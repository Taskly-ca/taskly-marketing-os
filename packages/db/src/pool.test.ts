import { describe, it, expect, afterEach } from 'vitest';
import { getPool, closePool } from './pool.js';
import { loadDbConfig } from './config.js';

// `new Pool()` opens no socket — it connects lazily on the first query — so the
// singleton's wiring is checkable without a database.
const cfg = loadDbConfig({
  DATABASE_URL: 'postgresql://user:pw@db.abcdefgh.supabase.co:5432/postgres',
  DATABASE_POOL_MAX: '3',
  DATABASE_STATEMENT_TIMEOUT_MS: '7000',
});

afterEach(async () => {
  await closePool();
});

describe('pool', () => {
  it('carries the config into the driver', () => {
    const pool = getPool(cfg);
    expect(pool.options.max).toBe(3);
    expect(pool.options.statement_timeout).toBe(7_000);
    expect(pool.options.idle_in_transaction_session_timeout).toBe(7_000);
    expect(pool.options.connectionTimeoutMillis).toBe(10_000);
    expect(pool.options.ssl).toEqual({ rejectUnauthorized: false });
    // A client-side query_timeout would abort a long migration and abandon a
    // query the server keeps running. Server-side timeouts only.
    expect(pool.options.query_timeout).toBeUndefined();
  });

  it('is a singleton', () => {
    expect(getPool(cfg)).toBe(getPool(cfg));
  });

  it('does NOT re-read the environment once built', () => {
    const first = getPool(cfg);
    // No DATABASE_URL in this process. If the argument default were
    // `loadDbConfig()` it would be evaluated here and throw.
    expect(getPool()).toBe(first);
  });

  it('closePool() is idempotent and lets the next call rebuild', async () => {
    const first = getPool(cfg);
    await closePool();
    await closePool();
    expect(getPool(cfg)).not.toBe(first);
  });
});
