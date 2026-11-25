import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError } from "../../src/errors.js";
import type { FetchFn } from "../../src/tools/download.js";
import {
  createSpawnLineRunner,
  idleTimeoutMessage,
  parseAppInfo,
  parseProgress,
  STEAMCMD_BUSY,
  STEAMCMD_CLOSE_WAIT_MS,
  STEAMCMD_IDLE_MS,
  SteamCmd,
  SteamCmdError,
  type LineRunner,
  type SpawnRunnerOpts,
} from "../../src/tools/steamcmd.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "steamcmd");
const fixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), "utf8");
const lines = (text: string) => text.split(/\r\n|\r|\n/).filter((l) => l.length > 0);

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skali-steamcmd-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A SteamCmd whose steamcmd.exe already exists, so ensure() never fetches. */
function installedSteamCmd(run: LineRunner): SteamCmd {
  const failFetch = (async () => {
    throw new Error("network not allowed");
  }) as unknown as FetchFn;
  const s = new SteamCmd({ toolsDir: tmp, run, fetch: failFetch });
  fs.mkdirSync(path.dirname(s.exe), { recursive: true });
  fs.writeFileSync(s.exe, "fake");
  return s;
}

/** A runner that replays `outputs` (one per call) and records argv. */
function scriptedRunner(outputs: string[], exitCode = 0) {
  const calls: { exe: string; args: string[] }[] = [];
  const run: LineRunner = async (exe, args, onLine) => {
    calls.push({ exe, args });
    const out = outputs[calls.length - 1] ?? "";
    for (const l of lines(out)) onLine(l);
    return exitCode;
  };
  return { run, calls };
}

function noopIo() {
  return { log: vi.fn(), progress: vi.fn(), onWait: vi.fn() };
}

describe("parseProgress", () => {
  it("reads the percentage from an Update state line", () => {
    expect(parseProgress(" Update state (0x61) downloading, progress: 45.12 (123456 / 273600)")).toBe(45.12);
  });
  it("returns null for other lines", () => {
    expect(parseProgress("Success! App '896660' fully installed.")).toBeNull();
    expect(parseProgress("[ 47%] Downloading update (20,893 of 30,203 KB)...")).toBeNull();
    expect(parseProgress("Loading Steam API...OK")).toBeNull();
    expect(parseProgress("")).toBeNull();
  });
});

describe("parseAppInfo", () => {
  it("reads name and windows support for Valheim Dedicated Server", () => {
    expect(parseAppInfo(896660, fixture("app-info-896660.txt"))).toEqual({
      appId: 896660,
      name: "Valheim Dedicated Server",
      windows: true,
    });
  });
  it("returns null for an unknown app", () => {
    expect(parseAppInfo(999999999, fixture("app-info-999999999-unknown.txt"))).toBeNull();
  });
  it("reports windows: false when no depot lists windows", () => {
    expect(parseAppInfo(1628350, fixture("app-info-1628350-linux-only.txt"))).toEqual({
      appId: 1628350,
      name: "Steam Linux Runtime 3.0 (sniper)",
      windows: false,
    });
  });
  it("returns null when the output has no block for the app", () => {
    expect(parseAppInfo(896660, fixture("first-run.txt"))).toBeNull();
  });
  it("throws (not null) on a truncated app block", () => {
    const full = fixture("app-info-896660.txt");
    const truncated = full.slice(0, full.indexOf('"depots"')) + "Unloading Steam API...OK\n";
    expect(() => parseAppInfo(896660, truncated)).toThrow(SteamCmdError);
    // cut off mid-block with nothing after it
    expect(() => parseAppInfo(896660, full.slice(0, full.indexOf('"config"')))).toThrow(SteamCmdError);
  });
  it("still returns null for an empty { } block", () => {
    expect(parseAppInfo(5, '"5"\n{\n}\n')).toBeNull();
  });
});

