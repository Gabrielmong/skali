import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { EventLog } from './event-log.js';
import { type OpContext, errorText, short } from './op-context.js';
import { run, step } from './op-steps.js';
import { assertSha, isCurrent, releaseDir } from './releases.js';

/** What a finished build must contain, relative to the release folder. */
export const REQUIRED_FILES = [
  'apps/server/dist/main.js',
  'apps/server/dist/schema-version.json',
  'apps/server/dist/deploy-probe.js',
  'apps/web/dist/index.html',
  'tools/SkaliHelper/publish/SkaliHelper.exe',
];

const NATIVE_GUIDANCE =
  "better-sqlite3 is native: use a Node version that has a prebuilt binary for it (Node 22 or 24 LTS, system-wide), or install the build tools (winget install Microsoft.VisualStudio.2022.BuildTools, with the 'Desktop development with C++' workload), then re-run.";

function fetchRepo(ctx: OpContext, log: EventLog): Promise<void> {
  const { bin, branch, stepTimeoutsMs } = ctx.config;
  const args = ['-C', ctx.paths.repo, 'fetch', 'origin', branch];
  return step(log, 'Fetch', () =>
    run(ctx, log, bin.git, args, { env: ctx.gitEnv(), timeoutMs: stepTimeoutsMs.fetch }),
  );
}

function exportRelease(ctx: OpContext, sha: string, dir: string, log: EventLog): Promise<void> {
  const { bin, stepTimeoutsMs } = ctx.config;
  const timeoutMs = stepTimeoutsMs.export;
  return step(log, 'Export', async () => {
    assertSha(sha);
    if (isCurrent(ctx.paths, sha)) throw new Error(`${short(sha)} is the release running now`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(ctx.paths.data, { recursive: true });
    const tar = path.join(ctx.paths.data, `export-${short(sha)}.tar`);
    try {
      await run(ctx, log, bin.git, ['-C', ctx.paths.repo, 'archive', '-o', tar, sha], { env: ctx.gitLocalEnv(), timeoutMs });
      mkdirSync(dir, { recursive: true });
      await run(ctx, log, bin.tar, ['-xf', tar, '-C', dir], { timeoutMs });
    } finally {
      rmSync(tar, { force: true });
    }
  });
}

/** Fetch, export, install, native check, build, verify. Nothing running is touched. On failure the caller removes the half-built `dir` with removeRelease. */
export async function buildRelease(ctx: OpContext, sha: string, dir: string, log: EventLog): Promise<void> {
  const { bin, stepTimeoutsMs: t } = ctx.config;
  const pnpm = (args: string[], timeoutMs: number) => run(ctx, log, bin.pnpm, args, { cwd: dir, timeoutMs });
  await fetchRepo(ctx, log);
  await exportRelease(ctx, sha, dir, log);
  await step(log, 'Install', () =>
    pnpm(['install', '--frozen-lockfile', '--store-dir', ctx.paths.pnpmStore], t.install),
  );
  await step(log, 'Native check', async () => {
    try {
      await run(
        ctx,
        log,
        bin.node,
        ['-e', "new (require('better-sqlite3'))(':memory:').close()"],
        { cwd: path.join(dir, 'apps', 'server'), timeoutMs: t.build },
      );
    } catch (e) {
      throw new Error(`better-sqlite3 failed to load under node (${errorText(e)}). ${NATIVE_GUIDANCE}`);
    }
  });
  await step(log, 'Build', () => pnpm(['build'], t.build));
  await step(log, 'Verify', () => {
    const missing = REQUIRED_FILES.find((f) => !existsSync(path.join(dir, ...f.split('/'))));
    if (missing) throw new Error(`missing ${missing}`);
  });
}

/** The schema version the build wrote into the release. */
export function releaseSchemaVersion(dir: string): number {
  const file = path.join(dir, 'apps', 'server', 'dist', 'schema-version.json');
  const v = (JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion?: unknown }).schemaVersion;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error(`${file} has no valid schemaVersion`);
  return v;
}

/** Deletes a half-built release, never the one `current` points at. */
export function removeRelease(ctx: OpContext, sha: string, log: EventLog): void {
  if (isCurrent(ctx.paths, sha)) return;
  try {
    rmSync(releaseDir(ctx.paths, sha), { recursive: true, force: true });
  } catch (e) {
    log.line(`Couldn't remove ${short(sha)}: ${errorText(e)}`);
  }
}

