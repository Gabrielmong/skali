import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config-formats/doc.js";
import { ConfigParseError } from "../../src/config-formats/types.js";

const fx = (n: string) => readFileSync(new URL(`../fixtures/${n}`, import.meta.url), "utf8");
const ops = fx("ops.json");
const odd = fx("odd.json");

describe("json", () => {
  it("fixtures round-trip byte-identically", () => {
    for (const n of ["ops.json", "whitelist.json", "odd.json"]) {
      expect(parseConfig("json", fx(n)).toString()).toBe(fx(n));
    }
    expect(odd).toContain("\t");
  });

  it("lists leaves with pointer ids, section and key", () => {
    const f = parseConfig("json", ops).fields();
    expect(f).toHaveLength(8);
    expect(f[0]).toEqual({ id: "/0/uuid", key: "uuid", section: "0", value: "069a79f4-44e9-4726-a5be-fca90e38aaf5" });
    expect(f[3]!.value).toBe(false);
    const o = parseConfig("json", odd).fields();
    expect(o.map((x) => x.id)).toEqual([
      "/name", "/limits/max", "/limits/ratio", "/limits/enabled", "/tags/0", "/tags/1", "/tags/2", "/motd", "/a~1b~0c",
    ]);
    expect(o[0]!.value).toBe('café "quoted" \u{1F600}');
    expect(o[2]!.value).toBe(150);
    expect(o[7]!.value).toBe("");
    expect(o[8]!.key).toBe("a/b~c");
  });

  it("set /0/level to 3 changes only that number token", () => {
    const d = parseConfig("json", ops);
    d.set("/0/level", 3);
    expect(d.toString()).toBe(ops.replace('"level": 4', '"level": 3'));
    d.set("/0/level", "7");
    expect(d.toString()).toBe(ops.replace('"level": 4', '"level": 7'));
    d.set("/1/bypassesPlayerLimit", false);
    expect(d.toString()).toContain('"bypassesPlayerLimit": false\n  }\n]');
    expect(d.fields().find((f) => f.id === "/0/level")!.value).toBe(7);
  });

  it("a string with quotes and unicode is escaped validly and re-parses to the same value", () => {
    const d = parseConfig("json", odd);
    const v = 'He said "hi" \\ \n\t \u00e9 \u{1F600}';
    d.set("/name", v);
    d.set("/motd", "now set");
    d.set("/tags/0", "x");
    const out = d.toString();
    expect(JSON.parse(out).name).toBe(v);
    expect(JSON.parse(out).motd).toBe("now set");
    expect(parseConfig("json", out).fields()[0]!.value).toBe(v);
    expect(out).toContain("\t\"limits\": {");
  });

  it("a number field rejects \"abc\" and a bool field rejects non-booleans; unknown id throws", () => {
    const d = parseConfig("json", ops);
    expect(() => d.set("/0/level", "abc")).toThrow(new ConfigParseError("level must be a number"));
    expect(() => d.set("/0/level", true)).toThrow(/level must be a number/);
    expect(() => d.set("/0/bypassesPlayerLimit", "yes")).toThrow(ConfigParseError);
    expect(() => d.set("/nope", 1)).toThrow("Unknown setting");
    expect(d.toString()).toBe(ops);
  });

  it("invalid JSON throws ConfigParseError with a line number", () => {
    let e: unknown;
    try { parseConfig("json", '{\n  "a": 1,\n  "b": ,\n}'); } catch (x) { e = x; }
    expect(e).toBeInstanceOf(ConfigParseError);
    expect((e as ConfigParseError).line).toBe(3);
    for (const bad of ['{"a": 1} // c', '{"a": 1} x', "", '{"a": 01}', '{"a": "x', '[1,]', '{"a":1,}', '"\\q"']) {
      expect(() => parseConfig("json", bad), bad).toThrow(ConfigParseError);
    }
  });

  it("CRLF input without a final newline round-trips and set edits only the token", () => {
    const t = '{\r\n  "a": 1,\r\n  "b": "x"\r\n}';
    const d = parseConfig("json", t);
    expect(d.toString()).toBe(t);
    d.set("/b", "yz");
    expect(d.toString()).toBe('{\r\n  "a": 1,\r\n  "b": "yz"\r\n}');
  });

  it("odd.json edits produce the exact expected output", () => {
    const d = parseConfig("json", odd);
    d.set("/name", 'a"b');
    d.set("/limits/max", 5);
    d.set("/motd", "hi");
    expect(d.toString()).toBe(
      odd.replace('"caf\\u00e9 \\"quoted\\" \\ud83d\\ude00"', '"a\\"b"')
        .replace('"max": 20', '"max": 5')
        .replace('"motd": null', '"motd": "hi"'),
    );
    expect(d.toString()).toContain('\t"name": "a\\"b",\n\t"limits"');
  });

  it("a root scalar document is rejected", () => {
    for (const bad of ['"abc"', "5", "true", "null", " 7\n"]) {
      expect(() => parseConfig("json", bad), bad).toThrow(/^Top-level value must be an object or array$/);
    }
  });
});