// Real node child processes: generous timeouts and idle windows so a busy whole-repo run (slow node start) is fine.
describe("spawnLineRunner (real child process: node -e)", { timeout: 30_000 }, () => {
  const node = process.execPath;
  const runScript = (script: string, onLine: (l: string) => void, idleMs = 10_000, extra: Partial<SpawnRunnerOpts> = {}) =>
    createSpawnLineRunner({ idleMs, ...extra })(node, ["-e", script], onLine);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const killQuietly = (pid: number) => {
    try {
      process.kill(pid);
    } catch {
      /* gone */
    }
  };

  it("the default close wait is 15 seconds", () => {
    expect(STEAMCMD_CLOSE_WAIT_MS).toBe(15_000);
  });

  it("idle timeout kills the whole tree with the real taskkill and rejects only after the child is gone", async () => {
    const pids: number[] = [];
    // the child starts a detached grandchild (outside libuv's kill-on-close job, so only /T kills it;
    // stdio ignored so it doesn't hold our pipes) and prints both pids
    const script =
      `const g = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{}, 60000)"], { stdio: "ignore", detached: true });` +
      `console.log(process.pid); console.log(g.pid); setTimeout(() => {}, 60000);`;
    const err = await runScript(script, (l) => pids.push(Number(l)), 1_500).catch((e) => e);
    try {
      expect(err).toBeInstanceOf(SteamCmdError);
      expect(err.message).toMatch(/stopped responding/);
      expect(pids).toHaveLength(2);
      expect(alive(pids[0]!)).toBe(false); // child closed before the reject
      await vi.waitFor(() => expect(alive(pids[1]!)).toBe(false), { timeout: 5_000 }); // grandchild killed via /T
    } finally {
      pids.forEach(killQuietly);
    }
  }, 20_000);

  it("calls the injected tree killer with the child's pid", async () => {
    const killed: number[] = [];
    let childPid = 0;
    const err = await runScript(`console.log(process.pid); setTimeout(() => {}, 60000);`, (l) => (childPid = Number(l)), 3_000, {
      killTree: async (pid) => {
        killed.push(pid);
        process.kill(pid);
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(killed).toEqual([childPid]);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 5_000 });
  }, 30_000); // idle window is generous: under parallel load node may take a while to print its pid

  it("falls back to child.kill() when the tree killer fails", async () => {
    let childPid = 0;
    const err = await runScript(`console.log(process.pid); setTimeout(() => {}, 60000);`, (l) => (childPid = Number(l)), 3_000, {
      killTree: async () => {
        throw new Error("taskkill failed");
      },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(childPid).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive(childPid)).toBe(false), { timeout: 5_000 });
  }, 30_000);

  it("waits for close only up to closeWaitMs, then rejects anyway", async () => {
    let childPid = 0;
    let printedAt = 0;
    // Idle window long enough for node to start and print its pid even under load; the default close wait is 15 s.
    const IDLE = 2_000;
    const err = await runScript(`console.log(process.pid); setTimeout(() => {}, 60000);`, (l) => {
      childPid = Number(l);
      printedAt = Date.now();
    }, IDLE, {
      killTree: async () => {}, // "succeeds" but kills nothing: close never comes
      closeWaitMs: 300,
    }).catch((e) => e);
    try {
      expect(err).toBeInstanceOf(SteamCmdError);
      expect(childPid).toBeGreaterThan(0);
      expect(Date.now() - printedAt).toBeLessThan(IDLE + 5_000);
      expect(alive(childPid)).toBe(true);
    } finally {
      killQuietly(childPid);
    }
  });

  it("the idle timeout is 10 minutes", () => {
    expect(STEAMCMD_IDLE_MS).toBe(10 * 60_000);
  });

  it("splits stdout and stderr on CR and LF and flushes a trailing partial line", async () => {
    const got: string[] = [];
    const code = await runScript(
      `process.stdout.write("a\\rb\\nc\\r\\nd"); process.stderr.write("e\\n"); process.exitCode = 3;`,
      (l) => got.push(l),
    );
    expect(code).toBe(3);
    expect([...got].sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(got.filter((l) => l !== "e")).toEqual(["a", "b", "c", "d"]);
  });

  it("never lets the child read stdin (stdin is ignored, so a read sees EOF at once)", async () => {
    const got: string[] = [];
    await runScript(
      `process.stdin.on("data", () => {}); process.stdin.on("end", () => console.log("eof")); process.stdin.resume();`,
      (l) => got.push(l),
      5_000,
    );
    expect(got).toEqual(["eof"]);
  });

  it("rejects when the exe does not exist", async () => {
    const run = createSpawnLineRunner({ idleMs: 10_000 });
    await expect(run(path.join(tmp, "nope", "missing.exe"), [], () => {})).rejects.toThrow();
  });

  it("kills the child and rejects with SteamCmdError when there is no output for the idle time", async () => {
    const started = Date.now();
    const err = await runScript(
      `console.log("hi"); setTimeout(() => console.log("late"), 30_000);`,
      () => {},
      300,
    ).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.kind).toBe("failed");
    expect(err.message).toMatch(/stopped responding/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("output keeps resetting the idle timer", async () => {
    const got: string[] = [];
    const code = await runScript(
      `console.log("start"); let n = 0; const t = setInterval(() => { console.log("tick" + n); if (++n === 5) clearInterval(t); }, 600);`,
      (l) => got.push(l),
      2_000, // ~3 s of ticks in all, longer than the idle window; startup has the full window
    );
    expect(code).toBe(0);
    expect(got).toHaveLength(6);
  });

  it("kills the child and rejects with the callback's error when onLine throws", async () => {
    const boom = new Error("boom");
    const started = Date.now();
    const err = await runScript(
      `console.log("first"); setTimeout(() => {}, 30_000);`,
      () => {
        throw boom;
      },
    ).catch((e) => e);
    expect(err).toBe(boom);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("uses the exact message for the default 10-minute timeout", () => {
    expect(idleTimeoutMessage(STEAMCMD_IDLE_MS)).toBe("SteamCMD stopped responding (no output for 10 minutes)");
  });
});

describe("SteamCmd.appUpdate", () => {
  it("passes the exact argv, forwards lines and progress, and resolves on Success!", async () => {
    const { run, calls } = scriptedRunner([fixture("app-update-success.txt")]);
    const s = installedSteamCmd(run);
    const io = noopIo();
    const folder = "D:\\GameServers\\valheim";
    await s.appUpdate(folder, 896660, io);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.exe).toBe(s.exe);
    expect(calls[0]!.args).toEqual([
      "+force_install_dir", folder, "+login", "anonymous", "+app_update", "896660", "validate", "+quit",
    ]);
    expect(io.log).toHaveBeenCalledWith("Success! App '896660' fully installed.");
    expect(io.progress).toHaveBeenCalledWith(45.12);
    expect(io.onWait).not.toHaveBeenCalled();
  });

  it("does not trust a non-zero exit code when Success! was printed", async () => {
    const { run } = scriptedRunner([fixture("app-update-success.txt")], 6);
    await expect(installedSteamCmd(run).appUpdate("D:\\g", 896660, noopIo())).resolves.toBeUndefined();
  });

  it.each([
    ["ERROR! Failed to install app '896660' (No subscription)"],
    ["Login Failure: No Connection"],
    ["This app requires a Steam account that owns it"],
  ])("throws a login SteamCmdError on %s", async (line) => {
    const { run } = scriptedRunner([`Loading Steam API...OK\n${line}\n`]);
    const err = await installedSteamCmd(run).appUpdate("D:\\g", 896660, noopIo()).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.kind).toBe("login");
  });

  it("throws a login SteamCmdError on the no-subscription fixture", async () => {
    const { run } = scriptedRunner([fixture("app-update-no-subscription.txt")]);
    const err = await installedSteamCmd(run).appUpdate("D:\\g", 123, noopIo()).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.kind).toBe("login");
  });

  it("throws a failed SteamCmdError on other ERROR! lines", async () => {
    const { run } = scriptedRunner([fixture("app-update-disk-error.txt")]);
    const err = await installedSteamCmd(run).appUpdate("D:\\g", 896660, noopIo()).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.kind).toBe("failed");
    expect(err.message).toMatch(/Disk write failure/);
  });

  it("throws a failed SteamCmdError when Success! never appears", async () => {
    const { run, calls } = scriptedRunner([
      "Loading Steam API...OK\n Update state (0x61) downloading, progress: 10.00 (1 / 10)\n",
    ]);
    const err = await installedSteamCmd(run).appUpdate("D:\\g", 896660, noopIo()).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.kind).toBe("failed");
    expect(calls).toHaveLength(1);
  });

  it("does not accept a Success! line for a different app", async () => {
    const { run } = scriptedRunner(["Success! App '1' fully installed.\n"]);
    const err = await installedSteamCmd(run).appUpdate("D:\\g", 896660, noopIo()).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.kind).toBe("failed");
  });

  it("retries once when SteamCMD self-updated and quit before installing", async () => {
    const { run, calls } = scriptedRunner([fixture("first-run.txt"), fixture("app-update-success.txt")], 7);
    await installedSteamCmd(run).appUpdate("D:\\g", 896660, noopIo());
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args).toEqual(calls[0]!.args);
  });

  it("retries only once after a self-update", async () => {
    const { run, calls } = scriptedRunner([fixture("first-run.txt"), fixture("first-run.txt"), fixture("app-update-success.txt")], 7);
    const err = await installedSteamCmd(run).appUpdate("D:\\g", 896660, noopIo()).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.kind).toBe("failed");
    expect(calls).toHaveLength(2);
  });

  it("two appUpdate calls run one at a time and the second calls onWait", async () => {
    const releases: (() => void)[] = [];
    let running = 0;
    let maxRunning = 0;
    const run: LineRunner = (_exe, args, onLine) =>
      new Promise<number>((resolve) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        releases.push(() => {
          onLine(`Success! App '${args[5]}' fully installed.`);
          running--;
          resolve(0);
        });
      });
    const s = installedSteamCmd(run);
    const io1 = noopIo();
    const io2 = noopIo();
    const p1 = s.appUpdate("D:\\a", 896660, io1);
    const p2 = s.appUpdate("D:\\b", 2394010, io2);
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    // give the second call every chance to start (it must not)
    await new Promise((r) => setTimeout(r, 20));
    expect(releases).toHaveLength(1);
    expect(io1.onWait).not.toHaveBeenCalled();
    expect(io2.onWait).toHaveBeenCalledTimes(1);
    releases[0]!();
    await p1;
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[1]!();
    await p2;
    expect(maxRunning).toBe(1);
    expect(io2.onWait).toHaveBeenCalledTimes(1);
  });

  it("releases the lock when the runner itself rejects (e.g. idle timeout)", async () => {
    let n = 0;
    const run: LineRunner = async (_exe, args, onLine) => {
      if (n++ === 0) throw new SteamCmdError("failed", "SteamCMD stopped responding (no output for 10 minutes)");
      onLine(`Success! App '${args[5]}' fully installed.`);
      return 0;
    };
    const s = installedSteamCmd(run);
    const err = await s.appUpdate("D:\\g", 896660, noopIo()).catch((e) => e);
    expect(err).toBeInstanceOf(SteamCmdError);
    expect(err.message).toMatch(/stopped responding/);
    await expect(s.appUpdate("D:\\g", 896660, noopIo())).resolves.toBeUndefined();
  });

  it("releases the lock after a failure", async () => {
    const { run } = scriptedRunner(["ERROR! boom\n", fixture("app-update-success.txt")]);
    const s = installedSteamCmd(run);
    await expect(s.appUpdate("D:\\g", 896660, noopIo())).rejects.toBeInstanceOf(SteamCmdError);
    await expect(s.appUpdate("D:\\g", 896660, noopIo())).resolves.toBeUndefined();
  });
});

