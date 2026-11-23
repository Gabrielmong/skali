import type { GameAdapter } from "../../src/games/types.js";
import type { ServerRecord } from "../../src/servers/repo.js";
import { fakeGamePath } from "./fake-game.js";

/** Minimal adapter for integration tests: launches FakeGame (ticking), stops it gracefully with Ctrl+C. */
export const fakeGameAdapter: GameAdapter = {
  info: { id: "basic", displayName: "FakeGame", hasCommands: false, launchFields: [] },
  ready: { kind: "none" },
  defaultStopTimeoutSec: 20,
  inspectFolder: async () => ({ ok: false, reason: "n/a" }),
  validateLaunch: () => [],
  ports: () => [],
  prepare: async () => ({}),
  buildLaunch: (s: ServerRecord) => ({ exe: fakeGamePath, args: [], cwd: s.folder }),
  stop: async (_s, ctx) => {
    await ctx.ctrlC();
  },
  command: null,
  hasCommandsFor: () => false,
  players: async () => null,
};
