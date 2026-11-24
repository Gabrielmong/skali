import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitHub, GitHubError } from '../src/github.js';

type Call = { url: string; init?: RequestInit };

function fake(handler: (url: string) => { status?: number; body?: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const { status = 200, body = {}, headers } = handler(u);
    return new Response(status === 304 ? null : JSON.stringify(body), { status, headers });
  }) as typeof fetch;
  return { impl, calls };
}

const dir = mkdtempSync(join(tmpdir(), 'gh-'));
const tokenFile = join(dir, 'token');
writeFileSync(tokenFile, 'secret\r\n');
const gh = (impl: typeof fetch) => new GitHub('o/r', tokenFile, impl);
const headersOf = (c: Call) => (c.init?.headers ?? {}) as Record<string, string>;

type Run = { name?: string; run_number?: number; created_at?: string; status: string; conclusion: string | null; html_url?: string; id?: number };
const runs = (...r: Run[]) => ({
  body: {
    workflow_runs: r.map((run, i) => ({ id: i + 1, run_number: i + 1, html_url: `https://gh/run/${i + 1}`, ...run, name: run.name ?? 'CI' })),
  },
});
const done = (conclusion: string) => ({ status: 'completed', conclusion });

describe('GitHub.ciState', () => {
  async function state(r: ReturnType<typeof runs>, name = 'CI') {
    const { impl } = fake(() => r);
    return gh(impl).ciState('abc', name);
  }

  it('maps workflow runs and returns the run url', async () => {
    expect((await state(runs())).state).toBe('none');
    expect((await state(runs())).runUrl).toBeUndefined();
    expect(await state(runs(done('success'), { status: 'in_progress', conclusion: null }))).toEqual({
      state: 'pending',
      runUrl: 'https://gh/run/2',
    });
    expect(await state(runs(done('success'), done('failure')))).toEqual({ state: 'failure', runUrl: 'https://gh/run/2' });
    expect((await state(runs(done('success'), done('skipped'), done('neutral')))).state).toBe('success');
  });

  it('only the workflow with the exact name counts; a failing CodeQL does not matter', async () => {
    const ci = { name: 'CI', ...done('success') };
    expect(await state(runs(ci, { name: 'CodeQL', ...done('failure') }))).toEqual({
      state: 'success',
      runUrl: 'https://gh/run/1',
    });
    expect((await state(runs(ci, { name: 'CodeQL', status: 'in_progress', conclusion: null }))).state).toBe('success');
    expect((await state(runs({ name: 'CodeQL', ...done('success') }))).state).toBe('none');
    expect((await state(runs({ name: 'CI Extra', ...done('success') }))).state).toBe('none');
  });

  it('the newest run decides, not the API order or any red', async () => {
    const r = (run_number: number, conclusion: string | null, extra: Partial<Run> = {}) => ({
      name: 'CI',
      run_number,
      html_url: `https://gh/n${run_number}`,
      status: conclusion ? 'completed' : 'in_progress',
      conclusion,
      ...extra,
    });
    const body = (...runs: unknown[]) => ({ body: { workflow_runs: runs } });
    const st = async (b: { body: unknown }) => gh(fake(() => b).impl).ciState('abc', 'CI');
    expect(await st(body(r(2, 'success'), r(1, 'failure')))).toEqual({ state: 'success', runUrl: 'https://gh/n2' });
    expect(await st(body(r(1, 'failure'), r(2, 'success')))).toEqual({ state: 'success', runUrl: 'https://gh/n2' });
    expect(await st(body(r(1, 'success'), r(2, 'failure')))).toEqual({ state: 'failure', runUrl: 'https://gh/n2' });
    expect(await st(body(r(2, 'failure'), r(1, 'success')))).toEqual({ state: 'failure', runUrl: 'https://gh/n2' });
    expect(await st(body(r(1, 'success'), r(2, null)))).toEqual({ state: 'pending', runUrl: 'https://gh/n2' });
    expect(
      await st(body(r(1, 'success'), { ...r(9, 'failure'), name: 'CodeQL' })),
    ).toEqual({ state: 'success', runUrl: 'https://gh/n1' });
    // equal run_number: newer created_at wins
    expect(
      await st(body(r(1, 'failure', { created_at: '2026-01-02' }), r(1, 'success', { created_at: '2026-01-01' }))),
    ).toEqual({ state: 'failure', runUrl: 'https://gh/n1' });
  });

  it('asks Actions for the runs of that commit', async () => {
    const { impl, calls } = fake(() => runs());
    await gh(impl).ciState('abc', 'CI');
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/actions/runs?head_sha=abc&per_page=100');
  });
});

