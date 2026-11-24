import { randomUUID } from "node:crypto";
import type { ConfigFormat } from "@skali/shared";
import type { Db } from "../db.js";
import { ConflictError } from "../errors.js";

export interface UserSource {
  id: string;
  serverId: string;
  path: string;
  format: ConfigFormat;
  label: string;
  createdAt: string;
}

interface Row {
  id: string; server_id: string; path: string; format: string; label: string; created_at: string;
}

const toSource = (r: Row): UserSource => ({
  id: r.id, serverId: r.server_id, path: r.path, format: r.format as ConfigFormat, label: r.label, createdAt: r.created_at,
});

/** The extra config files a user attached to a server. */
export class ConfigSourcesRepo {
  constructor(private readonly db: Db) {}

  list(serverId: string): UserSource[] {
    return (this.db.prepare("SELECT * FROM config_sources WHERE server_id = ? ORDER BY created_at, rowid").all(serverId) as Row[]).map(toSource);
  }

  add(serverId: string, input: { path: string; format: ConfigFormat; label: string }): UserSource {
    const src: UserSource = { id: randomUUID(), serverId, ...input, createdAt: new Date().toISOString() };
    try {
      this.db
        .prepare("INSERT INTO config_sources (id, server_id, path, format, label, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(src.id, src.serverId, src.path, src.format, src.label, src.createdAt);
    } catch (e) {
      if (e instanceof Error && (e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
        throw new ConflictError("That file is already in the list");
      }
      throw e;
    }
    return src;
  }

  /** False when no source with that id belongs to the server. */
  update(serverId: string, id: string, patch: { format?: ConfigFormat; label?: string }): boolean {
    return (
      this.db
        .prepare("UPDATE config_sources SET format = COALESCE(?, format), label = COALESCE(?, label) WHERE id = ? AND server_id = ?")
        .run(patch.format ?? null, patch.label ?? null, id, serverId).changes > 0
    );
  }

  /** False when no source with that id belongs to the server. */
  remove(serverId: string, id: string): boolean {
    return this.db.prepare("DELETE FROM config_sources WHERE id = ? AND server_id = ?").run(id, serverId).changes > 0;
  }

  removeAll(serverId: string): void {
    this.db.prepare("DELETE FROM config_sources WHERE server_id = ?").run(serverId);
  }
}
