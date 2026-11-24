import { existsSync } from 'node:fs';
import { actualRunning } from './actual-running.js';
import { backupDb } from './backup.js';
import type { EventLog } from './event-log.js';
import { probeAndRemember } from './db-probe.js';
import type { DeployEvent } from './history.js';
import { type OpContext, errorText, openLog, short } from './op-context.js';
import { OpError } from './op-error.js';
import { StepError, step } from './op-steps.js';
import { currentTarget, isCurrent, releaseDir } from './releases.js';
import { ROLLBACK_BLOCKED, lastSeenDb, releaseBlockedReason } from './rollback-eligibility.js';
import { activate, currentRelease, ensureStarted, restorePrevious } from './switch-to.js';

const SHA = /^[0-9a-f]{7,40}$/;

/**
 * Throws OpError (400) unless `sha` is one of the helper's own kept releases, not the running one, and not already
 * known to be blocked by the last database version seen. The decisive check is the fresh probe inside rollbackTo.
 */
export function assertCanRollback(ctx: OpContext, sha: string): void {
  if (!SHA.test(sha)) throw new OpError('Not a release', 400);
  const state = ctx.history.state();
  const dir = releaseDir(ctx.paths, sha);
  if (!state.releases.includes(sha) || !existsSync(dir)) throw new OpError(`Unknown release ${short(sha)}`, 400);
  if (state.running?.sha === sha || isCurrent(ctx.paths, sha)) throw new OpError(`Already running ${short(sha)}`, 400);
  const seen = lastSeenDb(ctx);
  if (seen && releaseBlockedReason(seen, dir) === ROLLBACK_BLOCKED) throw new OpError(ROLLBACK_BLOCKED, 400);
}

const messageOf = (ctx: OpContext, sha: string) =>
  ctx.history.events().find((e) => e.sha === sha && e.kind === 'DEPLOY' && e.status === 'SUCCEEDED')?.message ?? '';

/**
 * Stop → fresh probe → (blocked: start again, fail with the reason) → backup (failed: start again, fail with the
 * reason) → switch + settings → start → health. No busy-wait.
 */
async function rollback(ctx: OpContext, sha: string, log: EventLog, prev: string | undefined): Promise<string | undefined> {
  const name = ctx.config.serviceName;
  const still = prev === undefined ? `couldn't switch to ${short(sha)}` : `couldn't switch to ${short(sha)}; still running ${prev}`;
  try {
    await step(log, 'Stop Skáli', () => ctx.sys.serviceStop(name));
  } catch {
    await ensureStarted(ctx, log);
    return still;
  }
  const dir = releaseDir(ctx.paths, sha);
  const probe = await probeAndRemember(ctx, currentTarget(ctx.paths) ?? dir);
  log.line(probe ? `Database version ${probe.userVersion}` : "Couldn't read the database version");
  const blocked = releaseBlockedReason(probe, dir);
  if (blocked !== undefined) {
    log.line(`Not rolling back: ${blocked}`);
    await ensureStarted(ctx, log);
    return blocked;
  }
  try {
    await step(log, 'Back up database', () => backupDb(ctx, sha, log));
  } catch (e) {
    // Nothing was switched: the same release starts again.
    const why = `Not rolling back: the database backup failed (${e instanceof StepError ? e.why : errorText(e)})`;
    log.line(why);
    await ensureStarted(ctx, log);
    return prev === undefined ? why : `${why}; still running ${prev}`;
  }
  if (await activate(ctx, sha, log)) return undefined;
  if (prev === undefined) {
    await ensureStarted(ctx, log);
    return `${short(sha)} didn't come up; there was no previous version to go back to`;
  }
  const back = await restorePrevious(ctx, prev, log);
  return back === 'restored'
    ? `${short(sha)} didn't come up; switched back to ${prev}`
    : back === 'stayed'
      ? still
      : `${short(sha)} didn't come up; switching back to ${prev} also failed`;
}

export async function rollbackTo(ctx: OpContext, sha: string, by: string): Promise<DeployEvent> {
  assertCanRollback(ctx, sha);
  const message = messageOf(ctx, sha);
  const ev = ctx.history.start({ kind: 'ROLLBACK', sha, message, by });
  const { log, redact } = openLog(ctx, ev.id);
  const prev = currentRelease(ctx);
  let detail: string | undefined;
  try {
    detail = await rollback(ctx, sha, log, prev);
    if (detail === undefined) {
      ctx.history.update({
        running: { sha, message, deployedAt: ctx.now().toISOString() },
        autoDeploy: { on: false, reason: `rolled back to ${short(sha)}` },
      });
    }
  } catch (e) {
    detail = `Rollback stopped unexpectedly: ${errorText(e)}`;
    await ensureStarted(ctx, log);
  }
  if (detail !== undefined) {
    log.line(`✖ ${detail}`);
    const running = actualRunning(ctx); // a failed switch back may have left the target in place
    if (running) ctx.history.update({ running });
  }
  ctx.history.finish(ev.id, detail === undefined ? 'SUCCEEDED' : 'FAILED', detail === undefined ? undefined : redact(detail));
  return ctx.history.events().find((e) => e.id === ev.id) ?? ev;
}

