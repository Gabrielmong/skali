import { runProcess, system32Exe } from "./run.js";

/** Grants `user` modify rights (inherited) on `folder`. The folder is a separate argv element (no shell). */
export async function grantModify(folder: string, user: string, run: typeof runProcess = runProcess): Promise<void> {
  if (folder.includes('"')) throw new Error("Folder path may not contain a double quote");
  const r = await run(system32Exe("icacls.exe"), [folder, "/grant", `${user}:(OI)(CI)M`, "/Q"]);
  if (r.code !== 0) throw new Error(`icacls failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
}
