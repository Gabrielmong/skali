import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeDb } from '../src/db-probe.js';
import { type Fixture, setup } from './op-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = setup();
});
afterEach(() => f.cleanup());

const json = (o: unknown) => JSON.stringify(o);
const rel = path.join('R:', 'rel');

describe('probeDb', () => {
  it('runs the probe from the release against <dataDir>/skali.db and parses its line', async () => {
    const out = { userVersion: 4, walBytes: 0, servers: [{ id: 's', pid: null, desired: 'stopped' }] };
    f.sys.output = () => ['', json(out)];
    expect(await probeDb(f.ctx, rel)).toEqual(out);
    const c = f.sys.calls.find((x) => x.op === 'run')!;
    expect(c.cmd).toBe('node');
    expect(c.args).toEqual([
      path.join(rel, 'apps', 'server', 'dist', 'deploy-probe.js'),
      path.join(f.dataDir, 'skali.db'),
    ]);
  });

  it('is undefined when walBytes > 0', async () => {
    f.sys.output = () => [json({ userVersion: 4, walBytes: 3, servers: [] })];
    expect(await probeDb(f.ctx, rel)).toBeUndefined();
  });

  it('is undefined on a non-zero exit', async () => {
    f.sys.failWhen((c) => c.op === 'run', new Error('exited 2'));
    expect(await probeDb(f.ctx, rel)).toBeUndefined();
  });

  it('is undefined on bad JSON or a wrong shape', async () => {
    f.sys.output = () => ['not json'];
    expect(await probeDb(f.ctx, rel)).toBeUndefined();
    f.sys.output = () => [json({ userVersion: 'x' })];
    expect(await probeDb(f.ctx, rel)).toBeUndefined();
  });
});
