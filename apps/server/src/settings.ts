import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Db } from "./db.js";
import { BadRequestError } from "./errors.js";
import { isValidAllowEntry } from "./http/allowlist.js";

export interface AppSettings {
  allowlist: string[];
  connectHost: string;
  gamesRoot: string;
}

const DEFAULT_CONNECT_HOST = "192.168.0.100";
/** D:\GameServers when a D: drive exists, otherwise C:\GameServers. */
export function defaultGamesRoot(exists: (p: string) => boolean = fs.existsSync): string {
  return exists("D:\\") ? "D:\\GameServers" : "C:\\GameServers";
}

/** A local-drive absolute path (X:\...) that is not a drive root and has no double quote. */
function isValidGamesRoot(p: unknown): p is string {
  if (typeof p !== "string" || p.includes('"')) return false;
  if (!/^[A-Za-z]:[\\/]/.test(p)) return false;
  return path.win32.normalize(p).replace(/[\\/]+$/, "").length > 2;
}

const LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

/** An IPv4 address, a bracketed IPv6 address or a DNS host name (at most 253 characters). */
export function isValidConnectHost(h: string): boolean {
  if (h.length === 0 || h.length > 253) return false;
  if (/^\[[0-9A-Fa-f:.]+\]$/.test(h)) return net.isIPv6(h.slice(1, -1));
  if (net.isIPv4(h)) return true;
  return h.split(".").every((l) => LABEL.test(l));
}

export class SettingsStore {
  constructor(private readonly db: Db, private readonly initialAllowlist: string[]) {}

  private read(key: string): unknown {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  get(): AppSettings {
    return {
      allowlist: (this.read("allowlist") as string[] | undefined) ?? [...this.initialAllowlist],
      connectHost: (this.read("connectHost") as string | undefined) ?? DEFAULT_CONNECT_HOST,
      gamesRoot: (this.read("gamesRoot") as string | undefined) ?? defaultGamesRoot(),
    };
  }

  update(patch: Partial<AppSettings>): AppSettings {
    if (patch.allowlist !== undefined) {
      if (!Array.isArray(patch.allowlist) || !patch.allowlist.every((e) => typeof e === "string" && isValidAllowEntry(e))) {
        throw new BadRequestError("Allowlist entries must be IPv4 addresses or CIDR ranges");
      }
    }
    if (patch.connectHost !== undefined && (typeof patch.connectHost !== "string" || !isValidConnectHost(patch.connectHost.trim()))) {
      throw new BadRequestError("Connect address must be an IP address or host name");
    }
    if (patch.gamesRoot !== undefined && (typeof patch.gamesRoot !== "string" || !isValidGamesRoot(patch.gamesRoot.trim()))) {
      throw new BadRequestError("Games root must be an absolute folder path");
    }
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.transaction(() => {
      if (patch.allowlist !== undefined) put.run("allowlist", JSON.stringify(patch.allowlist));
      if (patch.connectHost !== undefined) put.run("connectHost", JSON.stringify(patch.connectHost.trim()));
      if (patch.gamesRoot !== undefined) put.run("gamesRoot", JSON.stringify(patch.gamesRoot.trim()));
    })();
    return this.get();
  }
}
