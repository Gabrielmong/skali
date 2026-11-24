// Run by the deploy helper with the release's node: node deploy-probe.js <dbPath>
// Read-only: never creates or modifies files and never runs migrations.
import fs from "node:fs";
import Database from "better-sqlite3";

function main(): void {
  const dbPath = process.argv[2];
  if (!dbPath) throw new Error("usage: deploy-probe <dbPath>");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const userVersion = db.pragma("user_version", { simple: true }) as number;
    const rows = db.prepare("SELECT id, pid, desired FROM servers ORDER BY id").all() as {
      id: string;
      pid: number | null;
      desired: string;
    }[];
    let walBytes = 0;
    try {
      walBytes = fs.statSync(`${dbPath}-wal`).size;
    } catch {
      walBytes = 0;
    }
    const servers = rows.map((r) => ({ id: r.id, pid: r.pid ?? null, desired: r.desired }));
    process.stdout.write(`${JSON.stringify({ userVersion, walBytes, servers })}\n`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`deploy-probe: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(2);
}
