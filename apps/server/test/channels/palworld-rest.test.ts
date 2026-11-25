import { afterEach, describe, expect, it } from "vitest";
import { createPalworldRest, DEFAULT_SAVE_TIMEOUT_MS, PalworldRestError } from "../../src/channels/palworld-rest.js";
import { startFakePalworld, type FakePalworld } from "../fakes/palworld-rest-server.js";

describe("Palworld REST", () => {
  let fake: FakePalworld | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("sends Basic auth and correct paths", async () => {
    fake = await startFakePalworld("pw");
    const api = createPalworldRest({ port: fake.port, password: "pw" });
    expect(await api.info()).toEqual({ version: "v0.5.0", servername: "Test" });
    expect(await api.metrics()).toEqual({ currentplayernum: 2, maxplayernum: 16 });
    expect(await api.players()).toEqual([{ name: "A", playerId: "p1", userId: "steam_1" }]);
    const auth = "Basic " + Buffer.from("admin:pw").toString("base64");
    expect(fake.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /v1/api/info",
      "GET /v1/api/metrics",
      "GET /v1/api/players",
    ]);
    expect(fake.requests.every((r) => r.authorization === auth)).toBe(true);
  });

  it("posts shutdown, save, announce, kick, ban, unban", async () => {
    fake = await startFakePalworld("pw");
    const api = createPalworldRest({ port: fake.port, password: "pw" });
    await api.shutdown(1, "bye");
    await api.save();
    await api.announce("hello");
    await api.kick("u1", "x");
    await api.ban("u2");
    await api.unban("u3");
    const r = fake.requests;
    expect(r[0]).toMatchObject({ method: "POST", url: "/v1/api/shutdown" });
    expect(r[0]!.body).toBe('{"waittime":1,"message":"bye"}');
    expect(r[1]).toMatchObject({ url: "/v1/api/save", body: "" });
    expect(JSON.parse(r[2]!.body)).toEqual({ message: "hello" });
    expect(JSON.parse(r[3]!.body)).toEqual({ userid: "u1", message: "x" });
    expect(JSON.parse(r[4]!.body)).toMatchObject({ userid: "u2" });
    expect(r[5]).toMatchObject({ url: "/v1/api/unban" });
    expect(JSON.parse(r[5]!.body)).toEqual({ userid: "u3" });
  });

  it("throws PalworldRestError on 401", async () => {
    fake = await startFakePalworld("pw");
    const api = createPalworldRest({ port: fake.port, password: "wrong" });
    const err = await api.info().catch((e) => e);
    expect(err).toBeInstanceOf(PalworldRestError);
    expect(err.status).toBe(401);
  });

  it("save has its own, longer timeout than other calls", async () => {
    fake = await startFakePalworld("pw", { delayMs: { "/v1/api/save": 300, "/v1/api/announce": 300 } });
    const api = createPalworldRest({ port: fake.port, password: "pw", timeoutMs: 100, saveTimeoutMs: 2000 });
    await expect(api.save()).resolves.toBeUndefined();
    await expect(api.announce("x")).rejects.toThrow();
  });
  it("save aborts after the configured timeout; default is 60 s", async () => {
    expect(DEFAULT_SAVE_TIMEOUT_MS).toBe(60_000);
    fake = await startFakePalworld("pw", { delayMs: { "/v1/api/save": 2000 } });
    const api = createPalworldRest({ port: fake.port, password: "pw", saveTimeoutMs: 150 });
    const t0 = Date.now();
    await expect(api.save()).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(1500);
  });
});
