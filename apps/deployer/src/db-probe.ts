import path from 'node:path';
import type { OpContext } from './op-context.js';

export type DbProbe = {
  userVersion: number;
  walBytes: number;
  servers: { id: string; pid: number | null; desired: string }[];
};

export const dbPath = (ctx: Pick<OpContext, 'config'>) => path.join(ctx.config.dataDir, 'skali.db');

function parse(text: string): DbProbe | undefined {
  try {
    const p = JSON.parse(text) as DbProbe;
    if (typeof p.userVersion !== 'number' || typeof p.walBytes !== 'number' || !Array.isArray(p.servers)) return undefined;
    return p;
  } catch {
    return undefined;
  }
}

/**
 * Reads the database with the release's own probe. Run only while Skáli is stopped (the caller's job).
 * Undefined when the probe fails, prints something unreadable, or an unclean shutdown left an uncommitted log (walBytes > 0).
 */
export async function probeDb(ctx: OpContext, releaseDir: string): Promise<DbProbe | undefined> {
  const lines: string[] = [];
  try {
    await ctx.sys.run(
      ctx.config.bin.node,
      [path.join(releaseDir, 'apps', 'server', 'dist', 'deploy-probe.js'), dbPath(ctx)],
      { timeoutMs: ctx.config.stepTimeoutsMs.backup, onLine: (l) => lines.push(l) },
    );
  } catch {
    return undefined;
  }
  const last = lines.map((l) => l.trim()).filter(Boolean).at(-1);
  const probe = last === undefined ? undefined : parse(last);
  return probe && probe.walBytes === 0 ? probe : undefined;
}

/** probeDb, remembering the version it read as history's lastDbVersion (what the page's rollback buttons go by). Skáli must be stopped. */
export async function probeAndRemember(ctx: OpContext, releaseDir: string): Promise<DbProbe | undefined> {
  const probe = await probeDb(ctx, releaseDir);
  if (probe) ctx.history.update({ lastDbVersion: probe.userVersion });
  return probe;
}
