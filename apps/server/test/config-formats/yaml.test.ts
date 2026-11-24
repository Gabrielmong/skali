import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config-formats/doc.js";
import { ConfigParseError } from "../../src/config-formats/types.js";

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");
const paper = fx("paper-global.yml");

describe("yaml", () => {
  it("fixture round-trips byte-identically", () => {
    expect(parseConfig("yaml", paper).toString()).toBe(paper);
  });

  it("lists scalars with pointer ids, section and key", () => {
    const f = parseConfig("yaml", paper).fields();
    expect(f.find((x) => x.id === "/_version")).toEqual({ id: "/_version", key: "_version", value: 29 });
    expect(f.find((x) => x.id === "/settings/velocity-support/enabled")).toEqual(
      { id: "/settings/velocity-support/enabled", key: "enabled", section: "settings", value: false });
    expect(f.find((x) => x.id === "/settings/motd")!.value).toBe('Welcome to "Skali"');
    expect(f.find((x) => x.id === "/allowed-commands/1")!.value).toBe("tell me");
    expect(f.find((x) => x.id === "/settings/velocity-support/secret")!.value).toBe("");
  });

  it("set a nested number changes only that token; comments on the same line survive", () => {
    const d = parseConfig("yaml", paper);
    d.set("/settings/velocity-support/enabled", true);
    d.set("/settings/region-file-cache-size", 512);
    expect(d.toString()).toBe(
      paper.replace("enabled: false   # keep off", "enabled: true   # keep off").replace("size: 256", "size: 512"));
  });

  it("set a single-quoted string keeps single quotes", () => {
    const d = parseConfig("yaml", paper);
    d.set("/messages/kick/flying-player", "it's off");
    expect(d.toString()).toContain("flying-player: 'it''s off'\n");
    expect(parse(d.toString()).messages.kick["flying-player"]).toBe("it's off");
  });

  it("invalid indentation throws ConfigParseError with a line", () => {
    try {
      parseConfig("yaml", "a:\n  b: 1\n c: 2\n");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigParseError);
      expect((e as ConfigParseError).line).toBe(3);
    }
  });

  it("re-quotes strings that would not re-read as the same string", () => {
    const cases = ["", "true", "123", "null", "~", "a: b", "a #b", " lead", "trail ", "- x", "#c", "&a", "*a", "!t", "@x", "%x", "{a}", "[a]", "it's \"q\" \\", "line\nbreak"];
    for (const s of cases) {
      const d = parseConfig("yaml", "k: old # note\nl: 'x'\n");
      d.set("/k", s);
      const out = d.toString();
      expect(parse(out).k, JSON.stringify(s)).toBe(s);
      expect(out).toContain("# note");
      expect(parse(out).l).toBe("x");
    }
    const d = parseConfig("yaml", "k: old\n");
    d.set("/k", "plain value");
    expect(d.toString()).toBe("k: plain value\n");
    const q = parseConfig("yaml", 'k: "old"\n');
    q.set("/k", 'a "b" \ c');
    expect(parse(q.toString()).k).toBe('a "b" \ c');
    expect(q.toString().startsWith('k: "')).toBe(true);
    const f = parseConfig("yaml", "k: {a: old, b: 1}\n");
    f.set("/k/a", "x, y");
    expect(parse(f.toString()).k.a).toBe("x, y");
  });

  it("preserves CRLF and a missing final newline", () => {
    const src = "a: 1\r\nb:\r\n  c: old # x\r\nd: [1, 2]";
    const d = parseConfig("yaml", src);
    expect(d.toString()).toBe(src);
    d.set("/b/c", "new");
    d.set("/d/1", 3);
    expect(d.toString()).toBe("a: 1\r\nb:\r\n  c: new # x\r\nd: [1, 3]");
  });

  it("unknown id throws Unknown setting; typed leaves validate", () => {
    const d = parseConfig("yaml", "n: 1\nb: true\ns: x\nz: null\n");
    expect(() => d.set("/nope", "x")).toThrow(ConfigParseError);
    expect(() => d.set("/nope", "x")).toThrow("Unknown setting");
    expect(() => d.set("/n", "abc")).toThrow("n must be a number");
    expect(() => d.set("/b", "yes")).toThrow("b must be true or false");
    expect(d.fields().find((x) => x.id === "/z")!.value).toBe("");
    d.set("/z", "hi");
    d.set("/s", 5);
    expect(parse(d.toString())).toEqual({ n: 1, b: true, s: "5", z: "hi" });
  });

  it("rules: quoted/block scalars are strings, aliases skipped, anchors kept, multi-doc and root scalar throw", () => {
    const src = "a: '1'\nb: |\n  text\nc: &x 5\nd: *x\n? [k1, k2]\n: v\n? {m: n}\n: w\ne: ~\n";
    const f = parseConfig("yaml", src).fields();
    expect(f.map((x) => x.id)).toEqual(["/a", "/b", "/c", "/e"]);
    expect(f[0]!.value).toBe("1");
    expect(f[1]!.value).toBe("text\n");
    expect(f[2]!.value).toBe(5);
    expect(f[3]!.value).toBe("");
    expect(parseConfig("yaml", src).toString()).toBe(src);
    expect(() => parseConfig("yaml", "a: 1\n---\nb: 2\n")).toThrow("Multiple YAML documents are not supported");
    expect(parseConfig("yaml", "# c\n---\na: 1\n").fields()).toHaveLength(1);
    expect(() => parseConfig("yaml", "just text")).toThrow("Top-level value must be a mapping or sequence");
    expect(() => parseConfig("yaml", "a: 1\na: 2\n")).toThrow(ConfigParseError);
    const d = parseConfig("yaml", "c: &x 5\n");
    d.set("/c", 6);
    expect(d.toString()).toBe("c: &x 6\n");
    const b = parseConfig("yaml", "b: |\n  text\nz: 1\n");
    b.set("/b", "new");
    expect(parse(b.toString())).toEqual({ b: "new", z: 1 });
  });
});

