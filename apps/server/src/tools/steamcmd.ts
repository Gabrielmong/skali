import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { SteamAppInfo } from "@skali/shared";
import { ConflictError } from "../errors.js";
import { runProcess, system32Exe } from "../system/run.js";
import { Mutex } from "../util/mutex.js";
import { download, extractZip, type FetchFn } from "./download.js";

export const STEAMCMD_URL = "https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip";

/** Runs `exe args` (no shell), calling `onLine` for every stdout/stderr line; resolves with the exit code. */
export type LineRunner = (exe: string, args: string[], onLine: (line: string) => void) => Promise<number>;

export interface SteamCmdDeps {
  toolsDir: string;
  run?: LineRunner;
  fetch?: FetchFn;
  /** Shared lock: only one SteamCMD process at a time. */
  lock?: Mutex;
}

export const STEAMCMD_BUSY = "SteamCMD is busy with an install or update; try again when it finishes";

export class SteamCmdError extends Error {
  constructor(
    readonly kind: "login" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "SteamCmdError";
  }
}

const PROGRESS_RE = /^\s*Update state \(0x[0-9a-f]+\)[^,]*, progress: (\d+(?:\.\d+)?) \(/i;

/** The percentage from an ` Update state (0x61) downloading, progress: 45.12 (…)` line, else null. */
export function parseProgress(line: string): number | null {
  const m = PROGRESS_RE.exec(line);
  return m ? Number(m[1]) : null;
}

const LOGIN_RE =
  /No subscription|Login Failure|FAILED (?:to )?log ?in|requires a Steam account|Invalid Password|Steam Guard|Two-factor/i;
const ERROR_RE = /^\s*ERROR!/i;
/** SteamCMD replaced itself and quit before running the remaining commands (first-run behaviour). */
const SELF_UPDATE_RE = /Update complete, launching/i;

// ---- minimal VDF (KeyValues text) parser -------------------------------------------------

type Vdf = { [key: string]: string | Vdf };

function tokenize(text: string, start: number): string[] | null {
  // Returns tokens: quoted strings are returned without quotes and prefixed with "s", braces as "{" / "}".
  const out: string[] = [];
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      let s = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          const n = text[i + 1]!;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          i += 2;
        } else {
          s += text[i];
          i++;
        }
      }
      i++;
      out.push("s" + s);
    } else if (c === "{") {
      depth++;
      out.push("{");
      i++;
    } else if (c === "}") {
      depth--;
      out.push("}");
      i++;
      if (depth === 0) return out;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      return null; // unquoted text inside the block: not VDF
    }
  }
  return null;
}

function parseObject(tokens: string[], pos: { i: number }): Vdf {
  const obj: Vdf = {};
  if (tokens[pos.i] !== "{") throw new Error("expected {");
  pos.i++;
  while (pos.i < tokens.length && tokens[pos.i] !== "}") {
    const k = tokens[pos.i++]!;
    if (!k.startsWith("s")) throw new Error("expected key");
    const v = tokens[pos.i];
    if (v === "{") obj[k.slice(1)] = parseObject(tokens, pos);
    else if (v !== undefined && v.startsWith("s")) {
      obj[k.slice(1)] = v.slice(1);
      pos.i++;
    } else throw new Error("expected value");
  }
  pos.i++;
  return obj;
}

/**
 * Extracts the `"<appId>" { … }` block from `app_info_print` output. Null when there is no header line;
 * throws SteamCmdError("failed") when the header is there but the block is truncated or malformed.
 */
function appBlock(appId: number, output: string): Vdf | null {
  const m = new RegExp(`^[ \\t]*"${appId}"[ \\t]*\\r?$`, "m").exec(output);
  if (!m) return null;
  const malformed = () => new SteamCmdError("failed", `SteamCMD printed incomplete app info for ${appId}`);
  const tokens = tokenize(output, m.index + m[0].length);
  if (!tokens) throw malformed();
  try {
    return parseObject(tokens, { i: 0 });
  } catch {
    throw malformed();
  }
}

const sub = (v: string | Vdf | undefined): Vdf | undefined => (v && typeof v === "object" ? v : undefined);
const str = (v: string | Vdf | undefined): string | undefined => (typeof v === "string" ? v : undefined);
const hasWindows = (oslist: string) => oslist.split(",").some((o) => o.trim().toLowerCase() === "windows");

/**
 * Name and Windows support from `app_info_print` output; null for an unknown app (no block, or an empty `{ }`).
 * Throws SteamCmdError("failed") on a truncated block.
 */
export function parseAppInfo(appId: number, output: string): SteamAppInfo | null {
  const block = appBlock(appId, output);
  if (!block) return null;
  const common = sub(block.common);
  const name = str(common?.name);
  if (!name) return null;
  const depotOslists: string[] = [];
  const depots = sub(block.depots);
  for (const [key, depot] of Object.entries(depots ?? {})) {
    if (!/^\d+$/.test(key)) continue; // skip "branches", "baselanguages", …
    const oslist = str(sub(sub(depot)?.config)?.oslist);
    if (oslist) depotOslists.push(oslist);
  }
  let windows: boolean;
  if (depotOslists.length > 0) windows = depotOslists.some(hasWindows);
  else {
    const commonOs = str(common?.oslist);
    windows = commonOs ? hasWindows(commonOs) : true; // no OS restriction declared
  }
  return { appId, name, windows };
}

