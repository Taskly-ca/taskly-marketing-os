import { describe, it, expect } from 'vitest';
import {
  assertL0,
  extractNumbers,
  extractDates,
  normalizeNumeric,
  dateParts,
  BARE_INTEGER_FLOOR,
} from './l0.js';
import type { EvidenceRef } from '@tmos/contracts';

const URL = 'https://jiffyondemand.com/pricing';

const ev = (span: string, url = URL): EvidenceRef => ({
  signal_id: null,
  fact_id: null,
  source_url: url,
  span,
  observed_at: '2026-08-04T00:00:00.000Z',
});

const check = (claim: string, spans: string[], urls: string[] = [URL]) =>
  assertL0({ claim, evidence: spans.map((s) => ev(s)), retrievedUrls: urls });

describe('the fabrication L0 exists to catch', () => {
  it('blocks a moved decimal — the characteristic failure', () => {
    // Not an invented sentence: a real sentence with a changed number. A judge
    // model reads this as fluent and plausible; a string comparison does not.
    const r = check('Jiffy raised prices 23% in July.', ['Jiffy raised prices 12% in July.']);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatchObject({ code: 'number_not_in_span', token: '23%' });
  });

  it('passes the same claim when the number is right', () => {
    expect(check('Jiffy raised prices 12% in July.', ['Jiffy raised prices 12% in July.']).ok).toBe(
      true,
    );
  });

  it('blocks a citation to a URL we never retrieved', () => {
    const r = assertL0({
      claim: 'Prices rose.',
      evidence: [ev('Prices rose.', 'https://invented-source.example/report')],
      retrievedUrls: [URL],
    });
    expect(r.violations[0]!.code).toBe('url_not_retrieved');
  });

  it('blocks a claim with no evidence at all, and stops there', () => {
    const r = assertL0({ claim: 'Everyone is raising prices.', evidence: [], retrievedUrls: [] });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0]!.code).toBe('no_evidence');
  });

  it('blocks an empty span — a citation that points at nothing', () => {
    const r = assertL0({ claim: 'x', evidence: [ev('   ')], retrievedUrls: [URL] });
    expect(r.violations.some((v) => v.code === 'empty_span')).toBe(true);
  });
});

describe('formatting must not cause false failures', () => {
  it('treats $1,200 · 1200 · 1,200.00 as the same number', () => {
    expect(normalizeNumeric('$1,200')).toBe(normalizeNumeric('1200'));
    expect(normalizeNumeric('1,200.00')).toBe(normalizeNumeric('1200'));
    expect(check('They charge $1,200 per job.', ['the rate is 1200 dollars']).ok).toBe(true);
  });

  it('ignores small bare integers as prose', () => {
    // "three of the five listings" is prose. Demanding it appear verbatim is
    // the fastest way to get a gate switched off.
    expect(extractNumbers('in 2 weeks they added 3 categories')).toEqual([]);
    expect(check('They added 3 new categories.', ['a handful of new categories appeared']).ok).toBe(
      true,
    );
  });

  it('still demands support for a small number carrying $ or %', () => {
    expect(extractNumbers('a 5% cut and a $9 fee')).toEqual(['5%', '$9']);
    expect(check('They take a 5% cut.', ['they take a 9% cut']).ok).toBe(false);
  });

  it(`treats ${BARE_INTEGER_FLOOR}+ as material`, () => {
    expect(extractNumbers('42 listings')).toEqual(['42']);
    expect(check('42 listings appeared.', ['we counted 42 listings']).ok).toBe(true);
  });

  it('tolerates a tracking parameter added after retrieval', () => {
    const r = assertL0({
      claim: 'Prices rose 12%.',
      evidence: [ev('prices rose 12%', `${URL}?utm_source=digest`)],
      retrievedUrls: [URL],
    });
    expect(r.ok).toBe(true);
  });
});

describe('dates', () => {
  it('matches the same date written three ways', () => {
    expect(dateParts('2026-08-01')).toEqual(dateParts('August 1, 2026'));
    expect(dateParts('2026-08-01')).toEqual(dateParts('1 August 2026'));
    expect(check('Effective 2026-08-01.', ['effective August 1, 2026']).ok).toBe(true);
  });

  it('lets a claim be LESS precise than its source', () => {
    expect(check('The change landed in August 2026.', ['effective August 1, 2026']).ok).toBe(true);
  });

  it('does NOT let a claim be MORE precise than its source', () => {
    // A claim may lose precision, never invent it. "August 3" from a source
    // that only says "August 2026" is a fabricated day.
    const r = check('The change landed on August 3, 2026.', ['sometime in August 2026']);
    expect(r.ok).toBe(false);
    expect(r.violations[0]!.code).toBe('date_not_in_span');
  });

  it('blocks a wrong month outright', () => {
    expect(check('Announced in July 2026.', ['announced in August 2026']).ok).toBe(false);
  });

  it('extracts the common written forms', () => {
    expect(extractDates('on 2026-08-01 and Aug… no, August 1, 2026 and 08/01/2026')).toEqual(
      expect.arrayContaining(['2026-08-01', 'August 1, 2026', '08/01/2026']),
    );
  });
});

describe('what L0 deliberately does NOT do', () => {
  it('passes a claim that is grounded but does not follow from the span', () => {
    // L0 is a floor. "12% therefore they are losing money" quotes the number
    // correctly and reasons badly — that is L1's job, and pretending L0 covers
    // it would be a false sense of safety.
    const r = check('Jiffy raised prices 12%, so they are losing customers.', [
      'Jiffy raised prices 12% in July.',
    ]);
    expect(r.ok).toBe(true);
  });

  it('does not require the so_what to be sourced', () => {
    // Demanding the consequence be quoted pushes authors to strip it — the one
    // part that makes a finding intelligence rather than a fact.
    const r = check('Jiffy raised prices 12%.', ['Jiffy raised prices 12% in July.']);
    expect(r.ok).toBe(true);
  });

  it('reports every violation, not just the first', () => {
    const r = check('Prices rose 23% on August 3, 2026.', ['prices rose 12% in July 2026']);
    expect(r.violations.map((v) => v.code).sort()).toEqual([
      'date_not_in_span',
      'number_not_in_span',
    ]);
  });
});
