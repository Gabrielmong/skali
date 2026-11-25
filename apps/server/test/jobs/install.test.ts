import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InstallRequest, RuntimeState } from "@skali/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigHistory } from "../../src/config/history.js";
import { ConfigService } from "../../src/config/service.js";
import { ConfigSourcesRepo } from "../../src/config/sources-repo.js";
import { openDb, type Db } from "../../src/db.js";
import { getAdapter } from "../../src/games/registry.js";
import { Installer, type InstallerDeps } from "../../src/jobs/install.js";
import { JobRunner, LOGIN_NEEDED } from "../../src/jobs/runner.js";
import { Adopter } from "../../src/servers/adopt.js";
import { ServerRepo } from "../../src/servers/repo.js";
import { SettingsStore } from "../../src/settings.js";
import { SteamCmdError } from "../../src/tools/steamcmd.js";

const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const PAL_EXE = path.join("Pal", "Binaries", "Win64", "PalServer-Win64-Shipping-Cmd.exe");
const PAL_INI = path.join("Pal", "Saved", "Config", "WindowsServer", "PalWorldSettings.ini");
const JAVA_EXE = "C:\\ProgramData\\Skali\\tools\\java\\21\\bin\\java.exe";
const JAR = Buffer.from("fake jar bytes");

let root: string, db: Db, repo: ServerRepo, runner: JobRunner, settings: SettingsStore, config: ConfigService;
let steamCmd: { ensure: ReturnType<typeof vi.fn>; appUpdate: ReturnType<typeof vi.fn> };
let java: { ensure: ReturnType<typeof vi.fn> };
let mc: { resolve: ReturnType<typeof vi.fn> };
let acl: ReturnType<typeof vi.fn>, firewall: ReturnType<typeof vi.fn>, probe: ReturnType<typeof vi.fn>;
let fetchFn: ReturnType<typeof vi.fn>;
let installer: Installer;
const stopped: RuntimeState = { status: "stopped", crashPaused: false };

/** Fake SteamCMD: lays down what the real app would, per app id. */
function installFiles(folder: string, appId: number): void {
  fs.mkdirSync(folder, { recursive: true });
  if (appId === 2394010) {
    fs.mkdirSync(path.join(folder, path.dirname(PAL_EXE)), { recursive: true });
    fs.writeFileSync(path.join(folder, PAL_EXE), "exe");
    fs.copyFileSync(path.join(FIXTURES, "DefaultPalWorldSettings.ini"), path.join(folder, "DefaultPalWorldSettings.ini"));
  } else if (appId === 896660) {
    fs.writeFileSync(path.join(folder, "valheim_server.exe"), "exe");
  } else {
    fs.writeFileSync(path.join(folder, "GameServer.exe"), "exe");
    fs.writeFileSync(path.join(folder, "UnityCrashHandler64.exe"), "exe");
  }
}

