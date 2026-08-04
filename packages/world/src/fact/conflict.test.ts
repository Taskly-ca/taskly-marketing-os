import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyConflict,
  detectConflicts,
  resolveFactual,
  isSubjectivePredicate,
  DEFAULT_CHANGE_WINDOW_MS,
  RESOLUTION_MARGIN,
} from './conflict.js';
import { createMemoryFactStore, resetFactIds } from './memory-store.js';
import { assertFact, retractFact } from './write.js';
import { asOfBoth } from './query.js';
import type { FactRow } from './types.js';

const ENTITY = 'ent_jiffy';
const PRICE = 'hourly_rate_cents';

const JUL = '2026-07-01T00:00:00.000Z';
const AUG = '2026-08-01T00:00:00.000Z';
const AUG4 = '2026-08-04T00:00:00.000Z';
const AUG9 = '2026-08-09T00:00:00.000Z';

const row = (over: Partial<FactRow> = {}): FactRow => ({
  factId: 'f_default',
  entityId: ENTITY,
  predicate: PRICE,
  value: { datatype: 'num', num: 9900 },
  valid: { from: JUL, to: null },
  asserted: { from: JUL, to: null },
  sourceId: 'src_a',
  observedAt: JUL,
  confidence: 0.7,
  method: 'scrape',
  evidence: {},
  supersedes: null,
  status: 'active',
  ...over,
});

const num = (n: number): FactRow['value'] => ({ datatype: 'num', num: n });

const reliability = (table: Record<string, number>) => (id: string) => table[id] ?? 0.5;

describe('a price change is TEMPORAL, not a conflict', () => {
  // The headline. Treating this as a data conflict and "resolving" it destroys
  // the single most valuable signal in competitive intelligence: that a
  // competitor moved their price.
  const july = row({ factId: 'f_jul', value: num(9900), valid: { from: JUL, to: AUG } });
  const august = row({
    factId: 'f_aug',
    value: num(11900),
    valid: { from: AUG, to: null },
    observedAt: AUG4,
  });

  it('classifies non-overlapping valid ranges as temporal', () => {
    expect(classifyConflict(july, august)).toBe('temporal');
    expect(classifyConflict(august, july)).toBe('temporal');
  });

  it('records it as a temporal conflict at the instant of the change', () => {
    const [c] = detectConflicts([july, august]);
    expect(c!.kind).toBe('temporal');
    expect(c!.validInstant).toBe(AUG);
    expect(c!.factIds).toEqual(['f_aug', 'f_jul']);
  });

  it('REFUSES to fuse it, and says to use recordChange instead', () => {
    const [c] = detectConflicts([july, august]);
    const out = resolveFactual(c!, [july, august], {
      reliabilityOf: () => 0.9,
      now: AUG9,
    });
    expect(out.resolved).toBe(false);
    if (out.resolved) throw new Error('a temporal conflict must never be fused');
    expect(out.refusal.kind).toBe('temporal');
    expect(out.refusal.action).toBe('recordChange');
  });

  it('treats overlapping-but-stale observations as a change, not a contradiction', () => {
    // Both rows are open-ended because neither source dated its claim, so the
    // ranges overlap. Five weeks apart, a real price move is the better
    // explanation than "two sources disagree about today".
    const stale = row({ factId: 'f_old', valid: { from: JUL, to: null }, observedAt: JUL });
    const fresh = row({
      factId: 'f_new',
      value: num(11900),
      valid: { from: AUG4, to: null },
      observedAt: AUG4,
      sourceId: 'src_b',
    });
    expect(classifyConflict(stale, fresh)).toBe('temporal');
  });

  it('still calls it factual when the two claims cover the SAME window', () => {
    // Identical windows cannot hide a change: one of the two is simply wrong.
    const a = row({ factId: 'f_a', valid: { from: JUL, to: AUG }, observedAt: JUL });
    const b = row({
      factId: 'f_b',
      value: num(11900),
      valid: { from: JUL, to: AUG },
      observedAt: AUG4,
      sourceId: 'src_b',
    });
    expect(classifyConflict(a, b)).toBe('factual');
  });

  it('exposes the change window as a tunable, not a magic number', () => {
    const a = row({ factId: 'f_a', valid: { from: JUL, to: null }, observedAt: JUL });
    const b = row({
      factId: 'f_b',
      value: num(11900),
      valid: { from: AUG4, to: null },
      observedAt: AUG4,
      sourceId: 'src_b',
    });
    expect(DEFAULT_CHANGE_WINDOW_MS).toBeGreaterThan(0);
    // A predicate that genuinely cannot change in five weeks re-reads the same
    // pair as a factual disagreement.
    expect(classifyConflict(a, b, { changeWindowMs: 365 * 24 * 3600 * 1000 })).toBe('factual');
  });
});