describe("SteamCmd.appInfo", () => {
  it("runs app_info_print anonymously and parses the result", async () => {
    const { run, calls } = scriptedRunner([fixture("app-info-896660.txt")]);
    const info = await installedSteamCmd(run).appInfo(896660);
    expect(info).toEqual({ appId: 896660, name: "Valheim Dedicated Server", windows: true });
    expect(calls[0]!.args).toEqual(["+login", "anonymous", "+app_info_update", "1", "+app_info_print", "896660", "+quit"]);
  });

  it("returns null for an unknown app", async () => {
    const { run } = scriptedRunner([fixture("app-info-999999999-unknown.txt")]);
    expect(await installedSteamCmd(run).appInfo(999999999)).toBeNull();
  });

  it("retries once after a first-run self-update", async () => {
    const { run, calls } = scriptedRunner([fixture("first-run.txt"), fixture("app-info-896660.txt")]);
    expect(await installedSteamCmd(run).appInfo(896660)).toMatchObject({ name: "Valheim Dedicated Server" });
    expect(calls).toHaveLength(2);
  });

  it("throws when SteamCMD printed no app info at all", async () => {
    const { run } = scriptedRunner(["Loading Steam API...OK\nConnecting anonymously to Steam Public...FAILED\n"]);
    await expect(installedSteamCmd(run).appInfo(896660)).rejects.toBeInstanceOf(SteamCmdError);
  });

  it("refuses (Conflict, busy copy) while an appUpdate holds the lock, and works again after it", async () => {
    let release!: () => void;
    const order: string[] = [];
    const run: LineRunner = (_exe, args, onLine) => {
      if (args.includes("+app_update")) {
        order.push("update-start");
        return new Promise((resolve) => {
          release = () => {
            onLine("Success! App '896660' fully installed.");
            order.push("update-end");
            resolve(0);
          };
        });
      }
      order.push("info");
      for (const l of lines(fixture("app-info-896660.txt"))) onLine(l);
      return Promise.resolve(0);
    };
    const s = installedSteamCmd(run);
    const pu = s.appUpdate("D:\\g", 896660, noopIo());
    await vi.waitFor(() => expect(order).toEqual(["update-start"]));
    const err = await s.appInfo(896660).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toBe(STEAMCMD_BUSY);
    expect(STEAMCMD_BUSY).toBe("SteamCMD is busy with an install or update; try again when it finishes");
    release();
    await pu;
    expect(await s.appInfo(896660)).toMatchObject({ name: "Valheim Dedicated Server" });
    expect(order).toEqual(["update-start", "update-end", "info"]);
  });

  it("two lookups share the lock (the second waits instead of being refused)", async () => {
    const { run, calls } = scriptedRunner([fixture("app-info-896660.txt"), fixture("app-info-896660.txt")]);
    const s = installedSteamCmd(run);
    const [a, b] = await Promise.all([s.appInfo(896660), s.appInfo(896660)]);
    expect(a).toMatchObject({ name: "Valheim Dedicated Server" });
    expect(b).toMatchObject({ name: "Valheim Dedicated Server" });
    expect(calls).toHaveLength(2);
  });
});

