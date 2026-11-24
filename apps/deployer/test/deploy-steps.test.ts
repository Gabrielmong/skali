import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REQUIRED_FILES, buildRelease, releaseSchemaVersion } from '../src/deploy-steps.js';
import { StepError } from '../src/op-steps.js';
import { releaseDir } from '../src/releases.js';
import type { Call } from './fakes.js';
import { type Fixture, SHA, setup, touch } from './op-fixture.js';

let f: Fixture;
let dir: string;
let skip: string[];
beforeEach(() => {
  f = setup();
  dir = releaseDir(f.paths, SHA);
  skip = [];
  f.sys.onRun((c: Call) => {
    const name = path.basename(c.cmd!);
    if (name === 'git' && c.args!.includes('archive')) writeFileSync(c.args![c.args!.indexOf('-o') + 1]!, 'tar');
    if (name === 'pnpm' && c.args![0] === 'build') {
      for (const r of REQUIRED_FILES) if (!skip.includes(r)) touch(path.join(dir, ...r.split('/')), '{"schemaVersion":7}');
    }
  });
});
afterEach(() => f.cleanup());

const tar = () => path.join(f.paths.data, 'export-abc1234.tar');
const runs = () => f.sys.calls.filter((c) => c.op === 'run');

describe('buildRelease', () => {
  it('runs fetch, export, install, native check, build in order with exact args', async () => {
    await buildRelease(f.ctx, SHA, dir, f.log);
    const r = runs();
    expect(r).toHaveLength(6);
    expect(r[0]!.args).toEqual(['-C', f.paths.repo, 'fetch', 'origin', 'main']);
    expect(r[0]!.env).toEqual({ GIT_CONFIG_COUNT: '1' });
    expect(r[0]!.timeoutMs).toBe(1001);
    expect(r[1]!.args).toEqual(['-C', f.paths.repo, 'archive', '-o', tar(), SHA]);
    expect(r[1]!.env).toEqual({ GIT_LOCAL: '1' }); // safe.directory, no token
    expect(r[2]!.cmd).toBe('tar');
    expect(r[2]!.args).toEqual(['-xf', tar(), '-C', dir]);
    expect(r[3]).toMatchObject({
      cmd: 'pnpm',
      args: ['install', '--frozen-lockfile', '--store-dir', f.paths.pnpmStore],
      cwd: dir,
      timeoutMs: 1004,
    });
    expect(r[4]).toMatchObject({ cmd: 'node', cwd: path.join(dir, 'apps', 'server') });
    expect(r[4]!.args![0]).toBe('-e');
    expect(r[4]!.args![1]).toContain('better-sqlite3');
    expect(r[5]).toMatchObject({ cmd: 'pnpm', args: ['build'], cwd: dir, timeoutMs: 1005 });
    expect(existsSync(tar())).toBe(false);
  });

  it.each([
    ['Fetch', (c: Call) => c.args!.includes('fetch'), 1],
    ['Export', (c: Call) => c.args!.includes('archive'), 2],
    ['Install', (c: Call) => c.args![0] === 'install', 4],
    ['Native check', (c: Call) => path.basename(c.cmd!) === 'node', 5],
    ['Build', (c: Call) => c.args![0] === 'build', 6],
  ])('stops at a failing %s step and leaves current untouched', async (title, pred, count) => {
    f.sys.failWhen((c) => c.op === 'run' && pred(c));
    await expect(buildRelease(f.ctx, SHA, dir, f.log)).rejects.toThrow(new RegExp(`^${title} failed`));
    expect(runs()).toHaveLength(count);
    expect(existsSync(f.paths.current)).toBe(false);
    expect(f.logText()).not.toContain('Verify');
  });

  it('native check failure carries the Node-version guidance', async () => {
    f.sys.failWhen((c) => path.basename(c.cmd!) === 'node');
    await expect(buildRelease(f.ctx, SHA, dir, f.log)).rejects.toThrow(
      /Node 22 or 24 LTS.*Desktop development with C\+\+/,
    );
  });

  it('Verify names the first missing file by relative path', async () => {
    skip = ['apps/server/dist/deploy-probe.js', 'apps/web/dist/index.html'];
    const err = await buildRelease(f.ctx, SHA, dir, f.log).catch((e) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err.message).toBe('Verify failed: missing apps/server/dist/deploy-probe.js');
  });

  it('rejects a malformed sha before running git', async () => {
    await expect(buildRelease(f.ctx, '--upload-pack=x', dir, f.log)).rejects.toThrow(/Export failed.*valid commit sha/);
    expect(runs().some((c) => c.args!.includes('archive'))).toBe(false);
  });

  it('reads the schema version the build wrote', () => {
    mkdirSync(path.join(dir, 'apps', 'server', 'dist'), { recursive: true });
    writeFileSync(path.join(dir, 'apps', 'server', 'dist', 'schema-version.json'), '{"schemaVersion": 9}');
    expect(releaseSchemaVersion(dir)).toBe(9);
  });
});
