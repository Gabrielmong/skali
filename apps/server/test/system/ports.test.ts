import net from "node:net";
import { describe, expect, it } from "vitest";
import type { PortSpec } from "@skali/shared";
import { findPortClashes, type PortProbe } from "../../src/system/ports.js";

const p = (port: number, protocol: "udp" | "tcp" = "udp"): PortSpec => ({ port, protocol, purpose: "x", forward: true });
const free: PortProbe = async () => true;

describe("findPortClashes", () => {
  it("reports a port used by another server", async () => {
    const r = await findPortClashes([p(25565, "tcp")], [{ name: "Survival", ports: [p(25565, "tcp")] }], free);
    expect(r).toEqual([{ port: 25565, protocol: "tcp", reason: "Used by Survival" }]);
  });
  it("same port, different protocol is no clash", async () => {
    expect(await findPortClashes([p(2456, "udp")], [{ name: "A", ports: [p(2456, "tcp")] }], free)).toEqual([]);
  });
  it("probe false means something else is using it", async () => {
    const r = await findPortClashes([p(8211)], [], async () => false);
    expect(r).toEqual([{ port: 8211, protocol: "udp", reason: "Something on this PC is already using it" }]);
  });
  it("duplicates inside the request are flagged", async () => {
    const r = await findPortClashes([p(1000), p(1000)], [], free);
    expect(r).toEqual([{ port: 1000, protocol: "udp", reason: "Listed twice" }]);
  });
  it("default probe sees a bound TCP port", async () => {
    const srv = net.createServer();
    await new Promise<void>((res) => srv.listen(0, "0.0.0.0", res));
    const port = (srv.address() as net.AddressInfo).port;
    try {
      const r = await findPortClashes([p(port, "tcp")], []);
      expect(r).toEqual([{ port, protocol: "tcp", reason: "Something on this PC is already using it" }]);
    } finally {
      await new Promise((res) => srv.close(res));
    }
  });
});
