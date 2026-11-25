import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { valheim } from "../../src/games/valheim.js";
import { startFakeA2S, type FakeA2S } from "../fakes/a2s-server.js";
import { rec } from "./helpers.js";

let fake: FakeA2S | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

describe("valheim adapter", () => {
  it("builds the default launch", () => {
    const s = rec("valheim", "C:\\v", { name: "My Srv", port: 2456, world: "Dedicated", password: "secret1", public: true, crossplay: false, extraArgs: "" });
    const l = valheim.buildLaunch(s);
    expect(l.exe).toBe(path.join("C:\\v", "valheim_server.exe"));
    expect(l.cwd).toBe("C:\\v");
    expect(l.env).toEqual({ SteamAppId: "892970" });
    expect(l.args).toEqual([
      "-nographics", "-batchmode", "-name", "My Srv", "-port", "2456", "-world", "Dedicated",
      "-password", "secret1", "-public", "1", "-savedir", path.join("C:\\v", "saves"), "-logFile", "-",
    ]);
  });
  it("falls back to the record name when launch.name is empty", () => {
    const s = rec("valheim", "C:\v", { name: "", password: "secret1" }, {}, "Rec Name");
    const a = valheim.buildLaunch(s).args;
    expect(a[a.indexOf("-name") + 1]).toBe("Rec Name");
  });
  it("adds crossplay and extra args, public 0", () => {
    const s = rec("valheim", "C:\\v", { name: "n", port: 3000, world: "W", password: "secret1", public: false, crossplay: true, extraArgs: '-x "a b"' });
    const a = valheim.buildLaunch(s).args;
    expect(a).toContain("-crossplay");
    expect(a.slice(-2)).toEqual(["-x", "a b"]);
    expect(a[a.indexOf("-public") + 1]).toBe("0");
  });
  it("validates passwords", () => {
    expect(valheim.validateLaunch("srv", { password: "abc" })).not.toEqual([]);
    expect(valheim.validateLaunch("myserver", { password: "MyServer1" })).not.toEqual([]);
    expect(valheim.validateLaunch("srv", { password: "hunter22" })).toEqual([]);
  });
  it("checks the password against the launch name that -name receives", () => {
    expect(valheim.validateLaunch("Record", { name: "Viking", password: "myviking1" })).not.toEqual([]);
    expect(valheim.validateLaunch("Record", { name: "Viking", password: "myrecord1" })).toEqual([]);
    expect(valheim.validateLaunch("Record", { password: "myrecord1" })).not.toEqual([]);
  });
  it("has the spec ports, stop and no commands", async () => {
    const s = rec("valheim", "C:\\v", { port: 2456 });
    expect(valheim.ports(s).map((p) => [p.port, p.protocol, p.forward])).toEqual([[2456, "udp", true], [2457, "udp", true], [2458, "udp", true]]);
    const ctrlC = vi.fn(async () => {});
    await valheim.stop(s, { ctrlC });
    expect(ctrlC).toHaveBeenCalled();
    expect(valheim.command).toBeNull();
    expect(valheim.hasCommandsFor(s)).toBe(false);
    expect(valheim.defaultStopTimeoutSec).toBe(90);
    expect(valheim.ready).toEqual({ kind: "pattern", pattern: /Game server connected/ });
  });
  it("reads players from A2S on port+1", async () => {
    fake = await startFakeA2S({ players: 3, maxPlayers: 10 });
    const s = rec("valheim", "C:\\v", { port: fake.port - 1 });
    expect(await valheim.players(s)).toEqual({ online: 3, max: 10 });
  });
  it("exposes install metadata", () => {
    expect(valheim.steamAppId).toBe(896660);
    expect(valheim.installDefaults()).toEqual({ port: 2456, world: "Dedicated", public: true, crossplay: false, extraArgs: "" });
    expect(valheim.saveLocations(rec("valheim", "C:\v"))).toEqual([path.join("C:\v", "saves")]);
  });
});
