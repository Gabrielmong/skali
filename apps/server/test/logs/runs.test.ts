import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendSkaliLine, createRun, listRuns, pruneRuns } from "../../src/logs/runs.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skali-runs-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const mk = (n: number) => createRun(dir, "srv", new Date(Date.UTC(2026, 0, 1, 0, 0, n)));

describe("runs", () => {
  it("createRun makes dir and empty console.log", () => {
    const r = mk(1);
    expect(r.runId).toBe("2026-01-01T00-00-01-000Z");
    expect(fs.statSync(r.consolePath).size).toBe(0);
    expect(r.runDir).toBe(path.join(dir, "srv", r.runId));
  });

  it("listRuns is newest first with startedAt and size", () => {
    const a = mk(1);
    mk(3);
    mk(2);
    fs.writeFileSync(a.consolePath, "hello");
    fs.mkdirSync(path.join(dir, "srv", "nolog"));
    fs.writeFileSync(path.join(dir, "srv", "stray.txt"), "x");
    const runs = listRuns(dir, "srv");
    expect(runs.map((r) => r.runId)).toEqual([
      "2026-01-01T00-00-03-000Z",
      "2026-01-01T00-00-02-000Z",
      "2026-01-01T00-00-01-000Z",
    ]);
    expect(runs[2]!.sizeBytes).toBe(5);
    expect(runs[2]!.startedAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("listRuns on missing server dir returns []", () => {
    expect(listRuns(dir, "nope")).toEqual([]);
  });

  it("pruneRuns keeps the newest N", () => {
    for (let i = 1; i <= 4; i++) mk(i);
    pruneRuns(dir, "srv", 2);
    expect(listRuns(dir, "srv").map((r) => r.runId)).toEqual([
      "2026-01-01T00-00-04-000Z",
      "2026-01-01T00-00-03-000Z",
    ]);
  });

  it("pruneRuns never deletes the newest", () => {
    for (let i = 1; i <= 3; i++) mk(i);
    pruneRuns(dir, "srv", 0);
    expect(listRuns(dir, "srv")).toHaveLength(1);
    pruneRuns(dir, "missing", 5);
  });

  it("appendSkaliLine interleaves whole lines with another appender", async () => {
    const r = mk(1);
    const other = fs.openSync(r.consolePath, "a");
    const ps: Promise<void>[] = [];
    for (let i = 0; i < 50; i++) {
      ps.push(appendSkaliLine(r.consolePath, `line ${i}`));
      fs.writeSync(other, `game ${i}\r\n`);
    }
    await Promise.all(ps);
    fs.closeSync(other);
    const lines = fs.readFileSync(r.consolePath, "utf8").split("\r\n");
    expect(lines.pop()).toBe("");
    expect(lines).toHaveLength(100);
    for (const l of lines) expect(l).toMatch(/^(\[skali\] line \d+|game \d+)$/);
  });

  it("pruneRuns ignores stray dirs and never deletes real newest", () => {
    for (let i = 1; i <= 3; i++) mk(i);
    const stray = path.join(dir, "srv", "zzz-stray");
    fs.mkdirSync(stray);
    pruneRuns(dir, "srv", 1);
    expect(listRuns(dir, "srv").map((r) => r.runId)).toEqual(["2026-01-01T00-00-03-000Z"]);
    expect(fs.existsSync(stray)).toBe(true);
  });

  it("rejects unsafe serverIds without touching anything", () => {
    mk(1);
    const now = new Date();
    for (const bad of ["", ".", "..", "a/../..", "a\\b","c:x", "a\0b"]) {
      expect(() => createRun(dir, bad, now)).toThrow();
      expect(() => listRuns(dir, bad)).toThrow();
      expect(() => pruneRuns(dir, bad, 1)).toThrow();
    }
    expect(listRuns(dir, "srv")).toHaveLength(1);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
