import { describe, expect, it } from "vitest";
import { BadRequestError } from "../../src/errors.js";
import { compareMcVersions, MinecraftSources } from "../../src/tools/minecraft-sources.js";
import type { FetchFn } from "../../src/tools/download.js";

const MANIFEST = {
  latest: { release: "1.21.4", snapshot: "25w01a" },
  versions: [
    { id: "25w01a", type: "snapshot", url: "https://piston.test/25w01a.json" },
    { id: "1.21.4", type: "release", url: "https://piston.test/1.21.4.json" },
    { id: "1.20.6", type: "release", url: "https://piston.test/1.20.6.json" },
    { id: "1.21.10", type: "release", url: "https://piston.test/1.21.10.json" },
  ],
};
const VJSON = {
  "1.21.4": {
    downloads: { server: { url: "https://piston.test/server-1.21.4.jar", sha1: "abc123", size: 1 } },
    javaVersion: { majorVersion: 21, component: "java-runtime-delta" },
  },
  "1.20.6": { downloads: { client: { url: "x" } }, javaVersion: { majorVersion: 21 } },
};
// Shape of the real Fill v3 /builds response: array, newest first, downloads["server:default"].
const PAPER_BUILDS = [
  { id: 99, channel: "BETA", downloads: { "server:default": { name: "paper-1.21.4-99.jar", checksums: { sha256: "bbb" }, url: "https://fill-data.test/beta.jar" } } },
  { id: 232, channel: "STABLE", downloads: { "server:default": { name: "paper-1.21.4-232.jar", checksums: { sha256: "5ee4f5" }, url: "https://fill-data.test/paper-1.21.4-232.jar" } } },
  { id: 200, channel: "STABLE", downloads: { "server:default": { name: "paper-1.21.4-200.jar", checksums: { sha256: "old" }, url: "https://fill-data.test/old.jar" } } },
];
const PAPER_PROJECT = {
  project: { id: "paper", name: "Paper" },
  versions: { "1.21": ["1.21.11", "1.21.11-rc1", "1.21.10", "1.21.4"], "1.20": ["1.20.6", "1.20.4"] },
};

const fake: FetchFn = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
  if (url === "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json") return json(MANIFEST);
  if (url === "https://piston.test/1.21.4.json") return json(VJSON["1.21.4"]);
  if (url === "https://piston.test/1.20.6.json") return json(VJSON["1.20.6"]);
  if (url === "https://fill.papermc.io/v3/projects/paper") return json(PAPER_PROJECT);
  if (url === "https://fill.papermc.io/v3/projects/paper/versions/1.21.4/builds") return json(PAPER_BUILDS);
  if (url.startsWith("https://fill.papermc.io/v3/projects/paper/versions/")) return json({ ok: false }, 404);
  return new Response("nope", { status: 404 });
}) as unknown as FetchFn;

describe("compareMcVersions", () => {
  it("compares numerically", () => {
    expect(compareMcVersions("1.21.10", "1.21.9")).toBeGreaterThan(0);
    expect(compareMcVersions("1.20.6", "1.21.4")).toBeLessThan(0);
    expect(compareMcVersions("1.21", "1.21.0")).toBe(0);
    expect(compareMcVersions("1.21.1", "1.21")).toBeGreaterThan(0);
  });
});

