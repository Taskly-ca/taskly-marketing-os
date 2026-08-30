/**
 * Phases B and C, driven end to end with fake ports — no key, no network, no
 * clock, no model.
 *
 * The cases that matter are the ones where the answer LOOKS finished. A `[9]`
 * reads exactly like a `[2]`; "$2.1B" reads exactly like a figure someone
 * checked; "caused" reads like a finding. By the time prose is on screen nobody
 * re-opens the sources, so every one of these has to be caught mechanically
 * while the sentence is still a string — which is precisely what phase C is,
 * and precisely what a wrong sentence boundary would defeat.
 */
import { describe, expect, it } from 'vitest';

import type { CitableSpan } from './attribute.js';
import type { DeltaEvent, SentenceEvent, SourceEvent, SpanEvent, StatusEvent } from './events.js';
import { checkSentence, streamAnswer } from './stream.js';
import type {
  AskPort,
  AskResult,
  AskStreamPort,
  ReadDoc,
  ReadPort,
  SearchHit,
  SearchPort,
} from './types.js';

const URL_A = 'https://example.com/jiffy';
const URL_B = 'https://competitor.example.org/taskrabbit';

const DOCS: ReadDoc[] = [
  {
    url: URL_A,
    title: 'Jiffy',
    text:
      'Jiffy operates in Toronto and Ottawa with a network of cleaners. Their standard rate is $89 ' +
      'per visit for two hours of work, booked entirely through the app, and the company has been ' +
      'running across Ontario for several years with steady expansion into nearby regions.',
  },
  {
    url: URL_B,
    title: 'TaskRabbit',
    text:
      'TaskRabbit charges a 15% service fee on every booking in Canada. The platform lists ' +
      'thousands of taskers across Toronto, Vancouver and Montreal, and it publishes its rates ' +
      'openly on a pricing page for anyone who wants to compare them before booking anything.',
  },
];

const SPAN_1 = 'Jiffy operates in Toronto and Ottawa';
const SPAN_2 = 'TaskRabbit charges a 15% service fee on every booking in Canada';

const SPANS: CitableSpan[] = [
  { id: 1, docIndex: 1, url: URL_A, span: SPAN_1 },
  { id: 2, docIndex: 2, url: URL_B, span: SPAN_2 },
];

/* ── the fakes ────────────────────────────────────────────────────────────── */

const search: SearchPort = {
  name: 'fake',
  search: async (): Promise<SearchHit[]> =>
    DOCS.map((d) => ({ title: d.title, url: d.url, snippet: '', provider: 'fake' })),
};

const read: ReadPort = {
  read: async (url: string): Promise<ReadDoc | null> => DOCS.find((d) => d.url === url) ?? null,
};

/** Plans, then extracts. Dispatches on the system prompt so one fake serves
 *  both non-streaming calls the pipeline makes. */
const ask = (opts: { queries?: string[]; spans?: unknown[] } = {}): AskPort => ({
  ask: async (system: string): Promise<AskResult | null> => {
    if (system.includes('search queries')) {
      return {
        text: JSON.stringify({ queries: opts.queries ?? ['jiffy toronto pricing'], unanswerable: [] }),
        costCents: 0.01,
      };
    }
    return {
      text: JSON.stringify({
        spans: opts.spans ?? [
          { span: SPAN_1, doc: 1 },
          { span: SPAN_2, doc: 2 },
        ],
      }),
      costCents: 0.02,
    };
  },
});

/** Streams `text` in the given chunks, then returns it whole — the shape
 *  `AskStreamPort` specifies, where the return value is the answer and the
 *  deltas are only a side channel. */
const streamer = (text: string, chunks?: readonly string[]): AskStreamPort => ({
  askStream: async (_s, _u, _m, onDelta): Promise<AskResult | null> => {
    for (const c of chunks ?? [text]) onDelta(c);
    return { text, costCents: 0.05 };
  },
});

interface Captured {
  readonly status: StatusEvent[];
  readonly sources: SourceEvent[];
  readonly spans: SpanEvent[];
  readonly deltas: DeltaEvent[];
  readonly sentences: SentenceEvent[];
}

