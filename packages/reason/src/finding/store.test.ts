import { describe, it, expect } from 'vitest';
import { createMemoryFindingStore, findingDedupeKey, evidenceKey } from './store.js';
import type { EvidenceRef, Finding } from '@tmos/contracts';

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const PRICING = 'https://jiffyondemand.com/pricing';

const ev = (over: Partial<EvidenceRef> = {}): EvidenceRef => ({
  signal_id: uuid(900),
  fact_id: null,
  source_url: PRICING,
  span: 'Our handyman rate is 6000 cents per hour.',
  observed_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  id: uuid(1),
  claim: 'Jiffy lists its handyman rate at 6000 cents per hour.',
  so_what: 'Our posted band sits above theirs, so the price gap narrowed.',
  subject_refs: ['company:jiffy'],
  evidence: [ev()],
  basis: 'inferred_from_sources',
  causal_rung: 0,
  stakes: 'medium',
  region: 'ca',
  domain_score: 0.6,
  generated_by: 'agent:t2@1',
  reviewed_by: null,
  superseded_by: null,
  supersede_reason: null,
  created_at: '2026-08-01T00:00:00.000Z',
  ...over,
});

describe('corrections supersede, they never mutate', () => {
  it('preserves the original verbatim and links it to the replacement', async () => {
    const store = createMemoryFindingStore();
    const original = finding();
    await store.put(original);

    const replacement = finding({
      id: uuid(2),
      claim: 'Jiffy lists its handyman rate at 7000 cents per hour.',
      created_at: '2026-08-02T00:00:00.000Z',
    });
    const r = await store.supersede(original.id, replacement, 'misread the pricing table row');
    expect(r.ok).toBe(true);

    const kept = await store.byId(original.id);
    // Everything the original asserted is still readable, unchanged.
    expect(kept?.claim).toBe(original.claim);
    expect(kept?.evidence).toEqual(original.evidence);
    expect(kept?.domain_score).toBe(original.domain_score);
    // Only the two supersession columns moved.
    expect(kept?.superseded_by).toBe(replacement.id);
    expect(kept?.supersede_reason).toBe('misread the pricing table row');
    // And the caller's object was not mutated under it.
    expect(original.superseded_by).toBeNull();
  });

  it('refuses a correction with no stated cause', async () => {
    const store = createMemoryFindingStore();
    const original = finding();
    await store.put(original);

    const r = await store.supersede(original.id, finding({ id: uuid(2) }), '   ');
    expect(r).toMatchObject({ ok: false, reason: 'missing_reason' });
    // Nothing was written: a reasonless correction is not half-applied.
    expect((await store.byId(original.id))?.superseded_by).toBeNull();
    expect(await store.byId(uuid(2))).toBeNull();
  });

  it('walks a multi-step chain to the live tip', async () => {
    const store = createMemoryFindingStore();
    const a = finding({ id: uuid(1) });
    const b = finding({ id: uuid(2), claim: 'b claim 6000' });
    const c = finding({ id: uuid(3), claim: 'c claim 6000' });
    await store.put(a);
    await store.supersede(a.id, b, 'first correction');
    await store.supersede(b.id, c, 'second correction');

    const chain = await store.chain(a.id);
    expect(chain.map((f) => f.id)).toEqual([uuid(1), uuid(2), uuid(3)]);
    expect((await store.unsuperseded()).map((f) => f.id)).toEqual([uuid(3)]);
  });

  it('will not supersede something already superseded, or itself', async () => {
    const store = createMemoryFindingStore();
    const a = finding({ id: uuid(1) });
    await store.put(a);
    await store.supersede(a.id, finding({ id: uuid(2) }), 'first');

    expect(await store.supersede(a.id, finding({ id: uuid(3) }), 'again')).toMatchObject({
      ok: false,
      reason: 'already_superseded',
    });
    expect(await store.supersede(uuid(2), finding({ id: uuid(2) }), 'self')).toMatchObject({
      ok: false,
      reason: 'self_supersede',
    });
    expect(await store.supersede(uuid(77), finding({ id: uuid(3) }), 'ghost')).toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it('lets a correction reuse the original claim and evidence', async () => {
    // A correction to `so_what` alone shares the dedupe key with the original.
    // Deduplication must not swallow it — supersession is an explicit act.
    const store = createMemoryFindingStore();
    const a = finding({ id: uuid(1) });
    await store.put(a);
    const b = finding({ id: uuid(2), so_what: 'Actually it narrows our margin, not theirs.' });
    expect(await store.supersede(a.id, b, 'wrong consequence drawn')).toMatchObject({ ok: true });
    expect((await store.chain(a.id)).map((f) => f.id)).toEqual([uuid(1), uuid(2)]);
  });
});

describe('deduplication — same claim, same evidence, one finding', () => {
  it('refuses a second copy and points at what we already hold', async () => {
    const store = createMemoryFindingStore();
    await store.put(finding());
    const again = await store.put(finding({ id: uuid(2), created_at: '2026-08-03T00:00:00.000Z' }));
    expect(again).toMatchObject({ ok: true, stored: false });
    if (again.ok && !again.stored) expect(again.duplicateOf.id).toBe(uuid(1));
    expect(await store.unsuperseded()).toHaveLength(1);
  });

  it('ignores the parts a re-run wobbles: so_what, score, author, time', async () => {
    const a = finding();
    const b = finding({
      id: uuid(2),
      so_what: 'A differently worded consequence.',
      domain_score: 0.91,
      generated_by: 'agent:t2@2',
      created_at: '2026-09-09T00:00:00.000Z',
    });
    expect(findingDedupeKey(b)).toBe(findingDedupeKey(a));
  });

  it('treats a new source for the same claim as new — that is corroboration', async () => {
    const store = createMemoryFindingStore();
    await store.put(finding());
    const elsewhere = await store.put(
      finding({ id: uuid(2), evidence: [ev({ signal_id: uuid(901) })] }),
    );
    expect(elsewhere).toMatchObject({ ok: true, stored: true });
  });

  it('keys evidence on the document, not the exact substring quoted', async () => {
    // The span is a model-chosen slice and wobbles by a word between runs.
    expect(evidenceKey(ev({ span: 'Our handyman rate is 6000 cents per hour.' }))).toBe(
      evidenceKey(ev({ span: 'rate is 6000 cents' })),
    );
  });

  it('falls back to the canonical URL when there is no signal or fact id', async () => {
    const bare = { signal_id: null, fact_id: null } as const;
    expect(evidenceKey(ev({ ...bare, source_url: `${PRICING}?utm_source=x#top` }))).toBe(
      evidenceKey(ev({ ...bare, source_url: `https://www.jiffyondemand.com/pricing/` })),
    );
  });

  it('normalises claim whitespace, case and trailing punctuation', async () => {
    expect(findingDedupeKey(finding({ claim: '  Jiffy   LISTS 6000  ' }))).toBe(
      findingDedupeKey(finding({ claim: 'jiffy lists 6000.' })),
    );
  });
});

describe('the store refuses what the schema refuses', () => {
  it('rejects a finding with no evidence', async () => {
    const store = createMemoryFindingStore();
    expect(await store.put(finding({ evidence: [] }))).toMatchObject({
      ok: false,
      reason: 'invalid_finding',
    });
  });

  it('rejects a re-used id', async () => {
    const store = createMemoryFindingStore();
    await store.put(finding());
    expect(await store.put(finding({ claim: 'a wholly different claim' }))).toMatchObject({
      ok: false,
      reason: 'duplicate_id',
    });
  });
});

describe('queries', () => {
  const seed = async () => {
    const store = createMemoryFindingStore();
    await store.put(
      finding({
        id: uuid(1),
        claim: 'one 6000',
        stakes: 'high',
        created_at: '2026-08-01T00:00:00.000Z',
      }),
    );
    await store.put(
      finding({
        id: uuid(2),
        claim: 'two 6000',
        stakes: 'low',
        subject_refs: ['company:taskrabbit'],
        created_at: '2026-08-03T00:00:00.000Z',
      }),
    );
    await store.put(
      finding({
        id: uuid(3),
        claim: 'three 6000',
        stakes: 'high',
        created_at: '2026-08-02T00:00:00.000Z',
      }),
    );
    return store;
  };

  it('finds by subject and by stakes', async () => {
    const store = await seed();
    expect((await store.bySubject('company:jiffy')).map((f) => f.id)).toEqual([uuid(3), uuid(1)]);
    expect((await store.byStakes('high')).map((f) => f.id)).toEqual([uuid(3), uuid(1)]);
    expect(await store.bySubject('company:unknown')).toEqual([]);
  });

  it('orders by recency, newest first, and honours the limit', async () => {
    const store = await seed();
    expect((await store.recent(2)).map((f) => f.id)).toEqual([uuid(2), uuid(3)]);
    expect(await store.recent(0)).toEqual([]);
  });

  it('hides superseded findings by default and shows them on request', async () => {
    const store = await seed();
    const fix = finding({
      id: uuid(4),
      claim: 'four 6000',
      created_at: '2026-08-04T00:00:00.000Z',
    });
    await store.supersede(uuid(1), fix, 'corrected');
    expect((await store.bySubject('company:jiffy')).map((f) => f.id)).toEqual([uuid(4), uuid(3)]);
    expect(
      (await store.bySubject('company:jiffy', { includeSuperseded: true })).map((f) => f.id),
    ).toContain(uuid(1));
  });
});
