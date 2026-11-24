import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PortSpec, RuntimeState } from "@skali/shared";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import { BadRequestError, ConflictError } from "../../src/errors.js";
import { createApp, type AdopterApi, type AppDeps, type AppEvent, type SupervisorApi } from "../../src/http/app.js";
import { createRun } from "../../src/logs/runs.js";
import type { ServerRecord } from "../../src/servers/repo.js";
import { ServerRepo } from "../../src/servers/repo.js";
import { Adopter } from "../../src/servers/adopt.js";
import { getAdapter } from "../../src/games/registry.js";
import { SettingsStore } from "../../src/settings.js";

const key = Buffer.alloc(32, 3);
let root: string, db: Db, repo: ServerRepo, settings: SettingsStore, logsDir: string, webDist: string;
let remote: string | undefined;
let states: Map<string, RuntimeState>;
type Fn = (...args: never[]) => unknown;
type Mocked<T> = { [K in keyof T]: T[K] extends Fn ? Mock<T[K]> : never };
type Firewall = NonNullable<AppDeps["firewall"]>;
let supervisor: Mocked<SupervisorApi>;
let adopter: Mocked<AdopterApi>;
let fw: Mocked<Firewall>;
let logs: string[];
let events: AppEvent[];

function deps(over: Partial<AppDeps> = {}): AppDeps {
  return {
    repo, supervisor, adopter, settings, logsDir, webDist,
    firewall: { ensure: fw.ensure, remove: fw.remove },
    remoteAddress: () => remote,
    hostname: "SERVER-PC",
    log: (m) => logs.push(m),
    notify: (e) => events.push(e),
    opWindowMs: 50,
    ...over,
  };
}
const app = (over: Partial<AppDeps> = {}) => createApp(deps(over));

function mkValheim(name = "friends", password = "secret1"): ServerRecord {
  const folder = path.join(root, `vh-${name}`);
  fs.mkdirSync(folder, { recursive: true });
  return repo.create({
    name, game: "valheim", folder, stopTimeoutSec: 90,
    launch: { port: 2456, world: "Dedicated", public: true, crossplay: false, extraArgs: "", password },
  });
}
function mkMinecraft(name = "mc"): ServerRecord {
  const folder = path.join(root, `mc-${name}`);
  fs.mkdirSync(folder, { recursive: true });
  return repo.create({
    name, game: "minecraft", folder, stopTimeoutSec: 60, secrets: { rconPassword: "rcon-secret-value" },
    launch: { jar: "server.jar", javaPath: "java", memoryMb: 2048, jvmArgs: "", port: 25565, rconPort: 25575 },
  });
}

