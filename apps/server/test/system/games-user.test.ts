import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import type { Helper } from "../../src/proc/helper.js";
import { ensureGamesUser, GAMES_USER } from "../../src/system/games-user.js";

function fakeHelper(calls: string[]): Helper {
  const no = () => Promise.reject(new Error("not used"));
  return {
    launch: no,
    stats: no,
    ctrlC: no,
    kill: no,
    ensureUser: async (name) => {
      calls.push(name);
      return { created: false, password: "pw-123" };
    },
  };
}

describe("ensureGamesUser", () => {
  it("returns null and touches nothing when running as the current user", async () => {
    const calls: string[] = [];
    const cfg = loadConfig({ SKALI_RUN_AS_CURRENT_USER: "1" });
    expect(await ensureGamesUser(fakeHelper(calls), cfg)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("ensures SkaliGames and returns its fresh password", async () => {
    const calls: string[] = [];
    const cfg = loadConfig({});
    expect(GAMES_USER).toBe("SkaliGames");
    expect(await ensureGamesUser(fakeHelper(calls), cfg)).toEqual({ name: "SkaliGames", password: "pw-123" });
    expect(calls).toEqual(["SkaliGames"]);
  });
});
