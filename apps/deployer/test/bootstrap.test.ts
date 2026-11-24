import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { BOOTSTRAP_BY, BOOTSTRAP_SIGNALS, BOOTSTRAP_TEXT, bootstrapRelease, holdSignals, parseCliArgs } from '../src/bootstrap.js';
import { parseCommand } from '../src/command.js';
import { currentTarget, isCurrent, releaseDir, switchCurrent } from '../src/releases.js';
import { BOOT, type DeployFixture, OLD, deploySetup, label, labels, probe } from './deploy-fixture.js';

const FROM = 'C:\\skali';
const BUILD = ['fetch', 'archive', 'tar', 'install', 'native', 'build'];

let f: DeployFixture;
beforeEach(() => {
  f = deploySetup();
  // Setup runs the bootstrap while Skáli still runs from the -From clone: no `current`, empty history.
  f.sys.serviceState = 'running';
  const out = f.sys.output!;
  f.sys.output = (c) => {
    const a = c.args ?? [];
    if (label(c) === 'git' && a.includes('log')) return ['Add auto-deploy'];
    return out(c);
  };
});
afterEach(() => f.cleanup());

const state = () => f.ctx.history.state();
const settingsCalls = () => f.sys.calls.filter((c) => label(c) === 'settings');
const logOf = (id: string) => readFileSync(path.join(f.paths.eventLogs, `${id}.log`), 'utf8');

