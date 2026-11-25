import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigHistory } from "../../src/config/history.js";
import { ConfigSourcesRepo } from "../../src/config/sources-repo.js";
import { openDb, type Db } from "../../src/db.js";
import { getAdapter } from "../../src/games/registry.js";
import { createApp, type AppDeps } from "../../src/http/app.js";
import { Installer } from "../../src/jobs/install.js";
import { Updater } from "../../src/jobs/update.js";
import { JobRunner } from "../../src/jobs/runner.js";
import { Adopter } from "../../src/servers/adopt.js";
import { ServerRepo, type PersistedJob, type ServerRecord } from "../../src/servers/repo.js";
import { SettingsStore } from "../../src/settings.js";

let root: string, db: Db, repo: ServerRepo, settings: SettingsStore;
let fw: { ensure: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> };
let logs: string[];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-appi-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, Buffer.alloc(32, 5));
  settings = new SettingsStore(db, ["127.0.0.1"]);
  fw = { ensure: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) };
  logs = [];
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function app(over: Partial<AppDeps> = {}) {
  const webDist = path.join(root, "web");
  fs.mkdirSync(webDist, { recursive: true });
  const adopter = new Adopter({ repo, adapter: getAdapter, gamesUser: null, firewall: fw.ensure as never, removeFirewall: fw.remove as never });
  return createApp({
    repo, settings, adopter, webDist,
    logsDir: path.join(root, "logs"),
    configSources: new ConfigSourcesRepo(db),
    configHistory: new ConfigHistory(path.join(root, "hist")),
    supervisor: {
      state: () => ({ status: "stopped", crashPaused: false }),
      start: vi.fn(), stop: vi.fn(), restart: vi.fn(), command: vi.fn(), forget: vi.fn(),
    },
    firewall: { ensure: fw.ensure as never, remove: fw.remove as never },
    remoteAddress: () => "127.0.0.1",
    hostname: "SERVER-PC",
    log: (m) => logs.push(m),
    ...over,
  });
}

const failedInstall: PersistedJob = {
  kind: "install", state: "failed", steps: [{ id: "files", label: "Download game files", state: "failed" }],
  error: "boom", runId: "r", params: { game: "palworld", appId: 2394010 },
};
function mk(over: Partial<ServerRecord> = {}, game: ServerRecord["game"] = "palworld"): ServerRecord {
  const name = over.name ?? "Pal";
  const folder = path.join(root, "games", name);
  fs.mkdirSync(path.join(folder, "Pal"), { recursive: true });
  fs.writeFileSync(path.join(folder, "Pal", "x.txt"), "x");
  return repo.create({
    name, game, folder, launch: game === "basic" ? {} : { port: 8211 }, stopTimeoutSec: 60,
    createdFolder: true, job: failedInstall, ...over,
  });
}
const del = (id: string, q = "") => request(app()).delete(`/api/servers/${id}${q}`).set("X-Skali", "1");

describe("DELETE ?deleteFolder=1", () => {
  it("deletes the folder of a failed install Skáli created", async () => {
    const s = mk();
    expect((await del(s.id, "?deleteFolder=1")).status).toBe(204);
    expect(repo.list()).toEqual([]);
    expect(fs.existsSync(s.folder)).toBe(false);
    expect(fs.existsSync(path.dirname(s.folder))).toBe(true);
  });
  it("keeps the folder without the flag", async () => {
    const s = mk();
    expect((await del(s.id)).status).toBe(204);
    expect(fs.existsSync(s.folder)).toBe(true);
  });
  it("ignores the flag when Skáli didn't create the folder or the job isn't a failed install", async () => {
    const a = mk({ name: "A", createdFolder: false });
    expect((await del(a.id, "?deleteFolder=1")).status).toBe(204);
    expect(fs.existsSync(a.folder)).toBe(true);
    const b = mk({ name: "B", job: null });
    expect((await del(b.id, "?deleteFolder=1")).status).toBe(204);
    expect(fs.existsSync(b.folder)).toBe(true);
  });
  it("refuses while installing → 409 and keeps everything", async () => {
    const s = mk({ job: { ...failedInstall, state: "running" } });
    const r = await del(s.id, "?deleteFolder=1");
    expect(r.status).toBe(409);
    expect(repo.list()).toHaveLength(1);
    expect(fs.existsSync(s.folder)).toBe(true);
  });
});

