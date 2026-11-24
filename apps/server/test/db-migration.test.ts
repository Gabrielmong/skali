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
  it("SCHEMA_VERSION is 2; a v1 database migrates and keeps its servers", () => {
    expect(SCHEMA_VERSION).toBe(2);
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
    expect(db.pragma("user_version", { simple: true })).toBe(2);
    expect(db.prepare("SELECT id, name, config_changed_at FROM servers").all()).toEqual([
      { id: "a", name: "Old", config_changed_at: null },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM config_sources").get()).toEqual({ n: 0 });
    db.close();
  });
});
