import type { Request } from "express";
import { BadRequestError } from "../errors.js";

export function bodyObject(req: Request): Record<string, unknown> {
  const b: unknown = req.body;
  if (!b || typeof b !== "object" || Array.isArray(b)) throw new BadRequestError("Expected a JSON object");
  return b as Record<string, unknown>;
}

export function onlyKeys(b: Record<string, unknown>, allowed: Set<string>): void {
  for (const k of Object.keys(b)) if (!allowed.has(k)) throw new BadRequestError(`Unexpected field: ${k}`);
}
