import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, loadOrCreateKey } from "../src/secrets.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "skali-sec-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe("secrets", () => {
  it("round-trips and rejects a wrong key", () => {
    const key = loadOrCreateKey(join(dir, "k.key"));
    const blob = encryptSecret("hunter2", key);
    expect(blob).not.toContain("hunter2");
    expect(decryptSecret(blob, key)).toBe("hunter2");
    expect(() => decryptSecret(blob, Buffer.alloc(32, 1))).toThrow();
  });
  it("throws on a wrong-length key file", () => {
    const p = join(dir, "bad.key");
    writeFileSync(p, Buffer.alloc(16));
    expect(() => loadOrCreateKey(p)).toThrow(/expected 32 bytes/);
  });
  it("creates a 32-byte key (with parent dir) and reuses it", () => {
    const p = join(dir, "sub", "dir", "secret.key");
    const a = loadOrCreateKey(p);
    expect(a.length).toBe(32);
    expect(readFileSync(p).length).toBe(32);
    expect(loadOrCreateKey(p).equals(a)).toBe(true);
  });
});
