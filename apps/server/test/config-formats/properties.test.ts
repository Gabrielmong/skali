import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseProperties } from "../../src/config-formats/properties.js";

// Note: fixtures/server.properties was authored for these tests from knowledge of a Minecraft 1.21 file (CRLF, as Java writes on Windows).
const fixture = readFileSync(new URL("../fixtures/server.properties", import.meta.url), "utf8");

const lines = (s: string) => s.split(/\r\n|\n/);
const changedLines = (a: string, b: string) => {
  const x = lines(a), y = lines(b);
  return y.map((l, i) => (l !== x[i] ? i : -1)).filter((i) => i >= 0);
};

describe("parseProperties", () => {
  it("fixture is CRLF", () => expect(fixture).toContain("\r\n"));

  it("round-trips the fixture byte-identically", () => {
    expect(parseProperties(fixture).toString()).toBe(fixture);
  });

  it("reads values, empty values and keys", () => {
    const d = parseProperties(fixture);
    expect(d.get("server-port")).toBe("25565");
    expect(d.get("rcon.password")).toBe("");
    expect(d.get("level-seed")).toBe("");
    expect(d.get("motd")).toBe("A Minecraft Server");
    expect(d.get("level-type")).toBe("minecraft:normal");
    expect(d.get("nope")).toBeUndefined();
    expect(d.keys()).toContain("enable-rcon");
    expect(d.keys()[0]).toBe("accepts-transfers");
    expect(d.keys()).not.toContain("#Minecraft server properties");
  });

  it("set changes exactly one line and keeps CRLF", () => {
    const d = parseProperties(fixture);
    d.set("rcon.password", "x");
    const out = d.toString();
    expect(changedLines(fixture, out)).toHaveLength(1);
    expect(out).toContain("\r\nrcon.password=x\r\n");
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    expect(parseProperties(out).get("rcon.password")).toBe("x");
  });

  it("set of a missing key appends with the file's line ending", () => {
    const d = parseProperties(fixture);
    d.set("new-key", "v");
    expect(d.toString()).toBe(fixture + "new-key=v\r\n");
    expect(d.get("new-key")).toBe("v");
  });

  it("handles LF files and files without trailing newline", () => {
    const lf = "#c\nenable-rcon=false\nrcon.port=1\n";
    const d = parseProperties(lf);
    d.set("enable-rcon", "true");
    d.set("extra", "1");
    expect(d.toString()).toBe("#c\nenable-rcon=true\nrcon.port=1\nextra=1\n");
    const no = parseProperties("a=1\nb=2");
    no.set("c", "3");
    expect(no.toString()).toBe("a=1\nb=2\nc=3");
  });

  it("does not escape : or = in values, but escapes backslashes", () => {
    const d = parseProperties("a=1\n");
    d.set("a", "x:y=z");
    expect(d.toString()).toBe("a=x:y=z\n");
    d.set("a", "c:\\dir");
    expect(d.toString()).toBe("a=c:\\\\dir\n");
    expect(d.get("a")).toBe("c:\\dir");
  });

  it("rejects line breaks in values", () => {
    expect(() => parseProperties("a=1\n").set("a", "x\ny")).toThrow();
  });

  it("treats # and ! lines as comments and accepts : and whitespace separators", () => {
    const d = parseProperties("# a=1\n! b=2\nc:3\nd 4\ne = 5\n   \n");
    expect(d.keys()).toEqual(["c", "d", "e"]);
    expect(d.get("c")).toBe("3");
    expect(d.get("d")).toBe("4");
    expect(d.get("e")).toBe("5");
  });

  it("set on a key in odd format only rewrites that line", () => {
    const src = "# x\nc:3\nd=4\n";
    const d = parseProperties(src);
    d.set("d", "9");
    expect(d.toString()).toBe("# x\nc:3\nd=9\n");
  });

  it("last duplicate wins", () => {
    const d = parseProperties("a=1\na=2\n");
    expect(d.get("a")).toBe("2");
    d.set("a", "3");
    expect(d.toString()).toBe("a=1\na=3\n");
  });

  it("empty input", () => {
    const d = parseProperties("");
    expect(d.keys()).toEqual([]);
    d.set("a", "1");
    expect(d.toString()).toBe("a=1\n");
  });

  it("\t and \f separate key and value", () => {
    for (const src of ["key\tvalue\n", "key\fvalue\n"]) {
      const doc = parseProperties(src);
      expect(doc.get("key")).toBe("value");
      expect(doc.toString()).toBe(src);
    }
  });
});