describe('factual — same instant, incompatible values', () => {
  it('two sources scraped the same day are eligible for fusion', () => {
    const a = row({
      factId: 'f_a',
      sourceId: 'src_a',
      valid: { from: AUG4, to: null },
      observedAt: AUG4,
    });
    const b = row({
      factId: 'f_b',
      sourceId: 'src_b',
      value: num(10900),
      valid: { from: AUG4, to: null },
      observedAt: AUG4,
    });
    expect(classifyConflict(a, b)).toBe('factual');
  });

  it('is none when the values agree', () => {
    const a = row({ factId: 'f_a', sourceId: 'src_a' });
    const b = row({ factId: 'f_b', sourceId: 'src_b' });
    expect(classifyConflict(a, b)).toBe('none');
  });

  it('is none across different predicates or entities', () => {
    const a = row({ factId: 'f_a' });
    expect(classifyConflict(a, row({ factId: 'f_b', predicate: 'city', value: num(1) }))).toBe(
      'none',
    );
    expect(classifyConflict(a, row({ factId: 'f_b', entityId: 'ent_other', value: num(1) }))).toBe(
      'none',
    );
  });

  it('collapses three disagreeing sources into ONE conflict row', () => {
    const rows = ['a', 'b', 'c'].map((s, i) =>
      row({
        factId: `f_${s}`,
        sourceId: `src_${s}`,
        value: num(9900 + i * 1000),
        valid: { from: AUG4, to: null },
        observedAt: AUG4,
      }),
    );
    const conflicts = detectConflicts(rows);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.kind).toBe('factual');
    expect(conflicts[0]!.factIds).toEqual(['f_a', 'f_b', 'f_c']);
    expect(conflicts[0]!.status).toBe('open');
  });

  it('ignores rows we no longer assert', () => {
    const live = row({ factId: 'f_a', valid: { from: AUG4, to: null }, observedAt: AUG4 });
    const dead = row({
      factId: 'f_b',
      sourceId: 'src_b',
      value: num(10900),
      valid: { from: AUG4, to: null },
      observedAt: AUG4,
      status: 'retracted',
      asserted: { from: JUL, to: AUG },
    });
    expect(detectConflicts([live, dead])).toHaveLength(0);
  });
});

describe('opinion — subjectivity is metadata, never a fused number', () => {
  const rating = (over: Partial<FactRow>): FactRow =>
    row({ predicate: 'rating', valid: { from: AUG4, to: null }, observedAt: AUG4, ...over });

  const ctx = { isSubjective: (p: string) => p === 'rating' };

  it('two sources disagreeing about a rating is not an error', () => {
    const yelp = rating({ factId: 'f_y', sourceId: 'src_yelp', value: num(4.2) });
    const google = rating({ factId: 'f_g', sourceId: 'src_google', value: num(4.6) });
    expect(classifyConflict(yelp, google, ctx)).toBe('opinion');
  });

  it('REFUSES to fuse an opinion conflict', () => {
    const yelp = rating({ factId: 'f_y', sourceId: 'src_yelp', value: num(4.2) });
    const google = rating({ factId: 'f_g', sourceId: 'src_google', value: num(4.6) });
    const [c] = detectConflicts([yelp, google], ctx);
    const out = resolveFactual(c!, [yelp, google], { reliabilityOf: () => 0.9, now: AUG9 });
    expect(out.resolved).toBe(false);
    if (out.resolved) throw new Error('an opinion must never be fused into one number');
    expect(out.refusal.kind).toBe('opinion');
    expect(out.refusal.action).toBe('keep_both');
  });

  it('reads subjectivity from predicate metadata, which can override the fallback', () => {
    // The fallback would call `rating` subjective; metadata wins both ways.
    expect(isSubjectivePredicate('rating')).toBe(true);
    expect(isSubjectivePredicate('rating', { isSubjective: () => false })).toBe(false);
    expect(isSubjectivePredicate('vendor_verdict', { isSubjective: () => true })).toBe(true);
  });

  it('does not mistake a price for an opinion via the fallback list', () => {
    expect(isSubjectivePredicate(PRICE)).toBe(false);
    expect(isSubjectivePredicate('platform_fee_bps')).toBe(false);
  });

  it('lets the SAME source move its own rating — that is a change', () => {
    const before = rating({ factId: 'f_1', value: num(4.2), valid: { from: JUL, to: AUG } });
    const after = rating({ factId: 'f_2', value: num(4.6), valid: { from: AUG, to: null } });
    expect(classifyConflict(before, after, ctx)).toBe('temporal');
  });
});

