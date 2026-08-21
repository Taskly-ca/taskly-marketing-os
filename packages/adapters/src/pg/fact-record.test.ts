/**
 * The proof that a `FactRow` can become a `FactRecord` without either package
 * learning about the other — and, more to the point, without the mapper
 * inventing anything to make the target shape validate. Deterministic and
 * keyless: nothing here needs a database, which is the whole reason the mapper
 * takes maps rather than ports.
 */
import { describe, expect, it } from 'vitest';

import { evidenceRefSchema } from '@tmos/contracts';
import type { Basis } from '@tmos/contracts';
import { basisDisplay, buildEntityPage, weakestBasis } from '@tmos/surface';
import type { FactMethod, FactRow } from '@tmos/world';

import {
  ENTITY_UNRESOLVED,
  UNIT_UNRECORDED,
  basisForFact,
  basisForMethod,
  factViewKeys,
  renderFactValue,
  toConflictRecord,
  toEvidenceRef,
  toFactRecord,
  toFactRecords,
} from './fact-record.js';
import type { FactViewLookups } from './fact-record.js';

const FACT_UUID = '11111111-1111-4111-8111-111111111111';

const row = (over: Partial<FactRow> = {}): FactRow => ({
  factId: FACT_UUID,
  entityId: 'entity-jiffy',
  predicate: 'price_per_hour',
  value: { datatype: 'num', num: 9900 },
  valid: { from: '2026-07-01T00:00:00.000Z', to: null },
  asserted: { from: '2026-07-04T00:00:00.000Z', to: null },
  sourceId: 'source-1',
  observedAt: '2026-07-04T00:00:00.000Z',
  confidence: 0.91,
  method: 'scrape',
  evidence: { url: 'https://jiffy.example/pricing', snippet: '$99 per hour' },
  supersedes: null,
  status: 'active',
  ...over,
});

const lookups = (over: Partial<FactViewLookups> = {}): FactViewLookups => ({
  predicates: new Map([['price_per_hour', { unit: 'cents' }]]),
  entityNames: new Map([['entity-jiffy', 'Jiffy']]),
  sourceNames: new Map([['source-1', 'Jiffy pricing page']]),
  ...over,
});

const EMPTY: FactViewLookups = {
  predicates: new Map(),
  entityNames: new Map(),
  sourceNames: new Map(),
};

const METHODS: readonly FactMethod[] = ['llm_extract', 'scrape', 'api', 'human'];

/* ── 1. value: a four-variant union becomes one string ──────────────────── */

describe('renderFactValue', () => {
  it('renders text verbatim', () => {
    expect(renderFactValue({ datatype: 'text', text: 'Etobicoke' }, 'service_area', EMPTY)).toBe(
      'Etobicoke',
    );
  });

  it('renders a number with the unit from its predicate definition', () => {
    expect(renderFactValue({ datatype: 'num', num: 9900 }, 'price_per_hour', lookups())).toBe(
      '9900 cents',
    );
  });

  it('refuses to print a bare number when the predicate is unknown to the lookup', () => {
    // `99` becoming dollars in one brief and cents in another is exactly what
    // predicates.ts refuses at write time; the renderer must not undo it.
    expect(renderFactValue({ datatype: 'num', num: 9900 }, 'price_per_hour', EMPTY)).toBe(
      `9900 ${UNIT_UNRECORDED}`,
    );
  });

  it('refuses a bare number when the predicate is known but carries no unit', () => {
    const known = lookups({ predicates: new Map([['price_per_hour', { unit: null }]]) });
    expect(renderFactValue({ datatype: 'num', num: 9900 }, 'price_per_hour', known)).toBe(
      `9900 ${UNIT_UNRECORDED}`,
    );
  });

  it('finds the definition when the row spells the predicate differently', () => {
    expect(renderFactValue({ datatype: 'num', num: 9900 }, 'Price Per Hour', lookups())).toBe(
      '9900 cents',
    );
  });

  it('renders an entity value as its name', () => {
    expect(
      renderFactValue(
        { datatype: 'entity', entityId: 'entity-jiffy' },
        'parent_company',
        lookups(),
      ),
    ).toBe('Jiffy');
  });

  it('marks an unresolved entity id rather than dressing it up as a name', () => {
    expect(
      renderFactValue(
        { datatype: 'entity', entityId: 'entity-ghost' },
        'parent_company',
        lookups(),
      ),
    ).toBe(`entity-ghost ${ENTITY_UNRESOLVED}`);
  });

  it('renders json with keys sorted, so key order cannot fake a world change', () => {
    const a = renderFactValue(
      { datatype: 'json', json: { b: 2, a: { d: 4, c: 3 } } },
      'hours',
      EMPTY,
    );
    const b = renderFactValue(
      { datatype: 'json', json: { a: { c: 3, d: 4 }, b: 2 } },
      'hours',
      EMPTY,
    );
    expect(a).toBe('{"a":{"c":3,"d":4},"b":2}');
    expect(b).toBe(a);
  });
});