/** Every key anywhere in a JSON value. */
function allKeys(v: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); allKeys(x, out); }
  return out;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-app-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, key);
  settings = new SettingsStore(db, ["192.168.0.150"]);
  logsDir = path.join(root, "logs");
  webDist = path.join(root, "web");
  fs.mkdirSync(webDist);
  fs.writeFileSync(path.join(webDist, "index.html"), "<!doctype html><title>Skali UI</title>");
  fs.writeFileSync(path.join(webDist, "app.js"), "console.log(1)");
  remote = "::ffff:192.168.0.150";
  states = new Map();
  logs = [];
  events = [];
  supervisor = {
    state: vi.fn<SupervisorApi["state"]>((id) => states.get(id) ?? { status: "stopped", crashPaused: false }),
    start: vi.fn<SupervisorApi["start"]>(async () => undefined),
    stop: vi.fn<SupervisorApi["stop"]>(async () => undefined),
    restart: vi.fn<SupervisorApi["restart"]>(async () => undefined),
    command: vi.fn<SupervisorApi["command"]>(async () => "ok"),
    forget: vi.fn<SupervisorApi["forget"]>(),
  };
  adopter = {
    inspect: vi.fn<AdopterApi["inspect"]>(async () => ({ ok: true, exe: "x.exe", launch: {}, notes: [] })),
    adopt: vi.fn<AdopterApi["adopt"]>(async (req) =>
      repo.create({ name: req.name, game: req.game, folder: req.folder, launch: req.launch, stopTimeoutSec: 60 })),
    remove: vi.fn<AdopterApi["remove"]>(async (id) => repo.delete(id)),
  };
  fw = { ensure: vi.fn<Firewall["ensure"]>(async () => undefined), remove: vi.fn<Firewall["remove"]>(async () => undefined) };
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("allowlist", () => {
  it("403 JSON for a disallowed IP on /api", async () => {
    remote = "10.0.0.1";
    const r = await request(app()).get("/api/servers");
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "forbidden" });
  });
  it("403 text for a disallowed IP on the UI", async () => {
    remote = "::ffff:10.0.0.9";
    const r = await request(app()).get("/");
    expect(r.status).toBe(403);
    expect(r.text).toBe("Skáli: this device (10.0.0.9) is not on the allowed list.");
  });
  it("403 when the remote address is unknown", async () => {
    remote = undefined;
    expect((await request(app()).get("/api/games")).status).toBe(403);
  });
  it("allows the listed PC and loopback", async () => {
    expect((await request(app()).get("/api/games")).status).toBe(200);
    remote = "127.0.0.1";
    expect((await request(app()).get("/api/games")).status).toBe(200);
  });
  it("uses req.socket.remoteAddress by default (loopback in supertest)", async () => {
    const r = await request(createApp({ ...deps(), remoteAddress: undefined })).get("/api/games");
    expect(r.status).toBe(200);
  });
  it("ignores X-Forwarded-For", async () => {
    remote = "10.0.0.1";
    const r = await request(app()).get("/api/games").set("X-Forwarded-For", "192.168.0.150");
    expect(r.status).toBe(403);
  });
});

describe("Host header (DNS rebinding)", () => {
  it("rejects a foreign Host on /api and on the UI", async () => {
    expect((await request(app()).get("/api/games").set("Host", "evil.example:4200")).status).toBe(403);
    expect((await request(app()).get("/").set("Host", "rebind.attacker.com")).status).toBe(403);
  });
  it("accepts IP literals, localhost and the machine name", async () => {
    for (const h of ["192.168.0.100:4200", "localhost:4200", "server-pc:4200", "SERVER-PC.local:4200", "server-pc.home.arpa:4200", "[::1]:4200"])
      expect((await request(app()).get("/api/games").set("Host", h)).status, h).toBe(200);
  });
  it("rejects <hostname>.<other suffix> (rebinding to an attacker's domain)", async () => {
    for (const h of ["server-pc.attacker.com:4200", "server-pc.lan:4200", "server-pc.evil.home:4200"]) {
      const r = await request(app()).get("/api/servers").set("Host", h);
      expect(r.status, h).toBe(403);
      expect(r.body).toEqual({ error: "forbidden" });
    }
  });
});

describe("CSRF header", () => {
  it("403 for a mutating /api request without X-Skali: 1", async () => {
    const s = mkValheim();
    const r = await request(app()).post(`/api/servers/${s.id}/start`);
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "forbidden" });
    expect(supervisor.start).not.toHaveBeenCalled();
    expect((await request(app()).post(`/api/servers/${s.id}/start`).set("X-Skali", "0")).status).toBe(403);
    expect((await request(app()).delete(`/api/servers/${s.id}`)).status).toBe(403);
    expect((await request(app()).put("/api/settings").send({ connectHost: "x" })).status).toBe(403);
  });
  it("applies regardless of path case or prefix", async () => {
    const s = mkValheim();
    const r = await request(app()).post(`/API/servers/${s.id}/start`);
    expect(r.status).toBe(403);
    expect((await request(app()).put("/Api/settings").send({ connectHost: "x" })).status).toBe(403);
    expect((await request(app()).post("/").send({})).status).toBe(403);
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(settings.get().connectHost).toBe("192.168.0.100");
  });
  it("routing is case-sensitive: /API with the header doesn't reach the API", async () => {
    const s = mkValheim();
    await request(app()).post(`/API/servers/${s.id}/start`).set("X-Skali", "1");
    expect(supervisor.start).not.toHaveBeenCalled();
  });
  it("sends no CORS headers and refuses preflights", async () => {
    const r = await request(app()).options("/api/servers").set("Origin", "http://evil.example").set("Access-Control-Request-Method", "POST");
    expect(r.status).toBe(403);
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
  });
  it("GET needs no header", async () => {
    expect((await request(app()).get("/api/servers")).status).toBe(200);
  });
});

