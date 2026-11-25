import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeState, ServerStatus } from "@skali/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import { getAdapter } from "../../src/games/registry.js";
import { JobRunner, startGuardReason } from "../../src/jobs/runner.js";
import { Updater } from "../../src/jobs/update.js";
import { ServerRepo } from "../../src/servers/repo.js";
import { SteamCmdError } from "../../src/tools/steamcmd.js";

const JAR_OLD = Buffer.from("old jar");
const JAR_NEW = Buffer.from("new jar bytes");
const MANAGED = "C:\\ProgramData\\Skali\\tools\\java\\17\\bin\\java.exe";
const NEW_JAVA = "C:\\ProgramData\\Skali\\tools\\java\\21\\bin\\java.exe";

let root: string, db: Db, repo: ServerRepo, runner: JobRunner;
let status: ServerStatus;
let calls: string[];
let supervisor: { stop: ReturnType<typeof vi.fn>; start: ReturnType<typeof vi.fn>; state: (id: string) => RuntimeState };
let steamCmd: { appUpdate: ReturnType<typeof vi.fn> };
let java: { ensure: ReturnType<typeof vi.fn>; isManaged: (p: string) => boolean };
let mc: { resolve: ReturnType<typeof vi.fn> };
let updater: Updater;
let lines: string[];
const NOW = new Date("2026-11-24T10:20:30.456Z");

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-update-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, Buffer.alloc(32, 3));
  runner = new JobRunner({ repo, logsDir: path.join(root, "logs"), emit: (e) => { if (e.type === "log") lines.push(...e.lines); }, changed: () => {} });
  status = "stopped";
  calls = [];
  lines = [];
  supervisor = {
    state: () => ({ status, crashPaused: false }),
    stop: vi.fn(async () => {
      calls.push("stop");
      status = "stopped";
    }),
    start: vi.fn(async (id: string, opts?: { skipGuard?: boolean }) => {
      // Like the real supervisor: the start guard refuses while the update job is running.
      const guard = opts?.skipGuard ? null : startGuardReason(repo.get(id));
      if (guard) throw new Error(guard);
      calls.push("start");
      status = "running";
    }),
  };
  steamCmd = {
    appUpdate: vi.fn(async () => {
      calls.push("appUpdate");
    }),
  };
  java = { ensure: vi.fn(async () => NEW_JAVA), isManaged: (p) => p.toLowerCase().startsWith("c:\\programdata\\skali\\tools\\java\\") };
  mc = {
    resolve: vi.fn(async () => ({
      url: "https://piston-data.mojang.com/server.jar",
      sha1: crypto.createHash("sha1").update(JAR_NEW).digest("hex"),
      javaMajor: 21,
    })),
  };
  updater = new Updater({
    repo, runner, adapter: getAdapter, supervisor: supervisor as never, steamCmd: steamCmd as never,
    java: java as never, mc: mc as never, backupsDir: path.join(root, "backups"), now: () => NOW,
    fetch: (async () => new Response(JAR_NEW, { headers: { "content-length": String(JAR_NEW.length) } })) as never,
  });
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const done = (id: string) => vi.waitFor(() => expect(runner.isRunning(id)).toBe(false));
const backups = (id: string) => {
  try {
    return fs.readdirSync(path.join(root, "backups", id));
  } catch {
    return [];
  }
};
const logText = (_id: string): string => lines.join(" ");

function palServer(withSaves = true) {
  const folder = path.join(root, "pal");
  const saves = path.join(folder, "Pal", "Saved", "SaveGames");
  if (withSaves) {
    fs.mkdirSync(saves, { recursive: true });
    fs.writeFileSync(path.join(saves, "Level.sav"), "save");
  } else fs.mkdirSync(folder, { recursive: true });
  return repo.create({ name: "Pal", game: "palworld", folder, launch: { port: 8211 }, stopTimeoutSec: 60 });
}
function mcServer(launch: Record<string, string | number | boolean> = {}) {
  const folder = path.join(root, "mc");
  fs.mkdirSync(path.join(folder, "world"), { recursive: true });
  fs.writeFileSync(path.join(folder, "world", "level.dat"), "x");
  fs.writeFileSync(path.join(folder, "server.jar"), JAR_OLD);
  return repo.create({
    name: "Mc", game: "minecraft", folder, stopTimeoutSec: 60,
    launch: { jar: "server.jar", javaPath: MANAGED, mcFlavour: "vanilla", mcVersion: "1.20.4", ...launch },
  });
}

