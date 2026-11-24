import net from "node:net";
import { isValidAllowEntry } from "@skali/shared";

export { isValidAllowEntry };

/** Socket address as shown to people and matched: IPv4-mapped IPv6 (`::ffff:a.b.c.d`) becomes plain IPv4. */
export function normalizeRemote(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(remote);
  return m ? m[1] : remote;
}

function ipv4ToInt(ip: string): number | null {
  if (net.isIPv4(ip) === false) return null;
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function matches(ip: number, entry: string): boolean {
  if (!isValidAllowEntry(entry)) return false;
  const [addr, prefix] = entry.split("/");
  const base = ipv4ToInt(addr!);
  if (base === null) return false;
  const bits = prefix === undefined ? 32 : Number(prefix);
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/** Loopback (127.0.0.0/8, ::1) is always allowed; otherwise the IPv4 address must match a list entry. */
export function isAllowed(remote: string | undefined, list: string[]): boolean {
  const addr = normalizeRemote(remote);
  if (!addr) return false;
  if (addr === "::1") return true;
  const ip = ipv4ToInt(addr);
  if (ip === null) return false;
  if (ip >>> 24 === 127) return true;
  return list.some((e) => matches(ip, e));
}

/** Splits a Host header value into hostname and port; null when malformed. */
function parseHost(host: string): { hostname: string; port: string | undefined } | null {
  const bracket = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(host);
  if (bracket) return { hostname: bracket[1]!, port: bracket[2] };
  const plain = /^([^:[\]]+)(?::(\d{1,5}))?$/.exec(host);
  if (plain) return { hostname: plain[1]!, port: plain[2] };
  return null;
}

/** Reserved for local use, so they can't be delegated publicly (and so can't be rebound from the internet). */
const LOCAL_SUFFIXES = [".local", ".home.arpa"];

/**
 * DNS-rebinding guard. The Host header's hostname must be an IP literal, `localhost`, exactly this machine's name, or
 * that name under `.local` / `.home.arpa` (case-insensitive, optional trailing dot). Any other domain could be
 * pointed at this server by an attacker, after which their page would be same-origin with Skáli.
 */
export function isAllowedHost(host: string | undefined, machineName: string): boolean {
  if (!host) return false;
  const parsed = parseHost(host);
  if (!parsed) return false;
  if (host.startsWith("[")) return net.isIPv6(parsed.hostname);
  const raw = parsed.hostname.toLowerCase();
  if (net.isIPv4(raw)) return true;
  const name = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (name === "localhost") return true;
  const me = machineName.toLowerCase();
  if (!me) return false;
  return name === me || LOCAL_SUFFIXES.some((s) => name === me + s);
}

/** A WebSocket upgrade's Origin (when present) must point at the same host:port the request was sent to. */
export function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    return u.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
