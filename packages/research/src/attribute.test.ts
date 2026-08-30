/**
 * The citable universe, driven entirely through a fake `AskPort` — no key, no
 * network, no clock.
 *
 * Almost every case here is a span that LOOKS like a citation. That is the
 * whole reason phase A exists: by the time prose is streaming with a `[3]`
 * hanging off it, nobody re-reads document 3. The refusal has to happen while
 * the quote is still a string in a JSON array, and it has to be mechanical,
 * because each of these reads as completely fine to a human skimming the
 * output — a paraphrase, a real quote pinned to the wrong page, a citation to a
 * document number we never handed the model.
 */
import { describe, expect, it, vi } from 'vitest';

import { attribute, bindSpans, DEFAULT_ATTRIBUTE_LIMITS } from './attribute.js';
import type { AskPort, ReadDoc } from './types.js';

const URL_A = 'https://example.com/a';
const URL_B = 'https://example.com/b';

const docs: ReadDoc[] = [
  {
    url: URL_A,
    title: 'A',
    text: 'Jiffy operates in Toronto and Ottawa. Their standard rate is $89 per visit for 2 hours.',
  },
  {
    url: URL_B,
    title: 'B',
    text: 'TaskRabbit charges a 15% service fee on every booking in Canada.',
  },
];

/** An `AskPort` that replies with exactly this text, and counts its calls. */
const askWith = (text: string): AskPort & { calls: () => number } => {
  let n = 0;
  return {
    ask: async () => {
      n += 1;
      return { text, costCents: 0.02 };
    },
    calls: () => n,
  };
};

const spansJson = (spans: unknown[]): string => JSON.stringify({ spans });

describe('bindSpans — the mechanical check, no model involved', () => {
  it('numbers the spans that really are on the page they cite', () => {
    const r = bindSpans(
      [
        { span: 'Jiffy operates in Toronto and Ottawa', doc: 1 },
        { span: 'TaskRabbit charges a 15% service fee', doc: 2 },
      ],
      docs,
    );
    expect(r.dropped).toEqual([]);
    expect(r.spans).toHaveLength(2);
    expect(r.spans[0]).toMatchObject({ id: 1, docIndex: 1, url: URL_A });
    expect(r.spans[1]).toMatchObject({ id: 2, docIndex: 2, url: URL_B });
  });

  it('refuses a span that appears in no document at all', () => {
    // The fabrication case: fluent, plausible, and simply not on the page.
    const r = bindSpans([{ span: 'Jiffy operates in Calgary and Edmonton', doc: 1 }], docs);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/does not appear/i);
  });

  it('refuses a paraphrase of a real sentence', () => {
    // Every fact in this is true and sourced. It is still not a quote, and a
    // quote is the only thing phase B is allowed to build prose on.
    const r = bindSpans([{ span: 'Jiffy works in both Toronto and Ottawa', doc: 1 }], docs);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/does not appear/i);
  });

  it('refuses a document index it was never handed, and says how many there were', () => {
    // An out-of-range index cannot be a transcription slip — we handed the
    // model the numbers. It is the unambiguous signal that the citation was
    // generated rather than located.
    const r = bindSpans([{ span: 'Jiffy operates in Toronto and Ottawa', doc: 9 }], docs);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/document 9.*2 document/i);
  });

  it('refuses a real quote pinned to the wrong document, and names the right one', () => {
    // Different bug from a paraphrase: the generation is fine, the bookkeeping
    // is wrong. Reporting which document it IS on is diagnosis, not repair —
    // the span is still dropped, because re-homing it would be the system
    // quietly fixing the model's citation and then vouching for it.
    const r = bindSpans([{ span: 'TaskRabbit charges a 15% service fee', doc: 1 }], docs);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/document 1/);
    expect(r.dropped[0]?.why).toMatch(/document 2/);
  });

  it('refuses a span too short to be evidence', () => {
    // "in Toronto" is on the page and proves nothing. Same 12-char floor the
    // whole-answer gate uses.
    const r = bindSpans([{ span: 'in Toronto', doc: 1 }], docs);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/too short/i);
  });

  it('refuses a span longer than the cap even though it is verbatim', () => {
    const long = 'The market moved again. '.repeat(40).trim();
    const wide: ReadDoc[] = [{ url: URL_A, title: 'A', text: long }];
    const r = bindSpans([{ span: long, doc: 1 }], wide);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/longer than/i);
  });

  it('matches a quote the page had wrapped across lines', () => {
    // The only reason substring matching works on HTML text at all: `normalise`
    // collapses whitespace and nothing else. Case is deliberately preserved.
    const wrapped: ReadDoc[] = [
      { url: URL_A, title: 'A', text: 'Jiffy operates\n   in Toronto\nand Ottawa.' },
    ];
    const r = bindSpans([{ span: 'Jiffy operates in Toronto and Ottawa', doc: 1 }], wrapped);
    expect(r.spans).toHaveLength(1);
    expect(r.spans[0]?.span).toBe('Jiffy operates in Toronto and Ottawa');
  });

  it('keeps ids contiguous when entries between them were dropped', () => {
    // Phase B emits `[N]`. If ids skipped the dropped entries, every marker
    // after the first refusal would resolve to the wrong quote — a citation
    // that is real, verified, and attached to the wrong sentence.
    const r = bindSpans(
      [
        { span: 'Jiffy operates in Toronto and Ottawa', doc: 1 },
        { span: 'invented text that is nowhere on the page', doc: 1 },
        { span: 'TaskRabbit charges a 15% service fee', doc: 2 },
      ],
      docs,
    );
    expect(r.spans.map((s) => s.id)).toEqual([1, 2]);
    expect(r.dropped).toHaveLength(1);
  });

  it('collapses a repeated span and reports the collapse', () => {
    const r = bindSpans(
      [
        { span: 'Jiffy operates in Toronto and Ottawa', doc: 1 },
        { span: 'Jiffy operates in Toronto  and Ottawa', doc: 1 },
      ],
      docs,
    );
    expect(r.spans).toHaveLength(1);
    expect(r.dropped[0]?.why).toMatch(/already/i);
  });

  it('keeps the same sentence twice when two documents both carry it', () => {
    // Two sources for one fact is corroboration, not duplication.
    const both: ReadDoc[] = [
      { url: URL_A, title: 'A', text: 'The GTA market grew 12% last year.' },
      { url: URL_B, title: 'B', text: 'The GTA market grew 12% last year.' },
    ];
    const r = bindSpans(
      [
        { span: 'The GTA market grew 12% last year', doc: 1 },
        { span: 'The GTA market grew 12% last year', doc: 2 },
      ],
      both,
    );
    expect(r.spans).toHaveLength(2);
  });

  it('caps the size of the universe and reports what overflowed', () => {
    const sentences = Array.from({ length: 6 }, (_, i) => `Sentence number ${i} about the market.`);
    const wide: ReadDoc[] = [{ url: URL_A, title: 'A', text: sentences.join(' ') }];
    const r = bindSpans(
      sentences.map((s) => ({ span: s, doc: 1 })),
      wide,
      { ...DEFAULT_ATTRIBUTE_LIMITS, maxSpans: 3 },
    );
    expect(r.spans).toHaveLength(3);
    expect(r.dropped).toHaveLength(3);
    expect(r.dropped[0]?.why).toMatch(/cap/i);
  });

  it('drops a malformed entry instead of throwing on it', () => {
    const r = bindSpans([{ doc: 1 }, { span: 42, doc: 1 }, null, 'nope'], docs);
    expect(r.spans).toEqual([]);
    expect(r.dropped).toHaveLength(4);
  });

  it('drops an entry with no document number rather than guessing one', () => {
    const r = bindSpans([{ span: 'Jiffy operates in Toronto and Ottawa' }], docs);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/document number/i);
  });

  it('returns nothing at all when the model returned no array', () => {
    expect(bindSpans(undefined, docs).spans).toEqual([]);
    expect(bindSpans({ spans: [] }, docs).spans).toEqual([]);
  });
});

