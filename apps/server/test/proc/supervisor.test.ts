import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../../src/db.js";
import { BadRequestError, ConflictError } from "../../src/errors.js";
import type { GameAdapter } from "../../src/games/types.js";
import { createRun } from "../../src/logs/runs.js";
import type { Helper, LaunchRequest, ProcStat } from "../../src/proc/helper.js";
import { Supervisor, type SupervisorEvent } from "../../src/proc/supervisor.js";
import { ServerRepo, type ServerRecord } from "../../src/servers/repo.js";

// ---------- fakes ----------

interface FakeProc { alive: boolean; startTime: string; cpuMs: number; memBytes: number; exitOnCtrlC: boolean; hideStart: boolean }

function makeHelper() {
  const procs = new Map<number, FakeProc>();
  let nextPid = 100;
  /** When false, launched processes ignore Ctrl+C. */
  const opts = { exitOnCtrlC: true, launchError: null as Error | null, killError: null as Error | null };
  const stat = (pid: number): ProcStat => {
    const p = procs.get(pid);
    if (!p || !p.alive) return { pid, alive: false };
    if (p.hideStart) return { pid, alive: true };
    return { pid, alive: true, startTime: p.startTime, cpuMs: p.cpuMs, memBytes: p.memBytes };
  };
  const helper = {
    launch: vi.fn(async (_r: LaunchRequest) => {
      if (opts.launchError) throw opts.launchError;
      const pid = nextPid++;
      const startTime = new Date(Date.UTC(2026, 0, 1, 0, 0, 0, pid)).toISOString();
      procs.set(pid, { alive: true, startTime, cpuMs: 0, memBytes: 1000, exitOnCtrlC: opts.exitOnCtrlC, hideStart: false });
      return { pid, startTime };
    }),
    stats: vi.fn(async (pids: number[]) => pids.map(stat)),
    ctrlC: vi.fn(async (pid: number, _startTime?: string) => {
      const p = procs.get(pid);
      if (p?.exitOnCtrlC) p.alive = false;
    }),
    kill: vi.fn(async (pid: number, _startTime?: string) => {
      if (opts.killError) throw opts.killError;
      const p = procs.get(pid);
      if (!p?.alive) return false;
      p.alive = false;
      return true;
    }),
    ensureUser: vi.fn(async () => ({ created: false, password: "x" })),
  };
  return { helper, procs, opts };
}

function makeAdapter(over: Partial<GameAdapter> = {}): GameAdapter {
  return {
    info: {
      id: "basic",
      displayName: "Fake",
      hasCommands: true,
      launchFields: [
        { key: "exe", label: "Executable", type: "text" },
        { key: "pw", label: "Password", type: "password" },
      ],
    },
    configSources: [],
    ready: { kind: "none" },
    defaultStopTimeoutSec: 30,
    steamAppId: null,
    installDefaults: () => ({}),
    saveLocations: () => [],
    inspectFolder: async () => ({ ok: false, reason: "n/a" }),
    validateLaunch: () => [],
    ports: () => [],
    prepare: vi.fn(async () => ({})),
    buildLaunch: vi.fn((s: ServerRecord) => ({ exe: "C:\\games\\fake.exe", args: ["-port", "1234"], cwd: s.folder, env: { A: "1" } })),
    stop: vi.fn(async (_s: ServerRecord, ctx: { ctrlC(): Promise<void> }) => {
      await ctx.ctrlC();
    }),
    command: vi.fn(async (_s: ServerRecord, cmd: string) => `ok ${cmd}`),
    hasCommandsFor: () => true,
    players: vi.fn(async () => ({ online: 1, max: 10 })),
    ...over,
  };
}

class FakeTailer extends EventEmitter {
  started = false;
  stopped = false;
  constructor(readonly file: string, readonly opts: { fromStart: boolean }) {
    super();
  }
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
  /** Lines the "file" gets between the last poll and the final drain. */
  pending: string[] = [];
  drained = false;
  async drain() {
    this.drained = true;
    if (this.pending.length) this.emit("lines", this.pending);
    this.stop();
  }
  push(lines: string[]) {
    this.emit("lines", lines);
  }
}

// ---------- harness ----------

let dir: string;
let db: ReturnType<typeof openDb>;
let repo: ServerRepo;
let h: ReturnType<typeof makeHelper>;
let adapter: GameAdapter;
let events: SupervisorEvent[];
let tailers: FakeTailer[];
let sup: Supervisor | null;
let emitImpl: (e: SupervisorEvent) => void;

const realTick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error("until: timed out");
    await realTick();
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date("2026-03-01T12:00:00.000Z"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skali-sup-"));
  db = openDb(path.join(dir, "t.db"));
  repo = new ServerRepo(db, Buffer.alloc(32, 3));
  h = makeHelper();
  adapter = makeAdapter();
  events = [];
  tailers = [];
  emitImpl = (e) => events.push(e);
  sup = null;
});

