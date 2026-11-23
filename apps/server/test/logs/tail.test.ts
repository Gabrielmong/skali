import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileTailer, readTail } from "../../src/logs/tail.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "skali-tail-"));
  file = path.join(dir, "console.log");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function collect(t: FileTailer): string[][] {
  const got: string[][] = [];
  t.on("lines", (l: string[]) => got.push(l));
  return got;
}

describe("FileTailer", () => {
  it("emits complete lines, buffers partial, completes later", async () => {
    fs.writeFileSync(file, "");
    const t = new FileTailer(file, { fromStart: true, pollMs: 10 });
    const got = collect(t);
    t.start();
    fs.appendFileSync(file, "a\r\nb\r\nc");
    await waitFor(() => got.length >= 1);
    expect(got[0]).toEqual(["a", "b"]);
    fs.appendFileSync(file, "\r\n");
    await waitFor(() => got.length >= 2);
    expect(got[1]).toEqual(["c"]);
    t.stop();
    t.stop();
  });

  it("keeps a split emoji intact", async () => {
    fs.writeFileSync(file, "");
    const t = new FileTailer(file, { fromStart: true, pollMs: 10 });
    const got = collect(t);
    t.start();
    const b = Buffer.from("\u{1F600}\r\n", "utf8");
    fs.appendFileSync(file, b.subarray(0, 2));
    await new Promise((r) => setTimeout(r, 50));
    fs.appendFileSync(file, b.subarray(2));
    await waitFor(() => got.length >= 1);
    expect(got.flat()).toEqual(["\u{1F600}"]);
    t.stop();
  });

  it("fromStart:false skips existing content", async () => {
    fs.writeFileSync(file, "old\r\n");
    const t = new FileTailer(file, { fromStart: false, pollMs: 10 });
    const got = collect(t);
    t.start();
    await new Promise((r) => setTimeout(r, 50));
    fs.appendFileSync(file, "new\r\n");
    await waitFor(() => got.length >= 1);
    expect(got.flat()).toEqual(["new"]);
    t.stop();
  });

  it("restarts from 0 after truncation", async () => {
    fs.writeFileSync(file, "aaaa\r\nbbbb\r\n");
    const t = new FileTailer(file, { fromStart: true, pollMs: 10 });
    const got = collect(t);
    t.start();
    await waitFor(() => got.length >= 1);
    fs.writeFileSync(file, "c\r\n");
    await waitFor(() => got.length >= 2);
    expect(got[1]).toEqual(["c"]);
    t.stop();
  });

  it("waits for the file to appear", async () => {
    const t = new FileTailer(file, { fromStart: true, pollMs: 10 });
    const got = collect(t);
    t.start();
    await new Promise((r) => setTimeout(r, 40));
    fs.writeFileSync(file, "x\r\n");
    await waitFor(() => got.length >= 1);
    expect(got.flat()).toEqual(["x"]);
    t.stop();
  });
});

describe("FileTailer listener errors", () => {
  it("does not swallow listener exceptions", async () => {
    fs.writeFileSync(file, "a\r\n");
    const t = new FileTailer(file, { fromStart: true, pollMs: 10 });
    t.on("lines", () => {
      throw new Error("boom");
    });
    const errs: unknown[] = [];
    t.on("error", (e) => errs.push(e));
    const rej = new Promise<unknown>((res) => process.once("unhandledRejection", res));
    t.start();
    const r = await rej;
    t.stop();
    expect((r as Error).message).toBe("boom");
    expect(errs).toEqual([]);
  });
});

describe("readTail", () => {
  it("caps bytes read for a file with no newlines", async () => {
    fs.writeFileSync(file, "x".repeat(20 * 1024 * 1024));
    const out = await readTail(file, 10);
    expect(out).toHaveLength(1);
    expect(out[0]!.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it("returns [] for a missing file", async () => {
    expect(await readTail(file)).toEqual([]);
  });

  it("handles CRLF endings, no trailing newline, and partial final line", async () => {
    fs.writeFileSync(file, "a\r\nb\r\n");
    expect(await readTail(file)).toEqual(["a", "b"]);
    fs.writeFileSync(file, "a\r\nb\r\nc");
    expect(await readTail(file)).toEqual(["a", "b", "c"]);
    expect(await readTail(file, 2)).toEqual(["b", "c"]);
  });

  it("decodes multibyte text across chunk boundaries", async () => {
    const line = "é".repeat(100);
    fs.writeFileSync(file, Array.from({ length: 2000 }, () => line).join("\r\n") + "\r\n");
    const out = await readTail(file, 1500);
    expect(out).toHaveLength(1500);
    expect(out.every((l) => l === line)).toBe(true);
  });

  it("reads the last 500 lines of a 50 MB file reading < 1 MB", async () => {
    const lineFor = (i: number) => `line ${String(i).padStart(8, "0")} ${"x".repeat(40)}\r\n`;
    const lineLen = lineFor(0).length;
    const total = Math.ceil((50 * 1024 * 1024) / lineLen);
    const fd = fs.openSync(file, "w");
    const batch = 20000;
    for (let i = 0; i < total; i += batch) {
      let s = "";
      for (let j = i; j < Math.min(total, i + batch); j++) s += lineFor(j);
      fs.writeSync(fd, s);
    }
    fs.closeSync(fd);
    expect(fs.statSync(file).size).toBeGreaterThan(50 * 1024 * 1024);

    let bytes = 0;
    const orig = fs.read;
    vi.spyOn(fs, "read").mockImplementation(((...args: unknown[]) => {
      const cb = args[args.length - 1] as (e: Error | null, n: number, b: Buffer) => void;
      args[args.length - 1] = (e: Error | null, n: number, b: Buffer) => {
        bytes += n ?? 0;
        cb(e, n, b);
      };
      return (orig as (...a: unknown[]) => void)(...args);
    }) as unknown as typeof fs.read);

    const out = await readTail(file, 500);
    expect(out).toHaveLength(500);
    expect(out[499]).toBe(lineFor(total - 1).trimEnd());
    expect(out[0]).toBe(lineFor(total - 500).trimEnd());
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(1024 * 1024);
  });
});
