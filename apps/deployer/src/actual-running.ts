import type { DeployerState } from './history.js';
import { type OpContext, short } from './op-context.js';
import { currentRelease } from './switch-to.js';

type Running = NonNullable<DeployerState['running']>;

/**
 * What `current` really points at, as a `state.running` value, for when a failure left
 * something other than the recorded release in place (or setup's bootstrap release with an
 * empty history). The commit message comes from history when known, otherwise "(unknown)".
 * Undefined when nothing is current.
 */
export function actualRunning(ctx: OpContext): Running | undefined {
  const name = currentRelease(ctx)?.toLowerCase();
  if (name === undefined) return undefined;
  const { running, releases } = ctx.history.state();
  if (running && short(running.sha) === name) return running;
  const known = ctx.history.events().find((e) => e.sha !== undefined && short(e.sha) === name && e.message);
  const sha = known?.sha ?? releases.find((s) => short(s) === name) ?? name;
  return { sha, message: known?.message ?? '(unknown)', deployedAt: ctx.now().toISOString() };
}
