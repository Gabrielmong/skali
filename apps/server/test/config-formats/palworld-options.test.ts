import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PalworldIniError, parsePalworldIni, quotePal } from "../../src/config-formats/palworld-options.js";

// Note: fixtures/DefaultPalWorldSettings.ini was authored for these tests from knowledge of the shipped Palworld file (CRLF).
const fixture = readFileSync(new URL("../fixtures/DefaultPalWorldSettings.ini", import.meta.url), "utf8");

describe("parsePalworldIni", () => {
  it("fixture is CRLF", () => expect(fixture).toContain("\r\n"));

  it("round-trips the fixture byte-identically", () => {
    expect(parsePalworldIni(fixture).toString()).toBe(fixture);
  });

  it("lists keys and reads raw tokens", () => {
    const d = parsePalworldIni(fixture);
    const keys = d.keys();
    expect(keys).toEqual(expect.arrayContaining(["Difficulty", "ExpRate", "AdminPassword"]));
    expect(keys[0]).toBe("Difficulty");
    expect(d.get("Difficulty")).toBe("None");
    expect(d.get("ExpRate")).toBe("1.000000");
    expect(d.get("ServerName")).toBe('"Default Palworld Server"');
    expect(d.get("AdminPassword")).toBe('""');
    expect(d.get("BanListURL")).toBe('"https://api.palworldgame.com/api/banlist.txt"');
    expect(d.get("RESTAPIEnabled")).toBe("False");
    expect(d.get("CrossplayPlatforms")).toBe("(Steam,Xbox,PS5,Mac)");
    expect(d.get("DenyTechnologyList")).toBe("");
    expect(d.get("DropItemMaxNum_UNKO")).toBe("100");
    expect(d.get("nope")).toBeUndefined();
  });

  it("set changes only that token", () => {
    const d = parsePalworldIni(fixture);
    d.set("RESTAPIEnabled", "True");
    expect(d.toString()).toBe(fixture.replace("RESTAPIEnabled=False", "RESTAPIEnabled=True"));
    expect(d.get("RESTAPIEnabled")).toBe("True");
    expect(d.get("RESTAPIPort")).toBe("8212");
  });

  it("quoted values with , ( ) and \\\" survive", () => {
    const d = parsePalworldIni(fixture);
    const tok = quotePal('a, "b" (c)');
    expect(tok).toBe('"a, \\"b\\" (c)"');
    d.set("ServerName", tok);
    const again = parsePalworldIni(d.toString());
    expect(again.get("ServerName")).toBe(tok);
    expect(again.get("ServerDescription")).toBe('""');
    expect(again.get("AdminPassword")).toBe('""');
    expect(again.keys()).toEqual(d.keys());
  });

  it("appends a missing key before the closing paren", () => {
    const d = parsePalworldIni(fixture);
    d.set("NewKey", "5");
    const again = parsePalworldIni(d.toString());
    expect(again.get("NewKey")).toBe("5");
    expect(again.get("bAllowEnhanceStat_WorkSpeed")).toBe("True");
    expect(d.toString()).toContain(",NewKey=5)\r\n");
  });

  it("preserves LF files and surrounding content", () => {
    const src = "[Other]\nOptionSettings=(Nope=1)\n[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(A=1,B=\"x,y\")\nTail=1\n";
    const d = parsePalworldIni(src);
    expect(d.get("A")).toBe("1");
    expect(d.get("Nope")).toBeUndefined();
    d.set("A", "2");
    expect(d.toString()).toBe(src.replace("A=1", "A=2"));
  });

  it("throws PalworldIniError when OptionSettings is missing", () => {
    expect(() => parsePalworldIni("")).toThrow(PalworldIniError);
    expect(() => parsePalworldIni("")).toThrow("OptionSettings line not found");
    expect(() => parsePalworldIni("[/Script/Pal.PalGameWorldSettings]\r\n")).toThrow(PalworldIniError);
    expect(() => parsePalworldIni("OptionSettings=(A=1)\n")).toThrow(PalworldIniError);
  });
});
