import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeState } from "@skali/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigHistory } from "../../src/config/history.js";
import { ConfigService } from "../../src/config/service.js";
import { ConfigSourcesRepo } from "../../src/config/sources-repo.js";
import { openDb, type Db } from "../../src/db.js";
import { encodeText } from "../../src/config-formats/text-codec.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../src/errors.js";
import { getAdapter } from "../../src/games/registry.js";
import { ServerRepo, type ServerRecord } from "../../src/servers/repo.js";

const key = Buffer.alloc(32, 3);
const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const PAL_REL = "Pal\\Saved\\Config\\WindowsServer\\PalWorldSettings.ini";
const NOT_TEXT = "This file isn't UTF-8 or UTF-16 text, so Skáli can't save it without changing other characters. Edit it outside Skáli.";

let root: string, db: Db, repo: ServerRepo, sources: ConfigSourcesRepo, history: ConfigHistory, svc: ConfigService;
let state: RuntimeState;
let clock: string;
let pal: ServerRecord;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const palFile = () => path.join(pal.folder, PAL_REL);
function mk(name: string, game: "palworld" | "minecraft" = "palworld"): ServerRecord {
  const folder = path.join(root, name);
  fs.mkdirSync(folder, { recursive: true });
  return repo.create({ name, game, folder, launch: {}, stopTimeoutSec: 60 });
}
function seed(rec: ServerRecord = pal): void {
  fs.copyFileSync(path.join(FIXTURES, "DefaultPalWorldSettings.ini"), path.join(rec.folder, "DefaultPalWorldSettings.ini"));
}
const put = (rel: string, data: string | Buffer, rec: ServerRecord = pal) => {
  const f = path.join(rec.folder, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  return f;
};
const rejects = async (p: Promise<unknown>, cls: new (m: string) => Error, msg?: string | RegExp) => {
  const e = await p.then(() => null, (x: unknown) => x);
  expect(e).toBeInstanceOf(cls);
  if (typeof msg === "string") expect((e as Error).message).toBe(msg);
  else if (msg) expect((e as Error).message).toMatch(msg);
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-cfg-"));
  db = openDb(path.join(root, "t.db"));
  repo = new ServerRepo(db, key);
  sources = new ConfigSourcesRepo(db);
  history = new ConfigHistory(path.join(root, "hist"));
  state = { status: "stopped", crashPaused: false };
  clock = "2026-11-24T10:00:00.000Z";
  svc = new ConfigService({ repo, sources, history, adapterOf: getAdapter, runtimeState: () => state, now: () => clock });
  pal = mk("pal");
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("service: sources", () => {
  it("lists launch first, then built-ins, then user sources", async () => {
    put("a.ini", "x=1\n");
    const u = await svc.addSource(pal.id, { path: "a.ini" });
    const list = svc.listSources(pal.id);
    expect(list.map((s) => s.id)).toEqual(["launch", "palworld-settings", u.id]);
    expect(list[0]).toMatchObject({ kind: "launch", builtin: true });
    expect(list[1]).toMatchObject({ kind: "file", builtin: true, format: "palworld", path: PAL_REL });
    expect(list[2]).toMatchObject({ kind: "file", builtin: false, label: "a.ini", format: "ini", path: "a.ini" });
  });
  it("unknown server and unknown source are 404; another server's source is 404", async () => {
    expect(() => svc.listSources("nope")).toThrow(NotFoundError);
    expect(() => svc.read(pal.id, "nope")).toThrow(NotFoundError);
    expect(() => svc.read(pal.id, "launch")).toThrow(NotFoundError);
    const other = mk("pal2");
    put("a.ini", "x=1\n", other);
    const u = await svc.addSource(other.id, { path: "a.ini" });
    expect(() => svc.read(pal.id, u.id)).toThrow(NotFoundError);
    await rejects(svc.updateSource(pal.id, u.id, { label: "x" }), NotFoundError);
    await rejects(svc.removeSource(pal.id, u.id), NotFoundError);
    expect(sources.list(other.id)).toHaveLength(1);
  });
});

describe("service: read", () => {
  it("palworld built-in missing is seeded from DefaultPalWorldSettings.ini with missing:true; save creates the file", async () => {
    seed();
    const v = svc.read(pal.id, "palworld-settings");
    expect(v).toMatchObject({ missing: true, seededFrom: "DefaultPalWorldSettings.ini", etag: "missing", format: "palworld" });
    expect(v.raw).toContain("bIsPvP=False");
    const f = v.fields!.find((x) => x.key === "bIsPvP")!;
    expect(f).toMatchObject({ type: "switch", value: false, label: "PvP" });
    expect(v.fields!.find((x) => x.key === "RESTAPIEnabled")!.locked).toMatch(/REST/);
    expect(fs.existsSync(palFile())).toBe(false);
    const r = await svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { ExpRate: 2 } });
    expect(fs.existsSync(palFile())).toBe(true);
    expect(fs.readFileSync(palFile(), "utf8")).toContain("ExpRate=2,");
    expect(r.file.missing).toBeUndefined();
    expect(history.list(pal.id, "palworld-settings")).toHaveLength(0);
  });
  it("missing file with no seed reads as empty", () => {
    const v = svc.read(pal.id, "palworld-settings");
    expect(v).toMatchObject({ raw: "", missing: true, etag: "missing" });
    expect(v.fields).toEqual([]);
    expect(v.seededFrom).toBeUndefined();
  });
  it("etag is sha256 of the bytes", () => {
    const buf = Buffer.from("x=1\n");
    put(PAL_REL, buf);
    expect(svc.read(pal.id, "palworld-settings").etag).toBe(sha(buf));
  });
  it("a parse failure gives fields:null and parseError; raw format gives null fields", async () => {
    put(PAL_REL, "[nothing]\n");
    const v = svc.read(pal.id, "palworld-settings");
    expect(v.fields).toBeNull();
    expect(v.parseError).toBeTruthy();
    put("n.txt", "hello\n");
    const u = await svc.addSource(pal.id, { path: "n.txt" });
    expect(svc.read(pal.id, u.id)).toMatchObject({ raw: "hello\n", fields: null, format: "raw" });
  });
  it("refuses >1 MiB and binary files", () => {
    put(PAL_REL, Buffer.alloc(1024 * 1024 + 1, 97));
    expect(() => svc.read(pal.id, "palworld-settings")).toThrow("File is larger than 1 MB; edit it outside Skáli");
    put(PAL_REL, Buffer.from([97, 0, 98]));
    expect(() => svc.read(pal.id, "palworld-settings")).toThrow("Not a text file");
  });
  it("switch fields report real booleans whatever the casing", async () => {
    put("t.json", JSON.stringify({ a: true, b: "x" }));
    put("c.ini", "a=True\nb=false\nc=TRUE\n");
    const j = await svc.addSource(pal.id, { path: "t.json" });
    const c = await svc.addSource(pal.id, { path: "c.ini" });
    expect(svc.read(pal.id, j.id).fields!.find((f) => f.key === "a")).toMatchObject({ type: "switch", value: true });
    const vals = svc.read(pal.id, c.id).fields!.map((f) => [f.type, f.value]);
    expect(vals).toEqual([["switch", true], ["switch", false], ["switch", true]]);
  });
  it("a file that is not UTF-8/16 text is read-only", async () => {
    const f = put("l.ini", Buffer.concat([Buffer.from("name=caf"), Buffer.from([0xe9]), Buffer.from("\n")]));
    const u = await svc.addSource(pal.id, { path: "l.ini" });
    const v = svc.read(pal.id, u.id);
    expect(v.fields).toBeNull();
    expect(v.parseError).toBe(NOT_TEXT);
    await rejects(svc.save(pal.id, u.id, { etag: v.etag, raw: "name=x\n" }), BadRequestError, NOT_TEXT);
    await rejects(svc.save(pal.id, u.id, { etag: v.etag, changes: { name: "x" } }), BadRequestError, NOT_TEXT);
    expect(() => svc.preview(pal.id, u.id, { changes: { name: "x" } })).toThrow(NOT_TEXT);
    expect(fs.readFileSync(f)[8]).toBe(0xe9);
  });
});