describe('attribute — the pass that builds the universe', () => {
  it('turns a model reply into a numbered, proven universe', async () => {
    const ask = askWith(
      spansJson([
        { span: 'Jiffy operates in Toronto and Ottawa', doc: 1 },
        { span: 'TaskRabbit charges a 15% service fee', doc: 2 },
      ]),
    );
    const u = await attribute('who operates where?', docs, { ask });
    expect(u.spans).toHaveLength(2);
    expect(u.spans[0]?.url).toBe(URL_A);
    expect(u.costCents).toBeCloseTo(0.02);
    expect(u.note).toBe('');
  });

  it('reports refusals alongside the universe rather than hiding them', async () => {
    const ask = askWith(
      spansJson([
        { span: 'Jiffy operates in Toronto and Ottawa', doc: 1 },
        { span: 'Jiffy is the largest operator in Canada', doc: 1 },
      ]),
    );
    const u = await attribute('q', docs, { ask });
    expect(u.spans).toHaveLength(1);
    expect(u.dropped).toHaveLength(1);
  });

  it('says the documents carried nothing, rather than inventing a universe', async () => {
    // A corpus that supports nothing is a real outcome. Phase B must be given
    // an empty universe and a reason, not a fallback to the model's memory.
    const ask = askWith(spansJson([]));
    const u = await attribute('what is our own churn rate?', docs, { ask });
    expect(u.spans).toEqual([]);
    expect(u.note).toMatch(/nothing/i);
  });

  it('never spends a call when there is nothing to attribute against', async () => {
    const ask = askWith(spansJson([]));
    const u = await attribute('q', [], { ask });
    expect(ask.calls()).toBe(0);
    expect(u.costCents).toBe(0);
    expect(u.note).toMatch(/no documents/i);
  });

  it('reports a blocked model call instead of returning an empty success', async () => {
    const u = await attribute('q', docs, { ask: { ask: async () => null } });
    expect(u.spans).toEqual([]);
    expect(u.note).toMatch(/unavailable|ceiling/i);
  });

  it('survives a reply that is not JSON', async () => {
    const u = await attribute('q', docs, { ask: askWith('Sure! Here are some spans:') });
    expect(u.spans).toEqual([]);
    expect(u.note).toMatch(/nothing/i);
  });

  it('hands the model numbers, never URLs', async () => {
    // The out-of-range index is only a fabrication signal because the model had
    // no other way to name a source. Leak a URL into the prompt and it can cite
    // a page by name that it never read.
    const ask = {
      ask: vi.fn(async (_system: string, _user: string, _maxTokens: number) => ({
        text: spansJson([]),
        costCents: 0,
      })),
    };
    await attribute('q', docs, { ask });
    const user = ask.ask.mock.calls[0]?.[1] ?? '';
    expect(user).not.toContain(URL_A);
    expect(user).toContain('[1]');
    expect(user).toContain('[2]');
  });
});
