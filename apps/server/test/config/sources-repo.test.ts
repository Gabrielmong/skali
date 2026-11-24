import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../../src/db.js";
import { ConfigSourcesRepo } from "../../src/config/sources-repo.js";
import { ConflictError } from "../../src/errors.js";

let root: string, db: Db, repo: ConfigSourcesRepo;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-src-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ConfigSourcesRepo(db);
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ConfigSourcesRepo", () => {
  it("add/list/update/remove", () => {
    const a = repo.add("s1", { path: "C:\\x\\a.ini", format: "ini", label: "A" });
    expect(a.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).toMatchObject({ serverId: "s1", path: "C:\\x\\a.ini", format: "ini", label: "A" });
    repo.add("s2", { path: "C:\\x\\a.ini", format: "ini", label: "other server" });
    expect(repo.list("s1").map((s) => s.id)).toEqual([a.id]);
    expect(repo.update("s1", a.id, { label: "B", format: "json" })).toBe(true);
    expect(repo.list("s1")[0]).toMatchObject({ label: "B", format: "json" });
    repo.update("s1", a.id, { label: "C" });
    expect(repo.list("s1")[0]).toMatchObject({ label: "C", format: "json" });
    expect(repo.remove("s1", a.id)).toBe(true);
    expect(repo.remove("s1", a.id)).toBe(false);
    expect(repo.list("s1")).toEqual([]);
    expect(repo.list("s2")).toHaveLength(1);
  });
  it("a duplicate path (different case) is a ConflictError", () => {
    repo.add("s1", { path: "C:\\x\\a.ini", format: "ini", label: "A" });
    expect(() => repo.add("s1", { path: "c:\\X\\A.INI", format: "ini", label: "B" })).toThrow(ConflictError);
    expect(() => repo.add("s1", { path: "c:\\X\\A.INI", format: "ini", label: "B" })).toThrow("That file is already in the list");
  });
  it("update/remove with the wrong serverId return false and leave the row", () => {
    const a = repo.add("s1", { path: "a", format: "raw", label: "A" });
    expect(repo.update("s2", a.id, { label: "X" })).toBe(false);
    expect(repo.remove("s2", a.id)).toBe(false);
    expect(repo.list("s1")[0]).toMatchObject({ label: "A" });
  });
  it("removeAll clears one server only", () => {
    repo.add("s1", { path: "a", format: "raw", label: "A" });
    repo.add("s1", { path: "b", format: "raw", label: "B" });
    repo.add("s2", { path: "a", format: "raw", label: "A" });
    repo.removeAll("s1");
    expect(repo.list("s1")).toEqual([]);
    expect(repo.list("s2")).toHaveLength(1);
  });
});
