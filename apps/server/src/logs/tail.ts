import { EventEmitter } from "node:events";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

const CHUNK = 64 * 1024;
const MAX_TAIL_BYTES = 8 * 1024 * 1024;

function open(file: string, flags: string): Promise<number> {
  return new Promise((resolve, reject) =>
    fs.open(file, flags, (e, fd) => (e ? reject(e) : resolve(fd))),
  );
}
function close(fd: number): Promise<void> {
  return new Promise((resolve) => fs.close(fd, () => resolve()));
}
function fstat(fd: number): Promise<fs.Stats> {
  return new Promise((resolve, reject) =>
    fs.fstat(fd, (e, s) => (e ? reject(e) : resolve(s))),
  );
}
/** Reads exactly `length` bytes (or until EOF) at `position`. Goes through fs.read. */
function readAt(fd: number, length: number, position: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const buf = Buffer.alloc(length);
    fs.read(fd, buf, 0, length, position, (e, n) => (e ? reject(e) : resolve(buf.subarray(0, n))));
  });
}

/** Last `maxLines` lines of a file, reading backwards in 64 KiB chunks. */
export async function readTail(file: string, maxLines = 500): Promise<string[]> {
  if (maxLines <= 0) return [];
  let fd: number;
  try {
    fd = await open(file, "r");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  try {
    let pos = (await fstat(fd)).size;
    const chunks: Buffer[] = [];
    let newlines = 0;
    let total = 0;
    // Need maxLines+1 newlines so the first kept line is known to be complete
    // (the trailing terminator, if any, counts as one).
    while (pos > 0 && newlines <= maxLines && total < MAX_TAIL_BYTES) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = await readAt(fd, len, pos);
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) newlines++;
      total += buf.length;
      chunks.unshift(buf);
    }
    let all = Buffer.concat(chunks);
    if (pos > 0) {
      // The head may start mid-line (and mid-character); drop through the first \n.
      const nl = all.indexOf(0x0a);
      if (nl >= 0) all = all.subarray(nl + 1);
    }
    const lines = all.toString("utf8").split("\n").map((l) => l.replace(/\r$/, ""));
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-maxLines);
  } finally {
    await close(fd);
  }
}

export class FileTailer extends EventEmitter {
  private pos = 0;
  private started = false;
  private positioned = false;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private inflight: Promise<void> | null = null;
  private decoder = new StringDecoder("utf8");
  private partial = "";
  private readonly fromStart: boolean;
  private readonly pollMs: number;

  constructor(
    private readonly path: string,
    opts: { fromStart?: boolean; pollMs?: number } = {},
  ) {
    super();
    this.fromStart = opts.fromStart ?? true;
    this.pollMs = opts.pollMs ?? 250;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule(0);
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Waits for any poll in flight, does one last poll (emitting what is new), then stops. */
  async drain(): Promise<void> {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    try {
      await this.inflight;
      await this.poll();
    } finally {
      this.stop();
    }
  }

  private schedule(ms: number): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.inflight = this.poll();
    }, ms);
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.started) return;
    this.polling = true;
    let out: string[] = [];
    try {
      out = await this.readNew();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT" && this.listenerCount("error") > 0) {
        this.emit("error", e);
      }
    } finally {
      this.polling = false;
      this.schedule(this.pollMs);
    }
    // Emitted outside the try so listener exceptions surface instead of being swallowed.
    if (out.length && this.started) this.emit("lines", out);
  }

  private async readNew(): Promise<string[]> {
    const fd = await open(this.path, "r");
    try {
      const size = (await fstat(fd)).size;
      if (!this.positioned) {
        this.positioned = true;
        this.pos = this.fromStart ? 0 : size;
      } else if (size < this.pos) {
        this.pos = 0;
        this.decoder = new StringDecoder("utf8");
        this.partial = "";
      }
      const out: string[] = [];
      while (this.pos < size && this.started) {
        const buf = await readAt(fd, Math.min(CHUNK, size - this.pos), this.pos);
        if (buf.length === 0) break;
        this.pos += buf.length;
        const parts = (this.partial + this.decoder.write(buf)).split("\n");
        this.partial = parts.pop() ?? "";
        for (const p of parts) out.push(p.replace(/\r$/, ""));
      }
      return out;
    } finally {
      await close(fd);
    }
  }
}
