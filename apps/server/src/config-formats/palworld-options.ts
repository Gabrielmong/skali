import { ConfigParseError, type ConfigDoc } from "./types.js";

/**
 * Lossless access to the `OptionSettings=(K=V,K=V,...)` line of PalWorldSettings.ini.
 * Values are raw tokens exactly as written (`True`, `1.000000`, `"My Server"`, `(Steam,Xbox)`).
 */
export class PalworldIniError extends Error {
  constructor(message: string) { super(message); this.name = "PalworldIniError"; }
}

export interface PalworldDoc {
  get(key: string): string | undefined;
  set(key: string, rawValue: string): void;
  keys(): string[];
  toString(): string;
}

/** Wraps in double quotes, escaping each backslash as two backslashes first, then each double quote as backslash-quote. */
export function quotePal(s: string): string {
  return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

/**
 * Inverse of quotePal for a raw ini value; an unquoted value is returned as is.
 * Reverses only the two escapes (backslash-backslash, backslash-quote) in one left-to-right pass; any other backslash stays literal.
 */
export function unquotePal(raw: string): string {
  const t = raw.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1).replace(/\\([\\"])/g, "$1") : t;
}

const SECTION = "[/Script/Pal.PalGameWorldSettings]";
const MALFORMED = "Malformed OptionSettings line";

interface Entry { key: string; valueStart: number; valueEnd: number }
interface Located { close: number; entries: Entry[] }

/** Finds the OptionSettings tuple inside the section and scans its entries (absolute offsets in text). */
function locate(text: string): Located {
  let inSection = false;
  let pos = 0;
  let open = -1;
  let lines = 0;
  for (;;) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const lineEnd = end > pos && text[end - 1] === "\r" ? end - 1 : end;
    const line = text.slice(pos, lineEnd);
    const t = line.trim();
    if (t.startsWith("[")) inSection = t === SECTION;
    else {
      // Unreal's loader lets the last line win, so a second line in the section (even under a repeated header) could override Skáli's keys: refuse the file.
      if (inSection && /^\s*OptionSettings\s*=/i.test(line) && ++lines > 1) throw new PalworldIniError("More than one OptionSettings line");
      const m = inSection && open < 0 ? /^\s*OptionSettings\s*=\s*\(/i.exec(line) : null;
      if (m) open = pos + m[0].length - 1;
    }
    if (end >= text.length) break;
    pos = end + 1;
  }
  if (open < 0) throw new PalworldIniError("OptionSettings line not found");
  const seen = new Set<string>();

  const entries: Entry[] = [];
  let i = open + 1;
  for (;;) {
    const keyStart = i;
    while (i < text.length && text[i] !== "=" && text[i] !== "," && text[i] !== ")" && text[i] !== "\n") i++;
    if (text[i] !== "=") {
      if (text[i] === ")" && text.slice(keyStart, i).trim() === "") return { close: i, entries }; // empty tuple or trailing comma
      throw new PalworldIniError(MALFORMED);
    }
    const key = text.slice(keyStart, i).trim();
    if (seen.has(key.toLowerCase())) throw new PalworldIniError(`Duplicate setting ${key}`);
    seen.add(key.toLowerCase());
    const valueStart = ++i;
    let depth = 0, inQuote = false;
    for (; i < text.length; i++) {
      const c = text[i]!;
      if (c === "\n") throw new PalworldIniError(MALFORMED);
      if (inQuote) {
        if (c === "\\") i++;
        else if (c === '"') inQuote = false;
      } else if (c === '"') inQuote = true;
      else if (c === "(") depth++;
      else if (c === ")") { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
    }
    if (i >= text.length) throw new PalworldIniError(MALFORMED);
    entries.push({ key, valueStart, valueEnd: i });
    if (text[i] === ")") return { close: i, entries };
    i++; // skip comma
  }
}

export function parsePalworldIni(text: string): PalworldDoc {
  let current = text;
  locate(current); // validate eagerly

  const find = (loc: Located, key: string) => {
    for (let i = loc.entries.length - 1; i >= 0; i--) if (loc.entries[i]!.key === key) return loc.entries[i]!;
    return undefined;
  };

  return {
    get(key) {
      const e = find(locate(current), key);
      return e ? current.slice(e.valueStart, e.valueEnd) : undefined;
    },
    set(key, rawValue) {
      if (/[\r\n]/.test(rawValue)) throw new PalworldIniError("Value cannot contain line breaks");
      const loc = locate(current);
      const e = find(loc, key);
      if (e) current = current.slice(0, e.valueStart) + rawValue + current.slice(e.valueEnd);
      else {
        let before = loc.close - 1;
        while (before >= 0 && /[ 	]/.test(current[before]!)) before--;
        const sep = loc.entries.length > 0 && current[before] !== "," ? "," : ""; // a trailing comma is already there
        current = current.slice(0, loc.close) + sep + key + "=" + rawValue + current.slice(loc.close);
      }
    },
    keys() {
      return [...new Set(locate(current).entries.map((e) => e.key))];
    },
    toString() {
      return current;
    },
  };
}

/** ConfigDoc adapter; field ids are the keys. */
export function parsePalworldConfig(text: string): ConfigDoc {
  const wrap = <T>(fn: () => T): T => {
    try { return fn(); } catch (e) {
      if (e instanceof PalworldIniError) throw new ConfigParseError(e.message);
      throw e;
    }
  };
  const doc = wrap(() => parsePalworldIni(text));
  return {
    fields: () => wrap(() => doc.keys().map((k) => ({ id: k, key: k, value: unquotePal(doc.get(k)!) }))),
    set(id, value) {
      wrap(() => {
        const prev = doc.get(id);
        if (prev === undefined) throw new ConfigParseError("Unknown setting");
        const quoted = prev.trim().startsWith('"');
        let raw: string;
        if (typeof value === "boolean") raw = /^(true|false)$/.test(prev.trim()) ? String(value) : value ? "True" : "False";
        else if (typeof value === "number") raw = String(value);
        else raw = quoted || !/^[A-Za-z0-9_.+-]+$/.test(value) ? quotePal(value) : value;
        doc.set(id, raw);
      });
    },
    toString: () => doc.toString(),
  };
}
