import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, SCHEMA_VERSION } from "../src/db.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-mig-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("db", () => {
  it("SCHEMA_VERSION; a v1 database migrates and keeps its servers", () => {
    const p = path.join(root, "v1.db");
    const old = new Database(p);
    old.exec(`CREATE TABLE servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, game TEXT NOT NULL, folder TEXT NOT NULL,
      launch TEXT NOT NULL, secrets TEXT NOT NULL, desired TEXT NOT NULL, auto_restart INTEGER NOT NULL,
      auto_start INTEGER NOT NULL, stop_timeout_sec INTEGER NOT NULL, pid INTEGER, pid_start_time TEXT,
      current_run_id TEXT, created_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    old
      .prepare("INSERT INTO servers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("a", "Old", "valheim", "C:\\f", "{}", "x", "stopped", 1, 1, 30, null, null, null, "2026-01-01T00:00:00.000Z");
    old.pragma("user_version = 1");
    old.close();
    const db = openDb(p);
    expect(db.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(db.prepare("SELECT id, name, config_changed_at FROM servers").all()).toEqual([
      { id: "a", name: "Old", config_changed_at: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM config_sources").get()).toEqual({ n: 0 });
    db.close();
  });
  it("SCHEMA_VERSION is 3; a v2 database migrates and the row reads back with defaults", () => {
    expect(SCHEMA_VERSION).toBe(3);
    const p = path.join(root, "v2.db");
    const old = new Database(p);
    old.exec(`CREATE TABLE servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, game TEXT NOT NULL, folder TEXT NOT NULL,
      launch TEXT NOT NULL, secrets TEXT NOT NULL, desired TEXT NOT NULL, auto_restart INTEGER NOT NULL,
      auto_start INTEGER NOT NULL, stop_timeout_sec INTEGER NOT NULL, pid INTEGER, pid_start_time TEXT,
      current_run_id TEXT, created_at TEXT NOT NULL, config_changed_at TEXT);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE config_sources (id TEXT PRIMARY KEY, server_id TEXT NOT NULL, path TEXT NOT NULL, format TEXT NOT NULL,
        label TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (server_id, path COLLATE NOCASE));`);
    old
      .prepare("INSERT INTO servers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("a", "Old", "valheim", "C:\\f", "{}", "x", "stopped", 1, 1, 30, null, null, null, "2026-01-01T00:00:00.000Z", null);
    old.pragma("user_version = 2");
    old.close();
    const db = openDb(p);
    expect(db.pragma("user_version", { simple: true })).toBe(3);
    expect(db.prepare("SELECT steam_app_id, setup_pending, created_folder, job FROM servers").all()).toEqual([
      { steam_app_id: null, setup_pending: 0, created_folder: 0, job: null },
    ]);
    db.close();
  });
});
