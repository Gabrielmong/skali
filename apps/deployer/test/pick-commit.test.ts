import { describe, expect, it } from 'vitest';
import type { CheckState, Commit } from '../src/github.js';
import { pickCommit } from '../src/pick-commit.js';

const now = new Date('2026-11-10T12:00:00Z');
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
const commit = (sha: string, m: number): Commit => ({ sha, message: `m ${sha}`, date: minutesAgo(m), author: 'a' });
const ciTimeoutMs = 30 * 60_000;

function pick(c: Commit[], states: Record<string, CheckState>, failed: string[] = []) {
  return pickCommit({ commits: c, states, failed, now, ciTimeoutMs });
}

describe('pickCommit', () => {
  const C = commit('C', 5);
  const B = commit('B', 60);

  it('deploys the newest green', () => {
    expect(pick([C, B], { C: 'success', B: 'success' })).toEqual({ action: 'deploy', commit: C, skip: [] });
  });

  it('waits while the head is pending', () => {
    expect(pick([C, B], { C: 'pending', B: 'success' })).toEqual({ action: 'wait', skip: [] });
  });

  it('waits while the head has no result yet and is young', () => {
    expect(pick([C, B], { C: 'none', B: 'success' })).toEqual({ action: 'wait', skip: [] });
  });

  it('red head falls back to older green', () => {
    expect(pick([C, B], { C: 'failure', B: 'success' })).toEqual({
      action: 'deploy',
      commit: B,
      skip: [{ commit: C, reason: 'tests failed' }],
    });
  });

  it('head pending past 30 min counts as no result', () => {
    const old = commit('C', 31);
    expect(pick([old, B], { C: 'pending', B: 'success' })).toEqual({
      action: 'deploy',
      commit: B,
      skip: [{ commit: old, reason: 'no test result' }],
    });
  });

  it('none past 30 min behaves the same', () => {
    const old = commit('C', 31);
    expect(pick([old, B], { C: 'none', B: 'success' })).toMatchObject({
      action: 'deploy',
      skip: [{ commit: old, reason: 'no test result' }],
    });
  });

  it('never auto-picks a failed sha', () => {
    expect(pick([C, B], { C: 'success', B: 'success' }, ['C'])).toEqual({ action: 'deploy', commit: B, skip: [] });
  });

  it('nothing new', () => {
    expect(pick([], {})).toEqual({ action: 'none', skip: [] });
  });

  it('returns none when every commit is skipped', () => {
    expect(pick([C], { C: 'failure' })).toEqual({ action: 'none', skip: [{ commit: C, reason: 'tests failed' }] });
  });
});
