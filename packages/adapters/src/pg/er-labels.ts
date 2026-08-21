/**
 * `LabelStore` (packages/world/src/er/labels.ts) on `er_label` — migration 002,
 * uniqueness fixed by 006.
 *
 * `er_label` is not a log. It is the ER regression suite and the calibration
 * set: every auto-merge threshold is fitted to it and every precision number
 * quoted about entity resolution is computed from it. 006 spends a paragraph on
 * why that makes a second, contradictory row for the same pair worse than no
 * row at all — the set still produces a number, and the number is quietly wrong.
 *
 * ONE THING GOVERNS THIS WHOLE FILE: the memory store's `add()` REPLACES.
 *
 *   rows.set(pairKey(l, r), { ...label, id: rows.get(key)?.id ?? nextId() })
 *
 * So the Postgres one must too, or a re-labelled pair is a second row here and
 * a corrected verdict there. 006's uniqueness is an index over an EXPRESSION —
 * `(least(left_entity, right_entity), greatest(left_entity, right_entity))` —
 * which is what makes the pair undirected without every caller remembering to
 * sort its arguments. A plain `insert` would raise 23505 on the second label;
 * `on conflict (kind, value)` would not compile against it. The conflict target
 * has to be the same pair of expressions, and it is spelled out below.
 *
 * The house rules from `fact-store.ts` hold unchanged: the adapter never reads
 * the clock (`decidedAt` always arrives from the caller, so `decided_at`'s
 * `default now()` is never used), and `ex: Executor = db()` is the LAST
 * parameter of every repository function.
 */
import { db, sql, type Executor, type QueryRow, type SqlQuery } from '@tmos/db';
import type { ErLabel, ErLabelInput, HumanVerdict, LabelStore } from '@tmos/world';

import { ConstraintError, guard } from '../errors.js';
import { asIso, asNumber, asText, asTextOrNull, asUnion, isUuid } from './values.js';

const VERDICTS: readonly HumanVerdict[] = ['match', 'no_match', 'unsure'];

/** uuids cast `::text` in the query, for the same reason the fact adapter does
 *  it: an `ErLabel` id is a string, and casting here means the result does not
 *  depend on a driver type parser that another module can replace. */
const ER_LABEL_COLUMNS = sql`
  id::text as id,
  left_entity::text as left_entity,
  right_entity::text as right_entity,
  score,
  llm_verdict,
  llm_rationale,
  human_verdict,
  decided_by,
  decided_at`;

/**
 * The memory store returns `Map` insertion order. `decided_at` is the only
 * column that records anything like it, with the id as a deterministic
 * tiebreak — inside one transaction `now()` is frozen, but `decidedAt` comes
 * from the caller here, so ties are only as common as the caller makes them.
 *
 * Nothing in `labels.ts` depends on order: `calibrate` sorts its own
 * candidates, `thresholdReport` is a fold, and `regressionSuite` is a map.
 */
const ER_LABEL_ORDER = sql`order by decided_at, id`;

/**
 * The undirected pair predicate, written so it matches `er_label_pair_uidx`
 * expression-for-expression — that index is the only thing that can serve it,
 * and a differently-spelled equivalent (`(l=$1 and r=$2) or (l=$2 and r=$1)`)
 * would be correct and unindexed.
 */
const samePair = (left: string, right: string): SqlQuery => sql`
  least(left_entity, right_entity) = least(${left}::uuid, ${right}::uuid)
    and greatest(left_entity, right_entity) = greatest(${left}::uuid, ${right}::uuid)`;

export function rowToErLabel(row: QueryRow): ErLabel {
  const id = asText(row.id, 'er_label.id');
  const at = (column: string): string => `er_label[${id}].${column}`;

  return {
    id,
    leftEntity: asText(row.left_entity, at('left_entity')),
    rightEntity: asText(row.right_entity, at('right_entity')),
    score: asNumber(row.score, at('score')),
    llmVerdict: asTextOrNull(row.llm_verdict, at('llm_verdict')),
    llmRationale: asTextOrNull(row.llm_rationale, at('llm_rationale')),
    humanVerdict: asUnion(row.human_verdict, VERDICTS, at('human_verdict')),
    decidedBy: asText(row.decided_by, at('decided_by')),
    decidedAt: asIso(row.decided_at, at('decided_at')),
  };
}

