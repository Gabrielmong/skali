import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EventLog } from '../src/event-log.js';
import { readLog } from '../src/history.js';
import { makeRedactor } from '../src/redact.js';

describe('EventLog', () => {
  it('redacts, splits lines and formats sections', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evlog-'));
    const file = join(dir, 'nested', 'e1.log');
    const log = new EventLog(file, makeRedactor(['s3cret']));
    log.section('Build');
    log.line('token s3cret\nsecond');
    log.ok('Build', 12000);
    log.fail('Migrate', 'bad');
    expect(readFileSync(file, 'utf8')).toBe(
      '▶ Build\ntoken ***\nsecond\n✔ Build (12s)\n✖ Migrate: bad\n',
    );
  });

  it('redacts the whole text before splitting lines (secrets across CRLF)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evlog-'));
    const file = join(dir, 'e2.log');
    const log = new EventLog(file, makeRedactor(['part1\r\npart2']));
    log.line('a part1\r\npart2 b\r\nnext');
    expect(readFileSync(file, 'utf8')).toBe('a *** b\nnext\n');
  });

  it('readLog returns the file, or the last lines, or undefined', () => {
    const dir = mkdtempSync(join(tmpdir(), 'evlog-'));
    const id = '20261110120000000-a1b2c3';
    writeFileSync(join(dir, `${id}.log`), 'one\ntwo\nthree\n');
    expect(readLog(dir, id)).toBe('one\ntwo\nthree\n');
    expect(readLog(dir, id, 2)).toBe('two\nthree\n');
    expect(readLog(dir, '20261110120000000-000000')).toBeUndefined();
  });

  it('readLog refuses ids that are not event ids (no path traversal)', () => {
    const root = mkdtempSync(join(tmpdir(), 'evlog-'));
    const dir = join(root, 'logs');
    mkdirSync(dir);
    writeFileSync(join(root, 'x.log'), 'outside');
    writeFileSync(join(dir, 'a.log'), 'not an event id');
    for (const id of ['../x', '..\\x', 'a', '20261110120000000-a1b2c3/../../x', '20261110120000000-A1B2C3']) {
      expect(readLog(dir, id)).toBeUndefined();
    }
  });
});
