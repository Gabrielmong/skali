import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "../../src/errors.js";
import { basic } from "../../src/games/basic.js";
import { getAdapter, listGames } from "../../src/games/registry.js";
import { startFakeA2S, type FakeA2S } from "../fakes/a2s-server.js";
import { startFakeRcon, type FakeRcon } from "../fakes/rcon-server.js";
import { rec, tmpFolder, touch } from "./helpers.js";

let a2s: FakeA2S | null = null;
let rcon: FakeRcon | null = null;
afterEach(async () => { await a2s?.close(); await rcon?.close(); a2s = null; rcon = null; });

describe("basic adapter", () => {
  it("inspectFolder picks ConanSandboxServer.exe over UnityCrashHandler64.exe", async () => {
    const f = tmpFolder();
    touch(path.join(f, "UnityCrashHandler64.exe"), "x".repeat(5000));
    touch(path.join(f, "vcredist_x64.exe"), "x".repeat(9000));
    touch(path.join(f, "ConanSandboxServer.exe"), "x");
    const r = await basic.inspectFolder(f);
    expect(r.ok && r.exe).toBe("ConanSandboxServer.exe");
    expect(r.ok && r.launch.exe).toBe("ConanSandboxServer.exe");
  });
  it("falls back to the largest exe; fails with none", async () => {
    const f = tmpFolder();
    expect((await basic.inspectFolder(f)).ok).toBe(false);
    touch(path.join(f, "a.exe"), "x");
    touch(path.join(f, "b.exe"), "xxxx");
    touch(path.join(f, "uninstall.exe"), "x".repeat(100));
    const r = await basic.inspectFolder(f);
    expect(r.ok && r.exe).toBe("b.exe");
  });
  it("builds launch and ports", () => {
    const s = rec("basic", "C:\\g", { exe: "bin\\srv.exe", args: '-a "b c"', ports: "27015/udp, 27016/tcp" });
    const l = basic.buildLaunch(s);
    expect(l.exe).toBe(path.resolve("C:\\g", "bin\\srv.exe"));
    expect(l.args).toEqual(["-a", "b c"]);
    expect(l.cwd).toBe("C:\\g");
    expect(basic.ports(s).map((p) => [p.port, p.protocol, p.forward])).toEqual([[27015, "udp", true], [27016, "tcp", true]]);
    expect(basic.ready).toEqual({ kind: "none" });
    expect(basic.defaultStopTimeoutSec).toBe(60);
  });
  it("validates the launch", () => {
    expect(basic.validateLaunch("n", {})).not.toEqual([]);
    expect(basic.validateLaunch("n", { exe: "a.exe", ports: "bogus" })).not.toEqual([]);
    expect(basic.validateLaunch("n", { exe: "a.exe", ports: "1/udp" })).toEqual([]);
  });
  it("range-checks query and rcon ports", () => {
    expect(basic.validateLaunch("n", { exe: "a.exe", queryPort: 70000 })).not.toEqual([]);
    expect(basic.validateLaunch("n", { exe: "a.exe", rconPort: 0 })).not.toEqual([]);
    expect(basic.validateLaunch("n", { exe: "a.exe", rconPort: 1.5 })).not.toEqual([]);
    expect(basic.validateLaunch("n", { exe: "a.exe", queryPort: 27015, rconPort: 25575 })).toEqual([]);
    expect(basic.hasCommandsFor(rec("basic", "C:\\g", { rconPort: 99999, rconPassword: "pw" }))).toBe(false);
  });
  it("stop is Ctrl+C", async () => {
    const ctrlC = vi.fn(async () => {});
    await basic.stop(rec("basic", "C:\\g", {}), { ctrlC });
    expect(ctrlC).toHaveBeenCalled();
  });
  it("commands need rcon port and password", async () => {
    const none = rec("basic", "C:\\g", {});
    expect(basic.hasCommandsFor(none)).toBe(false);
    expect(basic.hasCommandsFor(rec("basic", "C:\\g", { rconPort: 1 }))).toBe(false);
    await expect(basic.command!(none, "x")).rejects.toBeInstanceOf(BadRequestError);
    await expect(basic.command!(none, "x")).rejects.toThrow("RCON is not configured for this server");
    rcon = await startFakeRcon({ password: "pw" });
    const s = rec("basic", "C:\\g", { rconPort: rcon.port, rconPassword: "pw" });
    expect(basic.hasCommandsFor(s)).toBe(true);
    expect(await basic.command!(s, "status")).toBe("reply:status");
  });
  it("players use A2S on queryPort", async () => {
    expect(await basic.players(rec("basic", "C:\\g", {}))).toBeNull();
    a2s = await startFakeA2S({ players: 4, maxPlayers: 12 });
    expect(await basic.players(rec("basic", "C:\\g", { queryPort: a2s.port }))).toEqual({ online: 4, max: 12 });
  });
});

describe("registry", () => {
  it("returns adapters and game infos", () => {
    expect(getAdapter("palworld").info.id).toBe("palworld");
    expect(listGames().map((g) => g.id).sort()).toEqual(["basic", "minecraft", "palworld", "valheim"]);
    expect(basic.info.hasCommands).toBe(false);
  });
});
