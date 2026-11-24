import fs from "node:fs";
import http from "node:http";
import { Router, type Response } from "express";

export interface DeploysDeps {
  /** Base URL of the deploy helper, e.g. http://127.0.0.1:4201. */
  deployerUrl: string;
  /** File holding the helper's API token; read on every request, never logged or returned. */
  deployerTokenFile: string;
  log?: (msg: string) => void;
  timeoutMs?: number;
}

const SHA = /^[0-9a-f]{7,40}$/;
const FROM = /^\d{1,15}$/;
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE = 4 * 1024 * 1024;

interface Reply {
  status: number;
  body: unknown;
}

const simple = {
  "deploy-now": "deployNow",
  restart: "restartApp",
  pause: "pause",
  resume: "resume",
} as const;

/** The helper's /status, log and /command, behind the existing Host/allowlist/X-Skali middleware. */
export function deploysRouter(deps: DeploysDeps): Router {
  const r = Router();
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;

  function call(method: "GET" | "POST", path: string, body?: unknown): Promise<Reply | "down"> {
    let token: string;
    try {
      token = fs.readFileSync(deps.deployerTokenFile, "utf8").trim();
    } catch {
      return Promise.resolve("down");
    }
    if (!token) return Promise.resolve("down");
    return new Promise((resolve) => {
      let settled = false;
      const done = (v: Reply | "down") => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string | number> = { Authorization: `Bearer ${token}` };
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload);
      }
      let req: http.ClientRequest;
      try {
        req = http.request(new URL(path, deps.deployerUrl), { method, headers, timeout: timeoutMs }, (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_RESPONSE) {
              res.destroy();
              return done("down");
            }
            chunks.push(c);
          });
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed: unknown;
            try {
              parsed = text ? JSON.parse(text) : {};
            } catch {
              return done("down");
            }
            done({ status: res.statusCode ?? 502, body: parsed });
          });
          res.on("error", () => done("down"));
        });
      } catch {
        return done("down");
      }
      req.on("timeout", () => {
        req.destroy();
        done("down");
      });
      req.on("error", () => done("down"));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  async function send(res: Response, method: "GET" | "POST", path: string, body?: unknown): Promise<void> {
    const out = await call(method, path, body);
    if (out === "down") {
      deps.log?.("Deploy helper unreachable or token file unreadable");
      return void res.status(503).json({ error: "helper-not-running" });
    }
    res.status(out.status).json(out.body);
  }

  r.get("/status", (_req, res) => send(res, "GET", "/status"));

  r.get("/events/:id/log", (req, res) => {
    const from = req.query.from;
    if (from !== undefined && !(typeof from === "string" && FROM.test(from))) {
      return void res.status(400).json({ error: "from must be a byte offset" });
    }
    const q = from === undefined ? "" : `?from=${from}`;
    return send(res, "GET", `/events/${encodeURIComponent(String(req.params.id ?? ""))}/log${q}`);
  });

  for (const [route, type] of Object.entries(simple)) {
    r.post(`/${route}`, (_req, res) => send(res, "POST", "/command", { type, by: "you" }));
  }

  r.post("/rollback/:sha", (req, res) => {
    const sha = String(req.params.sha ?? "");
    if (!SHA.test(sha)) return void res.status(400).json({ error: "Invalid release id" });
    return send(res, "POST", "/command", { type: "rollback", sha, by: "you" });
  });

  return r;
}
