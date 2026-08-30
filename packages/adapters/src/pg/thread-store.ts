/**
 * Threads and messages on `thread` / `message` / `message_citation` — migration
 * 015.
 *
 * This is the first store in the package with no in-memory twin: there is no
 * port to conform to because nothing has ever persisted an answer. So the
 * behavioural specification is 015 itself, and the notes below say which
 * invariants live in the schema (and are therefore true for every writer) and
 * which live here (and are therefore only true for callers who come through
 * this file).
 *
 * THE HOUSE RULES, WHICH HOLD HERE TOO:
 *
 *   `ex: Executor = db()` IS THE LAST PARAMETER of every function, so each one
 *   works standalone against the pool and enlists in a caller's `withTx` with
 *   no plumbing.
 *
 *   THE ADAPTER NEVER READS THE CLOCK. Every instant is taken from the caller.
 *   That is not only for testability: `now()` is FROZEN for the whole of a
 *   transaction, so a question and its answer appended together would share an
 *   instant, and anything ordering by `created_at` would order them at random.
 *   015 answers that with `seq`, and this file is what assigns it.
 *
 *   A PRECONDITION IS CHECKED BEFORE THE STATEMENT, not after. `withTx` has no
 *   savepoints: a raised 23503 or 23505 aborts the CALLER's whole transaction,
 *   and every statement after it fails with "current transaction is aborted" —
 *   so the caller loses both the diagnosis and the rest of the batch. A missing
 *   thread, a blank title and a duplicated citation marker are therefore all
 *   refused in JavaScript, even though the schema would also refuse them.
 *
 * WHAT `appendMessage` SERIALISES, AND HOW. `seq` is `max(seq) + 1` over the
 * thread, which is a read-then-write and therefore a race: two answers appended
 * to one thread at the same moment both compute the same number, and the
 * `unique (thread_id, seq)` constraint turns the loser into an aborted
 * transaction. The fix is `select ... from thread ... for update` as the FIRST
 * statement — one row lock that does double duty, because it is also the
 * existence check the foreign key would otherwise have raised for. It is held
 * to the end of the caller's transaction (the same honest cost `putFinding`
 * documents for its advisory lock) and it only binds writers who come through
 * here; an INSERT into `message` from somewhere else can still collide.
 */
import { db, inTransaction, sql, withTx, type Executor, type QueryRow } from '@tmos/db';
import type { Citation, Dropped, Point, ReadDoc, ResearchAnswer } from '@tmos/research';

import { ConstraintError, DecodeError, NotFoundError, guard } from '../errors.js';
import {
  asIso,
  asIsoOrNull,
  asNumber,
  asText,
  asTextOrNull,
  asUnion,
  isUuid,
} from './values.js';

/* ── the shapes ─────────────────────────────────────────────────────────── */

export type MessageRole = 'user' | 'assistant';
/** Fast = per-sentence checks; Verified = the whole-answer verbatim gate. */
/**
 * How an answer was produced. Widened for `grounded` by migration 016.
 *
 * THE ORDER MATTERS AND IT IS NOT THE OBVIOUS ONE. This union is a decode gate:
 * `asUnion` THROWS on a value it does not list, and `getThread` is both what
 * renders a thread and what `historyFor` reads a follow-up's context from. So a
 * mode written to the database but missing from this list does not degrade —
 * it makes its own thread permanently unreadable, which is strictly worse than
 * the mislabelling it was meant to fix.
 *
 * Consequence, for whoever adds the next mode: widen this FIRST and ship it,
 * then start writing the new value. A migration that admits a mode the reader
 * refuses is a trap that only springs after the row exists.
 */
export type AnswerMode = 'fast' | 'verified' | 'grounded';
/**
 * Where a thread's title came from. `user` is a rename and outranks the other
 * two forever — see 015 on why a later auto-titler needs to be able to tell.
 */
export type TitleSource = 'question' | 'user' | 'generated';

const ROLES = ['user', 'assistant'] as const;
const MODES = ['fast', 'verified', 'grounded'] as const;
const TITLE_SOURCES = ['question', 'user', 'generated'] as const;

