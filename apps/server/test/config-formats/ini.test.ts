import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config-formats/doc.js";
import { decodeText, encodeText } from "../../src/config-formats/text-codec.js";

const engine = readFileSync(new URL("../fixtures/Engine.ini", import.meta.url), "utf8");
const generic = readFileSync(new URL("../fixtures/generic.ini", import.meta.url), "utf8");
const Z = "\u0000";
const lines = (s: string) => s.split(/\r\n|\n/);
const changed = (a: string, b: string) => { const x = lines(a); return lines(b).map((l, i) => (l !== x[i] ? i : -1)).filter((i) => i >= 0); };

describe("ini", () => {
  it("both fixtures round-trip byte-identically", () => {
    expect(engine).toContain("\r\n");
    expect(parseConfig("ini", engine).toString()).toBe(engine);
    expect(parseConfig("ini", generic).toString()).toBe(generic);
  });

  it("set changes only the value token and keeps a trailing comment", () => {
    const d = parseConfig("ini", generic);
    d.set(`network${Z}port`, 9000);
    d.set(`network${Z}host`, "1.2.3.4");
    const out = d.toString();
    expect(out).toContain("port = 9000\n");
    expect(out).toContain("host = 1.2.3.4   \n");
    expect(changed(generic, out)).toHaveLength(2);
    const t = parseConfig("ini", "key = value ; trailing\n");
    expect(t.fields()[0]!.value).toBe("value");
    t.set(`${Z}key`, "x");
    expect(t.toString()).toBe("key = x ; trailing\n");
  });

  it("comment markers: no preceding whitespace stays in the value; tab-# and empty value with comment", () => {
    const d = parseConfig("ini", "a=b;c\nk=v\t# c\nkey = ; note\n+Paths=../Game;x\n");
    expect(d.fields().map((f) => f.value)).toEqual(["b;c", "v", "", "../Game;x"]);
    d.set(`${Z}a`, "z");
    d.set(`${Z}k`, "w");
    d.set(`${Z}key`, "n");
    expect(d.toString()).toBe("a=z\nk=w\t# c\nkey = n ; note\n+Paths=../Game;x\n");
    expect(d.fields()[2]!.value).toBe("n");
  });

  it("a section header with a trailing comment is still a header", () => {
    const d = parseConfig("ini", "[Sec] ; note\nk=1\n  [Other]# x\nj=2\n");
    expect(d.fields().map((f) => [f.section, f.key])).toEqual([["Sec", "k"], ["Other", "j"]]);
  });

  it("repeated +Paths entries are separate fields with distinct ids; setting the 2nd changes only line 2 of them", () => {
    const d = parseConfig("ini", engine);
    const paths = d.fields().filter((f) => f.key === "+Paths");
    expect(paths.map((f) => f.id)).toEqual([`Core.System${Z}+Paths`, `Core.System${Z}+Paths${Z}2`, `Core.System${Z}+Paths${Z}3`]);
    d.set(paths[1]!.id, "../Other");
    const out = d.toString();
    expect(changed(engine, out)).toEqual([3]);
    expect(lines(out)[3]).toBe("+Paths=../Other");
  });

  it("keys before the first section are fields with section undefined", () => {
    const f = parseConfig("ini", generic).fields();
    expect(f[0]).toEqual({ id: `${Z}name`, key: "name", value: "My Server" });
    expect(f[0]!.section).toBeUndefined();
    expect(f.find((x) => x.key === "port")!.section).toBe("network");
  });

  it("CRLF is preserved after a set", () => {
    const d = parseConfig("ini", engine);
    d.set(`/Script/Engine.GameSession${Z}MaxPlayers`, 32);
    d.set(`/Script/Engine.GameSession${Z}bEnableCrossplay`, false);
    const out = d.toString();
    expect(out).toContain("MaxPlayers=32\r\n");
    expect(out).toContain("bEnableCrossplay=False\r\n");
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("booleans follow the old token's casing; line breaks and unknown ids throw; messy lines are kept", () => {
    const d = parseConfig("ini", generic);
    d.set(`network${Z}verbose`, false);
    expect(d.toString()).toContain("verbose = false\n");
    expect(() => d.set(`${Z}name`, "a\nb")).toThrow();
    expect(() => d.set("nope", 1)).toThrow();
    expect(d.toString()).toContain("this line has no equals\n");
  });

  it("a UTF-16LE Engine.ini decoded via decodeText, edited, and re-encoded keeps its BOM and encoding", () => {
    const buf = encodeText(engine, "utf16le");
    const { text, encoding } = decodeText(buf);
    expect(encoding).toBe("utf16le");
    const d = parseConfig("ini", text);
    d.set(`/Script/Engine.GameSession${Z}MaxPlayers`, 8);
    const out = encodeText(d.toString(), encoding);
    expect(out[0]).toBe(0xff);
    expect(out[1]).toBe(0xfe);
    expect(decodeText(out).text).toBe(engine.replace("MaxPlayers=16", "MaxPlayers=8"));
  });
});
