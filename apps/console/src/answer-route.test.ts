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
  ClarifyEvent,
  PlanEvent,
  ReadPort,
  ReflectEvent,
  SearchPort,
  SourceEvent,
  SpanEvent,
  StepEvent,
} from '@tmos/research';
import { DEEP_EVENTS } from '@tmos/research';
import type { BudgetLimits } from '@tmos/shared';
import type {
  CitationRecord,
  MessageRecord,
  NewMessage,
  NewThread,
  ThreadDetail,
  ThreadRecord,
} from '@tmos/adapters';
import { rowToMessage } from '@tmos/adapters';

import {
  AnswerBusy,
  AnswerGuard,
  answerKey,
  citationsFor,
  clarifyBody,
  DEEP_ANSWER,
  epilogueFor,
  estimatedCostCentsFor,
  GROUNDED_ANSWER,
  groundedRunner,
  historyFor,
  MAX_CLARIFICATIONS,
  parseClarifications,
  parseMode,
  RESOLVE_FOLLOW_UP,
  runAnswerStream,
  titleFor,
  unusedFor,
  userBodyFor,
  verifiedRunner,
  type AnswerDeps,
  type AnswerStore,
  type DeepAnswerDeps,
  type DeepAnswerFn,
  type EpilogueEvent,
  type GroundedAnswerFn,
  type ResolveFollowUpFn,
  type StreamAnswerFn,
  type UnusedEvent,
} from './answer-route.js';
import type { ConversationTurn, GroundedRecord, GroundedUniverse } from '@tmos/research';
import { groundedUniverse } from '@tmos/research';
import type { GroundedEvidence } from './grounded-retrieval.js';
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

/* ── mode routing ───────────────────────────────────────────────────────── */

describe('parseMode', () => {
  it('defaults to web, which is what every request sent before modes existed', () => {
    expect(parseMode(null)).toBe('web');
    expect(parseMode('')).toBe('web');
    expect(parseMode('web')).toBe('web');
  });

  it('reads the two new modes, case and whitespace insensitive', () => {
    expect(parseMode(' Grounded ')).toBe('grounded');
    expect(parseMode('VERIFIED')).toBe('verified');
  });

  it('falls back to web for a mode it does not know rather than erroring', () => {
    // A mode rides in a query string, and a query string is a link somebody may
    // have kept. Refusing an old link is worse than answering it the usual way.
    expect(parseMode('deep-research')).toBe('web');
  });
});

describe('runAnswerStream — the mode decides the pipeline', () => {
  const tagged = (tag: string): StreamAnswerFn => async () => ({ text: `${tag} answer`, costCents: 1 });

  it('sends a web question to the streaming pipeline', async () => {
    const d = deps({ groundedAnswer: tagged('grounded'), verifiedAnswer: tagged('verified') });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'web' }, d);
    expect(d.store.messages[1]?.body).toContain('The market grew 12%');
  });

  it('sends a grounded question to the grounded runner and never to the web one', async () => {
    let web = 0;
    const d = deps({
      streamAnswer: async (q, x) => {
        web += 1;
        return happyStream(q, x);
      },
      groundedAnswer: tagged('grounded'),
    });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'grounded' }, d);

    expect(web).toBe(0);
    expect(d.store.messages[1]?.body).toBe('grounded answer');
  });

  it('sends a verified question to the strict pipeline and records the mode on the row', async () => {
    const d = deps({ verifiedAnswer: tagged('verified') });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'verified' }, d);

    expect(d.store.messages[1]?.body).toBe('verified answer');
    // The column has carried only 'fast' since threads existed. Verified mode
    // being unreachable is why, and cost-per-mode is unanswerable without it.
    expect(d.store.messages[1]?.mode).toBe('verified');
  });

  it('stores a grounded turn as `fast`, because the DECODER cannot yet read it', async () => {
    // Migration 016 widened the check constraint to
    // ('fast','verified','grounded'), applied and verified against the live
    // database, and `AnswerMode`/`MODES` in the store were widened with it.
    // Both halves had to land, and in that order — see `messageMode`.
    const d = deps({ groundedAnswer: tagged('grounded') });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'grounded' }, d);
    expect(d.store.messages[1]?.mode).toBe('grounded');
  });

  it('a grounded row now survives the round trip it used to die on', () => {
    // THE ORDER THIS PINS. `rowToMessage` decodes `mode` through `asUnion`,
    // which THROWS on an unlisted value — and `getThread` is what renders a
    // thread AND what `historyFor` reads a follow-up's context from. So before
    // the store was widened, a 'grounded' row inserted cleanly and then failed
    // on every read, making its own thread permanently unreadable: strictly
    // worse than the mislabelling it fixed. Widen the reader, ship it, THEN
    // write the value.
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      thread_id: '00000000-0000-4000-8000-000000000002',
      seq: 2,
      role: 'assistant',
      body: 'Jiffy jobs start at $129 [1].',
      mode: 'grounded',
      run_id: 'run-1',
      cost_cents: '0.036',
      answer: null,
      created_at: '2026-08-31T12:00:00.000Z',
    };
    expect(rowToMessage(row).mode).toBe('grounded');
    expect(rowToMessage({ ...row, mode: 'fast' }).mode).toBe('fast');
    // Still closed, though — the union is a gate, not a passthrough.
    expect(() => rowToMessage({ ...row, mode: 'deep-research' })).toThrow(/not one of/);
  });

  it('refuses a mode with no runner by name, before a thread or a cent', async () => {
    const { frames, sink } = recorder();
    const d = deps();
    await runAnswerStream(sink, { ...ASK, mode: 'grounded' }, d);

    expect(frames.map((f) => f.event)).toEqual(['error_msg']);
    expect(String(frames[0]?.data)).toContain('grounded mode is not available');
    // Silently answering in web mode would tell somebody who asked what WE know
    // that the open web's answer was ours.
    expect(d.store.threads).toHaveLength(0);
  });
});

/* ── grounded mode ──────────────────────────────────────────────────────── */

const FACT: GroundedRecord = {
  type: 'world_fact',
  id: 'fact-1',
  title: 'Jiffy — price_min',
  url: 'https://jiffy.ca/pricing',
  snippet: 'Jobs start at $129 for a two-hour visit.',
  observedAt: '2026-08-20',
};

const PASSAGE: GroundedRecord = {
  type: 'brain_passage',
  id: 'c-1',
  title: '60-business/PRICING_v3.md',
  path: '60-business/PRICING_v3.md',
  heading: 'Commission',
  text: 'Commission is 20%, HST-inclusive.',
  right: 'grounds',
  reviewed: '2026-08-01',
};

/** A finding we withdrew. `bindGrounded` refuses it — it COULD have been
 *  evidence and failed a check, which is exactly what `dropped` means. */
const WITHDRAWN: GroundedRecord = {
  type: 'finding',
  id: 'f-9',
  title: 'Jiffy raised its minimum',
  sourceUrl: 'https://jiffy.ca/pricing',
  span: 'The minimum visit is now $149.',
  observedAt: '2026-08-10',
  superseded: true,
};