describe("MinecraftSources", () => {
  const src = new MinecraftSources({ fetch: fake });

  it("vanilla versions: releases only, newest first, latest from manifest", async () => {
    const r = await src.versions("vanilla");
    expect(r.latest).toBe("1.21.4");
    expect(r.versions).toEqual(["1.21.10", "1.21.4", "1.20.6"]);
  });

  it("paper versions: releases only (no rc/pre), newest first", async () => {
    const r = await src.versions("paper");
    expect(r.versions).toEqual(["1.21.11", "1.21.10", "1.21.4", "1.20.6", "1.20.4"]);
    expect(r.latest).toBe("1.21.11");
  });

  it("vanilla resolve returns server url, sha1 and java major", async () => {
    expect(await src.resolve("vanilla", "1.21.4")).toEqual({
      url: "https://piston.test/server-1.21.4.jar",
      sha1: "abc123",
      javaMajor: 21,
    });
  });

  it("vanilla resolve without a server download is a BadRequestError", async () => {
    await expect(src.resolve("vanilla", "1.20.6")).rejects.toThrow(new BadRequestError("Minecraft 1.20.6 has no server download"));
  });

  it("unknown version is a BadRequestError", async () => {
    await expect(src.resolve("vanilla", "9.9")).rejects.toBeInstanceOf(BadRequestError);
  });

  it("paper resolve returns the latest stable build with sha256 and Mojang's java major", async () => {
    expect(await src.resolve("paper", "1.21.4")).toEqual({
      url: "https://fill-data.test/paper-1.21.4-232.jar",
      sha256: "5ee4f5",
      javaMajor: 21,
      build: 232,
    });
  });

  it("paper resolve with no builds is a BadRequestError", async () => {
    await expect(src.resolve("paper", "1.20.6")).rejects.toBeInstanceOf(BadRequestError);
  });

  it("every metadata fetch carries a timeout signal", async () => {
    const inits: (RequestInit | undefined)[] = [];
    const spy = (async (input: string | URL | Request, init?: RequestInit) => {
      inits.push(init);
      return fake(input, init);
    }) as unknown as FetchFn;
    const s2 = new MinecraftSources({ fetch: spy });
    await s2.versions("vanilla");
    await s2.versions("paper");
    await s2.resolve("paper", "1.21.4");
    expect(inits.length).toBeGreaterThanOrEqual(5);
    for (const i of inits) expect(i?.signal).toBeInstanceOf(AbortSignal);
  });

  it("a metadata timeout becomes a readable error", async () => {
    const slow = (async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }) as unknown as FetchFn;
    await expect(new MinecraftSources({ fetch: slow }).versions("vanilla")).rejects.toThrow("Could not reach Mojang's version list: timed out");
  });

  it("refuses non-HTTPS URLs taken from the API JSON", async () => {
    const withUrls = (versionUrl: string, serverUrl: string, paperUrl: string) =>
      (async (input: string | URL | Request) => {
        const url = String(input);
        const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 });
        if (url.endsWith("version_manifest_v2.json")) return json({ ...MANIFEST, versions: [{ id: "1.21.4", type: "release", url: versionUrl }] });
        if (url === versionUrl) return json({ downloads: { server: { url: serverUrl, sha1: "abc" } }, javaVersion: { majorVersion: 21 } });
        if (url.endsWith("/builds")) return json([{ id: 1, channel: "STABLE", downloads: { "server:default": { url: paperUrl, checksums: { sha256: "x" } } } }]);
        return new Response("nope", { status: 404 });
      }) as unknown as FetchFn;
    const ok = "https://piston.test/1.21.4.json";
    await expect(new MinecraftSources({ fetch: withUrls("http://piston.test/1.21.4.json", "https://a/s.jar", "https://a/p.jar") }).resolve("vanilla", "1.21.4"))
      .rejects.toThrow(/not HTTPS/);
    await expect(new MinecraftSources({ fetch: withUrls(ok, "http://a/s.jar", "https://a/p.jar") }).resolve("vanilla", "1.21.4")).rejects.toThrow(/not HTTPS/);
    await expect(new MinecraftSources({ fetch: withUrls(ok, "https://a/s.jar", "http://a/p.jar") }).resolve("paper", "1.21.4")).rejects.toThrow(/not HTTPS/);
    await expect(new MinecraftSources({ fetch: withUrls(ok, "https://a/s.jar", "https://a/p.jar") }).resolve("paper", "1.21.4")).resolves.toMatchObject({ url: "https://a/p.jar" });
  });
});
