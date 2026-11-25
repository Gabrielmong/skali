#!/usr/bin/env node
// Builds apps/server/src/games/catalog.json from LinuxGSM's server list, keeping only games whose Steam app
// has a Windows depot. Dev tool: not part of the server runtime or its tests.
// Usage: node tools/catalog/generate.mjs <steamcmd.exe> [out.json]
// Everything downloaded is treated as data: it is parsed, never executed.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const RAW = "https://raw.githubusercontent.com/GameServerManagers/LinuxGSM/master";
const EXCLUDE = new Set([2394010, 896660]); // Palworld and Valheim are built in
const BATCH = 10;
const FETCH_CONCURRENCY = 8;

const [steamcmd, outArg] = process.argv.slice(2);
if (!steamcmd) {
  console.error("Usage: node tools/catalog/generate.mjs <steamcmd.exe> [out.json]");
  process.exit(2);
}
const out = path.resolve(
  outArg ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "server", "src", "games", "catalog.json"),
);

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function parseCsv(text) {
  const [head, ...rows] = text.split(/\r?\n/).filter((l) => l.trim());
  const cols = head.split(",");
  return rows.map((r) => {
    const cells = r.split(",");
    return Object.fromEntries(cols.map((c, i) => [c, cells[i] ?? ""]));
  });
}

function cfgValue(text, key) {
  const m = new RegExp(`^${key}="?(\\d+)"?\\s*(#.*)?$`, "m").exec(text);
  return m ? Number(m[1]) : undefined;
}

// ---- minimal VDF parsing of app_info_print output ----
function tokenize(text, start) {
  const toks = [];
  let depth = 0;
  for (let i = start; i < text.length; ) {
    const c = text[i];
    if (c === '"') {
      let s = "";
      i++;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length) {
          s += text[i + 1];
          i += 2;
        } else s += text[i++];
      }
      i++;
      toks.push("s" + s);
    } else if (c === "{") {
      depth++;
      toks.push("{");
      i++;
    } else if (c === "}") {
      depth--;
      toks.push("}");
      i++;
      if (depth === 0) return toks;
    } else if (/\s/.test(c)) i++;
    else return null;
  }
  return null;
}
function parseObj(t, pos) {
  const o = {};
  if (t[pos.i] !== "{") throw new Error("expected {");
  pos.i++;
  while (pos.i < t.length && t[pos.i] !== "}") {
    const k = t[pos.i++];
    const v = t[pos.i];
    if (!k.startsWith("s")) throw new Error("expected key");
    if (v === "{") o[k.slice(1)] = parseObj(t, pos);
    else if (v?.startsWith("s")) {
      o[k.slice(1)] = v.slice(1);
      pos.i++;
    } else throw new Error("expected value");
  }
  pos.i++;
  return o;
}
const hasWindows = (s) => s.split(",").some((o) => o.trim().toLowerCase() === "windows");
const header = (id) => new RegExp(`^[ \\t]*"${id}"[ \\t]*\\r?$`, "m");

/** { name, windows } for an app in the output, or null when absent/unknown/unparseable. */
function readApp(appId, output) {
  const m = header(appId).exec(output);
  if (!m) return null;
  try {
    const t = tokenize(output, m.index + m[0].length);
    if (!t) return null;
    const b = parseObj(t, { i: 0 });
    const common = typeof b.common === "object" ? b.common : {};
    if (typeof common.name !== "string" || !common.name.trim()) return null;
    const oslists = Object.entries(typeof b.depots === "object" ? b.depots : {})
      .filter(([k, d]) => /^\d+$/.test(k) && typeof d === "object" && typeof d.config?.oslist === "string")
      .map(([, d]) => d.config.oslist);
    const windows = oslists.length ? oslists.some(hasWindows) : typeof common.oslist === "string" ? hasWindows(common.oslist) : true;
    return { name: common.name.trim(), windows };
  } catch {
    return null;
  }
}

function runSteam(appIds) {
  const args = ["+login", "anonymous", "+app_info_update", "1", ...appIds.flatMap((id) => ["+app_info_print", String(id)]), "+quit"];
  return new Promise((resolve, reject) => {
    const p = spawn(steamcmd, args, { windowsHide: true });
    let buf = "";
    p.stdout.on("data", (d) => (buf += d));
    p.stderr.on("data", (d) => (buf += d));
    p.on("error", reject);
    p.on("close", () => resolve(buf));
  });
}

async function pool(items, n, fn) {
  const res = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        res[i] = await fn(items[i]);
      }
    }),
  );
  return res;
}

const started = Date.now();
const list = parseCsv(await get(`${RAW}/lgsm/data/serverlist.csv`));
console.log(`serverlist: ${list.length} games`);

const cfgs = await pool(list, FETCH_CONCURRENCY, async (row) => {
  try {
    const text = await get(`${RAW}/lgsm/config-default/config-lgsm/${row.gameservername}/_default.cfg`);
    return { row, appId: cfgValue(text, "appid"), port: cfgValue(text, "port"), queryport: cfgValue(text, "queryport") };
  } catch (e) {
    console.warn(`skip ${row.gameservername}: ${e.message}`);
    return null;
  }
});

const byApp = new Map();
for (const c of cfgs) {
  if (!c || !c.appId || c.appId <= 0 || EXCLUDE.has(c.appId)) continue;
  if (!byApp.has(c.appId)) byApp.set(c.appId, c); // first one wins for shared app ids
}
console.log(`${byApp.size} candidate Steam app ids`);

const ids = [...byApp.keys()];
const info = new Map();
for (let i = 0; i < ids.length; i += BATCH) {
  const batch = ids.slice(i, i + BATCH);
  let output = await runSteam(batch);
  const missing = batch.filter((id) => !header(id).test(output));
  if (missing.length) output += "\n" + (await runSteam(missing)); // one retry for ids that did not print
  for (const id of batch) info.set(id, readApp(id, output));
  console.log(`steam ${Math.min(i + BATCH, ids.length)}/${ids.length}`);
}

const entries = [];
for (const [appId, c] of byApp) {
  const a = info.get(appId);
  if (!a || !a.windows) {
    console.log(`drop ${appId} ${c.row.gamename}: ${a ? "no windows depot" : "no app info"}`);
    continue;
  }
  const e = { appId, name: a.name };
  const ports = [];
  if (c.port) ports.push({ port: c.port, protocol: "udp", purpose: "Game", forward: true });
  if (c.queryport && c.queryport !== c.port) ports.push({ port: c.queryport, protocol: "udp", purpose: "Query", forward: true });
  if (ports.length) e.ports = ports;
  entries.push(e);
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const doc = {
  source: "LinuxGSM (MIT) - https://github.com/GameServerManagers/LinuxGSM, filtered to Steam apps with a Windows depot",
  generated: new Date().toISOString().slice(0, 10),
  entries,
};
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
console.log(`wrote ${entries.length} entries to ${out} in ${Math.round((Date.now() - started) / 1000)}s`);
