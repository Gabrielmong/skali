import { type HttpReply, type RunOptions, type ServiceStatus, type System, stopService } from '../src/system.js';

export interface Call {
  op: 'run' | 'stop' | 'start' | 'restart' | 'status' | 'healthy' | 'http';
  cmd?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  url?: string;
}

/**
 * Models nssm: start/restart leave the service running and stop leaves it stopped (from running, or paused: NSSM
 * waiting to restart a crashed app), and a raw `nssm stop` on any other state fails.
 * serviceStop goes through the same stopService logic as realSystem.
 */
export class FakeSystem implements System {
  calls: Call[] = [];
  healthResult = true;
  /** Consumed one per health check before falling back to `healthResult`. */
  healthResults: boolean[] = [];
  serviceState: ServiceStatus = 'running';
  /** What httpGet answers (an Error rejects, like an unreachable server). Default: Skáli idle. */
  http: (url: string) => HttpReply | Error = () => ({ status: 200, body: JSON.stringify({ busy: false, reasons: [] }) });
  /** Output lines a run call streams through `onLine`. */
  output?: (c: Call) => string[];
  private failures: { pred: (c: Call) => boolean; error: Error }[] = [];
  private hook?: (c: Call) => void | Promise<void>;

  /** Applies to every call, service operations included. */
  failWhen(pred: (c: Call) => boolean, error = new Error('fake failure')): void {
    this.failures.push({ pred, error });
  }

  onRun(hook: (c: Call) => void | Promise<void>): void {
    this.hook = hook;
  }

  private record(call: Call): void {
    this.calls.push(call);
    const failure = this.failures.find((f) => f.pred(call));
    if (failure) throw failure.error;
  }

  async run(cmd: string, args: string[], opts: RunOptions = {}): Promise<void> {
    const call: Call = { op: 'run', cmd, args, cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs };
    this.record(call);
    for (const line of this.output?.(call) ?? []) opts.onLine?.(line);
    await this.hook?.(call);
  }

  async serviceStop(name: string): Promise<void> {
    await stopService(
      () => this.serviceStatus(name),
      async () => {
        this.record({ op: 'stop', cmd: name });
        if (this.serviceState !== 'running' && this.serviceState !== 'paused') {
          throw new Error('nssm exited 1 (service has not been started)');
        }
        this.serviceState = 'stopped';
      },
      name,
      50,
      1,
    );
  }

  async serviceStart(name: string): Promise<void> {
    this.record({ op: 'start', cmd: name });
    this.serviceState = 'running';
  }

  async serviceRestart(name: string): Promise<void> {
    this.record({ op: 'restart', cmd: name });
    this.serviceState = 'running';
  }

  async serviceStatus(name: string): Promise<ServiceStatus> {
    this.record({ op: 'status', cmd: name });
    return this.serviceState;
  }

  async httpGet(url: string, timeoutMs: number): Promise<HttpReply> {
    this.record({ op: 'http', url, timeoutMs });
    const reply = this.http(url);
    if (reply instanceof Error) throw reply;
    return reply;
  }

  async healthy(url: string): Promise<boolean> {
    this.record({ op: 'healthy', url });
    return this.healthResults.shift() ?? this.healthResult;
  }
}
