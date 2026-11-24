import { existsSync, mkdirSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDb, restoreDb } from '../src/backup.js';
import { type Fixture, SHA, setup, touch } from './op-fixture.js';

let f: Fixture;
beforeEach(() => {
  f = setup();
  touch(path.join(f.dataDir, 'skali.db'), 'db');
});
afterEach(() => f.cleanup());

const db = (s = '') => path.join(f.dataDir, `skali.db${s}`);

describe('backupDb', () => {
  it('copies the db and sidecars into <time>-<sha7> with a Windows-safe name', async () => {
    touch(db('-wal'), 'w');
    const dir = await backupDb(f.ctx, SHA, f.log);
    expect(path.basename(dir)).toBe('2026-11-10T09-00-00.000Z-abc1234');
    expect(readdirSync(dir).sort()).toEqual(['skali.db', 'skali.db-wal']);
    expect(readFileSync(path.join(dir, 'skali.db'), 'utf8')).toBe('db');
  });

  it('keeps the newest 10 of 12', async () => {
    for (let i = 0; i < 12; i++) {
      const name = `2026-10-${String(10 + i).padStart(2, '0')}T00-00-00.000Z-aaaaaaa`;
      mkdirSync(path.join(f.paths.backups, name), { recursive: true });
    }
    await backupDb(f.ctx, SHA, f.log);
    const left = readdirSync(f.paths.backups).sort();
    expect(left).toHaveLength(10);
    expect(left.at(-1)).toContain('2026-11-10');
    expect(left[0]).toContain('2026-10-13');
  });

  it('refuses while the service is not stopped, touching nothing', async () => {
    f.sys.serviceState = 'running';
    await expect(backupDb(f.ctx, SHA, f.log)).rejects.toThrow(/stopped/);
    expect(existsSync(f.paths.backups)).toBe(false);
  });
});

describe('backupDb guards', () => {
  it('throws when skali.db is missing, before creating a backup folder', async () => {
    rmSync(db());
    await expect(backupDb(f.ctx, SHA, f.log)).rejects.toThrow(/Database not found/);
    expect(existsSync(f.paths.backups)).toBe(false);
  });

  it.each(['-x', '../../x', 'ABC1234', 'abc'])('rejects the sha %s', async (bad) => {
    await expect(backupDb(f.ctx, bad, f.log)).rejects.toThrow(/valid commit sha/);
  });
});

describe('restoreDb', () => {
  it('throws, deleting nothing, when the backup has no skali.db', async () => {
    const empty = path.join(f.root, 'empty-backup');
    mkdirSync(empty);
    touch(db('-wal'), 'live');
    await expect(restoreDb(f.ctx, empty, f.log)).rejects.toThrow(/no skali\.db/);
    expect(readFileSync(db(), 'utf8')).toBe('db');
    expect(existsSync(db('-wal'))).toBe(true);
  });

  it('a failed copy leaves the live database and sidecars intact and no temp files', async () => {
    const bad = path.join(f.root, 'bad-backup');
    mkdirSync(path.join(bad, 'skali.db'), { recursive: true }); // a directory: copyFileSync fails
    touch(db('-wal'), 'live');
    await expect(restoreDb(f.ctx, bad, f.log)).rejects.toThrow();
    expect(readFileSync(db(), 'utf8')).toBe('db');
    expect(readFileSync(db('-wal'), 'utf8')).toBe('live');
    expect(readdirSync(f.dataDir).filter((n) => n.endsWith('.restore-tmp'))).toEqual([]);
  });

  it('copies back and removes a -wal/-shm the backup lacks', async () => {
    const dir = await backupDb(f.ctx, SHA, f.log);
    touch(db(), 'newer');
    touch(db('-wal'), 'stray');
    touch(db('-shm'), 'stray');
    await restoreDb(f.ctx, dir, f.log);
    expect(readFileSync(db(), 'utf8')).toBe('db');
    expect(existsSync(db('-wal'))).toBe(false);
    expect(existsSync(db('-shm'))).toBe(false);
  });

  it('refuses while the service is running', async () => {
    const dir = await backupDb(f.ctx, SHA, f.log);
    f.sys.serviceState = 'running';
    await expect(restoreDb(f.ctx, dir, f.log)).rejects.toThrow(/stopped/);
  });
});
