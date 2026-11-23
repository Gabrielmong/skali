import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createHelper, HelperError, type SpawnFn } from "../../src/proc/helper.js";

/** A child process that never answers until killed. */
function hangingChild() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: false,
    kill: vi.fn(() => {
      child.killed = true;
      setImmediate(() => child.emit("close", null));
      return true;
    }),
  });
  return child;
}

function answeringChild(json: unknown) {
  const child = hangingChild();
  setImmediate(() => {
    child.stdout.end(JSON.stringify(json));
    child.emit("close", 0);
  });
  return child;
}

describe("createHelper timeouts", () => {
  it("kills a hung helper call and rejects with HelperError code TIMEOUT", async () => {
    const children: ReturnType<typeof hangingChild>[] = [];
    const spawn = vi.fn(() => {
      const c = hangingChild();
      children.push(c);
      return c;
    }) as unknown as SpawnFn;
    const helper = createHelper("SkaliHelper.exe", { spawn, timeoutsMs: { stats: 30 } });
    const err = await helper.stats([1]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelperError);
    expect((err as HelperError).code).toBe("TIMEOUT");
    expect((err as HelperError).message).toMatch(/stats timed out after 30 ms/);
    expect(children[0]!.kill).toHaveBeenCalledTimes(1);
  });

  it("uses 15 s for stats/ctrlc/kill and 60 s for launch/ensure-user by default", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const children: ReturnType<typeof hangingChild>[] = [];
      const spawn = vi.fn(() => {
        const c = hangingChild();
        children.push(c);
        return c;
      }) as unknown as SpawnFn;
      const helper = createHelper("SkaliHelper.exe", { spawn });
      const results: Record<string, unknown> = {};
      const track = (name: string, p: Promise<unknown>) => p.then(() => (results[name] = "ok"), (e: HelperError) => (results[name] = e.code));
      void track("kill", helper.kill(1));
      void track("ctrlC", helper.ctrlC(1));
      void track("launch", helper.launch({ exe: "x", args: [], cwd: ".", stdoutPath: "o" }));
      void track("ensureUser", helper.ensureUser("u"));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(results).toEqual({});
      await vi.advanceTimersByTimeAsync(1);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(results).toEqual({ kill: "TIMEOUT", ctrlC: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(45_000);
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(results).toEqual({ kill: "TIMEOUT", ctrlC: "TIMEOUT", launch: "TIMEOUT", ensureUser: "TIMEOUT" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a call answered in time resolves normally and its timer is cleared", async () => {
    const spawn = vi.fn(() => answeringChild({ processes: [{ pid: 1, alive: false }] })) as unknown as SpawnFn;
    const helper = createHelper("SkaliHelper.exe", { spawn, timeoutsMs: { stats: 1000 } });
    expect(await helper.stats([1])).toEqual([{ pid: 1, alive: false }]);
  });
});
