import os from "node:os";
import path from "node:path";
import type { GameId, RuntimeState } from "@skali/shared";
import { BadRequestError, ConflictError } from "../errors.js";
import type { GameAdapter, LaunchSpec } from "../games/types.js";
import { appendSkaliLine, createRun, pruneRuns } from "../logs/runs.js";
import { FileTailer } from "../logs/tail.js";
import type { ServerRecord, ServerRepo } from "../servers/repo.js";
import { Mutex } from "../util/mutex.js";
import { exeNotFoundMessage, resolveExe } from "../util/resolve-exe.js";
import { nextCrashAction, CRASH_WINDOW_MS } from "./crash-policy.js";
import type { Helper, ProcStat } from "./helper.js";

export type SupervisorEvent =
  | { type: "status"; serverId: string; state: RuntimeState }
  | { type: "log"; serverId: string; runId: string; lines: string[] };

/** The part of FileTailer the supervisor uses. */
export interface Tailer {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  start(): void;
  stop(): void;
  /** One final poll (emitting any new lines), then stop. Optional: absent means plain stop. */
  drain?(): Promise<void>;
}

export interface SupervisorDeps {
  repo: ServerRepo;
  helper: Helper;
  adapter: (id: GameId) => GameAdapter;
  logsDir: string;
  gamesUser: { name: string; password: string } | null;
  /** The only outward channel. Calls are guarded: a throwing subscriber cannot break supervisor state. */
  emit: (e: SupervisorEvent) => void;
  now?: () => number;
  cpuCount?: number;
  /** A reason the server may not be started right now (install running, setup pending...), or null. */
  startGuard?: (id: string) => string | null;
  /** Test seam; defaults to FileTailer. */
  createTailer?: (file: string, opts: { fromStart: boolean }) => Tailer;
}

const TICK_MS = 2_000;
const PROBE_MS = 5_000;
const READY_TIMEOUT_MS = 10 * 60_000;
const PLAYERS_MS = 15_000;
const STOP_POLL_MS = 1_000;
const ADAPTER_STOP_MAX_MS = 90_000;
const MIN_POLL_AFTER_CTRLC_MS = 5_000;

const NO_READY = "No ready signal seen";
const UNVERIFIABLE = "Process identity unverifiable";

