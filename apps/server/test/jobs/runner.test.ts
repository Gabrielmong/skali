import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import {
  JobRunner,
  LOGIN_NEEDED,
  RESTART_DURING_INSTALL,
  RESTART_DURING_UPDATE,
  startGuardReason,
  type JobStep,
} from "../../src/jobs/runner.js";
import type { SupervisorEvent } from "../../src/proc/supervisor.js";
import { ServerRepo, type PersistedJob } from "../../src/servers/repo.js";
import { SteamCmdError } from "../../src/tools/steamcmd.js";

let root: string;
let db: Db;
let repo: ServerRepo;
let events: SupervisorEvent[];
let changed: ReturnType<typeof vi.fn>;
let runner: JobRunner;
let n = 0;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-job-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, Buffer.alloc(32, 3));
  events = [];
  changed = vi.fn();
  n = 0;
  runner = new JobRunner({
    repo,
    logsDir: path.join(root, "logs"),
    emit: (e) => events.push(e),
    changed: changed as unknown as (id: string) => void,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)),
  });
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const mk = (name = "Pal") =>
  repo.create({ name, game: "basic", folder: path.join(root, name), launch: { exe: "x" }, stopTimeoutSec: 10 });
const step = (id: string, run: JobStep["run"] = async () => undefined): JobStep => ({ id, label: `Step ${id}`, run });
const states = (id: string) => repo.get(id).job?.steps.map((s) => s.state);
const consoleOf = (id: string, runId: string) => fs.readFileSync(path.join(root, "logs", id, runId, "console.log"), "utf8");

