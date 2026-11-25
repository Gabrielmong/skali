import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, SCHEMA_VERSION } from "../src/db.js";
import { ServerRepo } from "../src/servers/repo.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-probe-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const probeTs = path.resolve(__dirname, "../src/deploy-probe.ts");
const tsx = path.resolve(__dirname, "../node_modules/tsx/dist/cli.mjs");
const run = (dbPath?: string) =>
  spawnSync(process.execPath, [tsx, probeTs, ...(dbPath === undefined ? [] : [dbPath])], { encoding: "utf8" });

describe("deploy-probe", { timeout: 30_000 }, () => {
  it("prints userVersion, walBytes and servers", () => {
    const p = path.join(root, "t.db");
    const db = openDb(p);
    const repo = new ServerRepo(db, Buffer.alloc(32, 1));
    const rec = repo.create({
      name: "Val", game: "valheim", folder: root, stopTimeoutSec: 30,
      launch: { port: 2456, world: "W", public: true, crossplay: false, extraArgs: "", password: "secret1" },
    });
    const r = run(p);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.userVersion).toBe(SCHEMA_VERSION);
    expect(typeof out.walBytes).toBe("number");
    expect(out.servers).toEqual([{ id: rec.id, pid: null, desired: rec.desired }]);
    db.close();
  });
  it("exits 2 for a missing file and creates nothing", () => {
    const p = path.join(root, "missing.db");
    const r = run(p);
    expect(r.status).toBe(2);
    expect(r.stderr.length).toBeGreaterThan(0);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("probes a cleanly closed DB with no sidecars and leaves it unchanged", () => {
    const p = path.join(root, "t.db");
    const db = openDb(p);
    const repo = new ServerRepo(db, Buffer.alloc(32, 1));
    const rec = repo.create({
      name: "Val", game: "valheim", folder: root, stopTimeoutSec: 30,
      launch: { port: 2456, world: "W", public: true, crossplay: false, extraArgs: "", password: "secret1" },
    });
    db.close();
    for (const ext of ["-wal", "-shm"]) fs.rmSync(p + ext, { force: true });
    const r = run(p);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({
      userVersion: SCHEMA_VERSION, walBytes: 0, servers: [{ id: rec.id, pid: null, desired: rec.desired }],
    });
    const chk = new Database(p, { readonly: true });
    expect(chk.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(chk.prepare("SELECT id FROM servers").all()).toEqual([{ id: rec.id }]);
    chk.close();
  });
  const failing = (name: string, setup: () => string | undefined) =>
    it(`exits 2 with stderr and empty stdout: ${name}`, () => {
      const r = run(setup());
      expect(r.status).toBe(2);
      expect(r.stderr.length).toBeGreaterThan(0);
      expect(r.stdout).toBe("");
    });
  failing("corrupt file", () => {
    const p = path.join(root, "bad.db");
    fs.writeFileSync(p, Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) % 256)));
    return p;
  });
  failing("no servers table", () => {
    const p = path.join(root, "empty.db");
    const d = new Database(p);
    d.exec("CREATE TABLE x (a INTEGER)");
    d.close();
    return p;
  });
  failing("missing argument", () => undefined);
});
