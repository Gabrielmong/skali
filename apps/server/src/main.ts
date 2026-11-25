import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import type { SupervisorEvent } from "./proc/supervisor.js";
import { dataPaths, loadConfig, type AppConfig } from "./config.js";
import { ConfigHistory } from "./config/history.js";
import { ConfigService } from "./config/service.js";
import { ConfigSourcesRepo } from "./config/sources-repo.js";
import { openDb } from "./db.js";
import { getAdapter } from "./games/registry.js";
import { createApp } from "./http/app.js";
import { attachWsHub, type WsHub } from "./http/ws-hub.js";
import { createHelper } from "./proc/helper.js";
import { Supervisor } from "./proc/supervisor.js";
import { Installer } from "./jobs/install.js";
import { Updater } from "./jobs/update.js";
import { JobRunner, startGuardReason } from "./jobs/runner.js";
import { loadOrCreateKey } from "./secrets.js";
import { Adopter } from "./servers/adopt.js";
import { ServerRepo } from "./servers/repo.js";
import { SettingsStore } from "./settings.js";
import { grantReadExecute } from "./system/acl.js";
import { ensureGamesUser } from "./system/games-user.js";
import { ensureFirewallRules, removeFirewallRules } from "./system/firewall.js";
import { runPowerShell } from "./system/run.js";
import { JavaTools } from "./tools/java.js";
import { MinecraftSources } from "./tools/minecraft-sources.js";
import { SteamCmd } from "./tools/steamcmd.js";
import { createShutdown } from "./shutdown.js";

const errText = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/** Appends timestamped lines to service.log; never throws. Also echoes to stderr when asked. */
function createLogger(file: string | null): (msg: string, alsoStderr?: boolean) => void {
  return (msg, alsoStderr = false) => {
    const line = `${new Date().toISOString()} ${msg}\r\n`;
    if (file) {
      try {
        fs.appendFileSync(file, line);
      } catch {
        // disk trouble: stderr below is all we have
        alsoStderr = true;
      }
    }
    if (alsoStderr || !file) process.stderr.write(line);
  };
}

// SIDs: Everyone, Authenticated Users, BUILTIN\Users. Read via Get-Acl so non-English Windows names don't matter.
const BROAD_SIDS: Record<string, string> = { "S-1-1-0": "Everyone", "S-1-5-11": "Authenticated Users", "S-1-5-32-545": "Users" };
const ACL_SCRIPT =
  "(Get-Acl -LiteralPath $env:SKALI_DIR).Access | Where-Object { $_.AccessControlType -eq 'Allow' } | " +
  "ForEach-Object { try { $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch {} }";