afterEach(() => {
  sup?.shutdown();
  vi.useRealTimers();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function mkSup(over: { gamesUser?: { name: string; password: string } | null; startGuard?: (id: string) => string | null } = {}): Supervisor {
  sup = new Supervisor({
    repo,
    helper: h.helper as unknown as Helper,
    adapter: () => adapter,
    logsDir: path.join(dir, "logs"),
    gamesUser: over.gamesUser ?? null,
    ...(over.startGuard ? { startGuard: over.startGuard } : {}),
    emit: (e) => emitImpl(e),
    cpuCount: 2,
    createTailer: (file, opts) => {
      const t = new FakeTailer(file, opts);
      tailers.push(t);
      return t;
    },
  });
  return sup;
}

function mkServer(over: Partial<ServerRecord> = {}): ServerRecord {
  const s = repo.create({
    name: `Srv${Math.random().toString(36).slice(2, 8)}`,
    game: "basic",
    folder: dir,
    launch: { exe: "fake.exe", pw: "hunter2" },
    stopTimeoutSec: 10,
    secrets: { restPw: "s3cr3t" },
  });
  return Object.keys(over).length ? repo.update(s.id, over) : s;
}

const consoleOf = (id: string) => {
  const r = repo.get(id);
  return fs.readFileSync(path.join(dir, "logs", id, r.currentRunId!, "console.log"), "utf8");
};
const statuses = (id: string) =>
  events.filter((e): e is Extract<SupervisorEvent, { type: "status" }> => e.type === "status" && e.serverId === id).map((e) => e.state.status);

// ---------- tests ----------

describe("Supervisor: start guard", () => {
  it.each(["Installing…", "Updating…", "Install failed — retry or remove it", "Finish setup first"])("refuses start with %s", async (reason) => {
    const s = mkServer();
    const sv = mkSup({ startGuard: () => reason });
    await expect(sv.start(s.id)).rejects.toThrow(new ConflictError(reason));
    expect(h.helper.launch).not.toHaveBeenCalled();
  });

  it("skipGuard starts past the guard (a job starting its own server)", async () => {
    const s = mkServer();
    const sv = mkSup({ startGuard: () => "Updating…" });
    await sv.start(s.id, { skipGuard: true });
    expect(sv.state(s.id).status).toBe("running");
  });

  it("restart is refused before the running server is stopped", async () => {
    const s = mkServer();
    let guard: string | null = null;
    const sv = mkSup({ startGuard: () => guard });
    await sv.start(s.id);
    guard = "Updating…";
    await expect(sv.restart(s.id)).rejects.toThrow(new ConflictError("Updating…"));
    expect(sv.state(s.id).status).toBe("running");
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
  });

  it("boot skips a guarded auto-start server without marking it crashed", async () => {
    const s = mkServer({ desired: "running", autoStart: true });
    const sv = mkSup({ startGuard: () => "Installing…" });
    await sv.boot();
    expect(h.helper.launch).not.toHaveBeenCalled();
    expect(sv.state(s.id).status).toBe("stopped");
    expect(repo.get(s.id).desired).toBe("running");
  });
});

describe("Supervisor: start", () => {
  it("serializes start: concurrent double start launches once and the second rejects with Conflict", async () => {
    const s = mkServer();
    const sv = mkSup();
    const [a, b] = await Promise.allSettled([sv.start(s.id), sv.start(s.id)]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect((b as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
  });

  it("start when not stopped/crashed rejects with Conflict 'Server is <status>'", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    await expect(sv.start(s.id)).rejects.toThrow(new ConflictError("Server is running"));
  });

  it("validateLaunch errors become BadRequestError joined with '; ' and nothing launches", async () => {
    adapter = makeAdapter({ validateLaunch: () => ["Bad port", "Bad exe"] });
    const s = mkServer();
    const sv = mkSup();
    await expect(sv.start(s.id)).rejects.toThrow(new BadRequestError("Bad port; Bad exe"));
    expect(h.helper.launch).not.toHaveBeenCalled();
    expect(repo.get(s.id).desired).toBe("stopped");
    expect(sv.state(s.id).status).toBe("stopped");
  });

  it("launches with the console path, env and games user, persists pid and tails from the start", async () => {
    adapter = makeAdapter({ prepare: vi.fn(async () => ({ secrets: { restPw: "newpw", extra: "e" } })) });
    const s = mkServer();
    const user = { name: "skali-games", password: "pw" };
    const sv = mkSup({ gamesUser: user });
    await sv.start(s.id);
    const r = repo.get(s.id);
    expect(r.desired).toBe("running");
    expect(r.secrets).toEqual({ restPw: "newpw", extra: "e" });
    expect(r.pid).toBe(100);
    expect(r.pidStartTime).toBe(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 100)).toISOString());
    expect(r.currentRunId).toBeTruthy();
    const req = h.helper.launch.mock.calls[0]![0];
    const consolePath = path.join(dir, "logs", s.id, r.currentRunId!, "console.log");
    expect(req).toEqual({ exe: "C:\\games\\fake.exe", args: ["-port", "1234"], cwd: dir, env: { A: "1" }, stdoutPath: consolePath, user });
    expect(tailers).toHaveLength(1);
    expect(tailers[0]!.file).toBe(consolePath);
    expect(tailers[0]!.opts.fromStart).toBe(true);
    expect(tailers[0]!.started).toBe(true);
    // ready kind none: running immediately
    expect(sv.state(s.id)).toMatchObject({ status: "running", crashPaused: false, runId: r.currentRunId });
    expect(statuses(s.id)).toEqual(["starting", "running"]);
    // tailer lines become log events
    tailers[0]!.push(["hello"]);
    expect(events).toContainEqual({ type: "log", serverId: s.id, runId: r.currentRunId, lines: ["hello"] });
    expect(consoleOf(s.id)).toContain("[skali] Starting C:\\games\\fake.exe -port 1234");
  });

  it("masks password-field values and stored secrets in the Starting line", async () => {
    adapter = makeAdapter({
      prepare: vi.fn(async () => ({ secrets: { gen: "g3nerated", pin: "12" } })),
      buildLaunch: (s) => ({
        exe: "C:\\games\\fake.exe",
        args: ["-password", "hunter2", "-password=hunter2", "key=s3cr3t", "tok=g3nerated", "-pin", "12", "pin=12", "-port", "1234", "-x=ahunter2b"],
        cwd: s.folder,
      }),
    });
    const s = mkServer();
    await mkSup().start(s.id);
    const text = consoleOf(s.id);
    // Short secrets are masked only as a whole arg/value, so "12" does not mangle "1234".
    expect(text).toContain("Starting C:\\games\\fake.exe -password **** -password=**** key=**** tok=**** -pin **** pin=**** -port 1234 -x=a****b");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("s3cr3t");
    expect(text).not.toContain("g3nerated");
  });

  it("ready pattern: stays starting until a matching line, then running", async () => {
    adapter = makeAdapter({ ready: { kind: "pattern", pattern: /Game server connected/g } });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    expect(sv.state(s.id).status).toBe("starting");
    tailers[0]!.push(["loading..."]);
    expect(sv.state(s.id).status).toBe("starting");
    tailers[0]!.push(["x", "Game server connected"]);
    expect(sv.state(s.id).status).toBe("running");
    expect(sv.state(s.id).detail).toBeUndefined();
  });

  it("ready probe: polled every 5 s, errors count as not ready", async () => {
    let n = 0;
    const probe = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("refused");
      return n >= 3;
    });
    adapter = makeAdapter({ ready: { kind: "probe", probe } });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    expect(sv.state(s.id).status).toBe("starting");
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sv.state(s.id).status).toBe("starting");
    await vi.advanceTimersByTimeAsync(5000);
    expect(sv.state(s.id).status).toBe("starting");
    await vi.advanceTimersByTimeAsync(5000);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(sv.state(s.id).status).toBe("running");
    await vi.advanceTimersByTimeAsync(20000);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("no ready signal after 10 min -> running with detail", async () => {
    adapter = makeAdapter({ ready: { kind: "pattern", pattern: /never/ } });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(sv.state(s.id).status).toBe("starting");
    await vi.advanceTimersByTimeAsync(1);
    expect(sv.state(s.id)).toMatchObject({ status: "running", detail: "No ready signal seen" });
  });

  it("launch rejection -> crashed with detail, run-log line, desired stopped, no auto-restart", async () => {
    h.opts.launchError = new Error("Access is denied");
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", detail: "Access is denied" });
    const r = repo.get(s.id);
    expect(r.desired).toBe("stopped");
    expect(r.pid).toBeNull();
    expect(consoleOf(s.id)).toContain("Access is denied");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
    expect(sv.state(s.id).status).toBe("crashed");
  });

  it("a bare exe that is not on PATH fails the start with a clear message and never calls the helper", async () => {
    adapter = makeAdapter({ buildLaunch: (s: ServerRecord) => ({ exe: "skali-no-such-java", args: [], cwd: s.folder }) });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    expect(sv.state(s.id)).toMatchObject({ status: "crashed" });
    expect(sv.state(s.id).detail).toContain("not found on the system PATH");
    expect(h.helper.launch).not.toHaveBeenCalled();
  });

  it("a relative exe with a directory part is resolved against the server folder", async () => {
    adapter = makeAdapter({ buildLaunch: (s: ServerRecord) => ({ exe: "bin\\x.exe", args: [], cwd: s.folder }) });
    const s = mkServer();
    await mkSup().start(s.id);
    expect(h.helper.launch.mock.calls[0]![0].exe).toBe(path.win32.resolve(dir, "bin\\x.exe"));
  });

  it("prepare rejection -> crashed with detail, no launch, no auto-restart", async () => {
    adapter = makeAdapter({ prepare: vi.fn(async () => { throw new Error("Config file locked"); }) });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", detail: "Config file locked" });
    expect(repo.get(s.id).desired).toBe("stopped");
    expect(consoleOf(s.id)).toContain("Config file locked");
    expect(h.helper.launch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.helper.launch).not.toHaveBeenCalled();
  });
});

describe("Supervisor: stop", () => {
  it("stop when stopped is a no-op", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.stop(s.id);
    expect(h.helper.ctrlC).not.toHaveBeenCalled();
    expect(h.helper.kill).not.toHaveBeenCalled();
    expect(adapter.stop).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("graceful stop: adapter.stop gets a ctrlC bound to pid+startTime; ends stopped, pid cleared, tailer stopped", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    const { pid, pidStartTime } = repo.get(s.id);
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(h.helper.ctrlC).toHaveBeenCalledWith(pid, pidStartTime);
    expect(h.helper.kill).not.toHaveBeenCalled();
    const r = repo.get(s.id);
    expect(r).toMatchObject({ desired: "stopped", pid: null, pidStartTime: null });
    expect(sv.state(s.id).status).toBe("stopped");
    expect(tailers[0]!.stopped).toBe(true);
    expect(statuses(s.id)).toEqual(["starting", "running", "stopping", "stopped"]);
    const text = consoleOf(s.id);
    expect(text).toContain("[skali] Stopped");
    expect(text).not.toContain("Forced stop");
  });

  it("stop drains the tailer once so the last lines are emitted live before it stops", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    const runId = repo.get(s.id).currentRunId!;
    tailers[0]!.pending = ["World saved"];
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(tailers[0]!.drained).toBe(true);
    expect(tailers[0]!.stopped).toBe(true);
    expect(events).toContainEqual({ type: "log", serverId: s.id, runId, lines: ["World saved"] });
  });

  it("forced stop: still alive after stopTimeoutSec -> kill(pid, startTime) and 'Forced stop after <n>s'", async () => {
    h.opts.exitOnCtrlC = false;
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    const { pid, pidStartTime } = repo.get(s.id);
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.helper.kill).not.toHaveBeenCalled();
    expect(sv.state(s.id).status).toBe("stopping");
    await vi.advanceTimersByTimeAsync(1_500);
    await p;
    expect(h.helper.kill).toHaveBeenCalledWith(pid, pidStartTime);
    expect(sv.state(s.id).status).toBe("stopped");
    expect(consoleOf(s.id)).toContain("Forced stop after 10s");
  });

  it("stop during starting with a rejecting adapter.stop -> ctrlC fallback, kill after timeout, ends stopped", async () => {
    h.opts.exitOnCtrlC = false;
    adapter = makeAdapter({
      ready: { kind: "pattern", pattern: /never/ },
      stop: vi.fn(async () => { throw new Error("REST down"); }),
    });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    expect(sv.state(s.id).status).toBe("starting");
    const { pid, pidStartTime } = repo.get(s.id);
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
    expect(h.helper.ctrlC).toHaveBeenCalledWith(pid, pidStartTime);
    expect(h.helper.kill).toHaveBeenCalledWith(pid, pidStartTime);
    expect(sv.state(s.id).status).toBe("stopped");
  });

  it("adapter.stop that never settles times out after min(90 s, stopTimeoutSec) and falls back to ctrlC", async () => {
    adapter = makeAdapter({ stop: vi.fn(() => new Promise<void>(() => {})) });
    const s = mkServer({ stopTimeoutSec: 120 });
    const sv = mkSup();
    await sv.start(s.id);
    const { pid, pidStartTime } = repo.get(s.id);
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(89_999);
    expect(h.helper.ctrlC).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.helper.ctrlC).toHaveBeenCalledWith(pid, pidStartTime);
    await vi.advanceTimersByTimeAsync(1_000);
    await p;
    expect(sv.state(s.id).status).toBe("stopped");
    expect(h.helper.kill).not.toHaveBeenCalled();
  });

  it("adapter.stop taking 60 s (> old 30 s cap, < 90 s) is not interrupted when stopTimeoutSec is 120", async () => {
    adapter = makeAdapter({
      stop: vi.fn(async (_s: ServerRecord, ctx: { ctrlC(): Promise<void> }) => {
        await new Promise<void>((r) => setTimeout(r, 60_000));
        await ctx.ctrlC();
      }),
    });
    const s = mkServer({ stopTimeoutSec: 120 });
    const sv = mkSup();
    await sv.start(s.id);
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(h.helper.ctrlC).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.helper.ctrlC).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    await p;
    expect(sv.state(s.id).status).toBe("stopped");
    expect(h.helper.ctrlC).toHaveBeenCalledTimes(1);
  });

  it("stop with unverifiable identity: graceful attempt, then kill with startTime; kill failure ends stopped with detail and a log line", async () => {
    h.opts.exitOnCtrlC = false;
    h.opts.killError = new Error("Access is denied");
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    const { pid, pidStartTime } = repo.get(s.id);
    h.procs.get(pid!)!.hideStart = true;
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
    expect(h.helper.ctrlC).toHaveBeenCalledWith(pid, pidStartTime);
    expect(h.helper.kill).toHaveBeenCalledTimes(1);
    expect(h.helper.kill).toHaveBeenCalledWith(pid, pidStartTime);
    expect(sv.state(s.id).status).toBe("stopped");
    expect(sv.state(s.id).detail).toMatch(/Forced stop failed: Access is denied/);
    expect(consoleOf(s.id)).toContain("Forced stop failed: Access is denied");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.helper.kill).toHaveBeenCalledTimes(1);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
  });
});

