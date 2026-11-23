import dgram from "node:dgram";

const REQUEST = Buffer.concat([
  Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]),
  Buffer.from("Source Engine Query\0", "ascii"),
]);

function parseInfo(msg: Buffer): { name: string; players: number; maxPlayers: number } | null {
  // header(4) 0x49 protocol(1) name\0 map\0 folder\0 game\0 id(int16) players max
  if (msg.length < 6 || msg.readInt32LE(0) !== -1 || msg[4] !== 0x49) return null;
  let pos = 6;
  const strings: string[] = [];
  for (let i = 0; i < 4; i++) {
    const end = msg.indexOf(0, pos);
    if (end < 0) return null;
    strings.push(msg.subarray(pos, end).toString("utf8"));
    pos = end + 1;
  }
  pos += 2;
  if (pos + 2 > msg.length) return null;
  return { name: strings[0]!, players: msg[pos]!, maxPlayers: msg[pos + 1]! };
}

/** Queries a Steam A2S_INFO endpoint. Resolves null on timeout or an unparseable reply. */
export function queryA2SInfo(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<{ name: string; players: number; maxPlayers: number } | null> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let done = false;
    const finish = (v: { name: string; players: number; maxPlayers: number } | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.close();
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    sock.on("error", () => finish(null));
    sock.on("message", (msg) => {
      if (msg.length >= 9 && msg.readInt32LE(0) === -1 && msg[4] === 0x41) {
        sock.send(Buffer.concat([REQUEST, msg.subarray(5, 9)]), port, host, (err) => {
          if (err) finish(null);
        });
        return;
      }
      finish(parseInfo(msg));
    });
    sock.send(REQUEST, port, host, (err) => {
      if (err) finish(null);
    });
  });
}
