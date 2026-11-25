import fs from "node:fs";
import path from "node:path";
import type { GameId, InstallRequest, LaunchValues, MinecraftFlavour, PortSpec } from "@skali/shared";
import type { ConfigService } from "../config/service.js";
import { parseProperties } from "../config-formats/properties.js";
import { BadRequestError, ConflictError } from "../errors.js";
import { catalog } from "../games/catalog.js";
import { effectiveAppId, type GameAdapter } from "../games/types.js";
import { writeEula } from "../servers/adopt.js";
import { assertAllowedFolder, assertNewOrEmpty, assertNotLinked, defaultProtected, isUnder, type ProtectedPaths } from "../servers/folders.js";
import { NAME_INVALID, NAME_RE, NAME_USED, type PersistedJob, type ServerRecord, type ServerRepo } from "../servers/repo.js";
import type { SettingsStore } from "../settings.js";
import { grantModify } from "../system/acl.js";
import { ensureFirewallRules } from "../system/firewall.js";
import { findPortClashes, type PortProbe } from "../system/ports.js";
import { download, type FetchFn } from "../tools/download.js";
import type { JavaTools } from "../tools/java.js";
import type { MinecraftSources } from "../tools/minecraft-sources.js";
import type { SteamCmd } from "../tools/steamcmd.js";
import { Mutex } from "../util/mutex.js";
import { num, readTextFile, str, writeIfChanged } from "../util/files.js";
import type { JobRunner, JobStep } from "./runner.js";

export const WAITING_FOR_STEAMCMD = "Waiting for SteamCMD (another install or update is running)";
export const PROGRAM_NOT_FOUND = "Server program not found after install";
export const EULA_REQUIRED = "Accept the Minecraft EULA to continue";

const PAL_SOURCE = "palworld-settings";
const MAX_APP_ID = 2 ** 31;
/** Palworld server name / password from the dialog: one line, bounded (they go into the ini). */
const PAL_TEXT_MAX = 128;
const CONTROL_RE = /[\x00-\x1f\x7f]/;
/** Basic's launch form needs an exe to validate; at install time the program isn't known yet. */
const EXE_PLACEHOLDER = "server.exe";

export interface InstallerDeps {
  repo: ServerRepo;
  runner: JobRunner;
  adapter: (id: GameId) => GameAdapter;
  steamCmd: Pick<SteamCmd, "ensure" | "appUpdate">;
  java: Pick<JavaTools, "ensure">;
  mc: Pick<MinecraftSources, "resolve">;
  settings: Pick<SettingsStore, "get">;
  configService: Pick<ConfigService, "read" | "save">;
  gamesUser: string | null;
  acl?: typeof grantModify;
  firewall?: typeof ensureFirewallRules;
  probe?: PortProbe;
  protectedPaths?: Partial<ProtectedPaths>;
  usersRoot?: string;
  /** For the Minecraft server jar download. */
  fetch?: FetchFn;
}

/** What the steps need, kept in the job's params (never secrets) so Retry can rebuild them. */
interface McParams {
  flavour: MinecraftFlavour;
  version: string;
  javaMajor: number;
  url: string;
  sha1?: string;
  sha256?: string;
  build?: number;
}
interface InstallParams {
  game: GameId;
  appId: number | null;
  minecraft?: McParams;
  palworld?: { serverName: string; maxPlayers: number };
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_APP_ID;

function portsText(ports: PortSpec[] | undefined): string {
  return (ports ?? []).map((p) => `${p.port}/${p.protocol}`).join(", ");
}

/** Rebuilds InstallParams from a persisted job's params; throws when they are unusable. */
function readParams(raw: Record<string, unknown>): InstallParams {
  const game = raw.game;
  if (game !== "palworld" && game !== "valheim" && game !== "minecraft" && game !== "basic") {
    throw new ConflictError("This install can't be retried; remove it and install again");
  }
  return raw as unknown as InstallParams;
}

export class Installer {
  private readonly lock = new Mutex();
  private readonly prot: ProtectedPaths;

  constructor(private readonly deps: InstallerDeps) {
    this.prot = { ...defaultProtected(), ...deps.protectedPaths };
  }

  /** Validates, creates the folder + record (createdFolder, job running), starts the job without awaiting it, returns the record. */
  install(req: InstallRequest): Promise<ServerRecord> {
    return this.lock.run(() => this.doInstall(req));
  }