/**
 * What `message.answer` holds: the `ResearchAnswer` minus the four fields 015
 * promoted to columns (`question`/`summary` → `body`, `costCents` →
 * `cost_cents`). Derived with `Pick` rather than restated, so a change to
 * `ResearchAnswer` breaks the build here instead of silently storing a shape
 * the reader no longer expects.
 */
export type AnswerPayload = Pick<
  ResearchAnswer,
  'points' | 'dropped' | 'unanswered' | 'sources' | 'queries'
>;

/** One resolved `[N]` marker. `ordinal` is the number the reader sees. */
export interface CitationRecord {
  readonly ordinal: number;
  readonly sourceUrl: string;
  /** Verbatim from the fetched document. This is what stays checkable. */
  readonly span: string;
  readonly title: string | null;
}

export interface MessageRecord {
  readonly id: string;
  readonly threadId: string;
  /** Position in the thread. Assigned by `appendMessage`, never by the caller. */
  readonly seq: number;
  readonly role: MessageRole;
  readonly body: string;
  readonly mode: AnswerMode | null;
  /** Joins `ai_usage_log.run_id`. Null on a user turn — the run is the answer's. */
  readonly runId: string | null;
  readonly costCents: number;
  readonly answer: AnswerPayload | null;
  readonly createdAt: string;
  readonly citations: readonly CitationRecord[];
}

export interface ThreadRecord {
  readonly id: string;
  readonly title: string;
  readonly titleSource: TitleSource;
  readonly forkedFromMessageId: string | null;
  readonly createdAt: string;
  /** Maintained by 015's trigger on `message`, never written from here. */
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface ThreadSummary extends ThreadRecord {
  readonly messageCount: number;
}

export interface ThreadDetail extends ThreadRecord {
  readonly messages: readonly MessageRecord[];
}

export interface NewThread {
  /** Minted by the caller with `randomUUID()`, like every other id in this package. */
  readonly id: string;
  readonly title: string;
  /** Defaults to `question` — the cheap derivation from the first question. */
  readonly titleSource?: TitleSource;
  /** The message this thread was forked from, when it was. */
  readonly forkedFromMessageId?: string | null;
  readonly createdAt: string;
}

export interface NewMessage {
  readonly id: string;
  readonly threadId: string;
  readonly role: MessageRole;
  readonly body: string;
  readonly mode?: AnswerMode | null;
  readonly runId?: string | null;
  readonly costCents?: number;
  readonly answer?: AnswerPayload | null;
  readonly citations?: readonly CitationRecord[];
  readonly createdAt: string;
}

export interface ListThreadsOptions {
  /**
   * Archived threads are excluded by default. Including them changes the SQL
   * rather than adding an `or $1` — see `listThreads`.
   */
  readonly includeArchived?: boolean;
  readonly limit?: number;
}

/* ── projections ────────────────────────────────────────────────────────── */

/**
 * Nested into every read so the decoder only ever meets one shape. Ids are cast
 * `::text` so the result cannot depend on a driver type parser (`pg/values.ts`
 * explains why nothing here trusts those).
 */
const THREAD_COLUMNS = sql`
  t.id::text as id,
  t.title,
  t.title_source,
  t.forked_from_message_id::text as forked_from_message_id,
  t.created_at,
  t.updated_at,
  t.archived_at`;

const MESSAGE_COLUMNS = sql`
  m.id::text as id,
  m.thread_id::text as thread_id,
  m.seq,
  m.role,
  m.body,
  m.mode,
  m.run_id,
  m.cost_cents,
  m.answer,
  m.created_at`;

const CITATION_COLUMNS = sql`
  c.message_id::text as message_id,
  c.ordinal,
  c.source_url,
  c.span,
  c.title`;

/* ── decoding ───────────────────────────────────────────────────────────── */

/**
 * `answer` is a jsonb document with no Zod schema behind it: `ResearchAnswer`
 * lives in `packages/research`, not in `packages/contracts`, so there is
 * nothing to `safeParse` against. It is therefore decoded element by element
 * rather than cast — the same rule the rest of this package follows, for the
 * same reason: "the row that came back is not an answer" is a different failure
 * from "your write was refused", and a cast turns the first into neither.
 */
function asRecord(value: unknown, column: string): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  throw new DecodeError(`${column}: expected an object, got ${typeof value}`);
}

