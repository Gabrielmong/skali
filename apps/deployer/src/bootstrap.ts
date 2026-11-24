import path from 'node:path';
import { actualRunning } from './actual-running.js';
import { backupDb, restoreDb } from './backup.js';
import { type DbProbe, probeAndRemember } from './db-probe.js';
import { sameServers } from './deploy.js';
import { buildRelease, removeRelease } from './deploy-steps.js';
import type { EventLog } from './event-log.js';
import type { DeployEvent } from './history.js';
import { type OpContext, errorText, openLog } from './op-context.js';
import { runScript, step } from './op-steps.js';
import { assertSha, currentTarget, releaseDir, removeCurrent } from './releases.js';
import { activate, checkHealth, ensureStarted } from './switch-to.js';

/**
 * Who a bootstrap event is by. Only this path records it: the API's parseCommand accepts "auto" and "you" only,
 * so nothing reaching the helper over HTTP can claim to be setup.
 */
export const BOOTSTRAP_BY = 'setup';

/** A failed bootstrap's event detail (and setup's exit message). */
export const BOOTSTRAP_TEXT = {
  noMessage: '(installed by setup)',
  down: "app didn't come up",
  restored: 'restored the previous install',
  restoreFailed: (from: string) =>
    `restoring the previous install also failed; run ${path.win32.join(from, 'scripts', 'install-service.ps1')} from an elevated PowerShell`,
  stays: 'the new release stays in place (NSSM keeps restarting it)',
  finishing: 'finishing the bootstrap (it puts Skáli back on failure)',
} as const;

/** Signals the bootstrap outlives: Ctrl+C / Ctrl+Break in setup's console, and a stop request. */
export const BOOTSTRAP_SIGNALS = ['SIGINT', 'SIGBREAK', 'SIGTERM'] as const;

/**
 * While a bootstrap runs, an interrupt must not kill it between "stop Skali" and "start Skali": each signal is logged
 * and otherwise ignored (as the service finishes its operation before exiting). Returns a function removing the handlers.
 */
export function holdSignals(
  proc: Pick<NodeJS.EventEmitter, 'on' | 'off'>,
  say: (message: string) => void,
): () => void {
  const handlers = BOOTSTRAP_SIGNALS.map((sig) => {
    const h = () => say(`${sig}: ${BOOTSTRAP_TEXT.finishing}`);
    proc.on(sig, h);
    return [sig, h] as const;
  });
  return () => {
    for (const [sig, h] of handlers) proc.off(sig, h);
  };
}

const GIT_LOG_TIMEOUT_MS = 30_000;

export interface CliArgs {
  config?: string;
  bootstrap?: { sha: string; from: string };
}

/** `main.js [config] [--bootstrap <sha> --from <existing install>]`, flags in any order. */
export function parseCliArgs(argv: string[]): CliArgs {
  let config: string | undefined;
  let sha: string | undefined;
  let from: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--bootstrap' || a === '--from') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--bootstrap') sha = v;
      else from = v;
    } else if (a.startsWith('--')) {
      throw new Error(`Unknown option ${a}`);
    } else if (config !== undefined) {
      throw new Error(`Unexpected argument ${a}`);
    } else {
      config = a;
    }
  }
  if (sha !== undefined && from === undefined) throw new Error('--bootstrap needs --from <the existing install>');
  if (from !== undefined && sha === undefined) throw new Error('--from is only used with --bootstrap <sha>');
  return {
    ...(config !== undefined ? { config } : {}),
    ...(sha !== undefined && from !== undefined ? { bootstrap: { sha, from } } : {}),
  };
}

type Outcome = { ok: true } | { ok: false; detail: string };
const failed = (detail: string): Outcome => ({ ok: false, detail });

