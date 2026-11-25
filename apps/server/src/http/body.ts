import type { Request } from "express";
import type { LaunchValues } from "@skali/shared";
import { BadRequestError } from "../errors.js";

export function bodyObject(req: Request): Record<string, unknown> {
  const b: unknown = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new BadRequestError("Expected a JSON object");
  return b as Record<string, unknown>;
}

export function onlyKeys(b: Record<string, unknown>, allowed: Set<string>): void {
  for (const k of Object.keys(b)) if (!allowed.has(k)) throw new BadRequestError(`Unexpected field: ${k}`);
}

const MAX_LAUNCH_KEYS = 64;
const MAX_LAUNCH_STRING = 4096;

/** A flat object of string/number/boolean launch values (bounded). */
export function launchValues(v: unknown): LaunchValues {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new BadRequestError("launch must be an object");
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > MAX_LAUNCH_KEYS) throw new BadRequestError("Too many launch values");
  for (const [k, x] of entries) {
    const ok =
      typeof x === "boolean" ||
      (typeof x === "number" && Number.isFinite(x)) ||
      (typeof x === "string" && x.length <= MAX_LAUNCH_STRING);
    if (!ok) throw new BadRequestError(`Invalid launch value: ${k}`);
  }
  return { ...(v as LaunchValues) };
}
