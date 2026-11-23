import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHelper, type Helper } from "../../src/proc/helper.js";
import { ensurePublished, fakeGamePath, helperExePath } from "../support/fake-game.js";

/**
 * Admin tests: create a real local Windows user (SkaliGamesTest, never the real SkaliGames), grant it LSA logon
 * rights and launch FakeGame as it. They only run when SKALI_ADMIN_TESTS=1 AND the process runs as LocalSystem,
 * which is what the service runs as and what launching as another user requires (SeAssignPrimaryTokenPrivilege;
 * an elevated admin doesn't hold it and the helper fails closed). Never run them on a dev PC.
 *
 * How to run on the server PC (from an elevated prompt, repo at C:\skali, after a normal
 * `corepack pnpm --filter @skali/server test` so the helper and FakeGame are published):
 *
 *   Sysinternals PsExec:
 *     psexec -s -i cmd /c "cd /d C:\skali && set SKALI_ADMIN_TESTS=1&& set COREPACK_ENABLE_DOWNLOAD_PROMPT=0&& corepack pnpm --filter @skali/server exec vitest run test/proc/helper-user.test.ts > C:\ProgramData\skali-admin-tests.log 2>&1"
 *
 *   or a one-shot scheduled task as SYSTEM:
 *     schtasks /create /tn SkaliAdminTests /ru SYSTEM /sc once /st 00:00 /f /tr "cmd /c cd /d C:\skali && set SKALI_ADMIN_TESTS=1&& set COREPACK_ENABLE_DOWNLOAD_PROMPT=0&& corepack pnpm --filter @skali/server exec vitest run test/proc/helper-user.test.ts > C:\ProgramData\skali-admin-tests.log 2>&1"
 *     schtasks /run /tn SkaliAdminTests   (wait for it to finish, read the log)
 *     schtasks /delete /tn SkaliAdminTests /f
 *
 * node, corepack and dotnet must be on the machine PATH (SYSTEM doesn't see per-user PATH entries).
 */
const TEST_USER = "SkaliGamesTest";
const TEST_TIMEOUT = 30_000;

/** True when this process runs as LocalSystem (S-1-5-18). */
function isLocalSystem(): boolean {
  if (process.platform !== "win32") return false;
  try {
    // Absolute path: a Git Bash PATH would find GNU whoami first.
    const whoami = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "whoami.exe");
    return execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).includes('"S-1-5-18"');
  } catch {
    return false;
  }
}

const requested = process.env.SKALI_ADMIN_TESTS === "1";
const enabled = requested && isLocalSystem();

// Asked for the admin tests but not running as SYSTEM: fail loudly instead of skipping silently.
describe.skipIf(!requested || enabled)("SkaliHelper admin tests: wrong account", () => {
  it("must run as LocalSystem", () => {
    throw new Error("SKALI_ADMIN_TESTS=1 requires running as LocalSystem; see the header of helper-user.test.ts");
  });
});

describe.skipIf(!enabled)("SkaliHelper as a separate user (admin, LocalSystem)", () => {
  let helper: Helper;
  let dir: string;
  let exe: string;
  let password: string;
  let fileCounter = 0;
  const started: number[] = [];

  const deleteUser = () =>
    execFileSync(helperExePath, ["delete-user"], { input: JSON.stringify({ name: TEST_USER }), windowsHide: true });

  beforeAll(() => {
    ensurePublished();
    helper = createHelper(helperExePath);
    // The test user can't read the current user's profile (repo, %TEMP%), so give it a folder of its own
    // with a copy of FakeGame.
    dir = path.join(process.env.ProgramData ?? "C:\\ProgramData", `skali-admin-test-${process.pid}`);
    fs.mkdirSync(dir, { recursive: true });
    exe = path.join(dir, "FakeGame.exe");
    fs.copyFileSync(fakeGamePath, exe);
    deleteUser(); // leftover of an aborted run; no-op when absent
  }, 180_000);

  afterEach(async () => {
    for (const pid of started.splice(0)) await helper.kill(pid).catch(() => false);
  });

  afterAll(async () => {
    // Give killed processes a moment to release their files.
    await new Promise((r) => setTimeout(r, 500));
    try {
      deleteUser();
    } finally {
      if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  });

  const tmpFile = () => path.join(dir, `out-${++fileCounter}.log`);
  const readOut = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

  async function waitForFile(file: string, re: RegExp, timeoutMs = 15_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const content = readOut(file);
      if (re.test(content)) return content;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${re} in ${file}; got: ${content}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function launchAsUser(args: string[]) {
    const out = tmpFile();
    const res = await helper.launch({ exe, args, cwd: dir, stdoutPath: out, user: { name: TEST_USER, password } });
    started.push(res.pid);
    return { ...res, out };
  }

  it("ensure-user creates the user, then only resets its password", async () => {
    const first = await helper.ensureUser(TEST_USER);
    const second = await helper.ensureUser(TEST_USER);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.password).toHaveLength(32);
    expect(second.password).toHaveLength(32);
    expect(second.password).not.toBe(first.password);
    password = second.password;
  }, TEST_TIMEOUT);

  it("launch as the user runs with that user's environment", async () => {
    const { out } = await launchAsUser(["--echo-env", "USERNAME"]);
    const content = await waitForFile(out, /ENV /);
    expect(content).toContain(`ENV USERNAME=${TEST_USER}`);
  }, TEST_TIMEOUT);

  it("Ctrl+C to a process running as the user still makes it save", async () => {
    const { pid, startTime, out } = await launchAsUser(["--ready-after", "0"]);
    await waitForFile(out, /READY/);
    await helper.ctrlC(pid, startTime);
    await waitForFile(out, /SAVED/);
  }, TEST_TIMEOUT);

  it("stats and kill work on a process running as the user", async () => {
    const { pid, startTime, out } = await launchAsUser(["--ignore-ctrlc", "--ready-after", "0"]);
    await waitForFile(out, /READY/);
    const [s] = await helper.stats([pid]);
    expect(s).toMatchObject({ pid, alive: true, startTime });
    expect(s.memBytes).toBeGreaterThan(0);
    expect(await helper.kill(pid, startTime)).toBe(true);
  }, TEST_TIMEOUT);
});
