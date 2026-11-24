import path from 'node:path';
import type { EventLog } from './event-log.js';
import { type OpContext, errorText } from './op-context.js';
import { releaseDir } from './releases.js';

/** A failed step; the message reads "<Step> failed: <why>". */
export class StepError extends Error {
  constructor(
    readonly step: string,
    readonly why: string,
  ) {
    super(`${step} failed: ${why}`);
    this.name = 'StepError';
  }
}

/** Runs `fn` as one log section, timing it; a throw is logged and rethrown as a StepError. */
export async function step<T>(log: EventLog, title: string, fn: () => Promise<T> | T): Promise<T> {
  log.section(title);
  const started = Date.now();
  try {
    const result = await fn();
    log.ok(title, Date.now() - started);
    return result;
  } catch (e) {
    const why = e instanceof StepError ? e.why : errorText(e);
    log.fail(title, why);
    throw new StepError(title, why);
  }
}

interface LoggedRun {
  cwd?: string;
  env?: Record<string, string>;
  /** Kills the command (and its children) after this long; the step then fails. */
  timeoutMs?: number;
}

/** Runs a command, printing it and streaming its output into the event log. */
export function run(ctx: OpContext, log: EventLog, cmd: string, args: string[], opts: LoggedRun = {}): Promise<void> {
  log.line(`$ ${path.basename(cmd)} ${args.join(' ')}`);
  return ctx.sys.run(cmd, args, { cwd: opts.cwd, env: opts.env, timeoutMs: opts.timeoutMs, onLine: (l) => log.line(l) });
}

/** Runs `<release>\scripts\<name>.ps1` from that release. */
export function runScript(
  ctx: OpContext,
  log: EventLog,
  release: string,
  name: string,
  args: string[],
  timeoutMs: number,
): Promise<void> {
  const file = path.join(release, 'scripts', `${name}.ps1`);
  return run(ctx, log, ctx.config.bin.powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
    timeoutMs,
  });
}

/** Re-applies the NSSM settings the given release ships: `<release>\scripts\apply-service-settings.ps1 -Service Skali -Root <root> -Node <node>`. */
export function applySettings(ctx: OpContext, log: EventLog, sha: string): Promise<void> {
  const { serviceName, root, bin, stepTimeoutsMs } = ctx.config;
  const args = ['-Service', serviceName, '-Root', root, '-Node', bin.node];
  return runScript(ctx, log, releaseDir(ctx.paths, sha), 'apply-service-settings', args, stepTimeoutsMs.settings);
}
