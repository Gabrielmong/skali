import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import yazl from "yazl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JavaTools } from "../../src/tools/java.js";
import type { FetchFn } from "../../src/tools/download.js";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skali-java-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function zipBuffer(entries: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const z = new yazl.ZipFile();
    for (const [n, c] of Object.entries(entries)) z.addBuffer(Buffer.from(c), n);
    z.end();
    const chunks: Buffer[] = [];
    z.outputStream.on("data", (c: Buffer) => chunks.push(c));
    z.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    z.outputStream.on("error", reject);
  });
}

/** Fetch fake shaped like the real Adoptium assets response (array of assets; binary.package.{link,checksum}). */
async function fakeFetch(opts: { checksum?: string } = {}) {
  const zip = await zipBuffer({
    "jdk-21.0.5+11-jre/bin/java.exe": "JAVA",
    "jdk-21.0.5+11-jre/release": "x",
  });
  const sha = crypto.createHash("sha256").update(zip).digest("hex");
  const urls: string[] = [];
  const f = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://api.adoptium.net/v3/assets/latest/21/hotspot")) {
      return new Response(
        JSON.stringify([
          {
            binary: {
              os: "windows",
              image_type: "jre",
              package: { link: "https://example.test/jre21.zip", checksum: opts.checksum ?? sha, name: "jre21.zip" },
            },
            version: { major: 21 },
          },
        ]),
        { status: 200 },
      );
    }
    if (url === "https://example.test/jre21.zip") return new Response(new Uint8Array(zip), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as unknown as FetchFn;
  return { f, urls };
}

describe("JavaTools", () => {
  it("refuses a non-HTTPS package link from the Adoptium JSON and never downloads it", async () => {
    const urls: string[] = [];
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith("https://api.adoptium.net/")) {
        return new Response(JSON.stringify([{ binary: { package: { link: "http://example.test/jre21.zip", checksum: "a".repeat(64) } } }]), { status: 200 });
      }
      return new Response("nope", { status: 404 });
    }) as unknown as FetchFn;
    const j = new JavaTools({ toolsDir: tmp, fetch: f, grant: async () => {} });
    await expect(j.ensure(21, () => {})).rejects.toThrow(/not HTTPS/);
    expect(urls).toHaveLength(1);
  });

  it("the Adoptium lookup carries a timeout signal", async () => {
    let init: RequestInit | undefined;
    const f = (async (_input: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response("[]", { status: 200 });
    }) as unknown as FetchFn;
    await expect(new JavaTools({ toolsDir: tmp, fetch: f }).ensure(21, () => {})).rejects.toThrow(/No Windows Java 21/);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("ensure downloads, verifies, flattens the top folder, and grants the java dir", async () => {
    const { f, urls } = await fakeFetch();
    const grant = vi.fn(async (_dir: string) => {});
    const j = new JavaTools({ toolsDir: tmp, fetch: f, grant });
    const exe = await j.ensure(21, () => {});
    expect(exe).toBe(path.win32.join(tmp, "java", "21", "bin", "java.exe"));
    expect(fs.readFileSync(exe, "utf8")).toBe("JAVA");
    expect(grant).toHaveBeenCalledWith(path.win32.join(tmp, "java"));
    expect(urls[0]).toContain("architecture=x64&image_type=jre&os=windows&vendor=eclipse");
    expect(j.installedMajors()).toEqual([21]);
    expect(fs.readdirSync(path.join(tmp, "java"))).toEqual(["21"]);
  });

  it("a checksum mismatch throws and leaves nothing behind", async () => {
    const { f } = await fakeFetch({ checksum: "0".repeat(64) });
    const j = new JavaTools({ toolsDir: tmp, fetch: f, grant: async () => {} });
    await expect(j.ensure(21, () => {})).rejects.toThrow(/checksum/i);
    expect(j.installedMajors()).toEqual([]);
    const left = fs.existsSync(path.join(tmp, "java")) ? fs.readdirSync(path.join(tmp, "java")) : [];
    expect(left).toEqual([]);
  });

  it("a failed grant removes the install so the next ensure retries and succeeds", async () => {
    const { f } = await fakeFetch();
    let calls = 0;
    const grant = vi.fn(async (_dir: string) => {
      if (++calls === 1) throw new Error("icacls failed");
    });
    const j = new JavaTools({ toolsDir: tmp, fetch: f, grant });
    await expect(j.ensure(21, () => {})).rejects.toThrow(/icacls failed/);
    expect(j.installedMajors()).toEqual([]);
    const exe = await j.ensure(21, () => {});
    expect(fs.existsSync(exe)).toBe(true);
    expect(grant).toHaveBeenCalledTimes(2);
  });

  it("a second ensure makes no fetch", async () => {
    const { f, urls } = await fakeFetch();
    const j = new JavaTools({ toolsDir: tmp, fetch: f, grant: async () => {} });
    await j.ensure(21, () => {});
    const n = urls.length;
    await j.ensure(21, () => {});
    expect(urls.length).toBe(n);
  });

  it("installedMajors is sorted ascending and only counts folders with java.exe", () => {
    for (const m of [21, 8, 17]) {
      fs.mkdirSync(path.join(tmp, "java", String(m), "bin"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "java", String(m), "bin", "java.exe"), "x");
    }
    fs.mkdirSync(path.join(tmp, "java", "25"), { recursive: true });
    expect(new JavaTools({ toolsDir: tmp }).installedMajors()).toEqual([8, 17, 21]);
  });

  it("isManaged", () => {
    const j = new JavaTools({ toolsDir: "C:\\ProgramData\\Skali\\tools" });
    expect(j.isManaged("C:\\ProgramData\\Skali\\tools\\java\\21\\bin\\java.exe")).toBe(true);
    expect(j.isManaged("c:\\programdata\\skali\\TOOLS\\java\\21\\bin\\java.exe")).toBe(true);
    expect(j.isManaged("C:\\Program Files\\Java\\bin\\java.exe")).toBe(false);
    expect(j.isManaged("C:\\ProgramData\\Skali\\tools\\javaX\\bin\\java.exe")).toBe(false);
    expect(j.isManaged("C:\\ProgramData\\Skali\\tools\\java")).toBe(false);
  });
});
