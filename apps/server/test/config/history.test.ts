import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigHistory } from "../../src/config/history.js";
import { NotFoundError } from "../../src/errors.js";

let root: string, h: ConfigHistory;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "skali-hist-"));
  h = new ConfigHistory(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("ConfigHistory", () => {
  it("push 22 versions keeps 20, newest first; read returns the bytes", () => {
    for (let i = 0; i < 22; i++) h.push("srv", "launch", Buffer.from(`v${i}`));
    const list = h.list("srv", "launch");
    expect(list).toHaveLength(20);
    expect(new Set(list.map((e) => e.id)).size).toBe(20);
    for (const e of list) expect(e.id).toMatch(/^[0-9TZ.-]+\.bak$/);
    expect(h.read("srv", "launch", list[0].id).toString()).toBe("v21");
    expect(h.read("srv", "launch", list[19].id).toString()).toBe("v2");
    expect(list[0]).toMatchObject({ sizeBytes: 3 });
    expect(Number.isNaN(Date.parse(list[0].savedAt))).toBe(false);
    expect(list.map((e) => e.id)).toEqual([...list.map((e) => e.id)].sort().reverse());
  });
  it("list of nothing is empty", () => {
    expect(h.list("srv", "nope")).toEqual([]);
  });
  it("rejects bad entry ids", () => {
    h.push("srv", "launch", Buffer.from("x"));
    expect(() => h.read("srv", "launch", "../x")).toThrow(NotFoundError);
    expect(() => h.read("srv", "launch", "..\\x.bak")).toThrow(NotFoundError);
    expect(() => h.read("srv", "launch", "2020-01-01T00-00-00.000Z.bak")).toThrow(NotFoundError);
  });
  it("rejects ids that could escape the root", () => {
    expect(() => h.push("..", "launch", Buffer.from("x"))).toThrow(NotFoundError);
    expect(() => h.push("srv", "../x", Buffer.from("x"))).toThrow(NotFoundError);
    expect(() => h.list("a/b", "x")).toThrow(NotFoundError);
    expect(() => h.removeServer("..")).toThrow(NotFoundError);
    expect(() => h.removeSource("srv", "..")).toThrow(NotFoundError);
  });
  it("removeServer and removeSource delete folders; missing is a no-op", () => {
    h.push("srv", "a", Buffer.from("1"));
    h.push("srv", "b", Buffer.from("2"));
    h.removeSource("srv", "a");
    expect(h.list("srv", "a")).toEqual([]);
    expect(h.list("srv", "b")).toHaveLength(1);
    h.removeServer("srv");
    expect(fs.existsSync(path.join(root, "srv"))).toBe(false);
    h.removeServer("srv");
    h.removeSource("srv", "a");
  });
});