function deps(over: Partial<InstallerDeps> = {}): InstallerDeps {
  return {
    repo, runner, adapter: getAdapter, steamCmd: steamCmd as never, java: java as never, mc: mc as never,
    settings, configService: config, gamesUser: "skali-games",
    acl: acl as never, firewall: firewall as never, probe: probe as never,
    protectedPaths: { dataDir: null }, fetch: fetchFn as never,
    ...over,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-install-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, Buffer.alloc(32, 7));
  settings = new SettingsStore(db, ["127.0.0.1"]);
  runner = new JobRunner({ repo, logsDir: path.join(root, "logs"), emit: () => {}, changed: () => {} });
  config = new ConfigService({
    repo, sources: new ConfigSourcesRepo(db), history: new ConfigHistory(path.join(root, "hist")),
    adapterOf: getAdapter, runtimeState: () => stopped, now: () => new Date().toISOString(),
  });
  steamCmd = {
    ensure: vi.fn(async () => undefined),
    appUpdate: vi.fn(async (folder: string, appId: number) => installFiles(folder, appId)),
  };
  java = { ensure: vi.fn(async () => JAVA_EXE) };
  mc = {
    resolve: vi.fn(async () => ({
      url: "https://piston-data.mojang.com/server.jar",
      sha1: crypto.createHash("sha1").update(JAR).digest("hex"),
      javaMajor: 21,
    })),
  };
  fetchFn = vi.fn(async () => new Response(JAR, { headers: { "content-length": String(JAR.length) } }));
  acl = vi.fn(async () => undefined);
  firewall = vi.fn(async () => undefined);
  probe = vi.fn(async () => true);
  installer = new Installer(deps());
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const done = (id: string) => vi.waitFor(() => expect(runner.isRunning(id)).toBe(false));
const pal = (over: Partial<InstallRequest> = {}): InstallRequest => ({
  game: "palworld", name: "Pal", folder: path.join(root, "games", "Pal"), launch: { port: 8211 },
  palworld: { serverName: "My server", serverPassword: "hunter22", maxPlayers: 16 }, ...over,
});

describe("Installer.install validation", () => {
  const nothingCreated = (folder: string) => {
    expect(repo.list()).toEqual([]);
    expect(fs.existsSync(folder)).toBe(false);
  };

  it("rejects a non-empty folder", async () => {
    const folder = path.join(root, "full");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "x.txt"), "x");
    await expect(installer.install(pal({ folder }))).rejects.toThrow("The install folder must be new or empty");
    expect(repo.list()).toEqual([]);
  });

  it("rejects a bad name", async () => {
    const req = pal({ name: "bad/name" });
    await expect(installer.install(req)).rejects.toThrow("Name may only contain");
    nothingCreated(req.folder);
  });

  it("rejects a used name", async () => {
    repo.create({ name: "pal", game: "valheim", folder: path.join(root, "other"), launch: {}, stopTimeoutSec: 60 });
    const req = pal();
    await expect(installer.install(req)).rejects.toThrow("Name already used");
    expect(repo.list()).toHaveLength(1);
    expect(fs.existsSync(req.folder)).toBe(false);
  });

  it("rejects a port clash with another server and with the PC", async () => {
    repo.create({ name: "Other", game: "palworld", folder: path.join(root, "other"), launch: { port: 8211, restPort: 9000 }, stopTimeoutSec: 60 });
    const req = pal();
    await expect(installer.install(req)).rejects.toThrow("Port 8211/udp: Used by Other");
    expect(repo.list()).toHaveLength(1);
    expect(fs.existsSync(req.folder)).toBe(false);

    probe.mockImplementation(async (port: number) => port !== 8212);
    const req2 = pal({ name: "Pal2", folder: path.join(root, "games", "Pal2"), launch: { port: 8300 } });
    await expect(installer.install(req2)).rejects.toThrow("Port 8212/tcp: Something on this PC is already using it");
    expect(fs.existsSync(req2.folder)).toBe(false);
  });

  it("rejects a Minecraft install without the EULA", async () => {
    const req: InstallRequest = {
      game: "minecraft", name: "Mc", folder: path.join(root, "mc"), launch: {}, minecraft: { flavour: "vanilla", version: "1.21.4" },
    };
    await expect(installer.install(req)).rejects.toThrow("Accept the Minecraft EULA to continue");
    await expect(installer.install({ ...req, acceptEula: false })).rejects.toThrow("Accept the Minecraft EULA to continue");
    nothingCreated(req.folder);
    expect(mc.resolve).not.toHaveBeenCalled();
  });

  it("rejects basic without an app id, invalid launch values, and a protected folder", async () => {
    const folder = path.join(root, "b");
    await expect(installer.install({ game: "basic", name: "B", folder, launch: {} })).rejects.toThrow("Steam app ID");
    await expect(installer.install(pal({ palworld: { serverName: "x", serverPassword: "", maxPlayers: 99 } }))).rejects.toThrow("Max players must be between 1 and 32");
    await expect(installer.install(pal({ folder: "relative\\x" }))).rejects.toThrow("Folder must be an absolute path");
    nothingCreated(folder);
  });
});

describe("Palworld essentials limits", () => {
  it.each([
    [{ serverName: "x".repeat(129), serverPassword: "" }, /Server name/],
    [{ serverName: "a\nb", serverPassword: "" }, /Server name/],
    [{ serverName: "ok", serverPassword: "p".repeat(129) }, /password/],
    [{ serverName: "ok", serverPassword: "a\u0000b" }, /password/],
  ])("rejects %j", async (p, re) => {
    const req = pal({ palworld: { ...p, maxPlayers: 16 } });
    await expect(installer.install(req)).rejects.toThrow(re);
    expect(repo.list()).toEqual([]);
    expect(fs.existsSync(req.folder)).toBe(false);
  });
});

