import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import os from "node:os";
import path from "node:path";
import type { GameId, JobView, RuntimeState, WsServerMessage } from "@skali/shared";
import { WebSocket, WebSocketServer } from "ws";
import { getAdapter } from "../games/registry.js";
import type { GameAdapter } from "../games/types.js";
import { listRuns } from "../logs/runs.js";
import { readTail } from "../logs/tail.js";
import type { SupervisorEvent } from "../proc/supervisor.js";
import type { ServerRepo } from "../servers/repo.js";
import type { SettingsStore } from "../settings.js";
import { isAllowed, isAllowedHost, isAllowedOrigin } from "./allowlist.js";
import type { AppEvent } from "./app.js";
import { toView } from "./views.js";

export interface WsHubDeps {
  /** Registers the hub's listener for supervisor events. The listener never throws. */
  subscribe: (cb: (e: SupervisorEvent) => void) => void;
  state: (id: string) => RuntimeState;
  settings: SettingsStore;
  /** The live job view for a server (null when none). */
  job?: (id: string) => JobView | null;
  repo: ServerRepo;
  adapter?: (id: GameId) => GameAdapter;
  logsDir: string;
  remoteAddress?: (req: IncomingMessage) => string | undefined;
  hostname?: string;
  log?: (msg: string) => void;
  /** Coalescing window for status messages. */
  tickMs?: number;
}

export interface WsHub {
  /** Changes made through the HTTP API. */
  notify(e: AppEvent): void;
  clientCount(): number;
  close(): void;
}

export const WS_PATH = "/ws";
const TICK_MS = 2_000;
const PING_MS = 30_000;
const HISTORY_LINES = 500;
const MAX_PAYLOAD = 64 * 1024;
/** A client this far behind is dropped rather than buffered without bound. */
const MAX_BUFFERED = 8 * 1024 * 1024;
const MAX_PENDING_LOGS = 1000;
const MAX_SUBS = 64;

