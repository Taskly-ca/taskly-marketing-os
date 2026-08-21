/**
 * An `Executor` that records what it was asked and answers from a script.
 *
 * This is how the SQL gets tested with no database: build the query, assert on
 * `text` and `values`. It sounds like testing the implementation against itself,
 * and would be, except for what it actually pins down — that a value reached
 * `values` rather than the text (the injection guarantee), that the placeholders
 * of a nested fragment were renumbered, that the append-only closers guard their
 * preconditions in the WHERE clause instead of relying on a trigger to raise,
 * and that a method issues the statements it claims to. None of that needs a
 * connection, and all of it is currently unverifiable any other way.
 *
 * Mirrors `createExecutor`'s contracts exactly — `one` throws on anything but
 * one row, `maybeOne` on more than one — so a test cannot pass here in a way it
 * would fail against the real thing.
 */
import type { Executor, QueryRow, SqlQuery } from '@tmos/db';

export interface RecordedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface RecordingExecutor extends Executor {
  /** Every query, in order. */
  readonly queries: RecordedQuery[];
  /** The most recent query; throws if nothing has run. */
  last(): RecordedQuery;
}

/**
 * `responses` is consumed one query at a time, in order. A query past the end
 * of the script gets no rows, which is what an empty table would say.
 */
export function recordingExecutor(
  responses: readonly (readonly QueryRow[])[] = [],
): RecordingExecutor {
  const queries: RecordedQuery[] = [];
  const script = responses.map((rows) => [...rows]);

  const run = (q: SqlQuery): QueryRow[] => {
    queries.push({ text: q.text, values: [...q.values] });
    return script.shift() ?? [];
  };

  return {
    queries,
    last() {
      const q = queries.at(-1);
      if (q === undefined) throw new Error('recordingExecutor: no query has run');
      return q;
    },
    async query<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row[]> {
      return run(q) as Row[];
    },
    async one<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row> {
      const rows = run(q);
      const [first] = rows;
      if (rows.length !== 1 || first === undefined) {
        throw new Error(`expected exactly one row, got ${rows.length}: ${q.text}`);
      }
      return first as Row;
    },
    async maybeOne<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row | null> {
      const rows = run(q);
      if (rows.length > 1) {
        throw new Error(`expected at most one row, got ${rows.length}: ${q.text}`);
      }
      return (rows[0] as Row | undefined) ?? null;
    },
    async execute(q: SqlQuery): Promise<number> {
      return run(q).length;
    },
  };
}
