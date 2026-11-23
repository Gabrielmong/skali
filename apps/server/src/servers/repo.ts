import { randomUUID } from "node:crypto";
import type { GameId, LaunchValues } from "@skali/shared";
import type { Db } from "../db.js";
import { BadRequestError, NotFoundError } from "../errors.js";
import { decryptSecret, encryptSecret } from "../secrets.js";

export interface ServerRecord {
  id: string;
  name: string;
  game: GameId;
  folder: string;
  launch: LaunchValues;
  secrets: Record<string, string>;
  desired: "running" | "stopped";
  autoRestart: boolean;
  autoStart: boolean;
  stopTimeoutSec: number;
  pid: number | null;
  pidStartTime: string | null;
  currentRunId: string | null;
  createdAt: string;
}

interface Row {
  id: string; name: string; game: string; folder: string; launch: string; secrets: string; desired: string;
  auto_restart: number; auto_start: number; stop_timeout_sec: number;
  pid: number | null; pid_start_time: string | null; current_run_id: string | null; created_at: string;
}

const NAME_RE = /^[A-Za-z0-9 _.-]{1,40}$/;
const NAME_USED = "Name already used";
const NAME_INVALID = "Name may only contain letters, numbers, spaces, _ . - (1-40 characters)";

export class ServerRepo {
  constructor(private readonly db: Db, private readonly key: Buffer) {}

  list(): ServerRecord[] {
    return (this.db.prepare("SELECT * FROM servers ORDER BY created_at, rowid").all() as Row[]).map((r) => this.toRecord(r));
  }

  get(id: string): ServerRecord {
    const row = this.db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("Server not found");
    return this.toRecord(row);
  }

  create(input: Pick<ServerRecord, "name" | "game" | "folder" | "launch" | "stopTimeoutSec"> & { secrets?: Record<string, string> }): ServerRecord {
    this.checkName(input.name);
    const rec: ServerRecord = {
      id: randomUUID(),
      name: input.name,
      game: input.game,
      folder: input.folder,
      launch: input.launch,
      secrets: input.secrets ?? {},
      desired: "stopped",
      autoRestart: true,
      autoStart: true,
      stopTimeoutSec: input.stopTimeoutSec,
      pid: null,
      pidStartTime: null,
      currentRunId: null,
      createdAt: new Date().toISOString(),
    };
    try {
      this.db
        .prepare(
          `INSERT INTO servers (id, name, game, folder, launch, secrets, desired, auto_restart, auto_start, stop_timeout_sec, pid, pid_start_time, current_run_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(rec.id, rec.name, rec.game, rec.folder, JSON.stringify(rec.launch), this.seal(rec.secrets), rec.desired,
          rec.autoRestart ? 1 : 0, rec.autoStart ? 1 : 0, rec.stopTimeoutSec, rec.pid, rec.pidStartTime, rec.currentRunId, rec.createdAt);
    } catch (e) {
      throw this.mapConstraint(e);
    }
    return rec;
  }

  update(id: string, patch: Partial<Omit<ServerRecord, "id" | "createdAt">>): ServerRecord {
    const row = this.db.prepare("SELECT * FROM servers WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError("Server not found");
    const cur = this.toRecord(row);
    if (patch.name !== undefined) this.checkName(patch.name, id);
    // undefined means unchanged; an explicit null (pid fields) is honoured.
    const next: ServerRecord = { ...cur };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    try {
      this.db
        .prepare(
          `UPDATE servers SET name = ?, game = ?, folder = ?, launch = ?, secrets = ?, desired = ?, auto_restart = ?, auto_start = ?,
             stop_timeout_sec = ?, pid = ?, pid_start_time = ?, current_run_id = ? WHERE id = ?`,
        )
        .run(next.name, next.game, next.folder, JSON.stringify(next.launch), patch.secrets !== undefined ? this.seal(next.secrets) : row.secrets, next.desired,
          next.autoRestart ? 1 : 0, next.autoStart ? 1 : 0, next.stopTimeoutSec, next.pid, next.pidStartTime, next.currentRunId, id);
    } catch (e) {
      throw this.mapConstraint(e);
    }
    return next;
  }

  delete(id: string): void {
    if (this.db.prepare("DELETE FROM servers WHERE id = ?").run(id).changes === 0) throw new NotFoundError("Server not found");
  }

  private checkName(name: string, exceptId?: string): void {
    if (typeof name !== "string" || !NAME_RE.test(name)) throw new BadRequestError(NAME_INVALID);
    const dup = this.db.prepare("SELECT id FROM servers WHERE name = ? COLLATE NOCASE").get(name) as { id: string } | undefined;
    if (dup && dup.id !== exceptId) throw new BadRequestError(NAME_USED);
  }

  private mapConstraint(e: unknown): unknown {
    return e instanceof Error && (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" ? new BadRequestError(NAME_USED) : e;
  }

  private seal(secrets: Record<string, string>): string {
    return encryptSecret(JSON.stringify(secrets), this.key);
  }

  private toRecord(r: Row): ServerRecord {
    return {
      id: r.id,
      name: r.name,
      game: r.game as GameId,
      folder: r.folder,
      launch: JSON.parse(r.launch) as LaunchValues,
      secrets: JSON.parse(decryptSecret(r.secrets, this.key)) as Record<string, string>,
      desired: r.desired as ServerRecord["desired"],
      autoRestart: r.auto_restart === 1,
      autoStart: r.auto_start === 1,
      stopTimeoutSec: r.stop_timeout_sec,
      pid: r.pid,
      pidStartTime: r.pid_start_time,
      currentRunId: r.current_run_id,
      createdAt: r.created_at,
    };
  }
}
