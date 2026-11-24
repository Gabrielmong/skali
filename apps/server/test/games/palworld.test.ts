import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "../../src/errors.js";
import { palworld } from "../../src/games/palworld.js";
import type { ServerRecord } from "../../src/servers/repo.js";
import { parsePalworldIni } from "../../src/config-formats/palworld-options.js";
import { startFakePalworld, type FakePalworld } from "../fakes/palworld-rest-server.js";
import { rec, tmpFolder, touch } from "./helpers.js";

let fake: FakePalworld | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

const DEFAULT_INI = "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,ServerName=\"Default Palworld Server\",AdminPassword=\"\",RESTAPIEnabled=False,RESTAPIPort=8212)\n";
const iniPath = (f: string) => path.join(f, "Pal", "Saved", "Config", "WindowsServer", "PalWorldSettings.ini");

describe("palworld adapter", () => {
  it("builds the default launch", () => {
    const l = palworld.buildLaunch(rec("palworld", "C:\\p", { port: 8211, players: 32, perfFlags: true, restPort: 8212, extraArgs: "" }));
    expect(l.exe).toBe(path.join("C:\\p", "Pal", "Binaries", "Win64", "PalServer-Win64-Shipping-Cmd.exe"));
    expect(l.args).toEqual(["Pal", "-port=8211", "-players=32", "-useperfthreads", "-NoAsyncLoadingThread", "-UseMultithreadForDS"]);
  });
  it("omits perf flags and appends extra", () => {
    const l = palworld.buildLaunch(rec("palworld", "C:\\p", { port: 1, players: 5, perfFlags: false, extraArgs: "-a b" }));
    expect(l.args).toEqual(["Pal", "-port=1", "-players=5", "-a", "b"]);
  });
  it("lists ports", () => {
    const p = palworld.ports(rec("palworld", "C:\\p", { port: 8211, restPort: 8212 }));
    expect(p.map((x) => [x.port, x.protocol, x.forward])).toEqual([[8211, "udp", true], [8212, "tcp", false]]);
  });

  describe("prepare", () => {
    it("copies the default ini when missing, sets keys, idempotent, keeps password", async () => {
      const f = tmpFolder();
      touch(path.join(f, "DefaultPalWorldSettings.ini"), DEFAULT_INI);
      const s = rec("palworld", f, { restPort: 9000 });
      const r1 = await palworld.prepare(s);
      const pw = r1.secrets!.adminPassword!;
      expect(pw).toHaveLength(24);
      const doc = parsePalworldIni(fs.readFileSync(iniPath(f), "utf8"));
      expect(doc.get("RESTAPIEnabled")).toBe("True");
      expect(doc.get("RESTAPIPort")).toBe("9000");
      expect(doc.get("AdminPassword")).toBe(`"${pw}"`);
      expect(doc.get("Difficulty")).toBe("None");
      const first = fs.readFileSync(iniPath(f));
      const r2 = await palworld.prepare({ ...s, secrets: r1.secrets! });
      expect(r2.secrets!.adminPassword).toBe(pw);
      expect(fs.readFileSync(iniPath(f)).equals(first)).toBe(true);
    });
    it("copies the default when the existing ini is empty", async () => {
      const f = tmpFolder();
      touch(path.join(f, "DefaultPalWorldSettings.ini"), DEFAULT_INI);
      touch(iniPath(f), "");
      await palworld.prepare(rec("palworld", f, {}));
      expect(parsePalworldIni(fs.readFileSync(iniPath(f), "utf8")).get("RESTAPIEnabled")).toBe("True");
      expect(parsePalworldIni(fs.readFileSync(iniPath(f), "utf8")).get("RESTAPIPort")).toBe("8212");
    });
    it("reports a malformed ini as BadRequest", async () => {
      const f = tmpFolder();
      touch(path.join(f, "DefaultPalWorldSettings.ini"), DEFAULT_INI);
      touch(iniPath(f), "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(Difficulty=None,\n");
      const err = await palworld.prepare(rec("palworld", f, {})).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestError);
      expect(err.message).toContain("PalWorldSettings.ini is malformed");
    });
    it("fails clearly without a default ini", async () => {
      await expect(palworld.prepare(rec("palworld", tmpFolder(), {}))).rejects.toBeInstanceOf(BadRequestError);
    });
  });

  describe("with REST", () => {
    it("parses commands", async () => {
      fake = await startFakePalworld("pw");
      const s = rec("palworld", "C:\\p", { restPort: fake.port }, { adminPassword: "pw" });
      await palworld.command!(s, "announce hello world");
      const post = fake.requests.find((r) => r.method === "POST")!;
      expect(post.url).toBe("/v1/api/announce");
      expect(JSON.parse(post.body)).toEqual({ message: "hello world" });
      const help = await palworld.command!(s, "foo");
      expect(help).toBe(palworld.info.commandHelp);
      expect(await palworld.command!(s, "help")).toBe(palworld.info.commandHelp);
      expect(await palworld.command!(s, "players")).toContain("steam_1");
    });
    it("probe and players", async () => {
      fake = await startFakePalworld("pw");
      const s = rec("palworld", "C:\\p", { restPort: fake.port }, { adminPassword: "pw" });
      const probe = (palworld.ready as { kind: "probe"; probe: (r: ServerRecord) => Promise<boolean> }).probe;
      expect(await probe(s)).toBe(true);
      expect(await palworld.players(s)).toEqual({ online: 2, max: 16 });
      const bad = rec("palworld", "C:\\p", { restPort: fake.port }, { adminPassword: "wrong" });
      expect(await probe(bad)).toBe(false);
      expect(await palworld.players(bad)).toBeNull();
    });
    it("stop saves then shuts down", async () => {
      fake = await startFakePalworld("pw");
      const s = rec("palworld", "C:\\p", { restPort: fake.port }, { adminPassword: "pw" });
      const ctrlC = vi.fn(async () => {});
      await palworld.stop(s, { ctrlC });
      expect(fake.requests.filter((r) => r.method === "POST").map((r) => r.url)).toEqual(["/v1/api/save", "/v1/api/shutdown"]);
      expect(ctrlC).not.toHaveBeenCalled();
    });
    it("stop falls back to Ctrl+C when REST rejects", async () => {
      fake = await startFakePalworld("pw");
      const s = rec("palworld", "C:\\p", { restPort: fake.port }, { adminPassword: "wrong" });
      const ctrlC = vi.fn(async () => {});
      await palworld.stop(s, { ctrlC });
      expect(ctrlC).toHaveBeenCalledTimes(1);
    });
  });
});
