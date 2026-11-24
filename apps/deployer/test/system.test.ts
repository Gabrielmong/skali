import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type ServiceStatus,
  needsShell,
  parseNssmStatus,
  realSystem,
  shellCommandLine,
  stopService,
  waitUntilStopped,
} from '../src/system.js';

const sys = realSystem({ node: process.execPath, nssm: 'nssm' } as never);
let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

describe('run', () => {
  it('streams lines', async () => {
    const lines: string[] = [];
    await sys.run(process.execPath, ['-e', "console.log('a');console.log('b')"], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(['a', 'b']);
  });

  it('rejects on non-zero exit', async () => {
    await expect(sys.run(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow(/exited 3/);
  });

  it('rejects when it runs past its timeout', async () => {
    const t = Date.now();
    await expect(sys.run(process.execPath, ['-e', 'setTimeout(() => {}, 20000)'], { timeoutMs: 300 })).rejects.toThrow(
      /timed out after 300 ms/,
    );
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it('kills the whole process tree on timeout', async () => {
    const marker = path.join(mkdtempSync(path.join(tmpdir(), 'tree-')), 'grandchild-ran');
    const grandchild = `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 1500)`;
    const parent =
      `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });` +
      'setTimeout(() => {}, 20000)';
    await expect(sys.run(process.execPath, ['-e', parent], { timeoutMs: 500 })).rejects.toThrow(/timed out/);
    await new Promise((r) => setTimeout(r, 2500));
    expect(existsSync(marker)).toBe(false);
  });

  it.runIf(process.platform === 'win32')('runs a .cmd file with quoted arguments', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cmd dir-'));
    const script = path.join(dir, 'echo args.cmd');
    writeFileSync(script, '@echo %*\r\n');
    const lines: string[] = [];
    await sys.run(script, ['a b', 'x&y'], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(['"a b" "x&y"']);
  });
});

describe('shell helpers', () => {
  it('needs a shell only for .cmd/.bat on win32', () => {
    expect(needsShell('C:\\npm\\pnpm.cmd', 'win32')).toBe(true);
    expect(needsShell('C:\\x\\RUN.BAT', 'win32')).toBe(true);
    expect(needsShell('C:\\x\\git.exe', 'win32')).toBe(false);
    expect(needsShell('/usr/bin/pnpm.cmd', 'linux')).toBe(false);
  });

  it('double-quotes the command and each argument', () => {
    expect(shellCommandLine('C:\\npm dir\\pnpm.cmd', ['install', '--store-dir', 'C:\\H\\shared\\pnpm store'])).toBe(
      '"C:\\npm dir\\pnpm.cmd" "install" "--store-dir" "C:\\H\\shared\\pnpm store"',
    );
  });

  it('refuses arguments containing a double quote', () => {
    expect(() => shellCommandLine('pnpm.cmd', ['a"b'])).toThrow(/double quote/);
    expect(() => shellCommandLine('pn"pm.cmd', [])).toThrow(/double quote/);
  });
});

describe('stopService', () => {
  const states = (...seq: ServiceStatus[]) => {
    let i = 0;
    return async () => seq[Math.min(i++, seq.length - 1)]!;
  };

  it.each(['stopped', 'missing'] as const)('does nothing when already %s', async (s) => {
    let stops = 0;
    await stopService(states(s), async () => void stops++, 'App', 100, 1);
    expect(stops).toBe(0);
  });

  it('stops a running service and waits until it is stopped', async () => {
    let stops = 0;
    await stopService(states('running', 'running', 'stop_pending', 'stopped'), async () => void stops++, 'App', 1000, 1);
    expect(stops).toBe(1);
  });

  it('stops a paused (crash-looping) service', async () => {
    let stops = 0;
    await stopService(states('paused', 'stopped'), async () => void stops++, 'App', 1000, 1);
    expect(stops).toBe(1);
  });

  it('retries the stop on a start-pending service whose first stop fails', async () => {
    let stops = 0;
    let state: ServiceStatus = 'start_pending';
    const stop = async () => {
      stops++;
      if (stops === 1) throw new Error('nssm exited 1 (start pending)');
      state = 'stopped';
    };
    await stopService(async () => state, stop, 'App', 1000, 1, 5);
    expect(stops).toBe(2);
  });

  it('sends no stop to a stop-pending service and waits', async () => {
    let stops = 0;
    await stopService(states('stop_pending', 'stop_pending', 'stopped'), async () => void stops++, 'App', 1000, 1);
    expect(stops).toBe(0);
  });

  it('accepts a failed stop when the service then reads stopped', async () => {
    const stop = async () => {
      throw new Error('nssm exited 1');
    };
    await expect(stopService(states('running', 'stopped'), stop, 'App', 1000, 1)).resolves.toBeUndefined();
  });

  it('times out with the usual message when the service never stops, retrying the stop meanwhile', async () => {
    let stops = 0;
    const stop = async () => {
      stops++;
      throw new Error('nssm exited 1');
    };
    await expect(stopService(async () => 'paused', stop, 'App', 60, 1, 10)).rejects.toThrow(/^App did not stop within 0 s$/);
    expect(stops).toBeGreaterThan(1);
  });
});

describe('healthy', () => {
  it('is true against a server answering 200', async () => {
    server = createServer((_, res) => res.writeHead(200).end('ok'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    expect(await sys.healthy(`http://127.0.0.1:${port}/`, 1500)).toBe(true);
  });

  it('is false within the timeout against a closed port', async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    const t = Date.now();
    expect(await sys.healthy(`http://127.0.0.1:${port}/`, 1500)).toBe(false);
    expect(Date.now() - t).toBeLessThan(3000);
  });
});

describe('httpGet', () => {
  it('answers the status and body', async () => {
    server = createServer((_, res) => res.writeHead(200).end('{"busy":true}'));
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    expect(await sys.httpGet(`http://127.0.0.1:${port}/api/deploys/busy`, 1500)).toEqual({ status: 200, body: '{"busy":true}' });
  });

  it('rejects against a closed port', async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const port = (s.address() as AddressInfo).port;
    await new Promise<void>((r) => s.close(() => r()));
    await expect(sys.httpGet(`http://127.0.0.1:${port}/`, 1500)).rejects.toThrow();
  });
});

describe('parseNssmStatus', () => {
  it('maps nssm output', () => {
    expect(parseNssmStatus('SERVICE_RUNNING\n')).toBe('running');
    expect(parseNssmStatus('S\0E\0R\0V\0I\0C\0E\0_RUNNING')).toBe('running');
    expect(parseNssmStatus('SERVICE_STOPPED')).toBe('stopped');
    expect(parseNssmStatus('Cannot open service! The specified service does not exist')).toBe('missing');
  });

  it('maps pending and paused states, never to stopped', () => {
    expect(parseNssmStatus('SERVICE_STOP_PENDING')).toBe('stop_pending');
    expect(parseNssmStatus('SERVICE_START_PENDING')).toBe('start_pending');
    expect(parseNssmStatus('SERVICE_PAUSED')).toBe('paused');
    expect(parseNssmStatus('S\0E\0R\0V\0I\0C\0E\0_PAUSED')).toBe('paused');
  });

  it('treats unknown output as other, never stopped', () => {
    expect(parseNssmStatus('')).toBe('other');
    expect(parseNssmStatus('Access is denied.')).toBe('other');
  });
});

describe('waitUntilStopped', () => {
  it('keeps polling through running and other until stopped', async () => {
    const seen = ['running', 'paused', 'stop_pending', 'stopped'] as const;
    let i = 0;
    await waitUntilStopped(async () => seen[i++]!, 'App', 1000, 1);
    expect(i).toBe(4);
  });

  it('accepts a missing service as stopped', async () => {
    await expect(waitUntilStopped(async () => 'missing', 'App', 1000, 1)).resolves.toBeUndefined();
  });

  it('throws when it never stops', async () => {
    await expect(waitUntilStopped(async () => 'other', 'App', 30, 5)).rejects.toThrow(/App did not stop/);
  });
});
