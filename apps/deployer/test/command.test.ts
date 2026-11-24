import { describe, expect, it } from 'vitest';
import { parseCommand } from '../src/command.js';
import { OpError } from '../src/op-error.js';

const rejects = (body: unknown) => {
  try {
    parseCommand(body);
  } catch (e) {
    expect(e).toBeInstanceOf(OpError);
    expect((e as OpError).status).toBe(400);
    return;
  }
  throw new Error('expected a 400');
};

describe('parseCommand', () => {
  it.each(['deployNow', 'restartApp', 'pause', 'resume'])('accepts %s from "you" and "auto"', (type) => {
    expect(parseCommand({ type, by: 'you' })).toEqual({ type, by: 'you' });
    expect(parseCommand({ type, by: 'auto' })).toEqual({ type, by: 'auto' });
  });

  it('accepts rollback with a sha and drops unknown fields', () => {
    expect(parseCommand({ type: 'rollback', sha: 'abc1234', by: 'you', path: 'C:\\x' })).toEqual({
      type: 'rollback',
      sha: 'abc1234',
      by: 'you',
    });
  });

  it('rejects by: "admin" and any other by', () => {
    rejects({ type: 'pause', by: 'admin' });
    rejects({ type: 'pause', by: 'Admin' });
    rejects({ type: 'pause', by: 'setup' });
    rejects({ type: 'pause' });
    rejects({ type: 'pause', by: 3 });
  });

  it('rejects unknown types and a rollback without a sha', () => {
    rejects({ type: 'rm -rf', by: 'you' });
    rejects({ type: 'deploy', by: 'you' });
    rejects({ by: 'you' });
    rejects({ type: 'rollback', by: 'you' });
    rejects({ type: 'rollback', sha: 1, by: 'you' });
    rejects(null);
    rejects('pause');
  });
});
