/**
 * WHAT THE ANSWER ROUTE OWES, PROVEN WITHOUT A SOCKET, A KEY OR A DATABASE.
 *
 * The route itself is glue — headers, a query string, a `res.end()` — and glue
 * is not where the money or the corruption is. Four things are, and all four
 * are testable with fakes:
 *
 *  1. **Sequencing.** The events must arrive in the order the contract stages
 *     them (sources before prose, `done` last and exactly once), because that
 *     ordering IS the product: §3 of the plan makes the case that a multi-second
 *     wait reads as legible rather than hung only when the sources land first.
 *  2. **The concurrency guard.** `/api/research` has none — N tabs is N
 *     concurrent paid runs — and a reload during a 60-second answer is the
 *     common case, not the exotic one.
 *  3. **Persistence.** A turn is a user message and an assistant message with
 *     its citations. A citation for a marker that never appears in the prose is
 *     noise; a marker with no citation is an answer that looks checked and is
 *     not.
 *  4. **Refusing to spend.** The budget pre-flight must land BEFORE the thread
 *     is created, or a refused day still accumulates empty threads.
 */
import { describe, expect, it } from 'vitest';

import type {
  AskPort,
  AskStreamPort,
  ReadPort,
  SearchPort,
  SourceEvent,
  SpanEvent,
} from '@tmos/research';
import type {
  CitationRecord,
  MessageRecord,
  NewMessage,
  NewThread,
  ThreadDetail,
  ThreadRecord,
} from '@tmos/adapters';

import {
  AnswerBusy,
  AnswerGuard,
  answerKey,
  citationsFor,
  epilogueFor,
  historyFor,
  runAnswerStream,
  titleFor,
  type AnswerDeps,
  type AnswerStore,
  type EpilogueEvent,
  type StreamAnswerFn,
} from './answer-route.js';
import type { SseSink } from './sse.js';

/* ── fakes ──────────────────────────────────────────────────────────────── */

function recorder(): { frames: { event: string; data: unknown }[]; sink: SseSink } {
  const frames: { event: string; data: unknown }[] = [];
  const sink: SseSink = {
    write: (chunk: string) => {
      const [head = '', body = ''] = chunk.split('\n');
      frames.push({
        event: head.replace('event: ', ''),
        data: JSON.parse(body.replace('data: ', '')) as unknown,
      });
      return true;
    },
  };
  return { frames, sink };
}

class FakeStore implements AnswerStore {
  readonly threads: ThreadRecord[] = [];
  readonly messages: NewMessage[] = [];

  async createThread(t: NewThread): Promise<ThreadRecord> {
    const rec: ThreadRecord = {
      id: t.id,
      title: t.title,
      titleSource: t.titleSource ?? 'question',
      forkedFromMessageId: t.forkedFromMessageId ?? null,
      createdAt: t.createdAt,
      updatedAt: t.createdAt,
      archivedAt: null,
    };
    this.threads.push(rec);
    return rec;
  }

  async getThread(id: string): Promise<ThreadDetail | null> {
    const head = this.threads.find((t) => t.id === id);
    if (!head) return null;
    // The stored turns, not an empty list: the history a follow-up is answered
    // against is read back out of here, so a store that forgets them would make
    // every history assertion below vacuously true.
    const messages = this.messages
      .filter((m) => m.threadId === id)
      .map((m, i) => this.record(m, i + 1));
    return { ...head, messages };
  }

  private record(m: NewMessage, seq: number): MessageRecord {
    return {
      id: m.id,
      threadId: m.threadId,
      seq,
      role: m.role,
      body: m.body,
      mode: m.mode ?? null,
      runId: m.runId ?? null,
      costCents: m.costCents ?? 0,
      answer: m.answer ?? null,
      createdAt: m.createdAt,
      citations: m.citations ?? [],
    };
  }

  async appendMessage(m: NewMessage): Promise<MessageRecord> {
    this.messages.push(m);
    return this.record(m, this.messages.length);
  }
}

const PORTS = {
  ask: { ask: async () => null } as AskPort,
  askStream: { askStream: async () => null } as AskStreamPort,
  search: [{ name: 'fake', search: async () => [] }] as readonly SearchPort[],
  read: { read: async () => null } as ReadPort,
};

const SOURCE: SourceEvent = {
  i: 1,
  url: 'https://example.ca/report',
  title: 'GTA home services 2026',
  domain: 'example.ca',
};
const SPAN: SpanEvent = { id: 1, sourceIndex: 1, quote: 'the market grew 12% in 2025' };

