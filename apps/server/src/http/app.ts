import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream";
import express, { type NextFunction, type Request, type Response } from "express";
import {
  MASKED_SECRET,
  SKALI_HEADER,
  SKALI_HEADER_VALUE,
  type AdoptRequest,
  type GameId,
  type LaunchValues,
  type PortSpec,
  type ServerView,
} from "@skali/shared";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import { getAdapter, listGames } from "../games/registry.js";
import type { GameAdapter } from "../games/types.js";
import { appendSkaliLine, listRuns } from "../logs/runs.js";
import type { Supervisor } from "../proc/supervisor.js";
import { writeEula, type Adopter } from "../servers/adopt.js";
import type { ServerRecord, ServerRepo } from "../servers/repo.js";
import type { AppSettings, SettingsStore } from "../settings.js";
import { ensureFirewallRules, removeFirewallRules } from "../system/firewall.js";
import { Mutex } from "../util/mutex.js";
import { isAllowed, isAllowedHost, isValidAllowEntry, normalizeRemote } from "./allowlist.js";
import { busyRouter } from "./busy.js";
import { deploysRouter } from "./deploys.js";
import { browse } from "./fs-browse.js";
import { toView } from "./views.js";

export type SupervisorApi = Pick<Supervisor, "state" | "start" | "stop" | "restart" | "command" | "forget">;
export type AdopterApi = Pick<Adopter, "inspect" | "adopt" | "remove">;

/** Changes the HTTP API makes that live clients should hear about (the WS hub listens). */
export type AppEvent =
  | { type: "changed"; serverId: string }
  | { type: "removed"; serverId: string }
  | { type: "allChanged" };

export interface AppDeps {
  repo: ServerRepo;
  supervisor: SupervisorApi;
  adopter: AdopterApi;
  settings: SettingsStore;
  logsDir: string;
  webDist: string;
  adapter?: (id: GameId) => GameAdapter;
  firewall?: { ensure: typeof ensureFirewallRules; remove: typeof removeFirewallRules };
  /** The peer address used for the allowlist. Never taken from X-Forwarded-For. Test seam. */
  remoteAddress?: (req: IncomingMessage) => string | undefined;
  /** This machine's name for the Host check; defaults to os.hostname(). */
  hostname?: string;
  log?: (msg: string) => void;
  notify?: (e: AppEvent) => void;
  /** The deploy helper behind the Deploys page proxy (routes are not mounted when unset). */
  deployerUrl?: string;
  deployerTokenFile?: string;
  /** How long start/stop/restart wait for an early rejection before answering 202. */
  opWindowMs?: number;
}

/** An error whose message is meant for the client, with its own status. */
class ExposedError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const JSON_LIMIT = "64kb";
const OP_WINDOW_MS = 250;
const MAX_COMMAND = 1000;
const MAX_LAUNCH_KEYS = 64;
const MAX_LAUNCH_STRING = 4096;
const PATCH_KEYS = new Set(["name", "autoRestart", "autoStart", "stopTimeoutSec", "launch"]);
const ADOPT_KEYS = new Set(["game", "name", "folder", "launch", "importWorldFrom", "acceptEula"]);

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const isApi = (req: Request) => /^\/api(\/|$)/i.test(req.path);
const defaultRemote = (req: IncomingMessage) => req.socket.remoteAddress;

