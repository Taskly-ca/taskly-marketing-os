import { describe, it, expect, beforeEach } from 'vitest';
import {
  AppendOnlyError,
  ConstraintError,
  EmptyRangeError,
  MemoryStoreError,
  NotFoundError,
  createMemoryFactStore,
  resetFactIds,
} from './memory-store.js';
import { assertFact, correctFact, recordChange, retractFact, currentlyAsserted } from './write.js';
import {
  currentBelief,
  asOfValid,
  asOfBoth,
  beliefSnapshot,
  assertionHistory,
  wasCorrected,
} from './query.js';
import type { FactInput } from './types.js';

const ENTITY = 'ent_jiffy';
const PRICE = 'hourly_rate_cents';

const input = (over: Partial<FactInput> = {}): FactInput => ({
  entityId: ENTITY,
  predicate: PRICE,
  value: { datatype: 'num', num: 9900 },
  sourceId: 'src_1',
  observedAt: '2026-07-01T00:00:00.000Z',
  method: 'scrape',
  ...over,
});

/** `recordChange` requires a validFrom — the instant the world changed. A plain
 *  `FactInput` widens it to `string | undefined`, so the change path gets its
 *  own helper rather than a cast at every call site. */
const changeInput = (
  over: Partial<FactInput> & { validFrom: string },
): FactInput & { validFrom: string } => ({ ...input(), ...over });

let store: ReturnType<typeof createMemoryFactStore>;
beforeEach(() => {
  resetFactIds();
  store = createMemoryFactStore();
});

describe('rule 1 — assert', () => {
  it('inserts new knowledge with an open asserted range', async () => {
    const { row, created } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    expect(created).toBe(true);
    expect(row.asserted.to).toBeNull();
    expect(row.status).toBe('active');
  });

  it('does NOT insert a row for re-observing the same value', async () => {
    // Sources re-serve the same page daily. A row per observation turns the
    // asserted history into a crawl log and buries every real change in it.
    await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    const second = await assertFact(
      store,
      input({ observedAt: '2026-07-02T00:00:00.000Z' }),
      '2026-07-02T00:00:00.000Z',
    );
    expect(second.created).toBe(false);
    expect(store.all()).toHaveLength(1);
  });
});

describe('rule 2 — correction (WE were wrong)', () => {
  it('closes asserted and keeps the SAME valid range', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    const fixed = await correctFact(
      store,
      row.factId,
      { datatype: 'num', num: 8900 },
      {
        sourceId: 'src_2',
        observedAt: '2026-07-05T00:00:00.000Z',
        method: 'human',
        now: '2026-07-05T00:00:00.000Z',
      },
    );

    const old = await store.byId(row.factId);
    expect(old!.asserted.to).toBe('2026-07-05T00:00:00.000Z');
    // The world never changed — only our reading of it did.
    expect(fixed.valid).toEqual(row.valid);
    expect(fixed.supersedes).toBe(row.factId);
  });

  it('refuses to correct an already-superseded row', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    const opts = {
      sourceId: 's',
      observedAt: '2026-07-05T00:00:00.000Z',
      method: 'human' as const,
      now: '2026-07-05T00:00:00.000Z',
    };
    await correctFact(store, row.factId, { datatype: 'num', num: 8900 }, opts);
    await expect(
      correctFact(store, row.factId, { datatype: 'num', num: 7900 }, opts),
    ).rejects.toThrow(/already superseded/);
  });
});

