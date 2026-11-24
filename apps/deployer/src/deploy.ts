import { actualRunning } from './actual-running.js';
import { backupDb, restoreDb } from './backup.js';
import { waitUntilIdle } from './busy.js';
import { type DbProbe, probeAndRemember } from './db-probe.js';
import { buildRelease, removeRelease } from './deploy-steps.js';
import type { EventLog } from './event-log.js';
import type { Commit } from './github.js';
import type { DeployEvent } from './history.js';
import { type OpContext, errorText, openLog } from './op-context.js';
import { step } from './op-steps.js';
import { currentTarget, pruneReleases, releaseDir } from './releases.js';
import { activate, currentRelease, ensureStarted, restorePrevious } from './switch-to.js';

export type { OpContext } from './op-context.js';

/** A failed deploy's event detail; the page shows "failed (<detail>)". */
export const DEPLOY_TEXT = {
  rolledBack: 'rolled back automatically',
  restored: 'rolled back, database restored',
  down: "app didn't come up",
} as const;

export interface DeployOptions {
  /** Wait for Skáli to finish starting/stopping servers before stopping it. Default: only for by "auto". */
  waitForIdle?: boolean;
  /** The commit's `CI` run, shown with the event. */
  ciRunUrl?: string;
}

type Outcome = { ok: true } | { ok: false; detail: string };

const failed = (detail: string): Outcome => ({ ok: false, detail });

/** What a failed health check decides with. */
interface Window {
  old: string | undefined; // short sha of the release that ran before
  dir: string; // the new release
  before: DbProbe | undefined;
  /** The backup this deploy just made (never anything a caller passed in). */
  backupDir: string;
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

/** The same servers, each with the same pid and desired state: no game was started or stopped. */
export function sameServers(a: DbProbe, b: DbProbe): boolean {
  if (a.servers.length !== b.servers.length) return false;
  const byId = new Map(a.servers.map((s) => [s.id, s]));
  return b.servers.every((s) => {
    const o = byId.get(s.id);
    return o !== undefined && o.pid === s.pid && o.desired === s.desired;
  });
}

async function switchBack(ctx: OpContext, old: string, text: string, log: EventLog): Promise<Outcome> {
  const back = await restorePrevious(ctx, old, log);
  return back === 'failed' ? failed(`${DEPLOY_TEXT.down}; switching back to ${old} also failed`) : failed(text);
}

/** Health failed after the switch: stop the new Skáli, read the database, then pick one of the three outcomes. */
async function afterFailedStart(ctx: OpContext, w: Window, log: EventLog): Promise<Outcome> {
  const leave = async (why: string): Promise<Outcome> => {
    log.line(`${why}; leaving the new release running`);
    await ensureStarted(ctx, log);
    return failed(DEPLOY_TEXT.down);
  };
  try {
    await step(log, 'Stop Skáli', () => ctx.sys.serviceStop(ctx.config.serviceName));
  } catch {
    return leave("Skáli didn't stop, so the database can't be read");
  }
  const after = await readDb(ctx, log, w.dir);
  const { before, old } = w;
  if (old === undefined) return leave('There is no previous release to go back to');
  if (!before || !after) return leave("The database version can't be read");
  if (after.userVersion === before.userVersion) {
    log.line('The database version did not change; switching back');
    return switchBack(ctx, old, DEPLOY_TEXT.rolledBack, log);
  }
  if (!sameServers(before, after)) return leave('A game was started or stopped during the check');
  log.line('The database changed, but no game was started or stopped; restoring the backup');
  try {
    await step(log, 'Restore database', () => restoreDb(ctx, w.backupDir, log));
    // The backup was taken right after the `before` probe, so the database is that version again.
    ctx.history.update({ lastDbVersion: before.userVersion });
  } catch {
    // restoreDb leaves either database whole; the new release migrates either on start.
    return leave("The backup couldn't be restored");
  }
  return switchBack(ctx, old, DEPLOY_TEXT.restored, log);
}

async function deploy(ctx: OpContext, commit: Commit, log: EventLog, waitForIdle: boolean): Promise<Outcome> {
  const { sha } = commit;
  const dir = releaseDir(ctx.paths, sha);
  const old = currentRelease(ctx);
  const oldDir = currentTarget(ctx.paths);
  const still = (why: string) => (old === undefined ? why : `${why}; still running ${old}`);
  const service = ctx.config.serviceName;

  try {
    await buildRelease(ctx, sha, dir, log);
  } catch (e) {
    removeRelease(ctx, sha, log);
    return failed(still(errorText(e)));
  }

  if (waitForIdle) await waitUntilIdle(ctx, log);

  try {
    await step(log, 'Stop Skáli', () => ctx.sys.serviceStop(service));
  } catch (e) {
    await ensureStarted(ctx, log);
    return failed(still(errorText(e)));
  }

  // Only now, with Skáli stopped: a running Skáli's WAL is never empty, so the probe would say "unknown".
  const before = await readDb(ctx, log, oldDir ?? dir);

  let backupDir: string;
  try {
    backupDir = await step(log, 'Back up database', () => backupDb(ctx, sha, log));
  } catch (e) {
    await ensureStarted(ctx, log); // nothing was switched: the old release starts again
    return failed(still(errorText(e)));
  }

  if (await activate(ctx, sha, log)) return { ok: true };
  return afterFailedStart(ctx, { old, dir, before, backupDir }, log);
}

function record(ctx: OpContext, commit: Commit, outcome: Outcome, log: EventLog): void {
  const { sha, message } = commit;
  const state = ctx.history.state();
  if (!outcome.ok) {
    // state.running follows what `current` really points at (it may be the new, failed release).
    const failedShas = state.failedShas.includes(sha) ? state.failedShas : [...state.failedShas, sha];
    const running = actualRunning(ctx);
    ctx.history.update({ failedShas, ...(running ? { running } : {}) });
    return;
  }
  const running = { sha, message, deployedAt: ctx.now().toISOString() };
  const releases = [sha, ...state.releases.filter((s) => s !== sha)].slice(0, ctx.config.keepReleases);
  ctx.history.update({ running, releases, failedShas: state.failedShas.filter((s) => s !== sha) });
  const current = currentRelease(ctx);
  try {
    pruneReleases(ctx.paths, [...releases, sha, ...(current ? [current] : [])]);
  } catch (e) {
    log.line(`Couldn't remove old releases: ${errorText(e)}`);
  }
}

export async function deployCommit(ctx: OpContext, commit: Commit, by: string, opts: DeployOptions = {}): Promise<DeployEvent> {
  const ev = ctx.history.start({
    kind: 'DEPLOY',
    sha: commit.sha,
    message: commit.message,
    by,
    ...(opts.ciRunUrl ? { ciRunUrl: opts.ciRunUrl } : {}),
  });
  const { log, redact } = openLog(ctx, ev.id);
  let outcome: Outcome;
  try {
    outcome = await deploy(ctx, commit, log, opts.waitForIdle ?? by === 'auto');
  } catch (e) {
    outcome = failed(`Deploy stopped unexpectedly: ${errorText(e)}`);
    await ensureStarted(ctx, log);
  }
  if (!outcome.ok) log.line(`✖ ${outcome.detail}`);
  record(ctx, commit, outcome, log);
  ctx.history.finish(ev.id, outcome.ok ? 'SUCCEEDED' : 'FAILED', outcome.ok ? undefined : redact(outcome.detail));
  return ctx.history.events().find((e) => e.id === ev.id) ?? ev;
}