/** A forecast. Never citable, and deliberately NOT a refusal: it never entered
 *  the contest `dropped` records the outcome of. */
const FORECAST: GroundedRecord = {
  type: 'forecast',
  id: 'p-3',
  title: 'Jiffy enters Hamilton by Q1',
  locator: 'prediction · p-3',
  claim: 'Jiffy enters Hamilton by Q1',
  p: 0.4,
  resolveAt: '2027-03-31',
};

const EVIDENCE: GroundedEvidence = {
  records: [FACT, PASSAGE],
  terms: ['jiffy', 'price'],
  entities: ['Jiffy'],
  excluded: [],
};

/** Quotable evidence, one refusal and one forecast — the run that has something
 *  to say in every group the reader is shown. */
const MIXED_EVIDENCE: GroundedEvidence = {
  records: [FACT, WITHDRAWN, FORECAST],
  terms: ['jiffy'],
  entities: ['Jiffy'],
  excluded: [],
};

/** Nothing quotable, and the reason is the refusals — the case where the
 *  `unused` frame is the entire explanation of an empty screen. */
const REFUSED_EVIDENCE: GroundedEvidence = {
  records: [WITHDRAWN, FORECAST],
  terms: ['jiffy'],
  entities: ['Jiffy'],
  excluded: [],
};

const EMPTY_EVIDENCE: GroundedEvidence = {
  records: [],
  terms: ['snow'],
  entities: [],
  excluded: ['no world-model facts: the question names no company we hold facts about'],
};

/** Ports that make a network call a test failure rather than a live request. */
const FORBIDDEN_PORTS = {
  ask: PORTS.ask,
  askStream: PORTS.askStream,
  search: [
    {
      name: 'tavily',
      search: (): never => {
        throw new Error('grounded mode reached a search provider');
      },
    },
  ] as readonly SearchPort[],
  read: {
    read: (): never => {
      throw new Error('grounded mode fetched a page');
    },
  } as ReadPort,
};

function groundedRelay(): { events: { event: string; data: unknown }[]; deps: Parameters<StreamAnswerFn>[1] } {
  const events: { event: string; data: unknown }[] = [];
  const push = (event: string) => (data: unknown) => {
    events.push({ event, data });
  };
  return {
    events,
    deps: {
      ...FORBIDDEN_PORTS,
      history: [],
      onStatus: push('status'),
      onSource: push('source'),
      onSpan: push('span'),
      onDelta: push('delta'),
      onSentence: push('sentence'),
      onUnused: push('unused'),
    },
  };
}

/** The same relay, with a conversation behind it. Grounded mode is allowed to
 *  resolve a follow-up against this and nothing else. */
function groundedRelayWith(history: readonly ConversationTurn[]): ReturnType<typeof groundedRelay> {
  const r = groundedRelay();
  return { events: r.events, deps: { ...r.deps, history } };
}

describe('groundedRunner', () => {
  it('never reaches a search provider or fetches a page', async () => {
    const { deps: dep } = groundedRelay();
    const run = groundedRunner(
      async () => EVIDENCE,
      async () => ({ text: 'Jiffy starts at $129 [1].', costCents: 2 }),
    );
    // The ports throw if touched: "grounded mode does not search" has to be
    // structural, because a fallback to the web would answer a different
    // question wearing this mode's badge.
    await expect(run('What do we know about Jiffy?', dep)).resolves.toBeDefined();
  });

  it('never announces a search it did not run', async () => {
    const { events, deps: dep } = groundedRelay();
    await groundedRunner(async () => EVIDENCE, async () => ({ text: 'a [1].', costCents: 1 }))(
      'What do we know about Jiffy?',
      dep,
    );
    const phases = events.filter((e) => e.event === 'status').map((e) => (e.data as { phase: string }).phase);
    expect(phases).not.toContain('searching');
    expect(phases[0]).toBe('reading');
  });

  it('puts every internal source on the wire, numbered, before any span', async () => {
    const { events, deps: dep } = groundedRelay();
    await groundedRunner(
      async () => EVIDENCE,
      async () => ({ text: 'Jiffy starts at $129 [1].', costCents: 2 }),
    )('What do we know about Jiffy?', dep);

    const names = events.map((e) => e.event);
    expect(names.indexOf('source')).toBeLessThan(names.indexOf('span'));
    const sources = events.filter((e) => e.event === 'source').map((e) => e.data as { i: number; kind: string; observedAt?: string; url: string });
    expect(sources.map((s) => s.i)).toEqual([1, 2]);
    // `kind` is what tells the renderer what it is holding, and the Brain card
    // keeps its locator rather than being dressed up as a link.
    expect(sources.map((s) => s.kind)).toEqual(['world', 'brain']);
    expect(sources[1]?.url).toBe('60-business/PRICING_v3.md § Commission');
    expect(sources.map((s) => s.observedAt)).toEqual(['2026-08-20', '2026-08-01']);
    // Spans reach the wire before any prose, and every one is already proven.
    expect(events.filter((e) => e.event === 'span')).toHaveLength(2);
  });

  it('hands phase B a universe whose spans are already proven, and no records', async () => {
    const seen: GroundedUniverse[] = [];
    // Typed as the seam, so a change to what phase B is promised breaks here.
    const phaseB: GroundedAnswerFn = async (_q, d) => {
      seen.push(d.universe);
      return { text: 'a [1].', costCents: 1 };
    };
    const { deps: dep } = groundedRelay();
    await groundedRunner(async () => EVIDENCE, phaseB)('What do we know about Jiffy?', dep);

    // Phase A over our own evidence costs nothing: the spans were written down
    // the day they were verified, so no extraction pass is paid for.
    expect(seen[0]?.costCents).toBe(0);
    expect(seen[0]?.spans.map((s) => s.span)).toEqual([
      'Jobs start at $129 for a two-hour visit.',
      'Commission is 20%, HST-inclusive.',
    ]);
  });

  it('refuses when nothing matched, and does not call the answer half at all', async () => {
    let called = false;
    const { deps: dep } = groundedRelay();
    const result = await groundedRunner(
      async () => EMPTY_EVIDENCE,
      async () => {
        called = true;
        return { text: 'plausible prose', costCents: 1 };
      },
    )('How should we price snow removal?', dep);

    expect(called).toBe(false);
    expect(result.text).toBe('');
    // `groundedUniverse`'s own note, relayed rather than replaced: it separates
    // "we hold nothing on this" from "we hold things and none can be quoted".
    expect(result.note).toMatch(/no internal records/i);
    // The reader is told what was refused and why, not just that it is empty.
    expect(result.unanswered?.join(' ')).toMatch(/names no company/);
  });

  it('keeps the internal records as the retrieval record, with no queries', async () => {
    const { deps: dep } = groundedRelay();
    const result = await groundedRunner(async () => EVIDENCE, async () => ({ text: 'a [1].', costCents: 1 }))(
      'What do we know about Jiffy?',
      dep,
    );
    expect(result.sources?.map((s) => s.url)).toEqual([
      'https://jiffy.ca/pricing',
      '60-business/PRICING_v3.md § Commission',
    ]);
    expect(result.queries).toEqual([]);
  });
});

