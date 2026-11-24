import { afterEach, describe, expect, it } from "vitest";
import { RconAuthError, RconClient, RconTimeoutError, withRcon } from "../../src/channels/rcon.js";
import { startFakeRcon, type FakeRcon } from "../fakes/rcon-server.js";

describe("RCON", () => {
  let fake: FakeRcon | undefined;
  let client: RconClient | undefined;
  afterEach(async () => {
    client?.close();
    client = undefined;
    await fake?.close();
    fake = undefined;
  });

  it("authenticates and execs", async () => {
    fake = await startFakeRcon({ password: "pw" });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw");
    expect(await client.exec("list")).toBe("reply:list");
  });

  it("handles empty RESPONSE_VALUE before auth response and fragmented replies", async () => {
    fake = await startFakeRcon({ password: "pw", emptyFirst: true, splitReplies: true });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw");
    expect(await client.exec("list")).toBe("reply:list");
  });

  it("rejects wrong password with RconAuthError", async () => {
    fake = await startFakeRcon({ password: "pw" });
    await expect(RconClient.connect("127.0.0.1", fake.port, "bad")).rejects.toBeInstanceOf(RconAuthError);
  });

  it("times out against a silent server", async () => {
    fake = await startFakeRcon({ silent: true });
    const t0 = Date.now();
    await expect(RconClient.connect("127.0.0.1", fake.port, "pw")).rejects.toBeInstanceOf(RconTimeoutError);
    expect(Date.now() - t0).toBeLessThan(5500);
  }, 10_000);

  it("serializes concurrent execs, each with its own reply", async () => {
    fake = await startFakeRcon({ password: "pw", splitReplies: true });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw");
    const [a, b, c] = await Promise.all([client.exec("a"), client.exec("b"), client.exec("c")]);
    expect([a, b, c]).toEqual(["reply:a", "reply:b", "reply:c"]);
  });

  it("withRcon runs and closes", async () => {
    fake = await startFakeRcon({ password: "pw" });
    expect(await withRcon("127.0.0.1", fake.port, "pw", (c) => c.exec("say hi"))).toBe("reply:say hi");
  });

  it("connect rejects when the socket closes before auth without an error event", async () => {
    fake = await startFakeRcon({ closeOnConnect: true });
    const t0 = Date.now();
    await expect(RconClient.connect("127.0.0.1", fake.port, "pw")).rejects.toThrow(/closed/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("each exec has its own timeout", async () => {
    fake = await startFakeRcon({ password: "pw", answerCommands: 1 });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw", 300);
    expect(await client.exec("first")).toBe("reply:first");
    const t0 = Date.now();
    await expect(client.exec("second")).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("joins a response split over several packets", async () => {
    const body = "x".repeat(10_000);
    fake = await startFakeRcon({ password: "pw", splitBody: 3, reply: () => body });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw");
    expect(await client.exec("big")).toBe(body);
  });

  it("round-trips non-ASCII bodies as UTF-8", async () => {
    fake = await startFakeRcon({ password: "pw", reply: (c) => c });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw");
    expect(await client.exec("Skáli ✓")).toBe("Skáli ✓");
  });

  it("withRcon accepts a per-command timeout", async () => {
    fake = await startFakeRcon({ password: "pw", answerCommands: 0 });
    await expect(withRcon("127.0.0.1", fake.port, "pw", (c) => c.exec("x"), 200)).rejects.toThrow(/timed out/);
  });

  it("returns the reply when the server never echoes the probe", async () => {
    fake = await startFakeRcon({ password: "pw", ignoreProbe: true });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw");
    const t0 = Date.now();
    expect(await client.exec("list")).toBe("reply:list");
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it("does not leak a Minecraft-style unknown-request probe reply", async () => {
    fake = await startFakeRcon({ password: "pw", unknownRequestBody: true });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw");
    const out = await client.exec("list");
    expect(out).toBe("reply:list");
    expect(out).not.toContain("Unknown request");
  });

  it("keeps all parts of a split reply when the probe is never echoed", async () => {
    const body = "y".repeat(10_000);
    fake = await startFakeRcon({ password: "pw", splitBody: 3, ignoreProbe: true, reply: () => body });
    client = await RconClient.connect("127.0.0.1", fake.port, "pw");
    expect(await client.exec("big")).toBe(body);
  });
});
