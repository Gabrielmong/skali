import type { CheckState, Commit, GitHub } from './github.js';
import { GitHubError } from './github.js';
import { type OpContext, errorText } from './op-context.js';
import { type Pick as CommitPick, type SkipNote, pickCommit } from './pick-commit.js';
import { makeRedactor } from './redact.js';

/** What polling needs from GitHub; tests (and later tasks) inject a fake. */
export type CommitSource = Pick<GitHub, 'commitsSince' | 'ciState'>;

const MAX_SKIPPED = 200;

export interface PickOptions {
  /** The running commit; undefined when nothing is deployed yet (only the head is considered). */
  runningSha: string | undefined;
  failed: string[];
  ciTimeoutMs: number;
  /** Deploy now: offer the head even when it is the running commit, so it can say "Already running". */
  includeRunning: boolean;
}

async function candidates(ctx: OpContext, gh: CommitSource, opts: PickOptions): Promise<Commit[]> {
  const { branch } = ctx.config;
  if (opts.runningSha === undefined) return gh.commitsSince(branch);
  const since = await gh.commitsSince(branch, opts.runningSha);
  if (since.length > 0 || !opts.includeRunning) return since;
  return gh.commitsSince(branch); // up to date: the head is the running commit
}

/**
 * Commits after the running one, newest first, through pickCommit. Check states are fetched one
 * at a time and only until pickCommit has its answer (a green commit, or one to wait for), so a
 * long run of commits doesn't cost a GitHub call each. Failed commits are never looked up.
 */
export async function findPick(ctx: OpContext, gh: CommitSource, opts: PickOptions): Promise<CommitPick> {
  const commits = await candidates(ctx, gh, opts);
  const states: Record<string, CheckState> = {};
  const urls: Record<string, string | undefined> = {};
  const now = ctx.now();
  const pick = (upTo: number): CommitPick => {
    const answer = pickCommit({ commits: commits.slice(0, upTo), states, failed: opts.failed, now, ciTimeoutMs: opts.ciTimeoutMs });
    const skip = answer.skip.map((s): SkipNote => {
      const runUrl = urls[s.commit.sha];
      return runUrl ? { ...s, runUrl } : s;
    });
    if (answer.action !== 'deploy') return { ...answer, skip };
    const runUrl = urls[answer.commit.sha];
    return runUrl ? { ...answer, skip, runUrl } : { ...answer, skip };
  };
  for (const [i, c] of commits.entries()) {
    if (opts.failed.includes(c.sha)) continue;
    const ci = await gh.ciState(c.sha, ctx.config.ciWorkflowName);
    states[c.sha] = ci.state;
    urls[c.sha] = ci.runUrl;
    const answer = pick(i + 1);
    if (answer.action !== 'none') return answer;
  }
  return pick(commits.length);
}

/** A SKIPPED event per commit, once each (remembered in state.skippedShas). */
export function recordSkips(ctx: OpContext, skip: SkipNote[]): void {
  const { history } = ctx;
  for (const { commit, reason, runUrl } of skip) {
    const skipped = history.state().skippedShas;
    if (skipped.includes(commit.sha)) continue;
    history.record({
      kind: 'DEPLOY',
      status: 'SKIPPED',
      sha: commit.sha,
      message: commit.message,
      by: 'auto',
      detail: reason,
      ...(runUrl ? { ciRunUrl: runUrl } : {}),
    });
    history.update({ skippedShas: [...skipped, commit.sha].slice(-MAX_SKIPPED) });
  }
}

const UNREACHABLE = /^can't reach GitHub since \d\d:\d\d$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * What lastCheck.error shows. The caller stores the result in `history.state().lastCheck.error` after each
 * check (and stores no error on success); "unreachable" reads the previous stored text to keep the time of
 * the first failure, so a success in between (or a different error) starts the clock again.
 */
export function checkError(ctx: OpContext, e: unknown): string {
  if (e instanceof GitHubError) {
    if (e.kind === 'auth') return e.message; // 'GitHub token missing' or 'GitHub token expired or revoked'
    if (e.kind === 'unreachable') {
      const previous = ctx.history.state().lastCheck?.error;
      if (previous && UNREACHABLE.test(previous)) return previous;
      const t = ctx.now();
      return `can't reach GitHub since ${pad(t.getHours())}:${pad(t.getMinutes())}`;
    }
    return e.message;
  }
  let secrets: string[] = [];
  try {
    secrets = ctx.secrets();
  } catch {
    // the built-in patterns still apply
  }
  return makeRedactor(secrets)(`Check failed: ${errorText(e)}`);
}
