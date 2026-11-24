import fs from "node:fs";
import path from "node:path";
import type { FsListing } from "@skali/shared";
import { BadRequestError } from "../errors.js";

export const MAX_FS_ENTRIES = 2000;

const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const byName = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** Existing drive roots C:\ … Z:\. */
export function driveRoots(exists: (p: string) => boolean = fs.existsSync): string[] {
  const out: string[] = [];
  for (let c = "C".charCodeAt(0); c <= "Z".charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    try {
      if (exists(root)) out.push(root);
    } catch {
      // ignore
    }
  }
  return out;
}

/**
 * Lists a folder for the folder picker: subfolders and files only (junctions and symlinks are neither, so they are
 * left out rather than followed). Only drive-letter paths: UNC and device paths are refused, so a crafted GET can't
 * make the service (LocalSystem) connect to a remote share.
 */
export async function browse(p: string | undefined): Promise<FsListing> {
  if (p === undefined || p === "") return { path: null, parent: null, dirs: driveRoots(), files: [], truncated: false };
  if (typeof p !== "string" || !DRIVE_PATH.test(p) || p.includes("\0")) {
    throw new BadRequestError("Path must be an absolute path such as C:\\Games");
  }
  const abs = path.win32.resolve(p);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(abs, { withFileTypes: true });
  } catch {
    throw new BadRequestError("Cannot read this folder");
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const e of entries) {
    if (e.isDirectory()) dirs.push(e.name);
    else if (e.isFile()) files.push(e.name);
  }
  dirs.sort(byName);
  files.sort(byName);
  const total = dirs.length + files.length;
  const keptDirs = dirs.slice(0, MAX_FS_ENTRIES);
  const keptFiles = files.slice(0, Math.max(0, MAX_FS_ENTRIES - keptDirs.length));
  const parent = path.win32.dirname(abs);
  return { path: abs, parent: parent === abs ? null : parent, dirs: keptDirs, files: keptFiles, truncated: total > MAX_FS_ENTRIES };
}
