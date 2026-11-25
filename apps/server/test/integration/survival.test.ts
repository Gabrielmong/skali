import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import { createHelper } from "../../src/proc/helper.js";
import { Supervisor } from "../../src/proc/supervisor.js";
import { ServerRepo } from "../../src/servers/repo.js";
import { ensurePublished, fakeGamePath, helperExePath } from "../support/fake-game.js";
import { fakeGameAdapter } from "../support/survival-adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Spawns tsx, SkaliHelper and FakeGame for real; generous timeouts so a busy whole-repo run doesn't trip them.
describe.skipIf(process.platform !== "win32")("game survives Skali process death", { timeout: 120_000 }, () => {
  const key = Buffer.alloc(32, 7);
  let dir: string;
  let db: Db | null = null;
  let host: ChildProcess | null = null;
  let sup: Supervisor | null = null;
  const helper = () => createHelper(helperExePath);

  beforeAll(() => {
    ensurePublished();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skali-surv-"));
  }, 120_000);

  afterAll(async () => {
    sup?.shutdown();
    if (host?.pid) {
      try {
        execFileSync("taskkill", ["/T", "/F", "/PID", String(host.pid)], { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
    try {
      db ??= openDb(path.join(dir, "t.db"));
      const rows = db.prepare("SELECT pid, pid_start_time AS st FROM servers WHERE pid IS NOT NULL").all() as { pid: number; st: string | null }[];
      for (const r of rows) {
        try {
          if ((await helper().stats([r.pid]))[0]?.alive) await helper().kill(r.pid, r.st ?? undefined);
        } catch {
          try {
            execFileSync("taskkill", ["/T", "/F", "/PID", String(r.pid)], { stdio: "ignore" });
          } catch {
            // gone
          }
        }
      }
    } catch {
      // nothing recorded
    }
    db?.close();
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }, 60_000);

  it("re-attaches to and gracefully stops a game whose host process was killed", async () => {
    const dbPath = path.join(dir, "t.db");
    const logsDir = path.join(dir, "logs");
    db = openDb(dbPath);
    const repo = new ServerRepo(db, key);
    const rec = repo.create({ name: "X", game: "basic", folder: dir, launch: {}, stopTimeoutSec: 20 });
    db.close();
    db = null;

    // Non-detached child of this process, as the service is under NSSM.
    const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
    host = spawn(process.execPath, [tsxCli, path.join(here, "supervisor-host.ts")], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        SKALI_HOST_CFG: JSON.stringify({ dbPath, logsDir, helperPath: helperExePath, serverId: rec.id, secretKeyHex: key.toString("hex") }),
      },
    });
    let out = "";
    let err = "";
    host.stdout!.on("data", (b: Buffer) => (out += b.toString()));
    host.stderr!.on("data", (b: Buffer) => (err += b.toString()));
    const hostExit = new Promise<void>((r) => host!.once("exit", () => r()));
    const started = await Promise.race([
      (async () => {
        while (!/STARTED (\d+)/.test(out)) await sleep(100);
        return Number(/STARTED (\d+)/.exec(out)![1]);
      })(),
      hostExit.then(() => Promise.reject(new Error(`host exited early: ${err}${out}`))),
      sleep(40_000).then(() => Promise.reject(new Error(`host start timed out: ${err}${out}`))),
    ]);
    const pid = started as number;

    // Kill the whole host tree. taskkill exits non-zero when the host (or a child in its tree) is already gone
    // ("process not found"); that is fine as long as the host does exit.
    try {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(host.pid)], { stdio: "ignore" });
    } catch (e) {
      await Promise.race([
        hostExit,
        sleep(15_000).then(() => Promise.reject(new Error(`taskkill failed and the host is still running: ${String(e)}`))),
      ]);
    }
    await hostExit;
    await sleep(2000);

    const stat = (await helper().stats([pid]))[0]!;
    expect(stat.alive).toBe(true);

    // A new Supervisor (the restarted service) re-attaches.
    db = openDb(dbPath);
    const repo2 = new ServerRepo(db, key);
    expect(repo2.get(rec.id).pid).toBe(pid);
    expect(stat.startTime).toBe(repo2.get(rec.id).pidStartTime);
    sup = new Supervisor({
      repo: repo2,
      helper: helper(),
      adapter: () => fakeGameAdapter,
      logsDir,
      gamesUser: null,
      emit: () => undefined,
    });
    await sup.boot();
    expect(sup.state(rec.id).status).toBe("running");
    expect(repo2.get(rec.id).pid).toBe(pid);

    await sup.stop(rec.id);
    expect(sup.state(rec.id).status).toBe("stopped");
    const runId = repo2.get(rec.id).currentRunId!;
    const log = fs.readFileSync(path.join(logsDir, rec.id, runId, "console.log"), "utf8");
    const lines = log.split(/\r?\n/).filter((l) => l && !l.startsWith("[skali]"));
    expect(lines.at(-1)).toBe("SAVED");
    expect(log).not.toContain("Forced stop");
    expect((await helper().stats([pid]))[0]!.alive).toBe(false);
  }, 120_000);
});