function bodyObject(req: Request): Record<string, unknown> {
  const b: unknown = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new BadRequestError("Expected a JSON object");
  return b as Record<string, unknown>;
}
function onlyKeys(b: Record<string, unknown>, allowed: Set<string>): void {
  for (const k of Object.keys(b)) if (!allowed.has(k)) throw new BadRequestError(`Unexpected field: ${k}`);
}
function optBool(b: Record<string, unknown>, k: string): boolean | undefined {
  const v = b[k];
  if (v !== undefined && typeof v !== "boolean") throw new BadRequestError(`${k} must be true or false`);
  return v as boolean | undefined;
}
function reqString(b: Record<string, unknown>, k: string): string {
  const v = b[k];
  if (typeof v !== "string") throw new BadRequestError(`${k} must be a string`);
  return v;
}
function launchValues(v: unknown): LaunchValues {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequestError("launch must be an object");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_LAUNCH_KEYS) throw new BadRequestError("Too many launch values");
  for (const [k, x] of entries) {
    const ok =
      typeof x === "boolean" ||
      (typeof x === "number" && Number.isFinite(x)) ||
      (typeof x === "string" && x.length <= MAX_LAUNCH_STRING);
    if (!ok) throw new BadRequestError(`Invalid launch value: ${k}`);
  }
  return { ...(v as LaunchValues) };
}
const portsKey = (ps: PortSpec[]) =>
  JSON.stringify(ps.filter((p) => p.forward).map((p) => `${p.port}/${p.protocol}`).sort());

