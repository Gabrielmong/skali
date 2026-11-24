import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { dbPath } from './db-probe.js';
import type { EventLog } from './event-log.js';
import { type OpContext, short } from './op-context.js';
import { assertSha } from './releases.js';

const SIDECARS = ['-wal', '-shm'];

async function assertStopped(ctx: OpContext): Promise<void> {
  const name = ctx.config.serviceName;
  const status = await ctx.sys.serviceStatus(name);
  if (status !== 'stopped') throw new Error(`${name} must be stopped before touching the database (it is ${status})`);
}

/** Copies the database (and its -wal/-shm when present) to `<backups>/<time>-<sha7>`, keeping the newest keepBackups. Skáli must be stopped. */
export async function backupDb(ctx: OpContext, sha: string, log: EventLog): Promise<string> {
  assertSha(sha);
  await assertStopped(ctx);
  const db = dbPath(ctx);
  if (!existsSync(db)) throw new Error(`Database not found: ${db}`);
  const stamp = ctx.now().toISOString().replace(/:/g, '-');
  const dir = path.join(ctx.paths.backups, `${stamp}-${short(sha)}`);
  mkdirSync(dir, { recursive: true });
  for (const suffix of ['', ...SIDECARS]) {
    if (existsSync(db + suffix)) copyFileSync(db + suffix, path.join(dir, path.basename(db) + suffix));
  }
  log.line(`Backup written: ${path.basename(dir)}`);
  const all = readdirSync(ctx.paths.backups, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const old of all.slice(0, Math.max(0, all.length - ctx.config.keepBackups))) {
    rmSync(path.join(ctx.paths.backups, old), { recursive: true, force: true });
  }
  return dir;
}

/**
 * Puts a backup back, removing any -wal/-shm the backup doesn't have. Skáli must be stopped.
 * Every file is staged as `<target>.restore-tmp` first. A copy failure leaves the live files untouched. Once all copies
 * succeeded, all live -wal/-shm are deleted, the staged skali.db is renamed over the live one, then the backup's sidecars
 * are renamed in. A failure in that phase leaves the old DB without its WAL, or the new DB, never a mismatched pair.
 */
export async function restoreDb(ctx: OpContext, backupDir: string, log: EventLog): Promise<void> {
  await assertStopped(ctx);
  const db = dbPath(ctx);
  const base = path.basename(db);
  if (!existsSync(path.join(backupDir, base))) throw new Error(`Backup has no ${base}: ${backupDir}`);
  const present = ['', ...SIDECARS].filter((suffix) => existsSync(path.join(backupDir, base + suffix)));
  const tmp = (suffix: string) => `${db}${suffix}.restore-tmp`;
  try {
    for (const suffix of present) copyFileSync(path.join(backupDir, base + suffix), tmp(suffix));
  } catch (e) {
    for (const suffix of present) rmSync(tmp(suffix), { force: true });
    throw e;
  }
  try {
    for (const suffix of SIDECARS) rmSync(db + suffix, { force: true });
    renameSync(tmp(''), db);
    for (const suffix of SIDECARS) if (present.includes(suffix)) renameSync(tmp(suffix), db + suffix);
  } finally {
    for (const suffix of present) rmSync(tmp(suffix), { force: true });
  }
  log.line(`Database restored from ${path.basename(backupDir)}`);
}
