import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import { createApp, type SupervisorApi } from "../../src/http/app.js";
import { ServerRepo } from "../../src/servers/repo.js";
import { SettingsStore } from "../../src/settings.js";

let root: string, db: Db, repo: ServerRepo, settings: SettingsStore, tokenFile: string;
let helper: http.Server;
let helperUrl: string;
let calls: { method: string; url: string; auth?: string; body: string }[];
let reply: { status: number; body: unknown };

function app(over: { deployerUrl?: string; deployerTokenFile?: string } = {}) {
  return createApp({
    repo, supervisor: { state: vi.fn() } as unknown as SupervisorApi, adopter: {} as never, settings,
    logsDir: path.join(root, "logs"), webDist: root, remoteAddress: () => "192.168.0.150", hostname: "SERVER-PC",
    log: () => undefined, deployerUrl: helperUrl, deployerTokenFile: tokenFile, ...over,
  });
}
const get = (a: ReturnType<typeof app>, p: string) => request(a).get(p).set("Host", "SERVER-PC:4200");
const post = (a: ReturnType<typeof app>, p: string, skali = true) => {
  const r = request(a).post(p).set("Host", "SERVER-PC:4200");
  return skali ? r.set("X-Skali", "1") : r;
};

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-deploys-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, Buffer.alloc(32, 3));
  settings = new SettingsStore(db, ["192.168.0.150"]);
  tokenFile = path.join(root, "api-token");
  fs.writeFileSync(tokenFile, "tok-one\n");
  calls = [];
  reply = { status: 200, body: { events: [] } };
  helper = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => helper.listen(0, "127.0.0.1", r));
  helperUrl = `http://127.0.0.1:${(helper.address() as AddressInfo).port}`;
});
afterEach(async () => {
  await new Promise((r) => helper.close(r));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("/api/deploys proxy", () => {
  it("passes the status through with the bearer token, read per request", async () => {
    reply = { status: 200, body: { autoDeploy: { on: true }, events: [], helperUpdateAvailable: false } };
    const a = app();
    const r = await get(a, "/api/deploys/status");
    expect(r.status).toBe(200);
    expect(r.body).toEqual(reply.body);
    expect(calls[0]).toMatchObject({ method: "GET", url: "/status", auth: "Bearer tok-one" });
    fs.writeFileSync(tokenFile, "tok-two");
    await get(a, "/api/deploys/status");
    expect(calls[1]!.auth).toBe("Bearer tok-two");
    expect(JSON.stringify(r.body) + JSON.stringify(r.headers)).not.toContain("tok-one");
  });

  it("proxies the log with from=", async () => {
    reply = { status: 200, body: { log: "x\n", next: 2 } };
    const r = await get(app(), "/api/deploys/events/ev%201/log?from=5");
    expect(r.body).toEqual({ log: "x\n", next: 2 });
    expect(calls[0]!.url).toBe("/events/ev%201/log?from=5");
    await get(app(), "/api/deploys/events/e1/log");
    expect(calls[1]!.url).toBe("/events/e1/log");
    expect((await get(app(), "/api/deploys/events/e1/log?from=abc")).status).toBe(400);
    expect(calls).toHaveLength(2);
  });

  it.each([
    ["deploy-now", "deployNow"],
    ["restart", "restartApp"],
    ["pause", "pause"],
    ["resume", "resume"],
  ])("maps %s to a fixed command with by: you", async (route, type) => {
    reply = { status: 202, body: { eventId: "e" } };
    const r = await post(app(), `/api/deploys/${route}`).send({ by: "auto", type: "rollback", sha: "abc" });
    expect(r.status).toBe(202);
    expect(JSON.parse(calls[0]!.body)).toEqual({ type, by: "you" });
    expect(calls[0]).toMatchObject({ method: "POST", url: "/command" });
  });

  it("rolls back to a hex sha", async () => {
    reply = { status: 202, body: {} };
    await post(app(), "/api/deploys/rollback/abc1234").send({});
    expect(JSON.parse(calls[0]!.body)).toEqual({ type: "rollback", sha: "abc1234", by: "you" });
  });

  it.each(["xyz1234", "abc12", "ABC1234", "a".repeat(41)])("rejects sha %s without calling the helper", async (sha) => {
    const r = await post(app(), `/api/deploys/rollback/${sha}`).send({});
    expect(r.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("passes helper 409 and 400 bodies through", async () => {
    reply = { status: 409, body: { error: "busy" } };
    let r = await post(app(), "/api/deploys/deploy-now").send({});
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "busy" });
    reply = { status: 400, body: { error: "Can't roll back past a database change; push a fix instead." } };
    r = await post(app(), "/api/deploys/rollback/abc1234").send({});
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/database change/);
  });

  it("503 helper-not-running when the helper is down", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise((r) => dead.close(r));
    const r = await get(app({ deployerUrl: url }), "/api/deploys/status");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "helper-not-running" });
  });

  it("503 helper-not-running when the token file is missing", async () => {
    const r = await get(app({ deployerTokenFile: path.join(root, "nope") }), "/api/deploys/status");
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: "helper-not-running" });
    expect(calls).toHaveLength(0);
  });

  it("403 for a POST without X-Skali, and the loopback busy probe stays unshadowed", async () => {
    const r = await post(app(), "/api/deploys/deploy-now", false).send({});
    expect(r.status).toBe(403);
    expect(calls).toHaveLength(0);
    const b = await request(app({})).get("/api/deploys/busy").set("Host", "127.0.0.1:4200");
    expect(b.status).toBe(404); // remote 192.168.0.150 is not loopback: busy router answered, not the proxy
    expect(calls).toHaveLength(0);
  });
});
