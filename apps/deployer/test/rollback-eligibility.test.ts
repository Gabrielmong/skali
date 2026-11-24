import { describe, expect, it } from 'vitest';
import type { DbProbe } from '../src/db-probe.js';
import { ROLLBACK_BLOCKED, ROLLBACK_UNKNOWN, rollbackBlockedReason } from '../src/rollback-eligibility.js';

const probe = (userVersion: number): DbProbe => ({ userVersion, walBytes: 0, servers: [] });

describe('rollbackBlockedReason', () => {
  it('allows an equal version', () => expect(rollbackBlockedReason(probe(5), 5)).toBeUndefined());
  it('allows an older database', () => expect(rollbackBlockedReason(probe(3), 5)).toBeUndefined());
  it('blocks a newer database', () => {
    expect(rollbackBlockedReason(probe(6), 5)).toBe(ROLLBACK_BLOCKED);
    expect(ROLLBACK_BLOCKED).toBe("Can't roll back past a database change; push a fix instead.");
  });
  it('says it cannot read the version when there is no probe', () => {
    expect(rollbackBlockedReason(undefined, 5)).toBe(
      "Can't read the database version right now; try again with Skáli stopped.",
    );
    expect(ROLLBACK_UNKNOWN).toContain('Skáli stopped');
  });
});
