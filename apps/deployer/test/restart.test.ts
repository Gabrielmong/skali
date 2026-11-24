import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RESTART_FAILED, restartApp } from '../src/restart.js';
import { type DeployFixture, OLD, deploySetup, labels } from './deploy-fixture.js';

let f: DeployFixture;
beforeEach(() => {
  f = deploySetup();
  f.runOld();
});
afterEach(() => f.cleanup());

describe('restartApp', () => {
  it('runs nssm restart Skali, then the health check', async () => {
    const ev = await restartApp(f.ctx, 'you');
    expect(labels(f.sys)).toEqual(['restart', 'healthy']);
    expect(f.sys.calls[0]).toMatchObject({ op: 'restart', cmd: 'Skali' });
    expect(f.sys.calls.at(-1)).toMatchObject({ op: 'healthy', url: 'http://127.0.0.1:4200/api/games' });
    expect(ev).toMatchObject({ kind: 'RESTART', status: 'SUCCEEDED', sha: OLD, by: 'you' });
  });

  it("fails with the Skáli text when it doesn't come up", async () => {
    f.sys.healthResult = false;
    const ev = await restartApp(f.ctx, 'you');
    expect(RESTART_FAILED).toBe("Skáli didn't come up after restart");
    expect(ev).toMatchObject({ status: 'FAILED', detail: RESTART_FAILED });
  });

  it('fails without throwing when nssm restart fails', async () => {
    f.sys.failWhen((c) => c.op === 'restart');
    const ev = await restartApp(f.ctx, 'you');
    expect(ev).toMatchObject({ status: 'FAILED', detail: RESTART_FAILED });
    expect(f.sys.calls.some((c) => c.op === 'healthy')).toBe(false);
  });
});
