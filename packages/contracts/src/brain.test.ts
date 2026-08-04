import { describe, it, expect } from 'vitest';
import {
  brainSnapshotSchema,
  brainDocSchema,
  groundingRightFor,
  mayGroundFact,
  isRetrievable,
  isStale,
  effectiveCaveats,
  BRAIN_STALE_DAYS,
} from './brain.js';
import type { BrainDoc } from './brain.js';

const NOW = new Date('2026-08-04T00:00:00.000Z');

const doc = (over: Partial<BrainDoc> = {}): BrainDoc =>
  brainDocSchema.parse({
    path: '20-architecture/SYSTEM.md',
    title: 'Taskly — Application Architecture',
    type: 'spec',
    status: 'canonical',
    reviewed: '2026-08-02',
    docSha: 'sha-1',
    chunks: [{ chunkId: 'sha-1:0', ordinal: 0, heading: 'Roles', text: 'x', chunkSha: 'c0' }],
    ...over,
  });

describe('the trust ladder', () => {
  it('assigns exactly one right per status', () => {
    expect(groundingRightFor('canonical')).toBe('grounds');
    expect(groundingRightFor('supporting')).toBe('corroborates');
    expect(groundingRightFor('draft')).toBe('context_only');
    expect(groundingRightFor('superseded')).toBe('never_retrieved');
  });

  it('lets ONLY canonical ground a factual claim', () => {
    // The fastest way to launder a guess into a stated fact is to let an
    // unreviewed draft be cited. This is the assertion that prevents it.
    expect(mayGroundFact('canonical')).toBe(true);
    expect(mayGroundFact('supporting')).toBe(false);
    expect(mayGroundFact('draft')).toBe(false);
    expect(mayGroundFact('superseded')).toBe(false);
  });

  it('keeps superseded documents out of the index entirely', () => {
    // Not "ranked lower" — absent. Retrieving a document the company has
    // already decided is wrong is how a corrected error gets re-published.
    expect(isRetrievable('superseded')).toBe(false);
    expect(isRetrievable('draft')).toBe(true);
    expect(isRetrievable('canonical')).toBe(true);
    expect(isRetrievable('supporting')).toBe(true);
  });
});

describe('staleness', () => {
  it('flags a canonical doc past the review window', () => {
    expect(isStale(doc({ reviewed: '2026-08-02' }), NOW)).toBe(false);
    expect(isStale(doc({ reviewed: '2026-01-01' }), NOW)).toBe(true);
  });

  it('is meaningless for anything that is not canonical', () => {
    expect(isStale(doc({ status: 'draft', reviewed: '2020-01-01' }), NOW)).toBe(false);
    expect(isStale(doc({ status: 'supporting', reviewed: null }), NOW)).toBe(false);
  });

  it('does not silently demote a stale canonical — it caveats it', () => {
    // Demoting would make the designated answer un-citable and leave the
    // question unanswered. Citing it with a visible warning is the honest move.
    const stale = doc({ reviewed: '2026-01-01', verify: ['lib/marketplace/fees.ts'] });
    expect(mayGroundFact(stale.status)).toBe(true);
    const caveats = effectiveCaveats(stale, NOW);
    expect(caveats.join(' ')).toMatch(/lib\/marketplace\/fees\.ts/);
    expect(caveats.join(' ')).toContain(String(BRAIN_STALE_DAYS));
  });
});

describe('caveats ride along with the citation', () => {
  it('carries authored caveats through unchanged', () => {
    const d = doc({ caveats: ['Prices here predate the Aug 1 change.'] });
    expect(effectiveCaveats(d, NOW)).toContain('Prices here predate the Aug 1 change.');
  });

  it('adds the status caveat a reader needs at the point of use', () => {
    expect(effectiveCaveats(doc({ status: 'supporting' }), NOW).join(' ')).toMatch(/sole basis/i);
    expect(effectiveCaveats(doc({ status: 'draft' }), NOW).join(' ')).toMatch(/DRAFT/);
  });

  it('emits nothing for a fresh canonical with no authored caveats', () => {
    expect(effectiveCaveats(doc(), NOW)).toEqual([]);
  });
});

describe('the snapshot refuses to be misread', () => {
  const snapshot = (over: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    commit: 'a99afa8d',
    generatedAt: '2026-08-04T00:00:00.000Z',
    docs: [doc()],
    ...over,
  });

  it('parses a well-formed snapshot', () => {
    expect(brainSnapshotSchema.safeParse(snapshot()).success).toBe(true);
  });

  it('rejects an unknown schema version rather than guessing', () => {
    // An old TMOS meeting a new snapshot must fail loudly. Best-effort parsing
    // of a shape we no longer understand is how a sync silently half-works.
    expect(brainSnapshotSchema.safeParse(snapshot({ schemaVersion: 2 })).success).toBe(false);
  });

  it('rejects a status the Brain gate would not accept', () => {
    const bad = snapshot({ docs: [{ ...doc(), status: 'final' }] });
    expect(brainSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a doc with no content hash — the diff key cannot be optional', () => {
    const bad = snapshot({ docs: [{ ...doc(), docSha: '' }] });
    expect(brainSnapshotSchema.safeParse(bad).success).toBe(false);
  });

  it('defaults the optional arrays rather than leaving them undefined', () => {
    const parsed = brainDocSchema.parse({
      path: 'x.md',
      title: 'x',
      type: 'plan',
      status: 'draft',
      reviewed: null,
      docSha: 's',
      chunks: [],
    });
    expect(parsed.caveats).toEqual([]);
    expect(parsed.verify).toEqual([]);
    expect(parsed.supersededBy).toEqual([]);
  });
});
