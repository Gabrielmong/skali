import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startApi } from '../src/api.js';
import { Deployer, type Ops } from '../src/deployer.js';
import { type CheckState, type Commit, GitHubError } from '../src/github.js';
import type { DeployEvent } from '../src/history.js';
import type { OpContext } from '../src/op-context.js';
import { OpError } from '../src/op-error.js';
import type { CommitSource } from '../src/poll.js';
import { switchCurrent } from '../src/releases.js';
import { ROLLBACK_BLOCKED, ROLLBACK_UNKNOWN } from '../src/rollback-eligibility.js';
import { BOOT, type DeployFixture, NEW, OLD, TARGET, commit, deploySetup, label } from './deploy-fixture.js';

class FakeGitHub implements CommitSource {
  commits: Commit[] = [commit(NEW, 'new feature')];
  states: Record<string, CheckState> = { [NEW]: 'success' };
  urls: Record<string, string> = { [NEW]: 'https://github.com/run/7' };
  error?: Error;
  calls = 0;
  since: Array<string | undefined> = [];
  async commitsSince(_branch: string, sinceSha?: string): Promise<Commit[]> {
    this.calls += 1;
    this.since.push(sinceSha);
    if (this.error) throw this.error;
    return this.commits;
  }
  async ciState(sha: string): Promise<{ state: CheckState; runUrl?: string }> {
    return { state: this.states[sha] ?? 'none', runUrl: this.urls[sha] };
  }
}

/** Stub operations that record an event like the real ones; `hold` keeps one in flight. */
function stubOps() {
  let release: () => void = () => undefined;
  const state = { held: false };
  const gate = () => (state.held ? new Promise<void>((r) => (release = r)) : Promise.resolve());
  const run = async (ctx: OpContext, kind: DeployEvent['kind'], sha: string | undefined, by: string) => {
    const ev = ctx.history.start({ kind, sha, by });
    await gate();
    ctx.history.finish(ev.id, 'SUCCEEDED');
    return ev;
  };
  const ops = {
    deployCommit: vi.fn((ctx: OpContext, c: Commit, by: string, _opts?: { waitForIdle?: boolean; ciRunUrl?: string }) =>
      run(ctx, 'DEPLOY', c.sha, by),
    ),
    rollbackTo: vi.fn((ctx: OpContext, sha: string, by: string) => run(ctx, 'ROLLBACK', sha, by)),
    restartApp: vi.fn((ctx: OpContext, by: string) => run(ctx, 'RESTART', undefined, by)),
  } satisfies Ops;
  return { ops, hold: () => (state.held = true), release: () => release() };
}

let f: DeployFixture;
let gh: FakeGitHub;
let stub: ReturnType<typeof stubOps>;
let d: Deployer;

beforeEach(() => {
  f = deploySetup();
  f.runOld();
  gh = new FakeGitHub();
  stub = stubOps();
  d = new Deployer(f.ctx, gh, stub.ops);
});

afterEach(async () => {
  vi.useRealTimers();
  stub.release();
  await d.stop();
  f.cleanup();
});

