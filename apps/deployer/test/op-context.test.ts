import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type OpContext, errorText, healthUrl, openLog, opSecrets, short } from '../src/op-context.js';

describe('opSecrets', () => {
  it('is the tokens, nothing more', () => {
    expect(opSecrets(['ghp_x', 'api'])).toEqual(['ghp_x', 'api']);
  });
});

describe('helpers', () => {
  it('shortens a sha to 7 chars', () => expect(short('0123456789abcdef')).toBe('0123456'));

  it('reads error text', () => {
    expect(errorText(new Error('boom'))).toBe('boom');
    expect(errorText('plain')).toBe('plain');
  });

  it('health URL is the games endpoint on the app port', () => {
    expect(healthUrl({ appPort: 4200 })).toBe('http://127.0.0.1:4200/api/games');
  });

  it('openLog redacts the context secrets, and survives secrets() throwing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'opctx-'));
    const ctx = { paths: { eventLogs: dir }, secrets: () => ['hunter22'] } as unknown as OpContext;
    openLog(ctx, 'e1').log.line('pw hunter22');
    expect(readFileSync(path.join(dir, 'e1.log'), 'utf8')).toBe('pw ***\n');
    const bad = {
      paths: { eventLogs: dir },
      secrets: () => {
        throw new Error('x');
      },
    } as unknown as OpContext;
    openLog(bad, 'e2').log.line('ghp_abcdEFGH1234');
    expect(readFileSync(path.join(dir, 'e2.log'), 'utf8')).toBe('***\n');
  });
});
