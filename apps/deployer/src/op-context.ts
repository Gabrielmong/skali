import path from 'node:path';
import type { DeployerConfig, Paths } from './config.js';
import { EventLog } from './event-log.js';
import type { History } from './history.js';
import { makeRedactor } from './redact.js';
import type { System } from './system.js';

export interface OpContext {
  config: DeployerConfig;
  paths: Paths;
  sys: System;
  history: History;
  /** Child-only env for git (never argv: command lines are visible to other users): GIT_CONFIG_* carrying http.https://github.com/.extraheader (sent to github.com only). */
  gitEnv(): Record<string, string>;
  /**
   * Child-only env for every other git call on the repo (archive, rev-parse, log): safe.directory for <root>/repo (git
   * refuses a repo owned by Administrators when it runs as SYSTEM, "dubious ownership") and no prompts. No token.
   */
  gitLocalEnv(): Record<string, string>;
  /** Values never to write into a log: the GitHub token and the API token. Build it with opSecrets. */
  secrets(): string[];
  now(): Date;
}

/** For OpContext.secrets(): the tokens. */
export function opSecrets(tokens: string[]): string[] {
  return [...tokens];
}

export const short = (sha: string) => sha.slice(0, 7);

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export interface OpLog {
  log: EventLog;
  redact: (s: string) => string;
}

/** The event's log file `<eventLogs>/<id>.log`, redacting every secret. */
export function openLog(ctx: OpContext, eventId: string): OpLog {
  let secrets: string[];
  try {
    secrets = ctx.secrets();
  } catch {
    secrets = []; // the built-in token patterns still apply
  }
  const redact = makeRedactor(secrets);
  return { log: new EventLog(path.join(ctx.paths.eventLogs, `${eventId}.log`), redact), redact };
}

/** Skáli's health endpoint, checked after every switch or restart. */
export function healthUrl(config: Pick<DeployerConfig, 'appPort'>): string {
  return `http://127.0.0.1:${config.appPort}/api/games`;
}
