import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BadRequestError } from "../../src/errors.js";
import { minecraft } from "../../src/games/minecraft.js";
import { parseProperties } from "../../src/config-formats/properties.js";
import { startFakeRcon, type FakeRcon } from "../fakes/rcon-server.js";
import { rec, tmpFolder, touch } from "./helpers.js";

let fake: FakeRcon | null = null;
afterEach(async () => { await fake?.close(); fake = null; });

describe("minecraft adapter", () => {
  it("keeps the bare 'java' in the launch; the supervisor resolves it against PATH", () => {
    const l = minecraft.buildLaunch(rec("minecraft", "C:\\m", { jar: "server.jar", javaPath: "java", memoryMb: 4096, jvmArgs: "" }));
    expect(l.exe).toBe("java");
    expect(l.cwd).toBe("C:\\m");
    expect(l.args).toEqual(["-Xms4096M", "-Xmx4096M", "-jar", "server.jar", "nogui"]);
  });
  it("includes jvmArgs between memory and -jar", () => {
    const l = minecraft.buildLaunch(rec("minecraft", "C:\\m", { jar: "p.jar", javaPath: "C:\\j\\java.exe", memoryMb: 2048, jvmArgs: "-XX:+UseG1GC" }));
    expect(l.exe).toBe("C:\\j\\java.exe");
    expect(l.args).toEqual(["-Xms2048M", "-Xmx2048M", "-XX:+UseG1GC", "-jar", "p.jar", "nogui"]);
  });
  it("inspectFolder prefers server.jar and notes missing eula", async () => {
    const f = tmpFolder();
    touch(path.join(f, "other.jar"));
    touch(path.join(f, "paper-1.21.jar"));
    touch(path.join(f, "server.jar"));
    const r = await minecraft.inspectFolder(f);
    expect(r.ok && r.launch.jar).toBe("server.jar");
    expect(r.ok && r.notes.length).toBe(1);
    touch(path.join(f, "eula.txt"), "eula=true\n");
    const r2 = await minecraft.inspectFolder(f);
    expect(r2.ok && r2.notes).toEqual([]);
  });
  it("inspectFolder falls back to paper then server-named jars, fails with none", async () => {
    const f = tmpFolder();
    expect((await minecraft.inspectFolder(f)).ok).toBe(false);
    touch(path.join(f, "a.jar"));
    touch(path.join(f, "paper-1.jar"));
    const r = await minecraft.inspectFolder(f);
    expect(r.ok && r.launch.jar).toBe("paper-1.jar");
  });

  describe("prepare", () => {
    it("requires the EULA", async () => {
      const f = tmpFolder();
      await expect(minecraft.prepare(rec("minecraft", f, {}))).rejects.toBeInstanceOf(BadRequestError);
      touch(path.join(f, "eula.txt"), "eula=false\n");
      await expect(minecraft.prepare(rec("minecraft", f, {}))).rejects.toThrow("Accept the Minecraft EULA first (server Overview)");
    });
    it("writes RCON keys, keeps other lines, is idempotent", async () => {
      const f = tmpFolder();
      touch(path.join(f, "eula.txt"), "#c\neula=true\n");
      const props = path.join(f, "server.properties");
      touch(props, "# comment\nmotd=Hello\nenable-rcon=false\n");
      const s = rec("minecraft", f, { port: 25570, rconPort: 25580 });
      const r1 = await minecraft.prepare(s);
      const pw = r1.secrets!.rconPassword!;
      expect(pw).toHaveLength(24);
      const text = fs.readFileSync(props, "utf8");
      expect(text.startsWith("# comment\nmotd=Hello\n")).toBe(true);
      const d = parseProperties(text);
      expect(d.get("server-port")).toBe("25570");
      expect(d.get("enable-rcon")).toBe("true");
      expect(d.get("rcon.port")).toBe("25580");
      expect(d.get("rcon.password")).toBe(pw);
      expect(d.get("broadcast-rcon-to-ops")).toBe("false");
      const r2 = await minecraft.prepare({ ...s, secrets: r1.secrets! });
      expect(r2.secrets!.rconPassword).toBe(pw);
      expect(fs.readFileSync(props, "utf8")).toBe(text);
    });
    it("creates server.properties when missing", async () => {
      const f = tmpFolder();
      touch(path.join(f, "eula.txt"), "eula=true");
      await minecraft.prepare(rec("minecraft", f, {}));
      expect(parseProperties(fs.readFileSync(path.join(f, "server.properties"), "utf8")).get("rcon.port")).toBe("25575");
    });
  });

  describe("with RCON", () => {
    it("parses the player list", async () => {
      fake = await startFakeRcon({ password: "pw", reply: (c) => (c === "list" ? "There are 3 of a max of 20 players online: a, b, c" : `reply:${c}`) });
      const s = rec("minecraft", "C:\\m", { rconPort: fake.port }, { rconPassword: "pw" });
      expect(await minecraft.players(s)).toEqual({ online: 3, max: 20 });
      expect(await minecraft.command!(s, "say hi")).toBe("reply:say hi");
      expect(minecraft.hasCommandsFor(s)).toBe(true);
    });
    it("players is null on RCON failure", async () => {
      fake = await startFakeRcon({ password: "pw" });
      const s = rec("minecraft", "C:\\m", { rconPort: fake.port }, { rconPassword: "bad" });
      expect(await minecraft.players(s)).toBeNull();
    });
    it("stop sends save-all then stop; falls back to Ctrl+C", async () => {
      const seen: string[] = [];
      fake = await startFakeRcon({ password: "pw", reply: (c) => { seen.push(c); return ""; } });
      const ctrlC = vi.fn(async () => {});
      await minecraft.stop(rec("minecraft", "C:\\m", { rconPort: fake.port }, { rconPassword: "pw" }), { ctrlC });
      expect(seen).toEqual(["save-all", "stop"]);
      expect(ctrlC).not.toHaveBeenCalled();
      await minecraft.stop(rec("minecraft", "C:\\m", { rconPort: fake.port }, { rconPassword: "bad" }), { ctrlC });
      expect(ctrlC).toHaveBeenCalledTimes(1);
    });
  });
});
