import { describe, it, expect } from 'vitest';
import {
  basisDisplay,
  renderBasis,
  weakestBasis,
  mayQuoteAsFact,
  findConfidenceNumbers,
  assertNoConfidenceNumber,
} from './basis.js';

describe('no surface may render confidence as a number', () => {
  it.each([
    '87% confident this is a real shift',
    'Confidence: 92%',
    'confidence = 0.87',
    'confidence score of high',
    '4/5 stars',
    '★★★★',
  ])('blocks %j', (text) => {
    expect(() => assertNoConfidenceNumber(text)).toThrow(/confidence rendered as a number/);
  });

  it('does NOT block a real number about the world', () => {
    // "prices rose 12%" is a fact and must survive. The difference between
    // reporting a number and claiming one is the whole distinction.
    for (const ok of [
      'Jiffy raised prices 12% in July.',
      'Their fee is 4.9% with a $2.99 floor.',
      '3 of 5 competitors now list snow removal.',
      'We hold 20% — it keeps Taskly running.',
    ]) {
      expect(() => assertNoConfidenceNumber(ok), ok).not.toThrow();
    }
  });

  it('reports every leak with an offset', () => {
    const leaks = findConfidenceNumbers('75% certain now, confidence: 80% later');
    expect(leaks.length).toBeGreaterThanOrEqual(2);
    expect(leaks.map((l) => l.index)).toEqual([...leaks.map((l) => l.index)].sort((a, b) => a - b));
  });
});

describe('what the reader is told instead', () => {
  it('gives a label, a meaning and an action for every basis', () => {
    for (const b of [
      'verified_metric',
      'governed_query',
      'inferred_from_sources',
      'exploratory_unverified',
    ] as const) {
      const d = basisDisplay(b);
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.meaning.length).toBeGreaterThan(0);
      // The action is the part that changes behaviour, and the reason a
      // category beats a number.
      expect(d.action.length).toBeGreaterThan(0);
    }
  });

  it('orders strength without exposing the rank', () => {
    expect(basisDisplay('verified_metric').rank).toBeGreaterThan(
      basisDisplay('governed_query').rank,
    );
    expect(basisDisplay('governed_query').rank).toBeGreaterThan(
      basisDisplay('inferred_from_sources').rank,
    );
    expect(basisDisplay('inferred_from_sources').rank).toBeGreaterThan(
      basisDisplay('exploratory_unverified').rank,
    );
  });

  it('names the INDEPENDENT source count, and never the raw one', () => {
    // Ten outlets republishing one press release is "1 source". Rendering 10 is
    // how a single fabricated claim becomes "widely reported".
    expect(renderBasis('inferred_from_sources', 1)).toBe('Inferred from 1 independent source');
    expect(renderBasis('inferred_from_sources', 3)).toBe('Inferred from 3 independent sources');
    expect(renderBasis('inferred_from_sources', 0)).toBe('Inferred — no independent source');
  });

  it('omits the count for bases where it is meaningless', () => {
    expect(renderBasis('verified_metric', 5)).toBe('Verified metric');
    expect(renderBasis('governed_query')).toBe('Governed query');
  });
});

describe('combining bases takes the weakest', () => {
  it('does not let a strong leg carry a weak one', () => {
    // A conclusion resting on a verified metric AND a guess is a guess.
    expect(weakestBasis(['verified_metric', 'exploratory_unverified'])).toBe(
      'exploratory_unverified',
    );
    expect(weakestBasis(['governed_query', 'inferred_from_sources'])).toBe('inferred_from_sources');
  });

  it('defaults to the weakest when there is nothing to go on', () => {
    expect(weakestBasis([])).toBe('exploratory_unverified');
  });

  it('gates quoting on basis, not on a score', () => {
    expect(mayQuoteAsFact('verified_metric')).toBe(true);
    expect(mayQuoteAsFact('governed_query')).toBe(true);
    expect(mayQuoteAsFact('inferred_from_sources')).toBe(false);
    expect(mayQuoteAsFact('exploratory_unverified')).toBe(false);
  });
});