describe("Supervisor: restart and command", () => {
  it("restart = stop then start in one mutex hold; desired ends running", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    const p = sv.restart(s.id);
    // A start queued behind the restart sees the restarted server, not a stopped one.
    const q = sv.start(s.id);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    await expect(q).rejects.toThrow(ConflictError);
    expect(h.helper.launch).toHaveBeenCalledTimes(2);
    expect(repo.get(s.id).desired).toBe("running");
    expect(repo.get(s.id).pid).toBe(101);
    expect(sv.state(s.id).status).toBe("running");
    expect(statuses(s.id)).toEqual(["starting", "running", "stopping", "stopped", "starting", "running"]);
  });

  it("command: Conflict when not running, BadRequest without commands, otherwise forwards", async () => {
    const s = mkServer();
    const sv = mkSup();
    await expect(sv.command(s.id, "save")).rejects.toThrow(new ConflictError("Server is stopped"));
    await sv.start(s.id);
    expect(await sv.command(s.id, "save")).toBe("ok save");
    adapter = makeAdapter({ command: null });
    await expect(sv.command(s.id, "save")).rejects.toThrow(BadRequestError);
    adapter = makeAdapter({ hasCommandsFor: () => false });
    await expect(sv.command(s.id, "save")).rejects.toThrow(BadRequestError);
  });
});

