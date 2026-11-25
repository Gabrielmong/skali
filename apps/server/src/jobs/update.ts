import fs from "node:fs";
import path from "node:path";
import type { GameId, LaunchValues, MinecraftFlavour, UpdateRequest } from "@skali/shared";
import { BadRequestError, ConflictError } from "../errors.js";
import { effectiveAppId, type GameAdapter } from "../games/types.js";
import type { Supervisor } from "../proc/supervisor.js";
import type { ServerRecord, ServerRepo } from "../servers/repo.js";
import { download, zipPaths, type FetchFn } from "../tools/download.js";
import type { JavaTools } from "../tools/java.js";
import { compareMcVersions, type MinecraftSources } from "../tools/minecraft-sources.js";
import type { SteamCmd } from "../tools/steamcmd.js";
import { assertNotLinked, isUnder, norm } from "../servers/folders.js";
import { assertNoReparsePoints, str } from "../util/files.js";
import { WAITING_FOR_STEAMCMD } from "./install.js";
import type { JobRunner, JobStep } from "./runner.js";

export const NO_STEAM_APP_ID = "This server has no Steam app ID";
export const NO_WORLD_YET = "No world folder yet; nothing to back up";
export const NO_SAVE_LOCATIONS = "This server type has no known world folder; no backup taken";

export interface UpdaterDeps {
  repo: ServerRepo;
  runner: JobRunner;
  adapter: (id: GameId) => GameAdapter;
  supervisor: Pick<Supervisor, "stop" | "start" | "state">;
  steamCmd: Pick<SteamCmd, "appUpdate">;
  java: Pick<JavaTools, "ensure" | "isManaged">;
  mc: Pick<MinecraftSources, "resolve">;
  /** `<dataDir>\backups` */
  backupsDir: string;
  now?: () => Date;
  /** For the Minecraft server jar download. */
  fetch?: FetchFn;
}

interface McUpdate {
  flavour: MinecraftFlavour;
  version: string;
  javaMajor: number;
  url: string;
  sha1?: string;
  sha256?: string;
  build?: number;
}

/** The server jar, which must lie inside the server folder. */
function jarPath(r: ServerRecord): string {
  const folder = path.resolve(r.folder);
  const jar = path.resolve(folder, str(r.launch.jar) || "server.jar");
  if (!isUnder(jar, folder) || jar.toLowerCase() === folder.toLowerCase()) throw new BadRequestError("The server jar must be inside the server folder");
  return jar;
}

const isUp = (status: string): boolean => status !== "stopped" && status !== "crashed";

/** Runs `fn` under the caller's serialization (the app's editLock). */
export type Serialize = <T>(fn: () => Promise<T>) => Promise<T>;
const unserialized: Serialize = (fn) => fn();

export class Updater {
  constructor(private readonly deps: UpdaterDeps) {}

