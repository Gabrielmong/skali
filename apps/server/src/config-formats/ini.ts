import { ConfigParseError, type ConfigDoc, type RawField } from "./types.js";

/**
 * Lossless INI reader/writer for Unreal-style and generic files. Lines are kept
 * verbatim; `set` replaces only the value span. The value is everything after
 * the first `=`, minus leading whitespace and any trailing comment (a `;` or `#`
 * preceded by whitespace), which stays untouched. Never throws on malformed input.
 */
interface Line {
  text: string;
  eol: string;
  id?: string;
  key?: string;
  section?: string;
  /** Offsets of the value span within `text`. */
  vStart?: number;
  vEnd?: number;
  /** Empty value followed by a comment: insert a separating space after a new value. */
  pad?: boolean;
}

export function parseIni(text: string): ConfigDoc {
  const parts = text.split(/(\r\n|\n|\r)/);
  const lines: Line[] = [];
  let section: string | undefined;
  const counts = new Map<string, number>();

  for (let i = 0; i < parts.length; i += 2) {
    const t = parts[i]!;
    const eol = parts[i + 1] ?? "";
    if (t === "" && eol === "") continue;
    const trimmed = t.trim();
    if (trimmed === "" || trimmed[0] === ";" || trimmed[0] === "#") { lines.push({ text: t, eol }); continue; }
    const header = /^\s*\[([^\]]*)\]\s*(?:[;#].*)?$/.exec(t);
    if (header) {
      section = header[1];
      lines.push({ text: t, eol });
      continue;
    }
    const eq = t.indexOf("=");
    if (eq < 0) { lines.push({ text: t, eol }); continue; }
    const key = t.slice(0, eq).trim();
    if (key === "") { lines.push({ text: t, eol }); continue; }
    let vStart = eq + 1;
    while (vStart < t.length && /[ \t]/.test(t[vStart]!)) vStart++;
    // The value ends at the first ; or # preceded by whitespace; that comment is kept untouched.
    let vEnd = t.length;
    let emptyBeforeComment = false;
    for (let j = eq + 2; j < t.length; j++) {
      if ((t[j] === ";" || t[j] === "#") && /[ 	]/.test(t[j - 1]!)) {
        vEnd = j;
        emptyBeforeComment = j <= vStart;
        if (j < vStart) vStart = j;
        break;
      }
    }
    while (vEnd > vStart && /[ \t]/.test(t[vEnd - 1]!)) vEnd--;
    const base = `${section ?? ""}\u0000${key}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    lines.push({ text: t, eol, id: n === 1 ? base : `${base}\u0000${n}`, key, section, vStart, vEnd, pad: emptyBeforeComment });
  }

  const byId = (id: string) => lines.find((l) => l.id === id);

  return {
    fields(): RawField[] {
      return lines.filter((l) => l.id !== undefined).map((l) => {
        const f: RawField = { id: l.id!, key: l.key!, value: l.text.slice(l.vStart!, l.vEnd!) };
        if (l.section !== undefined) f.section = l.section;
        return f;
      });
    },
    set(id, value) {
      const l = byId(id);
      if (!l) throw new ConfigParseError("Unknown setting");
      const prev = l.text.slice(l.vStart!, l.vEnd!);
      let out: string;
      if (typeof value === "boolean") out = /^(True|False)$/.test(prev) ? (value ? "True" : "False") : String(value);
      else out = String(value);
      if (/[\r\n]/.test(out)) throw new ConfigParseError("INI values cannot contain line breaks");
      const ins = l.pad && out !== "" ? out + " " : out;
      l.pad = false;
      l.text = l.text.slice(0, l.vStart!) + ins + l.text.slice(l.vEnd!);
      l.vEnd = l.vStart! + out.length;
    },
    toString: () => lines.map((l) => l.text + l.eol).join(""),
  };
}