/* ── grounded mode: the refusals reach the wire ─────────────────────────── */

describe('unusedFor', () => {
  it('says nothing when phase A refused nothing and holds no forecast', () => {
    // Null, not an empty frame: "nothing was dropped" and "this run does not
    // report drops" are different sentences and the card prints both.
    expect(unusedFor(groundedUniverse('q', EVIDENCE.records))).toBeNull();
  });

  it('keeps a refusal and an expectation in separate lists', () => {
    const u = unusedFor(groundedUniverse('q', MIXED_EVIDENCE.records));
    expect(u?.dropped.map((d) => d.why).join(' ')).toMatch(/superseded by a correction/);
    // A forecast is NOT a refusal — it never entered the contest. Merging the
    // two would render an expectation under a heading that means "refused",
    // and selection is the only place that distinction can be enforced.
    expect(u?.expectations.map((e) => e.claim)).toEqual(['Jiffy enters Hamilton by Q1']);
    expect(u?.dropped.some((d) => d.span.includes('Hamilton'))).toBe(false);
  });
});

describe('groundedRunner — the refusals on the wire', () => {
  it('emits `unused` after the last span and before any prose', async () => {
    const { events, deps: dep } = groundedRelay();
    await groundedRunner(async () => MIXED_EVIDENCE, async (_q, d) => {
      d.onDelta({ n: 1, text: 'Jobs start at $129 [1].' });
      return { text: 'Jobs start at $129 [1].', costCents: 1 };
    })('What do we know about Jiffy?', dep);
    const names = events.map((e) => e.event);
    // The frame is a fact about the EVIDENCE, true the moment phase A ends, so
    // the reader gets it beside the source strip rather than a beat after the
    // answer — the same argument §3 makes for sources landing before prose.
    expect(names.filter((n) => n === 'unused')).toHaveLength(1);
    expect(names.lastIndexOf('span')).toBeLessThan(names.indexOf('unused'));
    expect(names.indexOf('unused')).toBeLessThan(names.indexOf('delta'));
  });

  it('sends the refusals when nothing could be quoted, which is when they are the whole story', async () => {
    const { events, deps: dep } = groundedRelayWith([]);
    const result = await groundedRunner(async () => REFUSED_EVIDENCE, async () => {
      throw new Error('phase B must not run against an empty universe');
    })('What do we know about Jiffy?', dep);

    const unused = events.find((e) => e.event === 'unused')?.data as UnusedEvent | undefined;
    expect(unused?.dropped).toHaveLength(1);
    expect(unused?.expectations).toHaveLength(1);
    // The note says the screen is empty; the frame says WHICH of our own rows
    // failed which check. Without it the run is indistinguishable from one that
    // matched nothing at all.
    expect(result.note).toMatch(/prediction ledger|nothing quotable/i);
  });

  it('emits no frame at all when there was nothing to refuse', async () => {
    const { events, deps: dep } = groundedRelay();
    await groundedRunner(async () => EVIDENCE, async () => ({ text: 'a [1].', costCents: 1 }))(
      'What do we know about Jiffy?',
      dep,
    );
    expect(events.some((e) => e.event === 'unused')).toBe(false);
  });

  it('reaches the browser as its own event, before done, and never on a web run', async () => {
    const { frames, sink } = recorder();
    const d = deps({
      groundedAnswer: groundedRunner(async () => MIXED_EVIDENCE, async () => ({ text: 'a [1].', costCents: 1 })),
    });
    await runAnswerStream(sink, { ...ASK, mode: 'grounded' }, d);
    const names = frames.map((f) => f.event);
    expect(names).toContain('unused');
    expect(names.indexOf('unused')).toBeLessThan(names.indexOf('done'));

    // The web pipeline is never handed this channel and must not grow one by
    // accident: no frame means "this mode does not report that", which is not
    // the same claim as "nothing was refused".
    const web = recorder();
    await runAnswerStream(web.sink, { ...ASK, mode: 'web' }, deps());
    expect(web.frames.some((f) => f.event === 'unused')).toBe(false);
  });
});

/* ── grounded mode: the follow-up finally resolves ──────────────────────── */

const PRIOR: ConversationTurn = {
  // The answer carries a claim with NO FIGURE in it, on purpose: that is the
  // sentence the per-sentence check cannot catch if it is ever copied forward,
  // and therefore the string worth watching for in phase B's deps.
  question: 'What do we know about Jiffy in Toronto?',
  answer: 'Jiffy is the larger of the two providers [1].',
  sourceUrls: ['https://jiffy.ca/pricing'],
};

/** A planner that rewrites, without a model. The route's own resolver is
 *  exercised separately below. */
const resolvesTo = (standalone: string, costCents = 0.02): ResolveFollowUpFn =>
  async () => ({ standalone, costCents, note: '' });

