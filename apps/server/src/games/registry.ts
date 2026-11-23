import type { GameId, GameInfo } from "@skali/shared";
import { basic } from "./basic.js";
import { minecraft } from "./minecraft.js";
import { palworld } from "./palworld.js";
import type { GameAdapter } from "./types.js";
import { valheim } from "./valheim.js";

const adapters: Record<GameId, GameAdapter> = { palworld, valheim, minecraft, basic };

export function getAdapter(id: GameId): GameAdapter {
  const a = adapters[id];
  if (!a) throw new Error(`Unknown game: ${id}`);
  return a;
}

export function listGames(): GameInfo[] {
  return Object.values(adapters).map((a) => a.info);
}
