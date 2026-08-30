/**
 * The thread store, without Postgres.
 *
 * This adapter has no in-memory twin to be compared against — nothing has ever
 * persisted an answer — so these tests are the only executable statement of
 * what it promises. Four things are worth pinning down with no connection, and
 * they are the four that would fail silently:
 *
 *  1. THE PRECONDITIONS ARE CHECKED BEFORE ANY STATEMENT. `withTx` has no
 *     savepoints, so a CHECK violation aborts the caller's whole transaction
 *     and every later statement fails with "current transaction is aborted".
 *     A test that only asserted "it throws" would pass against an adapter that
 *     throws in the worst possible place.
 *
 *  2. `appendMessage` TAKES THE THREAD'S ROW LOCK FIRST. `seq` is `max + 1`,
 *     a read-then-write; the `for update` is the only thing between that and
 *     two concurrent answers claiming the same position.
 *
 *  3. THE PARTIAL-INDEX PREDICATE IS IN THE QUERY TEXT, not in a parameter.
 *     `thread_active_idx` is `where archived_at is null`, and an `or $1` reads
 *     identically while turning the sidebar into a sequential scan.
 *
 *  4. `cost_cents` DECODES AS A NUMBER. It is `numeric(14,6)` and the driver
 *     hands `numeric` back as a string; migration 014 exists because this
 *     column was an int and rounded every real call to zero. A per-message cost
 *     that is sometimes a string is the same bug wearing a hat.
 */
import { describe, expect, it } from 'vitest';
import { withTx, type PooledClient, type QueryRow } from '@tmos/db';

import { ConstraintError, DecodeError, NotFoundError } from '../errors.js';
import { recordingExecutor } from '../testing/recording-executor.js';
import {
  answerFromColumn,
  appendMessage,
  archiveThread,
  createThread,
  deleteThread,
  getThread,
  listThreads,
  renameThread,
  rowToMessage,
  rowToThread,
  type AnswerPayload,
  type CitationRecord,
} from './thread-store.js';

const THREAD = '11111111-1111-4111-8111-111111111111';
const MSG = '22222222-2222-4222-8222-222222222222';
const MSG2 = '33333333-3333-4333-8333-333333333333';
const T0 = '2026-08-30T12:00:00.000Z';

const ANSWER: AnswerPayload = {
  points: [{ claim: 'Jiffy lists snow removal at $129', citations: [{ url: 'https://j.test/p', span: 'from $129' }] }],
  dropped: [{ claim: 'Jiffy is the market leader', why: 'no span supported it' }],
  unanswered: ['what does Jiffy charge in Vancouver'],
  sources: [{ url: 'https://j.test/p', title: 'Pricing', text: 'snow removal from $129 per visit' }],
  queries: ['jiffy snow removal price toronto'],
};

const CITE: CitationRecord = {
  ordinal: 1,
  sourceUrl: 'https://j.test/p',
  span: 'from $129',
  title: 'Pricing',
};

/** Shaped the way node-postgres really answers: numeric → string, timestamptz → Date. */
const cannedThread = (over: Partial<QueryRow> = {}): QueryRow => ({
  id: THREAD,
  title: 'Jiffy snow removal pricing',
  title_source: 'question',
  forked_from_message_id: null,
  created_at: new Date(T0),
  updated_at: new Date(T0),
  archived_at: null,
  ...over,
});

const cannedMessage = (over: Partial<QueryRow> = {}): QueryRow => ({
  id: MSG,
  thread_id: THREAD,
  seq: 2,
  role: 'assistant',
  body: 'Jiffy lists snow removal from $129.',
  mode: 'verified',
  run_id: 'run_abc',
  cost_cents: '0.025000',
  answer: ANSWER,
  created_at: new Date(T0),
  ...over,
});

