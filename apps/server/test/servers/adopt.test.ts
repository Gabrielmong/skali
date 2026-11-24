import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb as rawOpenDb } from "../../src/db.js";
import { BadRequestError, ConflictError } from "../../src/errors.js";
import { getAdapter } from "../../src/games/registry.js";
import { Adopter } from "../../src/servers/adopt.js";
import { ServerRepo } from "../../src/servers/repo.js";
import { findValheimWorlds } from "../../src/servers/valheim-worlds.js";

const key = Buffer.alloc(32, 7);
let root: string, users: string, repo: ServerRepo, db: ReturnType<typeof rawOpenDb>;
let prot: NonNullable<ConstructorParameters<typeof Adopter>[0]["protectedPaths"]>;
let fwCalls: string[], rmCalls: string[], aclCalls: [string, string][];

function worldsDir(user: string, sub = "worlds_local") {
  const d = join(users, user, "AppData", "LocalLow", "IronGate", "Valheim", sub);
  mkdirSync(d, { recursive: true });
  return d;
}
function mkFolder(name: string, files: Record<string, string> = {}) {
  const f = join(root, name);
  mkdirSync(f, { recursive: true });
  for (const [k, v] of Object.entries(files)) writeFileSync(join(f, k), v);
  return f;
}
const valheimFolder = (n = "vh") => mkFolder(n, { "valheim_server.exe": "x" });

function adopter(over: Partial<ConstructorParameters<typeof Adopter>[0]> = {}) {
  return new Adopter({
    repo, adapter: getAdapter, gamesUser: "SkaliGames", usersRoot: users, protectedPaths: prot,
    firewall: async (n) => { fwCalls.push(n); },
    removeFirewall: async (n) => { rmCalls.push(n); },
    acl: async (f, u) => { aclCalls.push([f, u]); },
    ...over,
  });
}
const vhReq = (folder: string, extra = {}) => ({
  game: "valheim" as const, name: "friends", folder,
  launch: { port: 2456, world: "Dedicated", public: true, crossplay: false, extraArgs: "", password: "secret1", name: "friends" },
  ...extra,
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "skali-adopt-"));
  users = join(root, "Users");
  mkdirSync(users);
  db = rawOpenDb(join(root, "t.db"));
  repo = new ServerRepo(db, key);
  prot = {
    systemRoot: join(root, "Windows"), programFiles: [join(root, "PF"), join(root, "PF86")],
    programData: join(root, "PD"), dataDir: join(root, "PD", "Skali"), installDir: join(root, "Install"),
  };
  fwCalls = []; rmCalls = []; aclCalls = [];
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

describe("findValheimWorlds", () => {
  it("finds worlds with .db, ignores orphan .fwl, skips unreadable dirs, sorts newest first", async () => {
    const d = worldsDir("alice");
    writeFileSync(join(d, "Dedicated.fwl"), "f"); writeFileSync(join(d, "Dedicated.db"), "d");
    writeFileSync(join(d, "Orphan.fwl"), "f");
    const d2 = worldsDir("bob", "worlds");
    writeFileSync(join(d2, "Newer.fwl"), "f"); writeFileSync(join(d2, "Newer.db"), "d");
    utimesSync(join(d, "Dedicated.fwl"), new Date(2020, 1, 1), new Date(2020, 1, 1));
    mkdirSync(join(users, "Default"));
    writeFileSync(join(users, "stray.txt"), "x");
    const w = await findValheimWorlds(users);
    expect(w.map((x) => x.name)).toEqual(["Newer", "Dedicated"]);
    expect(w[1]!.fwlPath).toBe(join(d, "Dedicated.fwl"));
    expect(new Date(w[0]!.modified).toISOString()).toBe(w[0]!.modified);
  });
  it("returns [] when the users root does not exist", async () => {
    expect(await findValheimWorlds(join(root, "nope"))).toEqual([]);
  });
});

