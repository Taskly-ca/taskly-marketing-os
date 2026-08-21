/**
 * The three write rules. There are only three, and every mutation is one of
 * them.
 *
 *   1. ASSERT  — new knowledge. Insert. Nothing is closed.
 *   2. CORRECT — *we* were wrong. Close `asserted` on the old row and insert a
 *                replacement. The old belief stays queryable forever; that is
 *                the point. The replacement normally carries the SAME `valid`
 *                range; when the thing we got wrong IS the range, it carries
 *                the corrected one — still on the asserted axis, because
 *                migration 009 says so in as many words: "a wrong end date is
 *                corrected on the ASSERTED axis — close asserted and supersede
 *                — never by rewriting valid".
 *   3. CHANGE  — the *world* changed. Close `valid` on the current row and
 *                insert a new row whose `valid` opens at the change instant.
 *                Both rows keep an open `asserted` — we believe both, about
 *                different periods.
 *
 * Choosing between 2 and 3 is the caller's decision and it is NOT inferable
 * from the data: "the price is now $40" and "the price was always $40 and we
 * misread it" produce identical inputs. Guessing here silently rewrites
 * history, so the API refuses to guess.
 *
 * There is exactly one place where the choice is NOT the caller's, and where
 * this file used to get it wrong: a change reported at an instant that falls
 * inside an interval we have ALREADY closed. `recordChange` used to shorten
 * that closed bound. That is a rewrite of `valid`, it destroys what we used to
 * believe, and 009 raises on it. It is handled as a correction now — see
 * `recordChange`, case (c).
 */
import { assertValidRange, isOpen, rangeContains } from './types.js';
import type { FactInput, FactRow, FactStore, FactValue, Range } from './types.js';

const ms = (iso: string): number => new Date(iso).getTime();

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

/**
 * A range that ends at or before it starts contains no instant, so it asserts
 * nothing. Migration 009 refuses it on both axes ("cannot be emptied — an
 * interval that contains no instant asserts nothing"); the memory store does
 * not check, so the check lives here, above both adapters, where it fails the
 * same way whichever store is underneath.
 */
function assertNonEmpty(r: Range, axis: 'valid' | 'asserted', where: string): void {
  assertValidRange(r);
  if (r.to !== null && ms(r.to) <= ms(r.from)) {
    throw new RangeError(
      `${where}: ${axis} ${r.from}..${r.to} contains no instant — an interval that contains no instant asserts nothing`,
    );
  }
}

/**
 * Closing `asserted` at an instant that is not strictly after it opened is the
 * same emptiness, and it has one overwhelmingly common cause worth naming in
 * the message: **`now()` is frozen for the whole of a Postgres transaction**.
 * A row inserted and then corrected inside one `withTx` carries
 * `asserted.from === now`, so the close produces an empty range and 009 raises
 * (the adapter surfaces it as `EmptyRangeError`).
 *
 * Checked BEFORE any write, because `withTx` has no savepoints: a failure
 * halfway through a correction aborts the whole transaction, and a correction
 * that closed a belief without inserting its replacement would be the worst
 * possible thing to leave behind.
 */
function assertBeliefClosable(row: FactRow, now: string, where: string): void {
  if (ms(now) > ms(row.asserted.from)) return;
  throw new RangeError(
    `${where}: cannot close asserted at ${now} on a belief that opened at ${row.asserted.from} — ` +
      `the interval would contain no instant. Postgres freezes now() for a whole transaction, so a ` +
      `row inserted and corrected inside one transaction always lands here; correct it in a later ` +
      `transaction, or pass a \`now\` after ${row.asserted.from}.`,
  );
}

/** Rows we currently believe: `asserted` still open and not retracted. */
export const currentlyAsserted = (rows: FactRow[]): FactRow[] =>
  rows.filter((r) => isOpen(r.asserted) && r.status === 'active');

