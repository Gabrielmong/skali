import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class EventLog {
  constructor(
    private readonly file: string,
    private readonly redact: (s: string) => string,
  ) {
    mkdirSync(dirname(file), { recursive: true });
  }

  section(title: string): void {
    this.line(`▶ ${title}`);
  }

  /** Redacts the whole text first, so a secret spanning a line break (or CRLF) is still caught. */
  line(text: string): void {
    const lines = this.redact(text).split(/\r?\n/);
    appendFileSync(this.file, lines.map((l) => `${l}\n`).join(''));
  }

  ok(title: string, ms: number): void {
    this.line(`✔ ${title} (${Math.round(ms / 1000)}s)`);
  }

  fail(title: string, why: string): void {
    this.line(`✖ ${title}: ${why}`);
  }
}
