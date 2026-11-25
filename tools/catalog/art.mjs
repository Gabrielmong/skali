#!/usr/bin/env node
// Adds `art` (the base game's Steam header image URL) to apps/server/src/games/catalog.json, for the New server
// gallery cards. Dedicated-server apps have no store art, so this finds the game they serve: an OVERRIDES entry
// when one exists, else the Steam store search for the name with "Dedicated Server" etc. stripped, accepted only when
// the result's name matches. Dev tool, no SteamCMD needed. Usage: node tools/catalog/art.mjs [catalog.json]
// Everything downloaded is treated as data: it is parsed, never executed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(
  process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "server", "src", "games", "catalog.json"),
);

/** Server app id -> base game app id, where the name search can't find it (or finds the wrong game). 0 = no art. */
const OVERRIDES = {
  416880: 296300, // Ballistic Overkill
  443030: 440900, // Conan Exiles
  740: 730, // CS:GO server -> Counter-Strike 2
  317800: 317360, // Double Action: Boogaloo
  17585: 17580, // Dystopia
  460040: 17740, // Empires
  2728330: 0, // HZ_SERVER: unclear which game
  261140: 259080, // Just Cause 2: Multiplayer Mod
  619960: 225540, // Just Cause 3
  622970: 555160, // Pavlov VR
  332670: 234630, // Project CARS
  413770: 378860, // Project CARS 2
  244310: 0, // Source SDK Base 2013: not a game
};

const clean = (name) =>
  name
    .replace(/[™®]/g, "")
    .replace(/\s*[-:]?\s*(Linux\s+)?Dedicated\s*Server(\s+For\s+Linux)?$/i, "")
    .replace(/\s*-?\s*Server$/i, "")
    .trim();
const norm = (s) => s.toLowerCase().replace(/[™®]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url);
    if (res.status === 429) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`${url}: rate limited`);
}

async function searchGame(name) {
  const q = clean(name);
  const r = await json(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(q)}&cc=us&l=en`);
  const items = Array.isArray(r?.items) ? r.items : [];
  const want = norm(q);
  const hit = items.find((i) => i?.type === "app" && norm(String(i.name)) === want);
  return hit ? Number(hit.id) : null;
}

async function headerOf(appId) {
  const r = await json(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`);
  const d = r?.[appId];
  const url = d?.success ? d.data?.header_image : undefined;
  const ok = typeof url === "string" && /^https:\/\/[a-z0-9.-]+\.(steamstatic|akamaihd)\.(com|net)\//.test(url);
  return ok ? { url, name: String(d.data?.name ?? "") } : null;
}

const doc = JSON.parse(fs.readFileSync(file, "utf8"));
const misses = [];
for (const e of doc.entries) {
  let game = e.appId in OVERRIDES ? OVERRIDES[e.appId] : await searchGame(e.name);
  const found = game ? await headerOf(game) : null;
  const art = found?.url;
  if (art) e.art = art;
  else {
    delete e.art;
    misses.push(`${e.appId} ${e.name}`);
  }
  console.log(`${art ? "ok  " : "miss"} ${e.appId} ${e.name} -> ${game ?? "-"} ${found?.name ?? ""}`);
  await sleep(350);
}
fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
console.log(`\n${doc.entries.length - misses.length}/${doc.entries.length} with art. Misses:\n${misses.join("\n")}`);
