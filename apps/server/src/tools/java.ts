import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { download, extractZip, fetchMetadata, requireHttps, type FetchFn } from "./download.js";

export interface JavaToolsDeps {
  toolsDir: string;
  fetch?: FetchFn;
  /** Lets the games user read and run the tools (the caller wires grantReadExecute for the games user). */
  grant?: (dir: string) => Promise<void>;
}

interface AdoptiumAsset {
  binary?: { package?: { link?: string; checksum?: string } };
}

const assetsUrl = (major: number) =>
  `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=x64&image_type=jre&os=windows&vendor=eclipse`;

const lower = (p: string) => path.win32.normalize(p).toLowerCase();

/** Managed Temurin JREs under `<toolsDir>\java\<major>\`. */
export class JavaTools {
  private readonly root: string;
  private readonly fetchFn?: FetchFn;
  private readonly grant?: (dir: string) => Promise<void>;
  private readonly ensuring = new Map<number, Promise<string>>();

  constructor(deps: JavaToolsDeps) {
    this.root = path.win32.join(deps.toolsDir, "java");
    this.fetchFn = deps.fetch;
    this.grant = deps.grant;
  }

  javaExe(major: number): string {
    return path.win32.join(this.root, String(major), "bin", "java.exe");
  }

  installedMajors(): number[] {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.root);
    } catch {
      return [];
    }
    return names
      .filter((n) => /^\d+$/.test(n) && fs.existsSync(this.javaExe(Number(n))))
      .map(Number)
      .sort((a, b) => a - b);
  }

  isManaged(javaPath: string): boolean {
    return lower(javaPath).startsWith(lower(this.root) + "\\");
  }

  /** Installs the JRE for `major` if missing and returns java.exe. Concurrent calls share one download. */
  ensure(major: number, log: (l: string) => void): Promise<string> {
    if (fs.existsSync(this.javaExe(major))) return Promise.resolve(this.javaExe(major));
    let p = this.ensuring.get(major);
    if (!p) {
      p = this.install(major, log).finally(() => this.ensuring.delete(major));
      this.ensuring.set(major, p);
    }
    return p;
  }

  private async install(major: number, log: (l: string) => void): Promise<string> {
    const doFetch = this.fetchFn ?? fetch;
    log(`Looking up Java ${major}`);
    const res = await fetchMetadata(doFetch, assetsUrl(major), `Adoptium (Java ${major})`);
    if (!res.ok) throw new Error(`Could not look up Java ${major}: HTTP ${res.status}`);
    const assets = (await res.json()) as AdoptiumAsset[];
    const pkg = Array.isArray(assets) ? assets.map((a) => a.binary?.package).find((p) => p?.link && p.checksum) : undefined;
    if (!pkg?.link || !pkg.checksum) throw new Error(`No Windows Java ${major} download was found`);
    const link = requireHttps(pkg.link, `The Java ${major} download link`);

    await fsp.mkdir(this.root, { recursive: true });
    const stamp = `${process.pid}-${Date.now()}`;
    const zip = path.win32.join(this.root, `jre${major}-${stamp}.zip`);
    const staging = path.win32.join(this.root, `.extract-${major}-${stamp}`);
    const dest = path.win32.join(this.root, String(major));
    try {
      log(`Downloading Java ${major}`);
      await download(link, zip, { fetch: this.fetchFn, sha256: pkg.checksum });
      log(`Extracting Java ${major}`);
      await extractZip(zip, staging);
      // Temurin zips hold one top folder (jdk-21.0.5+11-jre); flatten it.
      let top = staging;
      const entries = await fsp.readdir(staging, { withFileTypes: true });
      if (entries.length === 1 && entries[0]!.isDirectory()) top = path.win32.join(staging, entries[0]!.name);
      if (!fs.existsSync(path.win32.join(top, "bin", "java.exe"))) throw new Error("The Java download did not contain bin\\java.exe");
      await fsp.rm(dest, { recursive: true, force: true });
      await fsp.rename(top, dest);
    } finally {
      await fsp.rm(zip, { force: true });
      await fsp.rm(staging, { recursive: true, force: true });
    }
    try {
      await this.grant?.(this.root);
    } catch (e) {
      // Without the grant the games user cannot run it; drop the install so the next ensure retries everything.
      await fsp.rm(dest, { recursive: true, force: true });
      throw e;
    }
    log(`Java ${major} is ready`);
    return this.javaExe(major);
  }
}
