/**
 * The pipeline, driven entirely through fakes — no key, no network.
 *
 * The behaviour worth pinning is what happens when a stage returns nothing.
 * Every one of these is a real outcome (robots refuses everything; the
 * providers have no results; the budget ceiling blocks the call), and in every
 * one the honest output is a short answer that says so — never a confident
 * essay assembled from the model's own memory, which is exactly what a
 * pipeline that "degrades gracefully" into a plain LLM call would produce.
 */
import { describe, expect, it } from 'vitest';

import { bindCitations, dedupeHits, research } from './pipeline.js';
import type { AskPort, ReadDoc, ReadPort, SearchHit, SearchPort } from './types.js';

const hit = (url: string): SearchHit => ({ title: url, url, snippet: '', provider: 'fake' });

const askWith = (replies: string[]): AskPort => {
  let i = 0;
  return { ask: async () => ({ text: replies[i++] ?? '{}', costCents: 0.01 }) };
};
const searchWith = (hits: SearchHit[]): SearchPort => ({ name: 'fake', search: async () => hits });
const readWith = (docs: Record<string, ReadDoc>): ReadPort => ({
  read: async (url) => docs[url] ?? null,
});

const PAGE = 'https://example.com/p';
const doc: ReadDoc = {
  url: PAGE,
  title: 'P',
  text: 'Jiffy operates in Toronto and Ottawa. '.repeat(10),
};

describe('research', () => {
  it('returns cited points when the documents support them', async () => {
    const r = await research('where does Jiffy operate?', {
      ask: askWith([
        JSON.stringify({ queries: ['jiffy cities'] }),
        JSON.stringify({
          summary: 'Two cities.',
          points: [{ claim: 'Jiffy operates in Ottawa.', citations: [{ doc: 1, span: 'Jiffy operates in Toronto and Ottawa' }] }],
        }),
      ]),
      search: [searchWith([hit(PAGE)])],
      read: readWith({ [PAGE]: doc }),
    });
    expect(r.points).toHaveLength(1);
    expect(r.points[0]?.citations[0]?.url).toBe(PAGE);
    expect(r.costCents).toBeGreaterThan(0);
  });

  it('says so when nothing could be read, rather than answering anyway', async () => {
    const r = await research('q', {
      ask: askWith([JSON.stringify({ queries: ['x'] })]),
      search: [searchWith([hit(PAGE)])],
      read: readWith({}),
    });
    expect(r.points).toEqual([]);
    expect(r.summary).toMatch(/could not read/i);
  });

  it('says so when the search found nothing', async () => {
    const r = await research('q', {
      ask: askWith([JSON.stringify({ queries: ['x'] })]),
      search: [searchWith([])],
      read: readWith({}),
    });
    expect(r.summary).toMatch(/No search results/i);
  });

  it('reports a blocked model call instead of falling back to memory', async () => {
    const r = await research('q', {
      ask: { ask: async () => null },
      search: [searchWith([hit(PAGE)])],
      read: readWith({ [PAGE]: doc }),
    });
    expect(r.points).toEqual([]);
    expect(r.summary).toMatch(/unavailable|ceiling/i);
  });

  it('carries the unanswerable parts through from the plan', async () => {
    const r = await research('what are Jiffy margins?', {
      ask: askWith([JSON.stringify({ queries: [], unanswerable: ['a private company\'s margins'] })]),
      search: [searchWith([])],
      read: readWith({}),
    });
    expect(r.unanswered).toContain("a private company's margins");
  });

  it('never reads more pages than the limit allows', async () => {
    const urls = Array.from({ length: 20 }, (_, i) => `https://example.com/${i}`);
    const docs = Object.fromEntries(urls.map((u) => [u, { ...doc, url: u }]));
    const r = await research('q', {
      ask: askWith([JSON.stringify({ queries: ['x'] }), JSON.stringify({ summary: '', points: [] })]),
      search: [searchWith(urls.map(hit))],
      read: readWith(docs),
      limits: { maxQueries: 1, maxPages: 3, maxCharsPerPage: 100 },
    });
    expect(r.sources).toHaveLength(3);
    // The per-page cap is what keeps a long page from dominating the prompt.
    expect(r.sources[0]?.text.length).toBeLessThanOrEqual(100);
  });
});

describe('dedupeHits', () => {
  it('treats tracking params and a trailing slash as the same page', () => {
    const r = dedupeHits([
      hit('https://www.example.com/a/'),
      hit('https://example.com/a?utm_source=x'),
      hit('https://example.com/b'),
    ]);
    expect(r).toHaveLength(2);
  });
});

describe('bindCitations', () => {
  const docs: ReadDoc[] = [{ url: PAGE, title: 'P', text: 'x' }];

  it('maps a 1-based doc index onto the URL we retrieved', () => {
    const p = bindCitations([{ claim: 'c', citations: [{ doc: 1, span: 's' }] }], docs);
    expect(p[0]?.citations[0]?.url).toBe(PAGE);
  });

  it('drops an index we never handed it, leaving the point uncited', () => {
    // An out-of-range index means the model cited something it invented. The
    // point survives to be REPORTED as dropped, rather than repaired.
    const p = bindCitations([{ claim: 'c', citations: [{ doc: 9, span: 's' }] }], docs);
    expect(p[0]?.citations).toEqual([]);
  });
});

describe('bindCitations — the flat quote-first shape', () => {
  const docs: ReadDoc[] = [{ url: PAGE, title: 'P', text: 'x' }];

  it('accepts {span, doc, claim}, which is what the prompt asks for', () => {
    const p = bindCitations([{ span: 'a quote', doc: 1, claim: 'c' }], docs);
    expect(p[0]?.citations).toEqual([{ url: PAGE, span: 'a quote' }]);
  });

  it('still accepts the nested shape rather than discarding the answer', () => {
    const p = bindCitations([{ claim: 'c', citations: [{ doc: 1, span: 's' }] }], docs);
    expect(p[0]?.citations).toHaveLength(1);
  });
});
