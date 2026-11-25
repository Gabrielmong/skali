import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertAllowedFolder, assertNewOrEmpty, type ProtectedPaths } from "../../src/servers/folders.js";

const prot: ProtectedPaths = {
  systemRoot: "C:\\Windows",
  programFiles: ["C:\\Program Files", "C:\\Program Files (x86)"],
  programData: "C:\\ProgramData",
  dataDir: "C:\\ProgramData\\Skali",
  installDir: null,
};
const users = "C:\\Users";

describe("assertAllowedFolder", () => {
  for (const f of ["C:\\", "C:\\Windows\\x", "C:\\ProgramData", "C:\\ProgramData\\Skali", "C:\\ProgramData\\Skali\\tools", "C:\\Users\\bob", "C:\\Users"]) {
    it(`rejects ${f}`, () => {
      expect(() => assertAllowedFolder(f, users, prot, "used")).toThrow(/can't be used/);
    });
  }
  it("uses the verb", () => {
    expect(() => assertAllowedFolder("C:\\", users, prot, "adopted")).toThrow(/can't be adopted/);
  });
  it("accepts a normal game folder (need not exist) and returns the resolved path", () => {
    expect(assertAllowedFolder("D:\\GameServers\\Valheim", users, prot, "used")).toBe(path.resolve("D:\\GameServers\\Valheim"));
  });
  it("rejects relative paths", () => {
    expect(() => assertAllowedFolder("games\\x", users, prot, "used")).toThrow(/absolute/);
  });
});

describe("assertNewOrEmpty", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skali-folders-"));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));
  it("passes for a missing path and an empty folder", () => {
    expect(() => assertNewOrEmpty(path.join(tmp, "nope"))).not.toThrow();
    expect(() => assertNewOrEmpty(tmp)).not.toThrow();
  });
  it("rejects a folder with a file", () => {
    fs.writeFileSync(path.join(tmp, "a.txt"), "x");
    expect(() => assertNewOrEmpty(tmp)).toThrow("The install folder must be new or empty");
  });
});