describe("Adopter.adopt", () => {
  it("adopts, grants ACL and opens firewall", async () => {
    const f = valheimFolder();
    const rec = await adopter().adopt(vhReq(f));
    expect(repo.get(rec.id).name).toBe("friends");
    expect(rec.stopTimeoutSec).toBe(getAdapter("valheim").defaultStopTimeoutSec);
    expect(aclCalls).toEqual([[f, "SkaliGames"]]);
    expect(fwCalls).toEqual(["friends"]);
  });

  it("skips ACL when gamesUser is null", async () => {
    await adopter({ gamesUser: null }).adopt(vhReq(valheimFolder()));
    expect(aclCalls).toEqual([]);
  });

  it("rejects relative, missing, non-directory and quoted folders", async () => {
    const a = adopter();
    await expect(a.adopt(vhReq("relative\\dir"))).rejects.toBeInstanceOf(BadRequestError);
    await expect(a.adopt(vhReq(join(root, "missing")))).rejects.toBeInstanceOf(BadRequestError);
    const file = join(root, "afile"); writeFileSync(file, "x");
    await expect(a.adopt(vhReq(file))).rejects.toBeInstanceOf(BadRequestError);
    await expect(a.adopt(vhReq(valheimFolder() + '"'))).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects a folder that fails inspection", async () => {
    await expect(adopter().adopt(vhReq(mkFolder("empty")))).rejects.toBeInstanceOf(BadRequestError);
  });

  it("rejects a folder already managed (case/trailing-slash insensitive)", async () => {
    const f = valheimFolder();
    await adopter().adopt(vhReq(f));
    const variant = (process.platform === "win32" ? f.toUpperCase() : f) + "\\";
    await expect(adopter().adopt({ ...vhReq(f), name: "other", folder: variant })).rejects.toThrow(/Folder already managed by friends/);
    await expect(adopter().adopt({ ...vhReq(f), name: "other" })).rejects.toBeInstanceOf(BadRequestError);
  });

  describe("world import", () => {
    let src: string;
    beforeEach(() => {
      src = worldsDir("alice");
      writeFileSync(join(src, "Dedicated.fwl"), "FWL"); writeFileSync(join(src, "Dedicated.db"), "DB");
    });

    it("copies both files, keeps originals, sets launch.world (by name)", async () => {
      const f = valheimFolder();
      const rec = await adopter().adopt(vhReq(f, { importWorldFrom: "Dedicated", launch: { ...vhReq(f).launch, world: "other" } }));
      const dest = join(f, "saves", "worlds_local");
      expect(readFileSync(join(dest, "Dedicated.fwl"), "utf8")).toBe("FWL");
      expect(readFileSync(join(dest, "Dedicated.db"), "utf8")).toBe("DB");
      expect(existsSync(join(src, "Dedicated.fwl"))).toBe(true);
      expect(rec.launch.world).toBe("Dedicated");
    });

    it("accepts a fwlPath from the scan", async () => {
      const f = valheimFolder();
      await adopter().adopt(vhReq(f, { importWorldFrom: join(src, "Dedicated.fwl") }));
      expect(existsSync(join(f, "saves", "worlds_local", "Dedicated.db"))).toBe(true);
    });

    it("rejects an arbitrary path or unknown name", async () => {
      const f = valheimFolder();
      const evil = join(root, "evil.fwl"); writeFileSync(evil, "x"); writeFileSync(join(root, "evil.db"), "x");
      await expect(adopter().adopt(vhReq(f, { importWorldFrom: evil }))).rejects.toBeInstanceOf(BadRequestError);
      await expect(adopter().adopt(vhReq(f, { importWorldFrom: "Nope" }))).rejects.toBeInstanceOf(BadRequestError);
      expect(repo.list()).toHaveLength(0);
    });

    it("refuses to overwrite an existing world and leaves it untouched", async () => {
      const f = valheimFolder();
      const dest = join(f, "saves", "worlds_local"); mkdirSync(dest, { recursive: true });
      writeFileSync(join(dest, "Dedicated.db"), "MINE");
      await expect(adopter().adopt(vhReq(f, { importWorldFrom: "Dedicated" }))).rejects.toBeInstanceOf(BadRequestError);
      expect(readFileSync(join(dest, "Dedicated.db"), "utf8")).toBe("MINE");
      expect(existsSync(join(dest, "Dedicated.fwl"))).toBe(false);
    });

    it("removes copied world files when a later step fails", async () => {
      const f = valheimFolder();
      await expect(adopter({ acl: async () => { throw new Error("acl boom"); } }).adopt(vhReq(f, { importWorldFrom: "Dedicated" }))).rejects.toThrow("acl boom");
      expect(existsSync(join(f, "saves", "worlds_local", "Dedicated.fwl"))).toBe(false);
      expect(existsSync(join(f, "saves", "worlds_local", "Dedicated.db"))).toBe(false);
      expect(repo.list()).toHaveLength(0);
    });
  });

  it("rolls back the record and removes firewall rules when firewall fails", async () => {
    const f = valheimFolder();
    await expect(adopter({ firewall: async () => { throw new Error("fw boom"); } }).adopt(vhReq(f))).rejects.toThrow("fw boom");
    expect(repo.list()).toHaveLength(0);
    expect(rmCalls).toEqual(["friends"]);
  });

  it("rolls back when ACL fails", async () => {
    await expect(adopter({ acl: async () => { throw new Error("acl boom"); } }).adopt(vhReq(valheimFolder()))).rejects.toThrow("acl boom");
    expect(repo.list()).toHaveLength(0);
  });

  describe("minecraft eula", () => {
    const req = (f: string, extra = {}) => ({
      game: "minecraft" as const, name: "mc", folder: f,
      launch: { jar: "server.jar", javaPath: "java", memoryMb: 4096, jvmArgs: "", port: 25565, rconPort: 25575 }, ...extra,
    });
    it("writes eula=true only when accepted", async () => {
      const a = mkFolder("mc1", { "server.jar": "x" });
      await adopter().adopt(req(a, { acceptEula: true }));
      expect(readFileSync(join(a, "eula.txt"), "utf8")).toContain("eula=true");
      const b = mkFolder("mc2", { "server.jar": "x" });
      await adopter().adopt({ ...req(b), name: "mc2" });
      expect(existsSync(join(b, "eula.txt"))).toBe(false);
    });
    it("preserves comments in an existing eula.txt", async () => {
      const a = mkFolder("mc3", { "server.jar": "x", "eula.txt": "#By changing the setting\n#Mon\neula=false\n" });
      await adopter().adopt(req(a, { acceptEula: true }));
      expect(readFileSync(join(a, "eula.txt"), "utf8")).toBe("#By changing the setting\n#Mon\neula=true\n");
    });
  });
});