describe("service: save", () => {
  const setup = () => {
    seed();
    put(PAL_REL, fs.readFileSync(path.join(FIXTURES, "DefaultPalWorldSettings.ini")));
  };
  it("form save changes one value; old version in history; configChangedAt set", async () => {
    setup();
    const before = fs.readFileSync(palFile());
    const v = svc.read(pal.id, "palworld-settings");
    clock = "2026-11-24T11:00:00.000Z";
    const r = await svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { ExpRate: 3 } });
    expect(fs.readFileSync(palFile(), "utf8")).toContain("ExpRate=3,");
    const h = history.list(pal.id, "palworld-settings");
    expect(h).toHaveLength(1);
    expect(history.read(pal.id, "palworld-settings", h[0]!.id).equals(before)).toBe(true);
    expect(repo.get(pal.id).configChangedAt).toBe("2026-11-24T11:00:00.000Z");
    expect(r.restartPending).toBe(false);
    expect(r.file.etag).toBe(sha(fs.readFileSync(palFile())));
  });
  it("restartPending is true when the server started before the change", async () => {
    setup();
    state = { status: "running", crashPaused: false, startedAt: "2026-11-24T09:00:00.000Z" };
    const v = svc.read(pal.id, "palworld-settings");
    const r = await svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { ExpRate: 3 } });
    expect(r.restartPending).toBe(true);
  });
  it("etag mismatch is 409 and the file is untouched", async () => {
    setup();
    const before = fs.readFileSync(palFile());
    await rejects(
      svc.save(pal.id, "palworld-settings", { etag: "stale", changes: { ExpRate: 3 } }),
      ConflictError,
      "The file changed on disk since you opened it. Reload to see the new version.",
    );
    expect(fs.readFileSync(palFile()).equals(before)).toBe(true);
    expect(history.list(pal.id, "palworld-settings")).toHaveLength(0);
  });
  it("two concurrent saves with the same etag: one wins, one gets 409", async () => {
    setup();
    const v = svc.read(pal.id, "palworld-settings");
    const res = await Promise.allSettled([
      svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { ExpRate: 3 } }),
      svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { ExpRate: 4 } }),
    ]);
    expect(res.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const rej = res.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rej.reason).toBeInstanceOf(ConflictError);
    expect(fs.readFileSync(palFile(), "utf8")).toContain("ExpRate=3,");
  });
  it("save while starting or stopping is 409", async () => {
    setup();
    const v = svc.read(pal.id, "palworld-settings");
    for (const status of ["starting", "stopping"] as const) {
      state = { status, crashPaused: false };
      await rejects(
        svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { ExpRate: 3 } }),
        ConflictError,
        "Server is starting or stopping; save again in a moment",
      );
    }
  });
  it("changing a locked key via changes or via parseable raw is 400 naming the key", async () => {
    setup();
    const v = svc.read(pal.id, "palworld-settings");
    await rejects(svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { RESTAPIEnabled: true } }), BadRequestError, /^RESTAPIEnabled is managed by Skáli: /);
    const raw = v.raw.replace("RESTAPIEnabled=False", "RESTAPIEnabled=True");
    await rejects(svc.save(pal.id, "palworld-settings", { etag: v.etag, raw }), BadRequestError, /^RESTAPIEnabled is managed by Skáli: /);
    // a locked key removed from the text is a change too
    await rejects(svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: v.raw.replace("RESTAPIEnabled=False,", "") }), BadRequestError, /RESTAPIEnabled/);
    // re-casing a switch-like locked value is not a change
    const ok = await svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: v.raw.replace("RESTAPIEnabled=False", "RESTAPIEnabled=false") });
    expect(ok.file.raw).toContain("RESTAPIEnabled=false");
  });
  it("a locked field sent with an unchanged value is skipped", async () => {
    setup();
    const v = svc.read(pal.id, "palworld-settings");
    const r = await svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { RESTAPIEnabled: false, ExpRate: 5 } });
    expect(r.file.raw).toContain("ExpRate=5,");
  });
  it("unparseable raw is saved and reads back with fields:null and parseError; changes then 400", async () => {
    setup();
    const v = svc.read(pal.id, "palworld-settings");
    const r = await svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: "garbage\n" });
    // the fixture is all CRLF, so the LF-only text is saved with CRLF
    expect(r.file).toMatchObject({ raw: "garbage\r\n", fields: null });
    expect(r.file.parseError).toBeTruthy();
    expect(fs.readFileSync(palFile(), "utf8")).toBe("garbage\r\n");
    await rejects(svc.save(pal.id, "palworld-settings", { etag: r.file.etag, changes: { ExpRate: 1 } }), BadRequestError, "This file can only be edited as raw text until it parses");
  });
  it("unknown id and bad values are 400", async () => {
    setup();
    const v = svc.read(pal.id, "palworld-settings");
    await rejects(svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { Nope: 1 } }), BadRequestError, /Unknown setting/);
    await rejects(svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { bIsPvP: "maybe" } }), BadRequestError);
    await rejects(svc.save(pal.id, "palworld-settings", { etag: v.etag }), BadRequestError);
    await rejects(svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: "", changes: {} }), BadRequestError);
  });
  it("the JSON adapter's strictness surfaces as 400", async () => {
    put("o.json", '{"n": 5, "b": true}\n');
    const u = await svc.addSource(pal.id, { path: "o.json" });
    const v = svc.read(pal.id, u.id);
    await rejects(svc.save(pal.id, u.id, { etag: v.etag, changes: { n: "abc" } }), BadRequestError);
  });
  it("switch fields: accepts booleans or 'true'/'false' in any case and keeps the file's casing", async () => {
    setup();
    let v = svc.read(pal.id, "palworld-settings");
    await svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { bIsPvP: true } });
    expect(fs.readFileSync(palFile(), "utf8")).toContain("bIsPvP=True,");
    v = svc.read(pal.id, "palworld-settings");
    expect(v.fields!.find((f) => f.key === "bIsPvP")!.value).toBe(true);
    await svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { bIsPvP: "FALSE" } });
    expect(fs.readFileSync(palFile(), "utf8")).toContain("bIsPvP=False,");
  });
  it("unchanged values are skipped so set() cannot re-encode bytes", async () => {
    const raw = '{\n  "big": 12345678901234567890,\n  "nul": null,\n  "s": "a\\u00e9b",\n  "t": 1\n}\n';
    put("j.json", raw);
    const u = await svc.addSource(pal.id, { path: "j.json" });
    const v = svc.read(pal.id, u.id);
    expect(v.fields!.length).toBeGreaterThan(0);
    const changes: Record<string, string | number | boolean> = {};
    for (const f of v.fields!) changes[f.id] = f.value;
    const r = await svc.save(pal.id, u.id, { etag: v.etag, changes });
    expect(fs.readFileSync(path.join(pal.folder, "j.json"), "utf8")).toBe(raw);
    expect(history.list(pal.id, u.id)).toHaveLength(0);
    expect(r.file.raw).toBe(raw);
  });
  it("numeric equality counts as unchanged", async () => {
    setup();
    const v = svc.read(pal.id, "palworld-settings");
    const before = fs.readFileSync(palFile());
    await svc.save(pal.id, "palworld-settings", { etag: v.etag, changes: { ExpRate: 1 } });
    expect(fs.readFileSync(palFile()).equals(before)).toBe(true);
  });
  it("identical save writes nothing, adds no history, leaves configChangedAt", async () => {
    setup();
    const v = svc.read(pal.id, "palworld-settings");
    const st0 = fs.statSync(palFile()).mtimeMs;
    const r = await svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: v.raw });
    expect(r.file.etag).toBe(v.etag);
    expect(fs.statSync(palFile()).mtimeMs).toBe(st0);
    expect(history.list(pal.id, "palworld-settings")).toHaveLength(0);
    expect(repo.get(pal.id).configChangedAt).toBeNull();
  });
  it("a UTF-16LE file stays UTF-16LE with a BOM after a save", async () => {
    const f = put("w.ini", encodeText("a=1\r\nb=2\r\n", "utf16le"));
    const u = await svc.addSource(pal.id, { path: "w.ini" });
    const v = svc.read(pal.id, u.id);
    expect(v.fields).toHaveLength(2);
    await svc.save(pal.id, u.id, { etag: v.etag, changes: { [v.fields![0]!.id]: "9" } });
    const out = fs.readFileSync(f);
    expect([out[0], out[1]]).toEqual([0xff, 0xfe]);
    expect(out.subarray(2).toString("utf16le")).toBe("a=9\r\nb=2\r\n");
  });
  it("a UTF-8 BOM file keeps its BOM", async () => {
    const f = put("b.ini", encodeText("a=1\n", "utf8bom"));
    const u = await svc.addSource(pal.id, { path: "b.ini" });
    const v = svc.read(pal.id, u.id);
    await svc.save(pal.id, u.id, { etag: v.etag, raw: "a=2\n" });
    expect([...fs.readFileSync(f).subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });
  it("refuses to write through a junction", async () => {
    const target = path.join(root, "elsewhere");
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(target, path.join(pal.folder, "Pal"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return;
      throw e;
    }
    await rejects(svc.save(pal.id, "palworld-settings", { etag: "missing", raw: "x" }), BadRequestError);
    expect(fs.readdirSync(target)).toEqual([]);
  });
});

describe("service: preview", () => {
  it("applies changes in memory and writes nothing; raw returns parsed fields or parseError", () => {
    seed();
    put(PAL_REL, fs.readFileSync(path.join(FIXTURES, "DefaultPalWorldSettings.ini")));
    const before = fs.readFileSync(palFile());
    const v = svc.preview(pal.id, "palworld-settings", { changes: { ExpRate: 7 } });
    expect(v.raw).toContain("ExpRate=7,");
    expect(v.fields!.find((f) => f.key === "ExpRate")!.value).toBe("7");
    expect(fs.readFileSync(palFile()).equals(before)).toBe(true);
    expect(svc.preview(pal.id, "palworld-settings", { raw: "oops" })).toMatchObject({ fields: null, raw: "oops" });
    expect(() => svc.preview(pal.id, "palworld-settings", { changes: { RESTAPIEnabled: true } })).toThrow(BadRequestError);
  });
});

describe("service: addSource", () => {
  it("refuses path escapes and odd forms before touching the filesystem", async () => {
    for (const p of ["../x", "a/../../x", "a\\..\\x", "C:\\x", "C:x", "\\\\host\\x", "\\\\?\\C:\\x", "/x", "\\x", "", ".", "a.ini:stream", "..", "x\0y"]) {
      await rejects(svc.addSource(pal.id, { path: p }), BadRequestError, "Pick a file inside the server folder");
    }
  });
  it("refuses a junction component, a 2 MiB file and a binary file", async () => {
    const target = path.join(root, "outside");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, "o.ini"), "a=1\n");
    let linked = true;
    try {
      fs.symlinkSync(target, path.join(pal.folder, "link"), "junction");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e;
      linked = false;
    }
    if (linked) await rejects(svc.addSource(pal.id, { path: "link\\o.ini" }), BadRequestError);
    put("big.ini", Buffer.alloc(2 * 1024 * 1024, 97));
    await rejects(svc.addSource(pal.id, { path: "big.ini" }), BadRequestError, "File is larger than 1 MB; edit it outside Skáli");
    put("bin.ini", Buffer.from([1, 0, 2]));
    await rejects(svc.addSource(pal.id, { path: "bin.ini" }), BadRequestError, "Not a text file");
    await rejects(svc.addSource(pal.id, { path: "missing.ini" }), BadRequestError);
    fs.mkdirSync(path.join(pal.folder, "d"));
    await rejects(svc.addSource(pal.id, { path: "d" }), BadRequestError);
    expect(sources.list(pal.id)).toHaveLength(0);
  });
  it("defaults, explicit format/label, duplicates and built-in path conflicts", async () => {
    put("conf\\a.json", "{}");
    const a = await svc.addSource(pal.id, { path: "conf/a.json" });
    expect(a).toMatchObject({ path: "conf\\a.json", format: "json", label: "a.json", builtin: false });
    await rejects(svc.addSource(pal.id, { path: "CONF\\a.json" }), ConflictError);
    put(PAL_REL, "x=1\n");
    await rejects(svc.addSource(pal.id, { path: PAL_REL.toLowerCase() }), ConflictError);
    await rejects(svc.addSource(pal.id, { path: "conf/a.json", format: "nope" as never }), BadRequestError);
    put("m.txt", "hi");
    expect(await svc.addSource(pal.id, { path: "m.txt", label: "Mine", format: "ini" })).toMatchObject({ label: "Mine", format: "ini" });
  });
  it("updateSource changes format/label; built-ins refused", async () => {
    put("m.txt", "hi");
    const u = await svc.addSource(pal.id, { path: "m.txt" });
    expect(await svc.updateSource(pal.id, u.id, { label: "L", format: "ini" })).toMatchObject({ label: "L", format: "ini", id: u.id });
    await rejects(svc.updateSource(pal.id, "palworld-settings", { label: "x" }), BadRequestError);
  });
  it("removeSource refuses built-ins; removes a user source and its history", async () => {
    await rejects(svc.removeSource(pal.id, "palworld-settings"), BadRequestError, "Built-in files can't be removed");
    put("m.ini", "a=1\n");
    const u = await svc.addSource(pal.id, { path: "m.ini" });
    const v = svc.read(pal.id, u.id);
    await svc.save(pal.id, u.id, { etag: v.etag, raw: "a=2\n" });
    expect(history.list(pal.id, u.id)).toHaveLength(1);
    await svc.removeSource(pal.id, u.id);
    expect(sources.list(pal.id)).toHaveLength(0);
    expect(history.list(pal.id, u.id)).toHaveLength(0);
    expect(fs.existsSync(path.join(pal.folder, "m.ini"))).toBe(true);
  });
});