describe("PATCH steamAppId", () => {
  const patch = (id: string, body: object) => request(app()).patch(`/api/servers/${id}`).set("X-Skali", "1").send(body);
  it("sets and clears a basic server's app id", async () => {
    const s = mk({ job: null, launch: { exe: "a.exe" } }, "basic");
    const r = await patch(s.id, { steamAppId: 376030 });
    expect(r.status).toBe(200);
    expect(r.body.steamAppId).toBe(376030);
    expect(repo.get(s.id).steamAppId).toBe(376030);
    await patch(s.id, { steamAppId: null }).expect(200);
    expect(repo.get(s.id).steamAppId).toBeNull();
  });
  it.each([[0], [-5], [1.5], ["12"], [2 ** 31 + 1]])("rejects %j", async (v) => {
    const s = mk({ job: null, launch: { exe: "a.exe" } }, "basic");
    expect((await patch(s.id, { steamAppId: v })).status).toBe(400);
  });
  it("is basic only", async () => {
    const s = mk({ job: null });
    const r = await patch(s.id, { steamAppId: 5 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/basic/i);
  });
});

describe("PATCH launch on a setupPending server", () => {
  const patch = (id: string, body: object) => request(app()).patch(`/api/servers/${id}`).set("X-Skali", "1").send(body);
  function pending(): ServerRecord {
    const s = mk({ job: null, setupPending: true, launch: { exe: "GameServer.exe", ports: "7777/udp" } }, "basic");
    fs.writeFileSync(path.join(s.folder, "GameServer.exe"), "exe");
    return s;
  }
  it("clears setupPending when the exe exists and syncs the firewall even with unchanged ports", async () => {
    const s = pending();
    const r = await patch(s.id, { launch: { exe: "GameServer.exe", ports: "7777/udp" } });
    expect(r.status).toBe(200);
    expect(r.body.setupPending).toBe(false);
    expect(repo.get(s.id).setupPending).toBe(false);
    expect(fw.ensure).toHaveBeenCalledWith("Pal", [{ port: 7777, protocol: "udp", purpose: "Game", forward: true }]);
  });
  it("a missing exe → 400 and stays pending", async () => {
    const s = pending();
    const r = await patch(s.id, { launch: { exe: "Nope.exe" } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/Nope\.exe/);
    expect(repo.get(s.id).setupPending).toBe(true);
    expect(repo.get(s.id).launch.exe).toBe("GameServer.exe");
  });
  it("an exe outside the folder → 400", async () => {
    const s = pending();
    fs.writeFileSync(path.join(root, "outside.exe"), "exe");
    expect((await patch(s.id, { launch: { exe: "..\\..\\outside.exe" } })).status).toBe(400);
    expect(repo.get(s.id).setupPending).toBe(true);
  });
  it("a firewall failure reverts setupPending", async () => {
    const s = pending();
    fw.ensure.mockRejectedValueOnce(new Error("netsh broke"));
    expect((await patch(s.id, { launch: { exe: "GameServer.exe" } })).status).toBe(500);
    expect(repo.get(s.id).setupPending).toBe(true);
  });
  it("a PATCH without launch leaves setupPending alone", async () => {
    const s = pending();
    await patch(s.id, { autoStart: false }).expect(200);
    expect(repo.get(s.id).setupPending).toBe(true);
  });
});

describe("PATCH keeps install-set Minecraft launch keys", () => {
  const patch = (id: string, body: object) => request(app()).patch(`/api/servers/${id}`).set("X-Skali", "1").send(body);
  function mcServer(): ServerRecord {
    const folder = path.join(root, "mc");
    fs.mkdirSync(folder, { recursive: true });
    return repo.create({
      name: "Mc", game: "minecraft", folder, stopTimeoutSec: 60,
      launch: { jar: "server.jar", javaPath: "java", memoryMb: 4096, jvmArgs: "", port: 25565, rconPort: 25575, mcFlavour: "paper", mcVersion: "1.21.4", paperBuild: 123 },
    });
  }
  it("accepts the full launch object sent back unchanged and keeps the keys", async () => {
    const s = mcServer();
    const r = await patch(s.id, { launch: { ...s.launch, memoryMb: 6144 } });
    expect(r.status).toBe(200);
    expect(repo.get(s.id).launch).toMatchObject({ memoryMb: 6144, mcFlavour: "paper", mcVersion: "1.21.4", paperBuild: 123 });
  });
  it("keeps them when the client omits them", async () => {
    const s = mcServer();
    await patch(s.id, { launch: { memoryMb: 5000 } }).expect(200);
    expect(repo.get(s.id).launch).toMatchObject({ mcFlavour: "paper", mcVersion: "1.21.4", paperBuild: 123 });
  });
  it.each([[{ mcVersion: "1.20.1" }], [{ mcFlavour: "vanilla" }], [{ paperBuild: 1 }]])("refuses a change %j", async (change) => {
    const s = mcServer();
    const r = await patch(s.id, { launch: { ...s.launch, ...change } });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/install/i);
    expect(repo.get(s.id).launch).toEqual(s.launch);
  });
  it("refuses setting them on a server that has none (adopted)", async () => {
    const folder = path.join(root, "mc2");
    fs.mkdirSync(folder);
    const s = repo.create({ name: "Mc2", game: "minecraft", folder, stopTimeoutSec: 60, launch: { jar: "server.jar" } });
    expect((await patch(s.id, { launch: { mcVersion: "1.21.4" } })).status).toBe(400);
    expect(repo.get(s.id).launch.mcVersion).toBeUndefined();
  });
});

describe("retry vs DELETE", () => {
  function rig() {
    const runner = new JobRunner({ repo, logsDir: path.join(root, "logs"), emit: () => {}, changed: () => {} });
    let release!: () => void;
    const appUpdate = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const installer = new Installer({
      repo, runner, adapter: getAdapter, settings, gamesUser: null,
      steamCmd: { ensure: async () => undefined, appUpdate } as never,
      java: { ensure: async () => "java" } as never, mc: { resolve: vi.fn() } as never,
      configService: { read: vi.fn(), save: vi.fn() } as never,
      firewall: fw.ensure as never, probe: async () => true, protectedPaths: { dataDir: null },
    });
    const slowRemove = vi.fn<(name: string) => Promise<void>>(async () => undefined);
    const adopter = new Adopter({ repo, adapter: getAdapter, gamesUser: null, firewall: fw.ensure as never, removeFirewall: slowRemove });
    const a = app({ adopter, setup: { steamCmd: {} as never, java: {} as never, mcSources: {} as never, portsInUse: () => [], installer } });
    return { a, runner, appUpdate, release: () => release(), slowRemove };
  }
  const failed = (): ServerRecord =>
    mk({ job: { ...failedInstall, steps: [{ id: "steamcmd", label: "Get SteamCMD", state: "done" }, { id: "files", label: "Download game files", state: "failed" }] } });

  it("a retry while a DELETE is in flight → 409 and starts no job", async () => {
    const { a, runner, slowRemove } = rig();
    const s = failed();
    let releaseFw!: () => void;
    slowRemove.mockImplementationOnce(() => new Promise<void>((r) => { releaseFw = r; }));
    const del = request(a).delete(`/api/servers/${s.id}?deleteFolder=1`).set("X-Skali", "1").then((x) => x);
    await vi.waitFor(() => expect(slowRemove).toHaveBeenCalled());
    const r = await request(a).post(`/api/servers/${s.id}/retry`).set("X-Skali", "1");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "Server is being removed" });
    expect(runner.isRunning(s.id)).toBe(false);
    releaseFw();
    expect((await del).status).toBe(204);
    expect(repo.list()).toEqual([]);
    expect(fs.existsSync(s.folder)).toBe(false);
  });

  it("a DELETE after a retry started → 409; the record and folder stay for the running job", async () => {
    const { a, runner, appUpdate, release } = rig();
    const s = failed();
    expect((await request(a).post(`/api/servers/${s.id}/retry`).set("X-Skali", "1")).status).toBe(202);
    await vi.waitFor(() => expect(appUpdate).toHaveBeenCalled());
    const r = await request(a).delete(`/api/servers/${s.id}?deleteFolder=1`).set("X-Skali", "1");
    expect(r.status).toBe(409);
    expect(repo.get(s.id).job?.state).toBe("running");
    expect(fs.existsSync(s.folder)).toBe(true);
    release();
    await vi.waitFor(() => expect(runner.isRunning(s.id)).toBe(false));
  });

  it("overlapping DELETE and retry never leave a running job on a deleted record", async () => {
    const { a, runner } = rig();
    const s = failed();
    const [d, r] = await Promise.all([
      request(a).delete(`/api/servers/${s.id}?deleteFolder=1`).set("X-Skali", "1").then((x) => x),
      request(a).post(`/api/servers/${s.id}/retry`).set("X-Skali", "1").then((x) => x),
    ]);
    if (d.status === 204) {
      expect(r.status).not.toBe(202);
      expect(runner.isRunning(s.id)).toBe(false);
      expect(repo.list()).toEqual([]);
    } else {
      expect(r.status).toBe(202);
      expect(repo.get(s.id).job?.state).toBe("running");
      expect(fs.existsSync(s.folder)).toBe(true);
    }
  });
});

