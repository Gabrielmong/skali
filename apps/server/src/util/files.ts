import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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

/** Writes only when the content differs from what is on disk; creates missing directories. */
export function writeIfChanged(file: string, content: string): boolean {
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
