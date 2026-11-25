import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { JobView, RuntimeState, WsServerMessage } from "@skali/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { openDb, type Db } from "../../src/db.js";
import { attachWsHub, type WsHub } from "../../src/http/ws-hub.js";
import { createRun } from "../../src/logs/runs.js";
import type { SupervisorEvent } from "../../src/proc/supervisor.js";
import { ServerRepo, type ServerRecord } from "../../src/servers/repo.js";
import { SettingsStore } from "../../src/settings.js";

const key = Buffer.alloc(32, 5);
let root: string, db: Db, repo: ServerRepo, settings: SettingsStore, logsDir: string;
let server: http.Server, hub: WsHub, port: number;
let remote: string | undefined;
let states: Map<string, RuntimeState>;
let jobs: Map<string, JobView>;
let listeners: ((e: SupervisorEvent) => void)[];
let clients: WebSocket[];

const emit = (e: SupervisorEvent) => listeners.forEach((l) => l(e));

function mk(name: string): ServerRecord {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  return repo.create({
    name, game: "valheim", folder, stopTimeoutSec: 90,
    launch: { port: 2456, world: "W", public: true, crossplay: false, extraArgs: "", password: "topsecret" },
  });
}

async function start(tickMs = 100_000): Promise<void> {
  server = http.createServer((_q, r) => r.end("x"));
  hub = attachWsHub(server, {
    subscribe: (cb) => { listeners.push(cb); },
    state: (id) => states.get(id) ?? { status: "stopped", crashPaused: false },
    settings, repo, logsDir,
    job: (id) => jobs.get(id) ?? null,
    remoteAddress: () => remote,
    hostname: "SERVER-PC",
    tickMs,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
}

/** A connected client that records every message. */
interface Client { ws: WebSocket; msgs: WsServerMessage[]; next(pred?: (m: WsServerMessage) => boolean, ms?: number): Promise<WsServerMessage> }

function connect(headers: Record<string, string> = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    clients.push(ws);
    const msgs: WsServerMessage[] = [];
    let cursor = 0;
    const waiters: (() => void)[] = [];
    ws.on("message", (d) => { msgs.push(JSON.parse(String(d))); waiters.splice(0).forEach((w) => w()); });
    const next = (pred: (m: WsServerMessage) => boolean = () => true, ms = 2000) =>
      new Promise<WsServerMessage>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timeout; got ${JSON.stringify(msgs.slice(cursor))}`)), ms);
        const check = () => {
          while (cursor < msgs.length) {
            const m = msgs[cursor++]!;
            if (pred(m)) { clearTimeout(t); res(m); return; }
          }
          waiters.push(check);
        };
        check();
      });
    ws.once("open", () => resolve({ ws, msgs, next }));
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("error", reject);
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = (c: Client, m: unknown) => c.ws.send(JSON.stringify(m));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-ws-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, key);
  settings = new SettingsStore(db, ["192.168.0.150", "192.168.0.77"]);
  logsDir = path.join(root, "logs");
  remote = "::ffff:192.168.0.150";
  states = new Map();
  jobs = new Map();
  listeners = [];
  clients = [];
});
afterEach(async () => {
  for (const c of clients) c.terminate();
  hub?.close();
  await new Promise((r) => server?.close(r));
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("upgrade checks", () => {
  it("refuses a disallowed IP with 403", async () => {
    await start();
    remote = "10.0.0.1";
    await expect(connect()).rejects.toThrow("HTTP 403");
  });
  it("refuses a foreign Host", async () => {
    await start();
    await expect(connect({ Host: "evil.example:4200" })).rejects.toThrow("HTTP 403");
  });
  it("refuses <hostname>.attacker.com even with a matching Origin", async () => {
    await start();
    await expect(connect({ Host: "server-pc.attacker.com:4200", Origin: "http://server-pc.attacker.com:4200" })).rejects.toThrow("HTTP 403");
  });
  it("refuses an Origin whose host differs from Host", async () => {
    await start();
    await expect(connect({ Origin: "http://evil.example" })).rejects.toThrow("HTTP 403");
    await expect(connect({ Host: "192.168.0.100:4200", Origin: "http://192.168.0.100:4201" })).rejects.toThrow("HTTP 403");
  });
  it("accepts a matching Origin and a missing one", async () => {
    await start();
    await connect({ Host: "192.168.0.100:4200", Origin: "http://192.168.0.100:4200" });
    await connect();
  });
  it("refuses other paths", async () => {
    await start();
    await expect(new Promise((res, rej) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/other`);
      clients.push(ws);
      ws.once("open", res);
      ws.once("error", rej);
      ws.once("unexpected-response", (_q, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    })).rejects.toThrow();
  });
});