describe("SteamCmd.ensure", () => {
  function zipWithExe(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const z = new yazl.ZipFile();
      z.addBuffer(Buffer.from("MZ fake steamcmd"), "steamcmd.exe");
      z.end();
      const chunks: Buffer[] = [];
      z.outputStream.on("data", (c: Buffer) => chunks.push(c));
      z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
      z.outputStream.on("error", reject);
    });
  }

  it("exe lives under <toolsDir>\\steamcmd", () => {
    const s = new SteamCmd({ toolsDir: "C:\\SkaliData\\tools" });
    expect(s.exe).toBe("C:\\SkaliData\\tools\\steamcmd\\steamcmd.exe");
  });

  it("ensure downloads and extracts when steamcmd.exe is missing, and does nothing when present", async () => {
    const zip = await zipWithExe();
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as unknown as FetchFn;
    const s = new SteamCmd({ toolsDir: tmp, fetch: fetchFn, run: async () => 0 });
    expect(s.installed()).toBe(false);
    const log = vi.fn();
    await s.ensure(log);
    expect(s.installed()).toBe(true);
    expect(fs.readFileSync(s.exe, "utf8")).toBe("MZ fake steamcmd");
    expect(urls).toEqual(["https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip"]);
    expect(log).toHaveBeenCalled();
    // the downloaded zip and the temp extract folder are cleaned up
    expect(fs.readdirSync(path.dirname(s.exe))).toEqual(["steamcmd.exe"]);
    expect(fs.readdirSync(tmp)).toEqual(["steamcmd"]);

    await s.ensure(log);
    expect(urls).toHaveLength(1);
  });

  it("concurrent ensure calls download once", async () => {
    const zip = await zipWithExe();
    let n = 0;
    const fetchFn = (async () => {
      n++;
      return new Response(new Uint8Array(zip), { status: 200 });
    }) as unknown as FetchFn;
    const s = new SteamCmd({ toolsDir: tmp, fetch: fetchFn });
    await Promise.all([s.ensure(() => {}), s.ensure(() => {})]);
    expect(n).toBe(1);
    expect(s.installed()).toBe(true);
  });

  it("throws when the zip has no steamcmd.exe", async () => {
    const fetchFn = (async () => {
      const z = new yazl.ZipFile();
      z.addBuffer(Buffer.from("x"), "other.txt");
      z.end();
      const chunks: Buffer[] = [];
      for await (const c of z.outputStream) chunks.push(c as Buffer);
      return new Response(new Uint8Array(Buffer.concat(chunks)), { status: 200 });
    }) as unknown as FetchFn;
    const s = new SteamCmd({ toolsDir: tmp, fetch: fetchFn });
    await expect(s.ensure(() => {})).rejects.toThrow(/steamcmd\.exe/);
    expect(s.installed()).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("a failed extraction leaves nothing behind that counts as installed", async () => {
    // a zip with steamcmd.exe followed by an entry that escapes the folder: extraction fails half way
    const fetchFn = (async () => {
      const z = new yazl.ZipFile();
      z.addBuffer(Buffer.from("MZ"), "steamcmd.exe");
      z.addBuffer(Buffer.from("x"), "zz/escape.txt");
      z.end();
      const chunks: Buffer[] = [];
      for await (const c of z.outputStream) chunks.push(c as Buffer);
      // yazl refuses ".." names, so patch the name bytes (same length) in local + central headers
      let buf = Buffer.concat(chunks);
      const from = Buffer.from("zz/escape.txt");
      const to = Buffer.from("../escape.txt");
      for (let i = buf.indexOf(from); i !== -1; i = buf.indexOf(from, i + 1)) to.copy(buf, i);
      return new Response(new Uint8Array(buf), { status: 200 });
    }) as unknown as FetchFn;
    const s = new SteamCmd({ toolsDir: tmp, fetch: fetchFn });
    await expect(s.ensure(() => {})).rejects.toThrow();
    expect(s.installed()).toBe(false);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("replaces a leftover steamcmd folder that has no steamcmd.exe", async () => {
    const zip = await zipWithExe();
    const fetchFn = (async () => new Response(new Uint8Array(zip), { status: 200 })) as unknown as FetchFn;
    const s = new SteamCmd({ toolsDir: tmp, fetch: fetchFn });
    fs.mkdirSync(path.dirname(s.exe), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(s.exe), "junk.txt"), "x");
    await s.ensure(() => {});
    expect(fs.readdirSync(path.dirname(s.exe))).toEqual(["steamcmd.exe"]);
  });

  it("appUpdate downloads SteamCMD first when it is missing", async () => {
    const zip = await zipWithExe();
    const fetchFn = (async () => new Response(new Uint8Array(zip), { status: 200 })) as unknown as FetchFn;
    const { run, calls } = scriptedRunner([fixture("app-update-success.txt")]);
    const s = new SteamCmd({ toolsDir: tmp, fetch: fetchFn, run });
    await s.appUpdate("D:\\g", 896660, noopIo());
    expect(s.installed()).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