function capture(): Captured & { deps: Omit<Parameters<typeof streamAnswer>[1], 'ask' | 'askStream' | 'search' | 'read'> } {
  const c: Captured = { status: [], sources: [], spans: [], deltas: [], sentences: [] };
  return {
    ...c,
    deps: {
      onStatus: (e): void => void c.status.push(e),
      onSource: (e): void => void c.sources.push(e),
      onSpan: (e): void => void c.spans.push(e),
      onDelta: (e): void => void c.deltas.push(e),
      onSentence: (e): void => void c.sentences.push(e),
    },
  };
}

const run = (text: string, chunks?: readonly string[], askPort: AskPort = ask()) => {
  const cap = capture();
  return streamAnswer('What do competitors charge in Toronto?', {
    ask: askPort,
    askStream: streamer(text, chunks),
    search: [search],
    read,
    ...cap.deps,
  }).then((answer) => ({ answer, cap }));
};

/* ── phase C, unit ────────────────────────────────────────────────────────── */

describe('checkSentence — the four deterministic checks', () => {
  it('confirms a sentence whose markers resolve and whose figures are quoted', () => {
    expect(checkSentence(0, `${SPAN_2} [2].`, SPANS)).toEqual({ n: 0, verdict: 'confirmed' });
  });

  it('flags a marker that points at no span, and says so as a fabrication', () => {
    const v = checkSentence(3, 'Jiffy also covers Hamilton [9].', SPANS);
    expect(v.verdict).toBe('flagged');
    expect(v.n).toBe(3);
    expect(v.why).toContain('[9]');
    expect(v.why).toContain('no span behind it');
  });

  it('flags a figure that appears in no cited span', () => {
    const v = checkSentence(0, 'The Toronto market is worth $2.1B [1].', SPANS);
    expect(v.verdict).toBe('flagged');
    expect(v.why).toContain('"2.1"');
    // The wording is the contract: unconfirmed, not false.
    expect(v.why).toContain('unconfirmed');
    expect(v.why).not.toContain('false');
  });

  it('flags a figure in a sentence that cites nothing at all', () => {
    const v = checkSentence(0, 'The market grew by 40% last year.', SPANS);
    expect(v.verdict).toBe('flagged');
    expect(v.why).toContain('cites no span at all');
  });

  it('does not demand that the marker digits themselves be sourced', () => {
    // `[12]` must not be read as the number twelve: without stripping markers
    // first, every sentence citing span 10 or higher would flag for citing.
    const many: CitableSpan[] = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      docIndex: 1,
      url: URL_A,
      span: SPAN_1,
    }));
    expect(checkSentence(0, 'Jiffy operates in Ottawa [12].', many).verdict).toBe('confirmed');
  });

  it('flags a banned trust claim even in an internal answer', () => {
    const v = checkSentence(0, 'Every Tasker is fully vetted before joining [1].', SPANS);
    expect(v.verdict).toBe('flagged');
    expect(v.why).toContain('honesty gate');
  });

  it('flags causal language — the check the research pipeline never ran', () => {
    const v = checkSentence(0, 'The 15% fee caused bookings to fall [2].', SPANS);
    expect(v.verdict).toBe('flagged');
    expect(v.why).toContain('causal language');
    expect(v.why).toContain('caused');
  });

  it('reports every reason a sentence failed, not only the first', () => {
    const v = checkSentence(0, 'Growth of 40% was caused by demand [9].', SPANS);
    expect(v.why).toContain('[9]');
    expect(v.why).toContain('"40"');
    expect(v.why).toContain('caused');
  });

  it('confirms a sentence that asserts nothing checkable', () => {
    // No marker, no figure, nothing that could fail. "Confirmed" here means
    // "nothing in it went unchecked", which is the honest reading of a badge on
    // a connective sentence.
    expect(checkSentence(0, 'Here is what the sources show.', SPANS).verdict).toBe('confirmed');
  });
});

/* ── phases B + C, end to end ─────────────────────────────────────────────── */