  /** Re-checks ports and resumes a failed install at its first failed step. ConflictError unless the job is a failed install. */
  retry(serverId: string): Promise<void> {
    return this.lock.run(async () => {
      const { repo, runner } = this.deps;
      const rec = repo.get(serverId);
      if (runner.isRunning(serverId) || rec.job?.kind !== "install" || rec.job.state !== "failed") {
        throw new ConflictError("Only a failed install can be retried");
      }
      const params = readParams(rec.job.params);
      await this.checkPorts(this.deps.adapter(rec.game), rec, rec.id);
      // The port check awaited, so check again; from here to run()'s own check there is no await, so it can't refuse.
      if (runner.isRunning(serverId)) throw new ConflictError("Only a failed install can be retried");
      void runner.run(serverId, "install", this.steps(serverId, params), rec.job.params, { resume: true });
    });
  }

  private async doInstall(req: InstallRequest): Promise<ServerRecord> {
    const { repo, runner } = this.deps;
    const adapter = this.deps.adapter(req.game);

    // ---- validation: nothing is created until all of it passes ----
    if (typeof req.name !== "string" || !NAME_RE.test(req.name)) throw new BadRequestError(NAME_INVALID);
    const others = repo.list();
    if (others.some((s) => s.name.toLowerCase() === req.name.toLowerCase())) throw new BadRequestError(NAME_USED);

    const rawFolder = req.folder === "" ? path.win32.join(this.deps.settings.get().gamesRoot, req.name) : req.folder;
    const folder = assertAllowedFolder(rawFolder, this.deps.usersRoot ?? "C:\\Users", this.prot, "used");
    assertNewOrEmpty(folder);
    assertNotLinked(folder);
    for (const s of others) {
      if (isUnder(folder, s.folder) || isUnder(s.folder, folder)) throw new BadRequestError(`Folder overlaps ${s.name}'s folder`);
    }

    const declared = new Set(adapter.info.launchFields.map((f) => f.key));
    for (const k of Object.keys(req.launch ?? {})) {
      if (!declared.has(k)) throw new BadRequestError(`Unknown launch setting for ${adapter.info.displayName}: ${k}`);
    }
    const launch: LaunchValues = { ...adapter.installDefaults(), ...req.launch };
    const params: InstallParams = { game: req.game, appId: adapter.steamAppId };
    const secrets: Record<string, string> = {};
    let mcChoice: { flavour: MinecraftFlavour; version: string } | null = null;

    if (req.game === "basic") {
      if (!isPosInt(req.appId)) throw new BadRequestError("Enter the server's Steam app ID");
      params.appId = req.appId;
      if (!str(launch.ports).trim()) {
        const fromCatalog = portsText(catalog().find((e) => e.game === "basic" && e.appId === req.appId)?.ports);
        if (fromCatalog) launch.ports = fromCatalog;
      }
    } else if (req.game === "minecraft") {
      if (req.acceptEula !== true) throw new BadRequestError(EULA_REQUIRED);
      const m = req.minecraft;
      if (!m || (m.flavour !== "vanilla" && m.flavour !== "paper") || typeof m.version !== "string" || !m.version) {
        throw new BadRequestError("Choose a Minecraft flavour and version");
      }
      mcChoice = { flavour: m.flavour, version: m.version };
    } else if (req.game === "palworld") {
      const p = req.palworld;
      if (!p || typeof p.serverName !== "string" || typeof p.serverPassword !== "string" || typeof p.maxPlayers !== "number") {
        throw new BadRequestError("Enter the Palworld server name, password and max players");
      }
      if (!p.serverName.trim()) throw new BadRequestError("Enter a server name");
      if (p.serverName.length > PAL_TEXT_MAX || CONTROL_RE.test(p.serverName)) {
        throw new BadRequestError(`Server name must be one line of at most ${PAL_TEXT_MAX} characters`);
      }
      if (p.serverPassword.length > PAL_TEXT_MAX || CONTROL_RE.test(p.serverPassword)) {
        throw new BadRequestError(`Server password must be one line of at most ${PAL_TEXT_MAX} characters`);
      }
      launch.players = p.maxPlayers;
      params.palworld = { serverName: p.serverName, maxPlayers: p.maxPlayers };
      if (p.serverPassword !== "") secrets.installServerPassword = p.serverPassword;
    }

    const toCheck = req.game === "basic" && !str(launch.exe).trim() ? { ...launch, exe: EXE_PLACEHOLDER } : launch;
    const errors = adapter.validateLaunch(req.name, toCheck);
    if (errors.length) throw new BadRequestError(errors.join("; "));

    const draft = this.draft(req.name, req.game, folder, launch);
    await this.checkPorts(adapter, draft);

    if (mcChoice) {
      let dl;
      try {
        dl = await this.deps.mc.resolve(mcChoice.flavour, mcChoice.version);
      } catch (e) {
        if (e instanceof BadRequestError) throw e;
        throw new BadRequestError(`Could not look up Minecraft ${mcChoice.version}: ${errText(e)}`);
      }
      params.minecraft = { ...mcChoice, javaMajor: dl.javaMajor, url: dl.url };
      if (dl.sha1 !== undefined) params.minecraft.sha1 = dl.sha1;
      if (dl.sha256 !== undefined) params.minecraft.sha256 = dl.sha256;
      if (dl.build !== undefined) params.minecraft.build = dl.build;
      launch.mcFlavour = mcChoice.flavour;
      launch.mcVersion = mcChoice.version;
      if (dl.build !== undefined) launch.paperBuild = dl.build;
    }

    // ---- create ----
    const existed = fs.existsSync(folder);
    fs.mkdirSync(folder, { recursive: true });
    const plain = params as unknown as Record<string, unknown>;
    const steps = this.steps("", params);
    const job: PersistedJob = {
      kind: "install",
      state: "running",
      steps: steps.map((s) => ({ id: s.id, label: s.label, state: "pending" })),
      runId: "",
      params: plain,
    };
    let rec: ServerRecord;
    try {
      rec = repo.create({
        name: req.name, game: req.game, folder, launch, secrets, stopTimeoutSec: adapter.defaultStopTimeoutSec,
        steamAppId: params.appId, createdFolder: !existed, job,
      });
    } catch (e) {
      if (!existed) fs.rmSync(folder, { recursive: true, force: true });
      throw e;
    }
    // run() records the job (and its run id) synchronously before its first await.
    void runner.run(rec.id, "install", this.steps(rec.id, params), plain);
    return repo.get(rec.id);
  }

