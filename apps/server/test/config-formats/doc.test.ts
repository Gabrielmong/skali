import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ConfigParseError, detectFormat, parseConfig } from "../../src/config-formats/doc.js";

const props = readFileSync(new URL("../fixtures/server.properties", import.meta.url), "utf8");
const pal = readFileSync(new URL("../fixtures/DefaultPalWorldSettings.ini", import.meta.url), "utf8");

const idOf = (d: ReturnType<typeof parseConfig>, key: string) => d.fields().find((f) => f.key === key)!.id;

describe("parseConfig", () => {
  it("properties and palworld fixtures round-trip byte-identically", () => {
    expect(parseConfig("properties", props).toString()).toBe(props);
    expect(parseConfig("palworld", pal).toString()).toBe(pal);
  });

  it("raw has no fields and returns the text unchanged", () => {
    const d = parseConfig("raw", "anything\r\n");
    expect(d.fields()).toEqual([]);
    expect(d.toString()).toBe("anything\r\n");
    expect(() => d.set("x", "y")).toThrow(ConfigParseError);
  });

  it("palworld set keeps quoting and bool case", () => {
    const d = parseConfig("palworld", pal);
    const name = idOf(d, "ServerName");
    d.set(name, 'a, "b"');
    const re = parseConfig("palworld", d.toString());
    expect(re.fields().find((f) => f.id === name)!.value).toBe('a, "b"');
    const pvp = idOf(d, "bIsPvP");
    d.set(pvp, true);
    expect(d.toString()).toMatch(/bIsPvP=True/);
    d.set(pvp, false);
    expect(d.toString()).toMatch(/bIsPvP=False/);
  });

  it("palworld decodes quoted values and keeps unquoted tokens", () => {
    const d = parseConfig("palworld", pal);
    const f = Object.fromEntries(d.fields().map((x) => [x.key, x.value]));
    expect(f.Difficulty).toBe("None");
    expect(f.ServerName).not.toMatch(/^"/);
  });

  it("palworld parse errors become ConfigParseError", () => {
    expect(() => parseConfig("palworld", "nothing here")).toThrow(ConfigParseError);
  });

  it("properties set writes strings and numbers; ids are stable across re-parse", () => {
    const d = parseConfig("properties", props);
    const id = idOf(d, "max-players");
    d.set(id, 12);
    const re = parseConfig("properties", d.toString());
    expect(re.fields().find((f) => f.id === id)!.value).toBe("12");
  });

  it("properties boolean keeps True/False case only for exact old tokens", () => {
    const d = parseConfig("properties", "a=Foo\nb=True\n");
    d.set("a", true);
    d.set("b", false);
    expect(d.toString()).toBe("a=true\nb=False\n");
  });

  it("palworld string over a bare token is quoted only when needed", () => {
    const d = parseConfig("palworld", pal);
    const before = Object.fromEntries(d.fields().map((x) => [x.key, x.value]));
    d.set("Difficulty", "a, b (c)");
    const re = parseConfig("palworld", d.toString());
    const after = Object.fromEntries(re.fields().map((x) => [x.key, x.value]));
    expect(after.Difficulty).toBe("a, b (c)");
    expect({ ...after, Difficulty: 0 }).toEqual({ ...before, Difficulty: 0 });
    const d2 = parseConfig("palworld", pal);
    d2.set("Difficulty", "Normal");
    expect(d2.toString()).toMatch(/Difficulty=Normal[,)]/);
  });

  it("unknown field id throws ConfigParseError", () => {
    expect(() => parseConfig("properties", props).set("nope", "x")).toThrow(ConfigParseError);
    expect(() => parseConfig("palworld", pal).set("nope", "x")).toThrow("Unknown setting");
  });
});

describe("detectFormat", () => {
  it("maps extensions case-insensitively", () => {
    expect(detectFormat("a/b.ini")).toBe("ini");
    expect(detectFormat("server.properties")).toBe("properties");
    expect(detectFormat("x.JSON")).toBe("json");
    expect(detectFormat("x.yml")).toBe("yaml");
    expect(detectFormat("x.YAML")).toBe("yaml");
    expect(detectFormat("Foo.CFG")).toBe("raw");
    expect(detectFormat("noext")).toBe("raw");
  });
});