describe('streamAnswer — the happy path', () => {
  const TEXT = `${SPAN_1} [1]. ${SPAN_2} [2].`;

  it('stages sources and spans before any prose, then streams and checks', async () => {
    const { answer, cap } = await run(TEXT);

    expect(cap.sources.map((s) => s.i)).toEqual([1, 2]);
    expect(cap.sources[0]).toMatchObject({ url: URL_A, domain: 'example.com' });
    expect(cap.spans.map((s) => s.id)).toEqual([1, 2]);
    expect(cap.spans[1]).toMatchObject({ sourceIndex: 2, quote: SPAN_2 });

    expect(cap.sentences).toEqual([
      { n: 0, verdict: 'confirmed' },
      { n: 1, verdict: 'confirmed' },
    ]);
    expect(answer.flagged).toBe(0);
    expect(answer.note).toBe('');
    expect(answer.costCents).toBeCloseTo(0.08, 6);
  });

  it('emits every phase in order, sources before writing', async () => {
    const { cap } = await run(TEXT);
    const phases = cap.status.map((s) => s.phase);
    expect(phases).toEqual(['planning', 'searching', 'reading', 'attributing', 'writing', 'checking', 'done']);
  });

  it('the deltas concatenate to exactly what the reader is told the answer is', async () => {
    const { answer, cap } = await run(TEXT);
    expect(cap.deltas.map((d) => d.text).join('')).toBe(answer.text);
    expect(answer.text).toBe(TEXT);
  });

  it('tags every delta with the sentence it belongs to', async () => {
    const { cap } = await run(TEXT, [...TEXT]);
    const bySentence = new Map<number, string>();
    for (const d of cap.deltas) bySentence.set(d.n, (bySentence.get(d.n) ?? '') + d.text);
    expect(bySentence.get(0)?.trim()).toBe(`${SPAN_1} [1].`);
    expect(bySentence.get(1)?.trim()).toBe(`${SPAN_2} [2].`);
  });

  it('reaches the same verdicts when the answer arrives one character at a time', async () => {
    const whole = await run(TEXT);
    const dribbled = await run(TEXT, [...TEXT]);
    expect(dribbled.cap.sentences).toEqual(whole.cap.sentences);
    expect(dribbled.answer.text).toBe(whole.answer.text);
  });
});

describe('streamAnswer — fabrication is caught, not rendered', () => {
  const TEXT = `${SPAN_1} [1]. Jiffy also covers Hamilton and Barrie [9].`;

  it('flags the sentence that cites a span that does not exist', async () => {
    const { cap } = await run(TEXT);
    expect(cap.sentences[0]).toEqual({ n: 0, verdict: 'confirmed' });
    expect(cap.sentences[1]?.verdict).toBe('flagged');
    expect(cap.sentences[1]?.why).toContain('[9]');
  });

  it('never puts the invented marker on screen, however it is chunked', async () => {
    // Including the chunking that splits the marker itself in half — `[9` in
    // one delta and `]` in the next — which is the shape a real token stream
    // produces and the one a naive substring filter misses.
    const half = TEXT.indexOf('[9]') + 2;
    const chunkings: readonly (readonly string[])[] = [
      [TEXT],
      [...TEXT],
      [TEXT.slice(0, half), TEXT.slice(half)],
    ];
    for (const chunks of chunkings) {
      const { answer, cap } = await run(TEXT, chunks);
      expect(answer.text).not.toContain('[9]');
      expect(answer.text).not.toContain('[9');
      expect(cap.deltas.map((d) => d.text).join('')).toBe(answer.text);
      // The real marker is untouched — the gate removes fabrications, not
      // citations.
      expect(answer.text).toContain('[1]');
    }
  });

  it('drops a mixed group whole rather than quietly rewriting the citation', async () => {
    const { answer } = await run(`${SPAN_1} [1, 9].`);
    expect(answer.text).not.toContain('[1, 9]');
    expect(answer.text).not.toContain('[1]');
    expect(answer.flagged).toBe(1);
  });

  it('leaves an ordinary bracket in the prose alone', async () => {
    const { answer } = await run(`${SPAN_1} [sic] [1].`);
    expect(answer.text).toContain('[sic]');
    expect(answer.flagged).toBe(0);
  });
});