describe('GitHub requests', () => {
  const commitBody = {
    sha: 's',
    commit: {
      message: 'hi\nbody',
      author: { name: 'Ann', date: '2026-01-01T00:00:00Z' },
      committer: { date: '2026-01-02T00:00:00Z' },
    },
  };

  it('sends the token from the file as bearer, trimmed', async () => {
    const { impl, calls } = fake(() => ({ body: [commitBody] }));
    const out = await gh(impl).commitsSince('main');
    expect(out).toEqual([{ sha: 's', message: 'hi', date: '2026-01-02T00:00:00Z', author: 'Ann' }]);
    const h = headersOf(calls[0]);
    expect(h.Authorization).toBe('Bearer secret');
    expect(h.Accept).toBe('application/vnd.github+json');
    expect(h['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/commits?sha=main&per_page=1');
  });

  it('a missing or empty token file is an auth error and nothing is sent', async () => {
    const empty = join(dir, 'empty');
    writeFileSync(empty, '   ');
    for (const file of [join(dir, 'nope'), empty]) {
      const { impl, calls } = fake(() => ({ body: [commitBody] }));
      const err = await new GitHub('o/r', file, impl).commitsSince('main').catch((e) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect(err.kind).toBe('auth');
      expect(err.message).toBe('GitHub token missing');
      expect(calls).toHaveLength(0);
    }
  });

  it('401 and a plain 403 are auth errors without the token', async () => {
    for (const status of [401, 403]) {
      const { impl } = fake(() => ({ status, headers: { 'x-ratelimit-remaining': '4999' } }));
      const err = await gh(impl).commitsSince('main').catch((e) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect(err.kind).toBe('auth');
      expect(err.message).toBe('GitHub token expired or revoked');
      expect(err.status).toBe(status);
      expect(err.message).not.toContain('secret');
    }
  });

  it.each([
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790000000' }],
    [429, {}],
  ])('%i from the rate limit is kind rate', async (status, headers) => {
    const { impl } = fake(() => ({ status, headers }));
    const err = await gh(impl).commitsSince('main').catch((e) => e);
    expect(err.kind).toBe('rate');
    expect(err.message).toBe('GitHub rate limit reached; trying again later');
    if (status === 403) expect(err.resetAt.getTime()).toBe(1790000000_000);
  });

  it('other failures are kind other and name the status', async () => {
    const { impl } = fake(() => ({ status: 500 }));
    const err = await gh(impl).commitsSince('main').catch((e) => e);
    expect(err.kind).toBe('other');
    expect(err.message).toBe('GitHub answered 500');
    expect(err.status).toBe(500);
  });

  it('network errors and timeouts are kind unreachable', async () => {
    for (const thrown of [new TypeError('fetch failed secret'), new DOMException('aborted', 'TimeoutError')]) {
      const impl = (async () => {
        throw thrown;
      }) as unknown as typeof fetch;
      const err = await gh(impl).commitsSince('main').catch((e) => e);
      expect(err).toBeInstanceOf(GitHubError);
      expect(err.kind).toBe('unreachable');
      expect(err.message).not.toContain('secret');
    }
  });

  it('passes an abort signal', async () => {
    const { impl, calls } = fake(() => ({ body: [commitBody] }));
    await gh(impl).commitsSince('main');
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('GitHub.commitsSince', () => {
  const mk = (sha: string) => ({
    sha,
    commit: { message: `m${sha}\nmore`, author: { name: `a${sha}`, date: `ad${sha}` }, committer: { date: `d${sha}` } },
  });

  it('compare returns newest first and excludes the base', async () => {
    const { impl, calls } = fake(() => ({ body: { commits: [mk('B'), mk('C')] } }));
    const out = await gh(impl).commitsSince('main', 'A');
    expect(out.map((c) => c.sha)).toEqual(['C', 'B']);
    expect(out[0]).toEqual({ sha: 'C', message: 'mC', date: 'dC', author: 'aC' });
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/compare/A...main');
  });

  it('nothing new is an empty list', async () => {
    const { impl } = fake(() => ({ body: { commits: [] } }));
    expect(await gh(impl).commitsSince('main', 'A')).toEqual([]);
  });
});

describe('GitHub.headConditional', () => {
  it('sends If-None-Match and returns changed:false on 304', async () => {
    const { impl, calls } = fake(() => ({ status: 304 }));
    expect(await gh(impl).headConditional('main', '"e1"')).toEqual({ changed: false });
    expect(headersOf(calls[0])['If-None-Match']).toBe('"e1"');
  });

  it('returns the head commit and the etag', async () => {
    const body = { sha: 'h', commit: { message: 'x', author: { name: 'A', date: 'd' }, committer: { date: 'c' } } };
    const { impl, calls } = fake(() => ({ body, headers: { etag: '"e2"' } }));
    expect(await gh(impl).headConditional('main')).toEqual({
      changed: true,
      data: { sha: 'h', message: 'x', date: 'c', author: 'A' },
      etag: '"e2"',
    });
    expect(calls[0].url).toBe('https://api.github.com/repos/o/r/commits/main');
    expect(headersOf(calls[0])['If-None-Match']).toBeUndefined();
  });
});
