import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface DeployerConfig {
  root: string;
  githubRepo: string;
  branch: string;
  tokenFile: string;
  apiTokenFile: string;
  apiPort: number;
  /** The NSSM service the deployer switches between releases. */
  serviceName: string;
  /** The port Skáli listens on; the health check hits http://127.0.0.1:<appPort>/api/games. */
  appPort: number;
  /** Skáli's data dir (database, backups source). Never moved by a deploy. */
  dataDir: string;
  pollMs: number;
  ciWorkflowName: string;
  ciTimeoutMs: number;
  /** How long a deploy waits for running games to end before switching anyway. */
  busyWaitMs: number;
  keepReleases: number;
  keepBackups: number;
  maxEvents: number;
  healthTimeoutMs: number;
  stepTimeoutsMs: StepTimeouts;
  bin: { node: string; pnpm: string; git: string; nssm: string; powershell: string; tar: string };
  installedDeployerTree: string;
}

/** Per-step command limits; a timeout kills the command's process tree and fails the step. */
export interface StepTimeouts {
  fetch: number;
  export: number;
  install: number;
  build: number;
  backup: number;
  settings: number; // apply-service-settings.ps1
}

export const DEFAULT_STEP_TIMEOUTS: StepTimeouts = {
  fetch: 300_000,
  export: 300_000,
  install: 1_800_000,
  build: 1_800_000,
  backup: 900_000,
  settings: 120_000,
};

export interface Paths {
  repo: string;
  releases: string;
  current: string;
  /** The deployer's own folder: `<root>\deployer`. */
  data: string;
  eventLogs: string;
  backups: string;
  pnpmStore: string;
  historyFile: string;
  apiTokenFile: string;
  /** The GitHub token. */
  tokenFile: string;
}

const DEFAULTS = {
  githubRepo: 'Gabrielmong/skali',
  branch: 'main',
  apiPort: 4201,
  serviceName: 'Skali',
  appPort: 4200,
  dataDir: 'C:\\ProgramData\\Skali',
  pollMs: 120_000,
  ciWorkflowName: 'CI',
  ciTimeoutMs: 1_800_000,
  busyWaitMs: 600_000,
  keepReleases: 5,
  keepBackups: 10,
  maxEvents: 50,
  healthTimeoutMs: 60_000,
};

const REQUIRED = ['root', 'tokenFile', 'apiTokenFile', 'bin', 'installedDeployerTree'] as const;

export function loadConfig(file: string): DeployerConfig {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const missing = REQUIRED.filter((k) => raw[k] === undefined || raw[k] === null || raw[k] === '');
  if (missing.length > 0) {
    throw new Error(`Deployer config ${file} is missing: ${missing.join(', ')}`);
  }
  const stepTimeoutsMs = { ...DEFAULT_STEP_TIMEOUTS, ...(raw.stepTimeoutsMs as Partial<StepTimeouts> | undefined) };
  return { ...DEFAULTS, ...raw, stepTimeoutsMs } as DeployerConfig;
}

export function pathsFor(root: string): Paths {
  const j = path.win32.join;
  const data = j(root, 'deployer');
  return {
    repo: j(root, 'repo'),
    releases: j(root, 'releases'),
    current: j(root, 'current'),
    data,
    eventLogs: j(data, 'logs'),
    backups: j(data, 'backups'),
    pnpmStore: j(data, 'pnpm-store'),
    historyFile: j(data, 'history.json'),
    apiTokenFile: j(data, 'api-token'),
    tokenFile: j(data, 'github-token'),
  };
}
