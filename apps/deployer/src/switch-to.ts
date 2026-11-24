import path from 'node:path';
import type { EventLog } from './event-log.js';
import { type OpContext, healthUrl, short } from './op-context.js';
import { applySettings, step } from './op-steps.js';
import { currentTarget, isCurrent, switchCurrent } from './releases.js';

/** Short sha of the release `current` points at, if any. */
export function currentRelease(ctx: OpContext): string | undefined {
  const target = currentTarget(ctx.paths);
  return target === undefined ? undefined : path.basename(target);
}

/** GET /api/games on Skáli until it answers 2xx, up to healthTimeoutMs (60 s). Never throws. */
export async function checkHealth(ctx: OpContext, log: EventLog): Promise<boolean> {
  try {
    return await step(log, 'Health', async () => {
      const url = healthUrl(ctx.config);
      const { healthTimeoutMs } = ctx.config;
      log.line(`GET ${url}`);
      if (!(await ctx.sys.healthy(url, healthTimeoutMs))) {
        throw new Error(`no answer within ${Math.round(healthTimeoutMs / 1000)} s`);
      }
      return true;
    });
  } catch {
    return false;
  }
}

/** Points `current` at the release, applies its service settings, starts Skáli and checks health. Skáli must be stopped. */
export async function activate(ctx: OpContext, sha: string, log: EventLog): Promise<boolean> {
  try {
    await step(log, 'Switch', async () => {
      log.line(`current -> ${short(sha)}`);
      switchCurrent(ctx.paths, sha);
      await applySettings(ctx, log, sha);
    });
    await step(log, 'Start Skáli', () => ctx.sys.serviceStart(ctx.config.serviceName));
  } catch {
    return false;
  }
  return checkHealth(ctx, log);
}

/** stop → switch → apply settings → start → health. Does not switch when Skáli won't stop. */
export async function switchTo(ctx: OpContext, sha: string, log: EventLog): Promise<boolean> {
  try {
    await step(log, 'Stop Skáli', () => ctx.sys.serviceStop(ctx.config.serviceName));
  } catch {
    return false;
  }
  return activate(ctx, sha, log);
}

/** Starts Skáli if it is stopped (not when pending, missing or unknown). Never throws. */
export async function ensureStarted(ctx: OpContext, log: EventLog): Promise<void> {
  const name = ctx.config.serviceName;
  try {
    if ((await ctx.sys.serviceStatus(name)) === 'stopped') await step(log, 'Start Skáli', () => ctx.sys.serviceStart(name));
  } catch {
    // already logged by step, or the status couldn't be read
  }
}

/**
 * After a failed switch: when `current` still points at `prev` make sure it runs ("stayed"),
 * otherwise switch back to it ("restored", or "failed" if that didn't come up either; Skáli is then left started).
 */
export async function restorePrevious(
  ctx: OpContext,
  prev: string,
  log: EventLog,
): Promise<'stayed' | 'restored' | 'failed'> {
  if (isCurrent(ctx.paths, prev)) {
    await ensureStarted(ctx, log);
    return 'stayed';
  }
  log.line(`Switching back to ${prev}`);
  if (await switchTo(ctx, prev, log)) return 'restored';
  await ensureStarted(ctx, log);
  return 'failed';
}
