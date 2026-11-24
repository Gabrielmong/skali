import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type { Paths } from './config.js';

const short = (sha: string) => sha.slice(0, 7);

/** A sha becomes a folder name and a git argument, so only lowercase hex (7 to 40) is accepted. */
export function assertSha(sha: string): void {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`Not a valid commit sha: ${JSON.stringify(sha)}`);
}

export function releaseDir(paths: Paths, sha: string): string {
  assertSha(sha);
  return path.join(paths.releases, short(sha));
}

/** Junction targets from readlink may carry a \\?\ prefix and a trailing separator. */
function normalize(p: string): string {
  return path.normalize(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
}

/** Windows paths are case-insensitive, so a junction may differ from our spelling only in case. */
export function samePath(a: string, b: string, platform: NodeJS.Platform = process.platform): boolean {
  const [x, y] = [normalize(a), normalize(b)];
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function currentTarget(paths: Paths): string | undefined {
  try {
    return normalize(readlinkSync(paths.current));
  } catch {
    return undefined;
  }
}

/** True when `current` points at this sha's release folder. */
export function isCurrent(paths: Paths, sha: string): boolean {
  assertSha(sha);
  const target = currentTarget(paths);
  return target !== undefined && samePath(target, releaseDir(paths, sha));
}

/** Removes the `current` link only, never the target's contents. */
export function removeCurrent(paths: Paths): void {
  if (!existsSync(paths.current) && !isLink(paths.current)) return;
  try {
    rmdirSync(paths.current);
  } catch {
    unlinkSync(paths.current);
  }
}

export function switchCurrent(paths: Paths, sha: string): void {
  removeCurrent(paths);
  symlinkSync(releaseDir(paths, sha), paths.current, 'junction');
}

/** Callers must include the in-flight/new release's sha in keepShas (only current's target is protected automatically). */
export function pruneReleases(paths: Paths, keepShas: string[]): void {
  const keep = new Set(keepShas.map(short));
  const target = currentTarget(paths);
  for (const entry of readdirSync(paths.releases, { withFileTypes: true })) {
    if (!entry.isDirectory() || keep.has(entry.name)) continue;
    const dir = path.join(paths.releases, entry.name);
    if (target !== undefined && samePath(dir, target)) continue;
    rmSync(dir, { recursive: true, force: true });
  }
}
