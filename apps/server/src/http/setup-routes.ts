import { Router } from "express";
import type { GameId, InstallRequest, MinecraftFlavour, PortSpec, ServerView, ToolsStatus, UpdateRequest } from "@skali/shared";
import { BadRequestError, ExposedError } from "../errors.js";
import { catalog } from "../games/catalog.js";
import { findPortClashes, type PortProbe } from "../system/ports.js";
import type { Installer } from "../jobs/install.js";
import type { Updater } from "../jobs/update.js";
import type { JavaTools } from "../tools/java.js";
import type { MinecraftSources } from "../tools/minecraft-sources.js";
import { SteamCmdError, type SteamCmd } from "../tools/steamcmd.js";
import { bodyObject, launchValues, onlyKeys } from "./body.js";

export interface SetupRouteDeps {
  steamCmd: Pick<SteamCmd, "appInfo" | "installed">;
  java: Pick<JavaTools, "installedMajors">;
  mcSources: Pick<MinecraftSources, "versions">;
  /** Other servers' names and ports, for clash checks; `exceptId` leaves that server out (editing it). */
  portsInUse: (exceptId?: string) => { name: string; ports: PortSpec[] }[];
  probe?: PortProbe;
  /** Install / retry routes are mounted only when set (with `view`). */
  installer?: Pick<Installer, "install" | "retry">;
  /** The update route is mounted only when set. */
  updater?: Pick<Updater, "update">;
  /** The API view of a server by id (app.ts supplies it). */
  view?: (id: string) => ServerView;
}

const MAX_APP_ID = 2 ** 31;
const MAX_PORTS = 64;
const FLAVOURS: readonly string[] = ["vanilla", "paper"];
const GAMES: readonly string[] = ["palworld", "valheim", "minecraft", "basic"];
const INSTALL_KEYS = new Set(["game", "name", "folder", "launch", "appId", "minecraft", "palworld", "acceptEula"]);

function subObject(v: unknown, k: string, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequestError(`${k} must be an object`);
  const o = v as Record<string, unknown>;
  onlyKeys(o, new Set(keys));
  return o;
}

/** Shape checks only; the installer does the real validation. */
function parseInstall(b: Record<string, unknown>): InstallRequest {
  onlyKeys(b, INSTALL_KEYS);
  if (typeof b.game !== "string" || !GAMES.includes(b.game)) throw new BadRequestError("Unknown game");
  if (typeof b.name !== "string") throw new BadRequestError("name must be a string");
  if (typeof b.folder !== "string") throw new BadRequestError("folder must be a string");
  const req: InstallRequest = { game: b.game as GameId, name: b.name, folder: b.folder, launch: launchValues(b.launch) };
  if (b.appId !== undefined) {
    if (typeof b.appId !== "number" || !Number.isInteger(b.appId)) throw new BadRequestError("appId must be a whole number");
    req.appId = b.appId;
  }
  if (b.minecraft !== undefined) {
    const m = subObject(b.minecraft, "minecraft", ["flavour", "version"]);
    if (typeof m.flavour !== "string" || !FLAVOURS.includes(m.flavour)) throw new BadRequestError("flavour must be vanilla or paper");
    if (typeof m.version !== "string") throw new BadRequestError("version must be a string");
    req.minecraft = { flavour: m.flavour as MinecraftFlavour, version: m.version };
  }
  if (b.palworld !== undefined) {
    const p = subObject(b.palworld, "palworld", ["serverName", "serverPassword", "maxPlayers"]);
    if (typeof p.serverName !== "string" || typeof p.serverPassword !== "string") {
      throw new BadRequestError("serverName and serverPassword must be strings");
    }
    if (typeof p.maxPlayers !== "number" || !Number.isInteger(p.maxPlayers)) throw new BadRequestError("maxPlayers must be a whole number");
    req.palworld = { serverName: p.serverName, serverPassword: p.serverPassword, maxPlayers: p.maxPlayers };
  }
  if (b.acceptEula !== undefined) {
    if (typeof b.acceptEula !== "boolean") throw new BadRequestError("acceptEula must be true or false");
    req.acceptEula = b.acceptEula;
  }
  return req;
}

