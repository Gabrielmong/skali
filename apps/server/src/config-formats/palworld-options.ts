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

/** Wraps in double quotes, escaping each `"` as `\"`. */
export function quotePal(s: string): string {
  return '"' + s.replace(/"/g, '\\"') + '"';
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
  for (;;) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const lineEnd = end > pos && text[end - 1] === "\r" ? end - 1 : end;
    const line = text.slice(pos, lineEnd);
    const t = line.trim();
    if (t.startsWith("[")) inSection = t === SECTION;
    else if (inSection) {
      const m = /^\s*OptionSettings\s*=\s*\(/.exec(line);
      if (m) { open = pos + m[0].length - 1; break; }
    }
    if (end >= text.length) break;
    pos = end + 1;
  }
  if (open < 0) throw new PalworldIniError("OptionSettings line not found");

  const entries: Entry[] = [];
  let i = open + 1;
  for (;;) {
    const keyStart = i;
    while (i < text.length && text[i] !== "=" && text[i] !== "," && text[i] !== ")" && text[i] !== "\n") i++;
    if (text[i] !== "=") {
      if (text[i] === ")" && i === keyStart) return { close: i, entries }; // empty tuple
      throw new PalworldIniError(MALFORMED);
    }
    const key = text.slice(keyStart, i).trim();
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
        const sep = loc.entries.length > 0 ? "," : "";
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