function asArray(value: unknown, column: string): unknown[] {
  if (Array.isArray(value)) return value;
  throw new DecodeError(`${column}: expected an array, got ${typeof value}`);
}

const asStrings = (value: unknown, column: string): string[] =>
  asArray(value, column).map((v, i) => asText(v, `${column}[${i}]`));

function citationFrom(value: unknown, column: string): Citation {
  const o = asRecord(value, column);
  return { url: asText(o.url, `${column}.url`), span: asText(o.span, `${column}.span`) };
}

function pointFrom(value: unknown, column: string): Point {
  const o = asRecord(value, column);
  return {
    claim: asText(o.claim, `${column}.claim`),
    citations: asArray(o.citations, `${column}.citations`).map((c, i) =>
      citationFrom(c, `${column}.citations[${i}]`),
    ),
  };
}

function droppedFrom(value: unknown, column: string): Dropped {
  const o = asRecord(value, column);
  return { claim: asText(o.claim, `${column}.claim`), why: asText(o.why, `${column}.why`) };
}

function docFrom(value: unknown, column: string): ReadDoc {
  const o = asRecord(value, column);
  return {
    url: asText(o.url, `${column}.url`),
    title: asText(o.title, `${column}.title`),
    text: asText(o.text, `${column}.text`),
  };
}

export function answerFromColumn(value: unknown): AnswerPayload | null {
  if (value === null || value === undefined) return null;
  // A custom type parser (or `::text` in a query someone else wrote) can hand
  // back the raw document instead of a parsed one.
  const raw: unknown = typeof value === 'string' ? safeJson(value) : value;
  const o = asRecord(raw, 'answer');
  return {
    points: asArray(o.points, 'answer.points').map((p, i) => pointFrom(p, `answer.points[${i}]`)),
    dropped: asArray(o.dropped, 'answer.dropped').map((d, i) =>
      droppedFrom(d, `answer.dropped[${i}]`),
    ),
    unanswered: asStrings(o.unanswered, 'answer.unanswered'),
    sources: asArray(o.sources, 'answer.sources').map((s, i) => docFrom(s, `answer.sources[${i}]`)),
    queries: asStrings(o.queries, 'answer.queries'),
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new DecodeError(`answer: not JSON`, { cause: error });
  }
}

export function rowToThread(row: QueryRow): ThreadRecord {
  return {
    id: asText(row.id, 'id'),
    title: asText(row.title, 'title'),
    titleSource: asUnion(row.title_source, TITLE_SOURCES, 'title_source'),
    forkedFromMessageId: asTextOrNull(row.forked_from_message_id, 'forked_from_message_id'),
    createdAt: asIso(row.created_at, 'created_at'),
    updatedAt: asIso(row.updated_at, 'updated_at'),
    archivedAt: asIsoOrNull(row.archived_at, 'archived_at'),
  };
}

export function rowToCitation(row: QueryRow): CitationRecord {
  return {
    ordinal: asNumber(row.ordinal, 'ordinal'),
    sourceUrl: asText(row.source_url, 'source_url'),
    span: asText(row.span, 'span'),
    title: asTextOrNull(row.title, 'title'),
  };
}

/**
 * `cost_cents` is `numeric(14,6)` (014), and node-postgres hands `numeric` back
 * as a STRING — deliberately, because float64 cannot hold every numeric. It is
 * coerced here rather than left as-is: a per-message cost that is sometimes a
 * string and sometimes a number is the shape that silently sums to '0.0250.025'.
 */
export function rowToMessage(row: QueryRow, citations: readonly CitationRecord[] = []): MessageRecord {
  return {
    id: asText(row.id, 'id'),
    threadId: asText(row.thread_id, 'thread_id'),
    seq: asNumber(row.seq, 'seq'),
    role: asUnion(row.role, ROLES, 'role'),
    body: asText(row.body, 'body'),
    mode: row.mode === null || row.mode === undefined ? null : asUnion(row.mode, MODES, 'mode'),
    runId: asTextOrNull(row.run_id, 'run_id'),
    costCents: asNumber(row.cost_cents, 'cost_cents'),
    answer: answerFromColumn(row.answer),
    createdAt: asIso(row.created_at, 'created_at'),
    citations: [...citations],
  };
}