describe('groundedRunner — a follow-up is resolved before anything is retrieved', () => {
  it('retrieves against the standalone question, not the four words typed', async () => {
    const asked: string[] = [];
    const { deps: dep } = groundedRelayWith([PRIOR]);
    await groundedRunner(
      async (q) => {
        asked.push(q);
        return EVIDENCE;
      },
      async () => ({ text: 'a [1].', costCents: 1 }),
      resolvesTo('What do we know about Jiffy in Vancouver?'),
    )('and in Vancouver?', dep);

    // The reported failure: "and in Vancouver?" matched against our own rows by
    // term overlap retrieves nothing, because none of those four words is a
    // term. The resolution is what the retrieval was missing.
    expect(asked).toEqual(['What do we know about Jiffy in Vancouver?']);
  });

  it('hands phase B the standalone question and NOTHING of the conversation', async () => {
    const seen: { question: string; deps: Record<string, unknown> }[] = [];
    const phaseB: GroundedAnswerFn = async (question, d) => {
      seen.push({ question, deps: d as unknown as Record<string, unknown> });
      return { text: 'a [1].', costCents: 1 };
    };
    const { deps: dep } = groundedRelayWith([PRIOR]);
    await groundedRunner(async () => EVIDENCE, phaseB, resolvesTo('What do we know about Jiffy in Vancouver?'))(
      'and in Vancouver?',
      dep,
    );

    expect(seen[0]?.question).toBe('What do we know about Jiffy in Vancouver?');
    // THE RULE THAT DOES NOT BEND. History may reach the planner and never the
    // writer. A previous ANSWER in front of the generator is a sentence that
    // can be copied out, cited to a span retrieved this run, and confirmed —
    // the per-sentence check is blind to it because it carries no figure. The
    // shape is the defence: there is no field to put it in.
    expect(Object.keys(seen[0]?.deps ?? {})).not.toContain('history');
    expect(JSON.stringify(seen[0]?.deps ?? {})).not.toContain('larger of the two');
  });

  it('does not plan on a first question — there is nothing to resolve and it is not free', async () => {
    let planned = 0;
    const { events, deps: dep } = groundedRelay();
    await groundedRunner(
      async () => EVIDENCE,
      async () => ({ text: 'a [1].', costCents: 1 }),
      async (q) => {
        planned += 1;
        return { standalone: q, costCents: 0.02, note: '' };
      },
    )('What do we know about Jiffy?', dep);

    // The resolver is still consulted (it is the one place the rule lives), but
    // it must not spend: grounded mode costs a fifth of a web answer because
    // phase A is free, and a turn-one planning call would be most of the rest.
    expect(planned).toBe(1);
    const phases = events.filter((e) => e.event === 'status').map((e) => (e.data as { phase: string }).phase);
    expect(phases).not.toContain('planning');
    expect(phases).not.toContain('searching');
  });

  it('bills the planning call, so a follow-up is not cheaper on paper than it was', async () => {
    const { deps: dep } = groundedRelayWith([PRIOR]);
    const result = await groundedRunner(
      async () => EVIDENCE,
      async () => ({ text: 'a [1].', costCents: 1 }),
      resolvesTo('What do we know about Jiffy in Vancouver?', 0.05),
    )('and in Vancouver?', dep);
    expect(result.costCents).toBeCloseTo(1.05, 6);
  });

  it('says so when the follow-up could not be resolved, rather than answering thin and silent', async () => {
    const { deps: dep } = groundedRelayWith([PRIOR]);
    const result = await groundedRunner(
      async () => EMPTY_EVIDENCE,
      async () => ({ text: '', costCents: 0 }),
      async (q) => ({ standalone: q, costCents: 0, note: 'this follow-up was not resolved (the model was unavailable)' }),
    )('and in Vancouver?', dep);

    expect(result.unanswered?.join(' ')).toMatch(/not resolved/);
  });
});

describe('RESOLVE_FOLLOW_UP', () => {
  /** The planner's contract: JSON with a `standalone` field. */
  const planner = (standalone: string): { ask: AskPort; prompts: string[] } => {
    const prompts: string[] = [];
    return {
      prompts,
      ask: {
        ask: async (system: string, user: string) => {
          prompts.push(`${system}\n${user}`);
          return { text: JSON.stringify({ queries: ['ignored'], standalone, reuse: true }), costCents: 0.02 };
        },
      },
    };
  };

  it('never calls a model when there is no conversation to resolve against', async () => {
    const { ask, prompts } = planner('unused');
    const r = await RESOLVE_FOLLOW_UP('What do we know about Jiffy?', [], ask);
    expect(prompts).toEqual([]);
    expect(r).toEqual({ standalone: 'What do we know about Jiffy?', costCents: 0, note: '' });
  });

  it('resolves the follow-up against the conversation and reports what it cost', async () => {
    const { ask, prompts } = planner('What do we know about Jiffy in Vancouver?');
    const r = await RESOLVE_FOLLOW_UP('and in Vancouver?', [PRIOR], ask);
    expect(r.standalone).toBe('What do we know about Jiffy in Vancouver?');
    expect(r.costCents).toBeCloseTo(0.02, 6);
    // The transcript is what makes the rewrite possible, and this is the only
    // call in grounded mode that is allowed to see it.
    expect(prompts[0]).toContain('larger of the two');
  });

  it('falls back to the words as typed when the planner is unavailable, and names it', async () => {
    const dead: AskPort = { ask: async () => null };
    const r = await RESOLVE_FOLLOW_UP('and in Vancouver?', [PRIOR], dead);
    expect(r.standalone).toBe('and in Vancouver?');
    // Degrades, never fails — but the reader is told why the answer is thin.
    expect(r.note).toMatch(/not resolved against the conversation/);
  });
});

describe('the grounded seam, now closed', () => {
  /** A streamer that emits `text` and returns it whole — the shape
   *  `AskStreamPort` specifies, where the return value is the answer. */
  const streamer = (text: string): AskStreamPort => ({
    askStream: async (_s, _u, _m, onDelta) => {
      onDelta(text);
      return { text, costCents: 2 };
    },
  });

  const answerWith = (text: string, sink: Partial<Parameters<GroundedAnswerFn>[1]> = {}) =>
    GROUNDED_ANSWER('What do we know about Jiffy?', {
      ask: { ask: async () => ({ text: JSON.stringify({ questions: [] }), costCents: 0 }) },
      askStream: streamer(text),
      universe: groundedUniverse('What do we know about Jiffy?', EVIDENCE.records),
      excluded: [],
      onStatus: () => undefined,
      onDelta: () => undefined,
      onSentence: () => undefined,
      ...sink,
    });

  it('writes prose against the universe instead of refusing', async () => {
    // What stood here asserted the stub REFUSED, which was the honest thing to
    // ship while nothing could write against a grounded universe. Something can
    // now, so the assertion is the same question asked of a working pipeline:
    // does a marker that resolves come back confirmed?
    const verdicts: { verdict: string; why?: string }[] = [];
    const result = await answerWith('Jobs start at $129 for a two-hour visit [1].', {
      onSentence: (e) => void verdicts.push(e),
    });
    expect(result.text).toBe('Jobs start at $129 for a two-hour visit [1].');
    expect(verdicts).toEqual([{ n: 0, verdict: 'confirmed' }]);
  });

  it('runs the same phase C it runs on the web path', async () => {
    // The point of the whole design, asserted at the route boundary rather than
    // only inside the package: the badge means one thing, so a fabricated
    // marker never reaches the reader and its sentence flags — in grounded mode
    // exactly as in web mode.
    const verdicts: { verdict: string; why?: string }[] = [];
    const result = await answerWith('Jiffy also covers Hamilton [9].', {
      onSentence: (e) => void verdicts.push(e),
    });
    expect(result.text).not.toContain('[9');
    expect(verdicts[0]?.verdict).toBe('flagged');
    expect(verdicts[0]?.why).toContain('no span behind it');
  });

  it('reports a dead model call rather than storing a half-answer', async () => {
    // `PORTS.askStream` returns null. The run reaches `done` with a note and no
    // prose — the same shape the web path produces, and NOT an error frame: the
    // mode is built, so a failure here is a failed call and not a missing
    // feature. Those two must not look alike to a reader.
    const { frames, sink } = recorder();
    const d = deps({ groundedAnswer: groundedRunner(async () => EVIDENCE, GROUNDED_ANSWER) });
    await runAnswerStream(sink, { ...ASK, mode: 'grounded' }, d);

    expect(frames.at(-1)?.event).toBe('done');
    expect(frames.some((f) => f.event === 'error_msg')).toBe(false);
    const body = d.store.messages.at(-1)?.body ?? '';
    expect(body).toContain('stopped part-way');
  });
});

/* ── verified mode ──────────────────────────────────────────────────────── */

