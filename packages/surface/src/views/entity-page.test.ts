import { describe, it, expect } from 'vitest';
import type { EvidenceRef, Finding } from '@tmos/contracts';
import { findConfidenceNumbers } from '../basis.js';
import { buildEntityPage } from './entity-page.js';
import type { ConflictRecord, FactRecord } from './entity-page.js';

const ev = (url: string, span: string): EvidenceRef => ({
  signal_id: null,
  fact_id: null,
  source_url: url,
  span,
  observed_at: '2026-07-01T00:00:00.000Z',
});

const fact = (
  over: Partial<FactRecord> & { factId: string; predicate: string; value: string },
) => ({
  valid: { from: '2026-01-01T00:00:00.000Z', to: null },
  asserted: { from: '2026-01-01T00:00:00.000Z', to: null },
  sourceId: 'src-1',
  sourceName: 'jiffy.example',
  evidence: ev('https://jiffy.example/pricing', over.value),
  observedAt: '2026-01-01T00:00:00.000Z',
  status: 'active' as const,
  basis: 'inferred_from_sources' as const,
  supersedes: null,
  ...over,
});

/* The world changed: the price was $99 until Aug 1, then $119. */
const priceThen = fact({
  factId: 'f-price-1',
  predicate: 'price_cents',
  value: '9900',
  valid: { from: '2026-06-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
  observedAt: '2026-06-02T00:00:00.000Z',
});
const priceNow = fact({
  factId: 'f-price-2',
  predicate: 'price_cents',
  value: '11900',
  valid: { from: '2026-08-01T00:00:00.000Z', to: null },
  asserted: { from: '2026-08-01T12:00:00.000Z', to: null },
  observedAt: '2026-08-01T12:00:00.000Z',
});

/* We were wrong: the HQ was always Mississauga; we recorded Toronto and fixed it. */
const hqWrong = fact({
  factId: 'f-hq-1',
  predicate: 'hq_city',
  value: 'Toronto',
  valid: { from: '2020-01-01T00:00:00.000Z', to: null },
  asserted: { from: '2026-06-01T00:00:00.000Z', to: '2026-07-10T00:00:00.000Z' },
  observedAt: '2026-06-01T00:00:00.000Z',
});
const hqRight = fact({
  factId: 'f-hq-2',
  predicate: 'hq_city',
  value: 'Mississauga',
  valid: { from: '2020-01-01T00:00:00.000Z', to: null },
  asserted: { from: '2026-07-10T00:00:00.000Z', to: null },
  observedAt: '2026-07-10T00:00:00.000Z',
  supersedes: 'f-hq-1',
});

/* Two sources, same instant, incompatible: exactly one is wrong. */
const feeA = fact({
  factId: 'f-fee-a',
  predicate: 'take_rate',
  value: '15%',
  sourceId: 'src-a',
  sourceName: 'jiffy.example',
  evidence: ev('https://jiffy.example/terms', 'we keep 15% of every job'),
  observedAt: '2026-07-20T00:00:00.000Z',
});
const feeB = fact({
  factId: 'f-fee-b',
  predicate: 'take_rate',
  value: '20%',
  sourceId: 'src-b',
  sourceName: 'thestar.example',
  evidence: ev('https://thestar.example/story', 'the company takes 20 per cent'),
  observedAt: '2026-07-21T00:00:00.000Z',
});

const temporalConflict: ConflictRecord = {
  id: 'c-temporal',
  predicate: 'price_cents',
  kind: 'temporal',
  status: 'open',
  validInstant: '2026-08-01T00:00:00.000Z',
  factIds: ['f-price-1', 'f-price-2'],
};
const factualConflict: ConflictRecord = {
  id: 'c-factual',
  predicate: 'take_rate',
  kind: 'factual',
  status: 'open',
  validInstant: '2026-07-21T00:00:00.000Z',
  factIds: ['f-fee-a', 'f-fee-b'],
};

const finding: Finding = {
  id: 'find-1',
  claim: 'Jiffy listed snow removal in the GTA.',
  so_what: 'It overlaps a category we planned to own this winter.',
  subject_refs: ['company:jiffy'],
  evidence: [ev('https://jiffy.example/pricing', 'snow removal')],
  basis: 'inferred_from_sources',
  causal_rung: 0,
  stakes: 'high',
  region: 'ca',
  domain_score: 0.88,
  generated_by: 'agent:test@1',
  reviewed_by: null,
  superseded_by: null,
  supersede_reason: null,
  created_at: '2026-07-30T00:00:00.000Z',
};

const page = () =>
  buildEntityPage({
    entity: { ref: 'company:jiffy', name: 'Jiffy', region: 'ca' },
    facts: [priceThen, priceNow, hqWrong, hqRight, feeA, feeB],
    conflicts: [temporalConflict, factualConflict],
    findings: [finding],
    peers: [
      {
        entityRef: 'company:taskrabbit',
        name: 'TaskRabbit',
        predicates: ['price_cents', 'sla_hours'],
      },
      { entityRef: 'company:handy', name: 'Handy', predicates: ['sla_hours'] },
    ],
    asOf: '2026-08-05T00:00:00.000Z',
  });

describe('current facts', () => {
  it('shows only what we believe now, with its evidence and rendered basis', () => {
    const p = page();
    const byPredicate = Object.fromEntries(p.currentFacts.map((f) => [f.predicate, f]));
    expect(byPredicate['price_cents']?.value).toBe('11900');
    expect(byPredicate['hq_city']?.value).toBe('Mississauga');
    expect(byPredicate['hq_city']?.evidence?.source_url).toMatch(/jiffy\.example/);
    expect(byPredicate['price_cents']?.basis.label).toMatch(/Inferred/);
  });

  it('flags a contested value instead of presenting it as settled', () => {
    const p = page();
    const takeRate = p.currentFacts.find((f) => f.predicate === 'take_rate');
    expect(takeRate?.contested).toBe(true);
    expect(takeRate?.conflictId).toBe('c-factual');
  });
});

describe('history on both axes — the world changing is not us being wrong', () => {
  it('labels a world change and a self-correction differently, from the same rows', () => {
    const p = page();
    const price = p.timeline.find((e) => e.predicate === 'price_cents');
    const hq = p.timeline.find((e) => e.predicate === 'hq_city');

    expect(price?.kind).toBe('world_change');
    expect(price?.axis).toBe('valid');
    expect(price?.from?.value).toBe('9900');
    expect(price?.to.value).toBe('11900');
    expect(price?.label).toMatch(/changed/i);

    expect(hq?.kind).toBe('we_corrected_ourselves');
    expect(hq?.axis).toBe('asserted');
    expect(hq?.from?.value).toBe('Toronto');
    expect(hq?.to.value).toBe('Mississauga');
    expect(hq?.label).toMatch(/our belief|we recorded/i);

    // The two stories must not be renderable as one thing.
    expect(price?.kind).not.toBe(hq?.kind);
    expect(p.counts.worldChanges).toBe(1);
    expect(p.counts.corrections).toBe(1);
  });

  it('orders the timeline newest first, deterministically', () => {
    const first = page().timeline.map((e) => `${e.at}/${e.predicate}`);
    const second = page().timeline.map((e) => `${e.at}/${e.predicate}`);
    expect(first).toEqual(second);
    expect(first).toEqual([...first].sort().reverse());
  });
});

describe('conflicts are typed before they are shown', () => {
  it('renders a temporal conflict as history, not as a dispute', () => {
    const p = page();
    expect(p.disputes.map((d) => d.conflictId)).not.toContain('c-temporal');
    const asHistory = p.timeline.find((e) => e.conflictId === 'c-temporal');
    expect(asHistory?.kind).toBe('world_change');
  });

  it('still renders a temporal conflict as history when the rows alone are ambiguous', () => {
    // Both beliefs open, both claiming the same instant — the row pair on its own
    // reads as a disagreement. The world model typed it `temporal`, so it is a
    // change, and it must not fall through into `disputes`.
    const p = buildEntityPage({
      entity: { ref: 'company:jiffy', name: 'Jiffy', region: 'ca' },
      facts: [feeA, feeB],
      conflicts: [{ ...factualConflict, id: 'c-t2', kind: 'temporal' }],
      findings: [],
      peers: [],
      asOf: '2026-08-05T00:00:00.000Z',
    });
    expect(p.disputes).toEqual([]);
    expect(p.timeline.map((e) => [e.kind, e.conflictId])).toEqual([['world_change', 'c-t2']]);
    expect(p.timeline[0]?.label).toMatch(/not a dispute/);
  });

  it('shows BOTH values of a factual conflict, each with its source', () => {
    const p = page();
    const dispute = p.disputes.find((d) => d.conflictId === 'c-factual');
    expect(dispute?.kind).toBe('factual');
    expect(dispute?.sides.map((s) => s.value).sort()).toEqual(['15%', '20%']);
    expect(dispute?.sides.map((s) => s.evidence?.source_url).sort()).toEqual([
      'https://jiffy.example/terms',
      'https://thestar.example/story',
    ]);
    // Never a fused value presented as if nobody disagreed.
    expect(dispute?.fusedValue).toBeNull();
    expect(Object.keys(dispute ?? {})).not.toContain('value');
  });
});

describe('what we do NOT know', () => {
  it('names a predicate peers have and this entity lacks', () => {
    const p = page();
    const gap = p.gaps.find((g) => g.predicate === 'sla_hours');
    expect(gap?.heldByPeers).toBe(2);
    expect(gap?.peerExamples).toEqual(['Handy', 'TaskRabbit']);
    expect(p.gaps.map((g) => g.predicate)).not.toContain('price_cents');
  });
});

describe('the page as a whole', () => {
  it('carries related findings, most recent first', () => {
    expect(page().findings.map((f) => f.id)).toEqual(['find-1']);
  });

  it('exposes no confidence number and no domain_score', () => {
    const json = JSON.stringify(page());
    expect(json).not.toMatch(/domain_?score/i);
    expect(findConfidenceNumbers(json)).toEqual([]);
  });
});