describe('Deployer.tick', () => {
  it('deploys the picked commit as auto, with the busy-wait and its CI run url', async () => {
    await d.tick();
    expect(stub.ops.deployCommit).toHaveBeenCalledTimes(1);
    const [, c, by, opts] = stub.ops.deployCommit.mock.calls[0]!;
    expect(c).toEqual(commit(NEW, 'new feature'));
    expect(by).toBe('auto');
    expect(opts).toEqual({ waitForIdle: true, ciRunUrl: 'https://github.com/run/7' });
    expect(gh.since).toEqual([OLD]);
    expect((await d.status()).lastCheck).toEqual({ at: f.ctx.now().toISOString() });
  });

  it('does nothing while paused', async () => {
    f.ctx.history.update({ autoDeploy: { on: false, reason: 'paused by you' } });
    await d.tick();
    expect(gh.calls).toBe(0);
    expect(stub.ops.deployCommit).not.toHaveBeenCalled();
  });

  it('records a failed check with checkError text, keeps polling, and a success clears the error', async () => {
    gh.error = new GitHubError('GitHub token expired or revoked', 'auth', 401);
    await d.tick();
    expect((await d.status()).lastCheck).toEqual({ at: f.ctx.now().toISOString(), error: 'GitHub token expired or revoked' });
    gh.error = new GitHubError("Can't reach GitHub", 'unreachable');
    await d.tick();
    expect((await d.status()).lastCheck?.error).toMatch(/^can't reach GitHub since \d\d:\d\d$/);
    expect(stub.ops.deployCommit).not.toHaveBeenCalled();
    gh.error = undefined;
    await d.tick();
    expect((await d.status()).lastCheck).toEqual({ at: f.ctx.now().toISOString() });
  });

  it('records each skip once, with its CI run url', async () => {
    gh.states = { [NEW]: 'failure' };
    await d.tick();
    await d.tick();
    const skipped = f.ctx.history.events().filter((e) => e.status === 'SKIPPED');
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ sha: NEW, detail: 'tests failed', ciRunUrl: 'https://github.com/run/7' });
  });

  it('reports a helper update when the fetched main has a different apps/deployer tree', async () => {
    let tree = 'tree-installed';
    f.sys.output = (c) => (label(c) === 'rev-parse' ? [tree] : []);
    await d.tick();
    expect((await d.status()).helperUpdateAvailable).toBe(false);
    const call = f.sys.calls.find((c) => label(c) === 'rev-parse')!;
    expect(call.args).toEqual(['-C', f.paths.repo, 'rev-parse', 'refs/remotes/origin/main:apps/deployer']);
    expect(call.env).toEqual({ GIT_LOCAL: '1' });
    tree = 'tree-newer';
    await d.tick();
    expect((await d.status()).helperUpdateAvailable).toBe(true);
    f.sys.failWhen((c) => label(c) === 'rev-parse');
    await d.tick();
    expect((await d.status()).helperUpdateAvailable).toBe(true); // a failed lookup keeps the last answer
  });

  it('a second auto tick while busy just skips', async () => {
    stub.hold();
    await d.command({ type: 'restartApp', by: 'you' });
    await d.tick();
    expect(gh.calls).toBe(0);
  });

  it('first deploy after setup (current = bootstrap release, history empty) deploys the green head', async () => {
    const fresh = deploySetup();
    try {
      fresh.addRelease(BOOT);
      switchCurrent(fresh.paths, BOOT);
      const dd = new Deployer(fresh.ctx, gh, stub.ops);
      expect((await dd.status()).running).toMatchObject({ sha: 'b007000' });
      await dd.tick();
      expect(gh.since).toEqual(['b007000']);
      expect(stub.ops.deployCommit).toHaveBeenCalledTimes(1);
      expect(stub.ops.deployCommit.mock.calls[0]![1].sha).toBe(NEW);
      await dd.stop();
    } finally {
      fresh.cleanup();
    }
  });
});