describe("JobRunner.run", () => {
  it("runs steps in order and clears the job on success", async () => {
    const s = mk();
    const order: string[] = [];
    const seenStates: (string[] | undefined)[] = [];
    await runner.run(
      s.id, "install",
      [step("a", async () => { order.push("a"); seenStates.push(states(s.id)); }), step("b", async () => { order.push("b"); })],
      { x: 1 },
    );
    expect(order).toEqual(["a", "b"]);
    expect(seenStates[0]).toEqual(["running", "pending"]);
    expect(repo.get(s.id).job).toBeNull();
    expect(runner.isRunning(s.id)).toBe(false);
    expect(runner.view(s.id)).toBeNull();
    expect(changed).toHaveBeenCalledWith(s.id);
  });

  it("a throwing step fails the job, later steps stay pending, changed fires on every transition", async () => {
    const s = mk();
    const later = vi.fn();
    await runner.run(s.id, "install", [step("a"), step("b", async () => { throw new Error("boom"); }), step("c", later)], {});
    const job = repo.get(s.id).job!;
    expect(job.state).toBe("failed");
    expect(job.error).toBe("boom");
    expect(job.steps.map((x) => x.state)).toEqual(["done", "failed", "pending"]);
    expect(later).not.toHaveBeenCalled();
    // persists: start, a running, b running, failed
    expect(changed.mock.calls.length).toBe(4);
    expect(runner.view(s.id)).toMatchObject({ state: "failed", error: "boom", progress: null });
    expect(runner.busyReasons()).toEqual([]);
  });

  it("maps a SteamCMD login failure to the exact copy", async () => {
    const s = mk();
    await runner.run(s.id, "install", [step("a", async () => { throw new SteamCmdError("login", "Login Failure"); })], {});
    expect(repo.get(s.id).job?.error).toBe(LOGIN_NEEDED);
    await runner.run(s.id, "install", [step("a", async () => { throw new SteamCmdError("failed", "nope"); })], {});
    expect(repo.get(s.id).job?.error).toBe("nope");
  });

  it("writes labels, step lines and errors to console.log and as log events with the job runId", async () => {
    const s = mk();
    await runner.run(s.id, "install", [step("a", async (c) => c.log("hello")), step("b", async () => { throw new Error("bad"); })], {});
    const job = repo.get(s.id).job!;
    const text = consoleOf(s.id, job.runId);
    expect(text).toContain("[skali] Step a");
    expect(text).toContain("[skali] hello");
    expect(text).toContain("[skali] Step b failed: bad");
    const logs = events.filter((e): e is Extract<SupervisorEvent, { type: "log" }> => e.type === "log");
    expect(logs.every((e) => e.runId === job.runId && e.serverId === s.id)).toBe(true);
    expect(logs.flatMap((e) => e.lines)).toEqual(["[skali] Step a", "[skali] hello", "[skali] Step b", "[skali] Step b failed: bad"]);
  });

  it("the runner itself logs only step labels and errors", async () => {
    const s = mk();
    await runner.run(s.id, "install", [step("a")], { password: "hunter2" });
    const all = events.flatMap((e) => (e.type === "log" ? e.lines : [])).join("\n");
    expect(all).toBe("[skali] Step a");
  });

  it("resume keeps done steps (not rerun) and starts a new run log", async () => {
    const s = mk();
    const first = vi.fn();
    await runner.run(s.id, "install", [step("a", first), step("b", async () => { throw new Error("x"); })], {});
    const firstRun = repo.get(s.id).job!.runId;
    const again = vi.fn();
    const b = vi.fn();
    const seen: (string[] | undefined)[] = [];
    await runner.run(s.id, "install", [step("a", again), step("b", async () => { b(); seen.push(states(s.id)); })], {}, { resume: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(again).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
    expect(seen[0]).toEqual(["done", "running"]);
    expect(repo.get(s.id).job).toBeNull();
    const runs = fs.readdirSync(path.join(root, "logs", s.id));
    expect(runs.length).toBe(2);
    expect(runs).toContain(firstRun);
  });

  it("busyReasons while running; progress shows in view() and resets between steps", async () => {
    const s = mk("Pal");
    const u = mk("Val");
    let viewDuring: unknown;
    let reasons: string[] = [];
    let betweenProgress: number | null | undefined;
    await runner.run(s.id, "install", [
      step("a", async (c) => {
        c.progress(37);
        viewDuring = runner.view(s.id);
        reasons = runner.busyReasons();
        expect(runner.isRunning(s.id)).toBe(true);
      }),
      step("b", async () => { betweenProgress = runner.view(s.id)?.progress; }),
    ], {});
    expect(viewDuring).toMatchObject({ kind: "install", state: "running", progress: 37 });
    expect(reasons).toEqual(["Pal is installing"]);
    expect(betweenProgress).toBeNull();
    await runner.run(u.id, "update", [step("a", async () => { reasons = runner.busyReasons(); })], {});
    expect(reasons).toEqual(["Val is updating"]);
  });

  it("throttles changed notifications for progress ticks", async () => {
    const s = mk();
    let during = 0;
    await runner.run(s.id, "install", [step("a", async (c) => {
      const before = changed.mock.calls.length;
      for (let i = 0; i < 100; i++) c.progress(i);
      during = changed.mock.calls.length - before;
    })], {});
    expect(during).toBeLessThanOrEqual(1);
  });
});

describe("JobRunner hardening", () => {
  it("refuses an overlapping run for the same server and keeps the first run's live state", async () => {
    const s = mk();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const first = runner.run(s.id, "install", [step("a", async (c) => { c.progress(10); await gate; })], {});
    await vi.waitFor(() => expect(runner.isRunning(s.id)).toBe(true));
    const second = vi.fn();
    expect(await runner.run(s.id, "update", [step("x", second)], {})).toBe(false);
    expect(second).not.toHaveBeenCalled();
    expect(runner.isRunning(s.id)).toBe(true);
    expect(repo.get(s.id).job?.kind).toBe("install");
    expect(runner.view(s.id)?.progress).toBe(10);
    expect(runner.clear(s.id)).toBe(false);
    expect(repo.get(s.id).job).not.toBeNull();
    release();
    expect(await first).toBe(true);
    expect(repo.get(s.id).job).toBeNull();
    expect(runner.clear(s.id)).toBe(true);
  });

  it("delivers the trailing progress value after a burst, and leaves no timer behind", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const s = mk();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const run = runner.run(s.id, "install", [step("a", async (c) => { c.progress(10); c.progress(20); c.progress(50); await gate; c.progress(60); })], {});
      await vi.waitFor(() => expect(runner.view(s.id)?.progress).toBe(50));
      const before = changed.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_100);
      expect(changed.mock.calls.length).toBe(before + 1); // trailing notify
      expect(runner.view(s.id)?.progress).toBe(50);
      release();
      await run;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not notify on progress(null) when the value was already null", async () => {
    const s = mk();
    let delta = -1;
    await runner.run(s.id, "install", [step("a", async (c) => {
      const before = changed.mock.calls.length;
      c.progress(null);
      delta = changed.mock.calls.length - before;
    })], {});
    expect(delta).toBe(0);
  });

  it("resume only reuses done steps from a failed job of the same kind", async () => {
    const s = mk();
    const ran: string[] = [];
    const mkSteps = () => [step("a", async () => { ran.push("a"); }), step("b", async () => { ran.push("b"); })];
    // failed update job with a done step "a", resumed as an install: start fresh
    repo.update(s.id, { job: { kind: "update", state: "failed", runId: "r", params: {}, steps: [{ id: "a", label: "A", state: "done" }, { id: "b", label: "B", state: "failed" }] } });
    await runner.run(s.id, "install", mkSteps(), {}, { resume: true });
    expect(ran).toEqual(["a", "b"]);
    // a stale "running" job of the same kind is not trusted either
    ran.length = 0;
    repo.update(s.id, { job: { kind: "install", state: "running", runId: "r", params: {}, steps: [{ id: "a", label: "A", state: "done" }, { id: "b", label: "B", state: "running" }] } });
    await runner.run(s.id, "install", mkSteps(), {}, { resume: true });
    expect(ran).toEqual(["a", "b"]);
  });
});

