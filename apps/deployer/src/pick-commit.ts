import type { CheckState, Commit } from './github.js';

export interface SkipNote {
  commit: Commit;
  reason: 'tests failed' | 'no test result';
  /** The CI run that decided it, when GitHub has one (added by findPick). */
  runUrl?: string;
}

export type Pick =
  | { action: 'deploy'; commit: Commit; skip: SkipNote[]; /** The commit's CI run (added by findPick). */ runUrl?: string }
  | { action: 'wait'; skip: SkipNote[] }
  | { action: 'none'; skip: SkipNote[] };

export interface PickInput {
  commits: Commit[]; // newest first
  states: Record<string, CheckState>;
  failed: string[];
  now: Date;
  ciTimeoutMs: number;
}

export function pickCommit({ commits, states, failed, now, ciTimeoutMs }: PickInput): Pick {
  const skip: SkipNote[] = [];
  for (const commit of commits) {
    if (failed.includes(commit.sha)) continue;
    const state = states[commit.sha] ?? 'none';
    if (state === 'success') return { action: 'deploy', commit, skip };
    if (state === 'failure') {
      skip.push({ commit, reason: 'tests failed' });
      continue;
    }
    const age = now.getTime() - new Date(commit.date).getTime();
    if (age < ciTimeoutMs) return { action: 'wait', skip };
    skip.push({ commit, reason: 'no test result' });
  }
  return { action: 'none', skip };
}
