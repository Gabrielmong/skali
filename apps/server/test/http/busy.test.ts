import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeState } from "@skali/shared";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigHistory } from "../../src/config/history.js";
import { ConfigSourcesRepo } from "../../src/config/sources-repo.js";
import { openDb, type Db } from "../../src/db.js";
import { createApp, type SupervisorApi } from "../../src/http/app.js";
import { ServerRepo } from "../../src/servers/repo.js";
import { SettingsStore } from "../../src/settings.js";

let root: string, db: Db, repo: ServerRepo, settings: SettingsStore;
let remote: string | undefined;
let states: Map<string, RuntimeState>;

function mk(name: string) {
  return repo.create({
    name, game: "valheim", folder: root, stopTimeoutSec: 30,
    launch: { port: 2456, world: "W", public: true, crossplay: false, extraArgs: "", password: "secret1" },
  });
}
function app() {
  const supervisor = {
    state: vi.fn((id: string) => states.get(id) ?? { status: "stopped", crashPaused: false }),
  } as unknown as SupervisorApi;
  return createApp({
    repo, configSources: new ConfigSourcesRepo(db), configHistory: new ConfigHistory(path.join(root, "config-history")), supervisor, adopter: {} as never, settings, logsDir: path.join(root, "logs"), webDist: root,
    remoteAddress: () => remote, hostname: "SERVER-PC", log: () => undefined,
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-busy-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, Buffer.alloc(32, 3));
  settings = new SettingsStore(db, ["192.168.0.150"]);
  states = new Map();
  remote = "127.0.0.1";
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("GET /api/deploys/busy", () => {
  it("reports a stopping server", async () => {
    const s = mk("Valheim");
    states.set(s.id, { status: "stopping", crashPaused: false });
    const r = await request(app()).get("/api/deploys/busy").set("Host", "127.0.0.1:4200");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ busy: true, reasons: ["Valheim is stopping"] });
  });
  it("reports a starting server", async () => {
    const s = mk("Valheim");
    states.set(s.id, { status: "starting", crashPaused: false });
    remote = "::1";
    const r = await request(app()).get("/api/deploys/busy").set("Host", "[::1]:4200");
    expect(r.body.reasons).toEqual(["Valheim is starting"]);
  });
  it("is idle when nothing is transitioning", async () => {
    const s = mk("Valheim");
    states.set(s.id, { status: "running", crashPaused: false });
    const r = await request(app()).get("/api/deploys/busy").set("Host", "127.0.0.1:4200");
    expect(r.body).toEqual({ busy: false, reasons: [] });
  });
  it("accepts ::ffff:127.0.0.1 and ::1", async () => {
    for (const a of ["::1", "::ffff:127.0.0.1"]) {
      remote = a;
      const r = await request(app()).get("/api/deploys/busy").set("Host", "127.0.0.1:4200");
      expect(r.status).toBe(200);
    }
  });
  it("404s a non-loopback remote even when allowlisted", async () => {
    remote = "192.168.0.150";
    const r = await request(app()).get("/api/deploys/busy");
    expect(r.status).toBe(404);
  });
});
