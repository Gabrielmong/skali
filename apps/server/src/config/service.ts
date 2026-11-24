import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ConfigFieldView,
  ConfigFileView,
  ConfigFormat,
  ConfigHistoryEntry,
  ConfigSaveRequest,
  ConfigSaveResult,
  ConfigSourceView,
  RuntimeState,
} from "@skali/shared";
import { parseConfig, detectFormat, ConfigParseError, type ConfigDoc, type RawField } from "../config-formats/doc.js";
import { inferType } from "../config-formats/infer.js";
import { decodeText, encodeText, isProbablyBinary, type TextEncoding } from "../config-formats/text-codec.js";
import { BadRequestError, ConflictError, NotFoundError } from "../errors.js";
import type { BuiltinSource, ConfigTemplate, FieldMeta, GameAdapter } from "../games/types.js";
import { isRestartPending } from "../http/views.js";
import type { ServerRecord, ServerRepo } from "../servers/repo.js";
import { assertNoReparsePoints } from "../util/files.js";
import { Mutex } from "../util/mutex.js";
import type { ConfigHistory } from "./history.js";
import type { ConfigSourcesRepo, UserSource } from "./sources-repo.js";

export const LAUNCH_SOURCE_ID = "launch";
export const MAX_CONFIG_BYTES = 1024 * 1024;

const NOT_INSIDE = "Pick a file inside the server folder";
const NOT_TEXT = "This file isn't UTF-8 or UTF-16 text, so Skáli can't save it without changing other characters. Edit it outside Skáli.";
const FORMATS = new Set<string>(["ini", "palworld", "properties", "json", "yaml", "raw"]);

export interface ConfigServiceDeps {
  repo: Pick<ServerRepo, "get" | "touchConfig">;
  sources: ConfigSourcesRepo;
  history: ConfigHistory;
  adapterOf: (game: ServerRecord["game"]) => GameAdapter;
  runtimeState: (serverId: string) => RuntimeState;
  now: () => string;
}

type Value = string | number | boolean;

interface Source {
  id: string;
  label: string;
  format: ConfigFormat;
  relPath: string;
  builtin: BuiltinSource | null;
  user: UserSource | null;
}

interface FileState {
  serverId: string;
  src: Source;
  abs: string;
  /** The bytes on disk; null when the file doesn't exist. */
  buf: Buffer | null;
  text: string;
  encoding: TextEncoding;
  etag: string;
  missing: boolean;
  seededFrom?: string;
  doc: ConfigDoc | null;
  parseError?: string;
}

const own = <T>(o: Record<string, T> | undefined, k: string): T | undefined =>
  o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
const isFormat = (f: unknown): f is ConfigFormat => typeof f === "string" && FORMATS.has(f);
const errCode = (e: unknown) => (e as NodeJS.ErrnoException).code;
const asBool = (v: unknown): boolean => /^true$/i.test(String(v));
/** inferType plus any casing of true/false, so every file spelling of a switch is one. */
const typeOf = (v: Value) => (typeof v === "string" && /^(true|false)$/i.test(v) ? ("switch" as const) : inferType(v));
const normLocked = (v: Value): string => {
  const s = String(v);
  return /^(true|false)$/i.test(s) ? s.toLowerCase() : s;
};

/** Reads, previews, saves and keeps history for the config files a server's folder holds. */
export class ConfigService {
  private readonly locks = new Map<string, Mutex>();

  constructor(private readonly d: ConfigServiceDeps) {}

  private lock(serverId: string): Mutex {
    let m = this.locks.get(serverId);
    if (!m) this.locks.set(serverId, (m = new Mutex()));
    return m;
  }

  // ---------- sources ----------

  listSources(serverId: string): ConfigSourceView[] {
    const rec = this.d.repo.get(serverId);
    const out: ConfigSourceView[] = [{ id: LAUNCH_SOURCE_ID, kind: "launch", label: "Launch settings", builtin: true }];
    for (const b of this.d.adapterOf(rec.game).configSources) {
      out.push({ id: b.id, kind: "file", label: b.label, path: b.path, format: b.format, builtin: true });
    }
    for (const u of this.d.sources.list(serverId)) out.push(this.userView(u));
    return out;
  }

  private userView(u: UserSource): ConfigSourceView {
    return { id: u.id, kind: "file", label: u.label, path: u.path, format: u.format, builtin: false };
  }

