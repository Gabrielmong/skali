import { Router, type Request } from "express";
import type { ConfigFormat, ConfigSaveRequest } from "@skali/shared";
import { LAUNCH_SOURCE_ID, MAX_CONFIG_BYTES, type ConfigService } from "../config/service.js";
import { BadRequestError } from "../errors.js";
import { bodyObject, onlyKeys } from "./body.js";
import type { AppEvent } from "./app.js";

/** Up to 1 MiB of raw text, which JSON can escape to six times its size. */
export const CONFIG_JSON_LIMIT = "7mb";
const MAX_CHANGES = 2000;
const FORMATS = new Set<string>(["ini", "palworld", "properties", "json", "yaml", "raw"]);

export interface ConfigRoutesDeps {
  service: ConfigService;
  notify: (e: AppEvent) => void;
}

type Changes = NonNullable<ConfigSaveRequest["changes"]>;

function format(b: Record<string, unknown>): ConfigFormat | undefined {
  const v = b.format;
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !FORMATS.has(v)) throw new BadRequestError("Unknown file format");
  return v as ConfigFormat;
}
function label(b: Record<string, unknown>): string | undefined {
  const v = b.label;
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new BadRequestError("label must be a string");
  return v;
}
function etag(b: Record<string, unknown>): string {
  if (typeof b.etag !== "string" || b.etag === "") throw new BadRequestError("etag must be a string");
  return b.etag;
}
/** `{changes}` or `{raw}`, never both and never neither. */
function edit(b: Record<string, unknown>): { changes?: Changes; raw?: string } {
  if ((b.changes === undefined) === (b.raw === undefined)) throw new BadRequestError("Send either changes or raw text");
  if (b.raw !== undefined) {
    if (typeof b.raw !== "string") throw new BadRequestError("raw must be a string");
    if (Buffer.byteLength(b.raw, "utf8") > MAX_CONFIG_BYTES) throw new BadRequestError("Text is larger than 1 MB");
    return { raw: b.raw };
  }
  const c = b.changes;
  if (!c || typeof c !== "object" || Array.isArray(c)) throw new BadRequestError("changes must be an object");
  const entries = Object.entries(c as Record<string, unknown>);
  if (entries.length > MAX_CHANGES) throw new BadRequestError("Too many changes");
  const out: Changes = {};
  for (const [k, v] of entries) {
    const ok = typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v));
    if (!ok) throw new BadRequestError(`Invalid value for ${k}`);
    out[k] = v;
  }
  return { changes: out };
}

/** Mounted at /api/servers/:id/config. */
export function configRouter({ service, notify }: ConfigRoutesDeps): Router {
  const r = Router({ mergeParams: true });
  const p = (req: Request, k: string) => String(req.params[k] ?? "");

  r.get("/sources", (req, res) => {
    res.json(service.listSources(p(req, "id")));
  });
  r.post("/sources", async (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["path", "format", "label"]));
    if (typeof b.path !== "string") throw new BadRequestError("path must be a string");
    const input: { path: string; format?: ConfigFormat; label?: string } = { path: b.path };
    const f = format(b);
    const l = label(b);
    if (f !== undefined) input.format = f;
    if (l !== undefined) input.label = l;
    res.status(201).json(await service.addSource(p(req, "id"), input));
  });
  r.patch("/sources/:sourceId", async (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["format", "label"]));
    const patch: { format?: ConfigFormat; label?: string } = {};
    const f = format(b);
    const l = label(b);
    if (f !== undefined) patch.format = f;
    if (l !== undefined) patch.label = l;
    res.json(await service.updateSource(p(req, "id"), p(req, "sourceId"), patch));
  });
  r.delete("/sources/:sourceId", async (req, res) => {
    await service.removeSource(p(req, "id"), p(req, "sourceId"));
    res.status(204).end();
  });

  r.use("/files/:sourceId", (req, _res, next) => {
    if (p(req, "sourceId") === LAUNCH_SOURCE_ID) throw new BadRequestError("Launch settings are edited through the server settings");
    next();
  });

  r.get("/files/:sourceId", (req, res) => {
    res.json(service.read(p(req, "id"), p(req, "sourceId")));
  });
  r.post("/files/:sourceId/preview", (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["changes", "raw"]));
    res.json(service.preview(p(req, "id"), p(req, "sourceId"), edit(b)));
  });
  r.put("/files/:sourceId", async (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["etag", "changes", "raw"]));
    const out = await service.save(p(req, "id"), p(req, "sourceId"), { etag: etag(b), ...edit(b) });
    notify({ type: "changed", serverId: p(req, "id") });
    res.json(out);
  });
  r.get("/files/:sourceId/history", (req, res) => {
    res.json(service.history(p(req, "id"), p(req, "sourceId")));
  });
  r.get("/files/:sourceId/history/:entryId", (req, res) => {
    res.json(service.historyRaw(p(req, "id"), p(req, "sourceId"), p(req, "entryId")));
  });
  r.post("/files/:sourceId/history/:entryId/restore", async (req, res) => {
    const b = bodyObject(req);
    onlyKeys(b, new Set(["etag"]));
    const out = await service.restore(p(req, "id"), p(req, "sourceId"), p(req, "entryId"), etag(b));
    notify({ type: "changed", serverId: p(req, "id") });
    res.json(out);
  });

  return r;
}