describe("Installer.install", () => {
  it("palworld install runs steps in order, seeds the ini, drops the install password", async () => {
    const order: string[] = [];
    steamCmd.ensure.mockImplementation(async () => void order.push("steamcmd"));
    steamCmd.appUpdate.mockImplementation(async (folder: string, appId: number) => {
      order.push("files");
      installFiles(folder, appId);
    });
    acl.mockImplementation(async () => void order.push("acl"));
    firewall.mockImplementation(async () => void order.push("firewall"));

    const req = pal();
    const rec = await installer.install(req);
    expect(rec.createdFolder).toBe(true);
    expect(rec.steamAppId).toBe(2394010);
    expect(rec.job?.state).toBe("running");
    expect(rec.job?.steps.map((s) => s.id)).toEqual(["steamcmd", "files", "config", "permissions", "firewall"]);
    expect(rec.job?.steps.map((s) => s.label)).toEqual(["Get SteamCMD", "Download game files", "Write settings", "Folder permissions", "Firewall rules"]);
    expect(JSON.stringify(rec.job?.params)).not.toContain("hunter22");
    expect(fs.existsSync(req.folder)).toBe(true);
    await done(rec.id);

    expect(order).toEqual(["steamcmd", "files", "acl", "firewall"]);
    const after = repo.get(rec.id);
    expect(after.job).toBeNull();
    expect(after.launch.players).toBe(16);
    expect(after.secrets.installServerPassword).toBeUndefined();
    const ini = fs.readFileSync(path.join(req.folder, PAL_INI), "utf8");
    expect(ini).toContain('ServerName="My server"');
    expect(ini).toContain('ServerPassword="hunter22"');
    expect(ini).toMatch(/ServerPlayerMaxNum=16\b/);
    expect(steamCmd.appUpdate).toHaveBeenCalledWith(path.resolve(req.folder), 2394010, expect.anything());
    expect(acl).toHaveBeenCalledWith(path.resolve(req.folder), "skali-games");
    expect(firewall).toHaveBeenCalledWith("Pal", getAdapter("palworld").ports(after));
    const logs = fs.readdirSync(path.join(root, "logs", rec.id)).map((r) => fs.readFileSync(path.join(root, "logs", rec.id, r, "console.log"), "utf8")).join("");
    expect(logs).not.toContain("hunter22");
  });

  it("fails the files step when the server program is missing after install", async () => {
    steamCmd.appUpdate.mockImplementation(async () => undefined);
    const rec = await installer.install(pal());
    await done(rec.id);
    const job = repo.get(rec.id).job!;
    expect(job.state).toBe("failed");
    expect(job.error).toBe("Server program not found after install");
    expect(job.steps.map((s) => s.state)).toEqual(["done", "failed", "pending", "pending", "pending"]);
  });

  it("skips the acl step without a games user", async () => {
    installer = new Installer(deps({ gamesUser: null }));
    const rec = await installer.install(pal());
    await done(rec.id);
    expect(repo.get(rec.id).job).toBeNull();
    expect(acl).not.toHaveBeenCalled();
  });

  it("valheim install sets steamAppId and launch values from the request", async () => {
    const rec = await installer.install({
      game: "valheim", name: "Viking", folder: path.join(root, "vh"),
      launch: { world: "Midgard", password: "s3cret!", public: false },
    });
    expect(rec.steamAppId).toBe(896660);
    expect(rec.launch).toMatchObject({ world: "Midgard", password: "s3cret!", public: false, port: 2456, crossplay: false });
    await done(rec.id);
    expect(repo.get(rec.id).job).toBeNull();
    expect(steamCmd.appUpdate).toHaveBeenCalledWith(expect.any(String), 896660, expect.anything());
  });

  it("minecraft install writes the eula, the verified jar, and launch values", async () => {
    const folder = path.join(root, "mc");
    const rec = await installer.install({
      game: "minecraft", name: "Mc", folder, launch: { memoryMb: 6144 }, acceptEula: true,
      minecraft: { flavour: "vanilla", version: "1.21.4" },
    });
    expect(rec.job?.steps.map((s) => [s.id, s.label])).toEqual([
      ["java", "Get Java 21"], ["files", "Download server jar"], ["config", "Write settings"],
      ["permissions", "Folder permissions"], ["firewall", "Firewall rules"],
    ]);
    await done(rec.id);
    const after = repo.get(rec.id);
    expect(after.job).toBeNull();
    expect(after.steamAppId).toBeNull();
    expect(after.launch).toMatchObject({ jar: "server.jar", javaPath: JAVA_EXE, mcFlavour: "vanilla", mcVersion: "1.21.4", memoryMb: 6144 });
    expect(after.launch.paperBuild).toBeUndefined();
    expect(fs.readFileSync(path.join(folder, "eula.txt"), "utf8")).toMatch(/^eula=true/m);
    expect(fs.readFileSync(path.join(folder, "server.jar"))).toEqual(JAR);
    const props = fs.readFileSync(path.join(folder, "server.properties"), "utf8");
    expect(props).toMatch(/^server-port=25565$/m);
    expect(props).toMatch(/^rcon\.port=25575$/m);
    expect(mc.resolve).toHaveBeenCalledWith("vanilla", "1.21.4");
    expect(java.ensure).toHaveBeenCalledWith(21, expect.any(Function));
    expect(steamCmd.appUpdate).not.toHaveBeenCalled();
  });

  it("paper install records the build; a checksum mismatch fails the files step", async () => {
    mc.resolve.mockResolvedValue({ url: "https://fill-data.papermc.io/paper.jar", sha256: "00".repeat(32), javaMajor: 21, build: 123 });
    const folder = path.join(root, "paper");
    const rec = await installer.install({
      game: "minecraft", name: "Paper", folder, launch: {}, acceptEula: true, minecraft: { flavour: "paper", version: "1.21.4" },
    });
    expect(rec.launch).toMatchObject({ mcFlavour: "paper", mcVersion: "1.21.4", paperBuild: 123 });
    await done(rec.id);
    const job = repo.get(rec.id).job!;
    expect(job.state).toBe("failed");
    expect(job.error).toMatch(/Checksum mismatch/);
    expect(fs.existsSync(path.join(folder, "server.jar"))).toBe(false);
  });

  it("basic install ends setupPending with the suggested exe and catalog ports", async () => {
    // 294420 (7 Days to Die) has no catalog ports; 376030 (ARK) has 7777/udp and 27015/udp.
    const rec = await installer.install({ game: "basic", name: "Ark", folder: path.join(root, "ark"), launch: {}, appId: 376030 });
    expect(rec.steamAppId).toBe(376030);
    expect(rec.job?.steps.map((s) => [s.id, s.label]).at(-1)).toEqual(["confirm", "Confirm server program"]);
    await done(rec.id);
    const after = repo.get(rec.id);
    expect(after.job).toBeNull();
    expect(after.setupPending).toBe(true);
    expect(after.launch.exe).toBe("GameServer.exe");
    expect(after.launch.ports).toBe("7777/udp, 27015/udp");
    expect(steamCmd.appUpdate).toHaveBeenCalledWith(expect.any(String), 376030, expect.anything());
  });
});