describe("servers", () => {
  it("GET /api/servers never includes secrets and masks Valheim password", async () => {
    mkValheim();
    mkMinecraft();
    const r = await request(app()).get("/api/servers");
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expect(allKeys(r.body).has("secrets")).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain("secret1");
    expect(JSON.stringify(r.body)).not.toContain("rcon-secret-value");
    const vh = r.body.find((s: { game: string }) => s.game === "valheim");
    expect(vh.launch.password).toBe("****");
    expect(vh.status).toBe("stopped");
    expect(vh.connectAddress).toBe("192.168.0.100:2456");
    expect(vh.ports.map((p: PortSpec) => p.port)).toEqual([2456, 2457, 2458]);
    expect(vh.hasCommands).toBe(false);
    const mc = r.body.find((s: { game: string }) => s.game === "minecraft");
    expect(mc.hasCommands).toBe(true);
    expect(typeof mc.commandHelp).toBe("string");
  });
  it("GET /api/servers/:id carries the runtime detail; unknown id → 404", async () => {
    const s = mkValheim();
    states.set(s.id, { status: "stopped", crashPaused: false, detail: "Forced stop failed: access denied" });
    const r = await request(app()).get(`/api/servers/${s.id}`);
    expect(r.body.detail).toBe("Forced stop failed: access denied");
    expect(r.body.id).toBe(s.id);
    const nf = await request(app()).get("/api/servers/nope");
    expect(nf.status).toBe(404);
    expect(nf.body).toEqual({ error: "Server not found" });
  });
  it("empty password is not masked", async () => {
    const s = repo.create({ name: "b", game: "basic", folder: root, stopTimeoutSec: 60, launch: { exe: "a.exe", rconPassword: "" } });
    const r = await request(app()).get(`/api/servers/${s.id}`);
    expect(r.body.launch.rconPassword).toBe("");
  });

  it("POST /api/servers/inspect validates and returns the result", async () => {
    const r = await request(app()).post("/api/servers/inspect").set("X-Skali", "1").send({ game: "valheim", folder: "C:\\x" });
    expect(r.status).toBe(200);
    expect(adopter.inspect).toHaveBeenCalledWith("valheim", "C:\\x");
    expect((await request(app()).post("/api/servers/inspect").set("X-Skali", "1").send({ game: "doom", folder: "C:\\x" })).status).toBe(400);
    expect((await request(app()).post("/api/servers/inspect").set("X-Skali", "1").send({ game: "valheim", folder: 5 })).status).toBe(400);
  });
  it("POST /api/servers adopts → 201 view and notifies", async () => {
    const folder = path.join(root, "new");
    const r = await request(app()).post("/api/servers").set("X-Skali", "1")
      .send({ game: "valheim", name: "new", folder, launch: { port: 2456, password: "abcdef" } });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("new");
    expect(r.body.launch.password).toBe("****");
    expect(r.body.secrets).toBeUndefined();
    expect(events).toContainEqual({ type: "changed", serverId: r.body.id });
  });
  it("POST /api/servers rejects bad bodies", async () => {
    const bad = [
      {}, { game: "valheim", name: "x", folder: "C:\\x" }, { game: "valheim", name: 1, folder: "C:\\x", launch: {} },
      { game: "valheim", name: "x", folder: "C:\\x", launch: { a: { nested: 1 } } },
      { game: "valheim", name: "x", folder: "C:\\x", launch: [] },
      { game: "valheim", name: "x", folder: "C:\\x", launch: {}, acceptEula: "yes" },
      { game: "valheim", name: "x", folder: "C:\\x", launch: {}, importWorldFrom: 3 },
    ];
    for (const b of bad) expect((await request(app()).post("/api/servers").set("X-Skali", "1").send(b)).status, JSON.stringify(b)).toBe(400);
    expect(adopter.adopt).not.toHaveBeenCalled();
  });
  it("maps BadRequest from the adopter to 400 with its message", async () => {
    adopter.adopt.mockRejectedValueOnce(new BadRequestError("Folder does not exist"));
    const r = await request(app()).post("/api/servers").set("X-Skali", "1").send({ game: "basic", name: "x", folder: "C:\\x", launch: {} });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Folder does not exist" });
  });

  describe("PATCH", () => {
    it('password "****" keeps the stored value', async () => {
      const s = mkValheim();
      const r = await request(app()).patch(`/api/servers/${s.id}`).set("X-Skali", "1")
        .send({ launch: { password: "****", world: "Other" }, autoRestart: false });
      expect(r.status).toBe(200);
      expect(r.body.launch.password).toBe("****");
      const stored = repo.get(s.id);
      expect(stored.launch.password).toBe("secret1");
      expect(stored.launch.world).toBe("Other");
      expect(stored.launch.port).toBe(2456);
      expect(stored.autoRestart).toBe(false);
    });
    it("a new password replaces the stored value; validateLaunch runs", async () => {
      const s = mkValheim();
      await request(app()).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send({ launch: { password: "newpass" } }).expect(200);
      expect(repo.get(s.id).launch.password).toBe("newpass");
      const r = await request(app()).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send({ launch: { password: "abc" } });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/at least 5/);
      expect(repo.get(s.id).launch.password).toBe("newpass");
    });
    it("rejects unexpected types and keys", async () => {
      const s = mkValheim();
      for (const b of [{ autoRestart: "yes" }, { autoStart: 1 }, { stopTimeoutSec: "90" }, { stopTimeoutSec: 0 }, { stopTimeoutSec: 1.5 },
        { name: 5 }, { launch: "x" }, { launch: { port: null } }, { secrets: { a: "b" } }, { pid: 1 }, ["x"],
        { launch: { bogus: 1 } }, { launch: { rconPassword: "x" } }])
        expect((await request(app()).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send(b)).status, JSON.stringify(b)).toBe(400);
      expect(repo.get(s.id).autoRestart).toBe(true);
    });
    it("unchanged name/ports do not touch the firewall", async () => {
      const s = mkValheim();
      await request(app()).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send({ autoStart: false }).expect(200);
      expect(fw.ensure).not.toHaveBeenCalled();
      expect(fw.remove).not.toHaveBeenCalled();
    });
    it("rename re-syncs firewall rules (remove old, ensure new)", async () => {
      const s = mkValheim();
      const r = await request(app()).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send({ name: "renamed" });
      expect(r.status).toBe(200);
      expect(r.body.name).toBe("renamed");
      expect(fw.remove).toHaveBeenCalledWith("friends");
      expect(fw.ensure).toHaveBeenCalledWith("renamed", expect.arrayContaining([expect.objectContaining({ port: 2456 })]));
      expect(fw.remove.mock.invocationCallOrder[0]).toBeLessThan(fw.ensure.mock.invocationCallOrder[0]);
      expect(events).toContainEqual({ type: "changed", serverId: s.id });
    });
    it("port change re-applies firewall rules", async () => {
      const s = mkValheim();
      await request(app()).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send({ launch: { port: 3000 } }).expect(200);
      expect(fw.ensure).toHaveBeenCalledWith("friends", expect.arrayContaining([expect.objectContaining({ port: 3000 })]));
    });
    it("firewall failure reverts the change and returns 500 with the error", async () => {
      const s = mkValheim();
      fw.ensure.mockRejectedValueOnce(new Error("PowerShell failed (exit 1): access denied"));
      const r = await request(app()).patch(`/api/servers/${s.id}`).set("X-Skali", "1").send({ name: "renamed", launch: { port: 3000 } });
      expect(r.status).toBe(500);
      expect(r.body.error).toMatch(/Firewall update failed: .*access denied/);
      const back = repo.get(s.id);
      expect(back.name).toBe("friends");
      expect(back.launch.port).toBe(2456);
      // old rules restored best-effort
      expect(fw.ensure).toHaveBeenLastCalledWith("friends", expect.arrayContaining([expect.objectContaining({ port: 2456 })]));
      expect(logs.join("\n")).toMatch(/access denied/);
    });
    it("duplicate name → 400", async () => {
      mkValheim("a");
      const b = mkValheim("b");
      const r = await request(app()).patch(`/api/servers/${b.id}`).set("X-Skali", "1").send({ name: "A" });
      expect(r.status).toBe(400);
      expect(fw.remove).not.toHaveBeenCalled();
    });
  });

  it("DELETE → 204, forgets runtime state and notifies", async () => {
    const s = mkValheim();
    const r = await request(app()).delete(`/api/servers/${s.id}`).set("X-Skali", "1");
    expect(r.status).toBe(204);
    expect(adopter.remove).toHaveBeenCalledWith(s.id, expect.any(Function));
    expect((adopter.remove.mock.calls[0]![1] as () => RuntimeState)()).toEqual({ status: "stopped", crashPaused: false });
    expect(supervisor.forget).toHaveBeenCalledWith(s.id);
    expect(events).toContainEqual({ type: "removed", serverId: s.id });
  });
  it("DELETE of a stopped server that still tracks a pid → 409 (real Adopter)", async () => {
    const s = mkValheim();
    repo.update(s.id, { pid: 77, pidStartTime: "2026-01-01T00:00:00.000Z" });
    states.set(s.id, { status: "stopped", crashPaused: false, detail: "Forced stop failed: access denied" });
    const real = new Adopter({ repo, adapter: getAdapter, gamesUser: null, firewall: fw.ensure, removeFirewall: fw.remove });
    const r = await request(app({ adopter: real })).delete(`/api/servers/${s.id}`).set("X-Skali", "1");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "Forced stop failed: access denied" });
    expect(repo.list()).toHaveLength(1);
    expect(fw.remove).not.toHaveBeenCalled();
    expect(supervisor.forget).not.toHaveBeenCalled();
  });
  it("while a DELETE is in flight, start/command → 409 'Server is being removed'", async () => {
    const s = mkMinecraft();
    states.set(s.id, { status: "stopped", crashPaused: false });
    let release!: () => void;
    const slowFw = vi.fn<Firewall["remove"]>(() => new Promise<void>((r) => { release = r; }));
    const real = new Adopter({ repo, adapter: getAdapter, gamesUser: null, firewall: fw.ensure, removeFirewall: slowFw });
    const a = app({ adopter: real });
    const del = request(a).delete(`/api/servers/${s.id}`).set("X-Skali", "1").then((x) => x);
    for (let i = 0; i < 100 && !slowFw.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 5));
    const st = await request(a).post(`/api/servers/${s.id}/start`).set("X-Skali", "1");
    expect(st.status).toBe(409);
    expect(st.body).toEqual({ error: "Server is being removed" });
    const cmd = await request(a).post(`/api/servers/${s.id}/command`).set("X-Skali", "1").send({ command: "list" });
    expect(cmd.status).toBe(409);
    expect(supervisor.start).not.toHaveBeenCalled();
    expect(supervisor.command).not.toHaveBeenCalled();
    release();
    expect((await del).status).toBe(204);
    expect(repo.list()).toHaveLength(0);
    // after removal: plain 404
    expect((await request(a).post(`/api/servers/${s.id}/start`).set("X-Skali", "1")).status).toBe(404);
  });
  it("DELETE of a running server → 409", async () => {
    const s = mkValheim();
    adopter.remove.mockRejectedValueOnce(new ConflictError("Stop the server before removing it"));
    const r = await request(app()).delete(`/api/servers/${s.id}`).set("X-Skali", "1");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "Stop the server before removing it" });
    expect(supervisor.forget).not.toHaveBeenCalled();
  });
});

