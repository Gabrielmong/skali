import { spawn } from "node:child_process";

/** Wrapper around tools/SkaliHelper: one helper process per call, JSON in on stdin, JSON out on stdout. */

export interface LaunchRequest {
  exe: string;
  args: string[];
  cwd: string;
  /** Log file; the game's stdout and stderr are appended to it. */
  stdoutPath: string;
  /** Overrides on top of the launching user's environment. */
  env?: Record<string, string>;
  /** Run as this local user instead of the service's own account. */
  user?: { name: string; password: string };
}

export interface ProcStat {
  pid: number;
  alive: boolean;
  /** Process creation time, ISO 8601 UTC with ms. */
  startTime?: string;
  /** CPU time of the process and all its descendants. */
  cpuMs?: number;
  /** Working set of the process and all its descendants. */
  memBytes?: number;
}

export interface Helper {
  launch(r: LaunchRequest): Promise<{ pid: number; startTime: string }>;
  stats(pids: number[]): Promise<ProcStat[]>;
  ctrlC(pid: number): Promise<void>;
  kill(pid: number): Promise<boolean>;
  ensureUser(name: string): Promise<{ created: boolean; password: string }>;
}

export class HelperError extends Error {
  override name = "HelperError";
}

export function createHelper(helperPath: string): Helper {
  const call = <T>(verb: string, request: unknown) => runHelper<T>(helperPath, verb, request);
  return {
    launch: (r) => call("launch", r),
    stats: async (pids) => (await call<{ processes: ProcStat[] }>("stats", { pids })).processes,
    ctrlC: async (pid) => {
      await call("ctrlc", { pid });
    },
    kill: async (pid) => (await call<{ killed: boolean }>("kill", { pid })).killed,
    ensureUser: (name) => call("ensure-user", { name }),
  };
}

function runHelper<T>(helperPath: string, verb: string, request: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    // detached: keeps the helper (and so the games it launches) out of libuv's kill-on-close job.
    const child = spawn(helperPath, [verb], { detached: true, windowsHide: true, stdio: "pipe" });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (b: Buffer) => stdout.push(b));
    child.stderr.on("data", (b: Buffer) => stderr.push(b));
    child.on("error", (err) => reject(new HelperError(`failed to run SkaliHelper ${verb}: ${err.message}`)));
    child.on("close", (code) => {
      const out = Buffer.concat(stdout).toString("utf8").trim();
      let parsed: unknown;
      try {
        parsed = out ? JSON.parse(out) : undefined;
      } catch {
        parsed = undefined;
      }
      const error = parsed && typeof parsed === "object" && "error" in parsed ? String(parsed.error) : undefined;
      if (code === 0 && parsed !== undefined && error === undefined) return resolve(parsed as T);
      const err = Buffer.concat(stderr).toString("utf8").trim();
      reject(new HelperError(error ?? (err || out || `SkaliHelper ${verb} exited with code ${code}`)));
    });
    child.stdin.on("error", () => {
      // The helper may exit before reading stdin (e.g. unknown verb); the close handler reports it.
    });
    child.stdin.end(JSON.stringify(request));
  });
}
