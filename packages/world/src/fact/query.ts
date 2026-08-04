/**
 * The four bitemporal reads. Every question worth asking of the world model is
 * one of these, and the difference between Q2 and Q3 is the reason the second
 * axis exists at all.
 *
 *   Q1 currentBelief    — what we believe now, about now
 *   Q2 asOfValid        — what we believe NOW, about a past instant
 *                         (our corrected, best understanding of history)
 *   Q3 asOfBoth         — what we believed THEN, about a past instant
 *                         (what a decision made then was actually looking at)
 *   Q4 beliefSnapshot   — everything we believed at an instant, all predicates
 *
 * Q2 and Q3 differ exactly when we have corrected ourselves. Post-mortems need
 * Q3: judging a past decision against facts we only learned afterwards is
 * hindsight bias with a database behind it.
 */
import { rangeContains } from './types.js';
import type { FactRow, FactStore } from './types.js';

const isLive = (r: FactRow): boolean => r.status === 'active';

/** Latest assertion wins, then highest confidence — deterministic ordering so
 *  the same inputs always produce the same answer. */
function pickBest(rows: FactRow[]): FactRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => {
    const byAsserted = new Date(b.asserted.from).getTime() - new Date(a.asserted.from).getTime();
    if (byAsserted !== 0) return byAsserted;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.factId < b.factId ? -1 : 1;
  })[0]!;
}

/** Q1 — what we believe now, about now. The hot path. */
export async function currentBelief(
  store: FactStore,
  entityId: string,
  predicate: string,
  now: string,
): Promise<FactRow | null> {
  const rows = await store.forPredicate(entityId, predicate);
  return pickBest(
    rows.filter((r) => isLive(r) && r.asserted.to === null && rangeContains(r.valid, now)),
  );
}

/** Q2 — our CURRENT best understanding of a PAST instant, corrections included. */
export async function asOfValid(
  store: FactStore,
  entityId: string,
  predicate: string,
  validAt: string,
): Promise<FactRow | null> {
  const rows = await store.forPredicate(entityId, predicate);
  return pickBest(
    rows.filter((r) => isLive(r) && r.asserted.to === null && rangeContains(r.valid, validAt)),
  );
}

/**
 * Q3 — what we believed AT `assertedAt` about `validAt`.
 *
 * Retracted rows are included when the retraction happened after `assertedAt`:
 * we did believe them at the time, and pretending otherwise defeats the whole
 * purpose of asking.
 */
export async function asOfBoth(
  store: FactStore,
  entityId: string,
  predicate: string,
  validAt: string,
  assertedAt: string,
): Promise<FactRow | null> {
  const rows = await store.forPredicate(entityId, predicate);
  return pickBest(
    rows.filter((r) => rangeContains(r.asserted, assertedAt) && rangeContains(r.valid, validAt)),
  );
}

/** Q4 — the whole entity as we understood it at one instant. */
export async function beliefSnapshot(
  store: FactStore,
  entityId: string,
  at: string,
): Promise<Map<string, FactRow>> {
  const rows = await store.forEntity(entityId);
  const byPredicate = new Map<string, FactRow[]>();
  for (const r of rows) {
    if (!rangeContains(r.asserted, at) || !rangeContains(r.valid, at)) continue;
    const list = byPredicate.get(r.predicate);
    if (list) list.push(r);
    else byPredicate.set(r.predicate, [r]);
  }

  const out = new Map<string, FactRow>();
  for (const [predicate, list] of byPredicate) {
    const best = pickBest(list);
    if (best) out.set(predicate, best);
  }
  return out;
}

/**
 * The correction trail for one fact, oldest belief first.
 *
 * This is what makes a wrong answer explainable after the fact: it shows what
 * we thought, when we stopped thinking it, and what replaced it.
 */
export async function assertionHistory(
  store: FactStore,
  entityId: string,
  predicate: string,
): Promise<FactRow[]> {
  const rows = await store.forPredicate(entityId, predicate);
  return [...rows].sort(
    (a, b) => new Date(a.asserted.from).getTime() - new Date(b.asserted.from).getTime(),
  );
}

/**
 * Did our belief about `validAt` ever change? Cheap honesty check before
 * quoting a historical number in a brief.
 */
export async function wasCorrected(
  store: FactStore,
  entityId: string,
  predicate: string,
  validAt: string,
): Promise<boolean> {
  const rows = await store.forPredicate(entityId, predicate);
  const covering = rows.filter((r) => rangeContains(r.valid, validAt));
  return covering.filter((r) => r.asserted.to !== null).length > 0;
}