describe('Deployer.command', () => {
  it('one at a time: a second command while one runs gets 409 busy', async () => {
    stub.hold();
    const { eventId } = await d.command({ type: 'deployNow', by: 'you' });
    expect(f.ctx.history.events()[0]).toMatchObject({ id: eventId, kind: 'DEPLOY', status: 'RUNNING' });
    expect((await d.status()).busy).toBe('Deploying def5678');
    for (const c of [{ type: 'pause' as const, by: 'you' }, { type: 'restartApp' as const, by: 'you' }]) {
      const second = d.command(c);
      await expect(second).rejects.toBeInstanceOf(OpError);
      await expect(second).rejects.toMatchObject({ status: 409, message: 'busy' });
    }
    stub.release();
    await d.stop();
    expect((await d.status()).busy).toBeUndefined();
  });

  it('one at a time, through the API: 409 {error:"busy"}', async () => {
    stub.hold();
    const server: Server = await startApi(d, { token: 'tok-123456', logsDir: f.paths.eventLogs, port: 0 });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const post = (body: unknown) =>
        fetch(`${base}/command`, {
          method: 'POST',
          headers: { Authorization: 'Bearer tok-123456', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      expect((await post({ type: 'restartApp', by: 'you' })).status).toBe(202);
      const res = await post({ type: 'deployNow', by: 'you' });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'busy' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('deployNow skips the busy-wait and may retry a failed sha', async () => {
    f.ctx.history.update({ failedShas: [NEW] });
    await d.command({ type: 'deployNow', by: 'you' });
    await d.stop();
    expect(stub.ops.deployCommit).toHaveBeenCalledTimes(1);
    const [, c, by, opts] = stub.ops.deployCommit.mock.calls[0]!;
    expect(c.sha).toBe(NEW);
    expect(by).toBe('you');
    expect(opts).toMatchObject({ waitForIdle: false });
  });

  it('deployNow refuses when nothing is green or the green one is running', async () => {
    gh.states = { [NEW]: 'pending' };
    await expect(d.command({ type: 'deployNow', by: 'you' })).rejects.toMatchObject({ status: 400, message: 'No green commit to deploy' });
    gh.commits = [commit(OLD, 'old')];
    gh.states = { [OLD]: 'success' };
    await expect(d.command({ type: 'deployNow', by: 'you' })).rejects.toMatchObject({ status: 400, message: 'Already running a1b2c3d' });
    expect(stub.ops.deployCommit).not.toHaveBeenCalled();
    expect((await d.status()).busy).toBeUndefined();
  });

  it('rollback to a sha that is not kept → 400, nothing runs', async () => {
    await expect(d.command({ type: 'rollback', sha: TARGET, by: 'you' })).rejects.toMatchObject({ status: 400 });
    expect(stub.ops.rollbackTo).not.toHaveBeenCalled();
    expect((await d.status()).busy).toBeUndefined();
  });

  it('an allowed rollback runs and returns its event', async () => {
    f.addRelease(TARGET, 3);
    f.ctx.history.update({ releases: [OLD, TARGET], lastDbVersion: 3 });
    const { eventId } = await d.command({ type: 'rollback', sha: TARGET, by: 'you' });
    await d.stop();
    expect(stub.ops.rollbackTo).toHaveBeenCalledTimes(1);
    expect(f.ctx.history.events().find((e) => e.id === eventId)).toMatchObject({ kind: 'ROLLBACK', sha: TARGET });
  });

  it('pause and resume record events and the reason', async () => {
    const paused = await d.command({ type: 'pause', by: 'you' });
    expect(f.ctx.history.state().autoDeploy).toEqual({ on: false, reason: 'paused by you' });
    expect(f.ctx.history.events()[0]).toMatchObject({ id: paused.eventId, kind: 'PAUSE', status: 'SUCCEEDED', by: 'you' });
    await d.command({ type: 'resume', by: 'you' });
    expect(f.ctx.history.state().autoDeploy).toEqual({ on: true });
  });
});

describe('Deployer.status', () => {
  const BLOCKED = 'b10cced000000000000000000000000000000000';
  beforeEach(() => {
    f.addRelease(TARGET, 4);
    f.addRelease(BLOCKED, 2);
    f.ctx.history.update({ releases: [OLD, TARGET, BLOCKED] });
    for (const sha of [BLOCKED, TARGET, OLD]) {
      f.ctx.history.record({ kind: 'DEPLOY', status: 'SUCCEEDED', sha, message: sha.slice(0, 7), by: 'auto', ciRunUrl: `https://gh/${sha.slice(0, 7)}` });
    }
  });

  it('marks kept releases from the last database version seen, never the running one; events carry ciRunUrl', async () => {
    f.ctx.history.update({ lastDbVersion: 3 });
    const before = f.sys.calls.length;
    const { events } = await d.status();
    expect(f.sys.calls.length).toBe(before); // the page never probes
    const bySha = (sha: string) => events.find((e) => e.sha === sha)!;
    expect(bySha(TARGET)).toMatchObject({ canRollback: true, ciRunUrl: 'https://gh/abc1234' });
    expect(bySha(TARGET).rollbackBlockedReason).toBeUndefined();
    expect(bySha(BLOCKED)).toMatchObject({ canRollback: false, rollbackBlockedReason: ROLLBACK_BLOCKED });
    expect(bySha(OLD)).toMatchObject({ canRollback: false });
    expect(bySha(OLD).rollbackBlockedReason).toBeUndefined();
  });

  it('an unknown database version blocks with the "can\'t read" text', async () => {
    const { events } = await d.status();
    expect(events.find((e) => e.sha === TARGET)).toMatchObject({ canRollback: false, rollbackBlockedReason: ROLLBACK_UNKNOWN });
  });

  it('running is what current really points at; helperUpdateAvailable defaults to false', async () => {
    switchCurrent(f.paths, TARGET);
    const s = await d.status();
    expect(s.running).toMatchObject({ sha: TARGET, message: 'abc1234' });
    expect(s.helperUpdateAvailable).toBe(false);
  });
});

describe('Deployer timer and shutdown', () => {
  it('first tick 10 s after start, then every pollMs', async () => {
    vi.useFakeTimers();
    d.start();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(gh.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(gh.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(gh.calls).toBe(2);
  });

  it('refuses commands once stopping', async () => {
    await d.stop();
    await expect(d.command({ type: 'pause', by: 'you' })).rejects.toMatchObject({ status: 409 });
  });
});