describe("Supervisor: tick", () => {
  it("computes cpuPct from cpu delta / (wall delta x cpuCount) and memBytes", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    await sv.tick();
    const pid = repo.get(s.id).pid!;
    h.procs.get(pid)!.cpuMs = 2000;
    h.procs.get(pid)!.memBytes = 5_000_000;
    vi.advanceTimersByTime(2000);
    await sv.tick();
    expect(sv.state(s.id).cpuPct).toBeCloseTo(50);
    expect(sv.state(s.id).memBytes).toBe(5_000_000);
  });

  it("uses one stats call for all known pids", async () => {
    const a = mkServer();
    const b = mkServer();
    const sv = mkSup();
    await sv.start(a.id);
    await sv.start(b.id);
    h.helper.stats.mockClear();
    await sv.tick();
    expect(h.helper.stats).toHaveBeenCalledTimes(1);
    expect(h.helper.stats.mock.calls[0]![0].sort()).toEqual([100, 101]);
  });

  it("refreshes players every 15 s while running; errors -> null", async () => {
    const players = vi.fn(async () => ({ online: 2, max: 8 }));
    adapter = makeAdapter({ players });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    await sv.tick();
    await until(() => sv.state(s.id).players !== undefined);
    expect(sv.state(s.id).players).toEqual({ online: 2, max: 8 });
    expect(players).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    await sv.tick();
    expect(players).toHaveBeenCalledTimes(1);
    players.mockRejectedValueOnce(new Error("timeout"));
    vi.advanceTimersByTime(5_000);
    await sv.tick();
    await until(() => sv.state(s.id).players === null);
    expect(players).toHaveBeenCalledTimes(2);
  });

  it("dead pid while running = crash: log line, pid cleared, restart scheduled after 10 s", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    const runId = repo.get(s.id).currentRunId!;
    h.procs.get(100)!.alive = false;
    await sv.tick();
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", detail: "Restarting in 10 s", crashPaused: false });
    expect(repo.get(s.id).pid).toBeNull();
    expect(repo.get(s.id).desired).toBe("running");
    expect(fs.readFileSync(path.join(dir, "logs", s.id, runId, "console.log"), "utf8")).toContain("Process exited unexpectedly");
    expect(tailers[0]!.drained).toBe(true);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => h.helper.launch.mock.calls.length === 2 && sv.state(s.id).status === "running");
    expect(repo.get(s.id).pid).toBe(101);
  });

  it("a pid now owned by a different process (startTime differs) is a crash", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    h.procs.get(100)!.startTime = "2026-02-02T00:00:00.000Z";
    await sv.tick();
    expect(sv.state(s.id).status).toBe("crashed");
    expect(repo.get(s.id).pid).toBeNull();
    expect(h.helper.kill).not.toHaveBeenCalled();
  });

  it("three fast crashes -> third pauses (crashPaused, desired stopped) and there is no 4th launch", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    for (let i = 1; i <= 3; i++) {
      h.procs.get(99 + i)!.alive = false;
      await sv.tick();
      if (i < 3) {
        await vi.advanceTimersByTimeAsync(10_000);
        await until(() => h.helper.launch.mock.calls.length === i + 1 && sv.state(s.id).status === "running");
      }
    }
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", crashPaused: true });
    expect(repo.get(s.id).desired).toBe("stopped");
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.helper.launch).toHaveBeenCalledTimes(3);
  });

  it("manual start after pause clears crashPaused and the crash history", async () => {
    const s = mkServer({ autoRestart: false });
    const sv = mkSup();
    await sv.start(s.id);
    h.procs.get(100)!.alive = false;
    await sv.tick();
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", crashPaused: true });
    repo.update(s.id, { autoRestart: true });
    await sv.start(s.id);
    expect(sv.state(s.id)).toMatchObject({ status: "running", crashPaused: false });
    // History cleared: one crash now restarts instead of pausing.
    h.procs.get(101)!.alive = false;
    await sv.tick();
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", crashPaused: false, detail: "Restarting in 10 s" });
  });

  it("alive without startTime (identity unverifiable) is never a crash; cpu/mem stay undefined", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    h.procs.get(100)!.hideStart = true;
    await sv.tick();
    vi.advanceTimersByTime(2000);
    await sv.tick();
    expect(sv.state(s.id).status).toBe("running");
    expect(sv.state(s.id).cpuPct).toBeUndefined();
    expect(sv.state(s.id).memBytes).toBeUndefined();
    expect(repo.get(s.id).pid).toBe(100);
    expect(h.helper.kill).not.toHaveBeenCalled();
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
  });

  it("does not overlap itself", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    let release!: () => void;
    h.helper.stats.mockImplementationOnce(
      (pids: number[]) => new Promise<ProcStat[]>((r) => { release = () => r(pids.map((pid) => ({ pid, alive: true }))); }),
    );
    const first = sv.tick();
    await sv.tick();
    expect(h.helper.stats).toHaveBeenCalledTimes(1);
    release();
    await first;
    await sv.tick();
    expect(h.helper.stats).toHaveBeenCalledTimes(2);
  });
});

