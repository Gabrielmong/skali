/**
 * Lossless java.util.Properties reader/writer. Lines are kept verbatim; only
 * the entry touched by `set` is rewritten. Minecraft's server.properties is the target.
 */
export interface PropertiesDoc {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  keys(): string[];
  toString(): string;
}

interface Line {
  /** Line text without its terminator; for a continued entry, all physical lines joined with their terminators. */
  text: string;
  eol: string;
  key?: string;
  /** Raw (still escaped) value text. */
  rawValue?: string;
  /** True when the entry spans more than one physical line. */
  multi?: boolean;
}

const WS = " \t\f";

function unescape(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c !== "\\") { out += c; continue; }
    const n = s[++i];
    if (n === undefined) break;
    if (n === "t") out += "\t";
    else if (n === "n") out += "\n";
    else if (n === "r") out += "\r";
    else if (n === "f") out += "\f";
    else if (n === "u" && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; }
    else out += n;
  }
  return out;
}

/** Escapes backslashes only (Minecraft does not escape `:` or `=`); a leading space would otherwise be swallowed as separator whitespace. */
function escapeValue(v: string): string {
  if (/[\r\n]/.test(v)) throw new Error("Property values cannot contain line breaks");
  const out = v.replace(/\\/g, "\\\\");
  return out.startsWith(" ") ? "\\" + out : out;
}

function escapeKey(k: string): string {
  if (/[\r\n]/.test(k)) throw new Error("Property keys cannot contain line breaks");
  return k.replace(/[\\=: \t\f#!]/g, (c) => "\\" + c);
}

/** Splits one logical entry (continuations already joined) into key and raw value. */
function splitEntry(logical: string): { key: string; rawValue: string } {
  let i = 0;
  while (i < logical.length && WS.includes(logical[i]!)) i++;
  const start = i;
  while (i < logical.length) {
    const c = logical[i]!;
    if (c === "\\") { i += 2; continue; }
    if (c === "=" || c === ":" || WS.includes(c)) break;
    i++;
  }
  const key = unescape(logical.slice(start, Math.min(i, logical.length)));
  while (i < logical.length && WS.includes(logical[i]!)) i++;
  if (logical[i] === "=" || logical[i] === ":") i++;
  while (i < logical.length && WS.includes(logical[i]!)) i++;
  return { key, rawValue: logical.slice(i) };
}

function endsWithOddBackslashes(s: string): boolean {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

export function parseProperties(text: string): PropertiesDoc {
  const parts = text.split(/(\r\n|\n|\r)/); // text, eol, text, eol, ..., text
  const physical: { text: string; eol: string }[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const t = parts[i]!;
    const eol = parts[i + 1] ?? "";
    if (t === "" && eol === "") continue; // empty piece after the final terminator
    physical.push({ text: t, eol });
  }

  const eolStyle = /\r\n|\n|\r/.exec(text)?.[0] ?? "\n";
  const lines: Line[] = [];
  for (let i = 0; i < physical.length; i++) {
    const p = physical[i]!;
    const trimmed = p.text.replace(/^[ \t\f]+/, "");
    if (trimmed === "" || trimmed[0] === "#" || trimmed[0] === "!") {
      lines.push({ text: p.text, eol: p.eol });
      continue;
    }
    let joined = p.text, eol = p.eol, logical = trimmed, multi = false;
    while (endsWithOddBackslashes(logical) && i + 1 < physical.length) {
      const nx = physical[++i]!;
      joined += eol + nx.text;
      eol = nx.eol;
      logical = logical.slice(0, -1) + nx.text.replace(/^[ \t\f]+/, "");
      multi = true;
    }
    const { key, rawValue } = splitEntry(logical);
    lines.push({ text: joined, eol, key, rawValue, multi });
  }

  const find = (key: string): number => {
    for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.key === key) return i;
    return -1;
  };

  return {
    get(key) {
      const i = find(key);
      return i < 0 ? undefined : unescape(lines[i]!.rawValue!);
    },
    set(key, value) {
      const raw = escapeValue(value);
      const i = find(key);
      if (i >= 0) {
        const l = lines[i]!;
        // Keep the original indentation/separator style when the entry is a single physical line.
        let prefix = escapeKey(key) + "=";
        if (!l.multi) {
          const m = /^([ \t\f]*)(?:\\.|[^\\=: \t\f])*([ \t\f]*[=:]?[ \t\f]*)/.exec(l.text)!;
          if (m[2]!.includes("=") || m[2]!.includes(":")) prefix = m[1]! + escapeKey(key) + m[2]!;
        }
        l.text = prefix + raw;
        l.rawValue = raw;
        l.multi = false;
        return;
      }
      const last = lines[lines.length - 1];
      let eol = eolStyle;
      if (last && last.eol === "") { last.eol = eolStyle; eol = ""; }
      lines.push({ text: escapeKey(key) + "=" + raw, eol, key, rawValue: raw });
    },
    keys() {
      const seen = new Set<string>();
      for (const l of lines) if (l.key !== undefined) seen.add(l.key);
      return [...seen];
    },
    toString() {
      return lines.map((l) => l.text + l.eol).join("");
    },
  };
}