/**
 * The row whose `valid` interval covers an instant.
 *
 * More than one can cover it: two sources asserting different values over the
 * same period is an unresolved *factual* conflict, which `fact/conflict.ts`
 * adjudicates and this function must not silently resolve. So it picks the row
 * a READ would surface — the same ordering as `query.ts`'s `pickBest` (latest
 * belief, then confidence, then id) — and leaves the rest untouched.
 *
 * The ordering is not cosmetic. `forPredicate` returns insertion order in
 * memory and `lower(asserted), fact_id` in Postgres, so a bare `find()` here
 * picked a different row in each store: the same call, two different histories.
 */
function pickCovering(rows: FactRow[], instant: string): FactRow | null {
  const covering = rows.filter((r) => rangeContains(r.valid, instant));
  if (covering.length <= 1) return covering[0] ?? null;
  return [...covering].sort((a, b) => {
    const byAsserted = ms(b.asserted.from) - ms(a.asserted.from);
    if (byAsserted !== 0) return byAsserted;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return a.factId < b.factId ? -1 : 1;
  })[0]!;
}

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
 *
 * `opts.valid` is the one exception, and it is not a loophole: it is how 009's
 * "a wrong end date is corrected on the ASSERTED axis" is actually expressed.
 * Supply it ONLY when the thing we got wrong is *when* the value held. The
 * range still moves by superseding a row, never by mutating one, so the old
 * window remains queryable — which is the whole difference between a bitemporal
 * correction and an UPDATE.
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
    /** The corrected world-interval. Omit unless the RANGE is what was wrong. */
    valid?: Range;
  },
): Promise<FactRow> {
  const old = await store.byId(factId);
  if (!old) throw new Error(`correctFact: no such fact ${factId}`);
  if (!isOpen(old.asserted)) {
    throw new Error(
      `correctFact: ${factId} is already superseded — correct the current row instead`,
    );
  }
  if (opts.valid) assertNonEmpty(opts.valid, 'valid', 'correctFact');
  assertBeliefClosable(old, opts.now, 'correctFact');

  await store.closeAsserted(factId, opts.now);
  return store.insert({
    ...old,
    value: corrected,
    // The world did not change: the valid range is copied, not recomputed —
    // unless the caller is correcting the range itself.
    valid: opts.valid ? { ...opts.valid } : { ...old.valid },
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
 * What `recordChange` did. The caller cannot otherwise tell which axis moved,
 * and "which axis moved" is the only question this module exists to answer.
 *
 *   unchanged  — the source restated the value we already hold. Nothing written.
 *   opened     — no interval covered the instant. A plain insert.
 *   change     — rule 3: `valid` closed on the covering row, new row opened.
 *   correction — rule 2: the covering row's `asserted` closed and it was
 *                superseded. We were wrong about *when*, not just about *what*.
 */
export interface ChangeOutcome {
  kind: 'unchanged' | 'opened' | 'change' | 'correction';
  /**
   * The covering row as it now stands: with `valid` closed on a `change`, with
   * `asserted` closed on a `correction`, and `null` when nothing was covered.
   * Read `kind` before reading a bound off it.
   */
  closed: FactRow | null;
  /** The row carrying the NEW value. */
  row: FactRow;
  /**
   * `correction` only, and only when the covering interval was split: the
   * re-issued OLD value over the shortened window it really held for.
   */
  prior: FactRow | null;
}

/**
 * Rule 3 — the world changed. And the two places where it did not.
 *
 * Four shapes, decided by where the change instant falls relative to the
 * interval we already hold:
 *
 *   (a) instant === covering.valid.from
 *       The value changed at the very instant our interval opened, so our
 *       interval never held the value we recorded for it — not for one instant.
 *       That is not the world moving, it is us having been wrong from the
 *       start. Pure `correctFact`, same `valid` range. Splitting instead would
 *       mint a `[from, from)` prior, an interval containing no instant, which
 *       009 refuses and which asserts nothing anyway.
 *
 *   (b) covering.valid is OPEN
 *       The genuine rule 3. Infinite → finite is the one `valid` mutation 009
 *       permits, and it is exactly what "the world changed" means.
 *
 *   (c) covering.valid is CLOSED and the instant falls strictly inside it
 *       We recorded "X from T0 to T2" and have now learned the value changed at
 *       T1, T0 < T1 < T2. Our previous assertion was WRONG — X did not run to
 *       T2 — and a wrong assertion closes `asserted`, never `valid`. Shortening
 *       T2 to T1 in place would erase what we used to believe and make "what
 *       did we believe on date D" unanswerable for this entity; 009 raises on
 *       it (`upper(valid)` is closable once, infinite → finite only). So the
 *       covering row is superseded by TWO rows: the old value over [T0, T1) and
 *       the new value over [T1, T2). Both point `supersedes` at the row they
 *       replace, which is a fan-out rather than a chain, deliberately: one row
 *       became two and the record should say so.
 *
 *       This is not a hypothetical. It fires whenever facts arrive out of
 *       order — a backfill, or a source reporting a historical change after a
 *       later one is already recorded.
 *
 *   (d) nothing covers the instant
 *       Plain insert. Nothing to close, nothing to correct.
 *
 * Everything after the guard in (c) must run in ONE transaction: it closes a
 * belief and then replaces it, and half of that is worse than neither.
 */
export async function recordChange(
  store: FactStore,
  input: FactInput & { validFrom: string },
  now: string,
): Promise<ChangeOutcome> {
  const rows = currentlyAsserted(await store.forPredicate(input.entityId, input.predicate));
  const covering = pickCovering(rows, input.validFrom);

  // (d)
  if (!covering) {
    return {
      kind: 'opened',
      closed: null,
      row: await store.insert(toRow(input, now, null)),
      prior: null,
    };
  }

  if (sameValue(covering.value, input.value)) {
    // Not a change at all — the source restated what we already hold.
    return { kind: 'unchanged', closed: null, row: covering, prior: null };
  }

  // (a)
  if (ms(input.validFrom) === ms(covering.valid.from)) {
    const row = await correctFact(store, covering.factId, input.value, {
      sourceId: input.sourceId,
      observedAt: input.observedAt,
      method: input.method,
      now,
      confidence: input.confidence,
      evidence: input.evidence,
    });
    return { kind: 'correction', closed: await store.byId(covering.factId), row, prior: null };
  }

  // (b)
  if (isOpen(covering.valid)) {
    await store.closeValid(covering.factId, input.validFrom);
    const row = await store.insert(toRow(input, now, covering.factId));
    return { kind: 'change', closed: await store.byId(covering.factId), row, prior: null };
  }

  // (c) — the covering interval is already closed. Correct, never shorten.
  //
  // The re-issued prior carries the NEW observation's source, not the old row's:
  // the old source told us X ran to T2 and never said it stopped at T1, and
  // attributing a claim to a source that did not make it is the memory-poisoning
  // failure the sourcing rule exists to prevent. Its original evidence is one
  // `supersedes` hop away, which is what makes the chain worth walking.
  const prior = await correctFact(store, covering.factId, covering.value, {
    sourceId: input.sourceId,
    observedAt: input.observedAt,
    method: input.method,
    now,
    // Same claim, unchanged strength — only its window moved.
    confidence: covering.confidence,
    evidence: input.evidence,
    valid: { from: covering.valid.from, to: input.validFrom },
  });

  // The new value inherits the interval it displaced, so the timeline stays
  // contiguous and does not overlap whatever row already owns [T2, …). An
  // explicit `validTo` from the caller wins — as everywhere else in this file, a
  // null and an absent `validTo` are the same thing.
  const row = await store.insert(
    toRow({ ...input, validTo: input.validTo ?? covering.valid.to }, now, covering.factId),
  );
  return { kind: 'correction', closed: await store.byId(covering.factId), row, prior };
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
