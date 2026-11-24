import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SKALI_HEADER, SKALI_HEADER_VALUE, type RuntimeState } from "@skali/shared";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigHistory } from "../../src/config/history.js";
import { ConfigSourcesRepo } from "../../src/config/sources-repo.js";
import { openDb, type Db } from "../../src/db.js";
import { createApp, type AppEvent, type SupervisorApi } from "../../src/http/app.js";
import { ServerRepo, type ServerRecord } from "../../src/servers/repo.js";
import { SettingsStore } from "../../src/settings.js";
import type { AdopterApi } from "../../src/http/app.js";

const key = Buffer.alloc(32, 3);
const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const PAL_REL = "Pal\\Saved\\Config\\WindowsServer\\PalWorldSettings.ini";

let root: string, db: Db, repo: ServerRepo, rec: ServerRecord, events: AppEvent[];
let states: Map<string, RuntimeState>;

function app() {
  const supervisor = {
    state: (id: string) => states.get(id) ?? { status: "stopped", crashPaused: false },
  } as unknown as SupervisorApi;
  return createApp({
    repo,
    configSources: new ConfigSourcesRepo(db),
    configHistory: new ConfigHistory(path.join(root, "hist")),
    supervisor,
    adopter: {} as AdopterApi,
    settings: new SettingsStore(db, ["192.168.0.150"]),
    logsDir: path.join(root, "logs"),
    webDist: path.join(root, "web"),
    remoteAddress: () => "::ffff:192.168.0.150",
    hostname: "SERVER-PC",
    log: vi.fn(),
    notify: (e) => events.push(e),
  });
}
const base = () => `/api/servers/${rec.id}/config`;
const H = { [SKALI_HEADER]: SKALI_HEADER_VALUE };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-cfgr-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, key);
  states = new Map();
  events = [];
  const folder = path.join(root, "pal");
  fs.mkdirSync(folder);
  rec = repo.create({ name: "pal", game: "palworld", folder, launch: {}, stopTimeoutSec: 60 });
  const f = path.join(folder, PAL_REL);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.copyFileSync(path.join(FIXTURES, "DefaultPalWorldSettings.ini"), f);
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("routes: config", () => {
  it("happy path through every route", async () => {
    const a = app();
    const src = await request(a).get(`${base()}/sources`);
    expect(src.status).toBe(200);
    expect(src.body.map((s: { id: string }) => s.id)).toEqual(["launch", "palworld-settings"]);

    fs.writeFileSync(path.join(rec.folder, "extra.ini"), "a=1\n");
    const add = await request(a).post(`${base()}/sources`).set(H).send({ path: "extra.ini" });
    expect(add.status).toBe(201);
    expect(add.body).toMatchObject({ label: "extra.ini", format: "ini", builtin: false });
    const patched = await request(a).patch(`${base()}/sources/${add.body.id}`).set(H).send({ label: "Extra" });
    expect(patched.body.label).toBe("Extra");

    const file = await request(a).get(`${base()}/files/palworld-settings`);
    expect(file.status).toBe(200);
    expect(file.body.fields.length).toBeGreaterThan(10);

    const prev = await request(a).post(`${base()}/files/palworld-settings/preview`).set(H).send({ changes: { ExpRate: 9 } });
    expect(prev.status).toBe(200);
    expect(prev.body.raw).toContain("ExpRate=9,");

    const put = await request(a).put(`${base()}/files/palworld-settings`).set(H).send({ etag: file.body.etag, changes: { ExpRate: 9 } });
    expect(put.status).toBe(200);
    expect(put.body.restartPending).toBe(false);
    expect(put.body.file.raw).toContain("ExpRate=9,");
    expect(events).toContainEqual({ type: "changed", serverId: rec.id });

    const hist = await request(a).get(`${base()}/files/palworld-settings/history`);
    expect(hist.body).toHaveLength(1);
    const entry = hist.body[0].id as string;
    const raw = await request(a).get(`${base()}/files/palworld-settings/history/${entry}`);
    expect(raw.body.raw).toContain("ExpRate=1.000000");
    const rest = await request(a).post(`${base()}/files/palworld-settings/history/${entry}/restore`).set(H).send({ etag: put.body.file.etag });
    expect(rest.status).toBe(200);
    expect(rest.body.file.raw).toContain("ExpRate=1.000000");

    const del = await request(a).delete(`${base()}/sources/${add.body.id}`).set(H);
    expect(del.status).toBe(204);
  });

  it("launch on /files routes is 400", async () => {
    const a = app();
    const msg = { error: "Launch settings are edited through the server settings" };
    for (const [m, p] of [["get", "launch"], ["get", "launch/history"], ["post", "launch/preview"], ["put", "launch"]] as const) {
      const r = await request(a)[m](`${base()}/files/${p}`).set(H).send({});
      expect(r.status, `${m} ${p}`).toBe(400);
      expect(r.body).toEqual(msg);
    }
  });

  it("unknown source and server are 404; a different server's source is 404", async () => {
    const a = app();
    expect((await request(a).get(`${base()}/files/nope`)).status).toBe(404);
    expect((await request(a).delete(`${base()}/sources/nope`).set(H)).status).toBe(404);
    expect((await request(a).get(`/api/servers/nope/config/sources`)).status).toBe(404);
    const folder2 = path.join(root, "pal2");
    fs.mkdirSync(folder2);
    fs.writeFileSync(path.join(folder2, "x.ini"), "a=1\n");
    const rec2 = repo.create({ name: "pal2", game: "palworld", folder: folder2, launch: {}, stopTimeoutSec: 60 });
    const add = await request(a).post(`/api/servers/${rec2.id}/config/sources`).set(H).send({ path: "x.ini" });
    expect((await request(a).get(`${base()}/files/${add.body.id}`)).status).toBe(404);
  });

  it("PUT without X-Skali is 403", async () => {
    const r = await request(app()).put(`${base()}/files/palworld-settings`).send({ etag: "x", raw: "x" });
    expect(r.status).toBe(403);
  });

  it("validates bodies", async () => {
    const a = app();
    const put = (b: unknown) => request(a).put(`${base()}/files/palworld-settings`).set(H).send(b as object);
    expect((await put({ etag: "x" })).status).toBe(400);
    expect((await put({ etag: "x", raw: "a", changes: {} })).status).toBe(400);
    expect((await put({ etag: "x", raw: 5 })).status).toBe(400);
    expect((await put({ etag: "x", changes: { a: null } })).status).toBe(400);
    expect((await put({ etag: "x", changes: [1] })).status).toBe(400);
    expect((await put({ raw: "a" })).status).toBe(400);
    expect((await put({ etag: "x", raw: "a", extra: 1 })).status).toBe(400);
    const many = Object.fromEntries(Array.from({ length: 2001 }, (_, i) => [`k${i}`, i]));
    expect((await put({ etag: "x", changes: many })).status).toBe(400);
    expect((await put({ etag: "x", raw: "a".repeat(1024 * 1024 + 1) })).status).toBe(400);
    const bad = await request(a).post(`${base()}/sources`).set(H).send({ path: "a.ini", format: "toml" });
    expect(bad.status).toBe(400);
    expect((await request(a).post(`${base()}/files/palworld-settings/preview`).set(H).send({ etag: "x", raw: "a" })).status).toBe(400);
  });

  it("accepts a 1 MiB raw body (above the global JSON limit) and answers 409 for a stale etag", async () => {
    const a = app();
    const r = await request(a).put(`${base()}/files/palworld-settings`).set(H).send({ etag: "stale", raw: "a".repeat(1024 * 1024) });
    expect(r.status).toBe(409);
  });

  it("409 while starting", async () => {
    states.set(rec.id, { status: "starting", crashPaused: false });
    const a = app();
    const f = await request(a).get(`${base()}/files/palworld-settings`);
    const r = await request(a).put(`${base()}/files/palworld-settings`).set(H).send({ etag: f.body.etag, changes: { ExpRate: 2 } });
    expect(r.status).toBe(409);
  });
});