/* ── threads ────────────────────────────────────────────────────────────── */

export async function createThread(t: NewThread, ex: Executor = db()): Promise<ThreadRecord> {
  requireUuid('createThread', 'thread id', t.id);
  requireNonBlank('createThread', 'title', t.title);
  if (t.forkedFromMessageId !== undefined && t.forkedFromMessageId !== null) {
    requireUuid('createThread', 'forkedFromMessageId', t.forkedFromMessageId);
  }

  // `created_at` seeds `updated_at` too: a thread with no messages yet still
  // has to sort somewhere in the list, and "when it was started" is the only
  // honest answer. The trigger takes over from the first message.
  const row = await guard('createThread', () =>
    ex.maybeOne(sql`
      insert into thread as t (id, title, title_source, forked_from_message_id, created_at, updated_at)
      values (
        ${t.id}::uuid, ${t.title}, ${t.titleSource ?? 'question'},
        ${t.forkedFromMessageId ?? null}::uuid,
        ${t.createdAt}::timestamptz, ${t.createdAt}::timestamptz
      )
      on conflict (id) do nothing
      returning ${THREAD_COLUMNS}`),
  );

  // `do nothing` rather than letting the primary key raise, for the reason at
  // the top of this file: a 23505 would abort the caller's transaction.
  if (row === null) throw new ConstraintError(`createThread: duplicate thread id: ${t.id}`);
  return rowToThread(row);
}

/**
 * Newest first, with the count of messages in each.
 *
 * THE PREDICATE IS WRITTEN LITERALLY, and `includeArchived` changes the SQL
 * rather than parameterising it. `thread_active_idx` is PARTIAL — `(updated_at
 * desc) where archived_at is null` — and the planner only considers a partial
 * index when the query's WHERE clause implies its predicate in that form. An
 * `or ${includeArchived}` reads as the same query and quietly turns the sidebar
 * into a sequential scan. (`prediction_due_idx` taught this once already.)
 *
 * The count is a LATERAL subquery rather than a `group by`, so that a thread
 * with no messages still appears — a thread created and then abandoned is
 * exactly the row a user is looking for when they wonder where their question
 * went.
 */
export async function listThreads(
  opts: ListThreadsOptions = {},
  ex: Executor = db(),
): Promise<ThreadSummary[]> {
  const where = opts.includeArchived === true ? sql`` : sql`where t.archived_at is null`;
  const limit = opts.limit ?? 100;

  const rows = await guard('listThreads', () =>
    ex.query(sql`
      select ${THREAD_COLUMNS}, n.message_count
        from thread t
        left join lateral (
          select count(*)::int as message_count from message m where m.thread_id = t.id
        ) n on true
       ${where}
       order by t.updated_at desc, t.id desc
       limit ${limit}`),
  );

  return rows.map((row) => ({
    ...rowToThread(row),
    messageCount: asNumber(row.message_count, 'message_count'),
  }));
}

/**
 * One thread, with every message and every citation.
 *
 * Three statements, not one join: a join would repeat the whole answer document
 * once per citation, and an answer carries the full text of every source it
 * read. Two reads with no transaction around them are safe under READ
 * COMMITTED for the one interleaving that matters — a message is only visible
 * to the first query once its transaction committed, and `appendMessage` writes
 * the citations inside that same transaction, so the later query cannot miss
 * them.
 */
