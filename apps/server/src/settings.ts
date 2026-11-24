import net from "node:net";
import type { Db } from "./db.js";
import { BadRequestError } from "./errors.js";
import { isValidAllowEntry } from "./http/allowlist.js";

export interface AppSettings {
  allowlist: string[];
  connectHost: string;
}

const DEFAULT_CONNECT_HOST = "192.168.0.100";
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
    const put = this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    this.db.transaction(() => {
      if (patch.allowlist !== undefined) put.run("allowlist", JSON.stringify(patch.allowlist));
      if (patch.connectHost !== undefined) put.run("connectHost", JSON.stringify(patch.connectHost.trim()));
    })();
    return this.get();
  }
}
