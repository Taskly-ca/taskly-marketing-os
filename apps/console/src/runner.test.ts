/**
 * The two properties of pressing a button that are worth proving.
 *
 * `argsFor` is trivial-looking and is the reason a stage name never reaches a
 * shell: it produces an argv ARRAY that `spawn` is handed directly, with no
 * shell involved, so there is nothing to inject into even if `isStage` were
 * bypassed. Testing it as data is testing that property.
 *
 * The busy rule is the one with teeth. Two concurrent passes are not two views
 * of the same work: `watch` reads the world model, decides whether an
 * observation is new, then writes it — so an interleaved second pass can read
 * the first's write and classify a genuine competitor change as `restated`,
 * losing it silently and looking healthy while doing so.
 */
import { describe, expect, it } from 'vitest';

import { argsFor, isStage, STAGES } from './runner.js';

describe('argsFor', () => {
  it('runs everything when the stage is `all` — the flag is its absence', () => {
    expect(argsFor('all', false)).toEqual([]);
  });

  it('passes --only for a single stage', () => {
    expect(argsFor('watch', false)).toEqual(['--only', 'watch']);
  });

  it('adds --free, which the worker reads as "skip what spends"', () => {
    expect(argsFor('all', true)).toEqual(['--free']);
    expect(argsFor('reason', true)).toEqual(['--only', 'reason', '--free']);
  });

  it('never emits a single string a shell could split', () => {
    // The whole argv-array argument: every element is one token.
    for (const s of STAGES) {
      for (const part of argsFor(s, true)) expect(part).not.toContain(' ');
    }
  });
});

describe('isStage', () => {
  it('accepts every stage the worker actually has', () => {
    for (const s of STAGES) expect(isStage(s)).toBe(true);
  });

  it('rejects anything else, including a shell attempt', () => {
    expect(isStage('reasoning')).toBe(false);
    expect(isStage('watch; rm -rf /')).toBe(false);
    expect(isStage('--free')).toBe(false);
    expect(isStage('')).toBe(false);
  });
});
