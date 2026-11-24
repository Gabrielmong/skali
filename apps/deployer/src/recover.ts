import { existsSync } from 'node:fs';
import { actualRunning } from './actual-running.js';
import { probeAndRemember } from './db-probe.js';
import type { EventLog } from './event-log.js';
import type { DeployEvent } from './history.js';
import { type OpContext, errorText, openLog, short } from './op-context.js';
import { applySettings, step } from './op-steps.js';
import { currentTarget, releaseDir, switchCurrent } from './releases.js';
import { releaseBlockedReason } from './rollback-eligibility.js';
import { currentRelease } from './switch-to.js';

export const INTERRUPTED = 'helper stopped during this';

/**
 * An interrupted deploy or rollback may have left `current` on a release that never passed its health check while
 * `state.running` (the last good one) is another. Go back to the last good release when the database allows it
 * (fresh probe with Skáli stopped, same rule as a rollback); otherwise stay on current. Skáli is left stopped; the
 * caller starts it.
 */
async function backToLastGood(ctx: OpContext, log: EventLog): Promise<void> {
  const good = ctx.history.state().running?.sha;
  const cur = currentRelease(ctx)?.toLowerCase();
  if (good === undefined || cur === undefined || short(good) === cur) return;
  const goodDir = releaseDir(ctx.paths, good);
  if (!existsSync(goodDir)) return;
  log.line(`current points at ${cur}, but ${short(good)} was the last good release`);
  await step(log, 'Stop Skáli', () => ctx.sys.serviceStop(ctx.config.serviceName));
  const probe = await probeAndRemember(ctx, goodDir);
  const blocked = releaseBlockedReason(probe, goodDir);
  if (blocked !== undefined) {
    log.line(`Staying on ${cur}: ${blocked}`);
    return;
  }
  await step(log, 'Switch', async () => {
    log.line(`current -> ${short(good)}`);
    switchCurrent(ctx.paths, good);
    await applySettings(ctx, log, good);
  });
}

/**
 * On helper start: close events a crash left RUNNING, undo a half-done switch when safe, and make sure Skáli runs.
 *
 * Skáli is never left stopped: starting it (when `current` exists and it is stopped) runs in a `finally`, and each
 * history write is guarded, so one bad event or an unwritable history.json can't abort recovery.
 *
 * Note: a crash after a deploy's health check passed but before its event was recorded looks exactly like a
 * half-done switch (`current` ≠ `state.running`). It is treated as one: reverted to the last good release if the
 * database allows (fresh probe), and its sha is marked failed. "Deploy now" retries it.
 */
export async function recoverOnStart(ctx: OpContext): Promise<void> {
  const { history } = ctx;
  let log: EventLog | undefined;
  try {
    const interrupted: DeployEvent[] = history.events().filter((e) => e.status === 'RUNNING');
    for (const ev of interrupted) {
      try {
        const l = openLog(ctx, ev.id).log;
        l.line(`✖ ${INTERRUPTED}`);
        log ??= l;
      } catch {
        // the event is closed below either way
      }
      try {
        history.finish(ev.id, 'FAILED', INTERRUPTED);
        const failedShas = history.state().failedShas;
        if (ev.kind === 'DEPLOY' && ev.sha && !failedShas.includes(ev.sha)) {
          history.update({ failedShas: [...failedShas, ev.sha] }); // every failed deploy is never auto-retried
        }
      } catch (e) {
        console.error(`Recovery couldn't close event ${ev.id}: ${errorText(e)}`);
      }
    }
    if (currentTarget(ctx.paths) === undefined) return; // setup hasn't made a release yet: nothing of ours to start
    if (log && interrupted.some((e) => e.kind === 'DEPLOY' || e.kind === 'ROLLBACK')) {
      try {
        await backToLastGood(ctx, log);
      } catch (e) {
        console.error(`Recovery couldn't go back to the last good release: ${errorText(e)}`);
      }
    }
  } catch (e) {
    console.error(`Recovery failed: ${errorText(e)}`);
  } finally {
    await startIfStopped(ctx, log);
  }
}

/** Starts Skáli when `current` exists and the service is stopped, then records what runs. Never throws. */
async function startIfStopped(ctx: OpContext, log: EventLog | undefined): Promise<void> {
  if (currentTarget(ctx.paths) === undefined) return;
  const name = ctx.config.serviceName;
  try {
    if ((await ctx.sys.serviceStatus(name)) === 'stopped') {
      try {
        log?.line('Starting Skáli');
      } catch {
        // logging must not keep Skáli down
      }
      await ctx.sys.serviceStart(name);
    }
  } catch (e) {
    console.error(`Recovery couldn't start ${name}: ${errorText(e)}`); // the status page shows Skáli is down
  }
  try {
    const running = actualRunning(ctx);
    if (running) ctx.history.update({ running });
  } catch {
    // best effort
  }
}