interface LogSub {
  ready: boolean;
  buffer: WsServerMessage[];
}
interface Client {
  ws: WebSocket;
  subs: Map<string, LogSub>;
  alive: boolean;
  /** Peer address at upgrade time, re-checked when the allowlist changes. */
  remote: string | undefined;
}

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function refuse(socket: Duplex, status: 403 | 404): void {
  const text = status === 403 ? "Forbidden" : "Not Found";
  try {
    socket.once("finish", () => socket.destroy());
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
}

export function attachWsHub(server: Server, deps: WsHubDeps): WsHub {
  const { repo, settings, logsDir } = deps;
  const adapterOf = deps.adapter ?? getAdapter;
  const remoteOf = deps.remoteAddress ?? ((req: IncomingMessage) => req.socket.remoteAddress);
  const machine = deps.hostname ?? os.hostname();
  const log = deps.log ?? ((m: string) => console.error(m));
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const clients = new Map<WebSocket, Client>();
  const sentThisTick = new Set<string>();
  const pending = new Set<string>();
  let closed = false;

  const send = (c: Client, msg: WsServerMessage): void => {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    try {
      if (c.ws.bufferedAmount > MAX_BUFFERED) {
        c.ws.terminate();
        return;
      }
      c.ws.send(JSON.stringify(msg), () => undefined);
    } catch {
      // the socket went away; its close handler cleans up
    }
  };
  const broadcast = (msg: WsServerMessage): void => {
    for (const c of clients.values()) send(c, msg);
  };

  const statusMsg = (id: string): WsServerMessage | null => {
    try {
      const rec = repo.get(id);
      return { type: "status", server: toView(rec, deps.state(id), adapterOf(rec.game), settings.get(), deps.job?.(id) ?? null) };
    } catch {
      return null; // deleted meanwhile
    }
  };
  const sendStatusNow = (id: string): void => {
    const m = statusMsg(id);
    if (m) broadcast(m);
  };
  /** At most one status per server per tick: the first goes out at once, later ones wait for the tick. */
  const onStatus = (id: string): void => {
    if (!sentThisTick.has(id)) {
      sentThisTick.add(id);
      pending.delete(id);
      sendStatusNow(id);
    } else {
      pending.add(id);
    }
  };
  const tick = (): void => {
    try {
      sentThisTick.clear();
      const ids = [...pending];
      pending.clear();
      for (const id of ids) {
        sentThisTick.add(id);
        sendStatusNow(id);
      }
    } catch (e) {
      log(`ws tick failed: ${errMsg(e)}`);
    }
  };

  const onLog = (e: Extract<SupervisorEvent, { type: "log" }>): void => {
    const msg: WsServerMessage = { type: "log", serverId: e.serverId, runId: e.runId, lines: e.lines };
    for (const c of clients.values()) {
      const sub = c.subs.get(e.serverId);
      if (!sub) continue;
      if (sub.ready) send(c, msg);
      else if (sub.buffer.length < MAX_PENDING_LOGS) sub.buffer.push(msg);
    }
  };

  deps.subscribe((e) => {
    try {
      if (closed) return;
      if (e.type === "status") onStatus(e.serverId);
      else onLog(e);
    } catch (err) {
      log(`ws event handling failed: ${errMsg(err)}`);
    }
  });

  async function subscribeLogs(c: Client, id: string): Promise<void> {
    let currentRunId: string | null;
    try {
      currentRunId = repo.get(id).currentRunId;
    } catch {
      return; // unknown server
    }
    if (!c.subs.has(id) && c.subs.size >= MAX_SUBS) return;
    const sub: LogSub = { ready: false, buffer: [] };
    c.subs.set(id, sub);
    // A running install/update logs to its own run, so show that. A failed job's log only stands in when the game has no run.
    const job = deps.job?.(id) ?? null;
    let runId: string | null = (job?.state === "running" ? job.runId : null) ?? deps.state(id).runId ?? currentRunId ?? job?.runId ?? null;
    if (!runId) runId = listRuns(logsDir, id)[0]?.runId ?? null;
    let lines: string[] = [];
    if (runId) {
      try {
        lines = await readTail(path.join(logsDir, id, runId, "console.log"), HISTORY_LINES);
      } catch (e) {
        log(`Reading log history for ${id} failed: ${errMsg(e)}`);
      }
    }
    if (c.subs.get(id) !== sub) return; // unsubscribed (or resubscribed) meanwhile
    send(c, { type: "logHistory", serverId: id, runId, lines });
    sub.ready = true;
    for (const m of sub.buffer.splice(0)) send(c, m);
  }

  function onMessage(c: Client, data: unknown): void {
    let msg: unknown;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;
    const { type, serverId } = msg as { type?: unknown; serverId?: unknown };
    if (typeof serverId !== "string" || serverId.length > 100) return;
    if (type === "subscribeLogs") {
      subscribeLogs(c, serverId).catch((e: unknown) => log(`subscribeLogs failed: ${errMsg(e)}`));
    } else if (type === "unsubscribeLogs") {
      c.subs.delete(serverId);
    }
  }

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const c: Client = { ws, subs: new Map(), alive: true, remote: remoteOf(req) };
    clients.set(ws, c);
    ws.on("error", () => undefined);
    ws.on("close", () => {
      c.subs.clear();
      clients.delete(ws);
    });
    ws.on("pong", () => {
      c.alive = true;
    });
    ws.on("message", (data, isBinary) => {
      try {
        if (!isBinary) onMessage(c, data);
      } catch (e) {
        log(`ws message handling failed: ${errMsg(e)}`);
      }
    });
    try {
      for (const rec of repo.list()) {
        const m = statusMsg(rec.id);
        if (m) send(c, m);
      }
    } catch (e) {
      log(`ws initial status failed: ${errMsg(e)}`);
    }
  });
  wss.on("error", (e) => log(`ws server error: ${errMsg(e)}`));

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    socket.on("error", () => undefined);
    try {
      let pathname = "";
      try {
        pathname = new URL(req.url ?? "", "http://x").pathname;
      } catch {
        // malformed
      }
      if (closed || pathname !== WS_PATH) return refuse(socket, 404);
      const host = req.headers.host;
      const origin = req.headers.origin;
      if (!isAllowedHost(host, machine) || !isAllowedOrigin(origin, host) || !isAllowed(remoteOf(req), settings.get().allowlist)) {
        return refuse(socket, 403);
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } catch (e) {
      log(`ws upgrade failed: ${errMsg(e)}`);
      socket.destroy();
    }
  };
  server.on("upgrade", onUpgrade);

  const tickTimer = setInterval(tick, deps.tickMs ?? TICK_MS);
  tickTimer.unref();
  const pingTimer = setInterval(() => {
    for (const c of clients.values()) {
      try {
        if (!c.alive) {
          c.ws.terminate();
          continue;
        }
        c.alive = false;
        c.ws.ping();
      } catch {
        // ignore
      }
    }
  }, PING_MS);
  pingTimer.unref();

  return {
    notify(e) {
      try {
        if (closed) return;
        if (e.type === "removed") {
          pending.delete(e.serverId);
          sentThisTick.delete(e.serverId);
          for (const c of clients.values()) c.subs.delete(e.serverId);
          broadcast({ type: "removed", serverId: e.serverId });
        } else if (e.type === "changed") {
          sendStatusNow(e.serverId);
        } else {
          const list = settings.get().allowlist;
          for (const c of [...clients.values()]) {
            if (isAllowed(c.remote, list)) continue;
            try {
              c.ws.terminate();
            } catch {
              // ignore
            }
            clients.delete(c.ws);
          }
          for (const rec of repo.list()) sendStatusNow(rec.id);
        }
      } catch (err) {
        log(`ws notify failed: ${errMsg(err)}`);
      }
    },
    clientCount: () => clients.size,
    close() {
      closed = true;
      clearInterval(tickTimer);
      clearInterval(pingTimer);
      server.off("upgrade", onUpgrade);
      for (const c of clients.values()) {
        try {
          c.ws.terminate();
        } catch {
          // ignore
        }
      }
      clients.clear();
      wss.close();
    },
  };
}