export function createApp(deps: AppDeps): express.Express {
  const { repo, supervisor, adopter, settings, logsDir, webDist } = deps;
  const adapterOf = deps.adapter ?? getAdapter;
  const fw = deps.firewall ?? { ensure: ensureFirewallRules, remove: removeFirewallRules };
  const remoteOf = deps.remoteAddress ?? defaultRemote;
  const machine = deps.hostname ?? os.hostname();
  const log = deps.log ?? ((m: string) => console.error(m));
  const notify = (e: AppEvent) => {
    try {
      deps.notify?.(e);
    } catch (err) {
      log(`notify failed: ${errMsg(err)}`);
    }
  };
  const opWindowMs = deps.opWindowMs ?? OP_WINDOW_MS;
  const gameIds = new Set<string>(listGames().map((g) => g.id));
  /** Serializes edits and removals, which pair a repo change with firewall changes. */
  const editLock = new Mutex();
  /** Servers with a DELETE in flight: lifecycle ops and commands are refused meanwhile. */
  const removing = new Set<string>();
  const notBeingRemoved = (id: string) => {
    if (removing.has(id)) throw new ConflictError("Server is being removed");
  };

  const view = (rec: ServerRecord): ServerView => toView(rec, supervisor.state(rec.id), adapterOf(rec.game), settings.get());
  const gameOf = (v: unknown): GameId => {
    if (typeof v !== "string" || !gameIds.has(v)) throw new BadRequestError("Unknown game");
    return v as GameId;
  };
  const param = (req: Request, k: string): string => String(req.params[k] ?? "");

  const app = express();
  app.disable("x-powered-by");
  app.set("case sensitive routing", true);
  app.set("etag", false);

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (isApi(req)) res.setHeader("Cache-Control", "no-store");
    next();
  });

  // Loopback-only deploy-helper probe: before the Host/allowlist checks (the helper calls http://127.0.0.1:4200)
  // and before anything else under /api/deploys.
  app.use(
    "/api/deploys/busy",
    busyRouter({ repo, state: (id) => supervisor.state(id), remoteOf }),
  );

  // 1. Host (DNS rebinding), 2. allowlist, 3. CSRF header. No CORS handling is registered anywhere.
  app.use((req, res, next) => {
    if (isAllowedHost(req.headers.host, machine)) return next();
    if (isApi(req)) return void res.status(403).json({ error: "forbidden" });
    res.status(403).type("text/plain; charset=utf-8").send("Skáli: unexpected Host header.");
  });
  app.use((req, res, next) => {
    const remote = remoteOf(req);
    if (isAllowed(remote, settings.get().allowlist)) return next();
    if (isApi(req)) return void res.status(403).json({ error: "forbidden" });
    res
      .status(403)
      .type("text/plain; charset=utf-8")
      .send(`Skáli: this device (${normalizeRemote(remote) ?? "unknown"}) is not on the allowed list.`);
  });
  // Every request that isn't GET/HEAD, whatever its path or case.
  app.use((req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") return next();
    if (req.get(SKALI_HEADER) === SKALI_HEADER_VALUE) return next();
    res.status(403).json({ error: "forbidden" });
  });

  app.use("/api", express.json({ limit: JSON_LIMIT }));

  if (deps.deployerUrl && deps.deployerTokenFile) {
    app.use("/api/deploys", deploysRouter({ deployerUrl: deps.deployerUrl, deployerTokenFile: deps.deployerTokenFile, log }));
  }

  // ---------- games & servers ----------

  app.get("/api/games", (_req, res) => {
    res.json(listGames());
  });

  app.get("/api/servers", (_req, res) => {
    res.json(repo.list().map(view));
  });

  app.post("/api/servers/inspect", async (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["game", "folder"]));
    const game = gameOf(b.game);
    const folder = reqString(b, "folder");
    res.json(await adopter.inspect(game, folder));
  });

  app.get("/api/servers/:id", (req, res) => {
    res.json(view(repo.get(param(req, "id"))));
  });

  app.post("/api/servers", async (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, ADOPT_KEYS);
    const ar: AdoptRequest = {
      game: gameOf(b.game),
      name: reqString(b, "name"),
      folder: reqString(b, "folder"),
      launch: launchValues(b.launch),
    };
    if (b.importWorldFrom !== undefined) ar.importWorldFrom = reqString(b, "importWorldFrom");
    const eula = optBool(b, "acceptEula");
    if (eula !== undefined) ar.acceptEula = eula;
    const rec = await adopter.adopt(ar);
    notify({ type: "changed", serverId: rec.id });
    res.status(201).json(view(rec));
  });

  app.patch("/api/servers/:id", async (req, res) => {
    const id = param(req, "id");
    const b = bodyObject(req);
    onlyKeys(b, PATCH_KEYS);
    const updated = await editLock.run(() => patchServer(id, b));
    notify({ type: "changed", serverId: id });
    res.json(view(updated));
  });

  async function patchServer(id: string, b: Record<string, unknown>): Promise<ServerRecord> {
    const cur = repo.get(id);
    const adapter = adapterOf(cur.game);
    if (b.name !== undefined && typeof b.name !== "string") throw new BadRequestError("name must be a string");
    const autoRestart = optBool(b, "autoRestart");
    const autoStart = optBool(b, "autoStart");
    const st = b.stopTimeoutSec;
    if (st !== undefined && !(typeof st === "number" && Number.isInteger(st) && st >= 5 && st <= 3600)) {
      throw new BadRequestError("stopTimeoutSec must be a whole number of seconds between 5 and 3600");
    }
    const name = (b.name as string | undefined) ?? cur.name;
    let launch = cur.launch;
    if (b.launch !== undefined) {
      const incoming = launchValues(b.launch);
      const declared = new Set(adapter.info.launchFields.map((f) => f.key));
      for (const k of Object.keys(incoming)) {
        if (!declared.has(k)) throw new BadRequestError(`Unknown launch setting for ${adapter.info.displayName}: ${k}`);
      }
      for (const f of adapter.info.launchFields) {
        if (f.type !== "password" || incoming[f.key] !== MASKED_SECRET) continue;
        // "****" is the masked value we sent: keep what is stored.
        if (cur.launch[f.key] !== undefined) incoming[f.key] = cur.launch[f.key]!;
        else delete incoming[f.key];
      }
      launch = { ...cur.launch, ...incoming };
    }
    if (b.launch !== undefined || b.name !== undefined) {
      const errors = adapter.validateLaunch(name, launch);
      if (errors.length) throw new BadRequestError(errors.join("; "));
    }
    let oldPorts: PortSpec[] = [];
    try {
      oldPorts = adapter.ports(cur);
    } catch {
      // the stored values were unusable; any valid new set counts as a change
    }
    const next = repo.update(id, {
      name,
      launch,
      ...(autoRestart !== undefined ? { autoRestart } : {}),
      ...(autoStart !== undefined ? { autoStart } : {}),
      ...(st !== undefined ? { stopTimeoutSec: st as number } : {}),
    });
    const nameChanged = next.name !== cur.name;
    let newPorts: PortSpec[];
    try {
      newPorts = adapter.ports(next);
    } catch (e) {
      revert(cur);
      throw e instanceof BadRequestError ? e : new BadRequestError(errMsg(e));
    }
    if (!nameChanged && portsKey(oldPorts) === portsKey(newPorts)) return next;
    try {
      if (nameChanged) await fw.remove(cur.name);
      await fw.ensure(next.name, newPorts);
    } catch (e) {
      log(`Firewall update for ${cur.name} failed; reverting the change: ${errMsg(e)}`);
      revert(cur);
      try {
        if (nameChanged) await fw.remove(next.name);
        await fw.ensure(cur.name, oldPorts);
      } catch (e2) {
        log(`Restoring firewall rules for ${cur.name} failed: ${errMsg(e2)}`);
      }
      throw new ExposedError(500, `Firewall update failed: ${errMsg(e)}`);
    }
    return next;
  }

  function revert(cur: ServerRecord): void {
    try {
      repo.update(cur.id, {
        name: cur.name,
        launch: cur.launch,
        autoRestart: cur.autoRestart,
        autoStart: cur.autoStart,
        stopTimeoutSec: cur.stopTimeoutSec,
      });
    } catch (e) {
      log(`Reverting ${cur.name} failed: ${errMsg(e)}`);
    }
  }

  app.delete("/api/servers/:id", async (req, res) => {
    const id = param(req, "id");
    repo.get(id);
    if (removing.has(id)) throw new ConflictError("Server is being removed");
    removing.add(id);
    try {
      await editLock.run(async () => {
        repo.get(id);
        // A getter: the adopter re-checks after its firewall step, before deleting the record.
        await adopter.remove(id, () => supervisor.state(id));
      });
    } finally {
      removing.delete(id);
    }
    supervisor.forget(id);
    notify({ type: "removed", serverId: id });
    res.status(204).end();
  });

  // ---------- lifecycle ----------

  /**
   * Starts the supervisor op and waits briefly: an early rejection (409/400) is reported; otherwise the op keeps
   * running in the background (a stop can take up to stopTimeoutSec) and the caller gets 202 with the current view.
   * Start failures after that show up as the server's state detail and over the WebSocket.
   */
  async function begin(op: "start" | "stop" | "restart", id: string): Promise<ServerView> {
    const rec = repo.get(id);
    notBeingRemoved(id);
    const outcome = Promise.resolve()
      .then(() => supervisor[op](id))
      .then(
        () => ({ ok: true as const }),
        (e: unknown) => ({ ok: false as const, e }),
      );
    let timer: NodeJS.Timeout | undefined;
    const early = await Promise.race([
      outcome,
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), opWindowMs);
      }),
    ]);
    clearTimeout(timer);
    if (early && !early.ok) throw early.e;
    if (!early) {
      void outcome.then((o) => {
        if (!o.ok) log(`${op} of ${rec.name} (${id}) failed: ${errMsg(o.e)}`);
      });
    }
    return view(repo.get(id));
  }

  for (const op of ["start", "stop", "restart"] as const) {
    app.post(`/api/servers/:id/${op}`, async (req, res) => {
      res.status(202).json(await begin(op, param(req, "id")));
    });
  }

  app.post("/api/servers/:id/command", async (req, res) => {
    const rec = repo.get(param(req, "id"));
    notBeingRemoved(rec.id);
    const b = bodyObject(req);
    onlyKeys(b, new Set(["command"]));
    const cmd = b.command;
    if (typeof cmd !== "string" || cmd.trim() === "") throw new BadRequestError("Enter a command");
    if (cmd.length > MAX_COMMAND) throw new BadRequestError("Command is too long");
    if (/[\x00-\x1f\x7f]/.test(cmd)) throw new BadRequestError("Command must be a single line");
    if (!view(rec).hasCommands) throw new BadRequestError("This server does not accept commands");
    const output = await supervisor.command(rec.id, cmd.trim());
    const runId = supervisor.state(rec.id).runId ?? rec.currentRunId;
    if (runId) {
      const file = path.join(logsDir, rec.id, runId, "console.log");
      try {
        if (fs.existsSync(file)) {
          await appendSkaliLine(file, `> ${cmd.trim()}`);
          const lines = output.split(/\r?\n/);
          if (lines.length && lines[lines.length - 1] === "") lines.pop();
          for (const l of lines) await appendSkaliLine(file, l);
        }
      } catch (e) {
        log(`Could not append command output to ${file}: ${errMsg(e)}`);
      }
    }
    res.json({ output });
  });

  app.post("/api/servers/:id/eula", (req, res) => {
    const rec = repo.get(param(req, "id"));
    if (rec.game !== "minecraft") throw new BadRequestError("The EULA only applies to Minecraft servers");
    writeEula(rec.folder);
    notify({ type: "changed", serverId: rec.id });
    res.status(204).end();
  });

  // ---------- logs ----------

  app.get("/api/servers/:id/runs", (req, res) => {
    const rec = repo.get(param(req, "id"));
    res.json(listRuns(logsDir, rec.id));
  });

  app.get("/api/servers/:id/runs/:runId/log", async (req, res) => {
    const rec = repo.get(param(req, "id"));
    const runId = param(req, "runId");
    if (!listRuns(logsDir, rec.id).some((r) => r.runId === runId)) throw new NotFoundError("Run not found");
    const file = path.join(logsDir, rec.id, runId, "console.log");
    const safe = `${rec.name}-${runId}.log`.replace(/[^A-Za-z0-9 _.-]/g, "_");
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(file, "r");
    } catch {
      throw new NotFoundError("Run not found");
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}"`);
    // pipeline closes the file (autoClose) when the client aborts or the read fails.
    pipeline(handle.createReadStream(), res, (err) => {
      if (err && (err as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE") log(`Log download failed: ${errMsg(err)}`);
    });
  });

  // ---------- folder picker ----------

  app.get("/api/fs", async (req, res) => {
    const p = req.query.path;
    if (p !== undefined && typeof p !== "string") throw new BadRequestError("path must be a single value");
    res.json(await browse(p));
  });

  // ---------- settings ----------

  app.get("/api/settings", (_req, res) => {
    res.json(settings.get());
  });

  app.put("/api/settings", (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["allowlist", "connectHost"]));
    const patch: Partial<AppSettings> = {};
    if (b.allowlist !== undefined) {
      const list = b.allowlist;
      if (!Array.isArray(list) || !list.every((e) => typeof e === "string" && isValidAllowEntry(e))) {
        throw new BadRequestError("Allowlist entries must be IPv4 addresses or CIDR ranges");
      }
      if (!isAllowed(remoteOf(req), list)) throw new BadRequestError("This would lock out the device you're using");
      patch.allowlist = list;
    }
    if (b.connectHost !== undefined) {
      if (typeof b.connectHost !== "string") throw new BadRequestError("connectHost must be a string");
      patch.connectHost = b.connectHost;
    }
    const out = settings.update(patch);
    notify({ type: "allChanged" });
    res.json(out);
  });

  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // ---------- web UI ----------

  app.use(express.static(webDist, { index: "index.html", dotfiles: "ignore" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const index = path.join(webDist, "index.html");
    if (!fs.existsSync(index)) return void res.status(404).type("text/plain; charset=utf-8").send("Skáli: the web UI is not built.");
    res.sendFile(index);
  });

  // ---------- errors ----------

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      log(`Error after response started (${req.method} ${req.path}): ${errMsg(err)}`);
      res.destroy();
      return;
    }
    const send = (status: number, error: string) => res.status(status).json({ error });
    if (err instanceof BadRequestError) return void send(400, err.message);
    if (err instanceof NotFoundError) return void send(404, err.message);
    if (err instanceof ConflictError) return void send(409, err.message);
    if (err instanceof ExposedError) return void send(err.status, err.message);
    const e = err as { type?: string; status?: number; expose?: boolean };
    if (e && e.type === "entity.too.large") return void send(413, "Request body too large");
    if (e && e.type === "entity.parse.failed") return void send(400, "Malformed JSON");
    if (e && typeof e.status === "number" && e.status >= 400 && e.status < 500 && e.expose) return void send(e.status, "Bad request");
    log(`Internal error on ${req.method} ${req.path}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    send(500, "Internal error");
  });

  return app;
}