describe("fix round 1", () => {
  const patch = (id: string, body: object, a = app()) => request(a).patch(`/api/servers/${id}`).set("X-Skali", "1").send(body);

  it("deleteFolder refuses (409, nothing removed) when an adopted server's folder is nested inside", async () => {
    const s = mk();
    const nested = path.join(s.folder, "Pal");
    repo.create({ name: "Nested", game: "valheim", folder: nested, launch: {}, stopTimeoutSec: 60 });
    const r = await del(s.id, "?deleteFolder=1");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Nested/);
    expect(repo.list()).toHaveLength(2);
    expect(fs.existsSync(path.join(nested, "x.txt"))).toBe(true);
    // without the flag the record goes and the folder stays
    expect((await del(s.id)).status).toBe(204);
    expect(fs.existsSync(path.join(nested, "x.txt"))).toBe(true);
  });

  it("deleteFolder refuses when another server's folder is a parent", async () => {
    const s = mk();
    repo.create({ name: "Parent", game: "valheim", folder: path.dirname(s.folder), launch: {}, stopTimeoutSec: 60 });
    const r = await del(s.id, "?deleteFolder=1");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Parent/);
    expect(fs.existsSync(s.folder)).toBe(true);
  });

  it("deleteFolder refuses a folder the folder rules deny", async () => {
    const s = mk();
    const r = await request(app({ protectedPaths: { dataDir: path.join(root, "games") } }))
      .delete(`/api/servers/${s.id}?deleteFolder=1`).set("X-Skali", "1");
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/Skáli's own data/);
    expect(fs.existsSync(s.folder)).toBe(true);
    expect(repo.list()).toHaveLength(1);
  });

  it("the folder is deleted before the record goes (an install to that path is refused meanwhile)", async () => {
    const s = mk();
    const seen: number[] = [];
    const real = fs.promises.rm;
    const spy = vi.spyOn(fs.promises, "rm").mockImplementation(async (p, o) => {
      seen.push(repo.list().length);
      return real(p, o);
    });
    try {
      expect((await del(s.id, "?deleteFolder=1")).status).toBe(204);
    } finally {
      spy.mockRestore();
    }
    expect(seen).toEqual([1]);
    expect(repo.list()).toEqual([]);
    expect(fs.existsSync(s.folder)).toBe(false);
  });

  it("finish setup accepts an exe named ..foo.exe and refuses one reached through a junction", async () => {
    const s = mk({ job: null, setupPending: true, launch: { exe: "x.exe" } }, "basic");
    fs.writeFileSync(path.join(s.folder, "..foo.exe"), "exe");
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "evil.exe"), "exe");
    fs.symlinkSync(outside, path.join(s.folder, "bin"), "junction");
    const bad = await patch(s.id, { launch: { exe: path.join("bin", "evil.exe") } });
    expect(bad.status).toBe(400);
    expect(repo.get(s.id).setupPending).toBe(true);
    const okr = await patch(s.id, { launch: { exe: "..foo.exe" } });
    expect(okr.body.error).toBeUndefined();
    expect(okr.status).toBe(200);
    expect(repo.get(s.id).setupPending).toBe(false);
  });

  it.each([[{ name: "Renamed" }], [{ launch: { port: 9000 } }], [{ autoStart: false }]])("PATCH %j while a job runs → 409", async (body) => {
    const s = mk({ job: { ...failedInstall, state: "running" } });
    const r = await patch(s.id, body);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/install/);
    expect(repo.get(s.id).name).toBe("Pal");
    expect(fw.ensure).not.toHaveBeenCalled();
  });

  it("PATCH steamAppId while an update runs → 409", async () => {
    const s = mk({ job: { ...failedInstall, kind: "update", state: "running" }, launch: { exe: "a.exe" } }, "basic");
    const r = await patch(s.id, { steamAppId: 5 });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/update/);
  });
});

