import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEPLOY_TEXT, deployCommit } from '../src/deploy.js';
import { isCurrent, releaseDir, switchCurrent } from '../src/releases.js';
import { markEvents } from '../src/rollback-eligibility.js';
import {
  BOOT,
  type DeployFixture,
  NEW,
  OLD,
  commit,
  deploySetup,
  label,
  labels,
  probe,
  scriptRelease,
} from './deploy-fixture.js';

let f: DeployFixture;
beforeEach(() => {
  f = deploySetup();
});
afterEach(() => f.cleanup());

const BUILD = ['fetch', 'archive', 'tar', 'install', 'native', 'build'];
const logOf = (id: string) => readFileSync(path.join(f.paths.eventLogs, `${id}.log`), 'utf8');
const settingsRuns = () => f.sys.calls.filter((c) => label(c) === 'settings').map(scriptRelease);
const history = () => f.ctx.history.state();

describe('deployCommit', () => {
  it('happy path: build, busy-wait, stop, probe, backup, switch + settings, start, health; then prune', async () => {
    f.runOld();
    const ev = await deployCommit(f.ctx, commit(NEW, 'add saves'), 'auto', { ciRunUrl: 'https://gh/run/1' });

    expect(labels(f.sys)).toEqual([...BUILD, 'http', 'stop', 'probe', 'settings', 'start', 'healthy']);
    expect(ev).toMatchObject({ kind: 'DEPLOY', status: 'SUCCEEDED', sha: NEW, message: 'add saves', by: 'auto', ciRunUrl: 'https://gh/run/1' });
    expect(history().running).toEqual({ sha: NEW, message: 'add saves', deployedAt: '2026-11-10T09:00:00.000Z' });
    expect(history().releases).toEqual([NEW, OLD]);
    expect(history().lastDbVersion).toBe(3);
    expect(isCurrent(f.paths, NEW)).toBe(true);
    expect(f.sys.serviceState).toBe('running');

    // The probe ran from the release that was current, before the switch.
    const probeCall = f.sys.calls.find((c) => label(c) === 'probe')!;
    expect(probeCall.args![0]).toBe(path.join(releaseDir(f.paths, OLD), 'apps', 'server', 'dist', 'deploy-probe.js'));
    // Settings: the new release's script with the agreed arguments.
    const settings = f.sys.calls.find((c) => label(c) === 'settings')!;
    expect(settings.args).toEqual([
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(releaseDir(f.paths, NEW), 'scripts', 'apply-service-settings.ps1'),
      '-Service', 'Skali', '-Root', f.root, '-Node', 'node',
    ]);
    expect(settings.timeoutMs).toBe(1009);
    expect(f.sys.calls.find((c) => c.op === 'healthy')!.url).toBe('http://127.0.0.1:4200/api/games');
    expect(f.sys.calls.find((c) => c.op === 'http')!.url).toBe('http://127.0.0.1:4200/api/deploys/busy');
    // Only the Skali service is ever stopped or started.
    expect(f.sys.calls.filter((c) => ['stop', 'start', 'restart', 'status'].includes(c.op)).every((c) => c.cmd === 'Skali')).toBe(true);

    // The backup was written, between the database read and the switch.
    const backups = readdirSync(f.paths.backups);
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(f.paths.backups, backups[0]!, 'skali.db'), 'utf8')).toBe('db-before');
    const lines = logOf(ev.id).split('\n');
    const at = (s: string) => lines.findIndex((l) => l.startsWith(s));
    expect(at('▶ Wait for Skáli to be idle')).toBeGreaterThan(at('✔ Verify'));
    expect(at('▶ Stop Skáli')).toBeGreaterThan(at('▶ Wait for Skáli to be idle'));
    expect(at('▶ Read database')).toBeGreaterThan(at('▶ Stop Skáli'));
    expect(at('▶ Back up database')).toBeGreaterThan(at('▶ Read database'));
    expect(at('▶ Switch')).toBeGreaterThan(at('▶ Back up database'));
    expect(at('▶ Health')).toBeGreaterThan(at('▶ Switch'));
  });

  it('deploy now (by you) skips the busy-wait', async () => {
    f.runOld();
    f.sys.http = () => ({ status: 200, body: JSON.stringify({ busy: true, reasons: ['x'] }) });
    const ev = await deployCommit(f.ctx, commit(NEW), 'you');
    expect(ev.status).toBe('SUCCEEDED');
    expect(labels(f.sys)).not.toContain('http');
  });

  it('waitForIdle: false skips the busy-wait even for by "auto"', async () => {
    f.runOld();
    await deployCommit(f.ctx, commit(NEW), 'auto', { waitForIdle: false });
    expect(labels(f.sys)).not.toContain('http');
  });

  it('Skáli unreachable on the busy route: the deploy proceeds at once', async () => {
    f.runOld();
    f.sys.http = () => new Error('connect ECONNREFUSED');
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(ev.status).toBe('SUCCEEDED');
    expect(labels(f.sys).filter((l) => l === 'http')).toHaveLength(1);
  });

  it('build failure leaves Skali untouched (never stopped) and removes the half-built release', async () => {
    f.runOld();
    f.sys.failWhen((c) => label(c) === 'build', new Error('pnpm exited 1'));
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');

    expect(f.sys.calls.some((c) => c.op !== 'run')).toBe(false);
    expect(f.sys.serviceState).toBe('running');
    expect(existsSync(releaseDir(f.paths, NEW))).toBe(false);
    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toBe('Build failed: pnpm exited 1; still running a1b2c3d');
    expect(history().failedShas).toEqual([NEW]);
    expect(history().running!.sha).toBe(OLD);
    expect(isCurrent(f.paths, OLD)).toBe(true);
  });

  it('health fails, database version unchanged → switch back: failed (rolled back automatically)', async () => {
    f.runOld();
    f.sys.healthResults = [false, true];
    f.probes = [probe(3), probe(3)];
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');

    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toBe(DEPLOY_TEXT.rolledBack);
    expect(DEPLOY_TEXT.rolledBack).toBe('rolled back automatically');
    expect(labels(f.sys).slice(-9)).toEqual(['probe', 'settings', 'start', 'healthy', 'stop', 'probe', 'settings', 'start', 'healthy']);
    expect(settingsRuns()).toEqual([releaseDir(f.paths, NEW), releaseDir(f.paths, OLD)]);
    // The second probe read the database with the new release.
    const probes = f.sys.calls.filter((c) => label(c) === 'probe');
    expect(probes[1]!.args![0]).toContain(path.join('releases', 'def5678'));
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(readFileSync(f.db(), 'utf8')).toBe('db-before');
    expect(logOf(ev.id)).not.toContain('Database restored');
    expect(history().running!.sha).toBe(OLD);
    expect(history().releases).toEqual([OLD]);
    expect(history().failedShas).toEqual([NEW]);
    expect(f.sys.serviceState).toBe('running');
  });

  it('health fails, version changed, no game started or stopped → restore this deploy\'s backup: failed (rolled back, database restored)', async () => {
    f.runOld();
    // An older backup that must not be the one restored.
    mkdirSync(path.join(f.paths.backups, '2026-01-01T00-00-00.000Z-0000000'), { recursive: true });
    writeFileSync(path.join(f.paths.backups, '2026-01-01T00-00-00.000Z-0000000', 'skali.db'), 'ancient');
    f.sys.healthResults = [false, true];
    f.probes = [probe(3), probe(4)];
    f.onProbe = (n) => {
      if (n === 2) writeFileSync(f.db(), 'migrated'); // the new Skáli migrated the database
    };
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');

    expect(ev.detail).toBe(DEPLOY_TEXT.restored);
    expect(DEPLOY_TEXT.restored).toBe('rolled back, database restored');
    expect(readFileSync(f.db(), 'utf8')).toBe('db-before');
    expect(logOf(ev.id)).toMatch(/Database restored from .*-def5678/);
    expect(labels(f.sys).slice(-8)).toEqual(['settings', 'start', 'healthy', 'stop', 'probe', 'settings', 'start', 'healthy']);
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(history().running!.sha).toBe(OLD);
    // The database is the backup again: version 3, not the 4 the failed release left.
    expect(history().lastDbVersion).toBe(3);
    expect(history().failedShas).toEqual([NEW]);
    expect(f.sys.serviceState).toBe('running');
    // So an older kept release with schema 3 is offered for rollback.
    const MID = '5555555000000000000000000000000000000000';
    f.addRelease(MID, 3);
    f.ctx.history.update({ releases: [OLD, MID] });
    f.ctx.history.record({ kind: 'DEPLOY', status: 'SUCCEEDED', sha: MID, message: 'mid', by: 'auto' });
    const marked = markEvents(f.ctx, f.ctx.history.events(), OLD);
    expect(marked.find((e) => e.sha === MID)).toMatchObject({ canRollback: true });
  });

  it("a game's pid changed during the window → no restore, the new release stays: failed (app didn't come up)", async () => {
    f.runOld();
    f.sys.healthResult = false;
    f.probes = [probe(3, [{ id: 's1', pid: null, desired: 'stopped' }]), probe(4, [{ id: 's1', pid: 4242, desired: 'running' }])];
    f.onProbe = (n) => {
      if (n === 2) writeFileSync(f.db(), 'migrated');
    };
    const ev = await deployCommit(f.ctx, commit(NEW, 'new saves'), 'auto');

    expect(ev.detail).toBe(DEPLOY_TEXT.down);
    expect(DEPLOY_TEXT.down).toBe("app didn't come up");
    expect(readFileSync(f.db(), 'utf8')).toBe('migrated');
    expect(isCurrent(f.paths, NEW)).toBe(true);
    expect(labels(f.sys).slice(-5)).toEqual(['start', 'healthy', 'stop', 'probe', 'start']);
    expect(settingsRuns()).toEqual([releaseDir(f.paths, NEW)]);
    expect(f.sys.serviceState).toBe('running');
    expect(history().autoDeploy.on).toBe(true);
    expect(history().failedShas).toEqual([NEW]);
    expect(history().running).toMatchObject({ sha: NEW, message: 'new saves' });
    expect(history().releases).toEqual([OLD]);
  });

  it("a probe that can't be read (before) → the new release stays: failed (app didn't come up)", async () => {
    f.runOld();
    f.sys.healthResult = false;
    f.probes = [undefined, probe(3)];
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(ev.detail).toBe("app didn't come up");
    expect(isCurrent(f.paths, NEW)).toBe(true);
    expect(f.sys.serviceState).toBe('running');
    expect(readFileSync(f.db(), 'utf8')).toBe('db-before');
  });

  it("a probe that can't be read (after) → the new release stays too", async () => {
    f.runOld();
    f.sys.healthResult = false;
    f.probes = [probe(3), undefined];
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(ev.detail).toBe("app didn't come up");
    expect(isCurrent(f.paths, NEW)).toBe(true);
  });

  it('a failed backup starts the old release again and changes nothing', async () => {
    f.runOld();
    rmSync(f.db());
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(ev.detail).toMatch(/^Back up database failed: Database not found: .*; still running a1b2c3d$/);
    expect(labels(f.sys).slice(-3)).toEqual(['stop', 'probe', 'start']);
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(f.sys.serviceState).toBe('running');
  });

  it('stops a crash-looping old release (NSSM shows it paused) and deploys the fix', async () => {
    f.runOld();
    f.sys.serviceState = 'paused';
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(ev.status).toBe('SUCCEEDED');
    expect(labels(f.sys)).toContain('stop');
    expect(isCurrent(f.paths, NEW)).toBe(true);
    expect(f.sys.serviceState).toBe('running');
  });

  it('a failed stop keeps the old release and starts it if it went down', async () => {
    f.runOld();
    // serviceStop as a whole rejects (a timeout), and the service is down by then.
    f.sys.serviceStop = async (name) => {
      f.sys.calls.push({ op: 'stop', cmd: name });
      f.sys.serviceState = 'stopped';
      throw new Error('Skali did not stop within 30 s');
    };
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(ev.detail).toBe('Stop Skáli failed: Skali did not stop within 30 s; still running a1b2c3d');
    expect(labels(f.sys).slice(-2)).toEqual(['stop', 'start']);
    expect(isCurrent(f.paths, OLD)).toBe(true);
  });

  it('a failed settings script switches back (the database never changed)', async () => {
    f.runOld();
    f.sys.failWhen((c) => label(c) === 'settings' && scriptRelease(c) === releaseDir(f.paths, NEW));
    f.probes = [probe(3), probe(3)];
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(ev.detail).toBe('rolled back automatically');
    expect(isCurrent(f.paths, OLD)).toBe(true);
    expect(f.sys.serviceState).toBe('running');
  });

  it('prunes to the kept releases, keeping the new one and current', async () => {
    f.ctx.config.keepReleases = 2;
    f.runOld();
    const MID = '5555555000000000000000000000000000000000';
    const GONE = '4444444000000000000000000000000000000000';
    f.addRelease(MID);
    f.addRelease(GONE);
    f.ctx.history.update({ releases: [OLD, MID, GONE] });
    await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(history().releases).toEqual([NEW, OLD]);
    expect(readdirSync(f.paths.releases).sort()).toEqual(['a1b2c3d', 'def5678']);
  });

  it('first deploy after setup: current is the bootstrap release, history empty', async () => {
    f.addRelease(BOOT);
    switchCurrent(f.paths, BOOT);
    f.sys.serviceState = 'running';
    expect(f.ctx.history.events()).toEqual([]);
    const ev = await deployCommit(f.ctx, commit(NEW, 'first'), 'auto');
    expect(ev.status).toBe('SUCCEEDED');
    expect(history().running).toMatchObject({ sha: NEW, message: 'first' });
    expect(history().releases).toEqual([NEW]);
    expect(isCurrent(f.paths, NEW)).toBe(true);
    const probeCall = f.sys.calls.find((c) => label(c) === 'probe')!;
    expect(probeCall.args![0]).toContain(path.join('releases', 'b007000'));
  });

  it('first deploy after setup whose health fails switches back to the bootstrap release', async () => {
    f.addRelease(BOOT);
    switchCurrent(f.paths, BOOT);
    f.sys.serviceState = 'running';
    f.sys.healthResults = [false, true];
    f.probes = [probe(3), probe(3)];
    const ev = await deployCommit(f.ctx, commit(NEW), 'auto');
    expect(ev.detail).toBe('rolled back automatically');
    expect(isCurrent(f.paths, BOOT)).toBe(true);
  });

  it('a later success clears the sha from failedShas', async () => {
    f.runOld();
    f.ctx.history.update({ failedShas: [NEW] });
    await deployCommit(f.ctx, commit(NEW), 'you');
    expect(history().failedShas).toEqual([]);
  });
});
