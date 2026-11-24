import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERRUPTED, recoverOnStart } from '../src/recover.js';
import { isCurrent, releaseDir, switchCurrent } from '../src/releases.js';
import { type DeployFixture, NEW, OLD, deploySetup, label, labels, probe, scriptRelease } from './deploy-fixture.js';

let f: DeployFixture;
beforeEach(() => {
  f = deploySetup();
});
afterEach(() => f.cleanup());

describe('recoverOnStart', () => {
  it('a crash between stop and start: closes the event and leaves Skali started on current', async () => {
    f.runOld();
    const done = f.ctx.history.record({ kind: 'RESTART', status: 'SUCCEEDED', by: 'you' });
    const ev = f.ctx.history.start({ kind: 'DEPLOY', sha: NEW, message: 'x', by: 'auto' });
    f.addRelease(NEW, 4); // built, but current was never switched
    f.sys.serviceState = 'stopped';

    await recoverOnStart(f.ctx);

    const after = f.ctx.history.events().find((e) => e.id === ev.id)!;
    expect(INTERRUPTED).toBe('helper stopped during this');
    expect(after).toMatchObject({ status: 'FAILED', detail: INTERRUPTED });
    expect(after.finishedAt).toBeDefined();
    expect(f.ctx.history.events().find((e) => e.id === done.id)!.status).toBe('SUCCEEDED');
    expect(f.ctx.history.state().failedShas).toEqual([NEW]);
    expect(labels(f.sys)).toEqual(['start']);
    expect(f.sys.serviceState).toBe('running');
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(readFileSync(path.join(f.paths.eventLogs, `${ev.id}.log`), 'utf8')).toContain(INTERRUPTED);
  });

  it('a half-switched deploy (current on the new release, Skali stopped) goes back to the previous release when the database allows', async () => {
    f.runOld(3);
    f.addRelease(NEW, 4);
    f.ctx.history.start({ kind: 'DEPLOY', sha: NEW, message: 'x', by: 'auto' });
    switchCurrent(f.paths, NEW);
    f.sys.serviceState = 'stopped';
    f.probe = probe(3);

    await recoverOnStart(f.ctx);

    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(labels(f.sys)).toEqual(['probe', 'settings', 'start']);
    expect(scriptRelease(f.sys.calls.find((c) => label(c) === 'settings')!)).toBe(releaseDir(f.paths, OLD));
    expect(f.sys.serviceState).toBe('running');
    expect(f.ctx.history.state().running!.sha).toBe(OLD);
  });

  it('a half-switched deploy whose database already moved on stays on the new release and starts it', async () => {
    f.runOld(3);
    f.addRelease(NEW, 4);
    f.ctx.history.start({ kind: 'DEPLOY', sha: NEW, message: 'new', by: 'auto' });
    switchCurrent(f.paths, NEW);
    f.sys.serviceState = 'running'; // the new Skáli had started and migrated
    f.probe = probe(4);

    await recoverOnStart(f.ctx);

    expect(isCurrent(f.paths, NEW)).toBe(true);
    expect(labels(f.sys)).toEqual(['stop', 'probe', 'start']);
    expect(f.sys.serviceState).toBe('running');
    expect(f.ctx.history.state().running).toMatchObject({ sha: NEW, message: 'new' });
  });

  it.each(['running', 'paused', 'start_pending', 'other', 'missing'] as const)('with nothing interrupted, does not start Skali when it is %s', async (state) => {
    f.runOld();
    f.sys.serviceState = state;
    await recoverOnStart(f.ctx);
    expect(f.sys.calls.map((c) => c.op)).toEqual(['status']);
  });

  it('does nothing when there is no current release', async () => {
    f.sys.serviceState = 'stopped';
    await recoverOnStart(f.ctx);
    expect(f.sys.calls).toEqual([]);
  });

  it('a history write that throws during recovery still leaves Skali started, and the error is logged', async () => {
    f.runOld();
    f.ctx.history.start({ kind: 'DEPLOY', sha: NEW, message: 'x', by: 'auto' });
    f.sys.serviceState = 'stopped';
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(f.ctx.history, 'finish').mockImplementation(() => {
      throw new Error('EPERM: operation not permitted, rename history.json.tmp');
    });
    await expect(recoverOnStart(f.ctx)).resolves.toBeUndefined();
    expect(f.sys.serviceState).toBe('running');
    expect(labels(f.sys)).toEqual(['start']);
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/EPERM/));
    errors.mockRestore();
  });

  it('does not throw when starting fails', async () => {
    f.runOld();
    f.sys.serviceState = 'stopped';
    f.sys.failWhen((c) => c.op === 'start');
    await expect(recoverOnStart(f.ctx)).resolves.toBeUndefined();
  });
});
