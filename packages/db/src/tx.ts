/**
 * Transactions, and the ambient executor.
 *
 * `withTx` is the only way to open one. Nesting reuses the outer transaction
 * rather than opening a second connection — two connections cannot see each
 * other's uncommitted rows, so a "nested" transaction on its own connection
 * deadlocks against its parent or silently commits half the work. Reuse is the
 * only behaviour that is ever correct here; there are deliberately no
 * savepoints, because a partial rollback inside a caller that thinks it is
 * atomic is the same bug wearing a hat.
 *
 * `db()` returns the transaction when there is one and the pool when there is
 * not, so a repository function composes either way without a client parameter
 * threaded through every signature:
 *
 *   export const insertFact = (row: FactRow, ex: Executor = db()) => ex.one(sql`...`);
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import { connectFromPool, poolClient, type Connect } from './pool.js';
import { createExecutor, type Executor } from './sql.js';

const current = new AsyncLocalStorage<Executor>();

/** The executor in scope: the open transaction, or the pool. */
export function db(): Executor {
  return current.getStore() ?? createExecutor(poolClient());
}

export function inTransaction(): boolean {
  return current.getStore() !== undefined;
}

/** Injection seam for tests. Production passes nothing. */
export interface TxDeps {
  readonly connect?: Connect;
}

export async function withTx<T>(fn: (tx: Executor) => Promise<T>, deps: TxDeps = {}): Promise<T> {
  const outer = current.getStore();
  if (outer !== undefined) return fn(outer);

  const client = await (deps.connect ?? connectFromPool)();
  const tx = createExecutor(client);
  let broken = false;

  try {
    await client.query('BEGIN');
    const result = await current.run(tx, () => fn(tx));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // Never let cleanup replace the cause — the original error is what the
      // caller needs. But the session is now in an unknown state, possibly
      // still inside a transaction, so it must be destroyed rather than handed
      // to the next borrower.
      broken = true;
      console.error('[@tmos/db] ROLLBACK failed:', (rollbackError as Error).message);
    }
    throw error;
  } finally {
    client.release(broken || undefined);
  }
}