/** Warns in service.log when the data dir (key, database) is open to ordinary users. Never blocks startup. */
async function warnIfDataDirBroad(dir: string, log: (m: string) => void): Promise<void> {
  try {
    const out = await runPowerShell(ACL_SCRIPT, { SKALI_DIR: dir });
    const broad = [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter((s) => s in BROAD_SIDS))].map((s) => BROAD_SIDS[s]);
    if (broad.length) {
      log(`WARNING: data folder ${dir} grants access to ${broad.join(", ")}; it holds the secret key and database. Restrict it to SYSTEM and Administrators.`);
    }
  } catch (e) {
    log(`Could not check the data folder's permissions: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function main(cfg: AppConfig, log: (msg: string, alsoStderr?: boolean) => void): Promise<void> {
  const paths = dataPaths(cfg.dataDir);
  const devMode = cfg.runAsCurrentUser;
  log(`Skáli starting (data ${cfg.dataDir}, port ${cfg.port}${devMode ? ", run-as-current-user mode" : ""})`);

  const db = openDb(paths.db);
  const key = loadOrCreateKey(paths.secretKey);
  const repo = new ServerRepo(db, key);
  const settings = new SettingsStore(db, cfg.initialAllowlist);
  const helper = createHelper(cfg.helperPath);
  // In run-as-current-user mode (dev/tests) no user is created and the firewall is never touched.
  const gamesUser = await ensureGamesUser(helper, cfg);
  const firewall = devMode
    ? {
        ensure: async (name: string) => log(`(dev) skipping firewall rules for ${name}`),
        remove: async (name: string) => log(`(dev) skipping firewall rule removal for ${name}`),
      }
    : { ensure: ensureFirewallRules, remove: removeFirewallRules };

  const listeners: ((e: SupervisorEvent) => void)[] = [];
  const emitAll = (e: SupervisorEvent): void => {
    for (const l of listeners) {
      try {
        l(e);
      } catch (err) {
        log(`event listener failed: ${errText(err)}`);
      }
    }
  };
  let hub: WsHub | null = null;
  const jobs = new JobRunner({ repo, logsDir: paths.logs, emit: emitAll, changed: (id) => hub?.notify({ type: "changed", serverId: id }) });
  const supervisor = new Supervisor({
    repo,
    helper,
    adapter: getAdapter,
    logsDir: paths.logs,
    gamesUser,
    startGuard: (id) => {
      try {
        return startGuardReason(repo.get(id));
      } catch {
        return null;
      }
    },
    emit: emitAll,
  });
  const adopter = new Adopter({
    repo,
    adapter: getAdapter,
    gamesUser: gamesUser?.name ?? null,
    firewall: (name, ports) => firewall.ensure(name, ports),
    removeFirewall: (name) => firewall.remove(name),
    protectedPaths: { dataDir: cfg.dataDir },
  });

  const configSources = new ConfigSourcesRepo(db);
  const configHistory = new ConfigHistory(path.join(cfg.dataDir, "config-history"));
  // One instance shared by the HTTP config routes and the installer, so saves to a server's files serialize.
  const configService = new ConfigService({
    repo,
    sources: configSources,
    history: configHistory,
    adapterOf: getAdapter,
    runtimeState: (id) => supervisor.state(id),
    now: () => new Date().toISOString(),
  });

  const toolsDir = path.win32.join(cfg.dataDir, "tools");
  // Exactly one SteamCmd: its lock is what keeps a single SteamCMD process across setup lookups and all jobs.
  const steamCmd = new SteamCmd({ toolsDir });
  const gamesUserName = gamesUser?.name ?? null;
  const java = new JavaTools({
    toolsDir,
    // JavaTools passes its own root (<dataDir>\tools\java); never grant the data dir itself (it holds secrets).
    grant: gamesUserName ? (javaRoot) => grantReadExecute(javaRoot, gamesUserName) : async () => undefined,
  });
  const mcSources = new MinecraftSources();
  const installer = new Installer({
    repo,
    runner: jobs,
    adapter: getAdapter,
    steamCmd,
    java,
    mc: mcSources,
    settings,
    configService,
    gamesUser: gamesUserName,
    firewall: (name, ports) => firewall.ensure(name, ports),
    protectedPaths: { dataDir: cfg.dataDir },
  });
  const updater = new Updater({
    repo,
    runner: jobs,
    adapter: getAdapter,
    supervisor,
    steamCmd,
    java,
    mc: mcSources,
    backupsDir: path.win32.join(cfg.dataDir, "backups"),
  });
  const portsInUse = (exceptId?: string) =>
    repo
      .list()
      .filter((s) => s.id !== exceptId)
      .map((s) => {
        try {
          return { name: s.name, ports: getAdapter(s.game).ports(s) };
        } catch {
          return { name: s.name, ports: [] };
        }
      });

  jobs.boot();
  await supervisor.boot();

  const app = createApp({
    repo,
    configSources,
    configHistory,
    configService,
    protectedPaths: { dataDir: cfg.dataDir },
    setup: { steamCmd, java, mcSources, portsInUse, installer, updater },
    supervisor,
    adopter,
    settings,
    logsDir: paths.logs,
    webDist: cfg.webDist,
    job: (id) => jobs.view(id),
    jobReasons: () => jobs.busyReasons(),
    deployerUrl: cfg.deployerUrl,
    deployerTokenFile: cfg.deployerTokenFile,
    firewall,
    log,
    notify: (e) => hub?.notify(e),
  });
  const server = http.createServer(app);
  hub = attachWsHub(server, {
    subscribe: (cb) => {
      listeners.push(cb);
    },
    state: (id) => supervisor.state(id),
    settings,
    job: (id) => jobs.view(id),
    repo,
    logsDir: paths.logs,
    log,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (e) => log(`HTTP server error: ${errText(e)}`));
  log(`Skáli listening on http://0.0.0.0:${cfg.port}`);

  if (!devMode) void warnIfDataDirBroad(cfg.dataDir, log);

  const shutdown = createShutdown({
    supervisor,
    hub: () => hub,
    server,
    db,
    log,
    exit: (code) => process.exit(code),
  });
  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) process.on(sig, () => shutdown(sig));
}

const cfg = loadConfig();
let log: (msg: string, alsoStderr?: boolean) => void;
try {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  fs.mkdirSync(dataPaths(cfg.dataDir).logs, { recursive: true });
  log = createLogger(dataPaths(cfg.dataDir).serviceLog);
} catch (e) {
  log = createLogger(null);
  log(`Cannot create the data folder ${cfg.dataDir}: ${errText(e)}`);
  process.exit(1);
}

process.on("unhandledRejection", (e) => log(`Unhandled rejection: ${errText(e)}`, true));
process.on("uncaughtException", (e) => {
  log(`Uncaught exception: ${errText(e)}`, true);
  process.exit(1);
});

main(cfg, log).catch((e: unknown) => {
  log(`Startup failed: ${errText(e)}`, true);
  // Non-zero so NSSM restarts the service.
  process.exit(1);
});
