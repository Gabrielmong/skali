import { afterEach, describe, expect, it } from "vitest";
import { queryA2SInfo } from "../../src/channels/a2s.js";
import { startFakeA2S, type FakeA2S } from "../fakes/a2s-server.js";

describe("A2S", () => {
  let fake: FakeA2S | undefined;
  afterEach(async () => {
    await fake?.close();
    fake = undefined;
  });

  it("reads info without challenge", async () => {
    fake = await startFakeA2S({ name: "Viking", players: 3, maxPlayers: 10 });
    expect(await queryA2SInfo("127.0.0.1", fake.port)).toEqual({ name: "Viking", players: 3, maxPlayers: 10 });
    expect(fake.received).toHaveLength(1);
  });

  it("answers the challenge", async () => {
    fake = await startFakeA2S({ challenge: true, players: 1, maxPlayers: 5 });
    expect(await queryA2SInfo("127.0.0.1", fake.port)).toEqual({ name: "Valheim", players: 1, maxPlayers: 5 });
    expect(fake.received).toHaveLength(2);
  });

  it("returns null for a silent server", async () => {
    fake = await startFakeA2S({ silent: true });
    expect(await queryA2SInfo("127.0.0.1", fake.port, 300)).toBeNull();
  });
});
