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
import type { MessageRecord, NewMessage, NewThread, ThreadDetail, ThreadRecord } from '@tmos/adapters';

import {
  AnswerBusy,
  AnswerGuard,
  answerKey,
  citationsFor,
  runAnswerStream,
  titleFor,
  type AnswerDeps,
  type AnswerStore,
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
    return { ...head, messages: [] };
  }

  async appendMessage(m: NewMessage): Promise<MessageRecord> {
    this.messages.push(m);
    return {
      id: m.id,
      threadId: m.threadId,
      seq: this.messages.length,
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