const DOC = { url: 'https://jiffy.ca/pricing', title: 'Jiffy pricing', text: 'Jobs start at $129 for a two-hour visit. We serve Toronto.' };

const researchAnswer = (over: Record<string, unknown> = {}) => ({
  question: 'q',
  summary: 'Jiffy is the market leader and is growing fast.',
  points: [
    { claim: 'Jiffy jobs start at $129.', citations: [{ url: DOC.url, span: 'Jobs start at $129 for a two-hour visit.' }] },
  ],
  dropped: [{ claim: 'Jiffy has 40% share', why: '"40" appears in the claim but in no cited span' }],
  unanswered: ['what Jiffy charges in Vancouver'],
  sources: [DOC],
  queries: ['jiffy pricing toronto'],
  costCents: 7,
  ...over,
});

describe('verifiedRunner', () => {
  it('stages the same events fast mode does, so one renderer handles both', async () => {
    const { events, deps: dep } = groundedRelay();
    await verifiedRunner(async () => researchAnswer())('q', { ...dep, ...PORTS });

    const names = events.map((e) => e.event);
    expect(names.indexOf('source')).toBeLessThan(names.indexOf('span'));
    expect(names.indexOf('span')).toBeLessThan(names.indexOf('delta'));
    expect(names.indexOf('delta')).toBeLessThan(names.indexOf('sentence'));
  });

  it('assembles the answer from the surviving claims and NEVER from the summary', async () => {
    const { deps: dep } = groundedRelay();
    const result = await verifiedRunner(async () => researchAnswer())('q', { ...dep, ...PORTS });

    expect(result.text).toBe('Jiffy jobs start at $129 [1].');
    // `summary` is the model's own prose and only the POINTS were gated. Putting
    // it on the wire would slip unchecked text into the mode whose whole promise
    // is that nothing unchecked is shown.
    expect(result.text).not.toContain('market leader');
  });

  it('carries the gate’s kept and refused claims into the stored payload', async () => {
    const d = deps({ verifiedAnswer: verifiedRunner(async () => researchAnswer()) });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'verified' }, d);

    const answer = d.store.messages[1]?.answer;
    expect(answer?.points).toHaveLength(1);
    expect(answer?.dropped?.[0]?.why).toContain('no cited span');
    expect(answer?.queries).toEqual(['jiffy pricing toronto']);
  });

  it('numbers one quote once even when two claims cite it', async () => {
    const { events, deps: dep } = groundedRelay();
    const span = 'Jobs start at $129 for a two-hour visit.';
    await verifiedRunner(async () =>
      researchAnswer({
        points: [
          { claim: 'Jiffy jobs start at $129.', citations: [{ url: DOC.url, span }] },
          { claim: 'A visit is two hours.', citations: [{ url: DOC.url, span }] },
        ],
      }),
    )('q', { ...dep, ...PORTS });

    expect(events.filter((e) => e.event === 'span')).toHaveLength(1);
  });

  it('runs the per-sentence check rather than assuming the gate agreed with it', async () => {
    // A figure with no span behind it must flag here even though `research()`
    // handed the point over as kept — two gates under one badge is how a badge
    // stops meaning anything. This also brings the causal lint, which
    // `research()` has never run, to Verified mode.
    const { events, deps: dep } = groundedRelay();
    const result = await verifiedRunner(async () =>
      researchAnswer({
        points: [
          { claim: 'Jiffy holds 40% of the market.', citations: [{ url: DOC.url, span: 'Jobs start at $129 for a two-hour visit.' }] },
        ],
      }),
    )('q', { ...dep, ...PORTS });

    const verdicts = events.filter((e) => e.event === 'sentence').map((e) => e.data as { verdict: string });
    expect(verdicts.map((v) => v.verdict)).toEqual(['flagged']);
    expect(result.flagged).toBe(1);
  });

  it('explains an empty verified answer in its own words, not the model’s', async () => {
    const { deps: dep } = groundedRelay();
    const result = await verifiedRunner(async () => researchAnswer({ points: [] }))('q', { ...dep, ...PORTS });

    expect(result.text).toBe('');
    // The stored body is this note. `summary` here reads as a confident,
    // uncited answer — the "empty answer replayed as a lie" bug, restated.
    expect(result.note).toContain('Verified mode kept nothing');
    expect(result.note).not.toContain('market leader');
  });
});

/* ── a grounded turn must not poison a later web follow-up ──────────────── */

describe('historyFor — internal locators are not pages', () => {
  it('carries only fetchable URLs forward, never a Brain path or a ledger row', () => {
    const [turn] = historyFor(
      detail([
        msg({ body: 'What do we know about Jiffy?' }),
        answered('Jiffy starts at $129 [1].', {
          answer: {
            points: [],
            dropped: [],
            unanswered: [],
            sources: [
              { url: 'https://jiffy.ca/pricing', title: 'p', text: 'x' },
              { url: '60-business/PRICING_v3.md § Commission', title: 'b', text: 'y' },
            ],
            queries: [],
          },
          citations: [{ ...CITE, sourceUrl: 'finding · f-1' }],
        }),
      ]),
    );
    // The follow-up planner hands this list to the reader as pages to re-read.
    // A locator would be fetched, fail, and spend a page of the run's budget.
    expect(turn?.sourceUrls).toEqual(['https://jiffy.ca/pricing']);
  });
});

/* ══ PART 7b — DEEP RESEARCH ═══════════════════════════════════════════════
 *
 * Five things are worth proving here, and each is a way this mode can go wrong
 * that no other mode can:
 *
 *  1. **The four contract events reach the wire unchanged.** `plan`, `step`,
 *     `reflect` and `clarify` are `events.ts`'s, not this route's, so the only
 *     defensible relay is one that renames and reshapes nothing.
 *  2. **The clarify round trip.** The stream ends when the pipeline asks, so
 *     the questions have to survive in the thread and the replies have to come
 *     back positionally without sliding onto the wrong question.
 *  3. **The budget.** A minutes-long mode admitted on a 30-second mode's
 *     estimate is a ceiling that gets consulted and then exceeded.
 *  4. **`message.mode` cannot say 'deep'.** Pinned, so the gap stays visible
 *     and nobody closes it in the order that corrupts a thread.
 *  5. **The seam rejects.** Not "returns something plausible".
 */

const DEEP_LIMITS: BudgetLimits = {
  maxRunTokens: 100_000,
  maxDailyCostCents: 2_000,
  maxToolDepth: 8,
};

const PLAN: PlanEvent = {
  steps: [
    { n: 1, question: 'What does Jiffy charge in Toronto?', why: 'the comparison rests on it' },
    { n: 2, question: 'What does TaskRabbit charge?', why: 'the other half of the comparison' },
  ],
};
const STEP: StepEvent = { n: 1, state: 'done', detail: 'read 9 pages', found: 2 };
const REFLECT: ReflectEvent = {
  after: 1,
  stillOpen: ['what TaskRabbit charges'],
  note: 'one side of the comparison is proven',
  stop: undefined,
};
const CLARIFY: ClarifyEvent = {
  questions: ['Which city?', 'Over what period?'],
  because: 'the question spans a market and a time window and neither is named',
};

