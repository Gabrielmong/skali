import { BadRequestError } from "../errors.js";
import type { MinecraftFlavour } from "@skali/shared";
import { fetchMetadata, requireHttps, type FetchFn } from "./download.js";

export interface McDownload {
  url: string;
  sha1?: string;
  sha256?: string;
  javaMajor: number;
  build?: number;
}

const MANIFEST_URL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const PAPER_API = "https://fill.papermc.io/v3/projects/paper";
const RELEASE_RE = /^\d+(\.\d+)*$/;

/** Numeric dot-separated comparison: "1.21.10" > "1.21.9"; missing parts count as 0. */
export function compareMcVersions(a: string, b: string): number {
  const pa = a.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

interface Manifest {
  latest: { release: string };
  versions: { id: string; type: string; url: string }[];
}
interface VersionJson {
  downloads?: { server?: { url: string; sha1?: string } };
  javaVersion?: { majorVersion: number };
}
interface PaperBuild {
  id: number;
  channel: string;
  downloads?: { "server:default"?: { url: string; checksums?: { sha256?: string } } };
}

export class MinecraftSources {
  private readonly fetchFn: FetchFn;
  constructor(deps: { fetch?: FetchFn } = {}) {
    this.fetchFn = deps.fetch ?? fetch;
  }

  private async getJson<T>(url: string, what: string): Promise<T> {
    const res = await fetchMetadata(this.fetchFn, url, what);
    if (!res.ok) throw new Error(`Could not reach ${what}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  private manifest() {
    return this.getJson<Manifest>(MANIFEST_URL, "Mojang's version list");
  }

  async versions(flavour: MinecraftFlavour): Promise<{ versions: string[]; latest: string }> {
    if (flavour === "vanilla") {
      const m = await this.manifest();
      const versions = m.versions.filter((v) => v.type === "release").map((v) => v.id).sort((a, b) => compareMcVersions(b, a));
      return { versions, latest: m.latest.release };
    }
    const p = await this.getJson<{ versions: Record<string, string[]> }>(PAPER_API, "PaperMC");
    const versions = Object.values(p.versions)
      .flat()
      .filter((v) => RELEASE_RE.test(v))
      .sort((a, b) => compareMcVersions(b, a));
    return { versions, latest: versions[0] ?? "" };
  }

  async resolve(flavour: MinecraftFlavour, version: string): Promise<McDownload> {
    const m = await this.manifest();
    const entry = m.versions.find((v) => v.id === version);
    if (!entry) throw new BadRequestError(`Unknown Minecraft version ${version}`);
    const vj = await this.getJson<VersionJson>(requireHttps(entry.url, `Mojang's data URL for ${version}`), `Mojang's data for ${version}`);
    // Paper's API has no Java version; Mojang's is right for both flavours.
    const javaMajor = vj.javaVersion?.majorVersion ?? 8;
    if (flavour === "vanilla") {
      const s = vj.downloads?.server;
      if (!s) throw new BadRequestError(`Minecraft ${version} has no server download`);
      return { url: requireHttps(s.url, `Mojang's server download for ${version}`), sha1: s.sha1, javaMajor };
    }
    const res = await fetchMetadata(this.fetchFn, `${PAPER_API}/versions/${encodeURIComponent(version)}/builds`, "PaperMC");
    if (res.status === 404) throw new BadRequestError(`Paper has no builds for Minecraft ${version}`);
    if (!res.ok) throw new Error(`Could not reach PaperMC: HTTP ${res.status}`);
    const builds = (await res.json()) as PaperBuild[];
    const best = (Array.isArray(builds) ? builds : [])
      .filter((b) => b.channel === "STABLE" && b.downloads?.["server:default"]?.url)
      .sort((a, b) => b.id - a.id)[0];
    const dl = best?.downloads?.["server:default"];
    if (!best || !dl) throw new BadRequestError(`Paper has no stable build for Minecraft ${version}`);
    return { url: requireHttps(dl.url, `Paper's download for ${version}`), sha256: dl.checksums?.sha256, javaMajor, build: best.id };
  }
}
