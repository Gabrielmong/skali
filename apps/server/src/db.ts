import Database from "better-sqlite3";

export type Db = Database.Database;

const MIGRATIONS: string[] = [
  // v1
  `CREATE TABLE servers (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL UNIQUE COLLATE NOCASE,
     game TEXT NOT NULL,
     folder TEXT NOT NULL,
     launch TEXT NOT NULL,
     secrets TEXT NOT NULL,
     desired TEXT NOT NULL,
     auto_restart INTEGER NOT NULL,
     auto_start INTEGER NOT NULL,
     stop_timeout_sec INTEGER NOT NULL,
     pid INTEGER,
     pid_start_time TEXT,
     current_run_id TEXT,
     created_at TEXT NOT NULL
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  const current = db.pragma("user_version", { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
  return db;
}