describe("yaml fix round 1", () => {
  it("C1: empty block scalar does not swallow the next key", () => {
    for (const src of ["a: |\nb: 1\n", "a: |\n\nb: 1\n", "a: | # c\nb: 1\n"]) {
      const d = parseConfig("yaml", src);
      d.set("/a", "n");
      expect(parse(d.toString()), src).toEqual({ a: "n", b: 1 });
    }
  });

  it("C2: repeated sets across style transitions stay valid", () => {
    const d = parseConfig("yaml", "k: |\n  old\nz: 1\n");
    d.set("/k", " x");
    d.set("/k", "ok");
    expect(d.toString()).toBe('k: "ok"\nz: 1\n');
    const p = parseConfig("yaml", "k: old\nz: 1\n");
    for (const v of ["true", "plain", "a: b", "plain2", "line\nbreak", "x"]) {
      p.set("/k", v);
      expect(parse(p.toString())).toEqual({ k: v, z: 1 });
    }
    const b = parseConfig("yaml", "k: |\n  old\nz: 1\n");
    for (const v of ["a\nb", " lead", "a\nb\n", "ok"]) {
      b.set("/k", v);
      expect(parse(b.toString())).toEqual({ k: v, z: 1 });
    }
  });

  it("I1: duplicate ids throw", () => {
    expect(() => parseConfig("yaml", "1: a\n'1': b\n")).toThrow(ConfigParseError);
  });

  it("I2: block writes and fallback use CRLF consistently", () => {
    const d = parseConfig("yaml", "a: |\r\n  old\r\nz: 1\r\n");
    d.set("/a", "x\ny");
    expect(d.toString()).toBe("a: |-\r\n  x\r\n  y\r\nz: 1\r\n");
    const e = parseConfig("yaml", "a: |\r\n  old\r\nz: 1\r\n");
    e.set("/a", " x");
    expect(e.toString()).toBe('a: " x"\r\nz: 1\r\n');
  });

  it("M1: same-line comment on a block scalar survives the fallback", () => {
    const d = parseConfig("yaml", "a: | # hi\n  old\nz: 1\n");
    d.set("/a", " x");
    expect(d.toString()).toBe('a: " x" # hi\nz: 1\n');
    const w = parseConfig("yaml", "a: | # hi\n  old\nz: 1\n");
    w.set("/a", "n");
    expect(w.toString()).toBe("a: |- # hi\n  n\nz: 1\n");
  });
});
