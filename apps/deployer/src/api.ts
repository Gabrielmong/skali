import { timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import { type Command, parseCommand } from './command.js';
import { readLog, readLogFrom } from './history.js';
import { OpError } from './op-error.js';

export interface ApiOptions {
  token: string;
  logsDir: string;
  port: number;
}

/** What the API needs from the deployer (the deployer class, added later, implements it). */
export interface DeployerApi {
  status(): Promise<unknown>;
  command(command: Command): Promise<{ eventId: string }>;
}

const BODY_LIMIT = 10 * 1024;
const HOST = '127.0.0.1';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const tooLarge = () => new HttpError(413, 'Body too large');

/** The JSON body, at most 10 KB: 413 as soon as it is known to be larger (the request is then cut off). */
function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > BODY_LIMIT) return reject(tooLarge());
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= BODY_LIMIT) return void chunks.push(chunk);
      req.off('data', onData);
      req.pause();
      reject(tooLarge());
    };
    req.on('data', onData);
    req.on('error', reject);
    req.on('end', () => {
      if (size > BODY_LIMIT) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Body is not JSON'));
      }
    });
  });
}

/** The decoded path segment, or a 404 when it doesn't decode. */
function segment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

/** `?from=<byte>`: undefined when absent, a 400 unless it is a whole number >= 0. */
function fromParam(url: URL): number | undefined {
  const raw = url.searchParams.get('from');
  if (raw === null) return undefined;
  if (!/^\d{1,15}$/.test(raw)) throw new HttpError(400, '"from" must be a byte offset');
  return Number(raw);
}

async function route(api: DeployerApi, opts: ApiOptions, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname;
  if (req.method === 'GET' && path === '/status') return send(res, 200, await api.status());
  const logMatch = /^\/events\/([^/]+)\/log$/.exec(path);
  if (req.method === 'GET' && logMatch) {
    const id = segment(logMatch[1]!);
    const from = fromParam(url);
    const body = from === undefined ? readLogBody(opts.logsDir, id) : readLogFrom(opts.logsDir, id, from);
    if (body === undefined) throw new HttpError(404, 'Not found');
    return send(res, 200, body);
  }
  if (req.method === 'POST' && path === '/command') {
    const command = parseCommand(await readJson(req));
    return send(res, 202, await api.command(command));
  }
  throw new HttpError(404, 'Not found');
}

function readLogBody(logsDir: string, id: string): { log: string } | undefined {
  const log = readLog(logsDir, id);
  return log === undefined ? undefined : { log };
}

export function createApi(api: DeployerApi, opts: ApiOptions): Server {
  return createServer((req, res) => {
    if (!authorized(req, opts.token)) {
      req.resume();
      return send(res, 401, { error: 'Unauthorized' });
    }
    route(api, opts, req, res).catch((e: unknown) => {
      if (e instanceof HttpError && e.status === 413) {
        res.once('finish', () => req.destroy()); // don't read the rest of an oversized body
        return send(res, 413, { error: e.message });
      }
      if (e instanceof OpError || e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error('API request failed:', e);
      send(res, 500, { error: 'Internal error' });
    });
  });
}

/** Listens on 127.0.0.1 only. */
export function startApi(api: DeployerApi, opts: ApiOptions): Promise<Server> {
  const server = createApi(api, opts);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, HOST, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}