/** A deep pipeline that shows its work, then answers. No model, no network. */
const deepStream: DeepAnswerFn = async (q, dep) => {
  dep.onPlan(PLAN);
  dep.onStep({ n: 1, state: 'running' });
  dep.onStep(STEP);
  dep.onReflect(REFLECT);
  return happyStream(q, dep);
};

/** A deep pipeline that stops before retrieving anything to ask what the
 *  question means — the whole point of a PRE-retrieval gate. */
const clarifyingStream = (e: ClarifyEvent = CLARIFY): DeepAnswerFn => async (_q, dep) => {
  dep.onClarify(e);
  return { text: '', costCents: 0.04 };
};

describe('parseMode — deep', () => {
  it('reads deep, case and whitespace insensitive', () => {
    expect(parseMode('deep')).toBe('deep');
    expect(parseMode('  DEEP ')).toBe('deep');
  });

  it('still refuses to guess at a near miss', () => {
    // `deep-research` was already asserted to fall back to web, and it must
    // keep doing so: a mode is an exact word, and a near miss silently routed
    // to a minutes-long paid pipeline is the wrong direction to guess in.
    expect(parseMode('deep-research')).toBe('web');
    expect(parseMode('deeper')).toBe('web');
  });
});

describe('parseClarifications', () => {
  it('keeps an interior blank in place — the numbers are the addressing', () => {
    // THE BUG THIS EXISTS TO PREVENT. `ClarifyEvent` carries no ids, so an
    // answer is identified by its position. Dropping the skipped second answer
    // would slide the third onto question 2: a perfectly well-formed set of
    // answers to a different set of questions, invisible to every layer below.
    expect(parseClarifications(['Toronto', '', 'last 12 months'])).toEqual([
      'Toronto',
      '',
      'last 12 months',
    ]);
  });

  it('drops trailing blanks, which are questions nobody reached', () => {
    expect(parseClarifications(['Toronto', '', ''])).toEqual(['Toronto']);
    expect(parseClarifications(['', ''])).toEqual([]);
    expect(parseClarifications([])).toEqual([]);
  });

  it('caps the count and the length — this is untrusted text in a URL', () => {
    expect(parseClarifications(Array.from({ length: 40 }, () => 'x'))).toHaveLength(MAX_CLARIFICATIONS);
    expect(parseClarifications([' '.repeat(3) + 'y'.repeat(900)])[0]).toHaveLength(500);
  });
});

describe('the four deep events reach the wire, unchanged', () => {
  it('relays plan, step and reflect under the contract’s own names', async () => {
    const { frames, sink } = recorder();
    await runAnswerStream(sink, { ...ASK, mode: 'deep' }, deps({ deepAnswer: deepStream }));

    const names = frames.map((f) => f.event);
    expect(names).toContain('plan');
    expect(names).toContain('step');
    expect(names).toContain('reflect');
    // Every deep frame name is one `events.ts` declares. If the contract grows
    // a fifth event or renames one, this is what notices.
    const deepFrames = frames.filter((f) => (DEEP_EVENTS as readonly string[]).includes(f.event));
    expect(deepFrames.map((f) => f.event)).toEqual(['plan', 'step', 'step', 'reflect']);
  });

  it('sends the payloads verbatim — the route composes nothing', async () => {
    const { frames, sink } = recorder();
    await runAnswerStream(sink, { ...ASK, mode: 'deep' }, deps({ deepAnswer: deepStream }));

    // Deep equality against the objects the pipeline emitted. A route that
    // helpfully added a field would be a second contract, held by one of the
    // three pieces that were written against one.
    expect(frames.find((f) => f.event === 'plan')?.data).toEqual(PLAN);
    expect(frames.filter((f) => f.event === 'step').at(-1)?.data).toEqual(STEP);
    // `stop: undefined` does not survive JSON, and that is the contract's own
    // encoding: absent means the run did not stop.
    expect(frames.find((f) => f.event === 'reflect')?.data).toEqual({
      after: 1,
      stillOpen: ['what TaskRabbit charges'],
      note: 'one side of the comparison is proven',
    });
  });

  it('publishes the plan before the first step, which is the whole point', async () => {
    const { frames, sink } = recorder();
    await runAnswerStream(sink, { ...ASK, mode: 'deep' }, deps({ deepAnswer: deepStream }));
    const names = frames.map((f) => f.event);
    // A reader has to be able to abandon a run that is going wrong at minute
    // one rather than discovering it at minute four.
    expect(names.indexOf('plan')).toBeLessThan(names.indexOf('step'));
    expect(names.indexOf('step')).toBeLessThan(names.indexOf('reflect'));
  });

  it('never emits one on a web run', async () => {
    const { frames, sink } = recorder();
    await runAnswerStream(sink, ASK, deps());
    for (const name of DEEP_EVENTS) expect(frames.some((f) => f.event === name)).toBe(false);
  });
});

describe('the clarify round trip — the run that asks instead of answering', () => {
  it('puts the questions on the wire and still ends with done', async () => {
    const { frames, sink } = recorder();
    const d = deps({ deepAnswer: clarifyingStream() });
    await runAnswerStream(sink, { ...ASK, mode: 'deep' }, d);

    expect(frames.find((f) => f.event === 'clarify')?.data).toEqual(CLARIFY);
    // `done` is not decoration here: it carries the threadId, and the replies
    // arrive as a NEW request that has to name the thread it is answering in.
    // A stream that just stopped would strand the round trip at step one.
    const done = frames.at(-1);
    expect(done?.event).toBe('done');
    expect((done?.data as { threadId: string }).threadId).toBe(d.store.threads[0]?.id);
  });

  it('persists the questions as the assistant turn, numbered as they were asked', async () => {
    const d = deps({ deepAnswer: clarifyingStream() });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'deep' }, d);

    const body = d.store.messages[1]?.body ?? '';
    expect(body).toContain('1. Which city?');
    expect(body).toContain('2. Over what period?');
    expect(body).toContain('spans a market and a time window');
    // NOT the generic empty-answer line. That sentence says documents were read
    // and carried nothing; this run stopped before reading anything, and a
    // confident account of something that did not happen is the exact failure
    // this system is organised against.
    expect(body).not.toContain('nothing quotable');
  });

  it('leaves a readable turn rather than a thread that looks like a crash', async () => {
    const d = deps({ deepAnswer: clarifyingStream() });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'deep' }, d);

    // A question with no assistant turn is what a died-halfway run leaves, and
    // `historyFor` drops it rather than report it answered with silence. An
    // abandoned clarify must not arrive wearing that shape.
    expect(d.store.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const turns = historyFor((await d.store.getThread(d.store.threads[0]?.id ?? ''))!);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.answer).toContain('Which city?');
    // Nothing was retrieved, so nothing is cited and nothing is claimed.
    expect(d.store.messages[1]?.citations ?? []).toEqual([]);
  });

  it('numbers a blank question rather than closing the gap', () => {
    const body = clarifyBody({ questions: ['Which city?', '', 'Over what period?'], because: '' });
    // The reader answers positionally. Renumbering to tidy the display would
    // misaddress every answer after the gap.
    expect(body).toContain('1. Which city?');
    expect(body).toContain('3. Over what period?');
  });

  it('says what happened when the pipeline asked with no questions in hand', () => {
    const body = clarifyBody({ questions: [], because: 'the question names no market' });
    expect(body).toContain('the question names no market');
    expect(body).not.toContain('1.');
  });

  it('records the prose when a pipeline asked and then answered anyway', async () => {
    const both: DeepAnswerFn = async (q, dep) => {
      dep.onClarify(CLARIFY);
      return happyStream(q, dep);
    };
    const d = deps({ deepAnswer: both });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'deep' }, d);
    // The contract says the stream ends after a clarify. If one does not, the
    // reader read an answer, and the thread must store what the reader read.
    expect(d.store.messages[1]?.body).toContain('The market grew 12%');
  });
});