describe("Supervisor: pending restart timers", () => {
  async function crashOnce(sv: Supervisor, id: string) {
    await sv.start(id);
    h.procs.get(100)!.alive = false;
    await sv.tick();
    expect(sv.state(id).detail).toBe("Restarting in 10 s");
    expect(vi.getTimerCount()).toBe(1); // the pending restart is the only timer
  }

  it("stop cancels a pending restart", async () => {
    const s = mkServer();
    const sv = mkSup();
    await crashOnce(sv, s.id);
    await sv.stop(s.id);
    expect(vi.getTimerCount()).toBe(0);
    expect(sv.state(s.id)).toMatchObject({ status: "stopped" });
    expect(repo.get(s.id).desired).toBe("stopped");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
  });

  it("forget cancels a pending restart", async () => {
    const s = mkServer();
    const sv = mkSup();
    await crashOnce(sv, s.id);
    sv.forget(s.id);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
    expect(sv.state(s.id).status).toBe("stopped");
  });

  it("shutdown cancels a pending restart", async () => {
    const s = mkServer();
    const sv = mkSup();
    await crashOnce(sv, s.id);
    sv.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
  });

  it("a manual start while a restart is pending cancels it (no double launch)", async () => {
    const s = mkServer();
    const sv = mkSup();
    await crashOnce(sv, s.id);
    await sv.start(s.id);
    expect(h.helper.launch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    await realTick();
    expect(h.helper.launch).toHaveBeenCalledTimes(2);
    expect(sv.state(s.id).status).toBe("running");
  });
});

describe("Supervisor: boot and shutdown", () => {
  function attached(over: Partial<ServerRecord> = {}) {
    const s = mkServer();
    const run = createRun(path.join(dir, "logs"), s.id, new Date("2026-02-01T00:00:00.000Z"));
    const startTime = "2026-02-01T00:00:00.123Z";
    h.procs.set(4242, { alive: true, startTime, cpuMs: 0, memBytes: 1, exitOnCtrlC: true, hideStart: false });
    repo.update(s.id, { pid: 4242, pidStartTime: startTime, currentRunId: run.runId, desired: "running", ...over });
    return { s, run, startTime };
  }

  it("re-attaches a live matching pid without launching; tails its console from the end; starts the 2 s tick", async () => {
    const { s, run, startTime } = attached();
    const sv = mkSup();
    await sv.boot();
    expect(h.helper.launch).not.toHaveBeenCalled();
    expect(sv.state(s.id)).toMatchObject({ status: "running", runId: run.runId, startedAt: startTime });
    expect(sv.state(s.id).detail).toBeUndefined();
    expect(tailers).toHaveLength(1);
    expect(tailers[0]!.file).toBe(run.consolePath);
    expect(tailers[0]!.opts.fromStart).toBe(false);
    expect(repo.get(s.id).pid).toBe(4242);
    h.helper.stats.mockClear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.helper.stats).toHaveBeenCalledTimes(1);
  });

  it("boot ignores a pid whose start time differs (never kills it) and auto-starts", async () => {
    const { s } = attached();
    h.procs.get(4242)!.startTime = "2026-02-05T00:00:00.000Z";
    const sv = mkSup();
    await sv.boot();
    expect(h.helper.kill).not.toHaveBeenCalled();
    expect(h.helper.ctrlC).not.toHaveBeenCalled();
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
    expect(repo.get(s.id).pid).toBe(100);
    expect(sv.state(s.id).status).toBe("running");
  });

  it("boot clears a dead pid; desired running without autoStart becomes desired stopped", async () => {
    const { s } = attached({ autoStart: false });
    h.procs.get(4242)!.alive = false;
    const sv = mkSup();
    await sv.boot();
    expect(h.helper.launch).not.toHaveBeenCalled();
    expect(repo.get(s.id)).toMatchObject({ pid: null, pidStartTime: null, desired: "stopped" });
    expect(sv.state(s.id).status).toBe("stopped");
  });

  it("boot re-attaches an alive pid whose identity is unverifiable as running with detail, from the end", async () => {
    const { s } = attached();
    h.procs.get(4242)!.hideStart = true;
    const sv = mkSup();
    await sv.boot();
    expect(sv.state(s.id)).toMatchObject({ status: "running", detail: "Process identity unverifiable" });
    expect(repo.get(s.id).pid).toBe(4242);
    expect(tailers[0]!.opts.fromStart).toBe(false);
    expect(h.helper.launch).not.toHaveBeenCalled();
    expect(h.helper.kill).not.toHaveBeenCalled();
  });

  it("shutdown clears the tick and stops tailers but never stops or kills games", async () => {
    attached();
    const sv = mkSup();
    await sv.boot();
    sv.shutdown();
    expect(tailers[0]!.stopped).toBe(true);
    h.helper.stats.mockClear();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.helper.stats).not.toHaveBeenCalled();
    expect(h.helper.kill).not.toHaveBeenCalled();
    expect(h.helper.ctrlC).not.toHaveBeenCalled();
  });
});

