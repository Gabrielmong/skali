import type { DeployerConfig } from './config.js';
import type { EventLog } from './event-log.js';
import { type OpContext, errorText } from './op-context.js';
import { step } from './op-steps.js';

/** How often a busy Skáli is asked again. */
export const BUSY_POLL_MS = 15_000;
const ASK_TIMEOUT_MS = 5_000;

export type IdleResult = 'idle' | 'unreachable' | 'timeout';

/** Skáli's loopback-only route that says whether a server is starting or stopping. */
export function busyUrl(config: Pick<DeployerConfig, 'appPort'>): string {
  return `http://127.0.0.1:${config.appPort}/api/deploys/busy`;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type Answer = { busy: false } | { busy: true; reasons: string[] } | { error: string };

async function ask(ctx: OpContext): Promise<Answer> {
  let status: number;
  let body: string;
  try {
    ({ status, body } = await ctx.sys.httpGet(busyUrl(ctx.config), ASK_TIMEOUT_MS));
  } catch (e) {
    return { error: errorText(e) };
  }
  if (status !== 200) return { error: `it answered ${status}` };
  try {
    const parsed = JSON.parse(body) as { busy?: unknown; reasons?: unknown };
    if (typeof parsed.busy !== 'boolean') return { error: 'its answer had no "busy"' };
    if (!parsed.busy) return { busy: false };
    const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.filter((r): r is string => typeof r === 'string') : [];
    return { busy: true, reasons };
  } catch {
    return { error: 'its answer was not JSON' };
  }
}

/**
 * Before an auto-deploy stops Skáli: waits while Skáli says a server is starting or stopping, asking every 15 s.
 * Returns when it is idle, at once when it can't be asked (a broken Skáli must still get its fix), or after `maxMs`
 * ("switching anyway"). Never throws.
 */
export async function waitUntilIdle(ctx: OpContext, log: EventLog, maxMs = ctx.config.busyWaitMs): Promise<IdleResult> {
  try {
    return await step(log, 'Wait for Skáli to be idle', async () => {
      const deadline = Date.now() + maxMs;
      let lastReasons: string | undefined;
      for (;;) {
        const answer = await ask(ctx);
        if ('error' in answer) {
          log.line(`Couldn't ask Skáli whether it is busy (${answer.error}); going ahead`);
          return 'unreachable' as const;
        }
        if (!answer.busy) {
          log.line(lastReasons === undefined ? 'Skáli is idle' : 'Skáli is idle now');
          return 'idle' as const;
        }
        const reasons = answer.reasons.join('; ') || 'busy';
        if (reasons !== lastReasons) log.line(`Skáli is busy: ${reasons}`);
        lastReasons = reasons;
        const left = deadline - Date.now();
        if (left <= 0) {
          log.line(`Skáli is still busy after ${Math.round(maxMs / 60_000)} min; switching anyway`);
          return 'timeout' as const;
        }
        await sleep(Math.min(BUSY_POLL_MS, left));
      }
    });
  } catch {
    return 'unreachable'; // only a log write can fail here; never hold a deploy on it
  }
}
