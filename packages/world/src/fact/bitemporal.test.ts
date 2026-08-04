import { describe, it, expect, beforeEach } from 'vitest';
import { createMemoryFactStore, resetFactIds } from './memory-store.js';
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

  it('hands back copies, so a caller cannot mutate stored state', async () => {
    const { row } = await assertFact(store, input(), '2026-07-01T00:00:00.000Z');
    row.value = { datatype: 'num', num: 1 };
    const fresh = await store.byId(row.factId);
    expect(fresh!.value).toEqual({ datatype: 'num', num: 9900 });
  });
});