describe("failures and retry", () => {
  it("a SteamCmdError login fails the job with the login copy", async () => {
    steamCmd.appUpdate.mockRejectedValue(new SteamCmdError("login", "ERROR! Failed to install app '1' (No subscription)"));
    const rec = await installer.install({ game: "basic", name: "B", folder: path.join(root, "b"), launch: {}, appId: 1 });
    await done(rec.id);
    expect(repo.get(rec.id).job).toMatchObject({ state: "failed", error: LOGIN_NEEDED });
  });

  it("retry resumes at the failed step and re-checks ports", async () => {
    steamCmd.appUpdate.mockRejectedValueOnce(new Error("network down"));
    const rec = await installer.install(pal());
    await done(rec.id);
    expect(repo.get(rec.id).job).toMatchObject({ state: "failed", error: "network down" });
    expect(repo.get(rec.id).secrets.installServerPassword).toBe("hunter22");

    probe.mockResolvedValueOnce(false);
    await expect(installer.retry(rec.id)).rejects.toThrow("Port 8211/udp: Something on this PC is already using it");
    expect(repo.get(rec.id).job?.state).toBe("failed");

    await installer.retry(rec.id);
    await done(rec.id);
    expect(repo.get(rec.id).job).toBeNull();
    expect(steamCmd.ensure).toHaveBeenCalledTimes(1);
    expect(steamCmd.appUpdate).toHaveBeenCalledTimes(2);
    expect(fs.readFileSync(path.join(rec.folder, PAL_INI), "utf8")).toContain('ServerPassword="hunter22"');
    expect(repo.get(rec.id).secrets.installServerPassword).toBeUndefined();
  });

  /** Replaces the server folder with a junction to a folder elsewhere, as a games-user process could. */
  const swapForJunction = (folder: string): string => {
    const target = path.join(root, "elsewhere");
    fs.mkdirSync(target, { recursive: true });
    fs.rmSync(folder, { recursive: true, force: true });
    fs.symlinkSync(target, folder, "junction");
    return target;
  };

  it("retry refuses the permissions step when the server folder became a junction", async () => {
    acl.mockRejectedValueOnce(new Error("icacls failed"));
    const rec = await installer.install({ game: "valheim", name: "V", folder: path.join(root, "v"), launch: { password: "s3cret!" } });
    await done(rec.id);
    expect(repo.get(rec.id).job).toMatchObject({ state: "failed", error: "icacls failed" });
    expect(acl).toHaveBeenCalledTimes(1);

    swapForJunction(rec.folder);
    await installer.retry(rec.id);
    await done(rec.id);
    expect(repo.get(rec.id).job).toMatchObject({ state: "failed", error: expect.stringContaining("is a link (junction or symlink)") });
    expect(acl).toHaveBeenCalledTimes(1);
  });

  it("retry refuses the files step when the server folder became a junction", async () => {
    steamCmd.appUpdate.mockRejectedValueOnce(new Error("network down"));
    const rec = await installer.install({ game: "valheim", name: "V", folder: path.join(root, "v"), launch: { password: "s3cret!" } });
    await done(rec.id);
    const target = swapForJunction(rec.folder);
    await installer.retry(rec.id);
    await done(rec.id);
    expect(repo.get(rec.id).job).toMatchObject({ state: "failed", error: expect.stringContaining("is a link (junction or symlink)") });
    expect(steamCmd.appUpdate).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(target)).toEqual([]);
    expect(acl).not.toHaveBeenCalled();
  });

  it("refuses a minecraft files step through a junction server folder", async () => {
    java.ensure.mockRejectedValueOnce(new Error("network down"));
    const rec = await installer.install({
      game: "minecraft", name: "M", folder: path.join(root, "m"), launch: {}, acceptEula: true, minecraft: { flavour: "vanilla", version: "1.21.4" },
    });
    await done(rec.id);
    expect(repo.get(rec.id).job).toMatchObject({ state: "failed", error: "network down" });
    const target = swapForJunction(rec.folder);
    await installer.retry(rec.id);
    await done(rec.id);
    expect(repo.get(rec.id).job).toMatchObject({ state: "failed", error: expect.stringContaining("is a link (junction or symlink)") });
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it("retry is refused unless the job is a failed install", async () => {
    const plain = repo.create({ name: "Plain", game: "valheim", folder: path.join(root, "p"), launch: {}, stopTimeoutSec: 60 });
    await expect(installer.retry(plain.id)).rejects.toMatchObject({ name: "ConflictError" });
    let release!: () => void;
    steamCmd.appUpdate.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const rec = await installer.install(pal());
    await vi.waitFor(() => expect(steamCmd.appUpdate).toHaveBeenCalled());
    await expect(installer.retry(rec.id)).rejects.toMatchObject({ name: "ConflictError" });
    release();
    await done(rec.id);
  });
});

describe("remove", () => {
  const adopter = () => new Adopter({ repo, adapter: getAdapter, gamesUser: null, firewall: firewall as never, removeFirewall: vi.fn(async () => undefined) });

  it("remove while installing → 409", async () => {
    let release!: () => void;
    steamCmd.appUpdate.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    const rec = await installer.install(pal());
    await vi.waitFor(() => expect(steamCmd.appUpdate).toHaveBeenCalled());
    await expect(adopter().remove(rec.id, stopped)).rejects.toMatchObject({ name: "ConflictError" });
    expect(repo.get(rec.id)).toBeTruthy();
    release();
    await done(rec.id);
  });

  it("remove of a failed install returns the record", async () => {
    steamCmd.appUpdate.mockRejectedValueOnce(new Error("boom"));
    const rec = await installer.install(pal());
    await done(rec.id);
    const removed = await adopter().remove(rec.id, stopped);
    expect(removed).toMatchObject({ id: rec.id, createdFolder: true, job: { kind: "install", state: "failed" } });
    expect(repo.list()).toEqual([]);
  });
});