/** A stand-in for Part 3's pipeline: emits one of everything, then returns. */
const happyStream: StreamAnswerFn = async (_q, dep) => {
  dep.onStatus({ phase: 'planning' });
  dep.onStatus({ phase: 'reading' });
  dep.onSource(SOURCE);
  dep.onStatus({ phase: 'attributing' });
  dep.onSpan(SPAN);
  dep.onStatus({ phase: 'writing' });
  dep.onDelta({ n: 1, text: 'The market grew 12% [1].' });
  dep.onSentence({ n: 1, verdict: 'confirmed' });
  dep.onDelta({ n: 2, text: ' Supply is thinner in the east.' });
  dep.onSentence({ n: 2, verdict: 'flagged', why: 'no span carries this' });
  return {
    text: 'The market grew 12% [1]. Supply is thinner in the east.',
    costCents: 3,
    sources: [{ url: SOURCE.url, title: SOURCE.title, text: 'the market grew 12% in 2025' }],
    queries: ['gta home services market size 2026'],
    unanswered: [],
  };
};

let seq = 0;
function deps(over: Partial<Omit<AnswerDeps, 'store'>> = {}): AnswerDeps & { store: FakeStore } {
  const store = new FakeStore();
  seq = 0;
  return {
    guard: new AnswerGuard(),
    streamAnswer: happyStream,
    ports: PORTS,
    runId: 'run-1',
    now: () => new Date('2026-08-31T12:00:00Z'),
    newId: () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    checkBudget: () => null,
    noteCost: () => undefined,
    ...over,
    store,
  };
}

const ASK = { question: 'How large is the GTA home-services market?', threadId: null };

/* ── the pure pieces ────────────────────────────────────────────────────── */

describe('answerKey', () => {
  it('keys a follow-up by its thread — that is the run that must not double', () => {
    expect(answerKey('t-1', 'anything at all')).toBe(answerKey('t-1', 'something else'));
  });

  it('keys a new question by the question, so a reload storm is one run', () => {
    // The reported failure is N TABS, and N tabs asking the same thing carry no
    // thread id to collide on. Normalising is what makes them collide.
    expect(answerKey(null, 'How big is  the market? ')).toBe(answerKey(null, 'how big is the market?'));
    expect(answerKey(null, 'a different question entirely')).not.toBe(answerKey(null, 'how big is the market?'));
  });
});

describe('AnswerGuard', () => {
  it('refuses a second answer on the same key, and says why', () => {
    const guard = new AnswerGuard(4);
    guard.begin('thread:1');
    expect(() => guard.begin('thread:1')).toThrow(AnswerBusy);
  });

  it('allows a genuinely different question to run alongside', () => {
    const guard = new AnswerGuard(4);
    guard.begin('thread:1');
    expect(() => guard.begin('thread:2')).not.toThrow();
  });

  it('caps total concurrent runs — the ceiling is money, not correctness', () => {
    const guard = new AnswerGuard(2);
    guard.begin('a');
    guard.begin('b');
    expect(() => guard.begin('c')).toThrow(AnswerBusy);
  });

  it('frees the slot when the run ends, and a double release frees nobody else', () => {
    const guard = new AnswerGuard(2);
    const release = guard.begin('a');
    guard.begin('b');
    release();
    release(); // idempotent: a `finally` that also ran on the error path
    expect(guard.size()).toBe(1);
    expect(() => guard.begin('c')).not.toThrow();
  });
});

