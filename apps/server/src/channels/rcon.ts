import net from "node:net";

export class RconAuthError extends Error {
  constructor(message = "RCON authentication failed") {
    super(message);
    this.name = "RconAuthError";
  }
}

export class RconTimeoutError extends Error {
  constructor(message = "RCON timed out") {
    super(message);
    this.name = "RconTimeoutError";
  }
}

const TYPE_RESPONSE = 0;
const TYPE_EXEC = 2;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_AUTH = 3;

interface RconPacket {
  id: number;
  type: number;
  body: string;
}

function encode(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, "ascii");
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

/** Source RCON client (Minecraft, Valheim mods, ...). One command in flight at a time. */
export class RconClient {
  private buffer = Buffer.alloc(0);
  private queue: RconPacket[] = [];
  private waiter: (() => void) | undefined;
  private failure: Error | undefined;
  private nextId = 1;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly socket: net.Socket,
    private readonly timeoutMs: number,
  ) {
    socket.on("data", (d) => {
      this.buffer = Buffer.concat([this.buffer, d]);
      this.parse();
    });
    socket.on("error", (e) => this.fail(e));
    socket.on("close", () => this.fail(new Error("RCON connection closed")));
  }

  static async connect(host: string, port: number, password: string, timeoutMs = 5000): Promise<RconClient> {
    const socket = new net.Socket();
    const client = new RconClient(socket, timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new RconTimeoutError("RCON connect timed out")), timeoutMs);
        socket.once("error", reject);
        socket.connect(port, host, () => {
          clearTimeout(timer);
          socket.off("error", reject);
          resolve();
        });
        socket.once("close", () => clearTimeout(timer));
      });
      socket.setNoDelay(true);
      await client.authenticate(password);
      return client;
    } catch (e) {
      client.close();
      throw e;
    }
  }

  exec(command: string): Promise<string> {
    const run = () => this.execOne(command);
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => undefined);
    return result;
  }

  close(): void {
    this.socket.destroy();
  }

  private newId(): number {
    const id = this.nextId;
    this.nextId = this.nextId >= 0x7fffffff ? 1 : this.nextId + 1;
    return id;
  }

  private async authenticate(password: string): Promise<void> {
    const id = this.newId();
    this.socket.write(encode(id, TYPE_AUTH, password));
    for (;;) {
      const p = await this.nextPacket();
      if (p.type === TYPE_RESPONSE) continue; // empty RESPONSE_VALUE some servers send first
      if (p.type === TYPE_AUTH_RESPONSE) {
        if (p.id === -1) throw new RconAuthError();
        return;
      }
    }
  }

  private async execOne(command: string): Promise<string> {
    const id = this.newId();
    this.socket.write(encode(id, TYPE_EXEC, command));
    for (;;) {
      const p = await this.nextPacket();
      if (p.type === TYPE_RESPONSE && p.id === id) return p.body;
    }
  }

  private parse(): void {
    while (this.buffer.length >= 4) {
      const size = this.buffer.readInt32LE(0);
      if (size < 10 || size > 8192) {
        this.fail(new Error(`Invalid RCON packet size ${size}`));
        return;
      }
      if (this.buffer.length < 4 + size) break;
      this.queue.push({
        id: this.buffer.readInt32LE(4),
        type: this.buffer.readInt32LE(8),
        body: this.buffer.subarray(12, 4 + size - 2).toString("ascii"),
      });
      this.buffer = this.buffer.subarray(4 + size);
    }
    this.waiter?.();
  }

  private fail(e: Error): void {
    this.failure ??= e;
    this.waiter?.();
  }

  private nextPacket(): Promise<RconPacket> {
    return new Promise<RconPacket>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new RconTimeoutError());
      }, this.timeoutMs);
      const check = (): boolean => {
        const p = this.queue.shift();
        if (p) {
          clearTimeout(timer);
          this.waiter = undefined;
          resolve(p);
          return true;
        }
        if (this.failure) {
          clearTimeout(timer);
          this.waiter = undefined;
          reject(this.failure);
          return true;
        }
        return false;
      };
      if (!check()) this.waiter = check as () => void;
    });
  }
}

export async function withRcon<T>(
  host: string,
  port: number,
  password: string,
  fn: (c: RconClient) => Promise<T>,
): Promise<T> {
  const client = await RconClient.connect(host, port, password);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}
