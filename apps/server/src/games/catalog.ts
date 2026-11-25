import type { CatalogEntry, PortSpec } from "@skali/shared";
import raw from "./catalog.json" with { type: "json" };

interface RawEntry {
  appId: number;
  name: string;
  ports?: PortSpec[];
  exeHint?: string;
  notes?: string;
  /** The base game's Steam header image (tools/catalog/art.mjs). */
  art?: string;
}

const STARRED: CatalogEntry[] = [
  {
    appId: 2394010,
    game: "palworld",
    name: "Palworld",
    star: true,
    art: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/1623730/6912f19c43a95ff5fe514eedd35e68bf12335459/header.jpg",
  },
  {
    appId: 896660,
    game: "valheim",
    name: "Valheim",
    star: true,
    art: "https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/892970/df65cafab20dae97a243c7cc988e8bf959e4b906/header.jpg",
  },
  { appId: null, game: "minecraft", name: "Minecraft", star: true },
];

/**
 * Hand corrections on top of the generated list (LinuxGSM's defaults are Linux configs and can be stale). Applied
 * here, not in catalog.json, so rerunning tools/catalog/generate.mjs keeps them.
 */
const CORRECTIONS: Record<number, Partial<Pick<CatalogEntry, "ports">>> = {
  // Satisfactory 1.0: game traffic on 7777/udp, the HTTPS server API on 7777/tcp, reliable messaging on 8888/tcp.
  1690800: {
    ports: [
      { port: 7777, protocol: "udp", purpose: "Game", forward: true },
      { port: 7777, protocol: "tcp", purpose: "Server API", forward: true },
      { port: 8888, protocol: "tcp", purpose: "Reliable messaging", forward: true },
    ],
  },
};

/** The starred built-in games first, then the generated Steam list (see tools/catalog) sorted by name. */
export function catalog(): CatalogEntry[] {
  const rest: CatalogEntry[] = (raw.entries as RawEntry[])
    .map((e) => ({ ...e, ...CORRECTIONS[e.appId], game: "basic" as const, star: false }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...STARRED, ...rest];
}