describe('resolveFactual — fuse, retract, never delete', () => {
  const pair = (): FactRow[] => [
    row({ factId: 'f_a', sourceId: 'src_a', valid: { from: AUG4, to: null }, observedAt: AUG4 }),
    row({
      factId: 'f_b',
      sourceId: 'src_b',
      value: num(10900),
      valid: { from: AUG4, to: null },
      observedAt: AUG4,
    }),
  ];

  it('weighs source reliability and retracts the loser', () => {
    const rows = pair();
    const [c] = detectConflicts(rows);
    const out = resolveFactual(c!, rows, {
      reliabilityOf: reliability({ src_a: 0.92, src_b: 0.31 }),
      now: AUG9,
      resolvedBy: 'consolidator@v1',
    });
    if (!out.resolved) throw new Error(`expected a resolution, got ${out.refusal.kind}`);
    expect(out.winner.factId).toBe('f_a');
    expect(out.retract).toEqual(['f_b']);
    expect(out.conflict.status).toBe('resolved');
    expect(out.conflict.resolvedBy).toBe('consolidator@v1');
    expect(out.conflict.resolvedAt).toBe(AUG9);
  });

  it('prefers a human-entered value over an LLM extraction at equal reliability', () => {
    const rows = [
      row({
        factId: 'f_llm',
        sourceId: 'src_a',
        method: 'llm_extract',
        valid: { from: AUG4, to: null },
        observedAt: AUG4,
      }),
      row({
        factId: 'f_human',
        sourceId: 'src_b',
        method: 'human',
        value: num(10900),
        valid: { from: AUG4, to: null },
        observedAt: AUG4,
      }),
    ];
    const [c] = detectConflicts(rows);
    const out = resolveFactual(c!, rows, { reliabilityOf: () => 0.6, now: AUG9 });
    if (!out.resolved) throw new Error('expected a resolution');
    expect(out.winner.factId).toBe('f_human');
  });

  it('refuses a coin flip: an indistinguishable pair is unresolvable, not guessed', () => {
    const rows = pair();
    const [c] = detectConflicts(rows);
    const out = resolveFactual(c!, rows, { reliabilityOf: () => 0.7, now: AUG9 });
    expect(out.resolved).toBe(false);
    if (out.resolved) throw new Error('expected a refusal');
    expect(out.refusal.kind).toBe('insufficient_margin');
    expect(out.refusal.action).toBe('human_review');
    expect(out.conflict.status).toBe('unresolvable');
    expect(RESOLUTION_MARGIN).toBeGreaterThan(0);
  });

  it('does not retract a row that AGREES with the winner', () => {
    const rows = [
      ...pair(),
      row({
        factId: 'f_c',
        sourceId: 'src_c',
        valid: { from: AUG4, to: null },
        observedAt: AUG4,
      }),
    ];
    const [c] = detectConflicts(rows);
    const out = resolveFactual(c!, rows, {
      reliabilityOf: reliability({ src_a: 0.92, src_b: 0.31, src_c: 0.5 }),
      now: AUG9,
    });
    if (!out.resolved) throw new Error('expected a resolution');
    expect(out.winner.factId).toBe('f_a');
    expect(out.retract).toEqual(['f_b']); // f_c corroborates, it does not lose
  });

  it('never mutates the rows or the conflict it was handed', () => {
    const rows = pair();
    const [c] = detectConflicts(rows);
    const frozen = JSON.stringify({ rows, c });
    resolveFactual(c!, rows, {
      reliabilityOf: reliability({ src_a: 0.92, src_b: 0.31 }),
      now: AUG9,
    });
    expect(JSON.stringify({ rows, c })).toBe(frozen);
  });

  it('leaves the retracted loser queryable — audit erasure is a failure mode', async () => {
    resetFactIds();
    const store = createMemoryFactStore();
    const base = {
      entityId: ENTITY,
      predicate: PRICE,
      validFrom: AUG4,
      observedAt: AUG4,
      method: 'scrape' as const,
    };
    const a = await assertFact(store, { ...base, value: num(9900), sourceId: 'src_a' }, AUG4);
    const b = await assertFact(store, { ...base, value: num(10900), sourceId: 'src_b' }, AUG4);

    const [c] = detectConflicts(store.all());
    const out = resolveFactual(c!, store.all(), {
      reliabilityOf: reliability({ src_a: 0.92, src_b: 0.31 }),
      now: AUG9,
    });
    if (!out.resolved) throw new Error('expected a resolution');
    expect(out.winner.factId).toBe(a.row.factId);

    for (const id of out.retract) await retractFact(store, id, AUG9);

    const loser = await store.byId(b.row.factId);
    expect(loser).not.toBeNull();
    expect(loser!.status).toBe('retracted');
    // What we believed on Aug 5 is still answerable after the fusion.
    const then = await asOfBoth(store, ENTITY, PRICE, AUG4, '2026-08-05T00:00:00.000Z');
    expect(then).not.toBeNull();
  });
});

beforeEach(() => {
  resetFactIds();
});
