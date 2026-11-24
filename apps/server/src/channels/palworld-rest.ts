export class PalworldRestError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Palworld REST error ${status}: ${body}`);
    this.name = "PalworldRestError";
  }
}

export interface PalworldRest {
  info(): Promise<{ version: string; servername: string }>;
  players(): Promise<{ name: string; playerId: string; userId: string }[]>;
  metrics(): Promise<{ currentplayernum: number; maxplayernum: number }>;
  announce(message: string): Promise<void>;
  save(): Promise<void>;
  shutdown(waittime: number, message: string): Promise<void>;
  kick(userid: string, message?: string): Promise<void>;
  ban(userid: string, message?: string): Promise<void>;
  unban(userid: string): Promise<void>;
}

export function createPalworldRest(opts: {
  host?: string;
  port: number;
  password: string;
  timeoutMs?: number;
  /** Saving a big world can take a while; kept under the supervisor's 30 s adapter-stop cap. */
  saveTimeoutMs?: number;
}): PalworldRest {
  const base = `http://${opts.host ?? "127.0.0.1"}:${opts.port}/v1/api/`;
  const auth = "Basic " + Buffer.from(`admin:${opts.password}`).toString("base64");
  const timeoutMs = opts.timeoutMs ?? 5000;
  const saveTimeoutMs = opts.saveTimeoutMs ?? 20_000;

  async function call(method: "GET" | "POST", path: string, body?: unknown, timeout = timeoutMs): Promise<string> {
    const headers: Record<string, string> = { Authorization: auth };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    if (!res.ok) throw new PalworldRestError(res.status, text);
    return text;
  }
  const get = async <T>(path: string): Promise<T> => JSON.parse(await call("GET", path)) as T;
  const post = async (path: string, body?: unknown, timeout?: number): Promise<void> => {
    await call("POST", path, body, timeout);
  };

  return {
    info: () => get("info"),
    players: async () => (await get<{ players: { name: string; playerId: string; userId: string }[] }>("players")).players,
    metrics: () => get("metrics"),
    announce: (message) => post("announce", { message }),
    save: () => post("save", undefined, saveTimeoutMs),
    shutdown: (waittime, message) => post("shutdown", { waittime, message }),
    kick: (userid, message = "") => post("kick", { userid, message }),
    ban: (userid, message = "") => post("ban", { userid, message }),
    unban: (userid) => post("unban", { userid }),
  };
}