describe("service: history and restore", () => {
  it("restore puts back an old version and pushes the current one to history", async () => {
    put("m.ini", "a=1\n");
    const u = await svc.addSource(pal.id, { path: "m.ini" });
    let v = svc.read(pal.id, u.id);
    await svc.save(pal.id, u.id, { etag: v.etag, raw: "a=2\n" });
    const entries = svc.history(pal.id, u.id);
    expect(entries).toHaveLength(1);
    expect(svc.historyRaw(pal.id, u.id, entries[0]!.id)).toEqual({ raw: "a=1\n" });
    v = svc.read(pal.id, u.id);
    const r = await svc.restore(pal.id, u.id, entries[0]!.id, v.etag);
    expect(r.file.raw).toBe("a=1\n");
    expect(fs.readFileSync(path.join(pal.folder, "m.ini"), "utf8")).toBe("a=1\n");
    expect(svc.history(pal.id, u.id)).toHaveLength(2);
    await rejects(svc.restore(pal.id, u.id, entries[0]!.id, "stale"), ConflictError);
    expect(() => svc.historyRaw(pal.id, u.id, "nope.bak")).toThrow(NotFoundError);
  });
  it("historyRaw decodes UTF-16", async () => {
    put("w.ini", encodeText("a=1\n", "utf16le"));
    const u = await svc.addSource(pal.id, { path: "w.ini" });
    const v = svc.read(pal.id, u.id);
    await svc.save(pal.id, u.id, { etag: v.etag, raw: "a=2\n" });
    expect(svc.historyRaw(pal.id, u.id, svc.history(pal.id, u.id)[0]!.id)).toEqual({ raw: "a=1\n" });
  });
});

