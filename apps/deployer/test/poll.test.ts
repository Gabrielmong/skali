import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { GitHubError } from '../src/github.js';
import type { CheckState, Commit } from '../src/github.js';
import { History } from '../src/history.js';
import type { OpContext } from '../src/op-context.js';
import { type CommitSource, checkError, findPick, recordSkips } from '../src/poll.js';

const NOW = '2026-11-10T09:00:00Z';
const sha = (n: number) => `${n}`.repeat(40).slice(0, 40);
const at = (minutesAgo: number) => new Date(Date.parse(NOW) - minutesAgo * 60_000).toISOString();
/** Newest first: c(1) is the head. */
const c = (n: number, minutesAgo = 60): Commit => ({ sha: sha(n), message: `m${n}`, date: at(minutesAgo), author: 'a' });
const OLD = sha(9);

let clock = new Date(NOW);
let ctx: OpContext;
beforeEach(() => {
  clock = new Date(NOW);
  const dir = mkdtempSync(join(tmpdir(), 'poll-'));
  const now = () => clock;
  ctx = {
    config: { branch: 'main', ciWorkflowName: 'CI' },
    history: new History(join(dir, 'h.json'), join(dir, 'logs'), 50, now),
    secrets: () => ['ghp_supersecret1234567'],
    now,
  } as unknown as OpContext;
});

function source(commits: Commit[], states: Record<string, CheckState>, urls: Record<string, string> = {}) {
  const asked: string[] = [];
  const since: Array<string | undefined> = [];
  const gh: CommitSource = {
    commitsSince: async (_b, s) => {
      since.push(s);
      return s === undefined ? commits.slice(0, 1) : s === commits[0]!.sha ? [] : commits;
    },
    ciState: async (s, name) => {
      asked.push(`${s}:${name}`);
      return { state: states[s] ?? 'none', runUrl: urls[s] };
    },
  };
  return { asked, since, gh };
}

const opts = { runningSha: OLD as string | undefined, failed: [] as string[], ciTimeoutMs: 1_800_000, includeRunning: false };

describe('findPick', () => {
  it('stops asking GitHub at the newest green commit, and skips carry the run url', async () => {
    const commits = [c(1), c(2), c(3), c(4), c(5)];
    const { gh, asked } = source(
      commits,
      { [sha(1)]: 'failure', [sha(2)]: 'success', [sha(3)]: 'success' },
      { [sha(1)]: 'https://gh/1' },
    );
    const pick = await findPick(ctx, gh, opts);
    expect(pick).toMatchObject({ action: 'deploy', commit: { sha: sha(2) } });
    expect(pick.skip).toEqual([{ commit: commits[0], reason: 'tests failed', runUrl: 'https://gh/1' }]);
    expect(asked).toEqual([`${sha(1)}:CI`, `${sha(2)}:CI`]);
  });

  it('stops at a head still inside the CI wait', async () => {
    const commits = [c(1, 5), c(2), c(3)];
    const { gh, asked } = source(commits, { [sha(1)]: 'pending', [sha(2)]: 'success' });
    expect((await findPick(ctx, gh, opts)).action).toBe('wait');
    expect(asked).toEqual([`${sha(1)}:CI`]);
  });

  it('with no CI wait passes pending commits and stops at the first green one', async () => {
    const commits = [c(1, 5), c(2), c(3)];
    const { gh } = source(commits, { [sha(1)]: 'pending', [sha(2)]: 'success' });
    expect(await findPick(ctx, gh, { ...opts, ciTimeoutMs: 0 })).toMatchObject({
      action: 'deploy',
      commit: { sha: sha(2) },
    });
  });

  it('a head with no result after the timeout is skipped (no test result)', async () => {
    const commits = [c(1, 31), c(2)];
    const { gh } = source(commits, { [sha(2)]: 'success' });
    const pick = await findPick(ctx, gh, opts);
    expect(pick).toMatchObject({ action: 'deploy', commit: { sha: sha(2) } });
    expect(pick.skip).toMatchObject([{ reason: 'no test result' }]);
  });

  it('never asks about failed commits', async () => {
    const commits = [c(1), c(2), c(3)];
    const { gh, asked } = source(commits, { [sha(1)]: 'failure', [sha(3)]: 'failure' });
    const pick = await findPick(ctx, gh, { ...opts, failed: [sha(2)] });
    expect(pick.action).toBe('none');
    expect(pick.skip.map((s) => s.commit.sha)).toEqual([sha(1), sha(3)]);
    expect(asked).toEqual([`${sha(1)}:CI`, `${sha(3)}:CI`]);
  });

  it('up to date is none, unless includeRunning offers the head', async () => {
    const commits = [c(1)];
    const { gh } = source(commits, { [sha(1)]: 'success' });
    expect((await findPick(ctx, gh, { ...opts, runningSha: sha(1) })).action).toBe('none');
    expect(await findPick(ctx, gh, { ...opts, runningSha: sha(1), includeRunning: true })).toMatchObject({
      action: 'deploy',
      commit: { sha: sha(1) },
    });
  });

  it('with nothing running it considers only the head', async () => {
    const commits = [c(1), c(2)];
    const { gh, since } = source(commits, { [sha(1)]: 'success' });
    const pick = await findPick(ctx, gh, { ...opts, runningSha: undefined });
    expect(pick).toMatchObject({ action: 'deploy', commit: { sha: sha(1) } });
    expect(since).toEqual([undefined]);
  });
});

