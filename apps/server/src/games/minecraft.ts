import fs from "node:fs";
import path from "node:path";
import { MINECRAFT_EULA_NOTE } from "@skali/shared";
import { BadRequestError } from "../errors.js";
import { withRcon } from "../channels/rcon.js";
import { parseProperties } from "../config-formats/properties.js";
import type { ServerRecord } from "../servers/repo.js";
import { splitArgs } from "../util/args.js";
import { generateSecret, num, readTextFile, str, writeIfChanged } from "../util/files.js";
import { MINECRAFT_TEMPLATE } from "./config-templates.js";
import type { GameAdapter } from "./types.js";

const EULA_OK = /^\s*eula\s*=\s*true\s*$/im;
const hasEula = (folder: string) => EULA_OK.test(readTextFile(path.join(folder, "eula.txt")) ?? "");

function rcon<T>(s: ServerRecord, fn: (c: { exec(cmd: string): Promise<string> }) => Promise<T>): Promise<T> {
  const password = s.secrets.rconPassword;
  if (!password) throw new BadRequestError("RCON is not configured for this server");
  return withRcon("127.0.0.1", num(s.launch.rconPort, 25575), password, fn);
}

export const minecraft: GameAdapter = {
  info: {
    id: "minecraft",
    displayName: "Minecraft (Java)",
    hasCommands: true,
    commandHelp: "Any Minecraft server console command, e.g. list, say <msg>, op <player>, whitelist add <player>.",
    launchFields: [
      { key: "jar", label: "Server jar", type: "text" },
      { key: "javaPath", label: "Java path", type: "text", default: "java" },
      { key: "memoryMb", label: "Memory (MB)", type: "number", default: 4096, min: 1024 },
      { key: "jvmArgs", label: "JVM arguments", type: "text", default: "" },
      { key: "port", label: "Port", type: "number", default: 25565, min: 1, max: 65535 },
      { key: "rconPort", label: "RCON port", type: "number", default: 25575, min: 1, max: 65535 },
    ],
  },
  configSources: [
    { id: "server-properties", label: "server.properties", path: "server.properties", format: "properties", template: MINECRAFT_TEMPLATE },
    { id: "ops", label: "Operators (ops.json)", path: "ops.json", format: "json" },
    { id: "whitelist", label: "Whitelist (whitelist.json)", path: "whitelist.json", format: "json" },
  ],
  ready: { kind: "pattern", pattern: /Done \(\d/ },
  defaultStopTimeoutSec: 60,
  async inspectFolder(folder) {
    let jars: string[];
    try {
      jars = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".jar"));
    } catch {
      return { ok: false, reason: "Folder not found" };
    }
    if (!jars.length) return { ok: false, reason: "No .jar file found in this folder" };
    const lower = (j: string) => j.toLowerCase();
    const jar =
      jars.find((j) => lower(j) === "server.jar") ??
      jars.find((j) => lower(j).includes("paper")) ??
      jars.find((j) => lower(j).includes("server")) ??
      jars[0]!;
    const notes: string[] = [];
    if (!hasEula(folder)) notes.push(MINECRAFT_EULA_NOTE);
    return {
      ok: true,
      exe: "java",
      launch: { jar, javaPath: "java", memoryMb: 4096, jvmArgs: "", port: 25565, rconPort: 25575 },
      notes,
    };
  },
  validateLaunch(_name, launch) {
    const errors: string[] = [];
    if (!str(launch.jar).trim()) errors.push("Server jar is required");
    if (num(launch.memoryMb, 4096) < 1024) errors.push("Memory must be at least 1024 MB");
    return errors;
  },
  ports(s) {
    return [
      { port: num(s.launch.port, 25565), protocol: "tcp", purpose: "Game", forward: true },
      { port: num(s.launch.rconPort, 25575), protocol: "tcp", purpose: "RCON", forward: false },
    ];
  },
  async prepare(s) {
    if (!hasEula(s.folder)) throw new BadRequestError("Accept the Minecraft EULA first (server Overview)");
    const file = path.join(s.folder, "server.properties");
    const doc = parseProperties(readTextFile(file) ?? "");
    const password = s.secrets.rconPassword || generateSecret();
    doc.set("server-port", String(num(s.launch.port, 25565)));
    doc.set("enable-rcon", "true");
    doc.set("rcon.port", String(num(s.launch.rconPort, 25575)));
    doc.set("rcon.password", password);
    doc.set("broadcast-rcon-to-ops", "false");
    writeIfChanged(file, doc.toString(), s.folder);
    return { secrets: { rconPassword: password } };
  },
  buildLaunch(s) {
    const l = s.launch;
    const mem = num(l.memoryMb, 4096);
    return {
      exe: str(l.javaPath, "java"),
      args: [`-Xms${mem}M`, `-Xmx${mem}M`, ...splitArgs(str(l.jvmArgs)), "-jar", str(l.jar, "server.jar"), "nogui"],
      cwd: s.folder,
    };
  },
  async stop(s, ctx) {
    try {
      await rcon(s, async (c) => {
        await c.exec("save-all");
        await c.exec("stop");
      });
    } catch {
      await ctx.ctrlC();
    }
  },
  command: async (s, cmd) => rcon(s, (c) => c.exec(cmd)),
  hasCommandsFor: () => true,
  async players(s) {
    try {
      const out = await rcon(s, (c) => c.exec("list"));
      const m = /There are (\d+) of a max of (\d+) players online/.exec(out);
      return m ? { online: Number(m[1]), max: Number(m[2]) } : null;
    } catch {
      return null;
    }
  },
};
