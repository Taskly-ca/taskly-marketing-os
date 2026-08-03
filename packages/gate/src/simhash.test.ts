import { describe, it, expect } from 'vitest';
import { simhash, hammingDistance, isNearDuplicate, shingles } from './simhash.js';

const ARTICLE =
  'Jiffy has expanded its home services lineup across the Greater Toronto Area, ' +
  'adding snow removal and gutter cleaning to a catalogue that already covered ' +
  'plumbing, electrical work and seasonal maintenance for homeowners.';

/** Same story, trivially rewrapped — a syndicated copy with a different intro. */
const NEAR_COPY =
  'Jiffy has expanded its home services lineup across the Greater Toronto Area, ' +
  'adding snow removal and gutter cleaning to a catalogue that already covered ' +
  'plumbing, electrical work and seasonal maintenance for homeowners today.';

const UNRELATED =
  'The city council approved a new transit funding package on Tuesday, allocating ' +
  'money toward subway extensions and bus rapid transit corridors over the next decade.';

describe('simhash near-duplicate detection', () => {
  it('is deterministic and stable', () => {
    expect(simhash(ARTICLE)).toBe(simhash(ARTICLE));
  });

  it('flags a trivially-rewrapped copy as a near duplicate', () => {
    expect(isNearDuplicate(simhash(ARTICLE), simhash(NEAR_COPY))).toBe(true);
  });

  it('does NOT flag an unrelated article', () => {
    expect(isNearDuplicate(simhash(ARTICLE), simhash(UNRELATED))).toBe(false);
  });

  it('places unrelated text far apart in hamming space', () => {
    expect(hammingDistance(simhash(ARTICLE), simhash(UNRELATED))).toBeGreaterThan(10);
  });

  it('keeps a wide margin between near-duplicate and unrelated', () => {
    // The measurement the threshold is calibrated on. If this margin ever
    // narrows, the fixed threshold is no longer safe and must become
    // length-aware — so assert the margin, not just the verdict.
    const near = hammingDistance(simhash(ARTICLE), simhash(NEAR_COPY));
    const far = hammingDistance(simhash(ARTICLE), simhash(UNRELATED));
    expect(near).toBeLessThanOrEqual(8);
    expect(far).toBeGreaterThan(20);
    expect(far - near).toBeGreaterThan(15);
  });

  it('round-trips through a signed 64-bit range (Postgres bigint safe)', () => {
    const sig = BigInt(simhash(ARTICLE));
    expect(sig).toBeGreaterThanOrEqual(-(2n ** 63n));
    expect(sig).toBeLessThan(2n ** 63n);
  });

  it('does not claim semantic dedup — same meaning, different words stays far', () => {
    // This is the documented boundary: SimHash scores paraphrase near zero.
    // Catching it is the embedding stage's job, on a candidate set only.
    const paraphrase =
      'The Toronto-area operator broadened what it offers to households, folding ' +
      'winter driveway clearing and roof drainage work into an existing menu of trades.';
    expect(isNearDuplicate(simhash(ARTICLE), simhash(paraphrase))).toBe(false);
  });

  it('handles empty and very short input without throwing', () => {
    expect(simhash('')).toBe('0');
    expect(() => simhash('hi')).not.toThrow();
    expect(shingles('one two')).toEqual(['one two']);
  });
});