describe('rule 3 — change (the WORLD changed)', () => {
  it('closes valid on the old row and leaves BOTH asserted open', async () => {
    await assertFact(
      store,
      input({ validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    const { closed, row } = await recordChange(
      store,
      changeInput({
        value: { datatype: 'num', num: 11900 },
        validFrom: '2026-08-01T00:00:00.000Z',
        observedAt: '2026-08-04T00:00:00.000Z',
      }),
      '2026-08-04T00:00:00.000Z',
    );

    expect(closed!.valid.to).toBe('2026-08-01T00:00:00.000Z');
    // We believe both: the old price for July, the new one for August.
    expect(closed!.asserted.to).toBeNull();
    expect(row.asserted.to).toBeNull();
    expect(currentlyAsserted(store.all())).toHaveLength(2);
  });

  it('separates when it changed from when we noticed', async () => {
    // The price changed Aug 1; we saw it Aug 4. A one-axis store must discard
    // one of those, and either loss is a real loss.
    const { row } = await recordChange(
      store,
      changeInput({
        value: { datatype: 'num', num: 11900 },
        validFrom: '2026-08-01T00:00:00.000Z',
        observedAt: '2026-08-04T00:00:00.000Z',
      }),
      '2026-08-04T00:00:00.000Z',
    );
    expect(row.valid.from).toBe('2026-08-01T00:00:00.000Z');
    expect(row.observedAt).toBe('2026-08-04T00:00:00.000Z');
    expect(row.asserted.from).toBe('2026-08-04T00:00:00.000Z');
  });

  it('treats a restatement of the current value as no change', async () => {
    await assertFact(
      store,
      input({ validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    const { closed } = await recordChange(
      store,
      changeInput({ validFrom: '2026-07-15T00:00:00.000Z' }),
      '2026-07-15T00:00:00.000Z',
    );
    expect(closed).toBeNull();
    expect(store.all()).toHaveLength(1);
  });
});

describe('Q1–Q4 — the four reads', () => {
  // A history with BOTH a real change and a correction, which is the only way
  // to tell the four queries apart.
  beforeEach(async () => {
    await assertFact(
      store,
      input({ value: { datatype: 'num', num: 9900 }, validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    await recordChange(
      store,
      changeInput({
        value: { datatype: 'num', num: 11900 },
        validFrom: '2026-08-01T00:00:00.000Z',
        observedAt: '2026-08-04T00:00:00.000Z',
      }),
      '2026-08-04T00:00:00.000Z',
    );
  });

  it('Q1 — current belief about now', async () => {
    const r = await currentBelief(store, ENTITY, PRICE, '2026-08-10T00:00:00.000Z');
    expect(r!.value).toEqual({ datatype: 'num', num: 11900 });
  });

  it('Q2 — current belief about the past', async () => {
    const r = await asOfValid(store, ENTITY, PRICE, '2026-07-15T00:00:00.000Z');
    expect(r!.value).toEqual({ datatype: 'num', num: 9900 });
  });

  it('Q3 — what we believed THEN differs from what we believe NOW', async () => {
    const july = (await store.forPredicate(ENTITY, PRICE)).find(
      (r) => r.valid.from === '2026-07-01T00:00:00.000Z',
    )!;
    await correctFact(
      store,
      july.factId,
      { datatype: 'num', num: 9500 },
      {
        sourceId: 'src_fix',
        observedAt: '2026-08-20T00:00:00.000Z',
        method: 'human',
        now: '2026-08-20T00:00:00.000Z',
      },
    );

    // Now: the corrected number.
    const now = await asOfValid(store, ENTITY, PRICE, '2026-07-15T00:00:00.000Z');
    expect(now!.value).toEqual({ datatype: 'num', num: 9500 });

    // On Aug 10 we still believed the wrong one — and a decision made that day
    // must be judged against THAT, not against what we learned later.
    const then = await asOfBoth(
      store,
      ENTITY,
      PRICE,
      '2026-07-15T00:00:00.000Z',
      '2026-08-10T00:00:00.000Z',
    );
    expect(then!.value).toEqual({ datatype: 'num', num: 9900 });
  });

  it('Q4 — a whole-entity snapshot at one instant', async () => {
    await assertFact(
      store,
      input({
        predicate: 'city',
        value: { datatype: 'text', text: 'Toronto' },
        validFrom: '2026-07-01T00:00:00.000Z',
      }),
      '2026-07-01T00:00:00.000Z',
    );
    const snap = await beliefSnapshot(store, ENTITY, '2026-08-10T00:00:00.000Z');
    expect(snap.get(PRICE)!.value).toEqual({ datatype: 'num', num: 11900 });
    expect(snap.get('city')!.value).toEqual({ datatype: 'text', text: 'Toronto' });
  });

  it('flags that a historical number was corrected, before it is quoted', async () => {
    expect(await wasCorrected(store, ENTITY, PRICE, '2026-07-15T00:00:00.000Z')).toBe(false);
    const july = (await store.forPredicate(ENTITY, PRICE)).find(
      (r) => r.valid.from === '2026-07-01T00:00:00.000Z',
    )!;
    await correctFact(
      store,
      july.factId,
      { datatype: 'num', num: 9500 },
      {
        sourceId: 's',
        observedAt: '2026-08-20T00:00:00.000Z',
        method: 'human',
        now: '2026-08-20T00:00:00.000Z',
      },
    );
    expect(await wasCorrected(store, ENTITY, PRICE, '2026-07-15T00:00:00.000Z')).toBe(true);
  });

  it('renders the correction trail oldest-belief-first', async () => {
    const trail = await assertionHistory(store, ENTITY, PRICE);
    expect(trail.map((r) => r.asserted.from)).toEqual([
      '2026-07-01T00:00:00.000Z',
      '2026-08-04T00:00:00.000Z',
    ]);
  });
});

describe('retraction preserves the audit trail', () => {
  it('keeps the row and closes asserted rather than deleting', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    await retractFact(store, row.factId, '2026-07-09T00:00:00.000Z');

    const after = await store.byId(row.factId);
    expect(after).not.toBeNull();
    expect(after!.status).toBe('retracted');
    expect(after!.asserted.to).toBe('2026-07-09T00:00:00.000Z');
    expect(await currentBelief(store, ENTITY, PRICE, '2026-07-10T00:00:00.000Z')).toBeNull();
  });

  it('still shows the retracted belief to a Q3 read from before the retraction', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    await retractFact(store, row.factId, '2026-07-09T00:00:00.000Z');
    const then = await asOfBoth(
      store,
      ENTITY,
      PRICE,
      '2026-07-05T00:00:00.000Z',
      '2026-07-05T00:00:00.000Z',
    );
    expect(then!.factId).toBe(row.factId);
  });
});

describe('the store enforces append-only, like the Postgres trigger', () => {
  it('refuses to close an already-closed asserted range', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    await store.closeAsserted(row.factId, '2026-07-05T00:00:00.000Z');
    await expect(store.closeAsserted(row.factId, '2026-07-06T00:00:00.000Z')).rejects.toThrow(
      /already closed/,
    );
  });

  it('refuses a valid bound that precedes the range start', async () => {
    const { row } = await assertFact(
      store,
      input({ validFrom: '2026-07-01T00:00:00.000Z' }),
      '2026-07-01T00:00:00.000Z',
    );
    await expect(store.closeValid(row.factId, '2026-06-01T00:00:00.000Z')).rejects.toThrow(
      /precedes/,
    );
  });

  /* ── the rules the fake used to be missing ────────────────────────────────
   *
   * Every case below is a write Postgres refuses and this store used to accept.
   * `packages/adapters/src/testing/fact-store.conformance.ts` asserts the same
   * things against BOTH stores; these repeat them here because they are the
   * memory store's own contract and should fail in `packages/world` first,
   * without a database anywhere in the picture.
   */

  it('refuses to re-close an already-closed VALID bound — 009: infinite → finite, once', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    await store.closeValid(row.factId, '2026-07-15T00:00:00.000Z');

    await expect(store.closeValid(row.factId, '2026-08-01T00:00:00.000Z')).rejects.toBeInstanceOf(
      AppendOnlyError,
    );
    const after = await store.byId(row.factId);
    expect(after!.valid.to).toBe('2026-07-15T00:00:00.000Z');
  });

  it('refuses to close a bound at the instant it opened, on either axis', async () => {
    const at = '2026-07-01T00:00:00.000Z';
    const { row } = await assertFact(store, input({ validFrom: at }), at);

    await expect(store.closeValid(row.factId, at)).rejects.toBeInstanceOf(EmptyRangeError);
    await expect(store.closeAsserted(row.factId, at)).rejects.toBeInstanceOf(EmptyRangeError);

    const after = await store.byId(row.factId);
    expect(after!.valid.to).toBeNull();
    expect(after!.asserted.to).toBeNull();
  });

  it('refuses an ASSERTED bound that precedes the range start, as closeValid always did', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');

    const error = await store
      .closeAsserted(row.factId, '2026-06-01T00:00:00.000Z')
      .then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(AppendOnlyError);
    expect((error as Error).message).toMatch(/precedes asserted\.from/);
  });

  it('refuses to insert a range that ends before it starts, on either axis', async () => {
    const inverted = { from: '2026-08-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');

    await expect(store.insert({ ...row, valid: inverted })).rejects.toBeInstanceOf(ConstraintError);
    await expect(store.insert({ ...row, asserted: inverted })).rejects.toBeInstanceOf(
      ConstraintError,
    );
    expect(store.all()).toHaveLength(1);
  });

  it('refuses to insert an EMPTY range — the row would be undecodable in Postgres', async () => {
    const empty = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' };
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');

    await expect(store.insert({ ...row, valid: empty })).rejects.toThrow(/contains no instant/);
    expect(store.all()).toHaveLength(1);
  });

  it('reports a missing row as NotFoundError on every mutation', async () => {
    await expect(store.closeValid('fact_nope', '2026-07-01T00:00:00.000Z')).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(
      store.closeAsserted('fact_nope', '2026-07-01T00:00:00.000Z'),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(store.setStatus('fact_nope', 'retracted')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('names every failure after its class, so either store is recognisable by error.name', async () => {
    // `@tmos/adapters` cannot be imported here — it depends on this package —
    // so the two taxonomies are mirrored rather than shared, and `name` is the
    // string a conformance case compares across both.
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    const error = await store
      .closeValid(row.factId, '2026-06-01T00:00:00.000Z')
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(MemoryStoreError);
    expect((error as Error).name).toBe('AppendOnlyError');
  });

  it('hands back copies, so a caller cannot mutate stored state', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    row.value = { datatype: 'num', num: 1 };
    const fresh = await store.byId(row.factId);
    expect(fresh!.value).toEqual({ datatype: 'num', num: 9900 });
  });
});

/* ── the out-of-order arrival: a "change" reported INSIDE a closed window ──
 *
 * The single most damaging error this system can make is doing rule 3's work on
 * rule 2's axis. Every case below is one arrival that LOOKS like a change and
 * is not, and each asserts the same thing from a different angle: a bound that
 * is already closed is never rewritten. Migration 009 raises on that rewrite,
 * so a green run here that did not pin it would be a green run against a store
 * Postgres can never be.
 */
const JUL_01 = '2026-07-01T00:00:00.000Z';
const JUL_05 = '2026-07-05T00:00:00.000Z';
const JUL_15 = '2026-07-15T00:00:00.000Z';
const JUL_20 = '2026-07-20T00:00:00.000Z';
const AUG_01 = '2026-08-01T00:00:00.000Z';
const AUG_04 = '2026-08-04T00:00:00.000Z';
const AUG_06 = '2026-08-06T00:00:00.000Z';
const AUG_10 = '2026-08-10T00:00:00.000Z';

const cents = (num: number) => ({ datatype: 'num' as const, num });

/** July at 9900, then a raise to 11900 on Aug 1 — recorded in order, correctly.
 *  Everything below then reports a THIRD fact about July, after the fact. */
async function julyThenAugust() {
  const { row: july } = await assertFact(store, input({ validFrom: JUL_01 }), JUL_01);
  const { row: august } = await recordChange(
    store,
    changeInput({ value: cents(11900), validFrom: AUG_01, observedAt: AUG_04 }),
    AUG_04,
  );
  return { july, august };
}

describe('rule 3 — a change inside an ALREADY-CLOSED window is a correction', () => {
  it('never rewrites the closed valid bound — it closes asserted instead', async () => {
    const { july } = await julyThenAugust();

    const out = await recordChange(
      store,
      changeInput({ value: cents(10500), validFrom: JUL_15, observedAt: AUG_10 }),
      AUG_10,
    );

    const old = await store.byId(july.factId);
    // The defect, asserted first and on its own terms: this used to become
    // { from: JUL_01, to: JUL_15 } — the record of what we believed destroyed,
    // and migration 009 raising against the real database.
    expect(old!.valid).toEqual({ from: JUL_01, to: AUG_01 });
    expect(old!.asserted.to).toBe(AUG_10);
    expect(out.kind).toBe('correction');
  });

  it('re-issues the old value over the window it really held, and the new value over the rest', async () => {
    const { july } = await julyThenAugust();

    const out = await recordChange(
      store,
      changeInput({ value: cents(10500), validFrom: JUL_15, observedAt: AUG_10 }),
      AUG_10,
    );

    expect(out.prior!.value).toEqual(cents(9900));
    expect(out.prior!.valid).toEqual({ from: JUL_01, to: JUL_15 });
    expect(out.prior!.asserted).toEqual({ from: AUG_10, to: null });

    expect(out.row.value).toEqual(cents(10500));
    expect(out.row.valid).toEqual({ from: JUL_15, to: AUG_01 });
    expect(out.row.asserted).toEqual({ from: AUG_10, to: null });

    // One row became two, and both say which row they replace.
    expect(out.prior!.supersedes).toBe(july.factId);
    expect(out.row.supersedes).toBe(july.factId);
  });

  it('leaves the later interval untouched — it was never in question', async () => {
    const { august } = await julyThenAugust();
    await recordChange(
      store,
      changeInput({ value: cents(10500), validFrom: JUL_15, observedAt: AUG_10 }),
      AUG_10,
    );

    const later = await store.byId(august.factId);
    expect(later!.valid).toEqual({ from: AUG_01, to: null });
    expect(later!.asserted.to).toBeNull();
  });

  it('leaves a contiguous, non-overlapping timeline', async () => {
    await julyThenAugust();
    await recordChange(
      store,
      changeInput({ value: cents(10500), validFrom: JUL_15, observedAt: AUG_10 }),
      AUG_10,
    );

    const live = currentlyAsserted(store.all()).sort(
      (a, b) => new Date(a.valid.from).getTime() - new Date(b.valid.from).getTime(),
    );
    expect(live.map((r) => [r.valid.from, r.valid.to])).toEqual([
      [JUL_01, JUL_15],
      [JUL_15, AUG_01],
      [AUG_01, null],
    ]);
  });

  it('keeps "what did we believe on date D" answerable across the correction', async () => {
    await julyThenAugust();
    await recordChange(
      store,
      changeInput({ value: cents(10500), validFrom: JUL_15, observedAt: AUG_10 }),
      AUG_10,
    );

    // Q3 — on Aug 6 we still thought July was 9900 all month. A decision made
    // that day has to be judged against that, and it is still there to be read.
    const then = await asOfBoth(store, ENTITY, PRICE, JUL_20, AUG_06);
    expect(then!.value).toEqual(cents(9900));

    // Q2 — what we believe now about the same instant.
    const now = await asOfValid(store, ENTITY, PRICE, JUL_20);
    expect(now!.value).toEqual(cents(10500));

    expect(await wasCorrected(store, ENTITY, PRICE, JUL_20)).toBe(true);
  });

  it('refuses the correction when the belief opened at the same instant (frozen now())', async () => {
    // Postgres freezes now() for a whole transaction, so a row inserted and
    // corrected inside one withTx would close asserted at the instant it opened
    // — an empty interval, which 009 rejects and the adapter reports as
    // EmptyRangeError. Caught before any write, so nothing is half-applied.
    const { row } = await assertFact(store, input({ validFrom: JUL_01, validTo: AUG_01 }), AUG_10);

    await expect(
      recordChange(
        store,
        changeInput({ value: cents(10500), validFrom: JUL_15, observedAt: AUG_10 }),
        AUG_10,
      ),
    ).rejects.toThrow(/no instant/);

    expect(store.all()).toHaveLength(1);
    expect((await store.byId(row.factId))!.asserted.to).toBeNull();
  });
});

describe('rule 3 — the edges of the covering window', () => {
  it('a change AT the instant an open window opened is a plain correction', async () => {
    // The recorded value never held for one instant, so we were wrong from the
    // start. Splitting would mint a [JUL_01, JUL_01) prior — an interval
    // containing no instant, which asserts nothing and which 009 refuses.
    const { row } = await assertFact(store, input({ validFrom: JUL_01 }), JUL_01);

    const out = await recordChange(
      store,
      changeInput({ value: cents(8800), validFrom: JUL_01, observedAt: JUL_15 }),
      JUL_15,
    );

    // Closing valid here would leave [JUL_01, JUL_01) behind: an interval that
    // contains no instant, matches nothing forever, and that 009 refuses.
    const old = await store.byId(row.factId);
    expect(old!.valid).toEqual({ from: JUL_01, to: null });
    expect(old!.asserted.to).toBe(JUL_15);

    expect(out.kind).toBe('correction');
    expect(out.prior).toBeNull();
    expect(out.row.valid).toEqual({ from: JUL_01, to: null });
    expect(out.row.supersedes).toBe(row.factId);
    expect(store.all()).toHaveLength(2);
  });

  it('a change AT the instant a closed window opened copies that window', async () => {
    const { july } = await julyThenAugust();

    const out = await recordChange(
      store,
      changeInput({ value: cents(9500), validFrom: JUL_01, observedAt: AUG_10 }),
      AUG_10,
    );

    expect((await store.byId(july.factId))!.valid).toEqual({ from: JUL_01, to: AUG_01 });
    expect(out.kind).toBe('correction');
    expect(out.prior).toBeNull();
    expect(out.row.valid).toEqual({ from: JUL_01, to: AUG_01 });

    for (const r of store.all()) {
      if (r.valid.to === null) continue;
      expect(new Date(r.valid.to).getTime()).toBeGreaterThan(new Date(r.valid.from).getTime());
    }
  });

  it('a change AT a closed window’s upper bound opens a fresh window', async () => {
    // `[from, to)` is half-open, so the upper bound is not covered by anything.
    // Nothing to close and nothing to correct: [JUL_01, AUG_01) is still exactly
    // what we believe, and the new value picks up where it left off.
    const { row } = await assertFact(store, input({ validFrom: JUL_01, validTo: AUG_01 }), JUL_01);

    const out = await recordChange(
      store,
      changeInput({ value: cents(11900), validFrom: AUG_01, observedAt: AUG_04 }),
      AUG_04,
    );

    expect(out.kind).toBe('opened');
    expect(out.closed).toBeNull();
    expect(out.prior).toBeNull();
    expect(out.row.valid).toEqual({ from: AUG_01, to: null });
    expect(out.row.supersedes).toBeNull();

    const old = await store.byId(row.factId);
    expect(old!.valid).toEqual({ from: JUL_01, to: AUG_01 });
    expect(old!.asserted.to).toBeNull();
  });

  it('inserts standalone when no window covers the instant at all', async () => {
    const out = await recordChange(
      store,
      changeInput({ value: cents(11900), validFrom: AUG_01, observedAt: AUG_04 }),
      AUG_04,
    );

    expect(out.kind).toBe('opened');
    expect(out.closed).toBeNull();
    expect(out.prior).toBeNull();
    expect(out.row.supersedes).toBeNull();
    expect(store.all()).toHaveLength(1);
  });

  it('a restatement inside a closed window writes nothing at all', async () => {
    const { july } = await julyThenAugust();

    const out = await recordChange(
      store,
      changeInput({ validFrom: JUL_15, observedAt: AUG_10 }),
      AUG_10,
    );

    expect(out.kind).toBe('unchanged');
    expect(out.closed).toBeNull();
    expect(out.prior).toBeNull();
    expect(out.row.factId).toBe(july.factId);
    expect(store.all()).toHaveLength(2);
    expect((await store.byId(july.factId))!.asserted.to).toBeNull();
  });

  it('acts on the row a READ would surface when two windows cover the instant', async () => {
    // Two sources disagreeing about the same period is an unresolved factual
    // conflict — fact_conflict's problem, not this function's. It must at least
    // be deterministic: `forPredicate` is insertion-ordered in memory and
    // ordered by lower(asserted) in Postgres, so picking "the first match"
    // picked a different row in each store.
    const { row: first } = await assertFact(store, input({ validFrom: JUL_01 }), JUL_01);
    const { row: second } = await assertFact(
      store,
      input({ value: cents(9700), validFrom: JUL_01, sourceId: 'src_2', observedAt: JUL_05 }),
      JUL_05,
    );
    expect((await currentBelief(store, ENTITY, PRICE, JUL_15))!.factId).toBe(second.factId);

    const out = await recordChange(
      store,
      changeInput({ value: cents(12000), validFrom: JUL_15, observedAt: AUG_04 }),
      AUG_04,
    );

    expect(out.kind).toBe('change');
    expect(out.closed!.factId).toBe(second.factId);
    expect(out.closed!.valid.to).toBe(JUL_15);
    // The other side of the disagreement is left exactly as it was.
    expect((await store.byId(first.factId))!.valid.to).toBeNull();
    expect((await store.byId(first.factId))!.asserted.to).toBeNull();
  });
});

describe('rule 2 — correcting the WINDOW, not the value', () => {
  it('supersedes the row with a corrected valid range and mutates nothing', async () => {
    // 009: "a wrong end date is corrected on the ASSERTED axis — close asserted
    // and supersede — never by rewriting valid."
    const { row } = await assertFact(store, input({ validFrom: JUL_01, validTo: AUG_01 }), JUL_01);

    const fixed = await correctFact(store, row.factId, row.value, {
      sourceId: 'src_2',
      observedAt: AUG_10,
      method: 'human',
      now: AUG_10,
      valid: { from: JUL_01, to: JUL_15 },
    });

    expect(fixed.valid).toEqual({ from: JUL_01, to: JUL_15 });
    expect(fixed.supersedes).toBe(row.factId);
    const old = await store.byId(row.factId);
    expect(old!.valid).toEqual({ from: JUL_01, to: AUG_01 });
    expect(old!.asserted.to).toBe(AUG_10);
  });

  it('refuses a corrected window that contains no instant', async () => {
    const { row } = await assertFact(store, input({ validFrom: JUL_01 }), JUL_01);
    await expect(
      correctFact(store, row.factId, row.value, {
        sourceId: 'src_2',
        observedAt: AUG_10,
        method: 'human',
        now: AUG_10,
        valid: { from: JUL_01, to: JUL_01 },
      }),
    ).rejects.toThrow(/no instant/);
    expect((await store.byId(row.factId))!.asserted.to).toBeNull();
  });

  it('refuses to close a belief at the instant it opened', async () => {
    const { row } = await assertFact(store, input(), AUG_10);
    await expect(
      correctFact(store, row.factId, cents(1), {
        sourceId: 'src_2',
        observedAt: AUG_10,
        method: 'human',
        now: AUG_10,
      }),
    ).rejects.toThrow(/no instant/);
    expect(store.all()).toHaveLength(1);
  });
});
