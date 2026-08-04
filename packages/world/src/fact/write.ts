/**
 * The three write rules. There are only three, and every mutation is one of
 * them.
 *
 *   1. ASSERT  — new knowledge. Insert. Nothing is closed.
 *   2. CORRECT — *we* were wrong. Close `asserted` on the old row and insert a
 *                replacement carrying the SAME `valid` range. The old belief
 *                stays queryable forever; that is the point.
 *   3. CHANGE  — the *world* changed. Close `valid` on the current row and
 *                insert a new row whose `valid` opens at the change instant.
 *                Both rows keep an open `asserted` — we believe both, about
 *                different periods.
 *
 * Choosing between 2 and 3 is the caller's decision and it is NOT inferable
 * from the data: "the price is now $40" and "the price was always $40 and we
 * misread it" produce identical inputs. Guessing here silently rewrites
 * history, so the API refuses to guess.
 */
import { assertValidRange, isOpen, rangeContains } from './types.js';
import type { FactInput, FactRow, FactStore, FactValue } from './types.js';

/** Same predicate, same instant, different value — the conflict test. */
export function sameValue(a: FactValue, b: FactValue): boolean {
  if (a.datatype !== b.datatype) return false;
  switch (a.datatype) {
    case 'text':
      return a.text === (b as Extract<FactValue, { datatype: 'text' }>).text;
    case 'num':
      return a.num === (b as Extract<FactValue, { datatype: 'num' }>).num;
    case 'entity':
      return a.entityId === (b as Extract<FactValue, { datatype: 'entity' }>).entityId;
    case 'json':
      return (
        JSON.stringify(a.json) ===
        JSON.stringify((b as Extract<FactValue, { datatype: 'json' }>).json)
      );
  }
}

function toRow(input: FactInput, now: string, supersedes: string | null): Omit<FactRow, 'factId'> {
  const validFrom = input.validFrom ?? input.observedAt;
  const valid = { from: validFrom, to: input.validTo ?? null };
  assertValidRange(valid);
  return {
    entityId: input.entityId,
    predicate: input.predicate,
    value: input.value,
    valid,
    asserted: { from: now, to: null },
    sourceId: input.sourceId,
    observedAt: input.observedAt,
    confidence: input.confidence ?? 0.5,
    method: input.method,
    evidence: input.evidence ?? {},
    supersedes,
    status: 'active',
  };
}

/** Rows we currently believe: `asserted` still open and not retracted. */
export const currentlyAsserted = (rows: FactRow[]): FactRow[] =>
  rows.filter((r) => isOpen(r.asserted) && r.status === 'active');

/**
 * Rule 1 — new knowledge.
 *
 * Re-observing the same value is NOT a new fact. Sources re-serve the same page
 * daily; inserting a row per observation would make `asserted` history a crawl
 * log and drown every real change in it. The existing row is returned unchanged.
 */
export async function assertFact(
  store: FactStore,
  input: FactInput,
  now: string,
): Promise<{ row: FactRow; created: boolean }> {
  const existing = currentlyAsserted(await store.forPredicate(input.entityId, input.predicate));
  const validFrom = input.validFrom ?? input.observedAt;

  const duplicate = existing.find(
    (r) => sameValue(r.value, input.value) && rangeContains(r.valid, validFrom),
  );
  if (duplicate) return { row: duplicate, created: false };

  return { row: await store.insert(toRow(input, now, null)), created: true };
}

/**
 * Rule 2 — we were wrong.
 *
 * The old row's `asserted` closes at `now`; the replacement carries the old
 * row's `valid` range verbatim. Ask "was the world different, or were we?" — if
 * the world changed, this is the wrong function.
 */
export async function correctFact(
  store: FactStore,
  factId: string,
  corrected: FactValue,
  opts: {
    sourceId: string;
    observedAt: string;
    method: FactInput['method'];
    now: string;
    confidence?: number;
    evidence?: FactInput['evidence'];
  },
): Promise<FactRow> {
  const old = await store.byId(factId);
  if (!old) throw new Error(`correctFact: no such fact ${factId}`);
  if (!isOpen(old.asserted)) {
    throw new Error(
      `correctFact: ${factId} is already superseded — correct the current row instead`,
    );
  }

  await store.closeAsserted(factId, opts.now);
  return store.insert({
    ...old,
    value: corrected,
    // The world did not change: the valid range is copied, not recomputed.
    valid: { ...old.valid },
    asserted: { from: opts.now, to: null },
    sourceId: opts.sourceId,
    observedAt: opts.observedAt,
    confidence: opts.confidence ?? old.confidence,
    method: opts.method,
    evidence: opts.evidence ?? {},
    supersedes: factId,
    status: 'active',
  });
}

/**
 * Rule 3 — the world changed.
 *
 * Closes `valid` on whichever row covers the change instant, then opens a new
 * one. Both keep an open `asserted`: we believe the old value for the old
 * period and the new value for the new one, simultaneously and correctly.
 */
export async function recordChange(
  store: FactStore,
  input: FactInput & { validFrom: string },
  now: string,
): Promise<{ closed: FactRow | null; row: FactRow }> {
  const rows = currentlyAsserted(await store.forPredicate(input.entityId, input.predicate));
  const covering = rows.find((r) => rangeContains(r.valid, input.validFrom));

  if (covering && sameValue(covering.value, input.value)) {
    // Not a change at all — the source restated what we already hold.
    return { closed: null, row: covering };
  }

  if (covering) {
    if (isOpen(covering.valid) || new Date(covering.valid.to!) > new Date(input.validFrom)) {
      await store.closeValid(covering.factId, input.validFrom);
    }
  }

  const row = await store.insert(toRow(input, now, covering?.factId ?? null));
  return { closed: covering ? await store.byId(covering.factId) : null, row };
}

/**
 * Retraction. The row stays — `status` flips to `retracted` and `asserted`
 * closes. Deleting it would erase the audit trail, and "we used to believe this
 * and stopped" is often the most useful thing in the record.
 */
export async function retractFact(store: FactStore, factId: string, now: string): Promise<void> {
  const row = await store.byId(factId);
  if (!row) throw new Error(`retractFact: no such fact ${factId}`);
  await store.setStatus(factId, 'retracted');
  if (isOpen(row.asserted)) await store.closeAsserted(factId, now);
}
