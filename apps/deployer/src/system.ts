import path from 'node:path';
import type { DeployerConfig } from './config.js';
import { spawnLines } from './spawn-lines.js';

export { needsShell, shellCommandLine } from './spawn-lines.js';

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>;
  onLine?: (line: string) => void;
  timeoutMs?: number;
}

/**
 * What `nssm status` says. `paused` is how NSSM shows an app it is waiting to restart (a crash loop); `other` is any
 * output we don't recognise. Only `stopped` (and `missing`) ever count as stopped.
 */
export type ServiceStatus = 'running' | 'stopped' | 'missing' | 'paused' | 'start_pending' | 'stop_pending' | 'other';

export interface HttpReply {
  status: number;
  body: string;
}

export interface System {
  run(cmd: string, args: string[], opts?: RunOptions): Promise<void>;
  serviceStop(name: string): Promise<void>;
  serviceStart(name: string): Promise<void>;
  serviceRestart(name: string): Promise<void>;
  serviceStatus(name: string): Promise<ServiceStatus>;
  healthy(url: string, timeoutMs: number): Promise<boolean>;
  /** One GET; rejects when unreachable or past timeoutMs. The health check and the busy-wait share it. */
  httpGet(url: string, timeoutMs: number): Promise<HttpReply>;
}

/** A plain GET with a timeout, answering status and body text. */
export async function fetchGet(url: string, timeoutMs: number): Promise<HttpReply> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return { status: res.status, body: await res.text() };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pure: interpret `nssm status` output (nssm may emit UTF-16, so NULs are ignored). */
export function parseNssmStatus(output: string): ServiceStatus {
  const text = output.replace(/\0/g, '');
  if (text.includes('does not exist')) return 'missing';
  if (text.includes('SERVICE_RUNNING')) return 'running';
  if (text.includes('SERVICE_STOPPED')) return 'stopped';
  if (text.includes('SERVICE_PAUSED')) return 'paused';
  if (text.includes('SERVICE_START_PENDING')) return 'start_pending';
  if (text.includes('SERVICE_STOP_PENDING')) return 'stop_pending';
  return 'other'; // unrecognised (other pending states, access denied, ...): never treat as stopped
}

/** Polls until the service is stopped (or gone); running, paused, pending and unknown states keep it waiting. */
export async function waitUntilStopped(
  status: () => Promise<ServiceStatus>,
  name: string,
  timeoutMs = 30_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await status();
    if (s === 'stopped' || s === 'missing') return;
    await sleep(intervalMs);
  }
  throw new Error(`${name} did not stop within ${Math.round(timeoutMs / 1000)} s`);
}

/**
 * Idempotent stop: nothing to do when already stopped or gone. Any other state except stop-pending gets `nssm stop`:
 * running, paused (NSSM waiting to restart a crash-looping app), start-pending and unrecognised. A failed stop is not
 * fatal (a start-pending service may not accept one yet): polling goes on, and the stop is sent again every `retryMs`
 * while the service still isn't stopping. Only stopped or missing count as done; past `timeoutMs` it throws.
 */
export async function stopService(
  status: () => Promise<ServiceStatus>,
  nssmStop: () => Promise<void>,
  name: string,
  timeoutMs = 30_000,
  intervalMs = 500,
  retryMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastStop: number | undefined;
  let lastError: unknown;
  for (;;) {
    const s = await status();
    if (s === 'stopped' || s === 'missing') return;
    const now = Date.now();
    if (now >= deadline) break;
    if (s !== 'stop_pending' && (lastStop === undefined || now - lastStop >= retryMs)) {
      lastStop = now;
      try {
        await nssmStop();
        continue; // read the status again straight away
      } catch (e) {
        lastError = e; // e.g. not accepting a stop while start-pending: keep polling and retry
      }
    }
    await sleep(intervalMs);
  }
  throw new Error(`${name} did not stop within ${Math.round(timeoutMs / 1000)} s`, { cause: lastError });
}

export function realSystem(bin: DeployerConfig['bin'], httpGet: System['httpGet'] = fetchGet): System {
  const run: System['run'] = async (cmd, args, opts) => {
    const code = await spawnLines(cmd, args, opts);
    if (code !== 0) throw new Error(`${path.basename(cmd)} exited ${code}`);
  };

  const serviceStatus: System['serviceStatus'] = async (name) => {
    let out = '';
    await spawnLines(bin.nssm, ['status', name], { onLine: (l) => (out += `${l}\n`) });
    return parseNssmStatus(out);
  };

  return {
    run,
    serviceStatus,
    serviceStart: (name) => run(bin.nssm, ['start', name]),
    serviceRestart: (name) => run(bin.nssm, ['restart', name]),
    serviceStop: (name) =>
      stopService(
        () => serviceStatus(name),
        () => run(bin.nssm, ['stop', name]),
        name,
      ),
    httpGet,
    async healthy(url, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        try {
          const res = await httpGet(url, Math.max(250, Math.min(5000, deadline - Date.now())));
          if (res.status >= 200 && res.status < 300) return true;
        } catch {
          // not up yet
        }
        if (Date.now() + 1000 >= deadline) return false;
        await sleep(1000);
      }
    },
  };
}
