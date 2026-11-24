import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, pathsFor } from '../src/config.js';

const bin = { node: 'n', pnpm: 'p', git: 'g', nssm: 'ns', powershell: 'ps', tar: 't' };
const minimal = {
  root: 'C:\\S',
  tokenFile: 't',
  apiTokenFile: 'a',
  bin,
  installedDeployerTree: 'abc',
};

function tmpFile(name: string, content: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'deployer-')), name);
  writeFileSync(file, content);
  return file;
}

describe('loadConfig', () => {
  it('fills defaults', () => {
    const cfg = loadConfig(tmpFile('c.json', JSON.stringify(minimal)));
    expect(cfg).toMatchObject({
      githubRepo: 'Gabrielmong/skali',
      branch: 'main',
      apiPort: 4201,
      serviceName: 'Skali',
      appPort: 4200,
      dataDir: 'C:\\ProgramData\\Skali',
      pollMs: 120000,
      ciWorkflowName: 'CI',
      ciTimeoutMs: 1800000,
      busyWaitMs: 600000,
      keepReleases: 5,
      keepBackups: 10,
      maxEvents: 50,
      healthTimeoutMs: 60000,
    });
  });

  it('lets the file override a default', () => {
    const cfg = loadConfig(tmpFile('c.json', JSON.stringify({ ...minimal, githubRepo: 'o/r', appPort: 5000 })));
    expect(cfg).toMatchObject({ githubRepo: 'o/r', appPort: 5000 });
  });

  it('fills step timeouts, keeping any the file overrides', () => {
    const cfg = loadConfig(tmpFile('c.json', JSON.stringify({ ...minimal, stepTimeoutsMs: { build: 60000 } })));
    expect(cfg.stepTimeoutsMs).toEqual({
      fetch: 300000,
      export: 300000,
      install: 1800000,
      build: 60000,
      backup: 900000,
      settings: 120000,
    });
    expect(loadConfig(tmpFile('c.json', JSON.stringify(minimal))).stepTimeoutsMs.build).toBe(1800000);
  });

  it('names missing keys', () => {
    const { root: _omit, ...rest } = minimal;
    expect(() => loadConfig(tmpFile('c.json', JSON.stringify(rest)))).toThrow(/root/);
  });
});

describe('pathsFor', () => {
  it('joins under the root with windows separators, and nothing else', () => {
    expect(pathsFor('C:\\S')).toEqual({
      repo: 'C:\\S\\repo',
      releases: 'C:\\S\\releases',
      current: 'C:\\S\\current',
      data: 'C:\\S\\deployer',
      eventLogs: 'C:\\S\\deployer\\logs',
      backups: 'C:\\S\\deployer\\backups',
      pnpmStore: 'C:\\S\\deployer\\pnpm-store',
      historyFile: 'C:\\S\\deployer\\history.json',
      apiTokenFile: 'C:\\S\\deployer\\api-token',
      tokenFile: 'C:\\S\\deployer\\github-token',
    });
  });
});
