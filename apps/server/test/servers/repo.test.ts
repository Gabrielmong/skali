import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb as rawOpenDb, SCHEMA_VERSION } from "../../src/db.js";
import { BadRequestError, NotFoundError } from "../../src/errors.js";
import { ServerRepo } from "../../src/servers/repo.js";

const key = Buffer.alloc(32, 7);
const opened: ReturnType<typeof rawOpenDb>[] = [];
const openDb = (p: string) => { const d = rawOpenDb(p); opened.push(d); return d; };
let dir: string;
let dbPath: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "skali-repo-")); dbPath = join(dir, "t.db"); });
afterEach(() => { for (const d of opened.splice(0)) if (d.open) d.close(); rmSync(dir, { recursive: true, force: true }); });

const input = (name = "Pal One") => ({
  name, game: "palworld" as const, folder: "C:\\games\\pal", launch: { port: 8211, rcon: true }, stopTimeoutSec: 30,
});

describe("ServerRepo job fields", () => {
  it("round-trips steamAppId, setupPending, createdFolder and job", () => {
    const repo = new ServerRepo(openDb(dbPath), key);
    const plain = repo.create(input("Plain"));
    expect(repo.get(plain.id)).toMatchObject({ steamAppId: null, setupPending: false, createdFolder: false, job: null });
    const c = repo.create({ ...input(), steamAppId: 896660, createdFolder: true });
    const job = { kind: "install" as const, state: "failed" as const, steps: [{ id: "files", label: "Game files", state: "failed" as const }], error: "x", runId: "r", params: { a: 1 } };
    repo.update(c.id, { setupPending: true, job });
    expect(repo.get(c.id)).toMatchObject({ steamAppId: 896660, setupPending: true, createdFolder: true, job });
    repo.update(c.id, { job: null });
    expect(repo.get(c.id).job).toBeNull();
  });
});

describe("ServerRepo", () => {
  it("create/get round-trips with defaults and decrypted secrets", () => {
    const repo = new ServerRepo(openDb(dbPath), key);
    const c = repo.create({ ...input(), secrets: { adminPassword: "s3cret" } });
    const g = repo.get(c.id);
    expect(g).toEqual(c);
    expect(g.secrets).toEqual({ adminPassword: "s3cret" });
    expect(g.launch).toEqual({ port: 8211, rcon: true });
    expect(g).toMatchObject({ desired: "stopped", autoRestart: true, autoStart: true, pid: null, pidStartTime: null, currentRunId: null });
    expect(repo.list()).toHaveLength(1);
  });

  it("does not store plaintext secrets", () => {
    const db = openDb(dbPath);
    new ServerRepo(db, key).create({ ...input(), secrets: { adminPassword: "s3cret" } });
    const raw = (db.prepare("SELECT secrets FROM servers").get() as { secrets: string }).secrets;
    expect(raw).not.toContain("s3cret");
  });

  it("rejects duplicate names case-insensitively and invalid names", () => {
    const repo = new ServerRepo(openDb(dbPath), key);
    repo.create(input("Alpha"));
    expect(() => repo.create(input("alpha"))).toThrow(new BadRequestError("Name already used"));
    expect(() => repo.create(input("a/b"))).toThrow(new BadRequestError("Name may only contain letters, numbers, spaces, _ . - (1-40 characters)"));
    expect(() => repo.create(input(""))).toThrow(BadRequestError);
    const b = repo.create(input("Beta"));
    expect(() => repo.update(b.id, { name: "ALPHA" })).toThrow(new BadRequestError("Name already used"));
    expect(() => repo.update(b.id, { name: "x:y" })).toThrow(BadRequestError);
  });

  it("enforces the 40-character name limit", () => {
    const repo = new ServerRepo(openDb(dbPath), key);
    expect(() => repo.create(input("a".repeat(41)))).toThrow(BadRequestError);
    expect(repo.create(input("b".repeat(40))).name).toHaveLength(40);
  });

  it("pid-only update leaves the raw secrets column byte-identical and other fields intact", () => {
    const db = openDb(dbPath);
    const repo = new ServerRepo(db, key);
    const c = repo.create({ ...input(), secrets: { a: "b" } });
    const raw = () => (db.prepare("SELECT secrets FROM servers").get() as { secrets: string }).secrets;
    const before = raw();
    repo.update(c.id, { pid: 99 });
    expect(raw()).toBe(before);
    const u = repo.update(c.id, { autoRestart: false });
    expect(u).toEqual({ ...c, pid: 99, autoRestart: false });
    expect(repo.get(c.id)).toEqual(u);
  });

  it("update persists patches", () => {
    const db = openDb(dbPath);
    const repo = new ServerRepo(db, key);
    const c = repo.create(input());
    const u = repo.update(c.id, { desired: "running", pid: 42, pidStartTime: "t", currentRunId: "r", autoRestart: false, secrets: { a: "b" }, launch: { port: 1 } });
    expect(u).toMatchObject({ desired: "running", pid: 42, autoRestart: false, secrets: { a: "b" } });
    expect(new ServerRepo(db, key).get(c.id)).toEqual(u);
    expect(repo.update(c.id, { pid: null }).pid).toBeNull();
    expect(() => repo.update("nope", { pid: 1 })).toThrow(NotFoundError);
  });

  it("delete then get throws NotFound", () => {
    const repo = new ServerRepo(openDb(dbPath), key);
    const c = repo.create(input());
    repo.delete(c.id);
    expect(() => repo.get(c.id)).toThrow(NotFoundError);
    expect(() => repo.delete(c.id)).toThrow(NotFoundError);
  });

  it("reopening keeps rows and user_version is the current schema version", () => {
    const db = openDb(dbPath);
    const c = new ServerRepo(db, key).create(input());
    db.close();
    const db2 = openDb(dbPath);
    expect(db2.pragma("user_version", { simple: true })).toBe(SCHEMA_VERSION);
    expect(new ServerRepo(db2, key).get(c.id).name).toBe("Pal One");
    db2.close();
  });
});
