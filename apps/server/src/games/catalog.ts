import type { CatalogEntry, PortSpec } from "@skali/shared";
import raw from "./catalog.json" with { type: "json" };

interface RawEntry {
  appId: number;
  name: string;
  ports?: PortSpec[];
  exeHint?: string;
  notes?: string;
}

const STARRED: CatalogEntry[] = [
  { appId: 2394010, game: "palworld", name: "Palworld", star: true },
  { appId: 896660, game: "valheim", name: "Valheim", star: true },
  { appId: null, game: "minecraft", name: "Minecraft", star: true },
];

/** The starred built-in games first, then the generated Steam list (see tools/catalog) sorted by name. */
export function catalog(): CatalogEntry[] {
  const rest: CatalogEntry[] = (raw.entries as RawEntry[])
    .map((e) => ({ ...e, game: "basic" as const, star: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...STARRED, ...rest];
}
