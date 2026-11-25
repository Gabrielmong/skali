import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BadRequestError } from "../errors.js";

/** 24 random alphanumeric characters. */
export function generateSecret(length = 24): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

/** Reads a text file, tolerating a UTF-8 BOM. Returns null if it does not exist. */
export function readTextFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/**
 * Defense in depth for writes the service (SYSTEM) makes inside a folder the games user can modify: refuses when
 * `target`, or any directory between `root` (exclusive) and it, is a symlink or junction (lstat reports both).
 * Missing components are fine. `root` itself is not checked here (see assertNotLinked in servers/folders.ts).
 * `verb` only words the error ("write", "back up").
 */
export function assertNoReparsePoints(root: string, target: string, verb = "write"): void {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new BadRequestError(`Refusing to ${verb} outside the server folder: ${target}`);
  }
  let cur = path.resolve(root);
  for (const part of rel.split(path.sep)) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // nothing below can exist
      throw e;
    }
    if (st.isSymbolicLink()) throw new BadRequestError(`Refusing to ${verb} through a link (junction or symlink): ${cur}`);
  }
}

/**
 * Writes only when the content differs from what is on disk; creates missing directories.
 * With `root`, first refuses link components (see assertNoReparsePoints).
 */
export function writeIfChanged(file: string, content: string, root?: string): boolean {
  if (root !== undefined) assertNoReparsePoints(root, file);
  if (readTextFile(file) === content) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
  return true;
}

export const str = (v: unknown, d = ""): string => (v === undefined || v === null ? d : String(v));
export const num = (v: unknown, d: number): number => {
  const n = typeof v === "number" ? v : Number(v);
  return v === undefined || v === "" || !Number.isFinite(n) ? d : n;
};
export const bool = (v: unknown, d: boolean): boolean =>
  v === undefined ? d : v === true || v === "true" || v === 1 || v === "1";