describe("JobRunner.boot / clear", () => {
  const running = (kind: "install" | "update"): PersistedJob => ({
    kind, state: "running", runId: "r", params: {},
    steps: [{ id: "a", label: "A", state: "done" }, { id: "b", label: "B", state: "running" }, { id: "c", label: "C", state: "pending" }],
  });

  it("running install becomes failed with the install copy", () => {
    const s = repo.update(mk().id, { job: running("install"), desired: "running" });
    runner.boot();
    const j = repo.get(s.id).job!;
    expect(j.state).toBe("failed");
    expect(j.error).toBe(RESTART_DURING_INSTALL);
    expect(j.steps.map((x) => x.state)).toEqual(["done", "failed", "pending"]);
    expect(repo.get(s.id).desired).toBe("running");
  });

  it("running update becomes failed with the update copy and desired stopped", () => {
    const s = repo.update(mk().id, { job: running("update"), desired: "running" });
    runner.boot();
    expect(repo.get(s.id).job?.error).toBe(RESTART_DURING_UPDATE);
    expect(repo.get(s.id).desired).toBe("stopped");
  });

  it("clear removes the job", () => {
    const s = repo.update(mk().id, { job: { ...running("install"), state: "failed" } });
    runner.clear(s.id);
    expect(repo.get(s.id).job).toBeNull();
    expect(changed).toHaveBeenCalledWith(s.id);
  });
});

describe("startGuardReason", () => {
  const base = { job: null, setupPending: false };
  const job = (kind: "install" | "update", state: "running" | "failed") => ({ kind, state, runId: "r", params: {}, steps: [] }) as PersistedJob;
  it("gives the exact reasons", () => {
    expect(startGuardReason(base)).toBeNull();
    expect(startGuardReason({ ...base, job: job("install", "running") })).toBe("Installing…");
    expect(startGuardReason({ ...base, job: job("update", "running") })).toBe("Updating…");
    expect(startGuardReason({ ...base, job: job("install", "failed") })).toBe("Install failed — retry or remove it");
    expect(startGuardReason({ ...base, job: job("update", "failed") })).toBeNull();
    expect(startGuardReason({ ...base, setupPending: true })).toBe("Finish setup first");
  });
});