export async function getThread(id: string, ex: Executor = db()): Promise<ThreadDetail | null> {
  if (!isUuid(id)) return null;

  return guard('getThread', async () => {
    const head = await ex.maybeOne(sql`select ${THREAD_COLUMNS} from thread t where t.id = ${id}::uuid`);
    if (head === null) return null;

    const messageRows = await ex.query(sql`
      select ${MESSAGE_COLUMNS} from message m where m.thread_id = ${id}::uuid order by m.seq`);

    const citationRows =
      messageRows.length === 0
        ? []
        : await ex.query(sql`
            select ${CITATION_COLUMNS} from message_citation c
             where c.message_id = any(${messageRows.map((r) => asText(r.id, 'id'))}::uuid[])
             order by c.message_id, c.ordinal`);

    const byMessage = new Map<string, CitationRecord[]>();
    for (const row of citationRows) {
      const key = asText(row.message_id, 'message_id');
      const list = byMessage.get(key) ?? [];
      list.push(rowToCitation(row));
      byMessage.set(key, list);
    }

    return {
      ...rowToThread(head),
      messages: messageRows.map((row) => rowToMessage(row, byMessage.get(asText(row.id, 'id')) ?? [])),
    };
  });
}

/**
 * A rename is always a human act, so it also sets `title_source = 'user'` —
 * which is the entire reason that column exists (015). A later auto-titler that
 * overwrote a rename would be reproducing the Perplexity complaint the plan
 * names in §7; this is the flag that stops it.
 */
export async function renameThread(id: string, title: string, ex: Executor = db()): Promise<void> {
  requireNonBlank('renameThread', 'title', title);
  if (!isUuid(id)) throw new NotFoundError(`unknown thread: ${id}`);

  const changed = await guard('renameThread', () =>
    ex.execute(sql`update thread set title = ${title}, title_source = 'user' where id = ${id}::uuid`),
  );
  if (changed === 0) throw new NotFoundError(`unknown thread: ${id}`);
}

/**
 * Soft delete. `archivedAt = null` puts it back — archiving is a list-view
 * decision, and one the user must be able to undo, which is precisely what
 * separates it from `deleteThread`.
 */
export async function archiveThread(
  id: string,
  archivedAt: string | null,
  ex: Executor = db(),
): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError(`unknown thread: ${id}`);

  const changed = await guard('archiveThread', () =>
    ex.execute(sql`update thread set archived_at = ${archivedAt}::timestamptz where id = ${id}::uuid`),
  );
  if (changed === 0) throw new NotFoundError(`unknown thread: ${id}`);
}

/**
 * Hard delete, cascading to `message` and `message_citation`.
 *
 * It exists ALONGSIDE archiving rather than instead of it because they answer
 * different requests: "get this out of my list" is undoable, "remove what I
 * asked" must actually remove it. A fork of a deleted thread survives — 015's
 * `on delete set null` keeps the fork and drops only the provenance link.
 *
 * `ai_usage_log` is untouched by design: the spend happened, and a ledger that
 * shrinks when someone tidies up is not a ledger. The rows are simply no longer
 * attributable to a message.
 */
export async function deleteThread(id: string, ex: Executor = db()): Promise<void> {
  if (!isUuid(id)) throw new NotFoundError(`unknown thread: ${id}`);

  const changed = await guard('deleteThread', () =>
    ex.execute(sql`delete from thread where id = ${id}::uuid`),
  );
  if (changed === 0) throw new NotFoundError(`unknown thread: ${id}`);
}

/* ── messages ───────────────────────────────────────────────────────────── */

async function appendInTransaction(m: NewMessage, ex: Executor): Promise<MessageRecord> {
  // Lock and existence check in one statement — see the header. Without the
  // lock, `max(seq) + 1` is a read-then-write that two concurrent appends both
  // win; without the check, a missing thread reaches the foreign key and aborts
  // the transaction instead of returning a NotFoundError.
  const thread = await guard('appendMessage', () =>
    ex.maybeOne(sql`select id::text as id from thread where id = ${m.threadId}::uuid for update`),
  );
  if (thread === null) throw new NotFoundError(`unknown thread: ${m.threadId}`);

  const citations = m.citations ?? [];
  const row = await guard('appendMessage', () =>
    ex.maybeOne(sql`
      insert into message as m (id, thread_id, seq, role, body, mode, run_id, cost_cents, answer, created_at)
      select ${m.id}::uuid, ${m.threadId}::uuid, coalesce(max(prior.seq), 0) + 1,
             ${m.role}, ${m.body}, ${m.mode ?? null}, ${m.runId ?? null},
             ${m.costCents ?? 0}::numeric, ${jsonOrNull(m.answer)}::jsonb,
             ${m.createdAt}::timestamptz
        from message prior
       where prior.thread_id = ${m.threadId}::uuid
      on conflict (id) do nothing
      returning ${MESSAGE_COLUMNS}`),
  );
  if (row === null) throw new ConstraintError(`appendMessage: duplicate message id: ${m.id}`);

  if (citations.length > 0) {
    // One statement whatever the count: the four columns go over as parallel
    // arrays and `unnest` zips them. The alternative — a VALUES list built in a
    // loop — is the shape that invites string concatenation back in.
    await guard('appendMessage', () =>
      ex.execute(sql`
        insert into message_citation (message_id, ordinal, source_url, span, title)
        select ${m.id}::uuid, o, u, s, t
          from unnest(
            ${citations.map((c) => c.ordinal)}::int[],
            ${citations.map((c) => c.sourceUrl)}::text[],
            ${citations.map((c) => c.span)}::text[],
            ${citations.map((c) => c.title)}::text[]
          ) as z(o, u, s, t)`),
    );
  }

  return rowToMessage(row, [...citations].sort((a, b) => a.ordinal - b.ordinal));
}

