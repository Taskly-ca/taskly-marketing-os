/**
 * The one `pg.Pool` in the process.
 *
 * A pool per module is the classic way to exhaust a Postgres connection limit —
 * Supabase's pooler counts connections, not processes, and the failure looks
 * like unrelated timeouts elsewhere. So: one lazy singleton, and a `closePool()`
 * that test teardown can call without knowing who opened it.
 */
import { Pool } from 'pg';

import { loadDbConfig, type DbConfig } from './config.js';

/** Shape of a driver result, narrowed to what this package uses. */
export interface QueryResultLike {
  readonly rows: readonly unknown[];
  readonly rowCount: number | null;
}

/**
 * The LOW-LEVEL port: raw text in, rows out.
 *
 * Only two callers are allowed to speak it — the transaction bookkeeping
 * (`BEGIN`/`COMMIT`/`ROLLBACK`) and the migration runner (a `.sql` file is a
 * multi-statement script and cannot be parameterised). Everything else gets an
 * `Executor`, which accepts nothing but a `sql` template.
 */
export interface DbClient {
  query(text: string, values?: readonly unknown[]): Promise<QueryResultLike>;
}

export interface PooledClient extends DbClient {
  release(err?: Error | boolean): void;
}

export type Connect = () => Promise<PooledClient>;

let pool: Pool | null = null;

/**
 * The pool, built on first use.
 *
 * `config` is read ONLY when there is no pool yet — deliberately, because the
 * default argument is `loadDbConfig()` and a default argument is evaluated on
 * every call that omits it. Written as `config: DbConfig = loadDbConfig()`, a
 * process that built its pool from an explicit config would then throw
 * "DATABASE_URL is required" on the next query. Caught by probe, 2026-08-22.
 */
export function getPool(config?: DbConfig): Pool {
  if (pool !== null) return pool;

  const cfg = config ?? loadDbConfig();
  pool = new Pool({
    connectionString: cfg.url,
    ssl: cfg.ssl,
    max: cfg.poolMax,
    connectionTimeoutMillis: cfg.connectionTimeoutMs,
    idleTimeoutMillis: 30_000,
    // Server-side ceilings. `query_timeout` (client-side) is deliberately NOT
    // set: it abandons the socket while the server keeps burning the query, and
    // it would also kill a legitimately long migration.
    statement_timeout: cfg.statementTimeoutMs,
    idle_in_transaction_session_timeout: cfg.statementTimeoutMs,
    application_name: 'tmos',
  });

  // An idle client that errors (server restart, pooler eviction) emits on the
  // pool. Without a listener, Node treats it as an unhandled 'error' event and
  // takes the process down.
  pool.on('error', (err) => {
    console.error('[@tmos/db] idle client error:', err.message);
  });

  return pool;
}

/** Checks out a connection. The default `connect` for `withTx`. */
export const connectFromPool: Connect = async () => {
  const client = await getPool().connect();
  return {
    query: (text, values) => client.query(text, values ? [...values] : undefined),
    release: (err) => client.release(err),
  };
};

/** The pool itself as a client — one statement, no checkout, no transaction. */
export function poolClient(): DbClient {
  return {
    query: (text, values) => getPool().query(text, values ? [...values] : undefined),
  };
}

/** Idempotent. Safe to call in `afterAll` whether or not a pool was opened. */
export async function closePool(): Promise<void> {
  const open = pool;
  pool = null;
  if (open !== null) await open.end();
}