interface Runtime {
  id: string;
  state: RuntimeState;
  mutex: Mutex;
  pid: number | null;
  pidStartTime: string | null;
  runId: string | null;
  consolePath: string | null;
  tailer: Tailer | null;
  readyTimer: NodeJS.Timeout | null;
  probeTimer: NodeJS.Timeout | null;
  probing: boolean;
  restartTimer: NodeJS.Timeout | null;
  /** Bumped on every start/stop/crash; stale async callbacks compare against it. */
  gen: number;
  crashTimes: number[];
  lastCpu: { cpuMs: number; at: number } | null;
  lastPlayersAt: number;
  playersInFlight: boolean;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves true when `p` settles in time, false on timeout; rejects when `p` rejects first. */
function settleWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const t = setTimeout(() => resolve(false), ms);
    p.then(
      () => {
        clearTimeout(t);
        resolve(true);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Values to hide in logs: password-type launch fields and every stored secret, longest first. */
function secretValues(adapter: GameAdapter, rec: ServerRecord): string[] {
  const vals = new Set<string>();
  for (const f of adapter.info.launchFields) {
    if (f.type !== "password") continue;
    const v = rec.launch[f.key];
    if (v !== undefined && v !== null && String(v) !== "") vals.add(String(v));
  }
  for (const v of Object.values(rec.secrets)) if (typeof v === "string" && v !== "") vals.add(v);
  return [...vals].sort((a, b) => b.length - a.length);
}

/** Secrets this short are only masked as a whole arg or a whole `key=`/`key:` value, so "1" can't mangle "-port 1234". */
const MIN_SUBSTRING_SECRET = 4;

function maskArg(arg: string, secrets: string[]): string {
  for (const s of secrets) {
    if (arg === s) return "****";
    const m = /^([^=:]*[=:])(.*)$/s.exec(arg);
    if (m && m[2] === s) return `${m[1]}****`;
  }
  let out = arg;
  for (const s of secrets) if (s.length >= MIN_SUBSTRING_SECRET) out = out.split(s).join("****");
  return out;
}

const quote = (a: string) => (a === "" || /\s/.test(a) ? `"${a}"` : a);

export function describeLaunch(spec: LaunchSpec, secrets: string[]): string {
  return [spec.exe, ...spec.args].map((a) => quote(maskArg(a, secrets))).join(" ");
}

export class Supervisor {
  private readonly rts = new Map<string, Runtime>();
  private readonly now: () => number;
  private readonly cpuCount: number;
  private readonly createTailer: (file: string, opts: { fromStart: boolean }) => Tailer;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticking = false;
  private closed = false;

  constructor(private readonly deps: SupervisorDeps) {
    this.now = deps.now ?? Date.now;
    this.cpuCount = Math.max(1, deps.cpuCount ?? os.availableParallelism());
    this.createTailer = deps.createTailer ?? ((file, opts) => new FileTailer(file, opts));
  }

  // ---------- public API ----------

  async boot(): Promise<void> {
    const { repo, helper } = this.deps;
    const withPid = repo.list().filter((r) => r.pid !== null);
    let stats: Map<number, ProcStat> | null = new Map();
    if (withPid.length) {
      try {
        stats = new Map((await helper.stats(withPid.map((r) => r.pid!))).map((s) => [s.pid, s]));
      } catch {
        stats = null; // helper unusable: identities can't be checked, so nothing may be relaunched
      }
    }
    for (const rec of withPid) {
      const s = stats?.get(rec.pid!);
      const verified = !!s && s.alive && s.startTime !== undefined && s.startTime === rec.pidStartTime;
      const unverifiable = stats === null || !s || (s.alive && (s.startTime === undefined || rec.pidStartTime === null));
      if (verified) this.attach(rec);
      else if (unverifiable) this.attach(rec, UNVERIFIABLE);
      else repo.update(rec.id, { pid: null, pidStartTime: null }); // dead or pid reused: never touch it
    }

    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);

    const toStart: string[] = [];
    for (const rec of repo.list()) {
      if (rec.desired !== "running" || this.rts.get(rec.id)?.pid != null) continue;
      if (this.deps.startGuard?.(rec.id)) continue; // a job owns the server: neither started nor crashed
      if (rec.autoStart) toStart.push(rec.id);
      else repo.update(rec.id, { desired: "stopped" });
    }
    await Promise.all(toStart.map((id) => this.startAndRecord(id)));
  }

  /** A pending auto-restart is cancelled inside doStart, after validation, so a rejected start leaves it intact. */
  start(id: string, opts: { skipGuard?: boolean } = {}): Promise<void> {
    const rt = this.rt(id);
    return rt.mutex.run(() => this.doStart(rt, opts.skipGuard === true));
  }

  stop(id: string): Promise<void> {
    const rt = this.rt(id);
    this.cancelRestart(rt);
    return rt.mutex.run(async () => {
      await this.doStop(rt, { allowAbandon: true });
    });
  }

  /** Starts again only when the old process is known gone, so a failed forced stop never yields two instances. */
  restart(id: string): Promise<void> {
    const rt = this.rt(id);
    const guard = this.deps.startGuard?.(id);
    if (guard) return Promise.reject(new ConflictError(guard)); // refuse before stopping a running server
    this.cancelRestart(rt);
    return rt.mutex.run(async () => {
      if (!(await this.doStop(rt))) {
        throw new ConflictError(rt.state.detail ?? `Previous process (pid ${rt.pid}) is still running`);
      }
      await this.doStart(rt);
    });
  }

  /** Not serialized with the mutex: a slow RCON call must not hold up a stop. */
  async command(id: string, cmd: string): Promise<string> {
    const status = this.state(id).status;
    if (status !== "running") throw new ConflictError(`Server is ${status}`);
    const rec = this.deps.repo.get(id);
    const adapter = this.deps.adapter(rec.game);
    if (!adapter.command || !adapter.hasCommandsFor(rec)) throw new BadRequestError("This server does not accept commands");
    return adapter.command(rec, cmd);
  }

  state(id: string): RuntimeState {
    const rt = this.rts.get(id);
    return rt ? { ...rt.state } : { status: "stopped", crashPaused: false };
  }

  /** Drops all runtime state for a deleted server. Never touches its process. */
  forget(id: string): void {
    const rt = this.rts.get(id);
    if (!rt) return;
    rt.gen++;
    this.cancelRestart(rt);
    this.clearReady(rt);
    this.stopTailer(rt);
    this.rts.delete(id);
  }

  async tick(): Promise<void> {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const watched = [...this.rts.values()].filter((rt) => rt.pid !== null && this.isLive(rt.state.status));
      if (!watched.length) return;
      const asked = new Map(watched.map((rt) => [rt.id, rt.pid!]));
      let stats: ProcStat[];
      try {
        stats = await this.deps.helper.stats([...asked.values()]);
      } catch {
        return;
      }
      const byPid = new Map(stats.map((s) => [s.pid, s]));
      const now = this.now();
      const crashes: Promise<void>[] = [];
      for (const rt of watched) {
        // Anything that changed while stats ran (stop/start in progress, forget) is left for the next tick.
        if (!this.isCurrent(rt) || rt.mutex.locked || !this.isLive(rt.state.status) || rt.pid !== asked.get(rt.id)) continue;
        const s = byPid.get(rt.pid);
        if (!s) continue;
        try {
          const differs = s.startTime !== undefined && rt.pidStartTime !== null && s.startTime !== rt.pidStartTime;
          if (!s.alive || differs) {
            crashes.push(this.onCrash(rt));
            continue;
          }
          this.sample(rt, s, now);
          this.maybeRefreshPlayers(rt, now);
          this.publish(rt);
        } catch {
          // e.g. the server row vanished; next tick re-evaluates
        }
      }
      await Promise.all(crashes);
    } finally {
      this.ticking = false;
    }
  }

  /** Stops timers and tailers. Never stops or kills games: they outlive the service. */
  shutdown(): void {
    this.closed = true;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    for (const rt of this.rts.values()) {
      rt.gen++;
      this.cancelRestart(rt);
      this.clearReady(rt);
      this.stopTailer(rt);
    }
  }

  // ---------- start ----------

  /** `skipGuard` is for a job starting its own server as its last step (the guard would refuse it as "Updating…"). */
  private async doStart(rt: Runtime, skipGuard = false): Promise<void> {
    const { repo, helper } = this.deps;
    const rec = repo.get(rt.id);
    const guard = skipGuard ? null : this.deps.startGuard?.(rt.id);
    if (guard) throw new ConflictError(guard);
    const status = rt.state.status;
    if (status !== "stopped" && status !== "crashed") throw new ConflictError(`Server is ${status}`);
    const adapter = this.deps.adapter(rec.game);
    const errors = adapter.validateLaunch(rec.name, rec.launch);
    if (errors.length) throw new BadRequestError(errors.join("; "));

    if (rt.pid !== null) {
      // Left over from a stop that couldn't confirm the process gone. Unknown identity or failed stats = not gone.
      const pid = rt.pid;
      const gone = rt.pidStartTime !== null && (await this.isGone(pid, rt.pidStartTime));
      if (!gone) throw new ConflictError(`Previous process (pid ${pid}) is still running; stop it first`);
      rt.pid = null;
      rt.pidStartTime = null;
      repo.update(rt.id, { pid: null, pidStartTime: null });
    }

    this.cancelRestart(rt);
    this.clearReady(rt);
    this.stopTailer(rt);
    repo.update(rt.id, { desired: "running" });
    if (rt.state.crashPaused) rt.crashTimes = [];
    const gen = ++rt.gen;
    const now = this.now();
    rt.lastCpu = null;
    rt.lastPlayersAt = -Infinity;
    rt.runId = null;
    rt.consolePath = null;
    rt.state = { status: "starting", crashPaused: false, startedAt: new Date(now).toISOString() };
    this.publish(rt);

    let launched: { pid: number; startTime: string };
    try {
      const run = createRun(this.deps.logsDir, rt.id, new Date(now));
      pruneRuns(this.deps.logsDir, rt.id);
      rt.runId = run.runId;
      rt.consolePath = run.consolePath;
      rt.state = { ...rt.state, runId: run.runId };
      repo.update(rt.id, { currentRunId: run.runId });

      const prep = await adapter.prepare(rec);
      const cur = prep.secrets && Object.keys(prep.secrets).length
        ? repo.update(rt.id, { secrets: { ...rec.secrets, ...prep.secrets } })
        : rec;
      const built = adapter.buildLaunch(cur);
      const exe = resolveExe(built.exe, built.cwd);
      if (exe === null) throw new BadRequestError(exeNotFoundMessage(built.exe));
      const spec = { ...built, exe };
      await this.log(rt, `Starting ${describeLaunch(spec, secretValues(adapter, cur))}`, false);
      launched = await helper.launch({
        exe: spec.exe,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        stdoutPath: run.consolePath,
        user: this.deps.gamesUser ?? undefined,
      });
    } catch (e) {
      const msg = errMsg(e);
      try {
        repo.update(rt.id, { desired: "stopped", pid: null, pidStartTime: null });
      } catch {
        // row gone
      }
      rt.state = { status: "crashed", detail: msg, crashPaused: false, ...(rt.runId ? { runId: rt.runId } : {}) };
      this.publish(rt);
      await this.log(rt, `Start failed: ${msg}`, true);
      return;
    }

    rt.pid = launched.pid;
    rt.pidStartTime = launched.startTime;
    try {
      // Persisted even after shutdown/forget: the game runs on, and boot must be able to find it again.
      repo.update(rt.id, { pid: launched.pid, pidStartTime: launched.startTime });
    } catch {
      // row gone
    }
    // shutdown or forget landed during the launch: leave no tailer or timers behind.
    if (!this.isCurrent(rt) || gen !== rt.gen) return;
    this.startTailer(rt, rt.consolePath!, true);

    const ready = adapter.ready;
    if (ready.kind === "none") {
      this.markRunning(rt, gen);
      return;
    }
    rt.readyTimer = setTimeout(() => {
      rt.readyTimer = null;
      this.markRunning(rt, gen, NO_READY);
    }, READY_TIMEOUT_MS);
    if (ready.kind === "probe") {
      rt.probeTimer = setInterval(() => void this.probeOnce(rt, gen, ready.probe), PROBE_MS);
    }
  }

  private async probeOnce(rt: Runtime, gen: number, probe: (s: ServerRecord) => Promise<boolean>): Promise<void> {
    if (rt.probing || gen !== rt.gen || rt.state.status !== "starting") return;
    rt.probing = true;
    let ok = false;
    try {
      ok = await probe(this.deps.repo.get(rt.id));
    } catch {
      ok = false;
    } finally {
      rt.probing = false;
    }
    if (ok) this.markRunning(rt, gen);
  }

  private markRunning(rt: Runtime, gen: number, detail?: string): void {
    if (gen !== rt.gen || rt.state.status !== "starting" || !this.isCurrent(rt)) return;
    this.clearReady(rt);
    const { detail: _old, ...rest } = rt.state;
    rt.state = { ...rest, status: "running", ...(detail ? { detail } : {}) };
    this.publish(rt);
  }

  /** Used by boot: a failed auto-start is recorded on the server instead of aborting boot. */
  private async startAndRecord(id: string): Promise<void> {
    try {
      await this.start(id);
    } catch (e) {
      const rt = this.rts.get(id);
      if (!rt || !this.isCurrent(rt)) return;
      try {
        this.deps.repo.update(id, { desired: "stopped" });
      } catch {
        // row gone
      }
      if (rt.state.status === "stopped" || rt.state.status === "crashed") {
        rt.state = { ...rt.state, status: "crashed", detail: errMsg(e) };
        this.publish(rt);
      }
    }
  }

  // ---------- stop ----------

  /** Returns true when the process is known gone afterwards (exited, or kill succeeded). */
  private async doStop(rt: Runtime, opts: { allowAbandon?: boolean } = {}): Promise<boolean> {
    const { repo, helper } = this.deps;
    this.cancelRestart(rt);
    if (rt.state.status === "stopped" && rt.pid === null) return true;
    if (rt.state.status === "stopped" && rt.pidStartTime === null && opts.allowAbandon) {
      // A pid that can never be verified would block start forever; a second explicit stop lets it go.
      const pid = rt.pid!;
      rt.pid = null;
      try {
        repo.update(rt.id, { pid: null, pidStartTime: null, desired: "stopped" });
      } catch {
        // row gone
      }
      const { detail: _d, ...rest } = rt.state;
      rt.state = rest;
      this.publish(rt);
      await this.log(rt, `Abandoned tracking of pid ${pid} (identity unverifiable)`, true);
      return true;
    }
    const rec = repo.update(rt.id, { desired: "stopped" });
    // A user stop lifts a crash pause; the history goes with it so the next crash isn't counted against it.
    if (rt.state.crashPaused) rt.crashTimes = [];
    rt.gen++;
    this.clearReady(rt);
    const pid = rt.pid;
    const startTime = rt.pidStartTime ?? undefined;

    if (pid === null) {
      // crashed (or failed to launch): nothing is running
      this.stopTailer(rt);
      rt.state = { status: "stopped", crashPaused: false, ...(rt.runId ? { runId: rt.runId } : {}) };
      this.publish(rt);
      await this.log(rt, "Stopped", true);
      return true;
    }

    const { detail: _old, ...rest } = rt.state;
    rt.state = { ...rest, status: "stopping" };
    this.publish(rt);

    const timeoutSec = rec.stopTimeoutSec;
    let deadline = this.now() + timeoutSec * 1000;
    // Without a stored start time the pid can't be tied to our game: never signal or kill it.
    const ctrlC = startTime !== undefined
      ? () => helper.ctrlC(pid, startTime)
      : () => Promise.reject(new Error("Cannot verify process identity"));
    const adapter = this.deps.adapter(rec.game);
    let fallback = false;
    try {
      const settled = await settleWithin(
        Promise.resolve().then(() => adapter.stop(rec, { ctrlC })),
        Math.min(ADAPTER_STOP_MAX_MS, timeoutSec * 1000),
      );
      fallback = !settled;
    } catch {
      fallback = true;
    }
    if (fallback && startTime !== undefined) {
      try {
        await ctrlC();
      } catch {
        // gone already, or no console; the poll and kill below decide
      }
      // Give the Ctrl+C a fair chance before killing.
      deadline = Math.max(deadline, this.now() + MIN_POLL_AFTER_CTRLC_MS);
    }

    let gone = await this.isGone(pid, startTime);
    while (!gone && this.now() < deadline) {
      await sleep(Math.min(STOP_POLL_MS, deadline - this.now()));
      gone = await this.isGone(pid, startTime);
    }

    const lines: string[] = [];
    let detail: string | undefined;
    let knownGone = gone;
    if (!gone && startTime === undefined) {
      detail = "Cannot verify process identity; not killing";
      lines.push(detail);
    } else if (!gone) {
      try {
        await helper.kill(pid, startTime);
        lines.push(`Forced stop after ${timeoutSec}s`);
        knownGone = true;
      } catch (e) {
        detail = `Forced stop failed: ${errMsg(e)}`;
        lines.push(detail);
      }
    }

    await this.drainTailer(rt);
    rt.lastCpu = null;
    if (knownGone) {
      rt.pid = null;
      rt.pidStartTime = null;
      try {
        repo.update(rt.id, { pid: null, pidStartTime: null });
      } catch {
        // row gone
      }
    }
    // Otherwise the pid stays tracked (memory and repo) while `stopped`: start refuses until it is confirmed gone,
    // a later stop retries the kill, and boot re-attaches it if it is still alive.
    rt.state = {
      status: "stopped",
      crashPaused: false,
      ...(rt.runId ? { runId: rt.runId } : {}),
      ...(detail ? { detail } : {}),
    };
    this.publish(rt);
    for (const l of [...lines, "Stopped"]) await this.log(rt, l, true);
    return knownGone;
  }

  /**
   * True only when the process is known to be gone: dead, or the pid now belongs to another process.
   * Unknown (stats failed, missing entry) and unverifiable (alive without startTime) count as alive.
   */
  private async isGone(pid: number, startTime: string | undefined): Promise<boolean> {
    try {
      const s = (await this.deps.helper.stats([pid])).find((x) => x.pid === pid);
      if (!s) return false;
      if (!s.alive) return true;
      return s.startTime !== undefined && startTime !== undefined && s.startTime !== startTime;
    } catch {
      return false;
    }
  }

  // ---------- tick helpers ----------

  private sample(rt: Runtime, s: ProcStat, now: number): void {
    if (s.startTime === undefined || s.startTime !== rt.pidStartTime) {
      // Identity unverifiable (access denied): alive, but no numbers.
      rt.lastCpu = null;
      const { cpuPct: _c, memBytes: _m, ...rest } = rt.state;
      rt.state = rest;
      return;
    }
    // Identity verified again (the caller has checked startTime === pidStartTime).
    if (rt.state.detail === UNVERIFIABLE) {
      const { detail: _d, ...rest } = rt.state;
      rt.state = rest;
    }
    let cpuPct = rt.state.cpuPct;
    if (s.cpuMs !== undefined) {
      if (rt.lastCpu && now > rt.lastCpu.at) {
        cpuPct = Math.max(0, ((s.cpuMs - rt.lastCpu.cpuMs) / ((now - rt.lastCpu.at) * this.cpuCount)) * 100);
      }
      rt.lastCpu = { cpuMs: s.cpuMs, at: now };
    }
    rt.state = {
      ...rt.state,
      ...(cpuPct !== undefined ? { cpuPct } : {}),
      ...(s.memBytes !== undefined ? { memBytes: s.memBytes } : {}),
    };
  }

  private maybeRefreshPlayers(rt: Runtime, now: number): void {
    if (rt.state.status !== "running" || rt.playersInFlight || now - rt.lastPlayersAt < PLAYERS_MS) return;
    const rec = this.deps.repo.get(rt.id);
    const adapter = this.deps.adapter(rec.game);
    rt.lastPlayersAt = now;
    rt.playersInFlight = true;
    const gen = rt.gen;
    void (async () => {
      let players: { online: number; max: number } | null;
      try {
        players = await adapter.players(rec);
      } catch {
        players = null;
      } finally {
        rt.playersInFlight = false;
      }
      if (gen !== rt.gen || !this.isCurrent(rt) || rt.state.status !== "running") return;
      rt.state = { ...rt.state, players };
      this.publish(rt);
    })();
  }

  private async onCrash(rt: Runtime): Promise<void> {
    const { repo } = this.deps;
    const now = this.now();
    rt.gen++;
    this.clearReady(rt);
    await this.drainTailer(rt);
    rt.pid = null;
    rt.pidStartTime = null;
    rt.lastCpu = null;
    let rec: ServerRecord;
    try {
      rec = repo.update(rt.id, { pid: null, pidStartTime: null });
    } catch {
      return;
    }
    rt.crashTimes = [...rt.crashTimes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    const action = nextCrashAction(rt.crashTimes, now, rec.autoRestart && rec.desired === "running");
    const runId = rt.runId ? { runId: rt.runId } : {};
    if (action.action === "restart") {
      rt.state = { status: "crashed", detail: "Restarting in 10 s", crashPaused: false, ...runId };
      rt.restartTimer = setTimeout(() => {
        rt.restartTimer = null;
        void this.autoRestart(rt);
      }, action.delayMs);
    } else {
      repo.update(rt.id, { desired: "stopped" });
      const detail = rec.autoRestart && rt.crashTimes.length >= 3
        ? "Crashed 3 times in 10 minutes; auto-restart paused"
        : "Process exited unexpectedly";
      rt.state = { status: "crashed", detail, crashPaused: true, ...runId };
    }
    this.publish(rt);
    await this.log(rt, "Process exited unexpectedly", true);
  }

  private async autoRestart(rt: Runtime): Promise<void> {
    if (!this.isCurrent(rt)) return;
    try {
      await rt.mutex.run(async () => {
        if (!this.isCurrent(rt) || rt.state.status !== "crashed" || rt.state.crashPaused) return;
        if (this.deps.repo.get(rt.id).desired !== "running") return;
        await this.doStart(rt);
      });
    } catch (e) {
      if (!this.isCurrent(rt) || rt.state.status !== "crashed") return;
      try {
        this.deps.repo.update(rt.id, { desired: "stopped" });
      } catch {
        // row gone
      }
      rt.state = { ...rt.state, detail: errMsg(e) };
      this.publish(rt);
    }
  }

  // ---------- plumbing ----------

  private rt(id: string): Runtime {
    let rt = this.rts.get(id);
    if (!rt) {
      rt = {
        id,
        state: { status: "stopped", crashPaused: false },
        mutex: new Mutex(),
        pid: null,
        pidStartTime: null,
        runId: null,
        consolePath: null,
        tailer: null,
        readyTimer: null,
        probeTimer: null,
        probing: false,
        restartTimer: null,
        gen: 0,
        crashTimes: [],
        lastCpu: null,
        lastPlayersAt: -Infinity,
        playersInFlight: false,
      };
      this.rts.set(id, rt);
    }
    return rt;
  }

  private attach(rec: ServerRecord, detail?: string): void {
    const rt = this.rt(rec.id);
    rt.pid = rec.pid;
    rt.pidStartTime = rec.pidStartTime;
    rt.runId = rec.currentRunId;
    rt.consolePath = rec.currentRunId ? path.join(this.deps.logsDir, rec.id, rec.currentRunId, "console.log") : null;
    rt.state = {
      status: "running",
      crashPaused: false,
      ...(rec.pidStartTime ? { startedAt: rec.pidStartTime } : {}),
      ...(rec.currentRunId ? { runId: rec.currentRunId } : {}),
      ...(detail ? { detail } : {}),
    };
    if (rt.consolePath) this.startTailer(rt, rt.consolePath, false);
    this.publish(rt);
  }

  private isLive(status: RuntimeState["status"]): boolean {
    return status === "starting" || status === "running";
  }

  private isCurrent(rt: Runtime): boolean {
    return !this.closed && this.rts.get(rt.id) === rt;
  }

  private startTailer(rt: Runtime, file: string, fromStart: boolean): void {
    this.stopTailer(rt);
    const t = this.createTailer(file, { fromStart });
    const gen = rt.gen;
    t.on("lines", (lines: string[]) => {
      // Must never throw: FileTailer emits from an async poll, so a throw would be an unhandled rejection.
      try {
        if (rt.tailer !== t || !this.isCurrent(rt)) return;
        if (rt.runId) this.safeEmit({ type: "log", serverId: rt.id, runId: rt.runId, lines });
        if (rt.state.status !== "starting" || gen !== rt.gen) return;
        const ready = this.deps.adapter(this.deps.repo.get(rt.id).game).ready;
        if (ready.kind !== "pattern") return;
        const re = ready.pattern;
        const hit = lines.some((l) => {
          re.lastIndex = 0;
          return re.test(l);
        });
        if (hit) this.markRunning(rt, gen);
      } catch {
        // ignore
      }
    });
    t.on("error", () => {
      // transient read errors; the tailer keeps polling
    });
    rt.tailer = t;
    t.start();
  }

  /** Lets the tailer emit the last lines (e.g. "World saved") before stopping it. Bounded; never throws. */
  private async drainTailer(rt: Runtime): Promise<void> {
    const t = rt.tailer;
    if (t?.drain) {
      try {
        await settleWithin(t.drain(), 1_000);
      } catch {
        // ignore
      }
    }
    if (rt.tailer === t) this.stopTailer(rt);
    else try { t?.stop(); } catch { /* ignore */ }
  }

  private stopTailer(rt: Runtime): void {
    const t = rt.tailer;
    rt.tailer = null;
    try {
      t?.stop();
    } catch {
      // ignore
    }
  }

  private clearReady(rt: Runtime): void {
    if (rt.readyTimer) clearTimeout(rt.readyTimer);
    if (rt.probeTimer) clearInterval(rt.probeTimer);
    rt.readyTimer = null;
    rt.probeTimer = null;
  }

  private cancelRestart(rt: Runtime): void {
    if (rt.restartTimer) clearTimeout(rt.restartTimer);
    rt.restartTimer = null;
  }

  /** Appends a `[skali]` line to the current run log. `direct` also emits it (no tailer is running to pick it up). */
  private async log(rt: Runtime, text: string, direct: boolean): Promise<void> {
    if (!rt.consolePath) return;
    try {
      await appendSkaliLine(rt.consolePath, text);
    } catch {
      // disk trouble must not break lifecycle handling
    }
    if (direct && rt.runId) this.safeEmit({ type: "log", serverId: rt.id, runId: rt.runId, lines: [`[skali] ${text}`] });
  }

  private publish(rt: Runtime): void {
    this.safeEmit({ type: "status", serverId: rt.id, state: { ...rt.state } });
  }

  private safeEmit(e: SupervisorEvent): void {
    try {
      this.deps.emit(e);
    } catch {
      // a subscriber's bug must not break supervisor state
    }
  }
}
