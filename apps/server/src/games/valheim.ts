import fs from "node:fs";
import path from "node:path";
import type { LaunchValues } from "@skali/shared";
import { queryA2SInfo } from "../channels/a2s.js";
import { splitArgs } from "../util/args.js";
import { bool, num, str } from "../util/files.js";
import type { GameAdapter } from "./types.js";

const EXE = "valheim_server.exe";

export const valheim: GameAdapter = {
  info: {
    id: "valheim",
    displayName: "Valheim",
    hasCommands: false,
    launchFields: [
      { key: "name", label: "Server name", type: "text" },
      { key: "port", label: "Port", type: "number", default: 2456, min: 1, max: 65533 },
      { key: "world", label: "World name", type: "text", default: "Dedicated" },
      { key: "password", label: "Password", type: "password", help: "At least 5 characters, must not contain the server name" },
      { key: "public", label: "Public server", type: "switch", default: true },
      { key: "crossplay", label: "Crossplay", type: "switch", default: false },
      { key: "extraArgs", label: "Extra arguments", type: "text", default: "" },
    ],
  },
  configSources: [],
  ready: { kind: "pattern", pattern: /Game server connected/ },
  defaultStopTimeoutSec: 90,
  steamAppId: 896660,
  installDefaults: () => ({ port: 2456, world: "Dedicated", public: true, crossplay: false, extraArgs: "" }),
  saveLocations: (s) => [path.join(s.folder, "saves")],
  async inspectFolder(folder) {
    if (!fs.existsSync(path.join(folder, EXE))) return { ok: false, reason: `${EXE} not found in this folder` };
    return {
      ok: true,
      exe: EXE,
      launch: valheim.installDefaults(),
      notes: [],
    };
  },
  validateLaunch(name: string, launch: LaunchValues) {
    const errors: string[] = [];
    const pw = str(launch.password);
    const effName = str(launch.name) || name;
    if (pw.length < 5) errors.push("Password must be at least 5 characters");
    else if (effName && pw.toLowerCase().includes(effName.toLowerCase())) errors.push("Password must not contain the server name");
    return errors;
  },
  ports(s) {
    const port = num(s.launch.port, 2456);
    return [
      { port, protocol: "udp", purpose: "Game", forward: true },
      { port: port + 1, protocol: "udp", purpose: "Steam query", forward: true },
      { port: port + 2, protocol: "udp", purpose: "Game (reserved)", forward: true },
    ];
  },
  async prepare() {
    return {};
  },
  buildLaunch(s) {
    const l = s.launch;
    const args = [
      "-nographics", "-batchmode",
      "-name", str(l.name) || s.name,
      "-port", String(num(l.port, 2456)),
      "-world", str(l.world, "Dedicated"),
      "-password", str(l.password),
      "-public", bool(l.public, true) ? "1" : "0",
      "-savedir", path.join(s.folder, "saves"),
      "-logFile", "-",
    ];
    if (bool(l.crossplay, false)) args.push("-crossplay");
    args.push(...splitArgs(str(l.extraArgs)));
    return { exe: path.join(s.folder, EXE), args, cwd: s.folder, env: { SteamAppId: "892970" } };
  },
  async stop(_s, ctx) {
    await ctx.ctrlC();
  },
  command: null,
  hasCommandsFor: () => false,
  async players(s) {
    const r = await queryA2SInfo("127.0.0.1", num(s.launch.port, 2456) + 1);
    return r ? { online: r.players, max: r.maxPlayers } : null;
  },
};