describe("start / stop / restart", () => {
  it("start on a running server → 409", async () => {
    const s = mkValheim();
    states.set(s.id, { status: "running", crashPaused: false });
    supervisor.start.mockRejectedValueOnce(new ConflictError("Server is running"));
    const r = await request(app()).post(`/api/servers/${s.id}/start`).set("X-Skali", "1");
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "Server is running" });
  });
  it("start refused for a lingering pid surfaces the message", async () => {
    const s = mkValheim();
    supervisor.start.mockRejectedValueOnce(new ConflictError("Previous process (pid 42) is still running; stop it first"));
    const r = await request(app()).post(`/api/servers/${s.id}/start`).set("X-Skali", "1");
    expect(r.status).toBe(409);
    expect(r.body.error).toContain("pid 42");
  });
  it("invalid launch → 400", async () => {
    const s = mkValheim();
    supervisor.start.mockRejectedValueOnce(new BadRequestError("Password must be at least 5 characters"));
    expect((await request(app()).post(`/api/servers/${s.id}/start`).set("X-Skali", "1")).status).toBe(400);
  });
  it("returns 202 with the current view once begun, without waiting", async () => {
    const s = mkValheim();
    let finish!: () => void;
    supervisor.stop.mockImplementationOnce(() => {
      states.set(s.id, { status: "stopping", crashPaused: false });
      return new Promise<void>((r) => { finish = r; });
    });
    const r = await request(app()).post(`/api/servers/${s.id}/stop`).set("X-Skali", "1");
    expect(r.status).toBe(202);
    expect(r.body.status).toBe("stopping");
    expect(r.body.id).toBe(s.id);
    finish();
  });
  it("a late rejection is logged, not thrown", async () => {
    const s = mkValheim();
    let fail!: (e: Error) => void;
    supervisor.restart.mockImplementationOnce(() => new Promise<void>((_r, j) => { fail = j; }));
    const r = await request(app()).post(`/api/servers/${s.id}/restart`).set("X-Skali", "1");
    expect(r.status).toBe(202);
    fail(new ConflictError("Previous process (pid 9) is still running"));
    await new Promise((res) => setTimeout(res, 10));
    expect(logs.join("\n")).toMatch(/restart.*pid 9/);
  });
  it("unknown server → 404 and the supervisor is not called", async () => {
    expect((await request(app()).post("/api/servers/nope/start").set("X-Skali", "1")).status).toBe(404);
    expect(supervisor.start).not.toHaveBeenCalled();
  });
});

