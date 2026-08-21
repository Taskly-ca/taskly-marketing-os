/**
 * Parameterised queries, and no other kind.
 *
 * The design goal is not "makes escaping easy" — it is that the unsafe path
 * does not exist. `sql` is a tagged template, so every `${}` becomes a `$n`
 * placeholder; `Executor` accepts a `SqlQuery` and nothing else, so a built
 * string has nowhere to go. Composing two fragments is done by nesting a
 * `SqlQuery` inside another (placeholders are renumbered), which removes the
 * last honest reason anyone had to concatenate.
 *
 *   const where = sql`where entity_id = ${id}`;
 *   const rows  = await db().query(sql`select * from fact ${where} limit ${50}`);
 *
 * There is no `sql.raw`. A list goes in as an array against `= any(${ids})`,
 * not as a spliced `in (...)`.
 */
import type { DbClient } from './pool.js';

const SQL_QUERY = Symbol.for('@tmos/db.SqlQuery');

export interface SqlQuery {
  readonly [SQL_QUERY]: true;
  /** Postgres text with `$1`-style placeholders. Never contains a value. */
  readonly text: string;
  readonly values: readonly unknown[];
}

export type QueryRow = Record<string, unknown>;

export function isSqlQuery(value: unknown): value is SqlQuery {
  return typeof value === 'object' && value !== null && SQL_QUERY in value;
}

const renumber = (text: string, offset: number): string =>
  text.replace(/\$(\d+)/g, (_m, n: string) => `$${Number(n) + offset}`);

export function sql(strings: TemplateStringsArray, ...values: readonly unknown[]): SqlQuery {
  // Called as `sql(someString)` rather than as a tag. That is the exact mistake
  // this module exists to prevent, so it fails loudly instead of coercing.
  if (!Array.isArray(strings) || !Array.isArray(strings.raw)) {
    throw new TypeError(
      'sql must be used as a template tag: sql`select ... ${value}`. ' +
        'Passing a string means the value was already concatenated into the query.',
    );
  }

  let text = '';
  const out: unknown[] = [];

  strings.forEach((chunk, i) => {
    text += chunk;
    if (i >= values.length) return;
    const value = values[i];
    if (isSqlQuery(value)) {
      text += renumber(value.text, out.length);
      out.push(...value.values);
    } else {
      out.push(value);
      text += `$${out.length}`;
    }
  });

  return { [SQL_QUERY]: true, text, values: out };
}

/**
 * Runs queries against whatever is underneath — the pool, or one client inside
 * a transaction. Repository code depends on this type and never on `pg`.
 */
export interface Executor {
  query<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row[]>;
  /** Exactly one row, or throws. For lookups by primary key. */
  one<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row>;
  /** Zero or one row. Two is still a bug, and still throws. */
  maybeOne<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row | null>;
  /** Affected row count, for writes whose rows nobody reads. */
  execute(q: SqlQuery): Promise<number>;
}

function assertSqlQuery(q: SqlQuery): void {
  if (!isSqlQuery(q)) {
    throw new TypeError(
      'Executor takes a sql`` query, not a string or a plain object. Build it with ' +
        'the sql template tag so its values are sent as parameters.',
    );
  }
}

export function createExecutor(client: DbClient): Executor {
  const run = async (q: SqlQuery): Promise<QueryRowsAndCount> => {
    assertSqlQuery(q);
    const res = await client.query(q.text, q.values);
    return { rows: res.rows, rowCount: res.rowCount };
  };

  return {
    async query<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row[]> {
      return (await run(q)).rows as Row[];
    },

    async one<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row> {
      const rows = (await run(q)).rows;
      const [first] = rows;
      if (rows.length !== 1 || first === undefined) {
        throw new Error(`expected exactly one row, got ${rows.length}: ${q.text}`);
      }
      return first as Row;
    },

    async maybeOne<Row extends QueryRow = QueryRow>(q: SqlQuery): Promise<Row | null> {
      const rows = (await run(q)).rows;
      if (rows.length > 1) {
        throw new Error(`expected at most one row, got ${rows.length}: ${q.text}`);
      }
      return (rows[0] as Row | undefined) ?? null;
    },

    async execute(q: SqlQuery): Promise<number> {
      const res = await run(q);
      return res.rowCount ?? 0;
    },
  };
}

interface QueryRowsAndCount {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}
