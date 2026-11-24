import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../src/db.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-sv-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("write-schema-version script", () => {
  it("writes the SCHEMA_VERSION a dist/db.js exports", () => {
    fs.writeFileSync(path.join(root, "db.js"), `export const SCHEMA_VERSION = ${SCHEMA_VERSION};\n`);
    const script = path.resolve(__dirname, "../scripts/write-schema-version.mjs");
    const r = spawnSync(process.execPath, [script, root], { encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, "schema-version.json"), "utf8"))).toEqual({ schemaVersion: SCHEMA_VERSION });
  });
  it("fails when SCHEMA_VERSION is not a positive integer", () => {
    fs.writeFileSync(path.join(root, "db.js"), `export const SCHEMA_VERSION = "x";\n`);
    const script = path.resolve(__dirname, "../scripts/write-schema-version.mjs");
    expect(spawnSync(process.execPath, [script, root]).status).not.toBe(0);
  });
});