// ---- process runner -------------------------------------------------------------------------

/** Kill SteamCMD when it prints nothing for this long (an inactivity timeout: big downloads are legitimately long). */
export const STEAMCMD_IDLE_MS = 10 * 60_000;

export function idleTimeoutMessage(idleMs: number): string {
  const span = idleMs % 60_000 === 0 ? `${idleMs / 60_000} minutes` : `${idleMs} ms`;
  return `SteamCMD stopped responding (no output for ${span})`;
}

/** After killing SteamCMD, wait this long at most for it to close before rejecting. */
export const STEAMCMD_CLOSE_WAIT_MS = 15_000;

/** Kills a process and all its descendants. */
export type TreeKiller = (pid: number) => Promise<void>;

/** `taskkill.exe /PID <pid> /T /F` (argv elements, no shell); throws when taskkill exits non-zero. */
export const taskkillTree: TreeKiller = async (pid) => {
  const r = await runProcess(system32Exe("taskkill.exe"), ["/PID", String(pid), "/T", "/F"]);
  if (r.code !== 0) throw new Error(`taskkill failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
};

export interface SpawnRunnerOpts {
  /** Inactivity timeout (default STEAMCMD_IDLE_MS). */
  idleMs?: number;
  /** Tree killer (default taskkillTree); on failure the runner falls back to child.kill(). */
  killTree?: TreeKiller;
  /** Bounded wait for the killed child's `close` (default STEAMCMD_CLOSE_WAIT_MS). */
  closeWaitMs?: number;
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });

/**
 * Runner that spawns without a shell, hidden window, stdin ignored; splits stdout+stderr on CR or LF.
 * Kills the process tree and rejects with SteamCmdError("failed") after `idleMs` without any output, and
 * kills it and rejects with the callback's error if `onLine` throws. After a kill it waits (bounded by
 * `closeWaitMs`) for the child to close before rejecting, so callers holding a lock release it only once
 * SteamCMD is gone.
 */
export function createSpawnLineRunner(opts: SpawnRunnerOpts = {}): LineRunner {
  const idleMs = opts.idleMs ?? STEAMCMD_IDLE_MS;
  const killTree = opts.killTree ?? taskkillTree;
  const closeWaitMs = opts.closeWaitMs ?? STEAMCMD_CLOSE_WAIT_MS;
  return (exe, args, onLine) =>
    new Promise<number>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let child: ReturnType<typeof spawn> | undefined;
      let closed: Promise<void> = Promise.resolve();
      const running = () => !!child && child.pid !== undefined && child.exitCode === null && child.signalCode === null;
      const killAndWait = async () => {
        if (!running()) return;
        const c = child!;
        try {
          const done = await within(killTree(c.pid!).then(() => true), closeWaitMs);
          if (!done) throw new Error("tree killer timed out");
        } catch {
          try {
            c.kill();
          } catch {
            /* already gone */
          }
        }
        await within(closed, closeWaitMs);
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killAndWait().then(
          () => reject(err),
          () => reject(err),
        );
      };
      const armIdle = () => {
        clearTimeout(timer);
        timer = setTimeout(() => fail(new SteamCmdError("failed", idleTimeoutMessage(idleMs))), idleMs);
      };
      const emit = (line: string) => {
        if (settled || line.length === 0) return;
        try {
          onLine(line);
        } catch (err) {
          fail(err);
        }
      };
      try {
        child = spawn(exe, args, {
          windowsHide: true,
          shell: false,
          cwd: path.dirname(exe),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err) {
        fail(err);
        return;
      }
      const c = child;
      closed = new Promise<void>((r) => c.once("close", () => r()));
      const attach = (stream: NodeJS.ReadableStream | null) => {
        if (!stream) return;
        let buf = "";
        stream.setEncoding("utf8");
        stream.on("data", (chunk: string) => {
          if (settled) return;
          armIdle();
          buf += chunk;
          const parts = buf.split(/\r\n|\r|\n/);
          buf = parts.pop() ?? "";
          for (const p of parts) emit(p);
        });
        stream.on("end", () => {
          emit(buf);
          buf = "";
        });
      };
      attach(c.stdout);
      attach(c.stderr);
      armIdle();
      c.on("error", fail);
      c.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code ?? -1);
      });
    });
}

/** Default runner with the 10-minute inactivity timeout. */
export const spawnLineRunner: LineRunner = createSpawnLineRunner();

// ---- SteamCmd ------------------------------------------------------------------------------

interface RunResult {
  code: number;
  lines: string[];
}

export class SteamCmd {
  readonly exe: string;
  private readonly dir: string;
  private readonly run: LineRunner;
  private readonly fetchFn?: FetchFn;
  private readonly lock: Mutex;
  private ensuring: Promise<void> | null = null;
  /** appUpdate calls running or queued: a lookup is refused rather than left waiting behind a long install. */
  private updates = 0;

  constructor(deps: SteamCmdDeps) {
    this.dir = path.win32.join(deps.toolsDir, "steamcmd");
    this.exe = path.win32.join(this.dir, "steamcmd.exe");
    this.run = deps.run ?? spawnLineRunner;
    this.fetchFn = deps.fetch;
    this.lock = deps.lock ?? new Mutex();
  }

  installed(): boolean {
    return fs.existsSync(this.exe);
  }

  /** Downloads and extracts SteamCMD if steamcmd.exe is missing. Concurrent calls share one download. */
  ensure(log: (l: string) => void): Promise<void> {
    if (this.installed()) return Promise.resolve();
    if (!this.ensuring) {
      this.ensuring = this.install(log).finally(() => {
        this.ensuring = null;
      });
    }
    return this.ensuring;
  }

  /** Downloads and extracts into a temp sibling folder, then renames it into place, so a half-extracted
   *  SteamCMD never counts as installed. */
  private async install(log: (l: string) => void): Promise<void> {
    log("Downloading SteamCMD");
    const toolsDir = path.win32.dirname(this.dir);
    await fsp.mkdir(toolsDir, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}`;
    const zip = path.win32.join(toolsDir, `steamcmd-${stamp}.zip`);
    const staging = path.win32.join(toolsDir, `steamcmd.extract-${stamp}`);
    try {
      await download(STEAMCMD_URL, zip, { fetch: this.fetchFn });
      log("Extracting SteamCMD");
      await extractZip(zip, staging);
      if (!fs.existsSync(path.win32.join(staging, "steamcmd.exe"))) {
        throw new Error("The SteamCMD download did not contain steamcmd.exe");
      }
      // a leftover folder without steamcmd.exe (installed() was false) is replaced
      await fsp.rm(this.dir, { recursive: true, force: true });
      await fsp.rename(staging, this.dir);
    } finally {
      await fsp.rm(zip, { force: true });
      await fsp.rm(staging, { recursive: true, force: true });
    }
    log("SteamCMD is ready");
  }

  private async runCollect(args: string[], onLine: (l: string) => void): Promise<RunResult> {
    const lines: string[] = [];
    const code = await this.run(this.exe, args, (l) => {
      lines.push(l);
      onLine(l);
    });
    return { code, lines };
  }

  /** Waits for the shared lock; calls onWait once if it had to wait. Throws SteamCmdError on failure. */
  appUpdate(
    folder: string,
    appId: number,
    io: { log: (l: string) => void; progress: (p: number | null) => void; onWait?: () => void },
  ): Promise<void> {
    if (this.lock.locked) io.onWait?.();
    this.updates++;
    const done = this.lock.run(async () => {
      await this.ensure(io.log);
      const args = ["+force_install_dir", folder, "+login", "anonymous", "+app_update", String(appId), "validate", "+quit"];
      const success = new RegExp(`^\\s*Success! App '${appId}' fully installed`);
      for (let attempt = 0; ; attempt++) {
        const r = await this.runCollect(args, (l) => {
          io.log(l);
          const p = parseProgress(l);
          if (p !== null) io.progress(p);
        });
        if (r.lines.some((l) => success.test(l))) return;
        const login = r.lines.find((l) => LOGIN_RE.test(l));
        if (login) throw new SteamCmdError("login", login.trim());
        const errors = r.lines.filter((l) => ERROR_RE.test(l));
        if (errors.length > 0) throw new SteamCmdError("failed", errors[errors.length - 1]!.trim());
        if (attempt === 0 && r.lines.some((l) => SELF_UPDATE_RE.test(l))) {
          io.log("SteamCMD updated itself; running the install again");
          continue;
        }
        throw new SteamCmdError("failed", `SteamCMD exited (code ${r.code}) without finishing the install`);
      }
    });
    return done.finally(() => {
      this.updates--;
    });
  }

  /**
   * App name and Windows support; null = unknown app. Ensures SteamCMD first and takes the shared lock.
   * Rejects with ConflictError(STEAMCMD_BUSY) while an install/update holds or waits for the lock (it can take hours);
   * another lookup is short, so that one is waited for.
   */
  appInfo(appId: number): Promise<SteamAppInfo | null> {
    if (this.updates > 0) return Promise.reject(new ConflictError(STEAMCMD_BUSY));
    return this.lock.run(async () => {
      await this.ensure(() => {});
      const args = ["+login", "anonymous", "+app_info_update", "1", "+app_info_print", String(appId), "+quit"];
      const header = new RegExp(`^\\s*"${appId}"\\s*$`);
      for (let attempt = 0; ; attempt++) {
        const r = await this.runCollect(args, () => {});
        if (r.lines.some((l) => header.test(l))) return parseAppInfo(appId, r.lines.join("\n"));
        if (attempt === 0 && r.lines.some((l) => SELF_UPDATE_RE.test(l))) continue;
        const login = r.lines.find((l) => LOGIN_RE.test(l));
        if (login) throw new SteamCmdError("login", login.trim());
        throw new SteamCmdError("failed", `SteamCMD did not return app info for ${appId} (code ${r.code})`);
      }
    });
  }
}