describe("Adopter folder guard", () => {
  it("rejects protected folders", async () => {
    const mk = (...p: string[]) => { const d = join(root, ...p); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "valheim_server.exe"), "x"); return d; };
    const bad = [
      parse(root).root,
      mk("Windows"), mk("Windows", "System32"),
      mk("PF"), mk("PF86"), mk("PD"), mk("PD", "Skali"), mk("PD", "Skali", "data"),
      mk("Install"), mk("Install", "bin"),
      users, mk("Users", "alice"),
    ];
    for (const f of bad) await expect(adopter().adopt(vhReq(f)), f).rejects.toBeInstanceOf(BadRequestError);
    expect(repo.list()).toHaveLength(0);
  });
  it("allows subfolders of a user profile, Program Files and ProgramData", async () => {
    const dirs = [["Users", "alice", "games"], ["PF", "Valheim"], ["PD", "games"]];
    for (const [i, p] of dirs.entries()) {
      const d = join(root, ...p!); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "valheim_server.exe"), "x");
      await adopter().adopt({ ...vhReq(d), name: "ok" + i });
    }
  });
  it("serializes concurrent adopts of the same folder", async () => {
    const f = valheimFolder();
    const a = adopter();
    const res = await Promise.allSettled([a.adopt(vhReq(f)), a.adopt({ ...vhReq(f), name: "second" })]);
    expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(repo.list()).toHaveLength(1);
  });
  it("removes saves dirs created by a failed adopt but keeps pre-existing ones", async () => {
    const src = worldsDir("alice");
    writeFileSync(join(src, "Dedicated.fwl"), "F"); writeFileSync(join(src, "Dedicated.db"), "D");
    const boom = { acl: async () => { throw new Error("boom"); } };
    const f1 = valheimFolder("v1");
    await expect(adopter(boom).adopt(vhReq(f1, { importWorldFrom: "Dedicated" }))).rejects.toThrow("boom");
    expect(existsSync(join(f1, "saves"))).toBe(false);
    const f2 = valheimFolder("v2");
    mkdirSync(join(f2, "saves"));
    await expect(adopter(boom).adopt(vhReq(f2, { importWorldFrom: "Dedicated" }))).rejects.toThrow("boom");
    expect(existsSync(join(f2, "saves"))).toBe(true);
    expect(existsSync(join(f2, "saves", "worlds_local"))).toBe(false);
  });
});

describe("Adopter.remove", () => {
  const st = (status: string) => ({ status, crashPaused: false }) as never;
  it("refuses while running, removes firewall rules and record when stopped, never touches files", async () => {
    const f = valheimFolder();
    const a = adopter();
    const rec = await a.adopt(vhReq(f));
    await expect(a.remove(rec.id, st("running"))).rejects.toBeInstanceOf(ConflictError);
    expect(repo.list()).toHaveLength(1);
    await a.remove(rec.id, st("crashed"));
    expect(repo.list()).toHaveLength(0);
    expect(rmCalls).toEqual(["friends"]);
    expect(existsSync(join(f, "valheim_server.exe"))).toBe(true);
  });
  it("refuses a stopped server that still tracks a pid", async () => {
    const a = adopter();
    const rec = await a.adopt(vhReq(valheimFolder()));
    repo.update(rec.id, { pid: 42, pidStartTime: "2026-01-01T00:00:00.000Z" });
    const err = await a.remove(rec.id, { status: "stopped", crashPaused: false, detail: "Forced stop failed: denied" }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err.message).toBe("Forced stop failed: denied");
    await expect(a.remove(rec.id, st("stopped"))).rejects.toThrow("The previous process may still be running; stop it first");
    expect(repo.list()).toHaveLength(1);
    expect(rmCalls).toEqual([]);
  });
  it("re-checks state after the firewall step and restores the rules when a start slipped in", async () => {
    let release!: () => void;
    const a = adopter({ removeFirewall: async (n) => { rmCalls.push(n); await new Promise<void>((r) => { release = r; }); } });
    const rec = await a.adopt(vhReq(valheimFolder()));
    fwCalls = [];
    let status = "stopped";
    const p = a.remove(rec.id, () => st(status));
    await new Promise((r) => setTimeout(r, 10));
    status = "starting";
    release();
    await expect(p).rejects.toBeInstanceOf(ConflictError);
    expect(repo.list()).toHaveLength(1);
    expect(fwCalls).toEqual(["friends"]);
  });
});
