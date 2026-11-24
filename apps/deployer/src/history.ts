import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readStored, writeStored } from './history-file.js';

export type EventKind = 'DEPLOY' | 'ROLLBACK' | 'RESTART' | 'PAUSE' | 'RESUME';
export type EventStatus = 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export interface DeployEvent {
  id: string;
  kind: EventKind;
  status: EventStatus;
  sha?: string;
  message?: string;
  by: string;
  startedAt: string;
  finishedAt?: string;
  detail?: string;
  /** The GitHub Actions run of the `CI` workflow for this commit, when there is one. */
  ciRunUrl?: string;
}

export interface DeployerState {
  running?: { sha: string; message: string; deployedAt: string };
  autoDeploy: { on: boolean; reason?: string };
  lastCheck?: { at: string; error?: string };
  failedShas: string[]; // never auto-retried
  skippedShas: string[]; // already recorded as SKIPPED (no duplicate events)
  releases: string[]; // full SHAs of kept successful releases, newest first
  /** The database's user_version as last read by a probe (always with Skáli stopped); rollback eligibility on the page uses it. */
  lastDbVersion?: number;
}

interface Stored {
  state: DeployerState;
  events: DeployEvent[]; // newest first
}

const defaults = (): Stored => ({
  state: { autoDeploy: { on: true }, failedShas: [], skippedShas: [], releases: [] },
  events: [],
});

export class History {
  private data: Stored;

  constructor(
    private readonly file: string,
    private readonly logsDir: string,
    private readonly maxEvents: number,
    private readonly now: () => Date,
  ) {
    mkdirSync(dirname(file), { recursive: true });
    mkdirSync(logsDir, { recursive: true });
    this.data = this.load();
  }

  state(): DeployerState {
    return this.data.state;
  }

  update(patch: Partial<DeployerState>): void {
    this.data.state = { ...this.data.state, ...patch };
    this.save();
  }

  events(): DeployEvent[] {
    return this.data.events;
  }

  start(e: Omit<DeployEvent, 'id' | 'startedAt' | 'status'>): DeployEvent {
    return this.add({ ...e, id: this.newId(), status: 'RUNNING', startedAt: this.now().toISOString() });
  }

  finish(id: string, status: Exclude<EventStatus, 'RUNNING'>, detail?: string): void {
    const ev = this.data.events.find((x) => x.id === id);
    if (!ev) return;
    ev.status = status;
    ev.finishedAt = this.now().toISOString();
    if (detail !== undefined) ev.detail = detail;
    this.save();
  }

  record(e: Omit<DeployEvent, 'id' | 'startedAt' | 'finishedAt'>): DeployEvent {
    const at = this.now().toISOString();
    return this.add({ ...e, id: this.newId(), startedAt: at, finishedAt: at });
  }

  private add(ev: DeployEvent): DeployEvent {
    this.data.events.unshift(ev);
    this.prune();
    this.save();
    return ev;
  }

  private prune(): void {
    const kept: DeployEvent[] = [];
    for (const ev of this.data.events) {
      if (kept.length < this.maxEvents || ev.status === 'RUNNING') {
        kept.push(ev);
      } else {
        rmSync(join(this.logsDir, `${ev.id}.log`), { force: true });
      }
    }
    this.data.events = kept;
  }

  private newId(): string {
    const stamp = this.now().toISOString().replace(/\D/g, '');
    return `${stamp}-${randomBytes(3).toString('hex')}`;
  }

  private load(): Stored {
    const base = defaults();
    const raw = readStored<Partial<Stored>>(this.file, this.now());
    if (!raw) return base;
    return { state: { ...base.state, ...raw.state }, events: raw.events ?? [] };
  }

  private save(): void {
    writeStored(this.file, this.data);
  }
}

/** History.newId's shape: ISO timestamp digits, "-", 3 random bytes as hex. */
const EVENT_ID = /^\d{17}-[0-9a-f]{6}$/;

/** The event's log, or undefined when there is none or `id` isn't an event id (so it can't escape logsDir). */
export function readLog(logsDir: string, id: string, maxLines = 2000): string | undefined {
  if (!EVENT_ID.test(id)) return undefined;
  const file = join(logsDir, `${id}.log`);
  if (!existsSync(file)) return undefined;
  return tailLines(readFileSync(file, 'utf8'), maxLines);
}

/** The last `max` lines of `text`, keeping its trailing newline. */
export function tailLines(text: string, max: number): string {
  const lines = text.split('\n');
  const trailing = lines[lines.length - 1] === '';
  const body = trailing ? lines.slice(0, -1) : lines;
  if (body.length <= max) return text;
  return body.slice(-max).join('\n') + (trailing ? '\n' : '');
}

/**
 * The event's log from byte `from` on, cut after its last newline (a line still being written is
 * left for the next read), with the byte offset to ask for next. undefined when there is no such log.
 */
export function readLogFrom(logsDir: string, id: string, from: number): { log: string; next: number } | undefined {
  if (!EVENT_ID.test(id)) return undefined;
  const file = join(logsDir, `${id}.log`);
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  if (from >= bytes.length) return { log: '', next: bytes.length };
  const end = bytes.lastIndexOf(0x0a) + 1;
  if (end <= from) return { log: '', next: from };
  return { log: bytes.subarray(from, end).toString('utf8'), next: end };
}