/**
 * Appends one turn and its citations ATOMICALLY.
 *
 * The atomicity is not incidental. A message stored without its citations is an
 * answer whose `[3]` points at nothing — worse than no answer, because it looks
 * checked. So both writes are one transaction, and the position (`seq`) is
 * assigned inside it under the thread's row lock.
 *
 * Every precondition is JavaScript, before the first statement, for the reason
 * at the top of the file. The role/mode pairing is checked here as well as by
 * 015's `message_role_shape` constraint: this way the caller gets a message
 * that names the rule instead of a CHECK violation that names a constraint.
 */
export async function appendMessage(m: NewMessage, ex: Executor = db()): Promise<MessageRecord> {
  requireUuid('appendMessage', 'message id', m.id);
  requireUuid('appendMessage', 'threadId', m.threadId);
  requireNonBlank('appendMessage', 'body', m.body);

  const mode = m.mode ?? null;
  if (m.role === 'assistant' && mode === null) {
    throw new ConstraintError(
      'appendMessage: an assistant message must record its mode (fast | verified) — ' +
        'an answer nobody can attribute to a pipeline cannot be compared against the other one.',
    );
  }
  if (m.role === 'user' && (mode !== null || (m.answer ?? null) !== null || (m.costCents ?? 0) !== 0)) {
    throw new ConstraintError(
      'appendMessage: a user message carries no mode, answer or cost — the run belongs to the answer.',
    );
  }

  const citations = m.citations ?? [];
  if (m.role === 'user' && citations.length > 0) {
    throw new ConstraintError('appendMessage: a user message cites nothing');
  }

  const seen = new Set<number>();
  for (const c of citations) {
    if (!Number.isInteger(c.ordinal) || c.ordinal < 1) {
      throw new ConstraintError(
        `appendMessage: citation ordinal must be a positive integer, got ${c.ordinal}`,
      );
    }
    if (seen.has(c.ordinal)) {
      // The primary key would refuse this too. Catching it here says WHY it
      // matters: two sources sharing a marker means `[3]` in the prose no
      // longer identifies a source, which is the one thing a marker is for.
      throw new ConstraintError(
        `appendMessage: two citations claim marker [${c.ordinal}] — a marker must identify one source`,
      );
    }
    seen.add(c.ordinal);
    requireNonBlank('appendMessage', `citation [${c.ordinal}] source url`, c.sourceUrl);
    requireNonBlank('appendMessage', `citation [${c.ordinal}] span`, c.span);
  }

  // `inTransaction()`, not the shape of `ex`, decides — the only way to hold a
  // transaction executor is inside `withTx`, which sets it for the whole async
  // context. Copied from `putFinding`.
  if (inTransaction()) return appendInTransaction(m, ex);
  return withTx((tx) => appendInTransaction(m, tx));
}

/* ── forking ────────────────────────────────────────────────────────────── */

/**
 * The fork's own identity. Minted by the caller, like every other id here, and
 * stamped with the caller's instant — the adapter still never reads the clock.
 */
export interface NewFork {
  readonly id: string;
  readonly createdAt: string;
}