  private draft(name: string, game: GameId, folder: string, launch: LaunchValues): ServerRecord {
    return {
      id: "", name, game, folder, launch, secrets: {}, desired: "stopped", autoRestart: true, autoStart: true, stopTimeoutSec: 60,
      pid: null, pidStartTime: null, currentRunId: null, createdAt: "", configChangedAt: null,
      steamAppId: null, setupPending: false, createdFolder: false, job: null,
    };
  }

  /** Another server's ports or a bind probe on this PC; BadRequestError lists every clash. */
  private async checkPorts(adapter: GameAdapter, rec: ServerRecord, exceptId?: string): Promise<void> {
    let ports: PortSpec[];
    try {
      ports = adapter.ports(rec);
    } catch (e) {
      throw new BadRequestError(errText(e));
    }
    const others = this.deps.repo
      .list()
      .filter((s) => s.id !== exceptId)
      .map((s) => {
        try {
          return { name: s.name, ports: this.deps.adapter(s.game).ports(s) };
        } catch {
          return { name: s.name, ports: [] };
        }
      });
    const clashes = await findPortClashes(ports, others, this.deps.probe);
    if (clashes.length) throw new BadRequestError(clashes.map((c) => `Port ${c.port}/${c.protocol}: ${c.reason}`).join("; "));
  }

