import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Paths } from '../src/config.js';
import { assertSha, currentTarget, isCurrent, pruneReleases, releaseDir, samePath, switchCurrent } from '../src/releases.js';

let root: string;
let paths: Paths;
const A = 'aaaaaaa1111111111111';
const B = 'bbbbbbb2222222222222';
const C = 'ccccccc3333333333333';

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'rel-'));
  mkdirSync(path.join(root, 'releases'));
  paths = { releases: path.join(root, 'releases'), current: path.join(root, 'current') } as Paths;
  for (const s of [A, B, C]) {
    mkdirSync(releaseDir(paths, s));
    writeFileSync(path.join(releaseDir(paths, s), 'f.txt'), 'x');
  }
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('releases', () => {
  it('uses the short sha as folder name', () => {
    expect(path.basename(releaseDir(paths, A))).toBe('aaaaaaa');
  });

  it('has no current target before any switch', () => {
    expect(currentTarget(paths)).toBeUndefined();
  });

  it('switchCurrent twice points at the second release and keeps the first', () => {
    switchCurrent(paths, A);
    expect(currentTarget(paths)).toBe(releaseDir(paths, A));
    switchCurrent(paths, B);
    expect(currentTarget(paths)).toBe(releaseDir(paths, B));
    expect(existsSync(path.join(releaseDir(paths, A), 'f.txt'))).toBe(true);
  });

  it('pruneReleases keeps listed releases and the current one', () => {
    switchCurrent(paths, C);
    pruneReleases(paths, [A, B]);
    expect(existsSync(releaseDir(paths, A))).toBe(true);
    expect(existsSync(releaseDir(paths, B))).toBe(true);
    expect(existsSync(releaseDir(paths, C))).toBe(true);
    pruneReleases(paths, [A]);
    expect(existsSync(releaseDir(paths, B))).toBe(false);
    expect(existsSync(releaseDir(paths, C))).toBe(true);
  });

  it('samePath ignores case and trailing separators on win32 only', () => {
    expect(samePath('C:\\Home\\Releases\\abc', 'c:\\home\\releases\\ABC\\', 'win32')).toBe(true);
    expect(samePath('/home/releases/abc', '/home/releases/ABC', 'linux')).toBe(false);
    expect(samePath('/home/releases/abc', '/home/releases/abc/', 'linux')).toBe(true);
  });

  it('isCurrent tells whether a sha is the current target', () => {
    switchCurrent(paths, A);
    expect(isCurrent(paths, A)).toBe(true);
    expect(isCurrent(paths, B)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('never prunes current when the junction differs in case', () => {
    symlinkSync(releaseDir(paths, C).toUpperCase(), paths.current, 'junction');
    pruneReleases(paths, []);
    expect(existsSync(releaseDir(paths, C))).toBe(true);
    expect(existsSync(releaseDir(paths, A))).toBe(false);
    expect(isCurrent(paths, C)).toBe(true);
  });

  it.each(['-x', '../../x', 'ABC1234', 'abc12', 'abc1234;rm', ''])('rejects the sha %j', (bad) => {
    expect(() => assertSha(bad)).toThrow(/valid commit sha/);
    expect(() => releaseDir(paths, bad)).toThrow(/valid commit sha/);
    expect(() => isCurrent(paths, bad)).toThrow(/valid commit sha/);
  });

  it('accepts 7 to 40 lowercase hex', () => {
    expect(() => assertSha('abc1234')).not.toThrow();
    expect(() => assertSha('a'.repeat(40))).not.toThrow();
  });
});
