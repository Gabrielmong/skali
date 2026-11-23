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
});
