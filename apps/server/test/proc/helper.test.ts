import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHelper, HelperError, type Helper } from "../../src/proc/helper.js";
import { ensurePublished, fakeGamePath, helperExePath } from "../support/fake-game.js";

const TEST_TIMEOUT = 20_000;

describe.skipIf(process.platform !== "win32")("SkaliHelper", { timeout: 30_000 }, () => {
  let helper: Helper;
  let tmpDir: string;
  let fileCounter = 0;
  const started: number[] = [];

  beforeAll(() => {
    ensurePublished();
    helper = createHelper(helperExePath);
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skali-helper-"));
  }, 180_000);

  afterEach(async () => {
    // Kill every tree we started (kill is whole-tree, so children go too).
    for (const pid of started.splice(0)) await helper.kill(pid).catch(() => false);
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const tmpFile = () => path.join(tmpDir, `out-${++fileCounter}.log`);

  async function launch(args: string[], extra: { env?: Record<string, string> } = {}) {
    const out = tmpFile();
    const res = await helper.launch({ exe: fakeGamePath, args, cwd: tmpDir, stdoutPath: out, ...extra });
    started.push(res.pid);
    return { ...res, out };
  }

  async function waitFor<T>(fn: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await fn();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  const readOut = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

  const waitForFile = (file: string, re: RegExp, timeoutMs?: number) =>
    waitFor(() => (re.test(readOut(file)) ? readOut(file) : undefined), `${re} in ${file}`, timeoutMs);

  const lineAfter = (content: string, prefix: string) => {
    const line = content.split(/\r?\n/).find((l) => l.startsWith(prefix));
    if (line === undefined) throw new Error(`no line starting with ${prefix}`);
    return line.slice(prefix.length);
  };

  const waitDead = (pid: number) =>
    waitFor(async () => ((await helper.stats([pid]))[0].alive ? undefined : true), `pid ${pid} to die`);

  it("launch writes stdout to file and returns pid + startTime", async () => {
    const { pid, startTime, out } = await launch(["--ready-after", "0"]);
    expect(pid).toBeGreaterThan(0);
    expect(startTime).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    await waitForFile(out, /READY/);
    const [s] = await helper.stats([pid]);
    expect(s).toMatchObject({ pid, alive: true, startTime });
    expect(s.memBytes).toBeGreaterThan(0);
    expect(s.cpuMs).toBeGreaterThanOrEqual(0);
  }, TEST_TIMEOUT);

  it("args round-trip with spaces, quotes and trailing backslashes", async () => {
    const args = ["--echo-args", "a b", 'say "hi"', "C:\\path with space\\", ""];
    const { out } = await launch(args);
    const content = await waitForFile(out, /ARGS /);
    expect(JSON.parse(lineAfter(content, "ARGS "))).toEqual(args);
  }, TEST_TIMEOUT);

  it("env override reaches the process", async () => {
    const { out } = await launch(["--echo-env", "SteamAppId"], { env: { SteamAppId: "892970" } });
    const content = await waitForFile(out, /ENV /);
    expect(lineAfter(content, "ENV ")).toBe("SteamAppId=892970");
  }, TEST_TIMEOUT);

  it("ctrlc makes the game save and exit 0", async () => {
    const { pid, out } = await launch(["--ready-after", "0"]);
    await waitForFile(out, /READY/);
    await helper.ctrlC(pid);
    const content = await waitForFile(out, /SAVED/);
    expect(content.indexOf("SAVING")).toBeGreaterThan(-1);
    expect(content.indexOf("SAVING")).toBeLessThan(content.indexOf("SAVED"));
    await waitDead(pid);
  }, TEST_TIMEOUT);

  it("kill ends an --ignore-ctrlc game and its child", async () => {
    const { pid, out } = await launch(["--ignore-ctrlc", "--spawn-child", "--ready-after", "0"]);
    const content = await waitForFile(out, /READY/);
    const childPid = Number(lineAfter(content, "CHILD "));
    started.push(childPid);
    await waitFor(async () => ((await helper.stats([childPid]))[0].alive ? true : undefined), "child alive");

    await helper.ctrlC(pid);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await helper.stats([pid]))[0].alive).toBe(true);

    expect(await helper.kill(pid)).toBe(true);
    await waitDead(pid);
    await waitDead(childPid);
  }, TEST_TIMEOUT);

  it("stats sums descendants", async () => {
    const { pid, out } = await launch(["--spawn-child", "--ready-after", "0"]);
    const content = await waitForFile(out, /READY/);
    const childPid = Number(lineAfter(content, "CHILD "));
    started.push(childPid);
    await waitFor(async () => ((await helper.stats([childPid]))[0].memBytes ?? 0) > 0 || undefined, "child stats");
    const [parent, child] = await helper.stats([pid, childPid]);
    expect(child).toMatchObject({ pid: childPid, alive: true });
    // Parent and child are both FakeGame processes of similar size, so the tree sum is ~2x the child alone.
    expect(parent.memBytes!).toBeGreaterThan(1.5 * child.memBytes!);
  }, TEST_TIMEOUT);

  it("stats reports dead pid", async () => {
    expect(await helper.stats([999999])).toEqual([{ pid: 999999, alive: false }]);
  }, TEST_TIMEOUT);

  it("utf8 output is preserved", async () => {
    const { out } = await launch(["--print-utf8", "--ready-after", "0"]);
    const content = await waitForFile(out, /READY/);
    expect(content).toContain("ÆØÅ ✓");
  }, TEST_TIMEOUT);

  it("launch of missing exe rejects with HelperError", async () => {
    const p = helper.launch({ exe: path.join(tmpDir, "nope.exe"), args: [], cwd: tmpDir, stdoutPath: tmpFile() });
    await expect(p).rejects.toBeInstanceOf(HelperError);
    await expect(p).rejects.toThrow(/nope\.exe|cannot find/i);
  }, TEST_TIMEOUT);

  it("launch as an unknown user rejects with a LogonUser error", async () => {
    const p = helper.launch({
      exe: fakeGamePath,
      args: [],
      cwd: tmpDir,
      stdoutPath: tmpFile(),
      user: { name: "SkaliNoSuchUser", password: "not-a-password" },
    });
    await expect(p).rejects.toBeInstanceOf(HelperError);
    await expect(p).rejects.toThrow(/LogonUser/);
  }, TEST_TIMEOUT);

  // Identity checks: a recorded pid may have been reused by another process; kill/ctrlc must refuse it.
  const OTHER_START = "2001-01-01T00:00:00.000Z";

  it("kill with matching startTime kills", async () => {
    const { pid, startTime, out } = await launch(["--ready-after", "0"]);
    await waitForFile(out, /READY/);
    expect(await helper.kill(pid, startTime)).toBe(true);
    await waitDead(pid);
  }, TEST_TIMEOUT);

  it("kill with a different startTime refuses and leaves the process alive", async () => {
    const { pid, out } = await launch(["--ready-after", "0"]);
    await waitForFile(out, /READY/);
    const p = helper.kill(pid, OTHER_START);
    await expect(p).rejects.toBeInstanceOf(HelperError);
    await expect(p).rejects.toThrow(`pid ${pid} is a different process`);
    await new Promise((r) => setTimeout(r, 300));
    expect((await helper.stats([pid]))[0].alive).toBe(true);
  }, TEST_TIMEOUT);

  it("ctrlc with matching startTime saves", async () => {
    const { pid, startTime, out } = await launch(["--ready-after", "0"]);
    await waitForFile(out, /READY/);
    await helper.ctrlC(pid, startTime);
    await waitForFile(out, /SAVED/);
    await waitDead(pid);
  }, TEST_TIMEOUT);

  it("ctrlc with a different startTime refuses and leaves the process alive", async () => {
    const { pid, out } = await launch(["--ready-after", "0"]);
    await waitForFile(out, /READY/);
    const p = helper.ctrlC(pid, OTHER_START);
    await expect(p).rejects.toBeInstanceOf(HelperError);
    await expect(p).rejects.toThrow(`pid ${pid} is a different process`);
    await new Promise((r) => setTimeout(r, 1000));
    expect((await helper.stats([pid]))[0].alive).toBe(true);
    expect(readOut(out)).not.toMatch(/SAVING/);
  }, TEST_TIMEOUT);

  // A process we may not open must never read as dead (that could start a second copy on the same world).
  // The System process (pid 4) can't be opened with SYNCHRONIZE by a non-SYSTEM caller.
  it("stats reports a process we can't fully open as alive", async () => {
    const [s] = await helper.stats([4]);
    expect(s).toMatchObject({ pid: 4, alive: true });
  }, TEST_TIMEOUT);

  it("kill of a process we may not terminate rejects instead of reporting it gone", async () => {
    // Safe: the System process can't be terminated by anyone, and a non-SYSTEM caller can't even get PROCESS_TERMINATE.
    await expect(helper.kill(4)).rejects.toBeInstanceOf(HelperError);
  }, TEST_TIMEOUT);
});
