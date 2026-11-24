import fs from "node:fs";
import path from "node:path";
import type { LaunchValues, PortSpec } from "@skali/shared";
import { queryA2SInfo } from "../channels/a2s.js";
import { withRcon } from "../channels/rcon.js";
import { BadRequestError } from "../errors.js";
import type { ServerRecord } from "../servers/repo.js";
import { splitArgs } from "../util/args.js";
import { num, str } from "../util/files.js";
import type { GameAdapter } from "./types.js";

const EXCLUDED = [/^UnityCrashHandler/i, /redist/i, /^steamcmd/i, /^uninstall/i];

function parsePorts(text: string): PortSpec[] | null {
  const out: PortSpec[] = [];
  for (const part of text.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d{1,5})\/(udp|tcp)$/i.exec(part);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 65535) return null;
    out.push({ port: Number(m[1]), protocol: m[2]!.toLowerCase() as "udp" | "tcp", purpose: "Game", forward: true });
  }
  return out;
}

const validPort = (v: unknown): boolean => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
};
const isSet = (v: unknown): boolean => v !== undefined && v !== null && v !== "";
const rconReady = (l: LaunchValues) => validPort(l.rconPort) && !!str(l.rconPassword);

export const basic: GameAdapter = {
  info: {
    id: "basic",
    displayName: "Other game (basic)",
    hasCommands: false,
    launchFields: [
      { key: "exe", label: "Executable", type: "text", help: "Path relative to the server folder" },
      { key: "args", label: "Arguments", type: "text" },
      { key: "ports", label: "Ports", type: "text", help: "e.g. 27015/udp, 27016/tcp" },
      { key: "queryPort", label: "Query port (A2S)", type: "number", min: 1, max: 65535 },
      { key: "rconPort", label: "RCON port", type: "number", min: 1, max: 65535 },
      { key: "rconPassword", label: "RCON password", type: "password" },
    ],
  },
  configSources: [],
  ready: { kind: "none" },
  defaultStopTimeoutSec: 60,
  async inspectFolder(folder) {
    let names: string[];
    try {
      names = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith(".exe") && !EXCLUDED.some((re) => re.test(f)));
    } catch {
      return { ok: false, reason: "Folder not found" };
    }
    if (!names.length) return { ok: false, reason: "No .exe file found in this folder" };
    const preferred = names.find((f) => /server|dedicated/i.test(f));
    const exe =
      preferred ??
      [...names].sort((a, b) => fs.statSync(path.join(folder, b)).size - fs.statSync(path.join(folder, a)).size)[0]!;
    return { ok: true, exe, launch: { exe }, notes: preferred ? [] : ["Picked the largest .exe; check it is the server"] };
  },
  validateLaunch(_name, launch) {
    const errors: string[] = [];
    if (!str(launch.exe).trim()) errors.push("Executable is required");
    if (str(launch.ports).trim() && !parsePorts(str(launch.ports))) errors.push("Ports must look like 27015/udp, 27016/tcp");
    for (const [k, label] of [["queryPort", "Query port"], ["rconPort", "RCON port"]] as const) {
      if (isSet(launch[k]) && !validPort(launch[k])) errors.push(`${label} must be a whole number between 1 and 65535`);
    }
    return errors;
  },
  ports(s) {
    return parsePorts(str(s.launch.ports)) ?? [];
  },
  async prepare() {
    return {};
  },
  buildLaunch(s) {
    return { exe: path.resolve(s.folder, str(s.launch.exe)), args: splitArgs(str(s.launch.args)), cwd: s.folder };
  },
  async stop(_s, ctx) {
    await ctx.ctrlC();
  },
  command: async (s: ServerRecord, cmd: string) => {
    if (!rconReady(s.launch)) throw new BadRequestError("RCON is not configured for this server");
    return withRcon("127.0.0.1", num(s.launch.rconPort, 0), str(s.launch.rconPassword), (c) => c.exec(cmd));
  },
  hasCommandsFor: (s) => rconReady(s.launch),
  async players(s) {
    if (!s.launch.queryPort) return null;
    const r = await queryA2SInfo("127.0.0.1", num(s.launch.queryPort, 0));
    return r ? { online: r.players, max: r.maxPlayers } : null;
  },
};
