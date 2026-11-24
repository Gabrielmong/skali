import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { busyUrl, waitUntilIdle } from '../src/busy.js';
import { type DeployFixture, deploySetup } from './deploy-fixture.js';

let f: DeployFixture;
beforeEach(() => {
  f = deploySetup();
});
afterEach(() => {
  vi.useRealTimers();
  f.cleanup();
});

const busy = (...reasons: string[]) => ({ status: 200, body: JSON.stringify({ busy: true, reasons }) });
const idle = { status: 200, body: JSON.stringify({ busy: false, reasons: [] }) };
const asks = () => f.sys.calls.filter((c) => c.op === 'http');

describe('waitUntilIdle', () => {
  it('asks Skáli on loopback port 4200', async () => {
    expect(busyUrl(f.ctx.config)).toBe('http://127.0.0.1:4200/api/deploys/busy');
    expect(await waitUntilIdle(f.ctx, f.log)).toBe('idle');
    expect(asks().map((c) => c.url)).toEqual(['http://127.0.0.1:4200/api/deploys/busy']);
  });

  it('(a) busy, then idle after 30 s: waits, logging the reasons, and checks every 15 s', async () => {
    vi.useFakeTimers();
    let n = 0;
    f.sys.http = () => (n++ < 2 ? busy('Valheim is stopping') : idle);
    let result: string | undefined;
    const waiting = waitUntilIdle(f.ctx, f.log).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(14_999);
    expect(asks()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(asks()).toHaveLength(2);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(result).toBe('idle');
    expect(asks()).toHaveLength(3);
    expect(f.logText()).toContain('Valheim is stopping');
  });

  it('(b) unreachable: treated as not busy, logged, proceeds immediately', async () => {
    f.sys.http = () => new Error('connect ECONNREFUSED 127.0.0.1:4200');
    expect(await waitUntilIdle(f.ctx, f.log)).toBe('unreachable');
    expect(asks()).toHaveLength(1);
    expect(f.logText()).toMatch(/Couldn't ask Skáli whether it is busy.*ECONNREFUSED.*going ahead/);
  });

  it('a non-200 or unreadable answer is treated as not busy too', async () => {
    f.sys.http = () => ({ status: 404, body: 'Not found' });
    expect(await waitUntilIdle(f.ctx, f.log)).toBe('unreachable');
    f.sys.http = () => ({ status: 200, body: 'not json' });
    expect(await waitUntilIdle(f.ctx, f.log)).toBe('unreachable');
  });

  it('(c) busy for 10 min: switches anyway', async () => {
    vi.useFakeTimers();
    f.sys.http = () => busy('Valheim is starting');
    let result: string | undefined;
    const waiting = waitUntilIdle(f.ctx, f.log).then((r) => (result = r));
    await vi.advanceTimersByTimeAsync(599_999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await waiting;
    expect(result).toBe('timeout');
    expect(asks()).toHaveLength(41);
    expect(f.logText()).toContain('switching anyway');
  });
});
