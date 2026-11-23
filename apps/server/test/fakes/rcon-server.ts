import net from "node:net";

export interface FakeRcon {
  port: number;
  close(): Promise<void>;
}

function packet(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, "ascii");
  const buf = Buffer.alloc(14 + b.length);
  buf.writeInt32LE(10 + b.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  b.copy(buf, 12);
  return buf;
}

/**
 * Fake Source RCON server. `silent` never replies. A command's reply is "reply:<command>". `splitReplies`
 * writes each reply in two chunks to exercise fragmentation. `emptyFirst` sends the empty RESPONSE_VALUE
 * before the AUTH_RESPONSE (Minecraft/Source behaviour).
 */
export async function startFakeRcon(opts: {
  password?: string;
  silent?: boolean;
  emptyFirst?: boolean;
  splitReplies?: boolean;
  /** Overrides the default "reply:<command>" reply body. */
  reply?: (command: string) => string;
}): Promise<FakeRcon> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    if (opts.silent) return;
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const size = buf.readInt32LE(0);
        if (buf.length < 4 + size) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + size - 2).toString("ascii");
        buf = buf.subarray(4 + size);
        if (type === 3) {
          if (opts.emptyFirst) sock.write(packet(id, 0, ""));
          sock.write(packet(body === opts.password ? id : -1, 2, ""));
        } else if (type === 2) {
          const reply = packet(id, 0, opts.reply ? opts.reply(body) : `reply:${body}`);
          if (opts.splitReplies) {
            sock.write(reply.subarray(0, 6));
            setTimeout(() => sock.write(reply.subarray(6)), 10);
          } else sock.write(reply);
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    port: (server.address() as net.AddressInfo).port,
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}
