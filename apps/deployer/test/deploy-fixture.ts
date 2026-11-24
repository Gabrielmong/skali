import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { DbProbe } from '../src/db-probe.js';
import { REQUIRED_FILES } from '../src/deploy-steps.js';
import type { Commit } from '../src/github.js';
import { releaseDir, switchCurrent } from '../src/releases.js';
import type { Call, FakeSystem } from './fakes.js';
import { type Fixture, setup, touch } from './op-fixture.js';

export const OLD = 'a1b2c3d' + '0'.repeat(33);
export const NEW = 'def5678' + '0'.repeat(33);
export const TARGET = 'abc1234' + '0'.repeat(33);
export const BOOT = 'b007000' + '1'.repeat(33);

export const commit = (sha: string, message = 'msg'): Commit => ({
  sha,
  message,
  date: '2026-11-10T08:00:00Z',
  author: 'a',
});

/** A probe result; servers default to one stopped server. */
export const probe = (userVersion: number, servers: DbProbe['servers'] = [{ id: 's1', pid: null, desired: 'stopped' }]): DbProbe => ({
  userVersion,
  walBytes: 0,
  servers,
});

/** A short name for each fake System call. */
export function label(c: Call): string {
  if (c.op !== 'run') return c.op;
  const name = path.basename(c.cmd!);
  const a = c.args ?? [];
  if (name === 'git') return a.includes('fetch') ? 'fetch' : a.includes('archive') ? 'archive' : a.includes('rev-parse') ? 'rev-parse' : 'git';
  if (name === 'tar') return 'tar';
  if (name === 'pnpm') return a[0] === 'install' ? 'install' : a[0] === 'build' ? 'build' : 'pnpm';
  if (name === 'node') return a[0] === '-e' ? 'native' : String(a[0]).endsWith('deploy-probe.js') ? 'probe' : 'node';
  if (name === 'powershell') return a.some((x) => x.endsWith('apply-service-settings.ps1')) ? 'settings' : 'powershell';
  return name;
}

/** Labels of every call except service status polls. */
export const labels = (sys: FakeSystem, skip: string[] = ['status']) =>
  sys.calls.map(label).filter((l) => !skip.includes(l));

/** A predicate true for the n-th call with this label (1-based). */
export const nth = (l: string, n: number) => {
  let seen = 0;
  return (c: Call) => label(c) === l && ++seen === n;
};

/** The release folder an apply-service-settings call ran from. */
export const scriptRelease = (c: Call) => {
  const file = c.args![c.args!.indexOf('-File') + 1]!;
  return path.dirname(path.dirname(file));
};

export interface DeployFixture extends Fixture {
  /** Consumed one per probe call; when empty, `probe` answers. undefined = probe prints nothing usable. */
  probes: (DbProbe | undefined)[];
  probe: DbProbe | undefined;
  /** Runs before a probe answers (e.g. to change the database as a started Skáli would). */
  onProbe?: (n: number) => void;
  /** Schema version written by a fake build. */
  newSchema: number;
  db(): string;
  addRelease(sha: string, schema?: number): void;
  /** OLD is the kept, running release: current -> OLD, Skali running. */
  runOld(schema?: number): void;
}

export function deploySetup(): DeployFixture {
  const base = setup();
  Object.assign(base.ctx.config, {
    appPort: 4200,
    healthTimeoutMs: 60_000,
    busyWaitMs: 600_000,
    maxEvents: 50,
    ciTimeoutMs: 1_800_000,
    pollMs: 120_000,
    ciWorkflowName: 'CI',
    installedDeployerTree: 'tree-installed',
  });
  const db = () => path.join(base.dataDir, 'skali.db');
  touch(db(), 'db-before');
  const writeSchema = (dir: string, schema: number) =>
    touch(path.join(dir, 'apps', 'server', 'dist', 'schema-version.json'), JSON.stringify({ schemaVersion: schema }));
  let probeCount = 0;
  const f: DeployFixture = {
    ...base,
    probes: [],
    probe: probe(3),
    newSchema: 4,
    db,
    addRelease(sha, schema = 3) {
      const dir = releaseDir(base.paths, sha);
      for (const r of REQUIRED_FILES) touch(path.join(dir, ...r.split('/')));
      writeSchema(dir, schema);
    },
    runOld(schema = 3) {
      f.addRelease(OLD, schema);
      switchCurrent(base.paths, OLD);
      base.ctx.history.update({ running: { sha: OLD, message: 'old', deployedAt: '2026-11-01T00:00:00.000Z' }, releases: [OLD] });
      base.sys.serviceState = 'running';
    },
  };
  base.sys.onRun((c) => {
    const l = label(c);
    if (l === 'archive') writeFileSync(c.args![c.args!.indexOf('-o') + 1]!, 'tar');
    if (l === 'build') {
      for (const r of REQUIRED_FILES) touch(path.join(c.cwd!, ...r.split('/')));
      writeSchema(c.cwd!, f.newSchema);
    }
  });
  base.sys.output = (c) => {
    if (label(c) !== 'probe') return [];
    probeCount += 1;
    f.onProbe?.(probeCount);
    const p = f.probes.length > 0 ? f.probes.shift() : f.probe;
    return p === undefined ? [] : [JSON.stringify(p)];
  };
  return f;
}
