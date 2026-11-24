import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type DeployerConfig, pathsFor } from '../src/config.js';
import { openLog } from '../src/op-context.js';
import { realContext } from '../src/real-context.js';
import { makeRedactor } from '../src/redact.js';
import { FakeSystem } from './fakes.js';

let root: string;
let config: DeployerConfig;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'realctx-'));
  config = { root, maxEvents: 50 } as DeployerConfig;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const GH = 'github_pat_tok123456';
/** safe.directory wants forward slashes. */
const repoSafe = (r: string) => path.join(r, 'repo').replace(/\\/g, '/');
const basicOf = (t: string) => Buffer.from(`x-access-token:${t}`).toString('base64');

describe('realContext', () => {
  it('git auth goes through child-only env config: a basic extraheader scoped to github.com, never interactive', () => {
    const ctx = realContext(config, pathsFor(root), { github: () => GH, api: 'api-tok-456' }, new FakeSystem());
    expect(ctx.gitEnv()).toEqual({
      GIT_CONFIG_COUNT: '3',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: repoSafe(root),
      GIT_CONFIG_KEY_1: 'credential.interactive',
      GIT_CONFIG_VALUE_1: 'false',
      GIT_CONFIG_KEY_2: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_2: `Authorization: Basic ${basicOf(GH)}`,
      GCM_INTERACTIVE: 'never',
      GIT_TERMINAL_PROMPT: '0',
    });
  });

  it('local git calls (archive, rev-parse, log) get safe.directory for <root>/repo and no token', () => {
    const ctx = realContext(config, pathsFor(root), { github: () => GH, api: 'api-tok-456' }, new FakeSystem());
    const env = ctx.gitLocalEnv();
    expect(env).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'safe.directory',
      GIT_CONFIG_VALUE_0: repoSafe(root),
      GIT_CONFIG_KEY_1: 'credential.interactive',
      GIT_CONFIG_VALUE_1: 'false',
      GCM_INTERACTIVE: 'never',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(JSON.stringify(env)).not.toContain(basicOf(GH));
    expect(env.GIT_CONFIG_VALUE_0).not.toContain('\\');
  });

  it('secrets are the GitHub token, the API token and the base64 Basic value', () => {
    const ctx = realContext(config, pathsFor(root), { github: () => GH, api: 'api-tok-456' }, new FakeSystem());
    expect(ctx.secrets()).toEqual([GH, 'api-tok-456', basicOf(GH)]);
  });

  it('the redactor removes the bare base64 Basic value from a log line', () => {
    const ctx = realContext(config, pathsFor(root), { github: () => GH, api: 'api-tok-456' }, new FakeSystem());
    const b64 = basicOf(GH);
    expect(makeRedactor(ctx.secrets())(`git said: header ${b64} rejected`)).toBe('git said: header *** rejected');
    openLog(ctx, 'e1').log.line(`trace ${b64} api-tok-456`);
    const text = readFileSync(path.join(pathsFor(root).eventLogs, 'e1.log'), 'utf8');
    expect(text).toBe('trace *** ***\n');
  });

  it('reads the GitHub token each time, so a replaced token is used without a restart', () => {
    let token = GH;
    const ctx = realContext(config, pathsFor(root), { github: () => token, api: 'api' }, new FakeSystem());
    token = 'github_pat_newer9999';
    expect(ctx.gitEnv().GIT_CONFIG_VALUE_2).toBe(`Authorization: Basic ${basicOf(token)}`);
  });
});