describe("Updater: Steam servers", () => {
  it("running server: stop, backup, update, start again; ends running with the job cleared", async () => {
    const s = palServer();
    status = "running";
    const r = await updater.update(s.id, {});
    expect(r).toEqual({ warnings: [] });
    await done(s.id);
    expect(calls).toEqual(["stop", "appUpdate", "start"]);
    expect(steamCmd.appUpdate.mock.calls[0]![1]).toBe(2394010);
    expect(backups(s.id)).toEqual(["2026-11-24T10-20-30-456Z-pre-update.zip"]);
    expect(repo.get(s.id).job).toBeNull();
    expect(status).toBe("running");
    expect(supervisor.start).toHaveBeenCalledWith(s.id, { skipGuard: true });
  });

  it("stopped server: no stop or start", async () => {
    const s = palServer();
    await updater.update(s.id, {});
    await done(s.id);
    expect(supervisor.stop).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(calls).toEqual(["appUpdate"]);
    expect(repo.get(s.id).job).toBeNull();
  });

  it("steps use the exact ids and labels", async () => {
    const s = palServer();
    let release!: () => void;
    steamCmd.appUpdate.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    await updater.update(s.id, {});
    expect(repo.get(s.id).job?.steps.map((x) => [x.id, x.label])).toEqual([
      ["stop", "Stop server"], ["backup", "Back up world"], ["files", "Update game files"], ["start", "Start server"],
    ]);
    await vi.waitFor(() => expect(steamCmd.appUpdate).toHaveBeenCalled());
    release();
    await done(s.id);
  });

  it("a backup failure fails the job, never calls appUpdate and never starts", async () => {
    const s = palServer();
    status = "running";
    fs.mkdirSync(path.join(root, "backups"), { recursive: true });
    fs.writeFileSync(path.join(root, "backups", s.id), "a file where the folder should be");
    await updater.update(s.id, {});
    await done(s.id);
    expect(steamCmd.appUpdate).not.toHaveBeenCalled();
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(status).toBe("stopped");
    expect(repo.get(s.id).job?.state).toBe("failed");
  });

  it("an update failure leaves the server stopped", async () => {
    const s = palServer();
    status = "running";
    steamCmd.appUpdate.mockRejectedValueOnce(new Error("disk full"));
    await updater.update(s.id, {});
    await done(s.id);
    expect(repo.get(s.id).job).toMatchObject({ state: "failed", error: "disk full" });
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(status).toBe("stopped");
  });

  it("a login-needed failure gets the login copy", async () => {
    const s = palServer();
    steamCmd.appUpdate.mockRejectedValueOnce(new SteamCmdError("login", "needs login"));
    await updater.update(s.id, {});
    await done(s.id);
    expect(repo.get(s.id).job?.error).toContain("needs a Steam login");
  });

  it("a missing save folder is logged and the update continues", async () => {
    const s = palServer(false);
    await updater.update(s.id, {});
    await done(s.id);
    expect(steamCmd.appUpdate).toHaveBeenCalled();
    expect(backups(s.id)).toEqual([]);
    expect(repo.get(s.id).job).toBeNull();
    expect(logText(s.id)).toContain("No world folder yet; nothing to back up");
  });

  it("a server type with no save locations logs that no backup is taken", async () => {
    const folder = path.join(root, "b");
    fs.mkdirSync(folder);
    const b = repo.create({ name: "B", game: "basic", folder, launch: {}, stopTimeoutSec: 60, steamAppId: 4321 });
    await updater.update(b.id, {});
    await done(b.id);
    expect(logText(b.id)).toContain("This server type has no known world folder; no backup taken");
    expect(logText(b.id)).not.toContain("No world folder yet");
    expect(backups(b.id)).toEqual([]);
  });

  it("refuses to back up through a junction save folder (fails before any update)", async () => {
    const s = palServer(false);
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "not a save");
    fs.symlinkSync(outside, path.join(s.folder, "Pal"), "junction");
    await updater.update(s.id, {});
    await done(s.id);
    expect(repo.get(s.id).job).toMatchObject({ state: "failed", error: expect.stringContaining("Refusing to back up through a link") });
    expect(steamCmd.appUpdate).not.toHaveBeenCalled();
    expect(backups(s.id)).toEqual([]);
  });

  it("refuses the backup and the update when the server folder became a junction", async () => {
    const s = palServer();
    const real = `${s.folder}-real`;
    fs.renameSync(s.folder, real);
    fs.symlinkSync(real, s.folder, "junction");
    await updater.update(s.id, {});
    await done(s.id);
    expect(repo.get(s.id).job).toMatchObject({ state: "failed", error: expect.stringContaining("is a link (junction or symlink)") });
    expect(steamCmd.appUpdate).not.toHaveBeenCalled();
    expect(backups(s.id)).toEqual([]);
  });

  it("basic without an app id is a BadRequest; with one it uses it", async () => {
    const folder = path.join(root, "b");
    fs.mkdirSync(folder);
    const b = repo.create({ name: "B", game: "basic", folder, launch: {}, stopTimeoutSec: 60 });
    await expect(updater.update(b.id, {})).rejects.toThrow("This server has no Steam app ID");
    expect(repo.get(b.id).job).toBeNull();
    const c = repo.create({ name: "C", game: "basic", folder: path.join(root, "c"), launch: {}, stopTimeoutSec: 60, steamAppId: 4321 });
    await updater.update(c.id, {});
    await done(c.id);
    expect(steamCmd.appUpdate.mock.calls[0]![1]).toBe(4321);
  });

  it("refuses with Conflict while starting/stopping or a job runs", async () => {
    const s = palServer();
    status = "starting";
    await expect(updater.update(s.id, {})).rejects.toThrow(/starting/);
    status = "stopping";
    await expect(updater.update(s.id, {})).rejects.toThrow(/stopping/);
    status = "stopped";
    let release!: () => void;
    steamCmd.appUpdate.mockImplementation(() => new Promise<void>((r) => { release = r; }));
    await updater.update(s.id, {});
    await expect(updater.update(s.id, {})).rejects.toThrow("already running");
    await vi.waitFor(() => expect(steamCmd.appUpdate).toHaveBeenCalled());
    release();
    await done(s.id);
  });
});