/** A pooled client that answers the transaction bookkeeping and records it. */
function fakeConnect(): { connect: () => Promise<PooledClient>; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    connect: async () => ({
      async query(text: string) {
        calls.push(text);
        return { rows: [], rowCount: 0 };
      },
      release() {},
    }),
  };
}

/** Runs `body` as if the caller were already inside someone's `withTx`. */
const inFakeTx = async <T>(body: () => Promise<T>): Promise<T> => withTx(body, fakeConnect());

/** Every `${}` became a placeholder — no value was concatenated into the text. */
const noValuesInText = (text: string, values: readonly unknown[]): void => {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 3) expect(text).not.toContain(v);
  }
};

describe('createThread', () => {
  it('parameterises every value and seeds updated_at from created_at', async () => {
    const ex = recordingExecutor([[cannedThread()]]);
    const t = await createThread({ id: THREAD, title: 'Jiffy snow removal pricing', createdAt: T0 }, ex);

    const q = ex.last();
    noValuesInText(q.text, q.values);
    // created_at is passed twice on purpose: a thread with no messages still
    // has to sort somewhere, and the trigger only takes over at message one.
    expect(q.values.filter((v) => v === T0)).toHaveLength(2);
    expect(q.text).toContain('on conflict (id) do nothing');
    expect(t.title).toBe('Jiffy snow removal pricing');
  });

  it("defaults title_source to 'question' — the derivation, not a rename", async () => {
    const ex = recordingExecutor([[cannedThread()]]);
    await createThread({ id: THREAD, title: 'q', createdAt: T0 }, ex);
    expect(ex.last().values).toContain('question');
  });

  it('refuses a non-uuid id before the statement, not after', async () => {
    const ex = recordingExecutor();
    await expect(createThread({ id: 'thread_1', title: 'q', createdAt: T0 }, ex)).rejects.toThrow(
      ConstraintError,
    );
    expect(ex.queries).toHaveLength(0);
  });

  it('refuses a blank title, which the list view cannot render', async () => {
    const ex = recordingExecutor();
    await expect(createThread({ id: THREAD, title: '   ', createdAt: T0 }, ex)).rejects.toThrow(
      /must not be blank/,
    );
    expect(ex.queries).toHaveLength(0);
  });

  it('turns a duplicate id into an error rather than an aborted transaction', async () => {
    const ex = recordingExecutor([[]]); // `do nothing` returned no row
    await expect(createThread({ id: THREAD, title: 'q', createdAt: T0 }, ex)).rejects.toThrow(
      /duplicate thread id/,
    );
  });
});

describe('appendMessage — what it refuses before opening a transaction', () => {
  const base = { id: MSG, threadId: THREAD, body: 'why?', createdAt: T0 } as const;

  it('refuses an assistant answer with no mode', async () => {
    const ex = recordingExecutor();
    await expect(appendMessage({ ...base, role: 'assistant' }, ex)).rejects.toThrow(
      /must record its mode/,
    );
    expect(ex.queries).toHaveLength(0);
  });

  it('refuses a user turn that carries a cost — the run belongs to the answer', async () => {
    const ex = recordingExecutor();
    await expect(appendMessage({ ...base, role: 'user', costCents: 3 }, ex)).rejects.toThrow(
      ConstraintError,
    );
    await expect(appendMessage({ ...base, role: 'user', mode: 'fast' }, ex)).rejects.toThrow(
      ConstraintError,
    );
    await expect(appendMessage({ ...base, role: 'user', answer: ANSWER }, ex)).rejects.toThrow(
      ConstraintError,
    );
    expect(ex.queries).toHaveLength(0);
  });

  it('refuses two citations claiming the same marker: [N] must identify one source', async () => {
    const ex = recordingExecutor();
    await expect(
      appendMessage(
        {
          ...base,
          role: 'assistant',
          mode: 'fast',
          citations: [CITE, { ...CITE, sourceUrl: 'https://other.test' }],
        },
        ex,
      ),
    ).rejects.toThrow(/marker \[1\]/);
    expect(ex.queries).toHaveLength(0);
  });

  it('refuses a zero or fractional marker — the prose is 1-based', async () => {
    const ex = recordingExecutor();
    for (const ordinal of [0, -1, 1.5]) {
      await expect(
        appendMessage({ ...base, role: 'assistant', mode: 'fast', citations: [{ ...CITE, ordinal }] }, ex),
      ).rejects.toThrow(/positive integer/);
    }
    expect(ex.queries).toHaveLength(0);
  });

  it('refuses a citation with an empty span — an unquotable citation is uncheckable', async () => {
    const ex = recordingExecutor();
    await expect(
      appendMessage({ ...base, role: 'assistant', mode: 'fast', citations: [{ ...CITE, span: ' ' }] }, ex),
    ).rejects.toThrow(/span must not be blank/);
    expect(ex.queries).toHaveLength(0);
  });
});