async function commitMessage(ctx: OpContext, sha: string): Promise<string> {
  const lines: string[] = [];
  try {
    await ctx.sys.run(ctx.config.bin.git, ['-C', ctx.paths.repo, 'log', '-1', '--format=%s', sha], {
      env: ctx.gitLocalEnv(),
      timeoutMs: GIT_LOG_TIMEOUT_MS,
      onLine: (l) => lines.push(l),
    });
  } catch {
    return BOOTSTRAP_TEXT.noMessage;
  }
  return lines.map((l) => l.trim()).find(Boolean) ?? BOOTSTRAP_TEXT.noMessage;
}

/** Reads the database with Skáli stopped; undefined when it can't be trusted. Never throws. */
async function readDb(ctx: OpContext, log: EventLog, dir: string): Promise<DbProbe | undefined> {
  try {
    return await step(log, 'Read database', async () => {
      const probe = await probeAndRemember(ctx, dir);
      log.line(probe ? `Database version ${probe.userVersion}` : "Couldn't read the database version");
      return probe;
    });
  } catch {
    return undefined;
  }
}

/**
 * Puts the Skali service back on the -From install (install-service.ps1's settings with AppDirectory = from, applied by
 * the release's own apply-service-settings.ps1), removes `current`, starts Skáli and checks health. Skáli must be stopped.
 */
async function restoreInstall(ctx: OpContext, sha: string, from: string, log: EventLog): Promise<Outcome> {
  const { serviceName, root, bin, stepTimeoutsMs } = ctx.config;
  const down = `${BOOTSTRAP_TEXT.down}; ${BOOTSTRAP_TEXT.restoreFailed(from)}`;
  try {
    await step(log, 'Restore previous install', async () => {
      log.line(`Skali -> ${from}`);
      const args = ['-Service', serviceName, '-Root', root, '-Node', bin.node, '-AppDirectory', from];
      await runScript(ctx, log, releaseDir(ctx.paths, sha), 'apply-service-settings', args, stepTimeoutsMs.settings);
      removeCurrent(ctx.paths);
    });
    await step(log, 'Start Skáli', () => ctx.sys.serviceStart(serviceName));
  } catch {
    await ensureStarted(ctx, log);
    return failed(down);
  }
  if (!(await checkHealth(ctx, log))) return failed(down);
  log.line(`Skali runs from ${from} again`);
  return failed(`${BOOTSTRAP_TEXT.down}; ${BOOTSTRAP_TEXT.restored} (${from})`);
}

/** The new release failed its health check: go back to -From when the database allows it (deploy's rules). */
async function afterFailedStart(
  ctx: OpContext,
  sha: string,
  from: string,
  before: DbProbe | undefined,
  backupDir: string,
  log: EventLog,
): Promise<Outcome> {
  const leave = async (why: string): Promise<Outcome> => {
    log.line(`${why}; leaving the new release running`);
    await ensureStarted(ctx, log);
    return failed(`${BOOTSTRAP_TEXT.down}; ${why}, so ${BOOTSTRAP_TEXT.stays}`);
  };
  const dir = releaseDir(ctx.paths, sha);
  try {
    await step(log, 'Stop Skáli', () => ctx.sys.serviceStop(ctx.config.serviceName));
  } catch {
    return leave("Skáli didn't stop, so the database can't be read");
  }
  const after = await readDb(ctx, log, dir);
  if (!before || !after) return leave("the database version can't be read");
  if (after.userVersion !== before.userVersion) {
    if (!sameServers(before, after)) return leave('the database changed and a game was started or stopped during the check');
    log.line('The database changed, but no game was started or stopped; restoring the backup');
    try {
      await step(log, 'Restore database', () => restoreDb(ctx, backupDir, log));
      ctx.history.update({ lastDbVersion: before.userVersion });
    } catch {
      return leave("the backup couldn't be restored");
    }
  }
  return restoreInstall(ctx, sha, from, log);
}

