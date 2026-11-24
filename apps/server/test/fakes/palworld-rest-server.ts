import http from "node:http";

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | undefined;
  body: string;
}
export interface FakePalworld {
  port: number;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakePalworld(
  password: string,
  opts: { failPaths?: string[]; delayMs?: Record<string, number> } = {},
): Promise<FakePalworld> {
  const requests: RecordedRequest[] = [];
  const expected = "Basic " + Buffer.from(`admin:${password}`).toString("base64");
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (req.headers.authorization !== expected) {
        res.writeHead(401, { "content-type": "text/plain" });
        res.end("Unauthorized");
        return;
      }
      const delay = opts.delayMs?.[req.url ?? ""] ?? 0;
      if (opts.failPaths?.includes(req.url ?? "")) {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      if (delay) {
        setTimeout(() => {
          res.writeHead(200);
          res.end("");
        }, delay);
        return;
      }
      const json = (o: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      switch (`${req.method} ${req.url}`) {
        case "GET /v1/api/info":
          return json({ version: "v0.5.0", servername: "Test" });
        case "GET /v1/api/players":
          return json({ players: [{ name: "A", playerId: "p1", userId: "steam_1" }] });
        case "GET /v1/api/metrics":
          return json({ currentplayernum: 2, maxplayernum: 16 });
        default:
          if (req.method === "POST") {
            res.writeHead(200);
            return res.end("");
          }
          res.writeHead(404);
          res.end("nope");
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as { port: number }).port,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