describe('bootstrapRelease', () => {
  it('builds the -From sha, stops Skáli, probes, backs up, switches, applies settings, starts and health-checks', async () => {
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);

    expect(labels(f.sys)).toEqual(['git', ...BUILD, 'stop', 'probe', 'settings', 'start', 'healthy']);
    expect(ev).toMatchObject({ kind: 'DEPLOY', status: 'SUCCEEDED', sha: BOOT, message: 'Add auto-deploy', by: BOOTSTRAP_BY });
    expect(BOOTSTRAP_BY).toBe('setup');
    expect(isCurrent(f.paths, BOOT)).toBe(true);
    expect(f.sys.serviceState).toBe('running');
    // Offered for rollback later and never pruned as unknown.
    expect(state().running).toEqual({ sha: BOOT, message: 'Add auto-deploy', deployedAt: '2026-11-10T09:00:00.000Z' });
    expect(state().releases).toEqual([BOOT]);
    expect(state().lastDbVersion).toBe(3);
    // The probe ran from the new release (nothing of ours was current) with Skáli stopped.
    const probeCall = f.sys.calls.find((c) => label(c) === 'probe')!;
    expect(probeCall.args![0]).toBe(path.join(releaseDir(f.paths, BOOT), 'apps', 'server', 'dist', 'deploy-probe.js'));
    // Settings: the release's own script pointing Skali at <root>\current.
    expect(settingsCalls()).toHaveLength(1);
    expect(settingsCalls()[0]!.args).toEqual([
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(releaseDir(f.paths, BOOT), 'scripts', 'apply-service-settings.ps1'),
      '-Service', 'Skali', '-Root', f.root, '-Node', 'node',
    ]);
    const backups = readdirSync(f.paths.backups);
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(f.paths.backups, backups[0]!, 'skali.db'), 'utf8')).toBe('db-before');
    expect(logOf(ev.id)).toContain('▶ Health');
    // git log reads the repo as SYSTEM too: safe.directory, no token.
    expect(f.sys.calls.find((c) => label(c) === 'git')!.env).toEqual({ GIT_LOCAL: '1' });
  });

  it('the commit message falls back when git log prints nothing', async () => {
    f.sys.output = (c) => (label(c) === 'probe' ? [JSON.stringify(probe(3))] : []);
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);
    expect(ev.status).toBe('SUCCEEDED');
    expect(ev.message).toBe(BOOTSTRAP_TEXT.noMessage);
  });

  it('a health failure puts Skali back on the -From install exactly as before and starts it', async () => {
    f.sys.healthResults = [false, true];
    f.probes = [probe(3), probe(3)];
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);

    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toBe(`${BOOTSTRAP_TEXT.down}; ${BOOTSTRAP_TEXT.restored} (${FROM})`);
    // install-service.ps1's settings again: AppDirectory = -From.
    const restore = settingsCalls()[1]!;
    expect(restore.args).toEqual([
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(releaseDir(f.paths, BOOT), 'scripts', 'apply-service-settings.ps1'),
      '-Service', 'Skali', '-Root', f.root, '-Node', 'node', '-AppDirectory', FROM,
    ]);
    expect(labels(f.sys)).toEqual([
      'git', ...BUILD, 'stop', 'probe', 'settings', 'start', 'healthy', 'stop', 'probe', 'settings', 'start', 'healthy',
    ]);
    expect(currentTarget(f.paths)).toBeUndefined(); // nothing of ours is current, so the helper never touches Skali
    expect(f.sys.serviceState).toBe('running');
    expect(state().running).toBeUndefined();
    expect(state().releases).toEqual([]);
    expect(state().failedShas).toEqual([BOOT]);
  });

  it('the database changed but no game was started or stopped: restores the backup before going back', async () => {
    f.sys.healthResults = [false, true];
    f.probes = [probe(3), probe(4)];
    f.onProbe = (n) => {
      if (n === 2) writeFileSync(f.db(), 'db-migrated');
    };
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);
    expect(ev.detail).toBe(`${BOOTSTRAP_TEXT.down}; ${BOOTSTRAP_TEXT.restored} (${FROM})`);
    expect(readFileSync(f.db(), 'utf8')).toBe('db-before');
    expect(state().lastDbVersion).toBe(3);
    expect(currentTarget(f.paths)).toBeUndefined();
    expect(f.sys.serviceState).toBe('running');
  });

  it('the database changed and a game was started meanwhile: leaves the new release running', async () => {
    f.sys.healthResults = [false];
    f.probes = [probe(3), probe(4, [{ id: 's1', pid: 42, desired: 'running' }])];
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);
    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toContain(BOOTSTRAP_TEXT.down);
    expect(ev.detail).toContain(BOOTSTRAP_TEXT.stays);
    expect(isCurrent(f.paths, BOOT)).toBe(true);
    expect(settingsCalls()).toHaveLength(1);
    expect(f.sys.serviceState).toBe('running');
  });

  it('restoring the previous install can fail too: says so and leaves Skali started', async () => {
    f.sys.healthResults = [false, false];
    f.probes = [probe(3), probe(3)];
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);
    expect(ev.detail).toBe(`${BOOTSTRAP_TEXT.down}; ${BOOTSTRAP_TEXT.restoreFailed(FROM)}`);
    expect(f.sys.serviceState).toBe('running');
  });

  it('a failed build changes nothing: Skali keeps running from -From, the half-built release is removed', async () => {
    f.sys.failWhen((c) => label(c) === 'build');
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);
    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toContain(`Skáli still runs from ${FROM}`);
    expect(labels(f.sys)).not.toContain('stop');
    expect(labels(f.sys)).not.toContain('settings');
    expect(existsSync(releaseDir(f.paths, BOOT))).toBe(false);
    expect(currentTarget(f.paths)).toBeUndefined();
    expect(f.sys.serviceState).toBe('running');
  });

  it('Skali won\'t stop: nothing is switched and it is started again', async () => {
    f.sys.failWhen((c) => c.op === 'stop');
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);
    expect(ev.status).toBe('FAILED');
    expect(labels(f.sys)).not.toContain('settings');
    expect(currentTarget(f.paths)).toBeUndefined();
  });

  it('a failed backup starts Skali again without switching', async () => {
    f.onProbe = () => rmSync(f.db()); // the database vanishes, so backupDb fails
    const ev = await bootstrapRelease(f.ctx, BOOT, FROM);
    expect(ev.status).toBe('FAILED');
    expect(ev.detail).toContain('Database not found');
    expect(labels(f.sys)).not.toContain('settings');
    expect(currentTarget(f.paths)).toBeUndefined();
    expect(f.sys.serviceState).toBe('running');
  });

  it('refuses when `current` already exists (setup bootstraps only once)', async () => {
    f.addRelease(OLD);
    switchCurrent(f.paths, OLD);
    await expect(bootstrapRelease(f.ctx, BOOT, FROM)).rejects.toThrow(/already exists/);
    expect(f.sys.calls).toEqual([]);
    expect(f.ctx.history.events()).toEqual([]);
  });

  it('refuses an invalid sha or a relative -From before doing anything', async () => {
    await expect(bootstrapRelease(f.ctx, 'HEAD', FROM)).rejects.toThrow(/sha/);
    await expect(bootstrapRelease(f.ctx, BOOT, 'skali')).rejects.toThrow(/absolute/);
    expect(f.sys.calls).toEqual([]);
  });

  it('records "setup" only through this path: the API still rejects it', () => {
    expect(() => parseCommand({ type: 'deployNow', by: 'setup' })).toThrow();
  });
});

