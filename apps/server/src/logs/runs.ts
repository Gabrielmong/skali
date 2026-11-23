import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export interface RunInfo {
  runId: string;
  startedAt: string;
  sizeBytes: number;
}

/** Creates logs/<serverId>/<runId>/console.log (empty). */
export function createRun(
  logsDir: string,
  serverId: string,
  now: Date,
): { runId: string; runDir: string; consolePath: string } {
  const runId = now.toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(serverDir(logsDir, serverId), runId);
  fs.mkdirSync(runDir, { recursive: true });
  const consolePath = path.join(runDir, "console.log");
  fs.closeSync(fs.openSync(consolePath, "a"));
  return { runId, runDir, consolePath };
}

const RUN_ID_RE = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/;

/** Validates serverId and returns its directory, guaranteed to be under logsDir. */
function serverDir(logsDir: string, serverId: string): string {
  if (!serverId || serverId === "." || serverId === ".." || /[\\/:\0]/.test(serverId)) {
    throw new Error(`invalid serverId: ${JSON.stringify(serverId)}`);
  }
  const root = path.resolve(logsDir);
  const dir = path.resolve(root, serverId);
  if (path.dirname(dir) !== root) throw new Error(`invalid serverId: ${JSON.stringify(serverId)}`);
  return dir;
}

/** Recovers the ISO timestamp from a runId such as 2026-01-01T00-00-01-000Z. */
function parseRunId(runId: string): string | null {
  const m = RUN_ID_RE.exec(runId);
  if (!m) return null;
  const d = new Date(`${m[1]}:${m[2]}:${m[3]}.${m[4]}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Run directory names for a server, newest first. */
function runDirs(logsDir: string, serverId: string): string[] {
  const base = serverDir(logsDir, serverId);
  try {
    return fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
      .map((e) => e.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

export function listRuns(logsDir: string, serverId: string): RunInfo[] {
  const out: RunInfo[] = [];
  for (const runId of runDirs(logsDir, serverId)) {
    const dir = path.join(logsDir, serverId, runId);
    try {
      const size = fs.statSync(path.join(dir, "console.log")).size;
      const startedAt = parseRunId(runId) ?? fs.statSync(dir).mtime.toISOString();
      out.push({ runId, startedAt, sizeBytes: size });
    } catch {
      // no console.log: not a run
    }
  }
  return out;
}

/** Removes all but the newest `keep` runs. Never deletes the newest run. */
export function pruneRuns(logsDir: string, serverId: string, keep = 30): void {
  const dirs = runDirs(logsDir, serverId);
  const n = Math.max(1, keep);
  for (const runId of dirs.slice(n)) {
    try {
      fs.rmSync(path.join(logsDir, serverId, runId), { recursive: true, force: true });
    } catch {
      // locked by a running game, etc.; skip
    }
  }
}

export async function appendSkaliLine(file: string, text: string): Promise<void> {
  await fsp.appendFile(file, `[skali] ${text}\r\n`, { flag: "a" });
}
