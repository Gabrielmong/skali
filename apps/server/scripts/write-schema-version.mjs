// Writes <distDir>/schema-version.json from the compiled db.js's SCHEMA_VERSION. Run after tsc.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const distDir = path.resolve(process.argv[2] ?? "dist");
const { SCHEMA_VERSION } = await import(pathToFileURL(path.join(distDir, "db.js")).href);
if (!Number.isInteger(SCHEMA_VERSION) || SCHEMA_VERSION < 1) {
  console.error(`write-schema-version: bad SCHEMA_VERSION ${String(SCHEMA_VERSION)}`);
  process.exit(1);
}
fs.writeFileSync(path.join(distDir, "schema-version.json"), `${JSON.stringify({ schemaVersion: SCHEMA_VERSION })}\n`);
