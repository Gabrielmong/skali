import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { download, extractZip, isInsideDir, zipPaths, type FetchFn } from "../../src/tools/download.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skali-dl-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeFetch(chunks: string[], init: ResponseInit = {}): FetchFn {
  return (async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const ch of chunks) c.enqueue(enc.encode(ch));
        c.close();
      },
    });
    return new Response(body, { status: 200, ...init });
  }) as unknown as FetchFn;
}

function buildZip(file: string, entries: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const [name, content] of Object.entries(entries)) z.addBuffer(Buffer.from(content), name);
    z.end();
    z.outputStream.pipe(fs.createWriteStream(file)).on("close", resolve).on("error", reject);
  });
}

describe("download", () => {
  it("writes the body to dest via a temp file and renames it", async () => {
    const dest = path.join(tmp, "out.bin");
    await download("http://x/a", dest, { fetch: fakeFetch(["ab", "cd", "ef"]) });
    expect(fs.readFileSync(dest, "utf8")).toBe("abcdef");
    expect(fs.readdirSync(tmp).filter((f) => f.endsWith(".part"))).toEqual([]);
  });

  it("verifies a matching sha256 and sha1", async () => {
    const dest = path.join(tmp, "ok.bin");
    const sha256 = crypto.createHash("sha256").update("abcdef").digest("hex");
    const sha1 = crypto.createHash("sha1").update("abcdef").digest("hex");
    await download("http://x/a", dest, { fetch: fakeFetch(["abc", "def"]), sha256, sha1 });
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("rejects on hash mismatch and leaves no file", async () => {
    const dest = path.join(tmp, "bad.bin");
    await expect(
      download("http://x/a", dest, { fetch: fakeFetch(["abc"]), sha256: "0".repeat(64) }),
    ).rejects.toThrow(/checksum/i);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(dest + ".part")).toBe(false);
  });

  it("rejects on non-2xx", async () => {
    const dest = path.join(tmp, "nf.bin");
    await expect(
      download("http://x/a", dest, { fetch: fakeFetch(["no"], { status: 404 }) }),
    ).rejects.toThrow(/404/);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(dest + ".part")).toBe(false);
  });

  it("reports progress from content-length", async () => {
    const seen: (number | null)[] = [];
    await download("http://x/a", path.join(tmp, "p.bin"), {
      fetch: fakeFetch(["aaaa", "bbbb", "cc"], { headers: { "content-length": "10" } }),
      onProgress: (p) => seen.push(p),
    });
    expect(seen.length).toBeGreaterThan(0);
    const nums = seen as number[];
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
    expect(nums.at(-1)).toBe(100);
  });

  it("reports null progress without content-length", async () => {
    const seen: (number | null)[] = [];
    await download("http://x/a", path.join(tmp, "q.bin"), {
      fetch: fakeFetch(["aaaa", "bbbb"]),
      onProgress: (p) => seen.push(p),
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p === null)).toBe(true);
  });
});

describe("extractZip", () => {
  it("extracts files and folders", async () => {
    const zip = path.join(tmp, "a.zip");
    await buildZip(zip, { "top.txt": "T", "sub/dir/inner.txt": "I" });
    const out = path.join(tmp, "out");
    await extractZip(zip, out);
    expect(fs.readFileSync(path.join(out, "top.txt"), "utf8")).toBe("T");
    expect(fs.readFileSync(path.join(out, "sub", "dir", "inner.txt"), "utf8")).toBe("I");
  });

  it("refuses an entry outside destDir", async () => {
    // yazl refuses ".." names, so build with an equal-length placeholder and patch the raw bytes.
    // Which layer rejects (yauzl's own filename validation or our guard) is covered by the isInsideDir unit test.
    const zip = path.join(tmp, "evil.zip");
    await buildZip(zip, { "xxxxxxxxxxx": "x" });
    const buf = fs.readFileSync(zip);
    const patched = Buffer.from(buf.toString("latin1").split("xxxxxxxxxxx").join("../evil.txt"), "latin1");
    expect(patched.length).toBe(buf.length);
    fs.writeFileSync(zip, patched);
    const out = path.join(tmp, "out");
    fs.mkdirSync(out);
    await expect(extractZip(zip, out)).rejects.toThrow(/outside|relative path|\.\./i);
    expect(fs.existsSync(path.join(tmp, "evil.txt"))).toBe(false);
  });

  it("isInsideDir rejects escapes", () => {
    const root = path.join(tmp, "root");
    for (const bad of ["../evil.txt", "..\\evil.txt", "C:\\x", "C:/x", "/x", "sub/../../x"]) {
      expect(isInsideDir(root, bad), bad).toBe(false);
    }
    for (const good of ["a.txt", "sub/b.txt", "sub\\c.txt", "sub/../d.txt", "dir/"]) {
      expect(isInsideDir(root, good), good).toBe(true);
    }
  });
});

describe("zipPaths", () => {
  it("zips a folder tree and a single file; extractZip round-trips it", async () => {
    const base = path.join(tmp, "base");
    fs.mkdirSync(path.join(base, "world", "region"), { recursive: true });
    fs.writeFileSync(path.join(base, "world", "level.dat"), "L");
    fs.writeFileSync(path.join(base, "world", "region", "r.mca"), "R");
    fs.writeFileSync(path.join(base, "server.properties"), "P");
    const dest = path.join(tmp, "b.zip");
    const ok = await zipPaths(
      [path.join(base, "world"), path.join(base, "server.properties"), path.join(base, "missing")],
      base,
      dest,
    );
    expect(ok).toBe(true);
    expect(fs.existsSync(dest + ".part")).toBe(false);
    const out = path.join(tmp, "out");
    await extractZip(dest, out);
    expect(fs.readFileSync(path.join(out, "world", "level.dat"), "utf8")).toBe("L");
    expect(fs.readFileSync(path.join(out, "world", "region", "r.mca"), "utf8")).toBe("R");
    expect(fs.readFileSync(path.join(out, "server.properties"), "utf8")).toBe("P");
  });

  it("skips symlinks/junctions", async () => {
    const base = path.join(tmp, "base");
    const outside = path.join(tmp, "outside");
    fs.mkdirSync(path.join(base, "world"), { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "S");
    fs.writeFileSync(path.join(base, "world", "level.dat"), "L");
    try {
      fs.symlinkSync(outside, path.join(base, "world", "link"), "junction");
    } catch (e) {
      console.warn("junction could not be created, skipping assertion:", (e as Error).message);
      return;
    }
    const dest = path.join(tmp, "l.zip");
    expect(await zipPaths([path.join(base, "world")], base, dest)).toBe(true);
    const out = path.join(tmp, "out");
    await extractZip(dest, out);
    expect(fs.existsSync(path.join(out, "world", "level.dat"))).toBe(true);
    expect(fs.existsSync(path.join(out, "world", "link"))).toBe(false);
  });

  it("returns false when no path exists and creates no file", async () => {
    const dest = path.join(tmp, "none.zip");
    expect(await zipPaths([path.join(tmp, "nope")], tmp, dest)).toBe(false);
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(dest + ".part")).toBe(false);
  });

  it("failure removes the partial zip (destination folder missing)", async () => {
    const f = path.join(tmp, "f.txt");
    fs.writeFileSync(f, "x");
    const dest = path.join(tmp, "nodir", "z.zip");
    await expect(zipPaths([f], tmp, dest)).rejects.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
    expect(fs.existsSync(dest + ".part")).toBe(false);
  });
});