/**
 * `LabelStore.add`, and it is an UPSERT — see the file header.
 *
 * Two preconditions are checked HERE rather than left to the database, for the
 * same reason `fact-store.ts` guards its closers in the WHERE clause: `@tmos/db`
 * has no savepoints, so a raised exception aborts the caller's whole
 * transaction and every later statement in it fails with "current transaction
 * is aborted". A labelling UI submitting a batch would lose the batch, not the
 * row. Both checks reproduce a rule the database also enforces, so a writer
 * that bypasses this function still cannot corrupt the set:
 *
 *   · a non-uuid id would raise 22P02. The memory store takes any string.
 *   · a self-pair would raise 006's `er_label_not_self`. The memory store
 *     accepts it, and it would hand the calibration set a free true positive.
 *
 * `do update` also rewrites `left_entity`/`right_entity` from `excluded`, so a
 * re-label submitted as (B,A) after (A,B) stores the orientation the human
 * actually saw — exactly what the memory store does, and legal because
 * least/greatest are unchanged by the swap.
 */
export async function upsertErLabel(label: ErLabelInput, ex: Executor = db()): Promise<ErLabel> {
  const { leftEntity, rightEntity } = label;

  for (const [side, id] of [['leftEntity', leftEntity], ['rightEntity', rightEntity]] as const) {
    if (!isUuid(id)) {
      throw new ConstraintError(
        `add: ${side} ${JSON.stringify(id)} is not a uuid — er_label.${side === 'leftEntity' ? 'left' : 'right'}_entity ` +
          'references entity(id). The in-memory store takes any string; Postgres does not.',
      );
    }
  }
  if (leftEntity.toLowerCase() === rightEntity.toLowerCase()) {
    throw new ConstraintError(
      `add: ${leftEntity} labelled against itself — migration 006's er_label_not_self rejects a ` +
        'self-pair, because it is always a mistake and it inflates precision with a free true ' +
        'positive. The in-memory store accepts it.',
    );
  }

  return guard('add', async () =>
    rowToErLabel(
      await ex.one(sql`
        insert into er_label (
          left_entity, right_entity, score,
          llm_verdict, llm_rationale, human_verdict, decided_by, decided_at
        ) values (
          ${leftEntity}::uuid, ${rightEntity}::uuid, ${label.score},
          ${label.llmVerdict}, ${label.llmRationale}, ${label.humanVerdict},
          ${label.decidedBy}, ${label.decidedAt}::timestamptz
        )
        on conflict (least(left_entity, right_entity), greatest(left_entity, right_entity))
        do update set
          left_entity   = excluded.left_entity,
          right_entity  = excluded.right_entity,
          score         = excluded.score,
          llm_verdict   = excluded.llm_verdict,
          llm_rationale = excluded.llm_rationale,
          human_verdict = excluded.human_verdict,
          decided_by    = excluded.decided_by,
          decided_at    = excluded.decided_at
        returning ${ER_LABEL_COLUMNS}`),
    ),
  );
}

/**
 * Every label. Unbounded on purpose and NOT capped: `calibrate` refuses below
 * 50 usable labels and `regressionSuite` replays all of them, so a silently
 * truncated read would move a threshold rather than fail. The table is a human
 * review queue — its size is bounded by how many verdicts people have typed.
 */
export async function allErLabels(ex: Executor = db()): Promise<ErLabel[]> {
  return guard('all', async () => {
    const rows = await ex.query(sql`select ${ER_LABEL_COLUMNS} from er_label ${ER_LABEL_ORDER}`);
    return rows.map(rowToErLabel);
  });
}

/** A malformed id is a MISS, never an error — see `factById` for the argument. */
export async function erLabelByPair(
  left: string,
  right: string,
  ex: Executor = db(),
): Promise<ErLabel | null> {
  if (!isUuid(left) || !isUuid(right)) return null;

  return guard('byPair', async () => {
    const row = await ex.maybeOne(
      sql`select ${ER_LABEL_COLUMNS} from er_label where ${samePair(left, right)}`,
    );
    return row === null ? null : rowToErLabel(row);
  });
}

/** See `createPostgresFactStore` — `executor` is resolved per call, never captured. */
export function createPostgresLabelStore(executor?: Executor): LabelStore {
  const ex = (): Executor => executor ?? db();

  return {
    add: (label) => upsertErLabel(label, ex()),
    all: () => allErLabels(ex()),
    byPair: (left, right) => erLabelByPair(left, right, ex()),
  };
}