describe('recordSkips', () => {
  it('records one SKIPPED event per commit with ciRunUrl, once each', () => {
    const skip = [{ commit: c(1), reason: 'tests failed' as const, runUrl: 'https://gh/1' }];
    recordSkips(ctx, skip);
    recordSkips(ctx, skip);
    expect(ctx.history.events()).toHaveLength(1);
    expect(ctx.history.events()[0]).toMatchObject({
      kind: 'DEPLOY',
      status: 'SKIPPED',
      sha: sha(1),
      by: 'auto',
      detail: 'tests failed',
      ciRunUrl: 'https://gh/1',
    });
    expect(ctx.history.state().skippedShas).toEqual([sha(1)]);
  });
});

describe('checkError', () => {
  const unreachable = () => new GitHubError("Can't reach GitHub", 'unreachable');
  /** What the deployer does after each check. */
  const store = (error?: string) =>
    ctx.history.update({ lastCheck: { at: clock.toISOString(), ...(error ? { error } : {}) } });

  it('auth errors', () => {
    expect(checkError(ctx, new GitHubError('GitHub token expired or revoked', 'auth', 401))).toBe('GitHub token expired or revoked');
    expect(checkError(ctx, new GitHubError('GitHub token missing', 'auth'))).toBe('GitHub token missing');
  });

  it('rate limit and other GitHub errors keep their own message', () => {
    expect(checkError(ctx, new GitHubError('GitHub rate limit reached; trying again later', 'rate', 429))).toBe(
      'GitHub rate limit reached; trying again later',
    );
    expect(checkError(ctx, new GitHubError('GitHub answered 500', 'other', 500))).toBe('GitHub answered 500');
  });

  it('unreachable says when it started, in local HH:MM, and keeps the first time', () => {
    clock = new Date(2026, 10, 10, 14, 2, 30);
    const first = checkError(ctx, unreachable());
    expect(first).toBe("can't reach GitHub since 14:02");
    store(first);
    clock = new Date(2026, 10, 10, 14, 9, 0);
    expect(checkError(ctx, unreachable())).toBe("can't reach GitHub since 14:02");
  });

  it('single digits are padded', () => {
    clock = new Date(2026, 10, 10, 7, 5, 0);
    expect(checkError(ctx, unreachable())).toBe("can't reach GitHub since 07:05");
  });

  it('a success in between clears it', () => {
    clock = new Date(2026, 10, 10, 14, 2, 0);
    store(checkError(ctx, unreachable()));
    clock = new Date(2026, 10, 10, 14, 4, 0);
    store(); // success
    clock = new Date(2026, 10, 10, 15, 30, 0);
    expect(checkError(ctx, unreachable())).toBe("can't reach GitHub since 15:30");
  });

  it('an auth failure in between restarts the unreachable clock', () => {
    clock = new Date(2026, 10, 10, 14, 2, 0);
    store(checkError(ctx, unreachable()));
    store(checkError(ctx, new GitHubError('GitHub token expired or revoked', 'auth', 401)));
    clock = new Date(2026, 10, 10, 16, 0, 0);
    expect(checkError(ctx, unreachable())).toBe("can't reach GitHub since 16:00");
  });

  it('other errors are redacted', () => {
    expect(checkError(ctx, new Error('boom ghp_supersecret1234567'))).toBe('Check failed: boom ***');
  });
});