describe("status", () => {
  it("sends status for all servers on connect, without secrets", async () => {
    const a = mk("a");
    const b = mk("b");
    states.set(a.id, { status: "running", crashPaused: false, cpuPct: 3 });
    await start();
    const c = await connect();
    const m1 = await c.next();
    const m2 = await c.next();
    const byId = new Map([m1, m2].map((m) => [(m as { server: { id: string } }).server.id, m]));
    expect(m1.type).toBe("status");
    expect((byId.get(a.id) as { server: { status: string } }).server.status).toBe("running");
    expect((byId.get(b.id) as { server: { status: string } }).server.status).toBe("stopped");
    expect(JSON.stringify(c.msgs)).not.toContain("topsecret");
    expect(JSON.stringify(c.msgs)).not.toContain("secrets");
  });
  it("broadcasts status events, coalesced to one per server per tick", async () => {
    const a = mk("a");
    await start(300);
    const c = await connect();
    await c.next(); // initial
    const before = c.msgs.length;
    states.set(a.id, { status: "starting", crashPaused: false });
    emit({ type: "status", serverId: a.id, state: { status: "starting", crashPaused: false } });
    states.set(a.id, { status: "running", crashPaused: false, cpuPct: 1 });
    emit({ type: "status", serverId: a.id, state: { status: "running", crashPaused: false, cpuPct: 1 } });
    states.set(a.id, { status: "running", crashPaused: false, cpuPct: 2 });
    emit({ type: "status", serverId: a.id, state: { status: "running", crashPaused: false, cpuPct: 2 } });
    const first = await c.next();
    expect((first as { server: { status: string } }).server.status).toBe("starting");
    await sleep(50);
    expect(c.msgs.length).toBe(before + 1);
    const second = await c.next(undefined, 1000);
    expect((second as { server: { cpuPct: number } }).server.cpuPct).toBe(2);
    await sleep(400);
    expect(c.msgs.length).toBe(before + 2);
  });
  it("notify changed/removed reach clients", async () => {
    await start();
    const c = await connect();
    const a = mk("late");
    hub.notify({ type: "changed", serverId: a.id });
    const m = await c.next((x) => x.type === "status");
    expect((m as { server: { name: string } }).server.name).toBe("late");
    hub.notify({ type: "removed", serverId: a.id });
    expect(await c.next((x) => x.type === "removed")).toEqual({ type: "removed", serverId: a.id });
  });
  it("an allowlist change disconnects clients that are no longer allowed", async () => {
    await start();
    const kept = await connect();
    remote = "::ffff:192.168.0.77";
    const dropped = await connect();
    const closed = new Promise<void>((r) => dropped.ws.once("close", () => r()));
    settings.update({ allowlist: ["192.168.0.150"] });
    hub.notify({ type: "allChanged" });
    await closed;
    await sleep(50);
    expect(kept.ws.readyState).toBe(WebSocket.OPEN);
    expect(hub.clientCount()).toBe(1);
  });
  it("events for unknown servers are ignored and never throw", async () => {
    await start();
    await connect();
    expect(() => emit({ type: "status", serverId: "gone", state: { status: "stopped", crashPaused: false } })).not.toThrow();
  });
});

