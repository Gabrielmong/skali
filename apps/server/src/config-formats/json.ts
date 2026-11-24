import { ConfigParseError, type ConfigDoc, type RawField } from "./types.js";

/**
 * Lossless JSON reader/writer. A hand-written tokenizer records the [start, end)
 * span of every scalar leaf; `set` splices only that span, so whitespace, key
 * order and number formatting elsewhere are untouched. Strict JSON: comments,
 * trailing commas and duplicate keys are errors. Ids are RFC 6901 pointers.
 */
type Kind = "string" | "number" | "boolean" | "null";
interface Leaf {
  id: string;
  key: string;
  section?: string;
  kind: Kind;
  value: string | number | boolean;
  start: number;
  end: number;
}

const MAX_DEPTH = 200;
const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

export function parseJsonDoc(source: string): ConfigDoc {
  let text = source;
  const leaves: Leaf[] = [];
  const seen = new Set<string>();
  let i = 0;

  const lineAt = (pos: number) => {
    let n = 1;
    for (let k = 0; k < pos && k < text.length; k++) if (text[k] === "\n") n++;
    return n;
  };
  const fail = (msg: string, pos = i): never => { throw new ConfigParseError(msg, lineAt(pos)); };
  const ws = () => { while (i < text.length && " \t\r\n".includes(text[i]!)) i++; };

  function readString(): string {
    const start = i;
    i++; // opening quote
    while (i < text.length) {
      const c = text[i]!;
      if (c === '"') {
        i++;
        try { return JSON.parse(text.slice(start, i)) as string; } catch { return fail("Invalid string", start); }
      }
      if (c === "\\") i += 2;
      else if (c < " ") return fail("Control character in string");
      else i++;
    }
    return fail("Unterminated string", start);
  }

  function leaf(segs: string[], kind: Kind, value: string | number | boolean, start: number): void {
    const id = segs.map((s) => "/" + esc(s)).join("");
    if (seen.has(id)) fail(`Duplicate key ${id}`, start);
    seen.add(id);
    const l: Leaf = { id, key: segs[segs.length - 1]!, kind, value, start, end: i };
    if (segs.length > 1) l.section = segs[0]!;
    leaves.push(l);
  }

  function parseValue(segs: string[], depth: number): void {
    if (depth > MAX_DEPTH) fail("Nested too deeply");
    ws();
    const c = text[i];
    const start = i;
    if (c === "{") {
      i++; ws();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("Expected a string key");
        const k = readString();
        ws();
        if (text[i] !== ":") fail("Expected ':'");
        i++;
        parseValue([...segs, k], depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        fail("Expected ',' or '}'");
      }
    } else if (c === "[") {
      i++; ws();
      if (text[i] === "]") { i++; return; }
      for (let n = 0; ; n++) {
        parseValue([...segs, String(n)], depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return; }
        fail("Expected ',' or ']'");
      }
    } else if (c === '"') {
      const v = readString();
      leaf(segs, "string", v, start);
    } else if (c === "t" && text.startsWith("true", i)) { i += 4; leaf(segs, "boolean", true, start); }
    else if (c === "f" && text.startsWith("false", i)) { i += 5; leaf(segs, "boolean", false, start); }
    else if (c === "n" && text.startsWith("null", i)) { i += 4; leaf(segs, "null", "", start); }
    else {
      const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 400));
      if (!m) return fail("Unexpected token");
      i += m[0].length;
      leaf(segs, "number", Number(m[0]), start);
    }
  }

  ws();
  if (text[i] !== "{" && text[i] !== "[" && i < text.length) fail("Top-level value must be an object or array");
  parseValue([], 0);
  ws();
  if (i < text.length) fail("Unexpected content after the JSON value");

  const byId = new Map(leaves.map((l) => [l.id, l]));
  return {
    fields: (): RawField[] => leaves.map((l) => {
      const f: RawField = { id: l.id, key: l.key, value: l.value };
      if (l.section !== undefined) f.section = l.section;
      return f;
    }),
    set(id, value) {
      const l = byId.get(id);
      if (!l) throw new ConfigParseError("Unknown setting");
      let token: string;
      let stored: string | number | boolean;
      if (l.kind === "number") {
        const n = typeof value === "number" ? value
          : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
        if (!Number.isFinite(n)) throw new ConfigParseError(`${l.key} must be a number`);
        token = String(n); stored = n;
      } else if (l.kind === "boolean") {
        if (typeof value !== "boolean") throw new ConfigParseError(`${l.key} must be true or false`);
        token = String(value); stored = value;
      } else {
        stored = String(value);
        token = JSON.stringify(stored);
      }
      const delta = token.length - (l.end - l.start);
      text = text.slice(0, l.start) + token + text.slice(l.end);
      l.end = l.start + token.length;
      l.value = stored;
      if (l.kind === "null") l.kind = "string";
      for (const o of leaves) if (o.start > l.start) { o.start += delta; o.end += delta; }
    },
    toString: () => text,
  };
}