describe('streamAnswer — the other ways a sentence fails', () => {
  it('flags an unsourced figure while confirming its neighbour', async () => {
    const { answer, cap } = await run(`${SPAN_1} [1]. The market is worth $2.1B [1].`);
    expect(cap.sentences.map((s) => s.verdict)).toEqual(['confirmed', 'flagged']);
    expect(cap.sentences[1]?.why).toContain('"2.1"');
    expect(answer.flagged).toBe(1);
  });

  it('flags a banned trust claim', async () => {
    const { cap } = await run('Every Tasker is fully vetted before joining [1].');
    expect(cap.sentences[0]?.why).toContain('honesty gate');
  });

  it('flags causal language', async () => {
    const { cap } = await run('The 15% fee caused bookings to fall [2].');
    expect(cap.sentences[0]?.why).toContain('causal language');
  });

  it('does not let an abbreviation move a verdict onto the wrong sentence', async () => {
    // One sentence, not two: if "Inc." split it, the figure and its marker
    // would land in different sentences and BOTH halves would flag — a verdict
    // manufactured entirely by a bad boundary.
    const { answer, cap } = await run(`The buyer was Acme Inc. ${SPAN_2} [2].`);
    expect(cap.sentences).toHaveLength(1);
    expect(cap.sentences[0]).toEqual({ n: 0, verdict: 'confirmed' });
    expect(answer.flagged).toBe(0);
  });
});

describe('streamAnswer — when there is nothing to say', () => {
  it('refuses to generate against an empty citable universe', async () => {
    const { answer, cap } = await run('anything at all', undefined, ask({ spans: [] }));
    expect(answer.text).toBe('');
    expect(cap.deltas).toEqual([]);
    expect(cap.sentences).toEqual([]);
    expect(answer.note).toContain('nothing quotable');
  });

  it('stops before searching when the question cannot be turned into a query', async () => {
    const { answer, cap } = await run('x', undefined, ask({ queries: [] }));
    expect(cap.sources).toEqual([]);
    expect(answer.note).toContain('Could not turn that into a search');
  });

  it('reports a read stage that returned nothing', async () => {
    const answer = await streamAnswer('q', {
      ask: ask(),
      askStream: streamer('unused'),
      search: [search],
      read: { read: async (): Promise<ReadDoc | null> => null },
    });
    expect(answer.note).toContain('could not read any of them');
    expect(answer.sources).toEqual([]);
  });

  it('does not stamp a verdict on a sentence the model never finished', async () => {
    // The stream died mid-answer. Flushing the splitter here would hand the
    // fragment to the checker and a truncated half-sentence would come back
    // "confirmed", which reads exactly like a whole one.
    const cap = capture();
    const answer = await streamAnswer('q', {
      ask: ask(),
      askStream: {
        askStream: async (_s, _u, _m, onDelta): Promise<AskResult | null> => {
          onDelta(`${SPAN_1} [1]. Their standard rate is`);
          return null;
        },
      },
      search: [search],
      read,
      ...cap.deps,
    });
    expect(answer.note).toContain('stopped part-way');
    expect(answer.sentences).toEqual([{ n: 0, verdict: 'confirmed' }]);
    expect(cap.sentences).toHaveLength(1);
  });

  it('checks the tail when the returned answer is longer than what streamed', async () => {
    // A dropped delta must not mean a sentence escapes the check: the returned
    // text is authoritative and its unseen suffix goes through the same gate.
    const full = `${SPAN_1} [1]. The market is worth $2.1B [1].`;
    const cap = capture();
    const answer = await streamAnswer('q', {
      ask: ask(),
      askStream: {
        askStream: async (_s, _u, _m, onDelta): Promise<AskResult | null> => {
          onDelta(`${SPAN_1} [1]. `);
          return { text: full, costCents: 0.05 };
        },
      },
      search: [search],
      read,
      ...cap.deps,
    });
    expect(answer.sentences.map((s) => s.verdict)).toEqual(['confirmed', 'flagged']);
    expect(answer.text).toBe(full);
  });
});
