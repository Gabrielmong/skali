import { runProcess, system32Exe } from "./run.js";

// Both helpers pass /L so icacls changes a link (junction/symlink) itself, never its target: a games-user process
// that swaps the folder for a junction must not be able to redirect the grant. Callers also refuse link folders.

/** Grants `user` modify rights (inherited) on `folder`. The folder is a separate argv element (no shell). */
export async function grantModify(folder: string, user: string, run: typeof runProcess = runProcess): Promise<void> {
  if (folder.includes('"')) throw new Error("Folder path may not contain a double quote");
  const r = await run(system32Exe("icacls.exe"), [folder, "/grant", `${user}:(OI)(CI)M`, "/L", "/Q"]);
  if (r.code !== 0) throw new Error(`icacls failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
}

/** Grants `user` read+execute (inherited) on `folder`, for tools the games user runs but must not change. */
export async function grantReadExecute(folder: string, user: string, run: typeof runProcess = runProcess): Promise<void> {
  if (folder.includes('"')) throw new Error("Folder path may not contain a double quote");
  const r = await run(system32Exe("icacls.exe"), [folder, "/grant", `${user}:(OI)(CI)RX`, "/L", "/Q"]);
  if (r.code !== 0) throw new Error(`icacls failed (exit ${r.code}): ${(r.stderr || r.stdout).trim()}`);
}