describe('parseCliArgs', () => {
  it('service mode: an optional config path', () => {
    expect(parseCliArgs([])).toEqual({});
    expect(parseCliArgs(['C:\\SkaliDeploy\\deployer\\deployer.json'])).toEqual({ config: 'C:\\SkaliDeploy\\deployer\\deployer.json' });
  });

  it('bootstrap mode: config, --bootstrap <sha> and --from <dir> in any order', () => {
    expect(parseCliArgs(['cfg.json', '--bootstrap', BOOT, '--from', FROM])).toEqual({
      config: 'cfg.json',
      bootstrap: { sha: BOOT, from: FROM },
    });
    expect(parseCliArgs(['--from', FROM, '--bootstrap', BOOT, 'cfg.json'])).toEqual({
      config: 'cfg.json',
      bootstrap: { sha: BOOT, from: FROM },
    });
  });

  it('rejects a half-given bootstrap, unknown flags and extra arguments', () => {
    expect(() => parseCliArgs(['--bootstrap', BOOT])).toThrow(/--from/);
    expect(() => parseCliArgs(['--from', FROM])).toThrow(/--bootstrap/);
    expect(() => parseCliArgs(['--bootstrap'])).toThrow();
    expect(() => parseCliArgs(['--force'])).toThrow(/Unknown/);
    expect(() => parseCliArgs(['a.json', 'b.json'])).toThrow();
  });
});

describe('holdSignals', () => {
  it('Ctrl+C, Ctrl+Break and SIGTERM during a bootstrap are logged and ignored, never leaving Skali stopped', () => {
    const proc = new EventEmitter();
    const said: string[] = [];
    const release = holdSignals(proc, (m) => said.push(m));
    expect(BOOTSTRAP_SIGNALS).toEqual(['SIGINT', 'SIGBREAK', 'SIGTERM']);
    for (const sig of BOOTSTRAP_SIGNALS) {
      // A listener exists, so Node does not take the default action (exit).
      expect(proc.listenerCount(sig)).toBe(1);
      proc.emit(sig, sig);
    }
    expect(said).toEqual([
      `SIGINT: ${BOOTSTRAP_TEXT.finishing}`,
      `SIGBREAK: ${BOOTSTRAP_TEXT.finishing}`,
      `SIGTERM: ${BOOTSTRAP_TEXT.finishing}`,
    ]);
    expect(BOOTSTRAP_TEXT.finishing).toBe('finishing the bootstrap (it puts Skáli back on failure)');
    release();
    for (const sig of BOOTSTRAP_SIGNALS) expect(proc.listenerCount(sig)).toBe(0);
  });
});