async function bootstrap(ctx: OpContext, sha: string, from: string, log: EventLog): Promise<Outcome> {
  const dir = releaseDir(ctx.paths, sha);
  const service = ctx.config.serviceName;
  const still = (why: string) => `${why}; Skáli still runs from ${from}`;

  try {
    await buildRelease(ctx, sha, dir, log);
  } catch (e) {
    removeRelease(ctx, sha, log);
    return failed(still(errorText(e)));
  }
  try {
    await step(log, 'Stop Skáli', () => ctx.sys.serviceStop(service));
  } catch (e) {
    await ensureStarted(ctx, log);
    return failed(still(errorText(e)));
  }
  // The database the -From install left. Its schema is the -From HEAD's, which is `sha` (setup builds exactly that
  // commit), so the new release's probe can read it.
  const before = await readDb(ctx, log, dir);
  let backupDir: string;
  try {
    backupDir = await step(log, 'Back up database', () => backupDb(ctx, sha, log));
  } catch (e) {
    await ensureStarted(ctx, log); // nothing was switched: the -From install starts again
    return failed(still(errorText(e)));
  }
  if (await activate(ctx, sha, log)) return { ok: true };
  return afterFailedStart(ctx, sha, from, before, backupDir, log);
}

function record(ctx: OpContext, sha: string, message: string, outcome: Outcome): void {
  const state = ctx.history.state();
  if (!outcome.ok) {
    const failedShas = state.failedShas.includes(sha) ? state.failedShas : [...state.failedShas, sha];
    const running = actualRunning(ctx); // set only when the new release was left in place
    ctx.history.update({ failedShas, ...(running ? { running } : {}) });
    return;
  }
  // In releases, so the page offers it for rollback and pruning never treats it as unknown.
  const running = { sha, message, deployedAt: ctx.now().toISOString() };
  const releases = [sha, ...state.releases.filter((s) => s !== sha)].slice(0, ctx.config.keepReleases);
  ctx.history.update({ running, releases, failedShas: state.failedShas.filter((s) => s !== sha) });
}

/**
 * Setup's one-time move of Skáli from the -From clone to the release layout: build `sha` (the clone's HEAD, which must be
 * on origin) as releases\<sha7>, then stop → probe → back up → switch `current` → apply settings → start → health.
 * Records a DEPLOY event by "setup". A build, stop or backup failure leaves Skali on -From (started again). A failed
 * health check puts Skali back on -From only when that is safe (afterFailedStart, the deploy rules of spec §5): when
 * the database can't be read, or changed while a game was started or stopped, the new release stays running instead.
 * Throws before doing anything when `current` already exists, or for a bad sha or a relative -From.
 */
export async function bootstrapRelease(ctx: OpContext, sha: string, from: string): Promise<DeployEvent> {
  assertSha(sha);
  if (!path.win32.isAbsolute(from) || !/^[A-Za-z]:\\/.test(from)) throw new Error(`--from must be an absolute path: ${from}`);
  if (currentTarget(ctx.paths) !== undefined) {
    throw new Error(`${ctx.paths.current} already exists: setup bootstraps only once (re-running setup only updates the helper)`);
  }
  const message = await commitMessage(ctx, sha);
  const ev = ctx.history.start({ kind: 'DEPLOY', sha, message, by: BOOTSTRAP_BY });
  const { log, redact } = openLog(ctx, ev.id);
  let outcome: Outcome;
  try {
    outcome = await bootstrap(ctx, sha, from, log);
  } catch (e) {
    outcome = failed(`Setup stopped unexpectedly: ${errorText(e)}`);
    await ensureStarted(ctx, log);
  }
  if (!outcome.ok) log.line(`✖ ${outcome.detail}`);
  record(ctx, sha, message, outcome);
  ctx.history.finish(ev.id, outcome.ok ? 'SUCCEEDED' : 'FAILED', outcome.ok ? undefined : redact(outcome.detail));
  return ctx.history.events().find((e) => e.id === ev.id) ?? ev;
}
