import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { History, tailLines } from '../src/history.js';

let dir: string;
let file: string;
let logs: string;
const now = () => new Date('2026-11-10T12:00:00.000Z');
const make = (max = 100) => new History(file, logs, max, now);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'history-'));
  file = join(dir, 'data', 'history.json');
  logs = join(dir, 'logs');
});

describe('History', () => {
  it('defaults', () => {
    const s = make().state();
    expect(s.autoDeploy.on).toBe(true);
    expect(s.failedShas).toEqual([]);
    expect(s.skippedShas).toEqual([]);
    expect(s.releases).toEqual([]);
    expect(make().events()).toEqual([]);
  });

  it('persists state and events across instances', () => {
    const a = make();
    a.update({ failedShas: ['abc'], autoDeploy: { on: false, reason: 'manual' } });
    const e = a.start({ kind: 'DEPLOY', sha: 'abc', by: 'auto' });
    a.finish(e.id, 'FAILED', 'boom');
    const b = make();
    expect(b.state().failedShas).toEqual(['abc']);
    expect(b.state().autoDeploy).toEqual({ on: false, reason: 'manual' });
    const [ev] = b.events();
    expect(ev).toMatchObject({ id: e.id, status: 'FAILED', detail: 'boom', finishedAt: now().toISOString() });
  });

  it('keeps the newest maxEvents and deletes dropped logs', () => {
    const h = make(3);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const e = h.record({ kind: 'PAUSE', status: 'SUCCEEDED', by: 'me' });
      writeFileSync(join(logs, `${e.id}.log`), 'x');
      ids.push(e.id);
    }
    expect(h.events().map((e) => e.id)).toEqual([ids[3], ids[2], ids[1]]);
    expect(existsSync(join(logs, `${ids[0]}.log`))).toBe(false);
    expect(existsSync(join(logs, `${ids[1]}.log`))).toBe(true);
  });

  it('never prunes a RUNNING event', () => {
    const h = make(1);
    const run = h.start({ kind: 'DEPLOY', by: 'auto' });
    h.record({ kind: 'PAUSE', status: 'SUCCEEDED', by: 'me' });
    h.record({ kind: 'RESUME', status: 'SUCCEEDED', by: 'me' });
    expect(h.events().some((e) => e.id === run.id)).toBe(true);
  });

  it('writes atomically', () => {
    const h = make();
    h.update({ releases: ['a'] });
    expect(readdirSync(join(dir, 'data')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  describe('a corrupt history.json (e.g. after a power cut)', () => {
    const corrupt = () => {
      mkdirSync(join(dir, 'data'), { recursive: true });
      writeFileSync(file, '{"state": {"autoDeploy"');
    };
    const quietly = () => vi.spyOn(console, 'error').mockImplementation(() => undefined);

    it('is moved aside and reported, starting from defaults', () => {
      corrupt();
      const err = quietly();
      const h = make();
      expect(h.state().autoDeploy.on).toBe(true);
      expect(h.events()).toEqual([]);
      const aside = join(dir, 'data', 'history.json.corrupt-20261110120000000');
      expect(readFileSync(aside, 'utf8')).toBe('{"state": {"autoDeploy"');
      expect(existsSync(file)).toBe(false);
      expect(err).toHaveBeenCalledWith(expect.stringContaining(aside));
      err.mockRestore();
    });

    it('uses history.json.tmp when that parses', () => {
      corrupt();
      writeFileSync(`${file}.tmp`, JSON.stringify({ state: { failedShas: ['abc'] }, events: [] }));
      const err = quietly();
      const h = make();
      expect(h.state().failedShas).toEqual(['abc']);
      expect(h.state().autoDeploy.on).toBe(true);
      err.mockRestore();
    });

    it('ignores a tmp file that does not parse either', () => {
      corrupt();
      writeFileSync(`${file}.tmp`, 'garbage');
      const err = quietly();
      expect(make().state().releases).toEqual([]);
      err.mockRestore();
    });
  });
});

describe('tailLines', () => {
  it('keeps the last N lines and the trailing newline', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc\n');
    expect(tailLines('a\nb\nc', 2)).toBe('b\nc');
    expect(tailLines('a\nb\n', 5)).toBe('a\nb\n');
  });
});