/** What the sidebar can render on one line, and what 015's title check will
 *  accept. Shared by both title paths below. */
const MAX_TITLE_CHARS = 80;
const FORK_SUFFIX = ' (fork)';

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

const cap = (s: string, max: number): string =>
  s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;

/**
 * WHAT A FORK IS CALLED.
 *
 * Not the parent's title. §7 of the answer-engine plan names generic
 * auto-titles as one of three Perplexity mistakes not to repeat, and a sidebar
 * holding three rows all called "Jiffy snow removal pricing" is that complaint
 * with an extra step — the whole reason to fork is to tell the branches apart.
 *
 * The honest name for a branch is THE QUESTION IT WAS CUT AT: that is what the
 * new conversation is about, and it is already written down. The parent's title
 * is only the fallback, for the case where the prefix contains no question at
 * all — and it arrives as `generated` rather than `question`, so that a parent
 * title which was a human RENAME (`title_source = 'user'`) does not smuggle its
 * un-overwritable status into a title no human ever typed.
 */
function forkTitle(
  branchQuestion: string | null,
  parentTitle: string,
): { readonly title: string; readonly source: TitleSource } {
  const question = collapse(branchQuestion ?? '');
  const source: TitleSource = question !== '' ? 'question' : 'generated';
  const base = question !== '' ? question : collapse(parentTitle);
  if (base === '') return { title: 'Untitled fork', source };
  // Forking a fork must not read "… (fork) (fork)".
  if (base.endsWith(FORK_SUFFIX)) return { title: cap(base, MAX_TITLE_CHARS), source };
  return { title: `${cap(base, MAX_TITLE_CHARS - FORK_SUFFIX.length)}${FORK_SUFFIX}`, source };
}

async function forkInTransaction(
  threadId: string,
  uptoSeq: number,
  fork: NewFork,
  ex: Executor,
): Promise<ThreadRecord> {
  // The same row lock `appendMessage` takes, for a second reason on top of the
  // existence check: it is what stops an append landing between the cut being
  // read and the prefix being copied, which would fork a thread that is not the
  // one the reader was looking at.
  const parent = await guard('forkThread', () =>
    ex.maybeOne(sql`select t.title from thread t where t.id = ${threadId}::uuid for update`),
  );
  if (parent === null) throw new NotFoundError(`unknown thread: ${threadId}`);

  // Both facts about the cut in one round trip: the message being forked FROM,
  // and the last question asked at or before it, which is what names the fork.
  const cut = await guard('forkThread', () =>
    ex.one(sql`
      select (select m.id::text from message m
               where m.thread_id = ${threadId}::uuid and m.seq = ${uptoSeq}) as branch_id,
             (select m.body from message m
               where m.thread_id = ${threadId}::uuid and m.seq <= ${uptoSeq} and m.role = 'user'
               order by m.seq desc limit 1) as branch_question`),
  );

  const branchId = asTextOrNull(cut.branch_id, 'branch_id');
  if (branchId === null) {
    // NOT "copy as much as exists". A seq naming no message is a mistake, and
    // answering it with the whole thread hides the mistake behind a plausible
    // result — the caller believes they cut at a point that was never there.
    throw new NotFoundError(
      `forkThread: thread ${threadId} has no message at seq ${uptoSeq} — a fork is cut at a ` +
        'message, and there is nothing at that position to cut at.',
    );
  }

  const named = forkTitle(
    asTextOrNull(cut.branch_question, 'branch_question'),
    asText(parent.title, 'title'),
  );

  const head = await guard('forkThread', () =>
    ex.maybeOne(sql`
      insert into thread as t (id, title, title_source, forked_from_message_id, created_at, updated_at)
      values (
        ${fork.id}::uuid, ${named.title}, ${named.source}, ${branchId}::uuid,
        ${fork.createdAt}::timestamptz, ${fork.createdAt}::timestamptz
      )
      on conflict (id) do nothing
      returning ${THREAD_COLUMNS}`),
  );
  if (head === null) throw new ConstraintError(`forkThread: duplicate thread id: ${fork.id}`);

  /**
   * The prefix and its citations, in ONE statement.
   *
   * `src` is materialised — it is referenced twice AND contains a volatile
   * function — so `new_id` is one uuid per source message, shared by the
   * message insert and the citation insert. That is the whole trick: the
   * old→new id map exists for the length of the statement without the adapter
   * minting ids in a loop, and without a second round trip in which a crash
   * could leave messages whose `[3]` points at nothing.
   *
   * `row_number()` rather than `m.seq`, so the fork's positions start at 1 and
   * stay contiguous whatever the parent's numbering looked like.
   *
   * `created_at` IS carried over: it is when the turn happened, and 015's
   * trigger takes `greatest(updated_at, new.created_at)`, so copying old
   * instants cannot rewind the fork below the parent in the sidebar.
   *
   * `run_id` and `cost_cents` are NOT carried over. The spend happened once.
   * A copied run id makes one paid run answer for two messages, and a copied
   * cost bills the fork for money nobody spent — the same reason `deleteThread`
   * leaves `ai_usage_log` alone.
   */
  await guard('forkThread', () =>
    ex.execute(sql`
      with src as (
        select m.id,
               row_number() over (order by m.seq) as seq,
               m.role, m.body, m.mode, m.answer, m.created_at,
               gen_random_uuid() as new_id
          from message m
         where m.thread_id = ${threadId}::uuid and m.seq <= ${uptoSeq}
      ),
      copied as (
        insert into message (id, thread_id, seq, role, body, mode, run_id, cost_cents, answer, created_at)
        select s.new_id, ${fork.id}::uuid, s.seq::int, s.role, s.body, s.mode,
               null::text, 0::numeric, s.answer, s.created_at
          from src s
      )
      insert into message_citation (message_id, ordinal, source_url, span, title)
      select s.new_id, c.ordinal, c.source_url, c.span, c.title
        from src s
        join message_citation c on c.message_id = s.id`),
  );

  return rowToThread(head);
}