describe("POST /api/servers/:id/update", () => {
  function rig() {
    const runner = new JobRunner({ repo, logsDir: path.join(root, "logs"), emit: () => {}, changed: () => {} });
    let release!: () => void;
    const appUpdate = vi.fn(() => new Promise<void>((r) => { release = r; }));
    const updater = new Updater({
      repo, runner, adapter: getAdapter, backupsDir: path.join(root, "backups"),
      supervisor: { state: () => ({ status: "stopped", crashPaused: false }), start: vi.fn(), stop: vi.fn() } as never,
      steamCmd: { appUpdate } as never, java: {} as never, mc: {} as never,
    });
    const slowRemove = vi.fn<(name: string) => Promise<void>>(async () => undefined);
    const adopter = new Adopter({ repo, adapter: getAdapter, gamesUser: null, firewall: fw.ensure as never, removeFirewall: slowRemove });
    const a = app({ adopter, setup: { steamCmd: {} as never, java: {} as never, mcSources: {} as never, portsInUse: () => [], updater } });
    return { a, runner, appUpdate, release: () => release(), slowRemove };
  }
  const post = (a: ReturnType<typeof app>, id: string, body: object = {}) =>
    request(a).post(`/api/servers/${id}/update`).set("X-Skali", "1").send(body);

  it("202 with warnings; the job runs and a PATCH meanwhile is refused", async () => {
    const { a, runner, appUpdate, release } = rig();
    const s = mk({ job: null });
    const r = await post(a, s.id);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ warnings: [] });
    await vi.waitFor(() => expect(appUpdate).toHaveBeenCalled());
    const p = await request(a).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send({ name: "Renamed" });
    expect(p.status).toBe(409);
    release();
    await vi.waitFor(() => expect(runner.isRunning(s.id)).toBe(false));
    expect(repo.get(s.id).job).toBeNull();
  });

  it("409 while an install job runs", async () => {
    const { a } = rig();
    const s = mk({ job: { ...failedInstall, state: "running" } });
    expect((await post(a, s.id)).status).toBe(409);
  });

  it("400 for basic without an app id", async () => {
    const { a } = rig();
    const s = mk({ job: null, launch: { exe: "a.exe" } }, "basic");
    const r = await post(a, s.id);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "This server has no Steam app ID" });
  });

  it("400 for an unknown body field", async () => {
    const { a } = rig();
    const s = mk({ job: null });
    expect((await post(a, s.id, { bogus: 1 })).status).toBe(400);
  });

  it("409 while the server is being removed, and starts no job", async () => {
    const { a, runner, slowRemove } = rig();
    const s = mk({ job: null });
    let releaseFw!: () => void;
    slowRemove.mockImplementationOnce(() => new Promise<void>((r) => { releaseFw = r; }));
    const del = request(a).delete(`/api/servers/${s.id}`).set("X-Skali", "1").then((x) => x);
    await vi.waitFor(() => expect(slowRemove).toHaveBeenCalled());
    const r = await post(a, s.id);
    expect(r.status).toBe(409);
    expect(runner.isRunning(s.id)).toBe(false);
    releaseFw();
    expect((await del).status).toBe(204);
  });
});

