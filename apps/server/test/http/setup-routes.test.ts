import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { ConflictError, ExposedError } from "../../src/errors.js";
import { STEAMCMD_BUSY, SteamCmdError } from "../../src/tools/steamcmd.js";
import { setupRouter, type SetupRouteDeps } from "../../src/http/setup-routes.js";

function app(over: Partial<SetupRouteDeps> = {}) {
  const deps: SetupRouteDeps = {
    steamCmd: { installed: () => true, appInfo: vi.fn(async (id: number) => (id === 896660 ? { appId: id, name: "Valheim Dedicated Server", windows: true } : null)) },
    java: { installedMajors: () => [21] },
    mcSources: { versions: vi.fn(async () => ({ versions: ["1.21.4", "1.21.3"], latest: "1.21.4" })) },
    portsInUse: vi.fn(() => [{ name: "Other", ports: [{ port: 25565, protocol: "tcp" as const, purpose: "Game", forward: true }] }]),
    probe: async () => true,
    ...over,
  };
  const a = express();
  a.use(express.json());
  a.use("/api", setupRouter(deps));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  a.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const name = err instanceof Error ? err.name : "";
    if (err instanceof ExposedError) return void res.status(err.status).json({ error: err.message });
    res.status(name === "BadRequestError" ? 400 : name === "ConflictError" ? 409 : name === "NotFoundError" ? 404 : 500).json({ error: name === "BadRequestError" || name === "ConflictError" || name === "NotFoundError" ? (err as Error).message : "Internal error" });
  });
  return { a, deps };
}

describe("GET /api/catalog", () => {
  it("returns the catalog", async () => {
    const r = await request(app().a).get("/api/catalog");
    expect(r.status).toBe(200);
    expect(r.body[0]).toMatchObject({ game: "palworld", appId: 2394010, star: true });
  });
});

describe("POST /api/steam/app-info", () => {
  it("returns the app", async () => {
    const r = await request(app().a).post("/api/steam/app-info").send({ appId: 896660 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ appId: 896660, name: "Valheim Dedicated Server", windows: true });
  });
  it("404s an unknown app", async () => {
    const r = await request(app().a).post("/api/steam/app-info").send({ appId: 999999999 });
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "No Steam app with that ID" });
  });
  it.each([[0], [-1], [1.5], ["12"], [2 ** 31 + 1], [null], [undefined]])("400s appId %s", async (appId) => {
    const r = await request(app().a).post("/api/steam/app-info").send({ appId });
    expect(r.status).toBe(400);
  });
  it("does not turn a SteamCMD failure into a 404", async () => {
    const { a } = app({ steamCmd: { installed: () => true, appInfo: async () => { throw new Error("boom"); } } });
    const r = await request(a).post("/api/steam/app-info").send({ appId: 5 });
    expect(r.status).not.toBe(404);
    expect(r.status).toBeGreaterThanOrEqual(500);
  });
});

describe("POST /api/steam/app-info upstream failures", () => {
  const withAppInfo = (appInfo: () => Promise<never>) => app({ steamCmd: { installed: () => true, appInfo } }).a;
  it("502s a SteamCMD failure with its message", async () => {
    const r = await request(withAppInfo(async () => { throw new SteamCmdError("failed", "SteamCMD did not return app info for 5 (code 7)"); }))
      .post("/api/steam/app-info").send({ appId: 5 });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "Steam lookup failed: SteamCMD did not return app info for 5 (code 7)" });
  });
  it("502s a network failure while getting SteamCMD", async () => {
    const r = await request(withAppInfo(async () => { throw new TypeError("fetch failed"); })).post("/api/steam/app-info").send({ appId: 5 });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "Steam lookup failed: fetch failed" });
  });
  it("409s while SteamCMD is busy with an install or update", async () => {
    const r = await request(withAppInfo(async () => { throw new ConflictError(STEAMCMD_BUSY); })).post("/api/steam/app-info").send({ appId: 5 });
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "SteamCMD is busy with an install or update; try again when it finishes" });
  });
  it("keeps other errors internal", async () => {
    const r = await request(withAppInfo(async () => { throw new Error("EACCES: permission denied"); })).post("/api/steam/app-info").send({ appId: 5 });
    expect(r.status).toBe(500);
  });
});

describe("GET /api/minecraft/versions upstream failures", () => {
  it.each([
    [new Error("Could not reach PaperMC: HTTP 503"), "Could not get the Minecraft versions: Could not reach PaperMC: HTTP 503"],
    [new Error("Could not reach Mojang's version list: timed out"), "Could not get the Minecraft versions: Could not reach Mojang's version list: timed out"],
    [new TypeError("fetch failed"), "Could not get the Minecraft versions: fetch failed"],
    [new SyntaxError("Unexpected token < in JSON"), "Could not get the Minecraft versions: Unexpected token < in JSON"],
  ])("502s %s", async (err, message) => {
    const { a } = app({ mcSources: { versions: async () => { throw err; } } });
    const r = await request(a).get("/api/minecraft/versions?flavour=vanilla");
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: message });
  });
});

describe("GET /api/minecraft/versions", () => {
  it("passes the flavour through", async () => {
    const { a, deps } = app();
    const r = await request(a).get("/api/minecraft/versions?flavour=paper");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ versions: ["1.21.4", "1.21.3"], latest: "1.21.4" });
    expect(deps.mcSources.versions).toHaveBeenCalledWith("paper");
  });
  it.each(["", "forge", "VANILLA"])("400s flavour %j", async (f) => {
    const r = await request(app().a).get("/api/minecraft/versions").query({ flavour: f });
    expect(r.status).toBe(400);
  });
  it("400s a missing flavour", async () => {
    expect((await request(app().a).get("/api/minecraft/versions")).status).toBe(400);
  });
});