  private resolve(rec: ServerRecord, sourceId: string): Source {
    const b = this.d.adapterOf(rec.game).configSources.find((s) => s.id === sourceId);
    if (b) return { id: b.id, label: b.label, format: b.format, relPath: b.path, builtin: b, user: null };
    const u = this.d.sources.list(rec.id).find((s) => s.id === sourceId);
    if (u) return { id: u.id, label: u.label, format: u.format, relPath: u.path, builtin: null, user: u };
    throw new NotFoundError("Config file not found");
  }

  private isBuiltinId(rec: ServerRecord, sourceId: string): boolean {
    return sourceId === LAUNCH_SOURCE_ID || this.d.adapterOf(rec.game).configSources.some((s) => s.id === sourceId);
  }

  /** Resolves `rel` under the server folder; anything that lands outside is refused. */
  private inside(rec: ServerRecord, rel: string): string {
    const root = path.resolve(rec.folder);
    const abs = path.resolve(root, rel);
    const r = path.relative(root, abs);
    if (r === "" || r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r)) throw new BadRequestError(NOT_INSIDE);
    return abs;
  }

  async addSource(serverId: string, req: { path: string; format?: ConfigFormat; label?: string }): Promise<ConfigSourceView> {
    return this.lock(serverId).run(() => {
      const rec = this.d.repo.get(serverId);
      const rel = checkRelPath(req.path);
      if (req.format !== undefined && !isFormat(req.format)) throw new BadRequestError("Unknown file format");
      const abs = this.inside(rec, rel);
      const key = rel.toLowerCase();
      if (this.d.adapterOf(rec.game).configSources.some((b) => path.normalize(b.path).toLowerCase() === key)) {
        throw new ConflictError("That file is already in the list");
      }
      assertNoReparsePoints(rec.folder, abs);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch (e) {
        if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") throw new BadRequestError("That file doesn't exist");
        throw e;
      }
      if (!st.isFile()) throw new BadRequestError(NOT_INSIDE);
      readChecked(abs); // size and binary checks
      const id = identityOf(abs);
      if (id !== null) {
        const taken = new Set(this.builtinIdentities(rec));
        for (const u of this.d.sources.list(serverId)) {
          const i = identityOf(this.inside(rec, u.path));
          if (i !== null) taken.add(i);
        }
        if (taken.has(id)) throw new ConflictError("That file is already in the list");
      }
      const label = typeof req.label === "string" && req.label.trim() !== "" ? req.label.trim().slice(0, 100) : path.basename(rel);
      const u = this.d.sources.add(serverId, { path: rel, format: req.format ?? detectFormat(rel), label });
      return this.userView(u);
    });
  }

  /** Identities (device+inode) of the built-in files that exist: short names and hard links alias these. */
  private builtinIdentities(rec: ServerRecord): string[] {
    const out: string[] = [];
    for (const b of this.d.adapterOf(rec.game).configSources) {
      try {
        const i = identityOf(this.inside(rec, b.path));
        if (i !== null) out.push(i);
      } catch {
        // a built-in whose path can't be resolved has nothing to alias
      }
    }
    return out;
  }

  async updateSource(serverId: string, sourceId: string, patch: { format?: ConfigFormat; label?: string }): Promise<ConfigSourceView> {
    return this.lock(serverId).run(() => {
      const rec = this.d.repo.get(serverId);
      if (this.isBuiltinId(rec, sourceId)) throw new BadRequestError("Built-in files can't be changed");
      if (patch.format !== undefined && !isFormat(patch.format)) throw new BadRequestError("Unknown file format");
      let label = patch.label;
      if (label !== undefined) {
        label = String(label).trim().slice(0, 100);
        if (label === "") throw new BadRequestError("Enter a name for the file");
      }
      const p: { format?: ConfigFormat; label?: string } = {};
      if (patch.format !== undefined) p.format = patch.format;
      if (label !== undefined) p.label = label;
      if (!this.d.sources.update(serverId, sourceId, p)) throw new NotFoundError("Config file not found");
      return this.userView(this.d.sources.list(serverId).find((s) => s.id === sourceId)!);
    });
  }

  async removeSource(serverId: string, sourceId: string): Promise<void> {
    return this.lock(serverId).run(() => {
      const rec = this.d.repo.get(serverId);
      if (this.isBuiltinId(rec, sourceId)) throw new BadRequestError("Built-in files can't be removed");
      if (!this.d.sources.remove(serverId, sourceId)) throw new NotFoundError("Config file not found");
      this.d.history.removeSource(serverId, sourceId);
    });
  }

  // ---------- reading ----------

  read(serverId: string, sourceId: string): ConfigFileView {
    const rec = this.d.repo.get(serverId);
    return this.view(this.load(rec, this.resolve(rec, sourceId)));
  }

  private load(rec: ServerRecord, src: Source): FileState {
    const abs = this.inside(rec, src.relPath);
    assertNoReparsePoints(rec.folder, abs);
    const buf = readChecked(abs);
    let text = "";
    let encoding: TextEncoding = "utf8";
    let missing = false;
    let seededFrom: string | undefined;
    let readOnly = false;
    if (buf) {
      ({ text, encoding } = decodeText(buf));
      readOnly = !encodeText(text, encoding).equals(buf);
    } else {
      missing = true;
      const seed = src.builtin?.seedFrom ? this.readSeed(rec, src.builtin.seedFrom) : null;
      if (seed !== null) {
        text = seed;
        seededFrom = src.builtin!.seedFrom;
      }
    }
    const st: FileState = {
      serverId: rec.id, src, abs, buf, text, encoding, missing, doc: null,
      etag: buf ? createHash("sha256").update(buf).digest("hex") : "missing",
    };
    if (seededFrom !== undefined) st.seededFrom = seededFrom;
    if (readOnly) st.parseError = NOT_TEXT;
    else if (!(missing && seededFrom === undefined)) {
      try {
        st.doc = parseConfig(src.format, text);
      } catch (e) {
        st.parseError = parseMessage(e);
      }
    } else {
      st.doc = parseConfig("raw", "");
    }
    return st;
  }

  /** The seed file's text, or null when it can't be used (the seed is best-effort). */
  private readSeed(rec: ServerRecord, rel: string): string | null {
    try {
      const abs = this.inside(rec, rel);
      assertNoReparsePoints(rec.folder, abs);
      const buf = readChecked(abs);
      return buf ? decodeText(buf).text : null;
    } catch {
      return null;
    }
  }

  private isReadOnly(st: FileState): boolean {
    return st.parseError === NOT_TEXT;
  }

  private view(st: FileState, text = st.text): ConfigFileView {
    const v: ConfigFileView = { sourceId: st.src.id, format: st.src.format, etag: st.etag, raw: text, fields: null };
    if (this.isReadOnly(st)) {
      v.parseError = NOT_TEXT;
    } else if (st.src.format === "raw") {
      v.fields = null;
    } else if (st.missing && st.seededFrom === undefined && text === "") {
      v.fields = [];
    } else {
      try {
        v.fields = this.fieldViews(st.src, parseConfig(st.src.format, text).fields());
      } catch (e) {
        v.parseError = parseMessage(e);
      }
    }
    if (st.missing) {
      v.missing = true;
      if (st.seededFrom !== undefined) v.seededFrom = st.seededFrom;
    }
    return v;
  }

  private fieldViews(src: Source, fields: RawField[]): ConfigFieldView[] {
    const tpl = src.builtin?.template;
    return fields.map((f) => {
      const meta: FieldMeta = own(tpl?.fields, f.key) ?? {};
      const type = meta.type ?? typeOf(f.value);
      const lockedNote = own(tpl?.locked, f.key);
      const out: ConfigFieldView = {
        id: f.id, key: f.key, value: type === "switch" ? asBool(f.value) : f.value, type,
      };
      if (f.section !== undefined) out.section = f.section;
      if (meta.label !== undefined) out.label = meta.label;
      if (meta.help !== undefined) out.help = meta.help;
      if (meta.group !== undefined) out.group = meta.group;
      if (meta.options !== undefined) out.options = meta.options;
      if (meta.min !== undefined) out.min = meta.min;
      if (meta.max !== undefined) out.max = meta.max;
      if (meta.step !== undefined) out.step = meta.step;
      if (meta.unit !== undefined) out.unit = meta.unit;
      if (lockedNote !== undefined) out.locked = lockedNote;
      return out;
    });
  }

  // ---------- preview / save ----------

  preview(serverId: string, sourceId: string, req: Omit<ConfigSaveRequest, "etag">): ConfigFileView {
    const rec = this.d.repo.get(serverId);
    const st = this.load(rec, this.resolve(rec, sourceId));
    const text = this.newText(st, req);
    return this.view(st, text);
  }

  async save(serverId: string, sourceId: string, req: ConfigSaveRequest): Promise<ConfigSaveResult> {
    return this.lock(serverId).run(() => this.saveLocked(serverId, sourceId, req));
  }

  async restore(serverId: string, sourceId: string, entryId: string, etag: string): Promise<ConfigSaveResult> {
    return this.lock(serverId).run(() => {
      this.d.repo.get(serverId);
      const raw = decodeText(this.d.history.read(serverId, sourceId, entryId)).text;
      return this.saveLocked(serverId, sourceId, { etag, raw });
    });
  }

  private saveLocked(serverId: string, sourceId: string, req: ConfigSaveRequest): ConfigSaveResult {
    const rec = this.d.repo.get(serverId);
    const src = this.resolve(rec, sourceId);
    if ((req.changes === undefined) === (req.raw === undefined)) throw new BadRequestError("Send either changes or raw text");
    const status = this.d.runtimeState(serverId).status;
    if (status === "starting" || status === "stopping") {
      throw new ConflictError("Server is starting or stopping; save again in a moment");
    }
    const st = this.load(rec, src);
    if (src.user && st.buf) {
      const id = identityOf(st.abs);
      if (id !== null && this.builtinIdentities(rec).includes(id)) throw new ConflictError("That file is already in the list");
    }
    if (st.etag !== req.etag) throw new ConflictError("The file changed on disk since you opened it. Reload to see the new version.");
    const text = this.newText(st, req);
    if (st.missing || text !== st.text) {
      assertNoReparsePoints(rec.folder, st.abs);
      if (st.buf) this.d.history.push(serverId, src.id, st.buf);
      fs.mkdirSync(path.dirname(st.abs), { recursive: true });
      fs.writeFileSync(st.abs, encodeText(text, st.encoding));
      this.d.repo.touchConfig(serverId, this.d.now());
    }
    const fresh = this.load(rec, src);
    const after = this.d.repo.get(serverId);
    return { file: this.view(fresh), restartPending: isRestartPending(after, this.d.runtimeState(serverId)) };
  }

  /** The text a request would produce; throws BadRequestError for anything save would refuse. */
  private newText(st: FileState, req: { changes?: Record<string, Value>; raw?: string }): string {
    if ((req.changes === undefined) === (req.raw === undefined)) throw new BadRequestError("Send either changes or raw text");
    if (this.isReadOnly(st)) throw new BadRequestError(NOT_TEXT);
    if (req.raw !== undefined) {
      const raw = matchCrlf(st.text, req.raw);
      this.checkLockedRaw(st, raw);
      return raw;
    }
    return this.applyChanges(st, req.changes!);
  }

  private applyChanges(st: FileState, changes: Record<string, Value>): string {
    if (!st.doc || st.parseError !== undefined) throw new BadRequestError("This file can only be edited as raw text until it parses");
    const doc = parseConfig(st.src.format, st.text);
    const byId = new Map(doc.fields().map((f) => [f.id, f]));
    const tpl = st.src.builtin?.template;
    const todo: [string, Value][] = [];
    for (const [id, value] of Object.entries(changes)) {
      const f = byId.get(id);
      if (!f) throw new BadRequestError(`Unknown setting: ${id}`);
      const type = own(tpl?.fields, f.key)?.type ?? typeOf(f.value);
      let next: Value = value;
      if (type === "switch") {
        if (typeof value === "boolean") next = value;
        else if (typeof value === "string" && /^(true|false)$/i.test(value)) next = asBool(value);
        else throw new BadRequestError(`${f.key} must be on or off`);
        if (next === asBool(f.value)) continue;
      } else if (sameNumber(value, f.value, type) || value === f.value) {
        continue;
      }
      const note = own(tpl?.locked, f.key);
      if (note !== undefined) throw new BadRequestError(`${f.key} is managed by Skáli: ${note}`);
      todo.push([id, next]);
    }
    if (todo.length === 0) return st.text;
    for (const [id, v] of todo) {
      try {
        doc.set(id, v);
      } catch (e) {
        if (e instanceof ConfigParseError) throw new BadRequestError(e.message);
        throw e;
      }
    }
    return doc.toString();
  }

  /** Raw text that parses must leave every locked key as it was (removing one counts as a change). */
  private checkLockedRaw(st: FileState, raw: string): void {
    const tpl: ConfigTemplate | undefined = st.src.builtin?.template;
    const keys = tpl ? Object.keys(tpl.locked) : [];
    if (!tpl || keys.length === 0) return;
    let next: ConfigDoc;
    try {
      next = parseConfig(st.src.format, raw);
    } catch {
      return; // unparseable raw is saved as the owner wrote it
    }
    const before = this.lockedBaseline(st);
    const after = next.fields();
    for (const k of keys) {
      const sig = (fs: RawField[]) => JSON.stringify(fs.filter((f) => f.key.toLowerCase() === k.toLowerCase()).map((f) => normLocked(f.value)));
      if (sig(before) !== sig(after)) throw new BadRequestError(`${k} is managed by Skáli: ${tpl.locked[k]}`);
    }
  }

  /**
   * The fields locked keys are compared against: the current file's, or when it doesn't parse, the newest
   * history entry that does. With neither, an empty baseline: every locked key in new text counts as a change.
   */
  private lockedBaseline(st: FileState): RawField[] {
    if (st.doc && st.parseError === undefined) return st.doc.fields();
    for (const e of this.d.history.list(st.serverId, st.src.id)) {
      try {
        return parseConfig(st.src.format, decodeText(this.d.history.read(st.serverId, st.src.id, e.id)).text).fields();
      } catch {
        // this version doesn't parse either; try an older one
      }
    }
    return [];
  }

  // ---------- history ----------

  history(serverId: string, sourceId: string): ConfigHistoryEntry[] {
    const rec = this.d.repo.get(serverId);
    return this.d.history.list(serverId, this.resolve(rec, sourceId).id);
  }

  historyRaw(serverId: string, sourceId: string, entryId: string): { raw: string } {
    const rec = this.d.repo.get(serverId);
    const src = this.resolve(rec, sourceId);
    return { raw: decodeText(this.d.history.read(serverId, src.id, entryId)).text };
  }
}