describe("command", () => {
  it("command on Valheim → 400", async () => {
    const s = mkValheim();
    states.set(s.id, { status: "running", crashPaused: false });
    const r = await request(app()).post(`/api/servers/${s.id}/command`).set("X-Skali", "1").send({ command: "save" });
    expect(r.status).toBe(400);
    expect(supervisor.command).not.toHaveBeenCalled();
  });
  it("runs the command and appends it to the run log", async () => {
    const s = mkMinecraft();
    const run = createRun(logsDir, s.id, new Date("2026-01-01T00:00:00Z"));
    states.set(s.id, { status: "running", crashPaused: false, runId: run.runId });
    supervisor.command.mockResolvedValueOnce("There are 0 of a max of 20 players online:\nnobody");
    const r = await request(app()).post(`/api/servers/${s.id}/command`).set("X-Skali", "1").send({ command: "list" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ output: "There are 0 of a max of 20 players online:\nnobody" });
    expect(supervisor.command).toHaveBeenCalledWith(s.id, "list");
    const log = fs.readFileSync(run.consolePath, "utf8");
    expect(log).toContain("[skali] > list\r\n");
    expect(log).toContain("[skali] There are 0 of a max of 20 players online:\r\n[skali] nobody\r\n");
  });
  it("rejects empty, non-string and multi-line commands", async () => {
    const s = mkMinecraft();
    for (const b of [{}, { command: "" }, { command: 5 }, { command: "say a\nstop" }, { command: "x".repeat(2000) }])
      expect((await request(app()).post(`/api/servers/${s.id}/command`).set("X-Skali", "1").send(b)).status, JSON.stringify(b)).toBe(400);
  });
});

