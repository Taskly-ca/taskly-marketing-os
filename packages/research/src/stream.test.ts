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
import type {
  ConversationTurn,
  DeltaEvent,
  SentenceEvent,
  SourceEvent,
  SpanEvent,
  StatusEvent,
} from './events.js';
import type { StreamedAnswer } from './stream.js';
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

/** Plans, extracts, then proposes. Dispatches on the system prompt so one fake
 *  serves all three non-streaming calls the pipeline makes. */
const ask = (
  opts: {
    queries?: string[];
    spans?: unknown[];
    standalone?: string;
    reuse?: boolean;
    related?: unknown[];
  } = {},
): AskPort => ({
  ask: async (system: string): Promise<AskResult | null> => {
    if (system.includes('search queries')) {
      return {
        text: JSON.stringify({
          queries: opts.queries ?? ['jiffy toronto pricing'],
          unanswerable: [],
          ...(opts.standalone === undefined ? {} : { standalone: opts.standalone }),
          ...(opts.reuse === undefined ? {} : { reuse: opts.reuse }),
        }),
        costCents: 0.01,
      };
    }
    if (system.includes('ask NEXT')) {
      return { text: JSON.stringify({ questions: opts.related ?? [] }), costCents: 0.02 };
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
    // plan 0.01 + attribute 0.02 + generate 0.05 + related 0.02.
    expect(answer.costCents).toBeCloseTo(0.10, 6);
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

/* ── conversation ─────────────────────────────────────────────────────────── */

/**
 * The follow-up half, and the one thing in it that is genuinely dangerous.
 *
 * Everything above tests a single turn, where the only thing a sentence can
 * rest on is a span this run proved. A conversation introduces a second thing
 * on the table — the previous answer — which is on-topic, already written, and
 * carried badges of its own. It is also, from this run's point of view, prose a
 * model wrote about pages that may since have changed.
 *
 * The failure to prevent is not "the follow-up is wrong". It is "the follow-up
 * is unsupported and reads as confirmed, because the conversation around it
 * was". These tests go after that directly: a figure proven LAST turn and gone
 * from the page THIS turn must flag; a claim with no figure in it must never
 * reach the generator at all, because no per-sentence check would catch it.
 */

/** The same page, a week later: the rate changed and "$89" is gone. */
const URL_A_LATER: ReadDoc = {
  url: URL_A,
  title: 'Jiffy',
  text:
    'Jiffy operates in Toronto and Ottawa with a network of cleaners. Their standard rate is now ' +
    '$109 per visit for two hours of work, booked entirely through the app, and the company has ' +
    'been running across Ontario for several years with steady expansion into nearby regions.',
};
const SPAN_LATER = 'Their standard rate is now $109 per visit';

/** The previous turn, as the route would hand it back: prose with markers, and
 *  the URLs that turn read. Its "$89" was true and proven — a week ago. */
const PRIOR: ConversationTurn = {
  question: 'What does Jiffy charge for a clean in Toronto?',
  answer: 'Their standard rate is $89 per visit [1]. Jiffy is the larger of the two providers [1].',
  sourceUrls: [URL_A],
};

interface Convo {
  readonly searches: string[];
  readonly fetched: string[];
  readonly genPrompt: () => string;
}

/** A run with history, over a read port the caller controls — which is how a
 *  page that has changed, or gone, is simulated without a network. */
function conversational(
  question: string,
  text: string,
  opts: {
    history?: readonly ConversationTurn[];
    askPort?: AskPort;
    docs?: readonly ReadDoc[];
    dead?: boolean;
  } = {},
): Promise<{ answer: StreamedAnswer; cap: Captured; convo: Convo }> {
  const searches: string[] = [];
  const fetched: string[] = [];
  let genPrompt = '';
  const docs = opts.docs ?? DOCS;

  const cap = capture();
  return streamAnswer(question, {
    ask: opts.askPort ?? ask(),
    askStream: {
      askStream: async (system, user, _m, onDelta): Promise<AskResult | null> => {
        genPrompt = `${system}\n${user}`;
        onDelta(text);
        return { text, costCents: 0.05 };
      },
    },
    search: [
      {
        name: 'fake',
        search: async (q: string): Promise<SearchHit[]> => {
          searches.push(q);
          return DOCS.map((d) => ({ title: d.title, url: d.url, snippet: '', provider: 'fake' }));
        },
      },
    ],
    read: {
      read: async (url: string): Promise<ReadDoc | null> => {
        fetched.push(url);
        return opts.dead === true ? null : (docs.find((d) => d.url === url) ?? null);
      },
    },
    ...(opts.history ? { history: opts.history } : {}),
    ...cap.deps,
  }).then((answer) => ({ answer, cap, convo: { searches, fetched, genPrompt: (): string => genPrompt } }));
}

describe('streamAnswer — a follow-up plans against the conversation', () => {
  it('runs a first question exactly as before when no history is given', async () => {
    const { convo } = await conversational('What does Jiffy charge?', `${SPAN_1} [1].`);
    expect(convo.searches).toEqual(['jiffy toronto pricing']);
    expect(convo.fetched).toEqual([URL_A, URL_B]);
  });

  it('answers the standalone rewrite, not the literal follow-up', async () => {
    // "and in Vancouver?" attributed and generated literally selects nothing:
    // four words that are relevant to no sentence on any page.
    const { answer, convo } = await conversational('and in Vancouver?', `${SPAN_1} [1].`, {
      history: [PRIOR],
      askPort: ask({ standalone: 'What do cleaners charge in Vancouver?', queries: ['vancouver'] }),
    });
    expect(convo.genPrompt()).toContain('QUESTION: What do cleaners charge in Vancouver?');
    // The reader's own words are still shown, so the answer is visibly a reply
    // to what was typed rather than to a rewrite nobody saw.
    expect(convo.genPrompt()).toContain('and in Vancouver?');
    // What the reader asked is what comes back on the answer, unrewritten.
    expect(answer.question).toBe('and in Vancouver?');
  });
});

describe('streamAnswer — reuse skips the search, never the evidence', () => {
  it('runs no search at all when the follow-up needs nothing new', async () => {
    // "Which of those was cheapest?" — answerable from the pages just read. A
    // search here spends a call and eight fetches to arrive back at them.
    const { answer, convo } = await conversational('which of those was cheapest?', `${SPAN_1} [1].`, {
      history: [PRIOR],
      askPort: ask({ queries: [], reuse: true, standalone: 'Which provider was cheapest?' }),
    });
    expect(convo.searches).toEqual([]);
    expect(convo.fetched).toEqual([URL_A]);
    expect(answer.reused).toEqual([URL_A]);
    expect(answer.queries).toEqual([]);
    expect(answer.note).toBe('');
  });

  it('re-reads the reused page rather than trusting a remembered copy', async () => {
    // The whole staleness argument in one assertion: reuse carries the URL
    // list, and the fetch happens again, so the answer is about the page as it
    // is now. `ConversationTurn` carries no text for exactly this reason.
    const { convo } = await conversational('and now?', `${SPAN_LATER} [1].`, {
      history: [PRIOR],
      askPort: ask({ queries: [], reuse: true, spans: [{ span: SPAN_LATER, doc: 1 }] }),
      docs: [URL_A_LATER],
    });
    expect(convo.fetched).toEqual([URL_A]);
  });

  it('fetches only what is genuinely new when it also searches', async () => {
    // Reuse plus queries: the reused page is read once, and the search result
    // for that same page collapses into it instead of being fetched again.
    const { answer, convo } = await conversational('and in Ottawa?', `${SPAN_1} [1].`, {
      history: [PRIOR],
      askPort: ask({ queries: ['ottawa cleaners'], reuse: true }),
    });
    expect(convo.searches).toEqual(['ottawa cleaners']);
    expect(convo.fetched).toEqual([URL_A, URL_B]);
    expect(answer.reused).toEqual([URL_A]);
  });

  it('searches anyway when reuse is claimed but there is nothing to reuse', async () => {
    const { convo } = await conversational('and in Ottawa?', `${SPAN_1} [1].`, {
      history: [{ question: 'q', answer: 'a', sourceUrls: [] }],
      askPort: ask({ queries: ['ottawa cleaners'], reuse: true }),
    });
    expect(convo.searches).toEqual(['ottawa cleaners']);
  });
});

describe('streamAnswer — credibility does not travel between turns', () => {
  it('flags a figure the previous turn proved once the page no longer carries it', async () => {
    // THE CASE. "$89" was genuinely confirmed last turn against this very page.
    // The page now says $109. The model, writing a follow-up, restates $89 and
    // cites the span it has. Nothing about the conversation may rescue that:
    // the figure is not in a span cited in THIS run, so the sentence flags.
    const { answer, cap } = await conversational(
      'and is that still the rate?',
      `Their standard rate is $89 per visit [1].`,
      {
        history: [PRIOR],
        askPort: ask({ queries: [], reuse: true, spans: [{ span: SPAN_LATER, doc: 1 }] }),
        docs: [URL_A_LATER],
      },
    );
    expect(cap.sentences[0]?.verdict).toBe('flagged');
    expect(cap.sentences[0]?.why).toContain('"89"');
    expect(answer.flagged).toBe(1);
    // And the wording still says unconfirmed rather than false — the rate may
    // have been right and merely unquoted, and we do not know which.
    expect(cap.sentences[0]?.why).toContain('unconfirmed');

    // The control, so the assertion above cannot be passing for some unrelated
    // reason: the identical sentence over the page that DOES still say $89
    // confirms. What changed is the evidence, not the conversation.
    const unchanged = await conversational(
      'and is that still the rate?',
      `Their standard rate is $89 per visit [1].`,
      {
        history: [PRIOR],
        askPort: ask({
          queries: [],
          reuse: true,
          spans: [{ span: 'Their standard rate is $89 per visit for two hours of work', doc: 1 }],
        }),
        docs: [DOCS[0] as ReadDoc],
      },
    );
    expect(unchanged.cap.sentences[0]?.verdict).toBe('confirmed');
  });

  it('never puts the previous answer where the generator could copy from it', async () => {
    // The structural half, and the reason the check above is a backstop rather
    // than the defence. "Jiffy is the larger of the two providers" carries no
    // figure, so `checkSentence` would confirm it as readily as any other
    // marked sentence — a claim from a previous run, wearing this run's badge.
    // The only thing that stops it is that phase B is never shown the prose.
    const { convo } = await conversational('and is that still true?', `${SPAN_LATER} [1].`, {
      history: [PRIOR],
      askPort: ask({ queries: [], reuse: true, spans: [{ span: SPAN_LATER, doc: 1 }] }),
      docs: [URL_A_LATER],
    });
    const prompt = convo.genPrompt();
    expect(prompt).not.toContain('larger of the two');
    expect(prompt).not.toContain('$89');
    expect(prompt).not.toContain(PRIOR.answer);
    // What it IS given: the standalone question and the spans proven this run.
    expect(prompt).toContain(SPAN_LATER);
  });

  it('refuses rather than answering from history when the reused pages are gone', async () => {
    // Link rot, or a changed robots.txt. The previous answer is right there and
    // would make a serviceable reply. Using it would mean an answer not one
    // word of which was proven this run.
    const { answer, cap } = await conversational('and is that still the rate?', 'unused', {
      history: [PRIOR],
      askPort: ask({ queries: [], reuse: true }),
      dead: true,
    });
    expect(answer.text).toBe('');
    expect(cap.deltas).toEqual([]);
    expect(answer.sentences).toEqual([]);
    expect(answer.note).toContain('context, not evidence');
  });

  it('still deletes a fabricated marker inside a follow-up', async () => {
    const { answer, cap } = await conversational(
      'and elsewhere?',
      `${SPAN_LATER} [1]. Jiffy also covers Hamilton [9].`,
      {
        history: [PRIOR],
        askPort: ask({ queries: [], reuse: true, spans: [{ span: SPAN_LATER, doc: 1 }] }),
        docs: [URL_A_LATER],
      },
    );
    expect(answer.text).not.toContain('[9]');
    expect(cap.sentences[1]?.verdict).toBe('flagged');
  });

  it('still runs the honesty gate and the causal lint on a follow-up', async () => {
    const { cap } = await conversational(
      'and are they safe?',
      'Every Jiffy cleaner is fully vetted [1]. The $109 rate caused bookings to fall [1].',
      {
        history: [PRIOR],
        askPort: ask({ queries: [], reuse: true, spans: [{ span: SPAN_LATER, doc: 1 }] }),
        docs: [URL_A_LATER],
      },
    );
    expect(cap.sentences[0]?.why).toContain('honesty gate');
    expect(cap.sentences[1]?.why).toContain('causal language');
  });
});

describe('streamAnswer — related questions', () => {
  it('returns questions grounded in the spans this run proved', async () => {
    const { answer } = await run(`${SPAN_1} [1]. ${SPAN_2} [2].`, undefined, ask({
      related: [
        'Does Jiffy operate outside Ottawa?',
        'How large is the Calgary snow-removal market?',
        'Is the 15% TaskRabbit fee typical in Canada?',
      ],
    }));
    // The middle one names nothing any quote mentions and does not survive.
    expect(answer.related).toEqual([
      'Does Jiffy operate outside Ottawa?',
      'Is the 15% TaskRabbit fee typical in Canada?',
    ]);
  });

  it('offers nothing when there was nothing to answer from', async () => {
    const { answer } = await run('anything', undefined, ask({ spans: [], related: ['Anything?'] }));
    expect(answer.related).toEqual([]);
  });
});