describe("Updater: Minecraft", () => {
  it("requires req.minecraft", async () => {
    const s = mcServer();
    await expect(updater.update(s.id, {})).rejects.toThrow("Choose a Minecraft flavour and version");
  });

  it("replaces the jar, keeps .previous, switches a managed java, records the new version", async () => {
    const s = mcServer({ paperBuild: 5 });
    fs.writeFileSync(path.join(s.folder, "server.jar.previous"), "older");
    status = "running";
    const r = await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } });
    expect(r.warnings).toEqual([]);
    await done(s.id);
    expect(repo.get(s.id).job).toBeNull();
    expect(fs.readFileSync(path.join(s.folder, "server.jar"))).toEqual(JAR_NEW);
    expect(fs.readFileSync(path.join(s.folder, "server.jar.previous"))).toEqual(JAR_OLD);
    expect(fs.existsSync(path.join(s.folder, "server.jar.new"))).toBe(false);
    const l = repo.get(s.id).launch;
    expect(l).toMatchObject({ javaPath: NEW_JAVA, mcFlavour: "vanilla", mcVersion: "1.21.4" });
    expect(l.paperBuild).toBeUndefined();
    expect(java.ensure).toHaveBeenCalledWith(21, expect.any(Function));
    expect(calls).toEqual(["stop", "start"]);
    expect(backups(s.id)).toHaveLength(1);
  });

  it("keeps an unmanaged javaPath and logs a warning", async () => {
    const s = mcServer({ javaPath: "C:\\Java\\bin\\java.exe" });
    await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } });
    await done(s.id);
    expect(java.ensure).not.toHaveBeenCalled();
    expect(repo.get(s.id).launch.javaPath).toBe("C:\\Java\\bin\\java.exe");
    expect(logText(s.id)).toContain("Warning: this server uses its own Java");
  });

  it("returns the downgrade warning; no warning for an unknown current version", async () => {
    const s = mcServer();
    const r = await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.19.2" } });
    expect(r.warnings).toEqual(["Minecraft 1.19.2 is older than 1.20.4. Worlds opened in a newer version may break; a backup is taken first."]);
    await done(s.id);
    repo.update(s.id, { launch: { ...repo.get(s.id).launch, mcVersion: "" } });
    const r2 = await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.19.2" } });
    expect(r2.warnings).toEqual([]);
    await done(s.id);
  });

  it("a checksum mismatch fails the job and leaves the old jar", async () => {
    const s = mcServer();
    mc.resolve.mockResolvedValueOnce({ url: "https://x/server.jar", sha1: "0".repeat(40), javaMajor: 21 });
    await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } });
    await done(s.id);
    expect(repo.get(s.id).job?.state).toBe("failed");
    expect(fs.readFileSync(path.join(s.folder, "server.jar"))).toEqual(JAR_OLD);
    expect(repo.get(s.id).launch.mcVersion).toBe("1.20.4");
  });
});

