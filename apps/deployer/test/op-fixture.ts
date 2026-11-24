import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DeployerConfig, Paths } from '../src/config.js';
import { EventLog } from '../src/event-log.js';
import { History } from '../src/history.js';
import type { OpContext } from '../src/op-context.js';
import { FakeSystem } from './fakes.js';

export const SHA = 'abc1234ffffffffffffffffffffffffffffffff0';

export interface Fixture {
  root: string;
  dataDir: string;
  paths: Paths;
  sys: FakeSystem;
  ctx: OpContext;
  log: EventLog;
  logText(): string;
  cleanup(): void;
}

/** Native paths over a temp dir (pathsFor uses path.win32), with a fake System. */
export function setup(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'ops-'));
  const j = (...p: string[]) => path.join(root, ...p);
  const paths: Paths = {
    repo: j('repo'),
    releases: j('releases'),
    current: j('current'),
    data: j('deployer'),
    eventLogs: j('deployer', 'logs'),
    backups: j('deployer', 'backups'),
    pnpmStore: j('deployer', 'pnpm-store'),
    historyFile: j('deployer', 'history.json'),
    apiTokenFile: j('deployer', 'api-token'),
    tokenFile: j('deployer', 'github-token'),
  };
  const dataDir = j('data');
  mkdirSync(paths.releases, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const now = () => new Date('2026-11-10T09:00:00Z');
  const sys = new FakeSystem();
  sys.serviceState = 'stopped';
  const config = {
    root,
    dataDir,
    serviceName: 'Skali',
    keepReleases: 5,
    keepBackups: 10,
    branch: 'main',
    stepTimeoutsMs: { fetch: 1001, export: 1002, install: 1004, build: 1005, backup: 1007, settings: 1009 },
    bin: { node: 'node', pnpm: 'pnpm', git: 'git', nssm: 'nssm', powershell: 'powershell', tar: 'tar' },
  } as DeployerConfig;
  const ctx: OpContext = {
    config,
    paths,
    sys,
    history: new History(paths.historyFile, paths.eventLogs, 50, now),
    gitEnv: () => ({ GIT_CONFIG_COUNT: '1' }),
    gitLocalEnv: () => ({ GIT_LOCAL: '1' }),
    secrets: () => [],
    now,
  };
  const logFile = path.join(paths.eventLogs, 'e.log');
  const log = new EventLog(logFile, (s) => s);
  return {
    root,
    dataDir,
    paths,
    sys,
    ctx,
    log,
    logText: () => readFileSync(logFile, 'utf8'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const touch = (file: string, text = 'x') => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};
