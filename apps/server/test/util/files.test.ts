import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BadRequestError } from "../../src/errors.js";
import { writeEula } from "../../src/servers/adopt.js";
import { assertNoReparsePoints, writeIfChanged } from "../../src/util/files.js";

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "skali-files-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("reparse-point guard", () => {
  it("allows plain and not-yet-existing paths", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "a"));
    expect(() => assertNoReparsePoints(root, path.join(root, "a", "b", "c.ini"))).not.toThrow();
    expect(writeIfChanged(path.join(root, "a", "b", "c.ini"), "x", root)).toBe(true);
  });
  it("refuses a junction directory between the root and the target, and writes nothing through it", () => {
    const root = tmp();
    const outside = tmp();
    fs.mkdirSync(path.join(root, "Pal"));
    fs.symlinkSync(outside, path.join(root, "Pal", "Config"), "junction");
    const file = path.join(root, "Pal", "Config", "PalWorldSettings.ini");
    expect(() => writeIfChanged(file, "x", root)).toThrow(BadRequestError);
    expect(fs.readdirSync(outside)).toEqual([]);
  });
  it("refuses a target file that is itself a link", () => {
    const root = tmp();
    const outside = tmp();
    const victim = path.join(outside, "victim.txt");
    fs.writeFileSync(victim, "keep");
    try {
      fs.symlinkSync(victim, path.join(root, "eula.txt"), "file");
    } catch {
      return; // file symlinks need a privilege on some setups
    }
    expect(() => writeEula(root)).toThrow(BadRequestError);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep");
  });
  it("writeEula refuses when the folder's eula.txt path is a junction", () => {
    const root = tmp();
    const outside = tmp();
    fs.symlinkSync(outside, path.join(root, "eula.txt"), "junction");
    expect(() => writeEula(root)).toThrow(BadRequestError);
  });
  it("refuses a target outside the root", () => {
    const root = tmp();
    expect(() => assertNoReparsePoints(root, path.join(root, "..", "x.txt"))).toThrow(BadRequestError);
  });
});