describe("POST /api/servers/check-ports", () => {
  const spec = (port: number, protocol: "udp" | "tcp" = "tcp") => ({ port, protocol, purpose: "Game", forward: true });
  it("reports clashes with other servers and passes exceptId", async () => {
    const { a, deps } = app();
    const r = await request(a).post("/api/servers/check-ports").send({ ports: [spec(25565), spec(25566)], exceptId: "abc" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ clashes: [{ port: 25565, protocol: "tcp", reason: "Used by Other" }] });
    expect(deps.portsInUse).toHaveBeenCalledWith("abc");
  });
  it("reports ports in use on the PC", async () => {
    const { a } = app({ portsInUse: () => [], probe: async (p) => p !== 7777 });
    const r = await request(a).post("/api/servers/check-ports").send({ ports: [spec(7777, "udp")] });
    expect(r.body.clashes).toEqual([{ port: 7777, protocol: "udp", reason: "Something on this PC is already using it" }]);
  });
  it.each([
    [{}], [{ ports: "x" }], [{ ports: [{ port: 0, protocol: "tcp" }] }], [{ ports: [{ port: 70000, protocol: "tcp" }] }],
    [{ ports: [{ port: 80, protocol: "icmp" }] }], [{ ports: [1] }], [{ ports: [spec(80)], exceptId: 5 }],
  ])("400s %j", async (body) => {
    expect((await request(app().a).post("/api/servers/check-ports").send(body)).status).toBe(400);
  });
});

describe("GET /api/tools", () => {
  it("reports installed tools", async () => {
    const r = await request(app().a).get("/api/tools");
    expect(r.body).toEqual({ steamcmd: true, java: [21] });
  });
});

describe("install and retry routes", () => {
  const fakeView = (id: string) => ({ id, job: { kind: "install", state: "running", steps: [], progress: null, runId: "r" } }) as never;
  function withInstaller() {
    const installer = {
      install: vi.fn(async () => ({ id: "new-id" }) as never),
      retry: vi.fn(async () => undefined),
    };
    const view = vi.fn(fakeView);
    return { installer, view, ...app({ installer, view }) };
  }
  const body = {
    game: "palworld", name: "Pal", folder: "D:\\GameServers\\Pal", launch: { port: 8211 },
    palworld: { serverName: "My server", serverPassword: "pw", maxPlayers: 16 },
  };

  it("are not mounted without an installer", async () => {
    expect((await request(app().a).post("/api/servers/install").send(body)).status).toBe(404);
    expect((await request(app().a).post("/api/servers/x/retry")).status).toBe(404);
  });

  it("install → 201 with the view, its job running", async () => {
    const { a, installer, view } = withInstaller();
    const r = await request(a).post("/api/servers/install").send(body);
    expect(r.status).toBe(201);
    expect(r.body.job.state).toBe("running");
    expect(installer.install).toHaveBeenCalledWith(body);
    expect(view).toHaveBeenCalledWith("new-id");
  });

  it("passes minecraft, appId and acceptEula through", async () => {
    const { a, installer } = withInstaller();
    const mc = { game: "minecraft", name: "Mc", folder: "D:\\mc", launch: {}, minecraft: { flavour: "paper", version: "1.21.4" }, acceptEula: true };
    expect((await request(a).post("/api/servers/install").send(mc)).status).toBe(201);
    expect(installer.install).toHaveBeenLastCalledWith(mc);
    const basic = { game: "basic", name: "B", folder: "D:\\b", launch: {}, appId: 376030 };
    expect((await request(a).post("/api/servers/install").send(basic)).status).toBe(201);
    expect(installer.install).toHaveBeenLastCalledWith(basic);
  });

  it.each([
    [{ ...body, extra: 1 }],
    [{ ...body, game: "doom" }],
    [{ ...body, name: 5 }],
    [{ ...body, folder: null }],
    [{ ...body, launch: undefined }],
    [{ ...body, launch: { port: { x: 1 } } }],
    [{ ...body, appId: "12" }],
    [{ ...body, acceptEula: "yes" }],
    [{ ...body, minecraft: { flavour: "forge", version: "1" } }],
    [{ ...body, minecraft: { flavour: "paper", version: 1 } }],
    [{ ...body, minecraft: { flavour: "paper", version: "1", x: 1 } }],
    [{ ...body, palworld: { serverName: "a", serverPassword: "b", maxPlayers: "3" } }],
    [{ ...body, palworld: { serverName: "a", serverPassword: "b", maxPlayers: 3, admin: "x" } }],
    [{ ...body, palworld: "x" }],
  ])("install 400s %j", async (b) => {
    const { a, installer } = withInstaller();
    const r = await request(a).post("/api/servers/install").send(b);
    expect(r.status).toBe(400);
    expect(installer.install).not.toHaveBeenCalled();
  });

  it("retry → 202 with the view; a conflict → 409", async () => {
    const { a, installer } = withInstaller();
    const r = await request(a).post("/api/servers/abc/retry");
    expect(r.status).toBe(202);
    expect(r.body.id).toBe("abc");
    expect(installer.retry).toHaveBeenCalledWith("abc");
    installer.retry.mockRejectedValueOnce(new ConflictError("Only a failed install can be retried"));
    const c = await request(a).post("/api/servers/abc/retry");
    expect(c.status).toBe(409);
    expect(c.body).toEqual({ error: "Only a failed install can be retried" });
  });
});
