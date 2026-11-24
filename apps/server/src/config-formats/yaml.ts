import { CST, Composer, LineCounter, Parser, isAlias, isMap, isScalar, isSeq, parseDocument, type Document } from "yaml";
import { ConfigParseError, type ConfigDoc, type RawField } from "./types.js";

/**
 * Lossless YAML reader/writer on top of the `yaml` CST. Scalars are located via the
 * composed AST (which keeps a reference to each CST token); `set` rewrites only that
 * token, and the output is CST.stringify over all tokens, so comments, indentation,
 * line endings and quoting elsewhere are untouched. Ids are RFC 6901 pointers.
 */
type Kind = "string" | "number" | "boolean" | "null";
interface Leaf {
  id: string;
  key: string;
  section?: string;
  kind: Kind;
  value: string | number | boolean;
  token: CST.FlowScalar | CST.BlockScalar;
  inFlow: boolean;
}

const esc = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** True when `value`, written as a plain scalar, re-reads as exactly that string. */
function plainRoundTrips(value: string, inFlow: boolean): boolean {
  if (value === "" || value !== value.trim() || /[\r\n\t]/.test(value)) return false;
  if (inFlow && /[,[\]{}]/.test(value)) return false;
  try {
    const d = parseDocument(`k: ${value}\n`);
    return d.errors.length === 0 && (d.toJS() as { k?: unknown } | null)?.k === value;
  } catch {
    return false;
  }
}

/** Rewrite any scalar token as a double-quoted one (JSON string syntax is valid YAML). */
function toDoubleQuoted(t: CST.FlowScalar | CST.BlockScalar, text: string): void {
  const tok = t as unknown as Record<string, unknown>;
  if (t.type === "block-scalar") {
    // The header line (space, comment, line break) moves to `end`, keeping same-line
    // comments and the line break that terminates the value.
    const rest = t.props.filter((p) => p.type !== "block-scalar-header");
    const atEof = t.source !== "" && !t.source.endsWith("\n");
    tok.end = atEof ? rest.filter((p) => p.type !== "newline") : rest;
    delete tok.props;
  }
  tok.type = "double-quoted-scalar";
  tok.source = JSON.stringify(text);
}

/**
 * Rewrite a block scalar's content as a literal (`|`) block, indented to match.
 * CST.setScalarValue does not indent block scalars, so this is done by hand.
 * Returns false when a literal block cannot represent the value safely.
 */
function writeBlock(t: CST.BlockScalar, text: string, eol: string): boolean {
  const header = t.props.find((p) => p.type === "block-scalar-header");
  if (!header || text === "" || /^[ \t\n]/.test(text) || text.includes("\r")) return false;
  const trailing = /\n*$/.exec(text)![0].length;
  const chomp = trailing === 0 ? "-" : trailing === 1 ? "" : "+";
  // An empty body is terminated by the header's own line break, which lives in props.
  const origNl = t.source === "" ? t.props.some((p) => p.type === "newline") : t.source.endsWith("\n");
  if (!origNl && (chomp !== "-" || t.source === "")) return false;
  const first = t.source.split("\n").find((l) => l.trim() !== "");
  const indent = " ".repeat(first ? first.length - first.trimStart().length : Math.max(t.indent, 0) + 2);
  const body = text.slice(0, text.length - trailing).split("\n");
  if (chomp === "+") for (let k = 1; k < trailing; k++) body.push("");
  let src = body.map((l) => (l === "" ? "" : indent + l)).join(eol) + eol;
  if (!origNl) src = src.slice(0, -eol.length);
  (header as CST.SourceToken).source = "|" + chomp;
  t.source = src;
  return true;
}

export function parseYamlDoc(source: string): ConfigDoc {
  const eol = source.includes(String.fromCharCode(13, 10)) ? String.fromCharCode(13, 10) : "\n";
  const lc = new LineCounter();
  const tokens = [...new Parser(lc.addNewLine).parse(source)];
  const docs: Document.Parsed[] = [...new Composer({ keepSourceTokens: true, lineCounter: lc }).compose(tokens)];

  for (const d of docs) {
    const e = d.errors[0];
    if (e) throw new ConfigParseError(e.message.split("\n")[0]!, lc.linePos(e.pos[0]).line);
  }
  if (docs.length > 1) throw new ConfigParseError("Multiple YAML documents are not supported");

  const leaves: Leaf[] = [];
  const seen = new Set<string>();
  const root = docs[0]?.contents ?? null;
  if (root && !isMap(root) && !isSeq(root)) {
    throw new ConfigParseError("Top-level value must be a mapping or sequence");
  }

  function walk(node: unknown, segs: string[], inFlow: boolean): void {
    if (isMap(node)) {
      const flow = inFlow || node.flow === true;
      for (const p of node.items) {
        if (!isScalar(p.key)) continue; // complex key: skip its whole subtree
        walk(p.value, [...segs, String(p.key.value)], flow);
      }
    } else if (isSeq(node)) {
      const flow = inFlow || node.flow === true;
      node.items.forEach((it, n) => walk(it, [...segs, String(n)], flow));
    } else if (isScalar(node) && !isAlias(node)) {
      const token = node.srcToken;
      if (!token || (token.type !== "scalar" && token.type !== "single-quoted-scalar"
        && token.type !== "double-quoted-scalar" && token.type !== "block-scalar")) return;
      const v = node.value;
      const plain = node.type === "PLAIN";
      const kind: Kind = plain && typeof v === "number" ? "number"
        : plain && typeof v === "boolean" ? "boolean"
        : plain && v === null ? "null" : "string";
      const id = segs.map((s) => "/" + esc(s)).join("");
      if (seen.has(id)) throw new ConfigParseError(`Duplicate key ${id}`);
      seen.add(id);
      const l: Leaf = {
        id, key: segs[segs.length - 1]!, kind, token, inFlow,
        value: kind === "null" ? "" : (v as string | number | boolean),
      };
      if (segs.length > 1) l.section = segs[0]!;
      leaves.push(l);
    }
  }
  walk(root, [], false);

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
      let text: string;
      let stored: string | number | boolean;
      let quote = false;
      if (l.kind === "number") {
        const n = typeof value === "number" ? value
          : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
        if (!Number.isFinite(n)) throw new ConfigParseError(`${l.key} must be a number`);
        text = String(n); stored = n;
      } else if (l.kind === "boolean") {
        if (typeof value !== "boolean") throw new ConfigParseError(`${l.key} must be true or false`);
        text = String(value); stored = value;
      } else {
        text = stored = String(value);
        quote = (l.kind === "null" || l.token.type === "scalar") && !plainRoundTrips(text, l.inFlow);
      }
      const t = l.token;
      if (t.type === "block-scalar") {
        if (!writeBlock(t, text, eol)) toDoubleQuoted(t, text);
      } else if (quote || /[\r\n]/.test(text)) {
        toDoubleQuoted(t, text);
      } else {
        CST.setScalarValue(t, text, { inFlow: l.inFlow });
      }
      l.value = stored;
      if (l.kind === "null") l.kind = "string";
    },
    toString: () => tokens.map((t) => CST.stringify(t)).join(""),
  };
}