  /**
   * Validates, starts the job without awaiting it, returns warnings. The Minecraft version lookup (network) runs
   * before `serialize`; everything it checked is checked again inside it, and from there to the job start nothing awaits.
   */
  async update(serverId: string, req: UpdateRequest, serialize: Serialize = unserialized): Promise<{ warnings: string[] }> {
    const { repo, runner, supervisor } = this.deps;
    const busy = (): void => {
      if (runner.isRunning(serverId) || repo.get(serverId).job?.state === "running") {
        throw new ConflictError("A job is already running for this server");
      }
      const cur = repo.get(serverId);
      if (cur.job?.kind === "install" && cur.job.state === "failed") throw new ConflictError("Retry or remove the failed install first");
      if (cur.setupPending) throw new ConflictError("Finish setup first");
      const status = supervisor.state(serverId).status;
      if (status === "starting" || status === "stopping") throw new ConflictError(`Server is ${status}; wait for it to settle`);
      // Stopped but a process is still tracked: a stop couldn't confirm it gone, so it may still be running.
      if (!isUp(status) && cur.pid != null) throw new ConflictError("The server's process could not be confirmed stopped; check it first");
    };
    busy();
    const rec = repo.get(serverId);
    const adapter = this.deps.adapter(rec.game);
    const warnings: string[] = [];
    let mcUpdate: McUpdate | undefined;

    if (rec.game === "minecraft") {
      const m = req.minecraft;
      if (!m || (m.flavour !== "vanilla" && m.flavour !== "paper") || typeof m.version !== "string" || !m.version) {
        throw new BadRequestError("Choose a Minecraft flavour and version");
      }
      let dl;
      try {
        dl = await this.deps.mc.resolve(m.flavour, m.version);
      } catch (e) {
        if (e instanceof BadRequestError) throw e;
        throw new BadRequestError(`Could not look up Minecraft ${m.version}: ${e instanceof Error ? e.message : String(e)}`);
      }
      jarPath(rec); // refuses a jar outside the folder
      if (!dl.sha1 && !dl.sha256) throw new BadRequestError("The server jar has no published checksum to verify it with");
      mcUpdate = { flavour: m.flavour, version: m.version, javaMajor: dl.javaMajor, url: dl.url };
      if (dl.sha1 !== undefined) mcUpdate.sha1 = dl.sha1;
      if (dl.sha256 !== undefined) mcUpdate.sha256 = dl.sha256;
      if (dl.build !== undefined) mcUpdate.build = dl.build;
      const current = str(rec.launch.mcVersion).trim();
      if (current && compareMcVersions(m.version, current) < 0) {
        warnings.push(`Minecraft ${m.version} is older than ${current}. Worlds opened in a newer version may break; a backup is taken first.`);
      }
    } else if (effectiveAppId(rec, adapter) === null) {
      throw new BadRequestError(NO_STEAM_APP_ID);
    }

    return serialize(async () => {
      // The lookup above awaited (outside the lock); check again. From here to run()'s own check there is no await.
      busy();
      const cur = repo.get(serverId);
      if (mcUpdate) jarPath(cur); // the jar may have been edited meanwhile
      else if (effectiveAppId(cur, adapter) === null) throw new BadRequestError(NO_STEAM_APP_ID);
      const wasRunning = isUp(supervisor.state(serverId).status);
      const params: Record<string, unknown> = { wasRunning };
      if (mcUpdate) params.minecraft = mcUpdate;
      void runner.run(serverId, "update", this.steps(serverId, wasRunning, mcUpdate), params);
      return { warnings };
    });
  }

  private backupFile(id: string): string {
    const stamp = (this.deps.now ?? (() => new Date()))().toISOString().replace(/[:.]/g, "-");
    return path.win32.join(this.deps.backupsDir, id, `${stamp}-pre-update.zip`);
  }

