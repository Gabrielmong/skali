import { existsSync } from 'node:fs';
import type { DbProbe } from './db-probe.js';
import { releaseSchemaVersion } from './deploy-steps.js';
import type { DeployEvent } from './history.js';
import type { OpContext } from './op-context.js';
import { releaseDir } from './releases.js';

export const ROLLBACK_BLOCKED = "Can't roll back past a database change; push a fix instead.";
export const ROLLBACK_UNKNOWN = "Can't read the database version right now; try again with Skáli stopped.";
export const ROLLBACK_NO_SCHEMA = "Can't read this release's schema version.";

/** Why a release can't be rolled back to, or undefined when it can: the database's user_version must not exceed the target's schema version. */
export function rollbackBlockedReason(probe: DbProbe | undefined, targetSchemaVersion: number): string | undefined {
  if (!probe) return ROLLBACK_UNKNOWN;
  return probe.userVersion <= targetSchemaVersion ? undefined : ROLLBACK_BLOCKED;
}

/** rollbackBlockedReason against the schema version the release folder carries (unreadable → blocked). */
export function releaseBlockedReason(probe: DbProbe | undefined, dir: string): string | undefined {
  let schema: number;
  try {
    schema = releaseSchemaVersion(dir);
  } catch {
    return ROLLBACK_NO_SCHEMA;
  }
  return rollbackBlockedReason(probe, schema);
}

/** The last database version a probe saw (Skáli stopped), shaped as a probe; undefined when none was ever read. */
export function lastSeenDb(ctx: Pick<OpContext, 'history'>): DbProbe | undefined {
  const v = ctx.history.state().lastDbVersion;
  return v === undefined ? undefined : { userVersion: v, walBytes: 0, servers: [] };
}

export type MarkedEvent = DeployEvent & { canRollback: boolean; rollbackBlockedReason?: string };

const restorable = (e: DeployEvent) =>
  e.sha !== undefined && e.status === 'SUCCEEDED' && (e.kind === 'DEPLOY' || e.kind === 'ROLLBACK');

/**
 * Marks the newest successful event of each kept release (other than the running one) with whether a rollback to it is
 * allowed, judged from the last database version seen. Never probes: the page must not touch a running Skáli's database.
 */
export function markEvents(ctx: OpContext, events: DeployEvent[], runningSha: string | undefined): MarkedEvent[] {
  const state = ctx.history.state();
  const seenDb = lastSeenDb(ctx);
  const verdicts = new Map<string, string | undefined>();
  for (const sha of state.releases) {
    if (sha === runningSha || sha === state.running?.sha) continue;
    let dir: string;
    try {
      dir = releaseDir(ctx.paths, sha);
    } catch {
      continue;
    }
    if (!existsSync(dir)) continue; // nothing to offer
    verdicts.set(sha, releaseBlockedReason(seenDb, dir));
  }
  const seen = new Set<string>();
  return events.map((ev) => {
    if (!restorable(ev) || seen.has(ev.sha!) || !verdicts.has(ev.sha!)) return { ...ev, canRollback: false };
    seen.add(ev.sha!);
    const reason = verdicts.get(ev.sha!);
    return reason === undefined ? { ...ev, canRollback: true } : { ...ev, canRollback: false, rollbackBlockedReason: reason };
  });
}
