import dgram from "node:dgram";
import net from "node:net";
import type { PortClash, PortSpec } from "@skali/shared";

/** true = the port is free. */
export type PortProbe = (port: number, protocol: "udp" | "tcp") => Promise<boolean>;

export const defaultPortProbe: PortProbe = (port, protocol) =>
  new Promise<boolean>((resolve) => {
    if (protocol === "tcp") {
      const s = net.createServer();
      s.once("error", () => resolve(false));
      s.listen(port, "0.0.0.0", () => s.close(() => resolve(true)));
    } else {
      const s = dgram.createSocket("udp4");
      s.once("error", () => {
        try {
          s.close();
        } catch {
          /* already closed */
        }
        resolve(false);
      });
      s.bind(port, "0.0.0.0", () => s.close(() => resolve(true)));
    }
  });

export async function findPortClashes(
  ports: PortSpec[],
  others: { name: string; ports: PortSpec[] }[],
  probe: PortProbe = defaultPortProbe,
): Promise<PortClash[]> {
  const out: PortClash[] = [];
  const seen = new Set<string>();
  for (const p of ports) {
    const key = `${p.protocol}:${p.port}`;
    if (seen.has(key)) {
      if (!out.some((c) => c.port === p.port && c.protocol === p.protocol)) out.push({ port: p.port, protocol: p.protocol, reason: "Listed twice" });
      continue;
    }
    seen.add(key);
    const other = others.find((o) => o.ports.some((q) => q.port === p.port && q.protocol === p.protocol));
    if (other) {
      out.push({ port: p.port, protocol: p.protocol, reason: `Used by ${other.name}` });
      continue;
    }
    if (!(await probe(p.port, p.protocol))) {
      out.push({ port: p.port, protocol: p.protocol, reason: "Something on this PC is already using it" });
    }
  }
  return out;
}
