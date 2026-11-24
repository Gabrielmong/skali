import fs from "node:fs/promises";
import path from "node:path";

export interface ValheimWorld { name: string; fwlPath: string; modified: string }

/** Finds Valheim worlds (.fwl with a matching .db) in every user profile under `usersRoot`, newest first. */
export async function findValheimWorlds(usersRoot = "C:\\Users"): Promise<ValheimWorld[]> {
  const out: { w: ValheimWorld; t: number }[] = [];
  let users: string[];
  try { users = await fs.readdir(usersRoot); } catch { return []; }
  for (const u of users) {
    for (const sub of ["worlds_local", "worlds"]) {
      const dir = path.join(usersRoot, u, "AppData", "LocalLow", "IronGate", "Valheim", sub);
      let files: string[];
      try { files = await fs.readdir(dir); } catch { continue; }
      for (const f of files) {
        if (!f.toLowerCase().endsWith(".fwl")) continue;
        const name = f.slice(0, -4);
        try {
          await fs.access(path.join(dir, `${name}.db`));
          const st = await fs.stat(path.join(dir, f));
          out.push({ w: { name, fwlPath: path.join(dir, f), modified: st.mtime.toISOString() }, t: st.mtimeMs });
        } catch { /* missing .db or unreadable: skip */ }
      }
    }
  }
  return out.sort((a, b) => b.t - a.t).map((x) => x.w);
}
