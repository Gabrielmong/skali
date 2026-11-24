import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';

const parse = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/**
 * Reads history.json. A file that doesn't parse (a power cut mid-write) is moved to
 * `history.json.corrupt-<timestamp>` and reported; then `history.json.tmp` is used if it parses,
 * else undefined (start from defaults), so a bad file never keeps the deployer from starting.
 */
export function readStored<T>(file: string, now: Date): T | undefined {
  if (!existsSync(file)) return undefined;
  try {
    return parse<T>(file);
  } catch (e) {
    const aside = `${file}.corrupt-${now.toISOString().replace(/\D/g, '')}`;
    renameSync(file, aside);
    console.error(`history.json did not parse (${(e as Error).message}); moved it to ${aside}`);
  }
  try {
    return parse<T>(`${file}.tmp`);
  } catch {
    return undefined;
  }
}

/** Writes `<file>.tmp`, flushes it to disk, then renames it over the file. */
export function writeStored(file: string, data: unknown): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}
