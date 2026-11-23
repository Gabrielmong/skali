import { spawn as nodeSpawn } from "node:child_process";

/** Wrapper around tools/SkaliHelper: one helper process per call, JSON in on stdin, JSON out on stdout. */

export interface LaunchRequest {
  exe: string;
  args: string[];
  cwd: string;
  /** Log file; the game's stdout and stderr are appended to it. */
  stdoutPath: string;
  /** Overrides on top of the launching user's environment. */
  env?: Record<string, string>;
  /** Run as this local user instead of the service's own account. */
  user?: { name: string; password: string };
}

export interface ProcStat {
  pid: number;
  /** True also when the process exists but may not be opened; then the other fields are absent. */
  alive: boolean;
  /** Process creation time, ISO 8601 UTC with ms. */
  startTime?: string;
  /** CPU time of the process and all its descendants. */
  cpuMs?: number;
  /** Working set of the process and all its descendants. */
  memBytes?: number;
}

export interface Helper {
  launch(r: LaunchRequest): Promise<{ pid: number; startTime: string }>;
  stats(pids: number[]): Promise<ProcStat[]>;
  /**
   * Sends Ctrl+C to the process's console. With `startTime` (as launch/stats return it), rejects when the pid now
   * belongs to a different process.
   */
  ctrlC(pid: number, startTime?: string): Promise<void>;
  /**
   * Kills the process tree; false if it was already gone. With `startTime`, rejects when the pid now belongs to a
   * different process. Rejects (never returns false) when the process exists but may not be terminated.
   */
  kill(pid: number, startTime?: string): Promise<boolean>;
  /** Creates the local user if missing, sets a new random password and grants its logon rights. Needs admin. */
  ensureUser(name: string): Promise<{ created: boolean; password: string }>;
}

export class HelperError extends Error {
  override name = "HelperError";
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

export type HelperVerb = "launch" | "stats" | "ctrlc" | "kill" | "ensure-user";
export type SpawnFn = typeof nodeSpawn;

export interface HelperOptions {
  /** Per-verb call timeouts in ms. Defaults: 15 s for stats/ctrlc/kill, 60 s for launch/ensure-user. */
  timeoutsMs?: Partial<Record<HelperVerb, number>>;
  /** Test seam. */
  spawn?: SpawnFn;
}

const DEFAULT_TIMEOUTS_MS: Record<HelperVerb, number> = {
  launch: 60_000,
  "ensure-user": 60_000,
  stats: 15_000,
  ctrlc: 15_000,
  kill: 15_000,
};

export function createHelper(helperPath: string, opts: HelperOptions = {}): Helper {
  const spawn = opts.spawn ?? nodeSpawn;
  const call = <T>(verb: HelperVerb, request: unknown) =>
    runHelper<T>(spawn, helperPath, verb, request, opts.timeoutsMs?.[verb] ?? DEFAULT_TIMEOUTS_MS[verb]);
  return {
    launch: (r) => call("launch", r),
    stats: async (pids) => (await call<{ processes: ProcStat[] }>("stats", { pids })).processes,
    ctrlC: async (pid, startTime) => {
      await call("ctrlc", { pid, startTime });
    },
    kill: async (pid, startTime) => (await call<{ killed: boolean }>("kill", { pid, startTime })).killed,
    ensureUser: (name) => call("ensure-user", { name }),
  };
}

function runHelper<T>(spawn: SpawnFn, helperPath: string, verb: HelperVerb, request: unknown, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolveOuter, rejectOuter) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const resolve = (v: T) => finish(() => resolveOuter(v));
    const reject = (e: Error) => finish(() => rejectOuter(e));
    // detached: keeps the helper (and so the games it launches) out of libuv's kill-on-close job.
    const child = spawn(helperPath, [verb], { detached: true, windowsHide: true, stdio: "pipe" });
    // A hung helper must not wedge its callers (a stop holding the server mutex, the supervisor tick).
    // Caveat for `launch`: on timeout the game may already have started, with a pid we never learn; the
    // supervisor reports a failed start and cannot track (or stop) that process.
    timer = setTimeout(() => {
      reject(new HelperError(`SkaliHelper ${verb} timed out after ${timeoutMs} ms`, "TIMEOUT"));
      try {
        child.kill();
      } catch {
        // already gone
      }
    }, timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.on("error", (err) => reject(new HelperError(`failed to run SkaliHelper ${verb}: ${err.message}`)));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      let parsed: unknown;
      try {
        parsed = out ? JSON.parse(out) : undefined;
      } catch {
        parsed = undefined;
      }
      const error = parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : undefined;
      if (code === 0 && parsed !== undefined && error === undefined) return resolve(parsed as T);
      const err = Buffer.concat(stderr).toString("utf8").trim();
      reject(new HelperError(error ?? (err || out || `SkaliHelper ${verb} exited with code ${code}`)));
    });
    child.stdin.on("error", () => {
      // The helper may exit before reading stdin (e.g. unknown verb); the close handler reports it.
    });
    child.stdin.end(JSON.stringify(request));
  });
}
