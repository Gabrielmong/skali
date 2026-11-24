import { describe, expect, it } from 'vitest';
import { makeRedactor } from '../src/redact.js';

describe('makeRedactor', () => {
  it('redacts secrets and token shapes', () => {
    const redact = makeRedactor(['s3cret']);
    expect(redact('x s3cret y')).toBe('x *** y');
    expect(redact('github_pat_ABC123_xyz')).toBe('***');
    expect(redact('ghp_abcdEFGH1234')).toBe('***');
    expect(redact('Authorization: Basic abc==')).toBe('Authorization: ***');
  });

  it('ignores empty and too-short secrets', () => {
    const redact = makeRedactor(['', 'a', 'abc']);
    expect(redact('a banana abc')).toBe('a banana abc');
  });
});