/* ── 2. evidence: a sufficiency gap, not a conversion ───────────────────── */

describe('toEvidenceRef', () => {
  it('produces a ref that the contract itself accepts', () => {
    const ref = toEvidenceRef(row());
    expect(ref).not.toBeNull();
    expect(evidenceRefSchema.safeParse(ref).success).toBe(true);
    expect(ref).toMatchObject({
      signal_id: null,
      fact_id: FACT_UUID,
      source_url: 'https://jiffy.example/pricing',
      span: '$99 per hour',
    });
  });

  it('dates the ref from observedAt — when the page was fetched — not valid.from', () => {
    const ref = toEvidenceRef(row({ valid: { from: '2024-01-01T00:00:00.000Z', to: null } }));
    expect(ref?.observed_at).toBe('2026-07-04T00:00:00.000Z');
    expect(ref?.observed_at).not.toBe('2024-01-01T00:00:00.000Z');
  });

  it('re-spells an offset timestamp rather than losing the whole citation', () => {
    const ref = toEvidenceRef(row({ observedAt: '2026-07-04T00:00:00+00:00' }));
    expect(ref?.observed_at).toBe('2026-07-04T00:00:00.000Z');
  });

  it('returns null for evidence too sparse to make a ref', () => {
    expect(toEvidenceRef(row({ evidence: {} }))).toBeNull();
    expect(toEvidenceRef(row({ evidence: { url: 'https://jiffy.example/pricing' } }))).toBeNull();
    expect(toEvidenceRef(row({ evidence: { snippet: '$99 per hour' } }))).toBeNull();
    expect(
      toEvidenceRef(row({ evidence: { url: 'https://jiffy.example/pricing', snippet: '   ' } })),
    ).toBeNull();
  });

  it('keeps the hash and the extractor version out of it — they are not a span', () => {
    // A ref must point at something a reader can open. A content hash proves the
    // fetch happened; it does not let anyone check the claim.
    expect(
      toEvidenceRef(row({ evidence: { hash: 'sha256:abc', extractorVersion: 'v3' } })),
    ).toBeNull();
  });

  it('refuses a url nobody can open', () => {
    const bad = ['javascript:alert(1)', 'data:text/html,hi', 'not a url'];
    for (const url of bad) {
      expect(toEvidenceRef(row({ evidence: { url, snippet: '$99 per hour' } }))).toBeNull();
    }
  });

  it('nulls the back-pointer when the fact id is not a uuid, rather than forcing it', () => {
    const ref = toEvidenceRef(row({ factId: 'fact_1' }));
    expect(ref?.fact_id).toBeNull();
    expect(evidenceRefSchema.safeParse(ref).success).toBe(true);
  });
});

/* ── 3. method → basis, per row ─────────────────────────────────────────── */

describe('basis', () => {
  it('maps each method to what it earns', () => {
    const expected: Record<FactMethod, Basis> = {
      llm_extract: 'inferred_from_sources',
      scrape: 'governed_query',
      api: 'governed_query',
      human: 'governed_query',
    };
    for (const method of METHODS) expect(basisForMethod(method)).toBe(expected[method]);
  });

  it('never lets a fact about the outside world claim verified_metric', () => {
    for (const method of METHODS) {
      for (const evidence of [{}, { url: 'https://a.example/p', snippet: 'x' }]) {
        const record = toFactRecord(row({ method, evidence }), lookups());
        expect(record.basis).not.toBe('verified_metric');
      }
    }
  });

  it('caps a document-read fact that arrived with nothing citable', () => {
    const scraped = row({ method: 'scrape', evidence: {} });
    expect(basisForFact(scraped, null)).toBe('inferred_from_sources');
    expect(basisForFact(row({ method: 'llm_extract', evidence: {} }), null)).toBe(
      'inferred_from_sources',
    );
  });

  it('leaves api and human alone — their provenance is the source row, not a span', () => {
    for (const method of ['api', 'human'] as const) {
      expect(basisForFact(row({ method, evidence: {} }), null)).toBe('governed_query');
    }
  });

  it('is never stronger than the per-answer rule in world/query/tools.ts', () => {
    const sets: FactRow[][] = [
      [row({ method: 'api' }), row({ method: 'human' })],
      [row({ method: 'api' }), row({ method: 'llm_extract' })],
      [row({ method: 'scrape', evidence: {} }), row({ method: 'api' })],
      [row({ method: 'scrape' })],
    ];
    for (const rows of sets) {
      const perAnswer: Basis = rows.some((r) => r.method === 'llm_extract')
        ? 'inferred_from_sources'
        : 'governed_query';
      const perRow = weakestBasis(rows.map((r) => toFactRecord(r, lookups()).basis));
      expect(basisDisplay(perRow).rank).toBeLessThanOrEqual(basisDisplay(perAnswer).rank);
    }
  });

  it('ignores confidence entirely', () => {
    const low = toFactRecord(row({ confidence: 0.01 }), lookups());
    const high = toFactRecord(row({ confidence: 0.99 }), lookups());
    expect(low.basis).toBe(high.basis);
  });
});