describe('appendMessage — the statements, in order', () => {
  it('locks the thread row first, then assigns seq inside that lock', async () => {
    const ex = recordingExecutor([[{ id: THREAD }], [cannedMessage()], [{}]]);

    await inFakeTx(() =>
      appendMessage(
        {
          id: MSG,
          threadId: THREAD,
          role: 'assistant',
          mode: 'verified',
          body: 'Jiffy lists snow removal from $129.',
          runId: 'run_abc',
          costCents: 0.025,
          answer: ANSWER,
          citations: [CITE],
          createdAt: T0,
        },
        ex,
      ),
    );

    expect(ex.queries).toHaveLength(3);
    // 1. the lock, which is also the existence check the FK would have raised for.
    expect(ex.queries[0]?.text).toContain('from thread where id = $1::uuid for update');
    // 2. the insert, with the position computed under it.
    expect(ex.queries[1]?.text).toContain('coalesce(max(prior.seq), 0) + 1');
    expect(ex.queries[1]?.text).toContain('insert into message');
    // 3. the citations, one statement whatever the count.
    expect(ex.queries[2]?.text).toContain('insert into message_citation');
    expect(ex.queries[2]?.text).toContain('unnest(');
  });

  it('sends the citation columns as four parallel arrays, never as built text', async () => {
    const ex = recordingExecutor([[{ id: THREAD }], [cannedMessage()], [{}]]);
    const citations: CitationRecord[] = [
      CITE,
      { ordinal: 2, sourceUrl: 'https://b.test', span: 'second span', title: null },
    ];

    await inFakeTx(() =>
      appendMessage(
        { id: MSG, threadId: THREAD, role: 'assistant', mode: 'fast', body: 'a', citations, createdAt: T0 },
        ex,
      ),
    );

    const q = ex.queries[2];
    expect(q?.values).toContainEqual([1, 2]);
    expect(q?.values).toContainEqual(['https://j.test/p', 'https://b.test']);
    expect(q?.values).toContainEqual(['from $129', 'second span']);
    // A missing document title stays null rather than becoming an invented one.
    expect(q?.values).toContainEqual(['Pricing', null]);
    noValuesInText(q?.text ?? '', ['https://j.test/p', 'second span']);
  });

  it('issues no citation statement when there is nothing to cite', async () => {
    const ex = recordingExecutor([[{ id: THREAD }], [cannedMessage({ answer: null })]]);
    await inFakeTx(() =>
      appendMessage(
        { id: MSG, threadId: THREAD, role: 'user', body: 'why?', createdAt: T0 },
        ex,
      ),
    );
    expect(ex.queries).toHaveLength(2);
  });

  it('reports an unknown thread as NotFound instead of letting the FK abort the batch', async () => {
    const ex = recordingExecutor([[]]); // the lock found no row
    await expect(
      inFakeTx(() =>
        appendMessage({ id: MSG, threadId: THREAD, role: 'user', body: 'why?', createdAt: T0 }, ex),
      ),
    ).rejects.toThrow(NotFoundError);
    // Nothing was inserted: one statement ran, and it was the lock.
    expect(ex.queries).toHaveLength(1);
  });

  it('returns the citations it stored, ordered by marker', async () => {
    const ex = recordingExecutor([[{ id: THREAD }], [cannedMessage()], [{}]]);
    const out = await inFakeTx(() =>
      appendMessage(
        {
          id: MSG,
          threadId: THREAD,
          role: 'assistant',
          mode: 'fast',
          body: 'a',
          citations: [{ ...CITE, ordinal: 3 }, CITE],
          createdAt: T0,
        },
        ex,
      ),
    );
    expect(out.citations.map((c) => c.ordinal)).toEqual([1, 3]);
  });
});

