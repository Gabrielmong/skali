import fs from "node:fs";
import path from "node:path";
import { BadRequestError } from "../errors.js";

export interface ProtectedPaths {
  systemRoot: string;
  programFiles: string[];
  programData: string;
  dataDir: string | null;
  installDir: string | null;
}

export function defaultProtected(): ProtectedPaths {
  const e = process.env;
  const programData = e.ProgramData || "C:\\ProgramData";
  return {
    systemRoot: e.SystemRoot || e.SYSTEMROOT || "C:\\Windows",
    programFiles: [e.ProgramFiles, e["ProgramFiles(x86)"]].filter((x): x is string => !!x),
    programData,
    dataDir: path.join(programData, "Skali"),
    installDir: null,
  };
}

export const norm = (p: string) => {
  let r = path.resolve(p);
  while (r.length > 3 && /[\\/]$/.test(r)) r = r.slice(0, -1);
  return process.platform === "win32" ? r.toLowerCase() : r;
};

export const isUnder = (p: string, base: string) => norm(p) === norm(base) || norm(p).startsWith(norm(base) + path.sep);

/** Deny rules shared by adopt and install. Does not require the folder to exist. Returns the resolved path. */
export function assertAllowedFolder(folder: unknown, usersRoot: string, prot: ProtectedPaths, verb: "adopted" | "used"): string {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new BadRequestError("Folder must be an absolute path");
  if (folder.includes('"')) throw new BadRequestError("Folder path may not contain a double quote");
  const r = path.resolve(folder);
  const deny = (why: string) => new BadRequestError(`This folder can't be ${verb}: ${why}`);
  if (path.parse(r).root === r || norm(r) === norm(path.parse(r).root)) throw deny("it is a drive or share root");
  if (isUnder(r, prot.systemRoot)) throw deny("it is a Windows system folder");
  for (const pf of [...prot.programFiles, prot.programData]) if (norm(r) === norm(pf)) throw deny("it is a system folder");
  if (prot.dataDir && isUnder(r, prot.dataDir)) throw deny("it holds Skáli's own data");
  if (prot.installDir && isUnder(r, prot.installDir)) throw deny("it is the Skáli install folder");
  if (norm(r) === norm(usersRoot) || norm(path.dirname(r)) === norm(usersRoot)) throw deny("it is a user profile folder");
  return r;
}

export const FOLDER_IS_LINK = "is a link (junction or symlink)";

/**
 * Refuses when `folder`, or any folder above it up to the drive root, is a link (junction or symlink; lstat reports
 * both). Run before steps where the service (SYSTEM) grants rights in, writes into, or reads from a server folder the
 * games user can modify: a games-user process could have swapped the folder (or a parent) for a junction to elsewhere.
 * A missing component ends the walk (nothing below it can exist).
 */
export function assertNotLinked(folder: string): void {
  const r = path.resolve(folder);
  const chain: string[] = [];
  for (let cur = r; ; cur = path.dirname(cur)) {
    chain.unshift(cur);
    if (path.dirname(cur) === cur) break;
  }
  for (const cur of chain) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new BadRequestError(`Refusing to use the server folder: ${cur} ${FOLDER_IS_LINK}. Replace it with a real folder, then try again`);
    }
  }
}

/** Passes for a missing path or an empty folder. */
export function assertNewOrEmpty(folder: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(folder);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new BadRequestError("The install folder must be new or empty");
  }
  if (names.length > 0) throw new BadRequestError("The install folder must be new or empty");
}