describe("Updater: fix round 1", () => {
  it("a stop that leaves a pid tracked fails the job before any backup or update", async () => {
    const s = palServer();
    status = "running";
    repo.update(s.id, { pid: 4242, pidStartTime: "t" });
    supervisor.stop.mockImplementation(async () => { status = "stopped"; });
    await updater.update(s.id, {});
    await done(s.id);
    expect(repo.get(s.id).job).toMatchObject({ state: "failed" });
    expect(steamCmd.appUpdate).not.toHaveBeenCalled();
    expect(backups(s.id)).toEqual([]);
    expect(supervisor.start).not.toHaveBeenCalled();
  });

  it("refuses to start when a stopped server still has a tracked pid", async () => {
    const s = palServer();
    repo.update(s.id, { pid: 4242, pidStartTime: "t" });
    await expect(updater.update(s.id, {})).rejects.toThrow(/process/);
  });

  it("refuses a failed install and a setup-pending server", async () => {
    const s = palServer();
    repo.update(s.id, { job: { kind: "install", state: "failed", steps: [], runId: "r", params: { game: "palworld" }, error: "x" } });
    await expect(updater.update(s.id, {})).rejects.toThrow(/install/);
    expect(repo.get(s.id).job?.kind).toBe("install");
    repo.update(s.id, { job: null, setupPending: true });
    await expect(updater.update(s.id, {})).rejects.toThrow("Finish setup first");
  });

  it("a failing final rename keeps server.jar, the old version and the old Java", async () => {
    const s = mcServer();
    const real = fs.renameSync;
    const spy = vi.spyOn(fs, "renameSync").mockImplementation((a, b) => {
      if (String(b).endsWith("server.jar")) throw new Error("EBUSY");
      return real(a, b);
    });
    try {
      await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } });
      await done(s.id);
    } finally {
      spy.mockRestore();
    }
    expect(repo.get(s.id).job?.state).toBe("failed");
    expect(fs.readFileSync(path.join(s.folder, "server.jar"))).toEqual(JAR_OLD);
    const l = repo.get(s.id).launch;
    expect(l.mcVersion).toBe("1.20.4");
    expect(l.javaPath).toBe(MANAGED);
  });

  it("works without an older .previous and leaves the old jar as .previous", async () => {
    const s = mcServer();
    await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } });
    await done(s.id);
    expect(fs.readFileSync(path.join(s.folder, "server.jar.previous"))).toEqual(JAR_OLD);
    expect(fs.readFileSync(path.join(s.folder, "server.jar"))).toEqual(JAR_NEW);
  });

  it("drops a level-name that points outside the server folder from the backup", async () => {
    const s = mcServer();
    fs.rmSync(path.join(s.folder, "world"), { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "big.bin"), "not a world");
    fs.writeFileSync(path.join(s.folder, "server.properties"), String.raw`level-name=..\\outside` + "\n");
    await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } });
    await done(s.id);
    expect(repo.get(s.id).job).toBeNull();
    expect(backups(s.id)).toEqual([]);
    expect(logText(s.id)).toContain("No world folder yet; nothing to back up");
  });

  it("refuses a junction level folder before zipping", async () => {
    const s = mcServer();
    fs.rmSync(path.join(s.folder, "world"), { recursive: true });
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "level.dat"), "elsewhere");
    fs.symlinkSync(outside, path.join(s.folder, "world"), "junction");
    await updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } });
    await done(s.id);
    expect(repo.get(s.id).job).toMatchObject({ state: "failed", error: expect.stringContaining("Refusing to back up through a link") });
    expect(backups(s.id)).toEqual([]);
    expect(fs.readFileSync(path.join(s.folder, "server.jar"))).toEqual(JAR_OLD);
  });

  it("refuses a jar outside the server folder before any job", async () => {
    const s = mcServer({ jar: path.join(root, "elsewhere.jar") });
    await expect(updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } })).rejects.toThrow(/inside the server folder/);
    repo.update(s.id, { launch: { ...repo.get(s.id).launch, jar: "../x.jar" } });
    await expect(updater.update(s.id, { minecraft: { flavour: "vanilla", version: "1.21.4" } })).rejects.toThrow(/inside the server folder/);
    expect(repo.get(s.id).job).toBeNull();
  });
});
