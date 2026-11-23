import fs from "node:fs";
import path from "node:path";
import { BadRequestError } from "../errors.js";
import { createPalworldRest, type PalworldRest } from "../channels/palworld-rest.js";
import { parsePalworldIni, quotePal } from "../config-formats/palworld-options.js";
import type { ServerRecord } from "../servers/repo.js";
import { splitArgs } from "../util/args.js";
import { bool, generateSecret, num, readTextFile, str, writeIfChanged } from "../util/files.js";
import type { GameAdapter } from "./types.js";

const REL_EXE = path.join("Pal", "Binaries", "Win64", "PalServer-Win64-Shipping-Cmd.exe");

const HELP = [
  "Commands:",
  "  help                     show this help",
  "  save                     save the world",
  "  info                     server info",
  "  players                  list online players",
  "  announce <msg>           broadcast a message",
  "  kick <userId> [msg]      kick a player",
  "  ban <userId> [msg]       ban a player",
  "  unban <userId>           unban a player",
].join("\n");

function rest(s: ServerRecord): PalworldRest {
  const password = s.secrets.adminPassword;
  if (!password) throw new BadRequestError("Palworld admin password is not set yet (start the server once)");
  return createPalworldRest({ host: "127.0.0.1", port: num(s.launch.restPort, 8212), password });
}

export const palworld: GameAdapter = {
  info: {
    id: "palworld",
    displayName: "Palworld",
    hasCommands: true,
    commandHelp: HELP,
    launchFields: [
      { key: "port", label: "Port", type: "number", default: 8211, min: 1, max: 65535 },
      { key: "players", label: "Max players", type: "number", default: 32, min: 1, max: 32 },
      { key: "perfFlags", label: "Performance flags", type: "switch", default: true },
      { key: "restPort", label: "REST API port", type: "number", default: 8212, min: 1, max: 65535 },
      { key: "extraArgs", label: "Extra arguments", type: "text", default: "" },
    ],
  },
  ready: {
    kind: "probe",
    probe: async (s) => {
      try {
        await rest(s).info();
        return true;
      } catch {
        return false;
      }
    },
  },
  defaultStopTimeoutSec: 120,
  async inspectFolder(folder) {
    if (!fs.existsSync(path.join(folder, REL_EXE))) return { ok: false, reason: "PalServer-Win64-Shipping-Cmd.exe not found in this folder" };
    return {
      ok: true,
      exe: REL_EXE,
      launch: { port: 8211, players: 32, perfFlags: true, restPort: 8212, extraArgs: "" },
      notes: [],
    };
  },
  validateLaunch(_name, launch) {
    const errors: string[] = [];
    const players = num(launch.players, 32);
    if (players < 1 || players > 32) errors.push("Max players must be between 1 and 32");
    return errors;
  },
  ports(s) {
    return [
      { port: num(s.launch.port, 8211), protocol: "udp", purpose: "Game", forward: true },
      { port: num(s.launch.restPort, 8212), protocol: "tcp", purpose: "REST API", forward: false },
    ];
  },
  async prepare(s) {
    const ini = path.join(s.folder, "Pal", "Saved", "Config", "WindowsServer", "PalWorldSettings.ini");
    let text = readTextFile(ini);
    if (text === null || !/OptionSettings\s*=/.test(text)) {
      const def = readTextFile(path.join(s.folder, "DefaultPalWorldSettings.ini"));
      if (def === null) throw new BadRequestError("DefaultPalWorldSettings.ini not found in the server folder");
      text = def;
    }
    const password = s.secrets.adminPassword || generateSecret();
    const doc = parsePalworldIni(text);
    doc.set("RESTAPIEnabled", "True");
    doc.set("RESTAPIPort", String(num(s.launch.restPort, 8212)));
    doc.set("AdminPassword", quotePal(password));
    writeIfChanged(ini, doc.toString());
    return { secrets: { adminPassword: password } };
  },
  buildLaunch(s) {
    const l = s.launch;
    const args = ["Pal", `-port=${num(l.port, 8211)}`, `-players=${num(l.players, 32)}`];
    if (bool(l.perfFlags, true)) args.push("-useperfthreads", "-NoAsyncLoadingThread", "-UseMultithreadForDS");
    args.push(...splitArgs(str(l.extraArgs)));
    return { exe: path.join(s.folder, REL_EXE), args, cwd: s.folder };
  },
  async stop(s, ctx) {
    try {
      const r = rest(s);
      await r.save();
      await r.shutdown(1, "Server is restarting/stopping");
    } catch {
      await ctx.ctrlC();
    }
  },
  async command(s, cmd) {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(cmd.trim());
    const verb = (m?.[1] ?? "").toLowerCase();
    const arg = (m?.[2] ?? "").trim();
    const known = ["save", "info", "players", "announce", "kick", "ban", "unban"];
    if (!known.includes(verb)) return HELP;
    const r = rest(s);
    switch (verb) {
      case "save":
        await r.save();
        return "World saved.";
      case "info": {
        const i = await r.info();
        return `${i.servername} (${i.version})`;
      }
      case "players": {
        const ps = await r.players();
        return ps.length ? ps.map((p) => `${p.name} (${p.userId})`).join("\n") : "No players online.";
      }
      case "announce":
        if (!arg) return HELP;
        await r.announce(arg);
        return "Announcement sent.";
      case "kick":
      case "ban": {
        const mm = /^(\S+)\s*([\s\S]*)$/.exec(arg);
        if (!mm) return HELP;
        const msg = mm[2] || undefined;
        await (verb === "kick" ? r.kick(mm[1]!, msg) : r.ban(mm[1]!, msg));
        return verb === "kick" ? "Player kicked." : "Player banned.";
      }
      default:
        if (!arg) return HELP;
        await r.unban(arg);
        return "Player unbanned.";
    }
  },
  hasCommandsFor: () => true,
  async players(s) {
    try {
      const m = await rest(s).metrics();
      return { online: m.currentplayernum, max: m.maxplayernum };
    } catch {
      return null;
    }
  },
};