describe('listThreads', () => {
  it('keeps the partial-index predicate in the text, not in a parameter', async () => {
    const ex = recordingExecutor([[{ ...cannedThread(), message_count: 4 }]]);
    const [row] = await listThreads({}, ex);

    // `thread_active_idx` is `(updated_at desc) where archived_at is null`; the
    // planner only considers it when the query says the same thing literally.
    expect(ex.last().text).toContain('where t.archived_at is null');
    expect(ex.last().text).toContain('order by t.updated_at desc');
    expect(row?.messageCount).toBe(4);
  });

  it('drops the predicate entirely when archived threads are wanted', async () => {
    const ex = recordingExecutor([[]]);
    await listThreads({ includeArchived: true }, ex);
    expect(ex.last().text).not.toContain('archived_at is null');
  });

  it('counts by lateral join so an empty thread still appears', async () => {
    const ex = recordingExecutor([[{ ...cannedThread(), message_count: 0 }]]);
    const [row] = await listThreads({}, ex);
    expect(ex.last().text).toContain('left join lateral');
    expect(row?.messageCount).toBe(0);
  });
});

describe('getThread', () => {
  it('answers null for an id that is not a uuid, without a statement', async () => {
    const ex = recordingExecutor();
    expect(await getThread('thread_1', ex)).toBeNull();
    expect(ex.queries).toHaveLength(0);
  });

  it('stops after the head query when the thread is gone', async () => {
    const ex = recordingExecutor([[]]);
    expect(await getThread(THREAD, ex)).toBeNull();
    expect(ex.queries).toHaveLength(1);
  });

  it('groups citations onto their own message and orders messages by seq', async () => {
    const ex = recordingExecutor([
      [cannedThread()],
      [cannedMessage({ id: MSG, seq: 1, role: 'user', mode: null, answer: null, cost_cents: '0' }),
       cannedMessage({ id: MSG2, seq: 2 })],
      [
        { message_id: MSG2, ordinal: 1, source_url: 'https://j.test/p', span: 'from $129', title: 'Pricing' },
        { message_id: MSG2, ordinal: 2, source_url: 'https://b.test', span: 'second', title: null },
      ],
    ]);

    const detail = await getThread(THREAD, ex);

    expect(ex.queries[1]?.text).toContain('order by m.seq');
    expect(detail?.messages.map((m) => m.seq)).toEqual([1, 2]);
    expect(detail?.messages[0]?.citations).toEqual([]);
    expect(detail?.messages[1]?.citations.map((c) => c.ordinal)).toEqual([1, 2]);
    expect(detail?.messages[1]?.citations[1]?.title).toBeNull();
  });

  it('skips the citation query when the thread has no messages', async () => {
    const ex = recordingExecutor([[cannedThread()], []]);
    const detail = await getThread(THREAD, ex);
    expect(detail?.messages).toEqual([]);
    expect(ex.queries).toHaveLength(2);
  });
});