describe("eula", () => {
  it("writes eula=true for Minecraft only", async () => {
    const mc = mkMinecraft();
    fs.writeFileSync(path.join(mc.folder, "eula.txt"), "#comment\neula=false\n");
    expect((await request(app()).post(`/api/servers/${mc.id}/eula`).set("X-Skali", "1")).status).toBe(204);
    expect(fs.readFileSync(path.join(mc.folder, "eula.txt"), "utf8")).toBe("#comment\neula=true\n");
    const vh = mkValheim();
    expect((await request(app()).post(`/api/servers/${vh.id}/eula`).set("X-Skali", "1")).status).toBe(400);
  });
});

describe("runs and logs", () => {
  it("lists runs and downloads a run log as an attachment", async () => {
    const s = mkValheim();
    const run = createRun(logsDir, s.id, new Date("2026-02-03T04:05:06.789Z"));
    fs.writeFileSync(run.consolePath, "line one\r\nline two\r\n");
    const runs = await request(app()).get(`/api/servers/${s.id}/runs`);
    expect(runs.body).toEqual([{ runId: run.runId, startedAt: "2026-02-03T04:05:06.789Z", sizeBytes: 20 }]);
    const r = await request(app()).get(`/api/servers/${s.id}/runs/${run.runId}/log`);
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/plain/);
    expect(r.headers["content-disposition"]).toBe(`attachment; filename="friends-${run.runId}.log"`);
    expect(r.text).toBe("line one\r\nline two\r\n");
  });
  it("runId ../../x → 404", async () => {
    const s = mkValheim();
    createRun(logsDir, s.id, new Date());
    for (const id of ["..%2F..%2Fx", "..%5C..%5Cx", "2026-01-01T00-00-00-000Z", "%2E%2E"])
      expect((await request(app()).get(`/api/servers/${s.id}/runs/${id}/log`)).status, id).toBe(404);
  });
  it("unknown server → 404 for runs and log", async () => {
    expect((await request(app()).get("/api/servers/nope/runs")).status).toBe(404);
    expect((await request(app()).get("/api/servers/..%2F..%2Fetc/runs")).status).toBe(404);
    expect((await request(app()).get("/api/servers/nope/runs/2026-01-01T00-00-00-000Z/log")).status).toBe(404);
  });
});