describe("service: fix round 1", () => {
  const seedAndSave = async () => {
    seed();
    const v = svc.read(pal.id, "palworld-settings");
    await svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: v.raw });
    return svc.read(pal.id, "palworld-settings");
  };
  const withPort = (raw: string, port: number) => raw.replace(/RESTAPIPort=\d+/, `RESTAPIPort=${port}`);

  it("I1: a locked key can't be changed through an unparseable intermediate save", async () => {
    const v = await seedAndSave();
    const broken = v.raw.replace("OptionSettings=(", "OptionSetting=(");
    const b = await svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: broken });
    expect(b.file.fields).toBeNull();
    await rejects(svc.save(pal.id, "palworld-settings", { etag: b.file.etag, raw: withPort(v.raw, 1) }), BadRequestError, /^RESTAPIPort is managed by Skáli: /);
  });
  it("I1: broken then fixed with the original locked values succeeds", async () => {
    const v = await seedAndSave();
    const b = await svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: v.raw.replace("OptionSettings=(", "OptionSetting=(") });
    const ok = await svc.save(pal.id, "palworld-settings", { etag: b.file.etag, raw: v.raw.replace("ExpRate=1.000000", "ExpRate=2.000000") });
    expect(ok.file.fields).not.toBeNull();
  });
  it("I1: with no parseable history, any locked key in the new text is refused", async () => {
    put(PAL_REL, "garbage\n");
    const v = svc.read(pal.id, "palworld-settings");
    seed();
    const seedRaw = fs.readFileSync(path.join(pal.folder, "DefaultPalWorldSettings.ini"), "utf8");
    await rejects(svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: seedRaw }), BadRequestError, /is managed by Skáli/);
  });

  it("I2: an 8.3 short name can't alias a built-in", async () => {
    const mc = mk("mc", "minecraft");
    put("server.properties", "motd=hi\n", mc);
    const short = "SERVER~1.PRO";
    if (!fs.existsSync(path.join(mc.folder, short))) return; // 8.3 names are off on this volume
    await rejects(svc.addSource(mc.id, { path: short }), ConflictError, "That file is already in the list");
    expect(sources.list(mc.id)).toHaveLength(0);
  });
  it("I2: a hard link to a built-in or to an existing user source is refused", async () => {
    const mc = mk("mc", "minecraft");
    put("server.properties", "motd=hi\n", mc);
    fs.linkSync(path.join(mc.folder, "server.properties"), path.join(mc.folder, "alias.properties"));
    await rejects(svc.addSource(mc.id, { path: "alias.properties" }), ConflictError, "That file is already in the list");
    put("mine.ini", "a=1\n", mc);
    await svc.addSource(mc.id, { path: "mine.ini" });
    fs.linkSync(path.join(mc.folder, "mine.ini"), path.join(mc.folder, "mine2.ini"));
    await rejects(svc.addSource(mc.id, { path: "mine2.ini" }), ConflictError, "That file is already in the list");
  });
  it("I2: a user source that later resolves to a built-in file refuses saves", async () => {
    const mc = mk("mc", "minecraft");
    put("server.properties", "motd=hi\n", mc);
    put("a.properties", "x=1\n", mc);
    const u = await svc.addSource(mc.id, { path: "a.properties" });
    fs.rmSync(path.join(mc.folder, "a.properties"));
    fs.linkSync(path.join(mc.folder, "server.properties"), path.join(mc.folder, "a.properties"));
    const v = svc.read(mc.id, u.id);
    await rejects(svc.save(mc.id, u.id, { etag: v.etag, raw: "server-port=1\n" }), ConflictError, "That file is already in the list");
    expect(fs.readFileSync(path.join(mc.folder, "server.properties"), "utf8")).toBe("motd=hi\n");
  });

  it("CRLF: LF-only raw text keeps a CRLF file's line endings; identical-after-conversion writes nothing", async () => {
    const f = put("c.ini", "a=1\r\nb=2\r\n");
    const u = await svc.addSource(pal.id, { path: "c.ini" });
    let v = svc.read(pal.id, u.id);
    await svc.save(pal.id, u.id, { etag: v.etag, raw: "a=1\nb=3\n" });
    expect(fs.readFileSync(f, "utf8")).toBe("a=1\r\nb=3\r\n");
    v = svc.read(pal.id, u.id);
    const st0 = fs.statSync(f).mtimeMs;
    await svc.save(pal.id, u.id, { etag: v.etag, raw: "a=1\nb=3\n" });
    expect(fs.statSync(f).mtimeMs).toBe(st0);
    expect(history.list(pal.id, u.id)).toHaveLength(1);
    // text with its own \r is left alone
    await svc.save(pal.id, u.id, { etag: v.etag, raw: "a=1\r\nb=3\nc=1\n" });
    expect(fs.readFileSync(f, "utf8")).toBe("a=1\r\nb=3\nc=1\n");
  });
  it("CRLF: restore also converts when the file is all CRLF", async () => {
    put("c.ini", "a=1\r\n");
    const u = await svc.addSource(pal.id, { path: "c.ini" });
    let v = svc.read(pal.id, u.id);
    await svc.save(pal.id, u.id, { etag: v.etag, raw: "a=2\nb=2\n" });
    v = svc.read(pal.id, u.id);
    expect(v.raw).toBe("a=2\r\nb=2\r\n");
    const e = svc.history(pal.id, u.id)[0]!.id;
    expect((await svc.restore(pal.id, u.id, e, v.etag)).file.raw).toBe("a=1\r\n");
  });
});

