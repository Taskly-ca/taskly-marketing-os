/**
 * The gate between "the model said something" and "you can act on it".
 *
 * Every case here is a way a research answer goes wrong that reads as
 * completely fine. That is the point: none of these look like errors in the
 * output, which is why they have to be caught mechanically rather than by the
 * reader noticing.
 */
import { describe, expect, it } from 'vitest';

import { claimNumbers, normalise, verifyPoints } from './verify.js';
import type { Point, ReadDoc } from './types.js';

const URL_A = 'https://example.com/a';
const docs: ReadDoc[] = [
  {
    url: URL_A,
    title: 'A',
    text: 'Jiffy operates in Toronto and Ottawa. Their standard rate is $89 per visit for 2 hours.',
  },
];

const point = (claim: string, span: string, url = URL_A): Point => ({
  claim,
  citations: [{ url, span }],
});

describe('verifyPoints', () => {
  it('keeps a point whose span really is on the page it cites', () => {
    const r = verifyPoints([point('Jiffy operates in Ottawa.', 'Jiffy operates in Toronto and Ottawa')], docs);
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toEqual([]);
  });

  it('drops a citation to a page this run never retrieved', () => {
    // The signature of an answer assembled from memory rather than reading.
    const r = verifyPoints([point('Jiffy is in Calgary.', 'Jiffy operates in Calgary', 'https://elsewhere.com/x')], docs);
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/never retrieved/);
  });

  it('drops a paraphrase presented as a quote', () => {
    // The page says "operates in Toronto and Ottawa"; this is close, true, and
    // not a quotation — which makes the citation unverifiable by a reader.
    const r = verifyPoints([point('Jiffy serves two cities.', 'Jiffy serves Toronto and Ottawa')], docs);
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/does not appear/);
  });

  it('drops an invented number even when the rest of the point is sourced', () => {
    // The most dangerous shape: an actionable figure attached to a real quote.
    const r = verifyPoints(
      [point('Jiffy charges $129 per visit.', 'Their standard rate is $89 per visit')],
      docs,
    );
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/129/);
  });

  it('keeps a number that IS in the span', () => {
    const r = verifyPoints(
      [point('Jiffy charges $89 per visit.', 'Their standard rate is $89 per visit')],
      docs,
    );
    expect(r.kept).toHaveLength(1);
  });

  it('drops a point with no citation at all', () => {
    const r = verifyPoints([{ claim: 'The market is growing.', citations: [] }], docs);
    expect(r.dropped[0]?.why).toBe('no source cited');
  });

  it('matches across a line wrap, because a real page is wrapped', () => {
    const wrapped: ReadDoc[] = [{ url: URL_A, title: 'A', text: 'Jiffy operates\n   in Toronto\nand Ottawa.' }];
    const r = verifyPoints([point('Jiffy is in Toronto.', 'Jiffy operates in Toronto and Ottawa')], wrapped);
    expect(r.kept).toHaveLength(1);
  });

  it('enforces the honesty boundary on generated text', () => {
    // A banned phrase in an internal memo is where it enters a campaign later,
    // so the gate is not relaxed just because nobody outside will read this.
    const d: ReadDoc[] = [{ url: URL_A, title: 'A', text: 'All our taskers are background-checked and insured.' }];
    const r = verifyPoints([point('Taskly taskers are background-checked.', 'All our taskers are background-checked and insured')], d);
    expect(r.kept).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/honesty gate/);
  });

  it('reports what it dropped rather than quietly shortening the answer', () => {
    const r = verifyPoints(
      [
        point('Jiffy operates in Ottawa.', 'Jiffy operates in Toronto and Ottawa'),
        { claim: 'The GTA market is worth $2.1B.', citations: [] },
      ],
      docs,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.dropped).toHaveLength(1);
  });
});

describe('claimNumbers', () => {
  it('ignores small bare integers the way L0 does', () => {
    // "the top 3 reasons" must not require a span containing "3".
    expect(claimNumbers('the top 3 reasons')).toEqual([]);
  });

  it('catches money, percentages and thousands', () => {
    expect(claimNumbers('$89 per visit')).toContain('89');
    expect(claimNumbers('grew 12%')).toContain('12');
    expect(claimNumbers('1,200 taskers')).toContain('1200');
  });

  it('catches a large bare integer', () => {
    expect(claimNumbers('listed 52 services')).toContain('52');
  });
});

describe('normalise', () => {
  it('collapses whitespace and nothing else', () => {
    expect(normalise('  a \n\t b  ')).toBe('a b');
    // Case is preserved: a headline is not body text.
    expect(normalise('Jiffy')).toBe('Jiffy');
  });
});
