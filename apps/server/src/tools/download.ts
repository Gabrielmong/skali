import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import yazl from "yazl";

export type FetchFn = typeof fetch;
export interface DownloadOpts {
  fetch?: FetchFn;
  sha1?: string;
  sha256?: string;
  onProgress?: (pct: number | null) => void;
}

/** Timeout for small JSON lookups (not the large downloads, which can legitimately take long). */
export const METADATA_TIMEOUT_MS = 30_000;

/** Fetches a small JSON/metadata URL with METADATA_TIMEOUT_MS; a timeout becomes "Could not reach <what>: timed out". */
export async function fetchMetadata(doFetch: FetchFn, url: string, what: string): Promise<Response> {
  try {
    return await doFetch(url, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) throw new Error(`Could not reach ${what}: timed out`);
    throw e;
  }
}

/** Download URLs taken from an API's JSON must be HTTPS (the checksum comes from the same JSON). */
export function requireHttps(url: unknown, what: string): string {
  let ok = false;
  try {
    ok = typeof url === "string" && new URL(url).protocol === "https:";
  } catch {
    /* not a URL */
  }
  if (!ok) throw new Error(`${what} is not HTTPS; refusing to download it`);
  return url as string;
}

/** Streams `url` to `<dest>.part`, verifies hashes, then renames to `dest`. */
export async function download(url: string, dest: string, opts: DownloadOpts = {}): Promise<void> {
  const doFetch = opts.fetch ?? fetch;
  const res = await doFetch(url);
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  }
  const total = Number(res.headers.get("content-length") ?? "");
  const hasTotal = Number.isFinite(total) && total > 0;
  const sha1 = opts.sha1 ? crypto.createHash("sha1") : null;
  const sha256 = opts.sha256 ? crypto.createHash("sha256") : null;
  let received = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      sha1?.update(chunk);
      sha256?.update(chunk);
      received += chunk.length;
      opts.onProgress?.(hasTotal ? Math.min(100, Math.floor((received / total) * 100)) : null);
      cb(null, chunk);
    },
  });
  const part = dest + ".part";
  try {
    await pipeline(Readable.fromWeb(res.body as never), tap, fs.createWriteStream(part));
    if (sha1 && sha1.digest("hex") !== opts.sha1!.toLowerCase()) {
      throw new Error(`Checksum mismatch (SHA-1) for ${url}`);
    }
    if (sha256 && sha256.digest("hex") !== opts.sha256!.toLowerCase()) {
      throw new Error(`Checksum mismatch (SHA-256) for ${url}`);
    }
    await fsp.rename(part, dest);
  } catch (err) {
    await fsp.rm(part, { force: true });
    throw err;
  }
}

/** Extracts a zip into `destDir`; entries resolving outside it are refused. */
/** True when `name` (a zip entry name) resolves inside `root`. Rejects absolute/drive paths and `..` escapes. */
export function isInsideDir(root: string, name: string): boolean {
  const r = path.resolve(root);
  const norm = name.replaceAll("\\", "/");
  if (norm.startsWith("/") || /^[A-Za-z]:/.test(norm)) return false;
  const target = path.resolve(r, norm);
  return target === r || target.startsWith(r + path.sep);
}

export async function extractZip(zipFile: string, destDir: string): Promise<void> {
  const root = path.resolve(destDir);
  await fsp.mkdir(root, { recursive: true });
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipFile, { lazyEntries: true }, (e, z) => (e || !z ? reject(e) : resolve(z))),
  );
  await new Promise<void>((resolve, reject) => {
    let done = false;
    const fail = (e: unknown) => {
      if (done) return;
      done = true;
      zip.close();
      reject(e);
    };
    zip.on("error", fail);
    zip.on("end", () => {
      if (done) return;
      done = true;
      resolve();
    });
    zip.on("entry", (entry: yauzl.Entry) => {
      const target = path.resolve(root, entry.fileName);
      if (!isInsideDir(root, entry.fileName)) {
        return fail(new Error(`Refusing zip entry outside the target folder: ${entry.fileName}`));
      }
      if (/\/$/.test(entry.fileName)) {
        fsp.mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail);
        return;
      }
      fsp
        .mkdir(path.dirname(target), { recursive: true })
        .then(
          () =>
            new Promise<void>((res, rej) =>
              zip.openReadStream(entry, (e, stream) => {
                if (e || !stream) return rej(e);
                pipeline(stream, fs.createWriteStream(target)).then(res, rej);
              }),
            ),
        )
        .then(() => zip.readEntry(), fail);
    });
    zip.readEntry();
  });
  zip.close();
}

async function collect(abs: string, rel: string, out: { abs: string; rel: string }[]): Promise<void> {
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink()) return; // symlinks and junctions are skipped
  if (st.isDirectory()) {
    for (const name of await fsp.readdir(abs)) {
      await collect(path.join(abs, name), rel + "/" + name, out);
    }
  } else if (st.isFile()) {
    out.push({ abs, rel });
  }
}

/** Zips each existing path (recursively) into `destZip`, entries named relative to `baseDir`. */
export async function zipPaths(paths: string[], baseDir: string, destZip: string): Promise<boolean> {
  const files: { abs: string; rel: string }[] = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    const rel = path.relative(path.resolve(baseDir), abs).split(path.sep).join("/");
    try {
      await collect(abs, rel, files);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  if (files.length === 0) return false;
  const part = destZip + ".part";
  let out: fs.WriteStream | undefined;
  try {
    const zip = new yazl.ZipFile();
    out = fs.createWriteStream(part);
    const writing = pipeline(zip.outputStream, out);
    const readFailed = new Promise<never>((_, rej) => zip.once("error", rej));
    for (const f of files) zip.addFile(f.abs, f.rel);
    zip.end();
    await Promise.race([writing, readFailed]);
    await fsp.rename(part, destZip);
  } catch (err) {
    out?.destroy();
    await new Promise((r) => setTimeout(r, 0));
    await fsp.rm(part, { force: true });
    throw err;
  }
  return true;
}