describe("POST /api/servers/:id/update (Minecraft lookup outside the edit lock)", () => {
  it("a slow version lookup doesn't block a PATCH; the update re-checks the jar after it", async () => {
    const runner = new JobRunner({ repo, logsDir: path.join(root, "logs"), emit: () => {}, changed: () => {} });
    let lookedUp!: (v: unknown) => void;
    const resolve = vi.fn(() => new Promise((r) => { lookedUp = r; }));
    const updater = new Updater({
      repo, runner, adapter: getAdapter, backupsDir: path.join(root, "backups"),
      supervisor: { state: () => ({ status: "stopped", crashPaused: false }), start: vi.fn(), stop: vi.fn() } as never,
      steamCmd: {} as never, java: {} as never, mc: { resolve } as never,
    });
    const a = app({ setup: { steamCmd: {} as never, java: {} as never, mcSources: {} as never, portsInUse: () => [], updater } });
    const s = mk({ job: null, name: "Mc", launch: { jar: "server.jar", javaPath: "java", port: 25565, rconPort: 25575 } }, "minecraft");
    const upd = request(a).post(`/api/servers/${s.id}/update`).set("X-Skali", "1")
      .send({ minecraft: { flavour: "vanilla", version: "1.21.4" } }).then((x) => x);
    await vi.waitFor(() => expect(resolve).toHaveBeenCalled());
    // The lookup is pending, yet an edit goes through: the edit lock isn't held across the network call.
    const p = await request(a).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send({ launch: { ...s.launch, jar: "../outside.jar" } });
    expect(p.status).toBe(200);
    lookedUp({ url: "https://example.test/server.jar", sha1: "a".repeat(40), javaMajor: 21 });
    const r = await upd;
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/inside the server folder/);
    expect(runner.isRunning(s.id)).toBe(false);
    expect(repo.get(s.id).job).toBeNull();
  });
});

describe("start clears a failed update job", () => {
  const failedUpdate: PersistedJob = { ...failedInstall, kind: "update", error: "x" };
  const startReq = (id: string) => request(app()).post(`/api/servers/${id}/start`).set("X-Skali", "1");
  it("clears a failed update once the start succeeds", async () => {
    const s = mk({ job: failedUpdate, createdFolder: false });
    expect((await startReq(s.id)).status).toBe(202);
    expect(repo.get(s.id).job).toBeNull();
  });
  it("leaves a failed update when the start is refused", async () => {
    const s = mk({ job: failedUpdate, createdFolder: false });
    const sup = { state: () => ({ status: "stopped", crashPaused: false }), start: vi.fn(async () => { throw new Error("nope"); }), stop: vi.fn(), restart: vi.fn(), command: vi.fn(), forget: vi.fn() };
    const r = await request(app({ supervisor: sup as never })).post(`/api/servers/${s.id}/start`).set("X-Skali", "1");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(repo.get(s.id).job).not.toBeNull();
  });
  it("never clears a failed install", async () => {
    const s = mk();
    await startReq(s.id);
    expect(repo.get(s.id).job?.kind).toBe("install");
  });
});