  /** The install steps; each reads the record fresh when it runs. `id` may be "" when only labels are needed. */
  private steps(id: string, p: InstallParams): JobStep[] {
    const { repo, configService } = this.deps;
    const adapter = this.deps.adapter(p.game);
    const rec = () => repo.get(id);
    const out: JobStep[] = [];

    if (p.game === "minecraft") {
      const mc = p.minecraft;
      if (!mc) throw new ConflictError("This install can't be retried; remove it and install again");
      out.push({
        id: "java",
        label: `Get Java ${mc.javaMajor}`,
        run: async (ctx) => {
          const javaPath = await this.deps.java.ensure(mc.javaMajor, ctx.log);
          const r = rec();
          repo.update(id, { launch: { ...r.launch, javaPath } });
        },
      });
      out.push({
        id: "files",
        label: "Download server jar",
        run: async (ctx) => {
          const r = rec();
          if (!mc.sha1 && !mc.sha256) throw new Error("The server jar has no published checksum to verify it with");
          assertNotLinked(r.folder);
          fs.mkdirSync(r.folder, { recursive: true });
          const name = mc.flavour === "paper" ? `Paper ${mc.version}${mc.build !== undefined ? ` build ${mc.build}` : ""}` : `Minecraft ${mc.version}`;
          ctx.log(`Downloading ${name}`);
          const opts: Parameters<typeof download>[2] = { onProgress: ctx.progress };
          if (this.deps.fetch) opts.fetch = this.deps.fetch;
          if (mc.sha1) opts.sha1 = mc.sha1;
          if (mc.sha256) opts.sha256 = mc.sha256;
          await download(mc.url, path.join(r.folder, "server.jar"), opts);
          ctx.progress(null);
          ctx.log("Server jar downloaded and verified");
        },
      });
      out.push({
        id: "config",
        label: "Write settings",
        run: async () => {
          const r = rec();
          assertNotLinked(r.folder);
          writeEula(r.folder);
          const file = path.join(r.folder, "server.properties");
          const doc = parseProperties(readTextFile(file) ?? "");
          doc.set("server-port", String(num(r.launch.port, 25565)));
          // prepare() sets the RCON password and re-asserts these on every start.
          if (doc.get("enable-rcon") === undefined) doc.set("enable-rcon", "true");
          if (doc.get("rcon.port") === undefined) doc.set("rcon.port", String(num(r.launch.rconPort, 25575)));
          writeIfChanged(file, doc.toString(), r.folder);
        },
      });
    } else {
      out.push({
        id: "steamcmd",
        label: "Get SteamCMD",
        run: (ctx) => this.deps.steamCmd.ensure(ctx.log),
      });
      out.push({
        id: "files",
        label: "Download game files",
        run: async (ctx) => {
          const r = rec();
          const appId = effectiveAppId(r, adapter);
          if (appId === null) throw new Error("This server has no Steam app ID");
          assertNotLinked(r.folder);
          await this.deps.steamCmd.appUpdate(r.folder, appId, {
            log: ctx.log,
            progress: ctx.progress,
            onWait: () => ctx.log(WAITING_FOR_STEAMCMD),
          });
          ctx.progress(null);
          if (p.game !== "basic") {
            const insp = await adapter.inspectFolder(r.folder);
            if (!insp.ok) throw new Error(PROGRAM_NOT_FOUND);
          }
        },
      });
      out.push({
        id: "config",
        label: "Write settings",
        run: async (ctx) => {
          if (p.game !== "palworld") return;
          const pal = p.palworld;
          if (!pal) throw new Error("The Palworld settings for this install are missing");
          assertNotLinked(rec().folder);
          const view = configService.read(id, PAL_SOURCE);
          if (view.missing && view.seededFrom === undefined) throw new Error("DefaultPalWorldSettings.ini was not found after install");
          if (!view.fields) throw new Error(`PalWorldSettings.ini can't be read: ${view.parseError ?? "unknown format"}`);
          const fields = view.fields;
          const changes: Record<string, string | number | boolean> = {};
          const set = (key: string, value: string | number) => {
            const f = fields.find((x) => x.key === key);
            if (!f) throw new Error(`PalWorldSettings.ini has no ${key} setting`);
            changes[f.id] = value;
          };
          set("ServerName", pal.serverName);
          set("ServerPlayerMaxNum", pal.maxPlayers);
          const password = rec().secrets.installServerPassword;
          if (password !== undefined) set("ServerPassword", password);
          await configService.save(id, PAL_SOURCE, { etag: view.etag, changes });
          const cur = rec();
          if (cur.secrets.installServerPassword !== undefined) {
            const rest = { ...cur.secrets };
            delete rest.installServerPassword;
            repo.update(id, { secrets: rest });
          }
          ctx.log("Wrote server name, password and max players to PalWorldSettings.ini");
        },
      });
    }

    out.push({
      id: "permissions",
      label: "Folder permissions",
      run: async (ctx) => {
        const user = this.deps.gamesUser;
        if (!user) {
          ctx.log("No games user on this PC; folder permissions unchanged");
          return;
        }
        const folder = rec().folder;
        // icacls also gets /L, but a link folder is refused outright: the games user must not redirect this grant.
        assertNotLinked(folder);
        await (this.deps.acl ?? grantModify)(folder, user);
      },
    });
    out.push({
      id: "firewall",
      label: "Firewall rules",
      run: async () => {
        const r = rec();
        await (this.deps.firewall ?? ensureFirewallRules)(r.name, adapter.ports(r));
      },
    });

    if (p.game === "basic") {
      out.push({
        id: "confirm",
        label: "Confirm server program",
        run: async (ctx) => {
          const r = rec();
          const launch: LaunchValues = { ...r.launch };
          const insp = await adapter.inspectFolder(r.folder);
          if (insp.ok) {
            launch.exe = insp.exe;
            ctx.log(`Suggested server program: ${insp.exe}`);
            for (const n of insp.notes) ctx.log(n);
          } else {
            ctx.log(`No server program found (${insp.reason}); pick it under Finish setup`);
          }
          if (!str(launch.ports).trim()) {
            const fromCatalog = portsText(catalog().find((e) => e.game === "basic" && e.appId === p.appId)?.ports);
            if (fromCatalog) launch.ports = fromCatalog;
          }
          repo.update(id, { launch, setupPending: true });
          ctx.log("Check the server program, arguments and ports, then save them to finish setup");
        },
      });
    }
    return out;
  }
}