/** device:inode of a file (follows 8.3 short names and hard links), or null if it can't be stat'ed. */
function identityOf(abs: string): string | null {
  try {
    const st = fs.statSync(abs, { bigint: true });
    return `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

/** Browsers turn CRLF into LF in text areas: when the file is all CRLF and `raw` has no CR, restore the CRLFs. */
function matchCrlf(current: string, raw: string): string {
  if (raw.includes("\r") || !current.includes("\r\n") || /(?<!\r)\n/.test(current)) return raw;
  return raw.replace(/\n/g, "\r\n");
}
/** Numeric equality for number fields (the file may hold "1.000000" where the form sends 1). */
function sameNumber(value: Value, cur: Value, type: string): boolean {
  if (type !== "number") return false;
  const a = typeof value === "string" ? (value.trim() === "" ? NaN : Number(value)) : Number(value);
  const b = typeof cur === "string" ? (cur.trim() === "" ? NaN : Number(cur)) : Number(cur);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function parseMessage(e: unknown): string {
  if (e instanceof ConfigParseError) return e.line !== undefined && !/line/i.test(e.message) ? `${e.message} (line ${e.line})` : e.message;
  return e instanceof Error ? e.message : String(e);
}

/**
 * Checks a user-supplied relative path on the string alone, before any filesystem access, and returns it
 * normalized (backslash separators on Windows, no trailing separator).
 */
function checkRelPath(p: unknown): string {
  const bad = () => new BadRequestError(NOT_INSIDE);
  if (typeof p !== "string" || p.trim() === "" || p.includes("\0") || p.includes(":")) throw bad();
  if (/^[\\/]/.test(p) || path.isAbsolute(p)) throw bad(); // rooted, UNC and \\?\ forms
  if (p.split(/[\\/]+/).some((seg) => seg === "..")) throw bad();
  const norm = path.normalize(p).replace(/[\\/]+$/, "");
  if (norm === "" || norm === ".") throw bad();
  return norm;
}

/** The file's bytes, or null if it doesn't exist; refuses directories, big files and binary files. */
function readChecked(abs: string): Buffer | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return null;
    throw e;
  }
  if (!st.isFile()) throw new BadRequestError("Not a text file");
  if (st.size > MAX_CONFIG_BYTES) throw new BadRequestError("File is larger than 1 MB; edit it outside Skáli");
  const buf = fs.readFileSync(abs);
  if (buf.length > MAX_CONFIG_BYTES) throw new BadRequestError("File is larger than 1 MB; edit it outside Skáli");
  if (isProbablyBinary(buf)) throw new BadRequestError("Not a text file");
  return buf;
}