  private steps(id: string, wasRunning: boolean, mc: McUpdate | undefined): JobStep[] {
    const { repo, supervisor } = this.deps;
    const rec = (): ServerRecord => repo.get(id);
    const adapter = this.deps.adapter(rec().game);
    const out: JobStep[] = [];

    out.push({
      id: "stop",
      label: "Stop server",
      run: async (ctx) => {
        if (!isUp(supervisor.state(id).status)) return;
        ctx.log("Stopping the server");
        await supervisor.stop(id);
        const status = supervisor.state(id).status;
        if (isUp(status)) throw new Error(`The server did not stop (it is ${status})`);
        if (repo.get(id).pid != null) throw new Error("The server's process could not be confirmed stopped; check it, then try again");
      },
    });

    out.push({
      id: "backup",
      label: "Back up world",
      run: async (ctx) => {
        const r = rec();
        const all = adapter.saveLocations(r);
        if (all.length === 0) {
          // Basic has no known save data; another type returns none only when its world setting was refused
          // (e.g. a Minecraft level-name outside the server folder), and then there is no world to back up.
          ctx.log(adapter.info.id === "basic" ? NO_SAVE_LOCATIONS : NO_WORLD_YET);
          return;
        }
        // The backup runs as SYSTEM over a folder the games user can modify: refuse a linked server folder, keep only
        // locations strictly inside it, and refuse link components on the way to each (zipPaths skips links below).
        assertNotLinked(r.folder);
        const locations = all.filter((p) => isUnder(p, r.folder) && norm(p) !== norm(r.folder));
        for (const p of all) if (!locations.includes(p)) ctx.log(`Skipping a save location outside the server folder: ${p}`);
        for (const p of locations) assertNoReparsePoints(r.folder, p, "back up");
        const file = this.backupFile(id);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const made = await zipPaths(locations, r.folder, file);
        ctx.log(made ? `Backup saved to ${file}` : NO_WORLD_YET);
      },
    });

    if (mc) {
      let newJava: string | undefined;
      out.push({
        id: "java",
        label: `Get Java ${mc.javaMajor}`,
        run: async (ctx) => {
          const current = str(rec().launch.javaPath);
          if (this.deps.java.isManaged(current)) {
            // Written to the record only after the jar swap succeeds, so a failed update leaves old jar + old Java.
            newJava = await this.deps.java.ensure(mc.javaMajor, ctx.log);
          } else {
            ctx.log(`Warning: this server uses its own Java (${current || "java"}); make sure it is Java ${mc.javaMajor} or newer`);
          }
        },
      });
      out.push({
        id: "files",
        label: "Download server jar",
        run: async (ctx) => {
          const r = rec();
          assertNotLinked(r.folder);
          const jar = jarPath(r);
          assertNoReparsePoints(r.folder, jar);
          const fresh = `${jar}.new`;
          const prev = `${jar}.previous`;
          ctx.log(`Downloading ${mc.flavour === "paper" ? "Paper" : "Minecraft"} ${mc.version}`);
          const opts: Parameters<typeof download>[2] = { onProgress: ctx.progress };
          if (this.deps.fetch) opts.fetch = this.deps.fetch;
          if (mc.sha1) opts.sha1 = mc.sha1;
          if (mc.sha256) opts.sha256 = mc.sha256;
          await download(mc.url, fresh, opts);
          ctx.progress(null);
          // Copy (not move) the old jar aside, then replace it in one rename: server.jar exists at every moment.
          try {
            if (fs.existsSync(jar)) fs.copyFileSync(jar, prev);
            fs.renameSync(fresh, jar);
          } catch (e) {
            fs.rmSync(fresh, { force: true });
            throw e;
          }
          const launch: LaunchValues = { ...rec().launch, mcFlavour: mc.flavour, mcVersion: mc.version };
          if (newJava !== undefined) launch.javaPath = newJava;
          if (mc.build !== undefined) launch.paperBuild = mc.build;
          else delete launch.paperBuild;
          repo.update(id, { launch });
          ctx.log("Server jar updated and verified; the old one is kept as a .previous file");
        },
      });
    } else {
      out.push({
        id: "files",
        label: "Update game files",
        run: async (ctx) => {
          const r = rec();
          const appId = effectiveAppId(r, adapter);
          if (appId === null) throw new Error(NO_STEAM_APP_ID);
          assertNotLinked(r.folder);
          await this.deps.steamCmd.appUpdate(r.folder, appId, {
            log: ctx.log,
            progress: ctx.progress,
            onWait: () => ctx.log(WAITING_FOR_STEAMCMD),
          });
          ctx.progress(null);
        },
      });
    }

    out.push({
      id: "start",
      label: "Start server",
      run: async (ctx) => {
        if (!wasRunning) return;
        ctx.log("Starting the server again");
        // The job is still "running" here, so the start guard would refuse it as "Updating…".
        await supervisor.start(id, { skipGuard: true });
      },
    });
    return out;
  }
}
