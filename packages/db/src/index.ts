/**
 * @tmos/db — the only Postgres access layer in this repo.
 *
 * Four things, and nothing else:
 *
 *   loadDbConfig()  typed env, no localhost fallback
 *   getPool()       one pool per process, TLS + timeouts decided from the URL
 *   sql`` / db()    parameterised queries; a built string has nowhere to go
 *   withTx()        BEGIN/COMMIT/ROLLBACK, nesting reuses the outer transaction
 *   migrate()       ordered, idempotent, checksum-enforced
 *
 * Repositories depend on `Executor`, take it as a defaulted parameter
 * (`ex: Executor = db()`), and stay composable inside someone else's
 * transaction without knowing they are in one.
 */
export * from './config.js';
export * from './pool.js';
export * from './sql.js';
export * from './tx.js';
export * from './migrate.js';