describe('the clarify round trip — the replies coming back', () => {
  const REPLIES = ['Toronto', '', 'the last 12 months'];

  it('hands the replies to the pipeline as answers, never as the question', async () => {
    const seen: { question: string; clarifications: readonly string[] }[] = [];
    const spy: DeepAnswerFn = async (question, dep) => {
      seen.push({ question, clarifications: dep.clarifications });
      return happyStream(question, dep);
    };
    await runAnswerStream(
      recorder().sink,
      { ...ASK, mode: 'deep', clarifications: REPLIES },
      deps({ deepAnswer: spy }),
    );

    expect(seen[0]?.clarifications).toEqual(REPLIES);
    // The question the run answers stays the question the reader typed. Folded
    // in, "Toronto" becomes a phrase the writer sees and the run is answering
    // something nobody asked.
    expect(seen[0]?.question).toBe(ASK.question);
    expect(seen[0]?.question).not.toContain('Toronto');
  });

  it('stores one exchange, though it arrived as two requests', async () => {
    const d = deps({ deepAnswer: deepStream });
    await runAnswerStream(
      recorder().sink,
      { ...ASK, mode: 'deep', clarifications: REPLIES },
      d,
    );

    const body = d.store.messages[0]?.body ?? '';
    expect(body).toContain(ASK.question);
    expect(body).toContain('1. Toronto');
    // Skipped, and written as skipped rather than closed up — the numbers are
    // what tie an answer to its question.
    expect(body).toContain('2. (not answered)');
    expect(body).toContain('3. the last 12 months');
  });

  it('leaves the user turn exactly as typed when there was no clarify', async () => {
    const d = deps();
    await runAnswerStream(recorder().sink, ASK, d);
    expect(d.store.messages[0]?.body).toBe(ASK.question);
    expect(userBodyFor('q', [])).toBe('q');
    expect(userBodyFor('q', ['', ''])).toBe('q');
  });

  it('carries no clarifications into a mode that never asks', async () => {
    // The route-level gate lives in `runAnswer`, which no test can reach; what
    // is provable here is that a web runner is handed whatever the params say,
    // so the gate has to be at the door. This pins the shape the door feeds.
    const seen: readonly string[][] = [];
    const spy: DeepAnswerFn = async (q, dep) => {
      (seen as string[][]).push([...dep.clarifications]);
      return happyStream(q, dep);
    };
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'deep' }, deps({ deepAnswer: spy }));
    expect(seen[0]).toEqual([]);
  });
});

describe('the budget, for a mode that spends for minutes', () => {
  it('admits a fast answer on the small generous estimate', () => {
    expect(estimatedCostCentsFor('web', DEEP_LIMITS)).toBe(5);
    expect(estimatedCostCentsFor('grounded', DEEP_LIMITS)).toBe(5);
    expect(estimatedCostCentsFor('verified', DEEP_LIMITS)).toBe(5);
  });

  it('admits a deep run only against the largest bill the token ceiling allows', () => {
    // Two budget states per request (`createAsk` and `createAskStream` hold one
    // each), every token priced at the strong model's output rate. 12c against
    // roughly 0.17c for a fast answer.
    expect(estimatedCostCentsFor('deep', DEEP_LIMITS)).toBe(12);
  });

  it('tracks the token ceiling rather than being a number somebody picked', () => {
    // Raise `TMOS_MAX_RUN_TOKENS` and the admission estimate follows, because
    // it is derived from it. A constant would have gone stale silently.
    expect(estimatedCostCentsFor('deep', { ...DEEP_LIMITS, maxRunTokens: 200_000 })).toBe(24);
    expect(estimatedCostCentsFor('web', { ...DEEP_LIMITS, maxRunTokens: 200_000 })).toBe(5);
  });

  it('tells the pre-flight which mode is asking', async () => {
    const asked: string[] = [];
    const d = deps({
      deepAnswer: deepStream,
      checkBudget: (mode) => {
        asked.push(mode);
        return null;
      },
    });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'deep' }, d);
    // One estimate for four modes was fine while they all cost the same.
    expect(asked).toEqual(['deep']);
  });

  it('refuses a deep run on a nearly-spent day, before a thread or a cent', async () => {
    const { frames, sink } = recorder();
    const d = deps({
      deepAnswer: deepStream,
      checkBudget: (mode) => (mode === 'deep' ? 'daily spend would reach 2008c, ceiling 2000c' : null),
    });
    await runAnswerStream(sink, { ...ASK, mode: 'deep' }, d);

    expect(frames.map((f) => f.event)).toEqual(['error_msg']);
    expect(d.store.threads).toHaveLength(0);
  });
});

describe('AnswerGuard — one deep run at a time', () => {
  it('refuses a second deep run even when a slot is free', () => {
    const guard = new AnswerGuard();
    guard.begin('q:one', 'deep');
    // The cap is on RUNS; the ceiling is on MONEY. For a run that spends for
    // minutes and reports at the end, two of them pass a pre-flight against a
    // day neither has told anything.
    expect(() => guard.begin('q:two', 'deep')).toThrow(AnswerBusy);
    expect(guard.deepSize()).toBe(1);
  });

  it('lets a fast answer run beside a deep one', () => {
    const guard = new AnswerGuard();
    guard.begin('q:one', 'deep');
    expect(() => guard.begin('q:two')).not.toThrow();
  });

  it('names the ledger, not the slot count, when it refuses', () => {
    const guard = new AnswerGuard();
    guard.begin('q:one', 'deep');
    try {
      guard.begin('q:two', 'deep');
      expect.unreachable();
    } catch (err) {
      expect(String((err as Error).message)).toMatch(/budget is only checked when a run starts/);
    }
  });

  it('frees the deep slot when the run ends', () => {
    const guard = new AnswerGuard();
    const release = guard.begin('q:one', 'deep');
    release();
    expect(guard.deepSize()).toBe(0);
    expect(() => guard.begin('q:two', 'deep')).not.toThrow();
  });

  it('claims the deep slot from the route, and frees it when the run throws', async () => {
    const guard = new AnswerGuard();
    const d = deps({ guard, deepAnswer: () => Promise.reject(new Error('boom')) });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'deep' }, d);
    expect(guard.deepSize()).toBe(0);
  });
});

