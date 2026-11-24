import type { DeployEvent } from './history.js';
import { type OpContext, openLog } from './op-context.js';
import { step } from './op-steps.js';
import { checkHealth } from './switch-to.js';

export const RESTART_FAILED = "Skáli didn't come up after restart";

/** `nssm restart Skali`, then the same health check as a deploy. No busy-wait: the owner chose the moment. */
export async function restartApp(ctx: OpContext, by: string): Promise<DeployEvent> {
  const running = ctx.history.state().running;
  const ev = ctx.history.start({ kind: 'RESTART', sha: running?.sha, message: running?.message, by });
  const { log } = openLog(ctx, ev.id);
  let ok = false;
  try {
    await step(log, 'Restart Skáli', () => ctx.sys.serviceRestart(ctx.config.serviceName));
    ok = await checkHealth(ctx, log);
  } catch {
    ok = false; // logged by step
  }
  if (!ok) log.line(`✖ ${RESTART_FAILED}`);
  ctx.history.finish(ev.id, ok ? 'SUCCEEDED' : 'FAILED', ok ? undefined : RESTART_FAILED);
  return ctx.history.events().find((e) => e.id === ev.id) ?? ev;
}
