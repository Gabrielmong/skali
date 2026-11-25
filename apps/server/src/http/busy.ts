import type { IncomingMessage } from "node:http";
import { Router } from "express";
import type { RuntimeState } from "@skali/shared";
import type { ServerRepo } from "../servers/repo.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface BusyDeps {
  repo: Pick<ServerRepo, "list">;
  /** The supervisor's runtime view, the same one views.ts renders. */
  state: (id: string) => RuntimeState;
  /** Running install/update jobs. */
  jobReasons?: () => string[];
  remoteOf: (req: IncomingMessage) => string | undefined;
}

/** GET /api/deploys/busy for the deploy helper: loopback only (anything else gets a plain 404), no Host check. */
export function busyRouter(deps: BusyDeps): Router {
  const r = Router();
  r.get("/", (req, res) => {
    const remote = deps.remoteOf(req);
    if (!remote || !LOOPBACK.has(remote)) return void res.status(404).json({ error: "not found" });
    const reasons: string[] = [];
    for (const rec of deps.repo.list()) {
      const status = deps.state(rec.id).status;
      if (status === "starting" || status === "stopping") reasons.push(`${rec.name} is ${status}`);
    }
    reasons.push(...(deps.jobReasons?.() ?? []));
    res.setHeader("Cache-Control", "no-store");
    res.json({ busy: reasons.length > 0, reasons });
  });
  return r;
}