describe("service: duplicate OptionSettings bypass", () => {
  const bad = (raw: string) => [
    raw + "\r\nOptionSettings=(RESTAPIEnabled=False,RESTAPIPort=1)\r\n",
    raw + "\r\n[/Script/Pal.PalGameWorldSettings]\r\nOptionSettings=(RESTAPIPort=1)\r\n",
    raw.replace("RESTAPIPort=8212", "RESTAPIPort=8212,restapiport=1"),
  ];
  it("each variant previews as unparseable (raw-only), and a two-line file makes prepare() fail loudly", async () => {
    seed();
    const v = svc.read(pal.id, "palworld-settings");
    await svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: v.raw });
    const base = svc.read(pal.id, "palworld-settings");
    for (const raw of bad(base.raw)) {
      const p = svc.preview(pal.id, "palworld-settings", { raw });
      expect(p.fields).toBeNull();
      expect(p.parseError).toBeTruthy();
    }
    const r = await svc.save(pal.id, "palworld-settings", { etag: base.etag, raw: bad(base.raw)[0]! });
    expect(r.file.fields).toBeNull();
    await expect(getAdapter("palworld").prepare({ ...pal, secrets: {} } as never)).rejects.toThrow("PalWorldSettings.ini is malformed");
  });
  it("from a two-line file, fixing it with a changed locked port is refused against the history baseline", async () => {
    seed();
    const v = svc.read(pal.id, "palworld-settings");
    await svc.save(pal.id, "palworld-settings", { etag: v.etag, raw: v.raw });
    const base = svc.read(pal.id, "palworld-settings");
    const r = await svc.save(pal.id, "palworld-settings", { etag: base.etag, raw: bad(base.raw)[0]! });
    await rejects(svc.save(pal.id, "palworld-settings", { etag: r.file.etag, raw: base.raw.replace("RESTAPIPort=8212", "RESTAPIPort=1") }), BadRequestError, /^RESTAPIPort is managed by Skáli: /);
  });
  it("a locked key spelled in another case is still caught (properties)", async () => {
    const mc = mk("mc", "minecraft");
    put("server.properties", "rcon.port=25575\nmotd=hi\n", mc);
    const v = svc.read(mc.id, "server-properties");
    await rejects(svc.save(mc.id, "server-properties", { etag: v.etag, raw: "rcon.port=25575\nRCON.PORT=1\nmotd=hi\n" }), BadRequestError, /is managed by Skáli/);
  });
});
