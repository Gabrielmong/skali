import { describe, expect, it, vi } from "vitest";
import { createShutdown } from "../src/shutdown.js";

function setup(serverCloses = true) {
  const supervisor = { shutdown: vi.fn(), stop: vi.fn(), restart: vi.fn() };
  const hub = { close: vi.fn() };
  let closeCb: (() => void) | undefined;
  const server = {
    close: vi.fn((cb?: () => void) => { closeCb = cb; if (serverCloses) cb?.(); }),
    closeAllConnections: vi.fn(),
  };
  const db = { close: vi.fn() };
  const exit = vi.fn<(code: number) => void>();
  const logs: string[] = [];
  const shutdown = createShutdown({ supervisor, hub: () => hub, server, db, exit, log: (m) => logs.push(m), forceAfterMs: 20 });
  return { supervisor, hub, server, db, exit, logs, shutdown, closeCb: () => closeCb?.() };
}

describe("createShutdown", () => {
  it("closes the server and hub, never stops games, exits 0 once", async () => {
    const t = setup();
    t.shutdown("SIGTERM");
    t.shutdown("SIGINT");
    t.shutdown("SIGBREAK");
    await new Promise((r) => setTimeout(r, 50)); // force timer fires too
    expect(t.supervisor.shutdown).toHaveBeenCalledTimes(1);
    expect(t.supervisor.stop).not.toHaveBeenCalled();
    expect(t.supervisor.restart).not.toHaveBeenCalled();
    expect(t.hub.close).toHaveBeenCalledTimes(1);
    expect(t.server.close).toHaveBeenCalledTimes(1);
    expect(t.server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(t.db.close).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledTimes(1);
    expect(t.exit).toHaveBeenCalledWith(0);
    expect(t.logs[0]).toMatch(/SIGTERM.*game servers keep running/);
  });
  it("exits via the fallback timer when the server never closes, and only once", async () => {
    const t = setup(false);
    t.shutdown("SIGINT");
    expect(t.exit).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.exit).toHaveBeenCalledTimes(1);
    t.closeCb();
    expect(t.exit).toHaveBeenCalledTimes(1);
  });
  it("still exits when a step throws", async () => {
    const t = setup();
    t.supervisor.shutdown.mockImplementation(() => { throw new Error("x"); });
    t.hub.close.mockImplementation(() => { throw new Error("y"); });
    t.shutdown("SIGTERM");
    expect(t.exit).toHaveBeenCalledWith(0);
    expect(t.logs.join("\n")).toMatch(/supervisor shutdown failed/);
  });
});