/* ── 4. the record itself ───────────────────────────────────────────────── */

describe('toFactRecord', () => {
  it('drops confidence and carries the rest across', () => {
    const record = toFactRecord(row(), lookups());
    expect(record).not.toHaveProperty('confidence');
    expect(record).toMatchObject({
      factId: FACT_UUID,
      predicate: 'price_per_hour',
      value: '9900 cents',
      sourceId: 'source-1',
      sourceName: 'Jiffy pricing page',
      observedAt: '2026-07-04T00:00:00.000Z',
      status: 'active',
      supersedes: null,
    });
  });

  it('leaves sourceName null when the caller did not look it up', () => {
    expect(toFactRecord(row(), EMPTY).sourceName).toBeNull();
  });

  it('rebuilds the ranges instead of sharing the row objects', () => {
    const source = row();
    const record = toFactRecord(source, lookups());
    expect(record.valid).toEqual(source.valid);
    expect(record.valid).not.toBe(source.valid);
    expect(record.asserted).not.toBe(source.asserted);
  });

  it('maps every status', () => {
    for (const status of ['active', 'retracted', 'disputed'] as const) {
      expect(toFactRecord(row({ status }), lookups()).status).toBe(status);
    }
  });

  it('feeds buildEntityPage — the two shapes really do meet', () => {
    const facts = toFactRecords(
      [
        // The old value's `valid` is closed at the change instant — that is what
        // makes this a world change rather than two sources disagreeing.
        row({
          factId: FACT_UUID,
          value: { datatype: 'num', num: 9900 },
          valid: { from: '2026-07-01T00:00:00.000Z', to: '2026-08-01T00:00:00.000Z' },
        }),
        row({
          factId: '22222222-2222-4222-8222-222222222222',
          value: { datatype: 'num', num: 10900 },
          valid: { from: '2026-08-01T00:00:00.000Z', to: null },
          asserted: { from: '2026-08-02T00:00:00.000Z', to: null },
          observedAt: '2026-08-02T00:00:00.000Z',
        }),
      ],
      lookups(),
    );
    const page = buildEntityPage({
      entity: { ref: 'company:jiffy', name: 'Jiffy', region: 'ca' },
      facts,
      conflicts: [],
      findings: [],
      peers: [],
      asOf: '2026-08-10T00:00:00.000Z',
    });
    expect(page.currentFacts[0]?.value).toBe('10900 cents');
    expect(page.currentFacts[0]?.sourceName).toBe('Jiffy pricing page');
    expect(page.timeline[0]?.kind).toBe('world_change');
  });
});

/* ── batching + the other doubly-declared shape ─────────────────────────── */

describe('factViewKeys', () => {
  it('collects one deduplicated, sorted set per lookup so the caller queries thrice', () => {
    const keys = factViewKeys([
      row({ predicate: 'price_per_hour', sourceId: 'source-1' }),
      row({ predicate: 'price_per_hour', sourceId: 'source-2' }),
      row({
        predicate: 'parent_company',
        sourceId: 'source-1',
        value: { datatype: 'entity', entityId: 'entity-parent' },
      }),
      row({ predicate: 'about', value: { datatype: 'text', text: 'x' } }),
    ]);
    expect(keys.predicates).toEqual(['about', 'parent_company', 'price_per_hour']);
    expect(keys.sourceIds).toEqual(['source-1', 'source-2']);
    expect(keys.entityIds).toEqual(['entity-parent']);
  });
});

describe('toConflictRecord', () => {
  it('drops entityId and copies the fact ids', () => {
    const factIds = ['a', 'b'];
    const view = toConflictRecord({
      id: 'conflict-1',
      entityId: 'entity-jiffy',
      predicate: 'price_per_hour',
      validInstant: '2026-08-01T00:00:00.000Z',
      factIds,
      kind: 'factual',
      status: 'open',
    });
    expect(view).not.toHaveProperty('entityId');
    expect(view.factIds).toEqual(factIds);
    expect(view.factIds).not.toBe(factIds);
  });
});