describe('renaming, archiving, deleting', () => {
  it("a rename stamps title_source = 'user', which nothing may later overwrite", async () => {
    const ex = recordingExecutor([[{}]]);
    await renameThread(THREAD, 'Jiffy pricing, Q4', ex);
    expect(ex.last().text).toContain("title_source = 'user'");
    expect(ex.last().values).toContain('Jiffy pricing, Q4');
  });

  it('refuses a blank rename and reports an unknown thread as NotFound', async () => {
    const ex = recordingExecutor([[]]);
    await expect(renameThread(THREAD, ' ', ex)).rejects.toThrow(/must not be blank/);
    await expect(renameThread(THREAD, 'x', ex)).rejects.toThrow(NotFoundError);
  });

  it('archives with the caller\'s instant and un-archives with null', async () => {
    const ex = recordingExecutor([[{}], [{}]]);
    await archiveThread(THREAD, T0, ex);
    expect(ex.last().values).toContain(T0);
    await archiveThread(THREAD, null, ex);
    expect(ex.last().values).toContain(null);
  });

  it('deletes, and says so when there was nothing to delete', async () => {
    const ex = recordingExecutor([[{}], []]);
    await deleteThread(THREAD, ex);
    expect(ex.last().text).toContain('delete from thread');
    await expect(deleteThread(THREAD, ex)).rejects.toThrow(NotFoundError);
  });

  it('treats a non-uuid as not found rather than raising 22P02', async () => {
    const ex = recordingExecutor();
    await expect(deleteThread('nope', ex)).rejects.toThrow(NotFoundError);
    await expect(archiveThread('nope', T0, ex)).rejects.toThrow(NotFoundError);
    await expect(renameThread('nope', 'x', ex)).rejects.toThrow(NotFoundError);
    expect(ex.queries).toHaveLength(0);
  });
});

describe('decoding what came back', () => {
  it('reads a fractional numeric cost as a number — the bug 014 fixed one layer down', () => {
    // `int` rounded 0.025 to 0 and made the daily ceiling unenforceable. A cost
    // decoded as the STRING '0.025' would sum by concatenation, which is worse.
    const m = rowToMessage(cannedMessage({ cost_cents: '0.025000' }));
    expect(m.costCents).toBe(0.025);
    expect(typeof m.costCents).toBe('number');
  });

  it('keeps dropped and unanswered — the refusals are the product', () => {
    const m = rowToMessage(cannedMessage());
    expect(m.answer?.dropped[0]?.why).toBe('no span supported it');
    expect(m.answer?.unanswered).toEqual(['what does Jiffy charge in Vancouver']);
    expect(m.answer?.points[0]?.citations[0]?.span).toBe('from $129');
  });

  it('decodes the payload from a raw JSON string too, since a type parser is global state', () => {
    expect(answerFromColumn(JSON.stringify(ANSWER))).toEqual(ANSWER);
    expect(answerFromColumn(null)).toBeNull();
  });

  it('refuses a payload that is not an answer, naming the field', () => {
    expect(() => answerFromColumn({ ...ANSWER, points: [{ claim: 1, citations: [] }] })).toThrow(
      /answer\.points\[0\]\.claim/,
    );
    expect(() => answerFromColumn({ ...ANSWER, unanswered: 'nope' })).toThrow(DecodeError);
  });

  it('refuses a role or mode outside what 015 permits', () => {
    expect(() => rowToMessage(cannedMessage({ role: 'system' }))).toThrow(DecodeError);
    expect(() => rowToMessage(cannedMessage({ mode: 'deep' }))).toThrow(DecodeError);
    // A user turn's null mode is not a decode failure — it is the shape.
    expect(rowToMessage(cannedMessage({ role: 'user', mode: null, answer: null })).mode).toBeNull();
  });

  it('reads a thread head, including a title nobody has renamed', () => {
    const t = rowToThread(cannedThread());
    expect(t.titleSource).toBe('question');
    expect(t.archivedAt).toBeNull();
    expect(t.updatedAt).toBe(T0);
    expect(() => rowToThread(cannedThread({ title_source: 'auto' }))).toThrow(DecodeError);
  });
});