function parseUpdate(b: Record<string, unknown>): UpdateRequest {
  const req: UpdateRequest = {};
  if (b.minecraft !== undefined) {
    const m = subObject(b.minecraft, "minecraft", ["flavour", "version"]);
    if (typeof m.flavour !== "string" || !FLAVOURS.includes(m.flavour)) throw new BadRequestError("flavour must be vanilla or paper");
    if (typeof m.version !== "string") throw new BadRequestError("version must be a string");
    req.minecraft = { flavour: m.flavour as MinecraftFlavour, version: m.version };
  }
  return req;
}

function parsePorts(v: unknown): PortSpec[] {
  if (!Array.isArray(v)) throw new BadRequestError("ports must be a list");
  if (v.length > MAX_PORTS) throw new BadRequestError("Too many ports");
  return v.map((p) => {
    if (!p || typeof p !== "object" || Array.isArray(p)) throw new BadRequestError("Each port must be an object");
    const { port, protocol } = p as Record<string, unknown>;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BadRequestError("Ports must be whole numbers from 1 to 65535");
    }
    if (protocol !== "udp" && protocol !== "tcp") throw new BadRequestError("Protocol must be udp or tcp");
    return { port, protocol, purpose: "", forward: true };
  });
}

/** A failure of SteamCMD or of a network fetch (incl. our timeouts and bad upstream JSON): not our bug, so a 502. */
function isUpstream(e: unknown): e is Error {
  if (e instanceof SteamCmdError || e instanceof SyntaxError) return true;
  if (e instanceof TypeError && e.message === "fetch failed") return true;
  return e instanceof Error && /^(Could not reach |Download failed: )/.test(e.message);
}

/** Runs `fn`, turning an upstream failure into a 502 with `prefix: <message>` (messages carry no secrets). */
async function upstream<T>(prefix: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isUpstream(e)) throw new ExposedError(502, `${prefix}: ${e.message}`);
    throw e;
  }
}

/** Setup helpers behind the New server gallery; mounted at /api. */
export function setupRouter(deps: SetupRouteDeps): Router {
  const r = Router();

  r.get("/catalog", (_req, res) => {
    res.json(catalog());
  });

  r.post("/steam/app-info", async (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["appId"]));
    const appId = b.appId;
    if (typeof appId !== "number" || !Number.isInteger(appId) || appId < 1 || appId > MAX_APP_ID) {
      throw new BadRequestError("Enter a Steam app ID (a whole number)");
    }
    // appInfo returns null for an unknown app; a SteamCMD/network failure is a 502, a busy SteamCMD a 409.
    const info = await upstream("Steam lookup failed", () => deps.steamCmd.appInfo(appId));
    if (!info) return void res.status(404).json({ error: "No Steam app with that ID" });
    res.json(info);
  });

  r.get("/minecraft/versions", async (req, res) => {
    const f = req.query.flavour;
    if (typeof f !== "string" || !FLAVOURS.includes(f)) throw new BadRequestError("flavour must be vanilla or paper");
    res.json(await upstream("Could not get the Minecraft versions", () => deps.mcSources.versions(f as MinecraftFlavour)));
  });

  r.post("/servers/check-ports", async (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["ports", "exceptId"]));
    const ports = parsePorts(b.ports);
    if (b.exceptId !== undefined && typeof b.exceptId !== "string") throw new BadRequestError("exceptId must be a string");
    const clashes = await findPortClashes(ports, deps.portsInUse(b.exceptId), deps.probe);
    res.json({ clashes });
  });

  const { installer, view } = deps;
  if (installer && view) {
    r.post("/servers/install", async (req, res) => {
      const rec = await installer.install(parseInstall(bodyObject(req)));
      res.status(201).json(view(rec.id));
    });

    r.post("/servers/:id/retry", async (req, res) => {
      const id = String(req.params.id ?? "");
      await installer.retry(id);
      res.status(202).json(view(id));
    });
  }

  if (deps.updater) {
    const updater = deps.updater;
    r.post("/servers/:id/update", async (req, res) => {
      const b = req.body === undefined ? {} : bodyObject(req);
      onlyKeys(b, new Set(["minecraft"]));
      const out = await updater.update(String(req.params.id ?? ""), parseUpdate(b));
      res.status(202).json(out);
    });
  }

  r.get("/tools", (_req, res) => {
    const status: ToolsStatus = { steamcmd: deps.steamCmd.installed(), java: deps.java.installedMajors() };
    res.json(status);
  });

  return r;
}
