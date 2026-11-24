export interface ShutdownDeps {
  /** Only `shutdown()` is ever called: it drops timers and tailers. Games keep running. */
  supervisor: { shutdown(): void };
  hub: () => { close(): void } | null;
  server: { close(cb?: (err?: Error) => void): unknown; closeAllConnections?(): void };
  db?: { close(): void };
  log: (msg: string) => void;
  exit: (code: number) => void;
  /** Exit anyway if the HTTP server hasn't closed by then. */
  forceAfterMs?: number;
}

const errText = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

/** Returns the signal handler. Runs once; later calls are ignored. Never stops game servers. */
export function createShutdown(deps: ShutdownDeps): (signal: string) => void {
  let started = false;
  let exited = false;
  const finish = () => {
    if (exited) return;
    exited = true;
    try {
      deps.db?.close();
    } catch {
      // ignore
    }
    deps.exit(0);
  };
  return (signal) => {
    if (started) return;
    started = true;
    deps.log(`${signal} received; shutting down (game servers keep running)`);
    try {
      deps.supervisor.shutdown();
    } catch (e) {
      deps.log(`supervisor shutdown failed: ${errText(e)}`);
    }
    try {
      deps.hub()?.close();
    } catch (e) {
      deps.log(`ws hub close failed: ${errText(e)}`);
    }
    try {
      deps.server.close(() => finish());
      deps.server.closeAllConnections?.();
    } catch (e) {
      deps.log(`HTTP server close failed: ${errText(e)}`);
      finish();
      return;
    }
    setTimeout(finish, deps.forceAfterMs ?? 5_000).unref();
  };
}