describe("/api/fs", () => {
  it("without path lists existing drive roots", async () => {
    const r = await request(app()).get("/api/fs");
    expect(r.status).toBe(200);
    expect(r.body.path).toBeNull();
    expect(r.body.parent).toBeNull();
    expect(r.body.dirs).toContain("C:\\");
    expect(r.body.files).toEqual([]);
  });
  it("lists dirs and files sorted case-insensitively, skipping junctions", async () => {
    const d = path.join(root, "browse");
    fs.mkdirSync(path.join(d, "beta"), { recursive: true });
    fs.mkdirSync(path.join(d, "Alpha"));
    fs.writeFileSync(path.join(d, "b.txt"), "");
    fs.writeFileSync(path.join(d, "A.exe"), "");
    fs.symlinkSync(path.join(d, "beta"), path.join(d, "junc"), "junction");
    const r = await request(app()).get("/api/fs").query({ path: d });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ path: d, parent: root, dirs: ["Alpha", "beta"], files: ["A.exe", "b.txt"], truncated: false });
  });
  it("a drive root has a null parent", async () => {
    const r = await request(app()).get("/api/fs").query({ path: "C:\\" });
    expect(r.status).toBe(200);
    expect(r.body.path).toBe("C:\\");
    expect(r.body.parent).toBeNull();
  });
  it("caps the entry count", async () => {
    const d = path.join(root, "many");
    fs.mkdirSync(d);
    for (let i = 0; i < 2005; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), "");
    const r = await request(app()).get("/api/fs").query({ path: d });
    expect(r.body.files.length + r.body.dirs.length).toBe(2000);
    expect(r.body.truncated).toBe(true);
  });
  it("rejects relative, UNC, device and unreadable paths", async () => {
    for (const p of ["relative\\dir", "\\rooted", "\\\\server\\share", "\\\\?\\C:\\", "\\\\.\\PhysicalDrive0", "C:", path.join(root, "missing")])
      expect((await request(app()).get("/api/fs").query({ path: p })).status, p).toBe(400);
  });
});

