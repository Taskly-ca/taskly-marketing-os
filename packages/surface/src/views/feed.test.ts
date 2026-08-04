import { describe, it, expect } from 'vitest';
import type { EvidenceRef, Finding } from '@tmos/contracts';
import { findConfidenceNumbers } from '../basis.js';
import { buildFeed } from './feed.js';

const ev = (url: string, span = 'listed snow removal in the GTA'): EvidenceRef => ({
  signal_id: null,
  fact_id: null,
  source_url: url,
  span,
  observed_at: '2026-07-01T00:00:00.000Z',
});

const finding = (over: Partial<Finding> & { id: string }): Finding => ({
  claim: 'Jiffy listed snow removal in the GTA.',
  so_what: 'It overlaps a category we planned to own this winter.',
  subject_refs: ['company:jiffy'],
  evidence: [ev('https://jiffy.example/pricing')],
  basis: 'inferred_from_sources',
  causal_rung: 0,
  stakes: 'medium',
  region: 'ca',
  domain_score: 0.71,
  generated_by: 'agent:test@1',
  reviewed_by: null,
  superseded_by: null,
  supersede_reason: null,
  created_at: '2026-07-01T00:00:00.000Z',
  ...over,
});

describe('a corrected claim does not silently come back', () => {
  const live = finding({ id: 'a', created_at: '2026-07-03T00:00:00.000Z' });
  const corrected = finding({
    id: 'b',
    created_at: '2026-07-02T00:00:00.000Z',
    superseded_by: 'a',
    supersede_reason: 'The price we read was a promotional banner, not the list price.',
  });

  it('excludes superseded findings by default, and says how many it hid', () => {
    const page = buildFeed([live, corrected]);
    expect(page.rows.map((r) => r.id)).toEqual(['a']);
    expect(page.supersededHidden).toBe(1);
  });

  it('reaches them under an explicit filter, carrying the reason', () => {
    const all = buildFeed([live, corrected], { filter: { superseded: 'include' } });
    expect(all.rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(all.supersededHidden).toBe(0);

    const only = buildFeed([live, corrected], { filter: { superseded: 'only' } });
    expect(only.rows.map((r) => r.id)).toEqual(['b']);
    expect(only.rows[0]?.superseded?.reason).toMatch(/promotional banner/);
  });
});

describe('what a row may and may not carry', () => {
  it('never exposes domain_score or a confidence number in the serialized shape', () => {
    const page = buildFeed([finding({ id: 'a', domain_score: 0.93 })], {
      order: 'ranked',
    });
    const json = JSON.stringify(page);
    expect(json).not.toMatch(/domain_?score/i);
    expect(json).not.toMatch(/confiden/i);
    expect(json).not.toMatch(/"[a-z_]*score"/i);
    expect(findConfidenceNumbers(json)).toEqual([]);
    // ranking still worked — it just never reached the reader
    expect(page.rows).toHaveLength(1);
  });

  it('refuses to render a claim that states confidence as a number', () => {
    expect(() =>
      buildFeed([finding({ id: 'a', claim: 'Jiffy is exiting the GTA — 92% confident.' })]),
    ).toThrow(/confidence rendered as a number/);
  });

  it('counts INDEPENDENT sources, not evidence rows, and renders that as the basis', () => {
    const page = buildFeed([
      finding({
        id: 'a',
        evidence: [
          ev('https://jiffy.example/pricing'),
          ev('https://www.jiffy.example/blog/snow'),
          ev('https://thestar.example/story'),
        ],
      }),
    ]);
    expect(page.rows[0]?.sourceCount).toBe(2);
    expect(page.rows[0]?.basis.label).toBe('Inferred from 2 independent sources');
    expect(page.rows[0]?.basis.quotableAsFact).toBe(false);
  });

  it('offers the dismissal taxonomy, never a bare dismiss', () => {
    const row = buildFeed([finding({ id: 'a' })]).rows[0];
    expect(row?.feedback.dismissRequiresReason).toBe(true);
    expect(row?.feedback.dismissOptions.map((o) => o.reason)).toEqual([
      'wrong',
      'obvious',
      'not_actionable',
      'stale',
      'bad_source',
    ]);
    expect(row?.feedback.dismissOptions[0]?.blames).toBe('verification');
  });
});

describe('ordering is total, so the feed cannot shuffle between requests', () => {
  const tie = ['c', 'a', 'b'].map((id) => finding({ id, created_at: '2026-07-01T00:00:00.000Z' }));

  it('breaks equal timestamps by id, independent of input order', () => {
    const forward = buildFeed(tie).rows.map((r) => r.id);
    const reversed = buildFeed([...tie].reverse()).rows.map((r) => r.id);
    expect(forward).toEqual(['a', 'b', 'c']);
    expect(reversed).toEqual(forward);
  });

  it('is reverse-chronological by default', () => {
    const page = buildFeed([
      finding({ id: 'old', created_at: '2026-06-01T00:00:00.000Z' }),
      finding({ id: 'new', created_at: '2026-08-01T00:00:00.000Z' }),
    ]);
    expect(page.rows.map((r) => r.id)).toEqual(['new', 'old']);
  });

  it('ranks by domain_score only when asked, still deterministically', () => {
    const page = buildFeed(
      [
        finding({ id: 'low', domain_score: 0.1 }),
        finding({ id: 'high', domain_score: 0.9 }),
        finding({ id: 'also-high', domain_score: 0.9 }),
      ],
      { order: 'ranked' },
    );
    expect(page.rows.map((r) => r.id)).toEqual(['also-high', 'high', 'low']);
  });
});

describe('pagination states what it is hiding', () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
    finding({ id, created_at: `2026-07-0${i + 1}T00:00:00.000Z` }),
  );

  it('reports that more exist rather than truncating in silence', () => {
    const page = buildFeed(many, { limit: 2 });
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);
    expect(page.nextOffset).toBe(2);
  });

  it('closes the page honestly at the end', () => {
    const page = buildFeed(many, { limit: 2, offset: 4 });
    expect(page.rows).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(page.nextOffset).toBeNull();
  });
});

describe('filters', () => {
  const rows = [
    finding({ id: 'a', subject_refs: ['company:jiffy'], stakes: 'high' }),
    finding({
      id: 'b',
      subject_refs: ['company:taskrabbit'],
      stakes: 'low',
      basis: 'governed_query',
      created_at: '2026-05-01T00:00:00.000Z',
    }),
  ];

  it('filters by subject, stakes, basis and date window', () => {
    expect(
      buildFeed(rows, { filter: { subjects: ['company:jiffy'] } }).rows.map((r) => r.id),
    ).toEqual(['a']);
    expect(buildFeed(rows, { filter: { stakes: ['low'] } }).rows.map((r) => r.id)).toEqual(['b']);
    expect(
      buildFeed(rows, { filter: { basis: ['governed_query'] } }).rows.map((r) => r.id),
    ).toEqual(['b']);
    expect(
      buildFeed(rows, { filter: { since: '2026-06-01T00:00:00.000Z' } }).rows.map((r) => r.id),
    ).toEqual(['a']);
    expect(
      buildFeed(rows, { filter: { until: '2026-06-01T00:00:00.000Z' } }).rows.map((r) => r.id),
    ).toEqual(['b']);
  });
});