describe('message.mode says “deep” — the gap, closed in order', () => {
  it('stores a deep turn as itself', async () => {
    const d = deps({ deepAnswer: deepStream });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'deep' }, d);
    expect(d.store.messages[1]?.mode).toBe('deep');
  });

  it('gives the per-mode ledger its meaning back, which was the harm', async () => {
    // §10's cost table sums `cost_cents` by `mode`. While deep stored as
    // `fast`, one 9c run made the fast row read more expensive than every real
    // fast answer combined — a per-mode table that is WRONG rather than
    // incomplete, which is worse, because nobody distrusts it.
    const d = deps({ deepAnswer: async (q, dep) => ({ ...(await happyStream(q, dep)), costCents: 9 }) });
    await runAnswerStream(recorder().sink, { ...ASK, mode: 'deep' }, d);
    expect(d.store.messages[1]?.mode).toBe('deep');
    expect(d.store.messages[1]?.costCents).toBe(9);
  });

  it('survives the round trip it would have died on, and the union is still a gate', () => {
    // THE ORDER THIS RECORDS, because it is the reusable part. `rowToMessage`
    // decodes `mode` through `asUnion`, which THROWS on an unlisted value, and
    // `getThread` is both what renders a thread and what `historyFor` reads a
    // follow-up's context from — so a value the decoder does not know inserts
    // cleanly and fails on EVERY read, making its own thread permanently
    // unreadable. Strictly worse than the mislabelling it fixes.
    //
    //   1. widen the reader (`AnswerMode` + `MODES` in packages/adapters)
    //   2. migration 017 widening the CHECK
    //   3. one word in `messageMode`
    //
    // The previous version of this test asserted the throw, so that it would
    // fail loudly the moment step 1 landed. It did, which is what made step 3
    // safe to take.
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      thread_id: '00000000-0000-4000-8000-000000000002',
      seq: 2,
      role: 'assistant',
      body: 'Jiffy jobs start at $129 [1].',
      mode: 'deep',
      run_id: 'run-1',
      cost_cents: '9',
      answer: null,
      created_at: '2026-08-31T12:00:00.000Z',
    };
    expect(rowToMessage(row).mode).toBe('deep');
    // Still closed. A gate that admits anything is not a gate, and the next
    // mode must repeat the three steps rather than inherit an open door.
    expect(() => rowToMessage({ ...row, mode: 'deep-research' })).toThrow(/not one of/);
  });
});

describe('the deep seam, now closed', () => {
  /** Everything `streamDeep` is handed by this route, with ports that refuse.
   *  `PORTS.ask` returns null, which is how a dead or blocked model arrives. */
  const seamDeps = (): DeepAnswerDeps => ({
    ...PORTS,
    history: [],
    clarifications: [],
    onStatus: () => undefined,
    onSource: () => undefined,
    onSpan: () => undefined,
    onDelta: () => undefined,
    onSentence: () => undefined,
    onUnused: () => undefined,
    onPlan: () => undefined,
    onStep: () => undefined,
    onReflect: () => undefined,
    onClarify: () => undefined,
  });

  it('is the pipeline, and answers nothing when it cannot plan', async () => {
    // What stood here asserted the STUB rejected, which was the honest thing to
    // ship while nothing could run a deep plan. Something can now, so the
    // assertion becomes the same question asked of a working pipeline: with no
    // model reachable, does it come back empty and say so — or does it come
    // back fluent? A stub that returned `{text: "..."}` would have passed every
    // other test in this file and been the worst behaviour this system can
    // have: an uncited essay no plan and no source stands behind.
    const result = await DEEP_ANSWER('How large is the GTA home-services market?', seamDeps());

    expect(result.text).toBe('');
    expect(result.note ?? '').not.toBe('');
    expect(result.costCents).toBe(0);
  });

  it('reports a dead pipeline as a finished run with a note, not as an error', async () => {
    // The mode is BUILT, so a failure here is a failed call and not a missing
    // feature, and those two must not look alike to a reader. Same shape the
    // web and grounded paths produce.
    const { frames, sink } = recorder();
    const d = deps({ deepAnswer: DEEP_ANSWER });
    await runAnswerStream(sink, { ...ASK, mode: 'deep' }, d);

    expect(frames.at(-1)?.event).toBe('done');
    expect(frames.some((f) => f.event === 'error_msg')).toBe(false);
    expect(d.store.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    // Something was stored and it is not prose about the GTA market.
    expect((d.store.messages[1]?.body ?? '').length).toBeGreaterThan(0);
    expect(d.store.messages[1]?.citations ?? []).toEqual([]);
  });

  it('refuses by name on a server that offers no deep runner at all', async () => {
    const { frames, sink } = recorder();
    const d = deps();
    await runAnswerStream(sink, { ...ASK, mode: 'deep' }, d);

    expect(frames.map((f) => f.event)).toEqual(['error_msg']);
    expect(String(frames[0]?.data)).toContain('deep mode is not available');
    // Refused before a thread: answering a minutes-of-research question with a
    // 20-second web pass would hand back a weaker answer under a stronger name.
    expect(d.store.threads).toHaveLength(0);
  });
});

describe('answerKey — a clarify reply is not a duplicate', () => {
  /**
   * The first live deep run refused the answer to its own question.
   *
   * A deep run that stops to ask ends its stream; the reader answers; the reply
   * arrives carrying the SAME question, because it is the same question. Keyed
   * on the question alone that reads as a reload, the guard refuses it, and the
   * workaround was to wait ~8 seconds.
   */
  it('separates the reply from the question it answers', () => {
    const asked = answerKey(null, 'What does Jiffy charge?');
    const replied = answerKey(null, 'What does Jiffy charge?', ['the Toronto home-services company']);
    expect(replied).not.toBe(asked);
  });

  it('still refuses a double-clicked Send — same reader, same replies', () => {
    const a = answerKey(null, 'q', ['toronto']);
    expect(answerKey(null, 'q', ['toronto'])).toBe(a);
  });

  it('treats two readers answering the same clarify differently as two runs', () => {
    expect(answerKey(null, 'q', ['toronto'])).not.toBe(answerKey(null, 'q', ['vancouver']));
  });

  it('applies the same rule on a thread, where the question is not in the key at all', () => {
    expect(answerKey('t1', 'q', ['a'])).not.toBe(answerKey('t1', 'q'));
    expect(answerKey('t1', 'q')).toBe(answerKey('t1', 'different question'));
  });
});