describe("settings", () => {
  it("GET returns settings", async () => {
    const r = await request(app()).get("/api/settings");
    expect(r.body).toEqual({ allowlist: ["192.168.0.150"], connectHost: "192.168.0.100" });
  });
  it("PUT removing the caller's own IP → 400", async () => {
    const r = await request(app()).put("/api/settings").set("X-Skali", "1").send({ allowlist: ["192.168.0.151"] });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "This would lock out the device you're using" });
    expect(settings.get().allowlist).toEqual(["192.168.0.150"]);
  });
  it("PUT keeping the caller (directly or by range) succeeds", async () => {
    const r = await request(app()).put("/api/settings").set("X-Skali", "1").send({ allowlist: ["192.168.0.0/24"], connectHost: "gs.lan" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ allowlist: ["192.168.0.0/24"], connectHost: "gs.lan" });
  });
  it("PUT accepts IPv4, DNS names and bracketed IPv6 for connectHost", async () => {
    for (const h of ["10.0.0.5", "gs.example.com", "SERVER-PC", "[fe80::1]", "a".repeat(63) + ".lan"]) {
      const r = await request(app()).put("/api/settings").set("X-Skali", "1").send({ connectHost: h });
      expect(r.status, h).toBe(200);
      expect(r.body.connectHost).toBe(h);
    }
  });
  it("PUT from loopback may set any list", async () => {
    remote = "127.0.0.1";
    expect((await request(app()).put("/api/settings").set("X-Skali", "1").send({ allowlist: [] })).status).toBe(200);
  });
  it("PUT validates", async () => {
    for (const b of [{ allowlist: "192.168.0.150" }, { allowlist: ["nope"] }, { connectHost: 5 }, { other: 1 }, [],
      { connectHost: "" }, { connectHost: "has space" }, { connectHost: "a\u0000b" }, { connectHost: "tab\there" }, { connectHost: "x".repeat(254) },
      { connectHost: "a".repeat(64) + ".lan" }, { connectHost: "-bad.lan" }, { connectHost: "host:4200" }, { connectHost: "http://x" },
      { connectHost: "<script>" }, { connectHost: "a..b" }])
      expect((await request(app()).put("/api/settings").set("X-Skali", "1").send(b)).status, JSON.stringify(b)).toBe(400);
  });
});

describe("errors and limits", () => {
  it("500 hides details and logs", async () => {
    adopter.inspect.mockRejectedValueOnce(new Error("boom at C:\\secret\\path"));
    const r = await request(app()).post("/api/servers/inspect").set("X-Skali", "1").send({ game: "valheim", folder: "C:\\x" });
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Internal error" });
    expect(r.text).not.toContain("secret");
    expect(logs.join("\n")).toContain("boom at C:\\secret\\path");
  });
  it("malformed JSON → 400 without a stack", async () => {
    const r = await request(app()).post("/api/servers").set("X-Skali", "1").set("Content-Type", "application/json").send("{bad");
    expect(r.status).toBe(400);
    expect(r.text).not.toMatch(/at \w+ \(/);
  });
  it("bodies over 64 KB → 413", async () => {
    const r = await request(app()).put("/api/settings").set("X-Skali", "1").send({ connectHost: "x".repeat(70 * 1024) });
    expect(r.status).toBe(413);
  });
  it("unknown /api route → 404 JSON", async () => {
    const r = await request(app()).get("/api/nope");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "Not found" });
  });
});

describe("static UI", () => {
  it("serves files and falls back to index.html", async () => {
    expect((await request(app()).get("/app.js")).text).toBe("console.log(1)");
    const r = await request(app()).get("/servers/abc");
    expect(r.status).toBe(200);
    expect(r.text).toContain("Skali UI");
    expect(r.headers["x-frame-options"]).toBe("DENY");
  });
  it("GET /api/games lists the 4 games", async () => {
    const r = await request(app()).get("/api/games");
    expect(r.body.map((g: { id: string }) => g.id).sort()).toEqual(["basic", "minecraft", "palworld", "valheim"]);
  });
});