describe("logs", () => {
  it("subscribe gets logHistory, then only that server's log messages", async () => {
    const a = mk("a");
    const b = mk("b");
    const run = createRun(logsDir, a.id, new Date("2026-01-01T00:00:00Z"));
    fs.writeFileSync(run.consolePath, Array.from({ length: 600 }, (_, i) => `l${i}`).join("\r\n") + "\r\n");
    states.set(a.id, { status: "running", crashPaused: false, runId: run.runId });
    await start();
    const c = await connect();
    send(c, { type: "subscribeLogs", serverId: a.id });
    const h = await c.next((m) => m.type === "logHistory");
    expect(h).toMatchObject({ type: "logHistory", serverId: a.id, runId: run.runId });
    const lines = (h as { lines: string[] }).lines;
    expect(lines).toHaveLength(500);
    expect(lines[0]).toBe("l100");
    expect(lines.at(-1)).toBe("l599");

    emit({ type: "log", serverId: b.id, runId: "r", lines: ["other"] });
    emit({ type: "log", serverId: a.id, runId: run.runId, lines: ["mine"] });
    const l = await c.next((m) => m.type === "log");
    expect(l).toEqual({ type: "log", serverId: a.id, runId: run.runId, lines: ["mine"] });
    await sleep(50);
    expect(c.msgs.filter((m) => m.type === "log")).toHaveLength(1);
  });
  it("history prefers the running job's run over the game's run", async () => {
    const a = mk("a");
    const game = createRun(logsDir, a.id, new Date("2026-01-01T00:00:00Z"));
    fs.writeFileSync(game.consolePath, "old game line\n");
    const jobRun = createRun(logsDir, a.id, new Date("2026-01-02T00:00:00Z"));
    fs.writeFileSync(jobRun.consolePath, "job line\n");
    states.set(a.id, { status: "stopped", crashPaused: false, runId: game.runId });
    jobs.set(a.id, { kind: "update", state: "running", steps: [], progress: null, runId: jobRun.runId });
    await start();
    const c = await connect();
    send(c, { type: "subscribeLogs", serverId: a.id });
    expect(await c.next((m) => m.type === "logHistory")).toEqual({ type: "logHistory", serverId: a.id, runId: jobRun.runId, lines: ["job line"] });
  });
  it("history ignores a failed job while the game has its own run", async () => {
    const a = mk("a");
    const game = createRun(logsDir, a.id, new Date("2026-01-01T00:00:00Z"));
    fs.writeFileSync(game.consolePath, "game line\n");
    const jobRun = createRun(logsDir, a.id, new Date("2026-01-02T00:00:00Z"));
    fs.writeFileSync(jobRun.consolePath, "job line\n");
    states.set(a.id, { status: "running", crashPaused: false, runId: game.runId });
    jobs.set(a.id, { kind: "update", state: "failed", steps: [], progress: null, runId: jobRun.runId });
    await start();
    const c = await connect();
    send(c, { type: "subscribeLogs", serverId: a.id });
    expect(await c.next((m) => m.type === "logHistory")).toEqual({ type: "logHistory", serverId: a.id, runId: game.runId, lines: ["game line"] });
  });
  it("history falls back to the newest run; none → empty", async () => {
    const a = mk("a");
    const b = mk("b");
    createRun(logsDir, a.id, new Date("2026-01-01T00:00:00Z"));
    const newest = createRun(logsDir, a.id, new Date("2026-01-02T00:00:00Z"));
    fs.writeFileSync(newest.consolePath, "x\n");
    await start();
    const c = await connect();
    send(c, { type: "subscribeLogs", serverId: a.id });
    expect(await c.next((m) => m.type === "logHistory")).toEqual({ type: "logHistory", serverId: a.id, runId: newest.runId, lines: ["x"] });
    send(c, { type: "subscribeLogs", serverId: b.id });
    expect(await c.next((m) => m.type === "logHistory")).toEqual({ type: "logHistory", serverId: b.id, runId: null, lines: [] });
  });
  it("unsubscribe stops log messages; unknown servers and junk are ignored", async () => {
    const a = mk("a");
    await start();
    const c = await connect();
    c.ws.send("not json");
    send(c, { type: "subscribeLogs", serverId: "nope" });
    send(c, { type: "bogus" });
    send(c, { type: "subscribeLogs", serverId: a.id });
    await c.next((m) => m.type === "logHistory");
    send(c, { type: "unsubscribeLogs", serverId: a.id });
    await sleep(50);
    emit({ type: "log", serverId: a.id, runId: "r", lines: ["after"] });
    await sleep(50);
    expect(c.msgs.filter((m) => m.type === "log" || (m.type === "logHistory" && m.serverId === "nope"))).toEqual([]);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });
  it("a closed client does not break broadcasting to others", async () => {
    const a = mk("a");
    await start();
    const c1 = await connect();
    const c2 = await connect();
    send(c1, { type: "subscribeLogs", serverId: a.id });
    send(c2, { type: "subscribeLogs", serverId: a.id });
    await c1.next((m) => m.type === "logHistory");
    await c2.next((m) => m.type === "logHistory");
    c1.ws.terminate();
    expect(() => emit({ type: "log", serverId: a.id, runId: "r", lines: ["z"] })).not.toThrow();
    expect(await c2.next((m) => m.type === "log")).toMatchObject({ lines: ["z"] });
    await sleep(50);
    expect(hub.clientCount()).toBe(1);
  });
});