describe("Supervisor: resilience", () => {
  it("a throwing tailer listener path never throws (emit throws; ready still detected)", async () => {
    adapter = makeAdapter({ ready: { kind: "pattern", pattern: /ready/ } });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    emitImpl = () => {
      throw new Error("subscriber blew up");
    };
    expect(() => tailers[0]!.push(["ready"])).not.toThrow();
    expect(sv.state(s.id).status).toBe("running");
  });

  it("the tailer 'lines' listener swallows its own errors (server row vanished mid-start)", async () => {
    adapter = makeAdapter({ ready: { kind: "pattern", pattern: /ready/ } });
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    repo.delete(s.id); // repo.get now throws NotFoundError inside the listener
    expect(() => tailers[0]!.push(["ready"])).not.toThrow();
  });

  it("a throwing emit subscriber cannot break supervisor state", async () => {
    emitImpl = () => {
      throw new Error("subscriber blew up");
    };
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    expect(sv.state(s.id).status).toBe("running");
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(sv.state(s.id).status).toBe("stopped");
    expect(repo.get(s.id).pid).toBeNull();
  });
});

describe("Supervisor: fix round 1", () => {
  it("restart does not launch a second instance when the forced stop failed", async () => {
    h.opts.exitOnCtrlC = false;
    h.opts.killError = new Error("Access is denied");
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    h.procs.get(100)!.hideStart = true;
    const p = sv.restart(s.id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(11_000);
    const err = await p;
    expect(err).toBeInstanceOf(ConflictError);
    expect((err as Error).message).toMatch(/Forced stop failed: Access is denied/);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
    expect(sv.state(s.id).status).toBe("stopped");
    expect(sv.state(s.id).detail).toMatch(/Forced stop failed: Access is denied/);
    expect(repo.get(s.id).pid).toBe(100);
  });

  async function crashUntilPaused(sv: Supervisor, id: string) {
    await sv.start(id);
    for (let i = 1; i <= 3; i++) {
      h.procs.get(99 + i)!.alive = false;
      await sv.tick();
      if (i < 3) {
        await vi.advanceTimersByTimeAsync(10_000);
        await until(() => h.helper.launch.mock.calls.length === i + 1 && sv.state(id).status === "running");
      }
    }
    expect(sv.state(id).crashPaused).toBe(true);
  }

  it("restart after a pause clears the crash history (next crash restarts, not pauses)", async () => {
    const s = mkServer();
    const sv = mkSup();
    await crashUntilPaused(sv, s.id);
    await sv.restart(s.id);
    expect(sv.state(s.id).status).toBe("running");
    h.procs.get(103)!.alive = false;
    await sv.tick();
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", crashPaused: false, detail: "Restarting in 10 s" });
  });

  it("stop then start after a pause also clears the crash history", async () => {
    const s = mkServer();
    const sv = mkSup();
    await crashUntilPaused(sv, s.id);
    await sv.stop(s.id);
    await sv.start(s.id);
    h.procs.get(103)!.alive = false;
    await sv.tick();
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", crashPaused: false, detail: "Restarting in 10 s" });
  });

  for (const how of ["shutdown", "forget"] as const) {
    it(`${how} during an in-flight launch: pid persisted, no tailer, no ready timers`, async () => {
      adapter = makeAdapter({ ready: { kind: "probe", probe: async () => false } });
      let release: (() => void) | undefined;
      const inner = h.helper.launch.getMockImplementation()!;
      h.helper.launch.mockImplementationOnce(async (r: LaunchRequest) => {
        await new Promise<void>((res) => {
          release = res;
        });
        return inner(r);
      });
      const s = mkServer();
      const sv = mkSup();
      const p = sv.start(s.id);
      await until(() => release !== undefined);
      if (how === "shutdown") sv.shutdown();
      else sv.forget(s.id);
      release!();
      await p;
      expect(repo.get(s.id).pid).toBe(100);
      expect(tailers).toHaveLength(0);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("never kills or Ctrl+Cs a process without a stored start time", async () => {
    const s = mkServer();
    const run = createRun(path.join(dir, "logs"), s.id, new Date("2026-02-01T00:00:00.000Z"));
    h.procs.set(4242, { alive: true, startTime: "x", cpuMs: 0, memBytes: 1, exitOnCtrlC: true, hideStart: true });
    repo.update(s.id, { pid: 4242, pidStartTime: null, currentRunId: run.runId, desired: "running" });
    const sv = mkSup();
    await sv.boot();
    expect(sv.state(s.id)).toMatchObject({ status: "running", detail: "Process identity unverifiable" });
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(20_000);
    await p;
    expect(h.helper.ctrlC).not.toHaveBeenCalled();
    expect(h.helper.kill).not.toHaveBeenCalled();
    expect(sv.state(s.id)).toMatchObject({ status: "stopped", detail: "Cannot verify process identity; not killing" });
    expect(fs.readFileSync(run.consolePath, "utf8")).toContain("Cannot verify process identity; not killing");
    // Still tracked: start refuses (unknown identity counts as not gone), restart refuses too.
    expect(repo.get(s.id).pid).toBe(4242);
    await expect(sv.start(s.id)).rejects.toThrow(new ConflictError("Previous process (pid 4242) is still running; stop it first"));
    const r = sv.restart(s.id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await r).toBeInstanceOf(ConflictError);
    expect(repo.get(s.id).pid).toBe(4242);
    // A second explicit stop abandons tracking, so the server is not blocked forever.
    await sv.stop(s.id);
    expect(repo.get(s.id).pid).toBeNull();
    expect(fs.readFileSync(run.consolePath, "utf8")).toContain("Abandoned tracking of pid 4242 (identity unverifiable)");
    expect(h.helper.ctrlC).not.toHaveBeenCalled();
    expect(h.helper.kill).not.toHaveBeenCalled();
    await sv.start(s.id);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
  });

  it("tick clears 'Process identity unverifiable' once the start time verifies", async () => {
    const s = mkServer();
    const run = createRun(path.join(dir, "logs"), s.id, new Date("2026-02-01T00:00:00.000Z"));
    const startTime = "2026-02-01T00:00:00.123Z";
    h.procs.set(4242, { alive: true, startTime, cpuMs: 0, memBytes: 1, exitOnCtrlC: true, hideStart: true });
    repo.update(s.id, { pid: 4242, pidStartTime: startTime, currentRunId: run.runId, desired: "running" });
    const sv = mkSup();
    await sv.boot();
    expect(sv.state(s.id).detail).toBe("Process identity unverifiable");
    h.procs.get(4242)!.hideStart = false;
    events = [];
    await sv.tick();
    expect(sv.state(s.id).detail).toBeUndefined();
    expect(sv.state(s.id).status).toBe("running");
    expect(events.some((e) => e.type === "status" && e.state.detail === undefined)).toBe(true);
  });

  it("boot with a failing stats call re-attaches as unverifiable: no launch, no kill", async () => {
    const s = mkServer();
    const run = createRun(path.join(dir, "logs"), s.id, new Date("2026-02-01T00:00:00.000Z"));
    repo.update(s.id, { pid: 4242, pidStartTime: "2026-02-01T00:00:00.123Z", currentRunId: run.runId, desired: "running" });
    h.helper.stats.mockRejectedValueOnce(new Error("helper missing"));
    const sv = mkSup();
    await sv.boot();
    expect(sv.state(s.id)).toMatchObject({ status: "running", detail: "Process identity unverifiable" });
    expect(repo.get(s.id).pid).toBe(4242);
    expect(h.helper.launch).not.toHaveBeenCalled();
    expect(h.helper.kill).not.toHaveBeenCalled();
  });

  it("a manual start rejected by validation leaves a pending restart intact", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    h.procs.get(100)!.alive = false;
    await sv.tick();
    expect(vi.getTimerCount()).toBe(1);
    adapter = makeAdapter({ validateLaunch: () => ["Executable is required"] });
    await expect(sv.start(s.id)).rejects.toThrow(BadRequestError);
    expect(vi.getTimerCount()).toBe(1);
    expect(sv.state(s.id)).toMatchObject({ status: "crashed", detail: "Restarting in 10 s" });
    // The pending restart then fails the same validation and records it.
    await vi.advanceTimersByTimeAsync(10_000);
    await until(() => sv.state(s.id).detail === "Executable is required");
    expect(repo.get(s.id).desired).toBe("stopped");
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
  });

  it("stopping from crashed appends 'Stopped'", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    h.procs.get(100)!.alive = false;
    await sv.tick();
    await sv.stop(s.id);
    expect(consoleOf(s.id)).toMatch(/Process exited unexpectedly[\s\S]*\[skali\] Stopped/);
  });

  it("after a fallback ctrlC there are at least 5 s of polling before kill", async () => {
    h.opts.exitOnCtrlC = false;
    adapter = makeAdapter({ stop: vi.fn(() => new Promise<void>(() => {})) });
    const s = mkServer({ stopTimeoutSec: 30 });
    const sv = mkSup();
    await sv.start(s.id);
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(h.helper.ctrlC).toHaveBeenCalledTimes(1);
    expect(h.helper.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(h.helper.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_500);
    await p;
    expect(h.helper.kill).toHaveBeenCalledTimes(1);
    expect(sv.state(s.id).status).toBe("stopped");
  });

  it("a failing stats call does not wedge the tick", async () => {
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    h.helper.stats.mockRejectedValueOnce(new Error("TIMEOUT"));
    await sv.tick();
    await sv.tick();
    expect(h.helper.stats).toHaveBeenCalledTimes(2);
  });
});

describe("Supervisor: pid without a stored start time", () => {
  it("is re-attached as unverifiable and never declared crashed even when stats shows a start time", async () => {
    const s = mkServer();
    const run = createRun(path.join(dir, "logs"), s.id, new Date("2026-02-01T00:00:00.000Z"));
    h.procs.set(4242, { alive: true, startTime: "2026-02-01T00:00:00.123Z", cpuMs: 0, memBytes: 1, exitOnCtrlC: true, hideStart: false });
    repo.update(s.id, { pid: 4242, pidStartTime: null, currentRunId: run.runId, desired: "running" });
    const sv = mkSup();
    await sv.boot();
    await sv.tick();
    expect(sv.state(s.id)).toMatchObject({ status: "running", detail: "Process identity unverifiable" });
    expect(sv.state(s.id).cpuPct).toBeUndefined();
    expect(repo.get(s.id).pid).toBe(4242);
    expect(h.helper.launch).not.toHaveBeenCalled();
  });
});

describe("Supervisor: fix round 2 (pid kept after an unconfirmed stop)", () => {
  it("keeps tracking the pid after a failed forced stop; start/restart refuse until it is gone", async () => {
    h.opts.exitOnCtrlC = false;
    h.opts.killError = new Error("Access is denied");
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    h.procs.get(100)!.hideStart = true;
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
    expect(sv.state(s.id).status).toBe("stopped");
    expect(sv.state(s.id).detail).toMatch(/Forced stop failed/);
    expect(repo.get(s.id)).toMatchObject({ pid: 100, desired: "stopped" });
    // tick ignores a stopped server even though it holds a pid
    await sv.tick();
    expect(sv.state(s.id).status).toBe("stopped");
    await expect(sv.start(s.id)).rejects.toThrow(ConflictError);
    const r = sv.restart(s.id).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(11_000);
    expect(await r).toBeInstanceOf(ConflictError);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
    // Once the old process is really gone, start proceeds.
    h.procs.get(100)!.alive = false;
    await sv.start(s.id);
    expect(h.helper.launch).toHaveBeenCalledTimes(2);
    expect(repo.get(s.id).pid).toBe(101);
  });

  it("a retried stop on a stopped server that still holds a pid runs the kill again", async () => {
    h.opts.exitOnCtrlC = false;
    h.opts.killError = new Error("Access is denied");
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
    expect(repo.get(s.id).pid).toBe(100);
    h.opts.killError = null;
    const q = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(11_000);
    await q;
    expect(h.helper.kill).toHaveBeenCalledTimes(2);
    expect(repo.get(s.id).pid).toBeNull();
    expect(sv.state(s.id).detail).toBeUndefined();
  });

  it("boot re-attaches a kept pid (desired stopped) that is still alive and verified, without launching", async () => {
    h.opts.exitOnCtrlC = false;
    h.opts.killError = new Error("Access is denied");
    const s = mkServer();
    const sv = mkSup();
    await sv.start(s.id);
    const p = sv.stop(s.id);
    await vi.advanceTimersByTimeAsync(11_000);
    await p;
    sv.shutdown();
    expect(repo.get(s.id)).toMatchObject({ pid: 100, desired: "stopped" });
    tailers = [];
    const sv2 = mkSup();
    await sv2.boot();
    expect(sv2.state(s.id).status).toBe("running");
    expect(repo.get(s.id).pid).toBe(100);
    expect(h.helper.launch).toHaveBeenCalledTimes(1);
    expect(tailers[0]!.opts.fromStart).toBe(false);
    sv2.shutdown();
  });
});
