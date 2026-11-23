import dgram from "node:dgram";

export interface FakeA2S {
  port: number;
  received: Buffer[];
  close(): Promise<void>;
}

const HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function infoReply(name: string, players: number, max: number): Buffer {
  const z = (s: string) => Buffer.concat([Buffer.from(s, "utf8"), Buffer.from([0])]);
  return Buffer.concat([
    HEADER,
    Buffer.from([0x49, 17]),
    z(name),
    z("map"),
    z("folder"),
    z("game"),
    Buffer.from([0x34, 0x12, players, max]),
    Buffer.from([0, 0x64, 0x6c, 0, 0]),
  ]);
}

/** challenge: require the 4-byte challenge echo. silent: never reply. */
export async function startFakeA2S(opts: {
  name?: string;
  players?: number;
  maxPlayers?: number;
  challenge?: boolean;
  silent?: boolean;
}): Promise<FakeA2S> {
  const received: Buffer[] = [];
  const challenge = Buffer.from([1, 2, 3, 4]);
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    received.push(msg);
    if (opts.silent) return;
    const hasChallenge = msg.length > 4 + 1 + 20 && msg.subarray(msg.length - 4).equals(challenge);
    if (opts.challenge && !hasChallenge) {
      sock.send(Buffer.concat([HEADER, Buffer.from([0x41]), challenge]), rinfo.port, rinfo.address);
      return;
    }
    sock.send(infoReply(opts.name ?? "Valheim", opts.players ?? 3, opts.maxPlayers ?? 10), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
  return {
    port: sock.address().port,
    received,
    close: () => new Promise<void>((r) => sock.close(() => r())),
  };
}
