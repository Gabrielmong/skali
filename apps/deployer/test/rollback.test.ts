import { readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OpError } from '../src/op-error.js';
import { isCurrent, releaseDir } from '../src/releases.js';
import { ROLLBACK_BLOCKED, ROLLBACK_UNKNOWN } from '../src/rollback-eligibility.js';
import { rollbackTo } from '../src/rollback.js';
import { type DeployFixture, OLD, TARGET, deploySetup, label, labels, probe, scriptRelease } from './deploy-fixture.js';

let f: DeployFixture;
beforeEach(() => {
  f = deploySetup();
  // TARGET (schema 3) is an older kept release; OLD (schema 4) runs.
  f.addRelease(TARGET, 3);
  f.runOld(4);
  f.ctx.history.update({ releases: [OLD, TARGET], lastDbVersion: 3 });
  f.ctx.history.record({ kind: 'DEPLOY', status: 'SUCCEEDED', sha: TARGET, message: 'target msg', by: 'auto' });
  f.probe = probe(3);
});
afterEach(() => f.cleanup());

const refusal = async (sha: string) => {
  const err = await rollbackTo(f.ctx, sha, 'you').catch((e: unknown) => e);
  expect(err).toBeInstanceOf(OpError);
  expect(f.sys.calls).toEqual([]);
  expect(f.ctx.history.events().filter((e) => e.kind === 'ROLLBACK')).toEqual([]);
  return err as OpError;
};

describe('rollbackTo', () => {
  it('refuses a sha that is not a kept release with 400', async () => {
    expect(await refusal('0123456789012345678901234567890123456789')).toMatchObject({ status: 400, message: 'Unknown release 0123456' });
  });

  it('refuses something that is not a sha with 400', async () => {
    expect(await refusal('..\\..\\x')).toMatchObject({ status: 400 });
  });

  it('refuses a kept sha whose folder is gone', async () => {
    const GONE = '7777777000000000000000000000000000000000';
    f.ctx.history.update({ releases: [OLD, TARGET, GONE] });
    expect(await refusal(GONE)).toMatchObject({ status: 400, message: 'Unknown release 7777777' });
  });

  it('refuses the running release', async () => {
    expect(await refusal(OLD)).toMatchObject({ status: 400, message: 'Already running a1b2c3d' });
  });

  it('refuses up front when the last database version seen is newer than the target knows', async () => {
    f.ctx.history.update({ lastDbVersion: 4 });
    expect(await refusal(TARGET)).toMatchObject({ status: 400, message: ROLLBACK_BLOCKED });
  });

  it('switches with a fresh probe after stopping, no busy-wait, and pauses auto-deploy', async () => {
    const ev = await rollbackTo(f.ctx, TARGET, 'you');
    expect(ev).toMatchObject({ kind: 'ROLLBACK', status: 'SUCCEEDED', sha: TARGET, by: 'you', message: 'target msg' });
    expect(labels(f.sys)).toEqual(['stop', 'probe', 'settings', 'start', 'healthy']);
    expect(scriptRelease(f.sys.calls.find((c) => label(c) === 'settings')!)).toBe(releaseDir(f.paths, TARGET));
    expect(f.ctx.history.state().autoDeploy).toEqual({ on: false, reason: 'rolled back to abc1234' });
    expect(f.ctx.history.state().running).toMatchObject({ sha: TARGET, message: 'target msg' });
    expect(isCurrent(f.paths, TARGET)).toBe(true);
  });

  it('backs up the database after the probe and before switching', async () => {
    const ev = await rollbackTo(f.ctx, TARGET, 'you');
    expect(ev.status).toBe('SUCCEEDED');
    const backups = readdirSync(f.paths.backups);
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/-abc1234$/);
    expect(readFileSync(path.join(f.paths.backups, backups[0]!, 'skali.db'), 'utf8')).toBe('db-before');
    const lines = readFileSync(path.join(f.paths.eventLogs, `${ev.id}.log`), 'utf8').split('\n');
    const at = (s: string) => lines.findIndex((l) => l.startsWith(s));
    expect(at('▶ Back up database')).toBeGreaterThan(at('Database version 3'));
    expect(at('▶ Switch')).toBeGreaterThan(at('▶ Back up database'));
  });

  it('when the backup fails, starts Skali again on the same release and fails with the reason', async () => {
    f.onProbe = () => rmSync(f.db()); // the database vanishes, so backupDb fails
    const ev = await rollbackTo(f.ctx, TARGET, 'you');
    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toMatch(/^Not rolling back: the database backup failed \(Database not found: .*\); still running a1b2c3d$/);
    expect(labels(f.sys)).toEqual(['stop', 'probe', 'start']);
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(f.sys.serviceState).toBe('running');
    expect(f.ctx.history.state().autoDeploy.on).toBe(true);
  });

  it('when the fresh probe blocks it, starts Skali again on the same release and fails with the reason', async () => {
    f.probe = probe(4);
    const ev = await rollbackTo(f.ctx, TARGET, 'you');
    expect(ev).toMatchObject({ status: 'FAILED', detail: ROLLBACK_BLOCKED });
    expect(labels(f.sys)).toEqual(['stop', 'probe', 'start']);
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(f.sys.serviceState).toBe('running');
    expect(f.ctx.history.state().autoDeploy.on).toBe(true);
    expect(f.ctx.history.state().lastDbVersion).toBe(4);
  });

  it("when the database can't be read, starts Skali again and fails with the unknown text", async () => {
    f.probe = undefined;
    const ev = await rollbackTo(f.ctx, TARGET, 'you');
    expect(ev).toMatchObject({ status: 'FAILED', detail: ROLLBACK_UNKNOWN });
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(f.sys.serviceState).toBe('running');
  });

  it("switches back when the target doesn't come up", async () => {
    f.sys.healthResults = [false, true];
    const ev = await rollbackTo(f.ctx, TARGET, 'you');
    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toBe("abc1234 didn't come up; switched back to a1b2c3d");
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(f.ctx.history.state().running!.sha).toBe(OLD);
    expect(f.ctx.history.state().autoDeploy.on).toBe(true);
  });

  it('when stopping fails it stays on the current release', async () => {
    f.sys.failWhen((c) => c.op === 'stop');
    const ev = await rollbackTo(f.ctx, TARGET, 'you');
    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toBe("couldn't switch to abc1234; still running a1b2c3d");
    expect(isCurrent(f.paths, OLD)).toBe(true);
  });
});
