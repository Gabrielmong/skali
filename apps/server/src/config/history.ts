import fs from "node:fs";
import path from "node:path";
import type { ConfigHistoryEntry } from "@skali/shared";
import { NotFoundError } from "../errors.js";

const KEEP = 20;
const ID_RE = /^[A-Za-z0-9_-]+$/;
const ENTRY_RE = /^[0-9TZ.-]+\.bak$/;

function safeId(id: string): string {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new NotFoundError("Not found");
  return id;
}

/** Pre-save copies of config files: `<root>/<serverId>/<sourceId>/<iso>.bak`, newest 20 kept. */
export class ConfigHistory {
  constructor(private readonly root: string) {}

  private dir(serverId: string, sourceId: string): string {
    return path.join(this.root, safeId(serverId), safeId(sourceId));
  }

  push(serverId: string, sourceId: string, bytes: Buffer): void {
    const dir = this.dir(serverId, sourceId);
    fs.mkdirSync(dir, { recursive: true });
    let t = Date.now();
    for (;;) {
      const name = `${new Date(t).toISOString().replace(/:/g, "-")}.bak`;
      try {
        fs.writeFileSync(path.join(dir, name), bytes, { flag: "wx" });
        break;
      } catch (e) {
        if ((e as { code?: string }).code !== "EEXIST") throw e;
        t += 1;
      }
    }
    for (const name of this.names(dir).slice(KEEP)) fs.rmSync(path.join(dir, name), { force: true });
  }

  list(serverId: string, sourceId: string): ConfigHistoryEntry[] {
    const dir = this.dir(serverId, sourceId);
    return this.names(dir).map((id) => ({
      id,
      savedAt: new Date(id.slice(0, -4).replace(/T(\d\d)-(\d\d)-(\d\d)/, "T$1:$2:$3")).toISOString(),
      sizeBytes: fs.statSync(path.join(dir, id)).size,
    }));
  }

  read(serverId: string, sourceId: string, entryId: string): Buffer {
    const dir = this.dir(serverId, sourceId);
    if (typeof entryId !== "string" || !ENTRY_RE.test(entryId)) throw new NotFoundError("Version not found");
    try {
      return fs.readFileSync(path.join(dir, entryId));
    } catch {
      throw new NotFoundError("Version not found");
    }
  }

  removeServer(serverId: string): void {
    fs.rmSync(path.join(this.root, safeId(serverId)), { recursive: true, force: true });
  }

  removeSource(serverId: string, sourceId: string): void {
    fs.rmSync(this.dir(serverId, sourceId), { recursive: true, force: true });
  }

  /** Entry file names, newest first (ISO names sort chronologically). */
  private names(dir: string): string[] {
    try {
      return fs.readdirSync(dir).filter((n) => ENTRY_RE.test(n)).sort().reverse();
    } catch {
      return [];
    }
  }
}