describe('titleFor', () => {
  it('names the thread after the question, collapsed and capped', () => {
    expect(titleFor('  How   big is the market? ')).toBe('How big is the market?');
    expect(titleFor('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it('never returns a blank title — the store refuses one', () => {
    expect(titleFor('   ').length).toBeGreaterThan(0);
  });
});

describe('citationsFor', () => {
  it('records only the markers the prose actually used', () => {
    const spans: SpanEvent[] = [SPAN, { id: 2, sourceIndex: 1, quote: 'unused quote here' }];
    const cites = citationsFor('The market grew 12% [1].', spans, [SOURCE]);
    expect(cites).toEqual([
      { ordinal: 1, sourceUrl: SOURCE.url, span: SPAN.quote, title: SOURCE.title },
    ]);
  });

  it('drops a marker that resolves to no span rather than inventing one', () => {
    expect(citationsFor('as reported [7]', [SPAN], [SOURCE])).toEqual([]);
  });

  it('records a repeated marker once — a marker identifies one source', () => {
    // `appendMessage` refuses two citations at the same ordinal outright, so
    // emitting a duplicate would abort the whole turn.
    expect(citationsFor('[1] and again [1]', [SPAN], [SOURCE])).toHaveLength(1);
  });
});

/* ── the run ────────────────────────────────────────────────────────────── */

describe('runAnswerStream', () => {
  it('stages the events the contract promises, with done last and once', async () => {
    const { frames, sink } = recorder();
    await runAnswerStream(sink, ASK, deps());

    const names = frames.map((f) => f.event);
    expect(names.indexOf('source')).toBeLessThan(names.indexOf('delta'));
    expect(names.indexOf('span')).toBeLessThan(names.indexOf('delta'));
    expect(names.filter((n) => n === 'done')).toHaveLength(1);
    expect(names.at(-1)).toBe('done');
    expect(names).not.toContain('error_msg');
  });

  it('reports the cost, the ids and the sentences that never confirmed', async () => {
    const { frames, sink } = recorder();
    const d = deps();
    await runAnswerStream(sink, ASK, d);

    const done = frames.at(-1)?.data as { costCents: number; threadId: string; messageId: string; flagged: number };
    expect(done.costCents).toBe(3);
    expect(done.flagged).toBe(1);
    expect(done.threadId).toBe(d.store.threads[0]?.id);
    expect(done.messageId).toBe(d.store.messages[1]?.id);
  });

  it('persists the turn: the question first, then the answer with its citations', async () => {
    const { sink } = recorder();
    const d = deps();
    await runAnswerStream(sink, ASK, d);

    expect(d.store.threads).toHaveLength(1);
    expect(d.store.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    const [user, assistant] = d.store.messages;
    // A user turn carries no mode, no cost and no citations — `appendMessage`
    // rejects all three, and a rejected append aborts the turn.
    expect(user?.mode ?? null).toBeNull();
    expect(user?.body).toBe(ASK.question);
    expect(assistant?.mode).toBe('fast');
    expect(assistant?.runId).toBe('run-1');
    expect(assistant?.costCents).toBe(3);
    expect(assistant?.citations).toEqual([
      { ordinal: 1, sourceUrl: SOURCE.url, span: SPAN.quote, title: SOURCE.title },
    ]);
  });

  it('refuses a second run on the same question and writes nothing for it', async () => {
    const guard = new AnswerGuard();
    const d = deps({ guard });
    let letGo = (): void => undefined;
    const held = new Promise<void>((r) => {
      letGo = r;
    });
    const slow: StreamAnswerFn = async (q, x) => {
      // Hold the slot while the second request arrives, exactly as a real
      // 60-second run does when the tab is reloaded.
      await held;
      return happyStream(q, x);
    };

    const first = runAnswerStream(recorder().sink, ASK, { ...d, streamAnswer: slow });
    const busy = recorder();
    const second = runAnswerStream(busy.sink, ASK, d);
    letGo();
    await Promise.all([first, second]);

    expect(busy.frames.map((f) => f.event)).toEqual(['error_msg']);
    expect(String(busy.frames[0]?.data)).toMatch(/already/i);
    // One turn, not two: the refused request cost nothing and stored nothing.
    expect(d.store.messages).toHaveLength(2);
  });

  it('releases the slot when the run ends, so the next question is not refused', async () => {
    const guard = new AnswerGuard();
    const d = deps({ guard });
    await runAnswerStream(recorder().sink, ASK, d);
    expect(guard.size()).toBe(0);

    const again = recorder();
    await runAnswerStream(again.sink, ASK, d);
    expect(again.frames.map((f) => f.event)).toContain('done');
  });

  it('releases the slot even when the pipeline throws', async () => {
    const guard = new AnswerGuard();
    const { frames, sink } = recorder();
    const boom: StreamAnswerFn = () => Promise.reject(new Error('groq refused'));
    await runAnswerStream(sink, ASK, deps({ guard, streamAnswer: boom }));

    expect(guard.size()).toBe(0);
    expect(frames.at(-1)?.event).toBe('error_msg');
    expect(String(frames.at(-1)?.data)).toContain('groq refused');
  });

  it('refuses a question too short to search, before anything is spent or stored', async () => {
    const { frames, sink } = recorder();
    const d = deps();
    await runAnswerStream(sink, { question: 'why?', threadId: null }, d);
    expect(frames.map((f) => f.event)).toEqual(['error_msg']);
    expect(d.store.threads).toHaveLength(0);
  });

  it('refuses when the reconstructed day is spent, and creates no thread for it', async () => {
    const { frames, sink } = recorder();
    const d = deps({ checkBudget: () => 'daily spend would reach 2005c, ceiling 2000c' });
    await runAnswerStream(sink, ASK, d);

    expect(frames.map((f) => f.event)).toEqual(['error_msg']);
    expect(String(frames[0]?.data)).toContain('ceiling');
    expect(d.store.threads).toHaveLength(0);
    expect(d.store.messages).toHaveLength(0);
  });

  it('records the spend against the day so the next run sees it', async () => {
    const noted: number[] = [];
    await runAnswerStream(recorder().sink, ASK, deps({ noteCost: (c) => noted.push(c) }));
    expect(noted).toEqual([3]);
  });

  it('keeps the retrieval record, so a reopened thread still shows its sources', async () => {
    const d = deps();
    await runAnswerStream(recorder().sink, ASK, d);

    const answer = d.store.messages[1]?.answer;
    expect(answer?.sources.map((doc) => doc.url)).toEqual([SOURCE.url]);
    expect(answer?.queries).toEqual(['gta home services market size 2026']);
    // Points and dropped stay empty on purpose: they are Verified mode's shape,
    // and a fast run genuinely produces none. Filling them would file one kind
    // of refusal under another kind's name.
    expect(answer?.points).toEqual([]);
    expect(answer?.dropped).toEqual([]);
  });

  it('stores the pipeline’s own reason when it wrote no prose at all', async () => {
    const silent: StreamAnswerFn = async () => ({
      text: '',
      costCents: 1,
      note: 'The documents carried nothing quotable for this question.',
    });
    const { frames, sink } = recorder();
    const d = deps({ streamAnswer: silent });
    await runAnswerStream(sink, ASK, d);

    // A blank body is refused by `appendMessage`, and a refused append would
    // abort the turn and lose the question with it.
    expect(d.store.messages[1]?.body).toContain('nothing quotable');
    expect(frames.at(-1)?.event).toBe('done');
  });

  it('continues an existing thread instead of starting a second one', async () => {
    const d = deps();
    await runAnswerStream(recorder().sink, ASK, d);
    const threadId = d.store.threads[0]?.id ?? '';

    await runAnswerStream(recorder().sink, { question: 'And in Vancouver?', threadId }, d);
    expect(d.store.threads).toHaveLength(1);
    expect(d.store.messages).toHaveLength(4);
    expect(d.store.messages.every((m) => m.threadId === threadId)).toBe(true);
  });

  it('says so when the thread is gone rather than silently starting a new one', async () => {
    const { frames, sink } = recorder();
    const d = deps();
    await runAnswerStream(sink, { question: ASK.question, threadId: 'no-such-thread' }, d);
    expect(frames.map((f) => f.event)).toEqual(['error_msg']);
    expect(d.store.threads).toHaveLength(0);
  });
});

/* ── conversation history ───────────────────────────────────────────────── */

const CITE: CitationRecord = {
  ordinal: 1,
  sourceUrl: 'https://example.ca/report',
  span: 'the market grew 12% in 2025',
  title: 'GTA home services 2026',
};

let mid = 0;
const msg = (over: Partial<MessageRecord>): MessageRecord => ({
  id: `m-${++mid}`,
  threadId: 't-1',
  seq: mid,
  role: 'user',
  body: 'q',
  mode: null,
  runId: null,
  costCents: 0,
  answer: null,
  createdAt: '2026-08-31T12:00:00.000Z',
  citations: [],
  ...over,
});

const answered = (body: string, over: Partial<MessageRecord> = {}): MessageRecord =>
  msg({ role: 'assistant', mode: 'fast', body, ...over });

const detail = (messages: readonly MessageRecord[]): ThreadDetail => ({
  id: 't-1',
  title: 'a thread',
  titleSource: 'question',
  forkedFromMessageId: null,
  createdAt: '2026-08-31T12:00:00.000Z',
  updatedAt: '2026-08-31T12:00:00.000Z',
  archivedAt: null,
  messages,
});

describe('historyFor', () => {
  it('pairs each question with the answer that followed it, oldest first', () => {
    const turns = historyFor(
      detail([
        msg({ body: 'How large is the GTA market?' }),
        answered('About $2bn [1].'),
        msg({ body: 'And in Vancouver?' }),
        answered('Smaller [1].'),
      ]),
    );
    expect(turns.map((t) => t.question)).toEqual(['How large is the GTA market?', 'And in Vancouver?']);
    expect(turns.map((t) => t.answer)).toEqual(['About $2bn [1].', 'Smaller [1].']);
  });

  it('keeps the [N] markers in the answer it sends back', () => {
    // `events.ts` is explicit about this: "where did that price come from?" is
    // a question ABOUT the marker, and a history that stripped it cannot answer.
    const [turn] = historyFor(detail([msg({ body: 'q' }), answered('Jiffy charges $129 [2].')]));
    expect(turn?.answer).toContain('[2]');
  });

  it('carries the URLs that turn read, documents first, deduped', () => {
    const [turn] = historyFor(
      detail([
        msg({ body: 'q' }),
        answered('a [1].', {
          answer: {
            points: [],
            dropped: [],
            unanswered: [],
            sources: [{ url: 'https://example.ca/report', title: 't', text: 'x' }],
            queries: [],
          },
          citations: [CITE, { ...CITE, ordinal: 2, sourceUrl: 'https://other.ca/p' }],
        }),
      ]),
    );
    // A follow-up on the same subject should not re-search from nothing.
    expect(turn?.sourceUrls).toEqual(['https://example.ca/report', 'https://other.ca/p']);
  });

  it('drops a question whose run died rather than reporting it answered with silence', () => {
    const turns = historyFor(
      detail([msg({ body: 'first' }), answered('an answer'), msg({ body: 'crashed' })]),
    );
    expect(turns.map((t) => t.question)).toEqual(['first']);
  });

  it('keeps a contiguous SUFFIX when the thread is long — never a hole in the middle', () => {
    const messages: MessageRecord[] = [];
    for (let i = 1; i <= 9; i += 1) {
      messages.push(msg({ body: `q${i}` }), answered(`a${i}`));
    }
    const turns = historyFor(detail(messages));

    expect(turns).toHaveLength(6);
    // The newest six, adjacent and in order. A sampled or head-plus-tail
    // history still reads as a conversation and is a different one.
    expect(turns.map((t) => t.question)).toEqual(['q4', 'q5', 'q6', 'q7', 'q8', 'q9']);
  });

  it('drops from the oldest end when the text budget binds, before the turn count does', () => {
    const long = 'x'.repeat(5_000);
    const messages: MessageRecord[] = [];
    for (let i = 1; i <= 4; i += 1) messages.push(msg({ body: `q${i}` }), answered(`${long}${i}`));

    const turns = historyFor(detail(messages));
    expect(turns.length).toBeLessThan(4);
    expect(turns.at(-1)?.question).toBe('q4');
    // Whatever survived is still adjacent: the kept questions are the tail.
    const kept = turns.map((t) => t.question);
    expect(kept).toEqual(['q1', 'q2', 'q3', 'q4'].slice(-kept.length));
  });

  it('sends the newest turn whole even when it alone exceeds the budget', () => {
    const huge = 'x'.repeat(40_000);
    const turns = historyFor(detail([msg({ body: 'q' }), answered(huge)]));
    // Half an answer is not a shorter answer — it is a different one, missing
    // exactly the markers a follow-up is usually about.
    expect(turns).toHaveLength(1);
    expect(turns[0]?.answer).toHaveLength(40_000);
  });

  it('is empty for a thread nobody has answered in yet', () => {
    expect(historyFor(detail([]))).toEqual([]);
    expect(historyFor(detail([msg({ body: 'only a question' })]))).toEqual([]);
  });
});

describe('runAnswerStream — the follow-up gets the thread', () => {
  it('passes no history on the first question and the prior turn on the second', async () => {
    const seen: { question: string; history: readonly { question: string; answer: string }[] }[] = [];
    const spy: StreamAnswerFn = async (q, dep) => {
      seen.push({ question: q, history: dep.history });
      return happyStream(q, dep);
    };
    const d = deps({ streamAnswer: spy });

    await runAnswerStream(recorder().sink, ASK, d);
    const threadId = d.store.threads[0]?.id ?? '';
    await runAnswerStream(recorder().sink, { question: 'And in Vancouver?', threadId }, d);

    expect(seen[0]?.history).toEqual([]);
    expect(seen[1]?.history).toEqual([
      {
        question: ASK.question,
        answer: 'The market grew 12% [1]. Supply is thinner in the east.',
        sourceUrls: [SOURCE.url],
      },
    ]);
  });

  it('loads the history BEFORE recording the new question, so it is not in its own context', async () => {
    const asked: string[][] = [];
    const spy: StreamAnswerFn = async (q, dep) => {
      asked.push(dep.history.map((h) => h.question));
      return happyStream(q, dep);
    };
    const d = deps({ streamAnswer: spy });
    await runAnswerStream(recorder().sink, ASK, d);
    const threadId = d.store.threads[0]?.id ?? '';
    await runAnswerStream(recorder().sink, { question: 'And in Vancouver?', threadId }, d);

    // The follow-up sees the turn before it and not itself — the user message
    // is appended after the history is read, and a history containing the
    // question being asked would make every follow-up look like a repeat.
    expect(asked[1]).toEqual([ASK.question]);
  });
});

/* ── the epilogue frame ─────────────────────────────────────────────────── */

describe('epilogueFor', () => {
  it('says nothing when there is nothing to say', () => {
    expect(epilogueFor({ text: 'a', costCents: 1 })).toBeNull();
    expect(epilogueFor({ text: 'a', costCents: 1, unanswered: [], note: '  ', related: [] })).toBeNull();
  });

  it('carries the refusals the done event could not', () => {
    // Annotated, because this shape is the thing the UI agent codes against —
    // if it drifts, this line is what stops it drifting silently.
    const e: EpilogueEvent | null = epilogueFor({
      text: 'a',
      costCents: 1,
      unanswered: ['what Jiffy charges in Vancouver', '  '],
      note: '',
    });
    expect(e).toEqual({ unanswered: ['what Jiffy charges in Vancouver'], note: '', related: [] });
  });

  it('relays related questions and invents none', () => {
    expect(epilogueFor({ text: 'a', costCents: 1, related: ['What does Jiffy charge?'] })?.related).toEqual([
      'What does Jiffy charge?',
    ]);
    // The pipeline returns none today. Emitting a plausible list here would be
    // the console generating ungrounded text under a derived-looking heading.
    expect(epilogueFor({ text: 'a', costCents: 1, unanswered: ['x'] })?.related).toEqual([]);
  });
});

describe('runAnswerStream — the epilogue on the wire', () => {
  const rich: StreamAnswerFn = async (q, dep) => ({
    ...(await happyStream(q, dep)),
    unanswered: ['what Jiffy charges in Vancouver'],
    related: ['How fast is Jiffy growing?'],
  });

  it('emits epilogue immediately before done, once', async () => {
    const { frames, sink } = recorder();
    await runAnswerStream(sink, ASK, deps({ streamAnswer: rich }));

    const names = frames.map((f) => f.event);
    expect(names.filter((n) => n === 'epilogue')).toHaveLength(1);
    expect(names.at(-2)).toBe('epilogue');
    expect(names.at(-1)).toBe('done');
    expect(frames.at(-2)?.data).toEqual({
      unanswered: ['what Jiffy charges in Vancouver'],
      note: '',
      related: ['How fast is Jiffy growing?'],
    });
  });

  it('leaves done exactly as the contract froze it', async () => {
    const { frames, sink } = recorder();
    await runAnswerStream(sink, ASK, deps({ streamAnswer: rich }));
    expect(Object.keys(frames.at(-1)?.data as object).sort()).toEqual([
      'costCents',
      'flagged',
      'messageId',
      'threadId',
    ]);
  });

  it('sends no epilogue when the run had no refusals and no related questions', async () => {
    const { frames, sink } = recorder();
    await runAnswerStream(sink, ASK, deps());
    expect(frames.map((f) => f.event)).not.toContain('epilogue');
  });

  it('explains an empty answer, which is the case with nothing else on screen', async () => {
    const silent: StreamAnswerFn = async () => ({
      text: '',
      costCents: 1,
      note: 'No search results. The providers returned nothing for those queries.',
    });
    const { frames, sink } = recorder();
    await runAnswerStream(sink, ASK, deps({ streamAnswer: silent }));

    const epilogue = frames.at(-2);
    expect(epilogue?.event).toBe('epilogue');
    expect((epilogue?.data as { note: string }).note).toContain('No search results');
  });
});