/**
 * FORK A THREAD AT A MESSAGE — the plan's §7, item 2.
 *
 * Perplexity's top UX complaint is a long thread that drifts with no way to cut
 * it, and 015 reserved `forked_from_message_id` for this and then deliberately
 * left it unwritten. This writes it.
 *
 * The fork is a NEW thread carrying the conversation up to and including
 * `uptoSeq` — every message, with its citations — and a pointer back to the
 * message it was cut from. The parent is untouched: forking is not moving.
 *
 * ATOMIC, ALWAYS. A half-copied thread is worse than no fork: a message stored
 * without its citations is an answer whose `[3]` points at nothing, and a
 * thread head with no messages under it is a conversation that never happened.
 * So the whole copy is one transaction, joined to the caller's if there is one.
 */
export async function forkThread(
  threadId: string,
  uptoSeq: number,
  fork: NewFork,
  ex: Executor = db(),
): Promise<ThreadRecord> {
  requireUuid('forkThread', 'threadId', threadId);
  requireUuid('forkThread', 'fork id', fork.id);
  if (!Number.isInteger(uptoSeq) || uptoSeq < 1) {
    throw new ConstraintError(
      `forkThread: seq must be a positive integer, got ${uptoSeq} — positions are 1-based ` +
        'and assigned by appendMessage.',
    );
  }

  if (inTransaction()) return forkInTransaction(threadId, uptoSeq, fork, ex);
  return withTx((tx) => forkInTransaction(threadId, uptoSeq, fork, tx));
}

/* ── small guards ───────────────────────────────────────────────────────── */

function requireUuid(op: string, what: string, value: string): void {
  if (!isUuid(value)) {
    throw new ConstraintError(
      `${op}: ${what} ${value} is not a uuid — mint ids with randomUUID(). Postgres would ` +
        'raise 22P02, and a raised error aborts the whole transaction.',
    );
  }
}

function requireNonBlank(op: string, what: string, value: string): void {
  if (value.trim() === '') {
    throw new ConstraintError(`${op}: ${what} must not be blank`);
  }
}

/** `undefined` and `null` are both "no payload"; only `===` tells them apart. */
const jsonOrNull = (value: AnswerPayload | null | undefined): string | null =>
  value === null || value === undefined ? null : JSON.stringify(value);
