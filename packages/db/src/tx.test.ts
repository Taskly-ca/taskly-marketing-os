import { describe, it, expect } from 'vitest';
import { withTx, db, inTransaction } from './tx.js';
import { sql } from './sql.js';
import type { PooledClient } from './pool.js';

/**
 * A fake pooled client. The whole point of `withTx` is the ORDER of the
 * bookkeeping statements, and that is observable without a database.
 */
function fakePool(opts: { failOn?: string } = {}) {
  const calls: string[] = [];
  const releasedWith: (Error | boolean | undefined)[] = [];
  let connects = 0;
  let releases = 0;
  const connect = async (): Promise<PooledClient> => {
    connects += 1;
    return {
      async query(text: string) {
        calls.push(text);
        if (opts.failOn === text) throw new Error(`boom: ${text}`);
        return { rows: [], rowCount: 0 };
      },
      release(err) {
        releases += 1;
        releasedWith.push(err);
      },
    };
  };
  return {
    connect,
    calls,
    releasedWith,
    get connects() {
      return connects;
    },
    get releases() {
      return releases;
    },
  };
}

describe('withTx', () => {
  it('BEGINs, runs the body, COMMITs, releases', async () => {
    const p = fakePool();
    const out = await withTx(async (tx) => {
      await tx.query(sql`select ${1} as n`);
      return 'done';
    }, p);

    expect(out).toBe('done');
    expect(p.calls).toEqual(['BEGIN', 'select $1 as n', 'COMMIT']);
    expect(p.releases).toBe(1);
  });

  it('ROLLBACKs and rethrows when the body throws', async () => {
    const p = fakePool();
    await expect(
      withTx(async () => {
        throw new Error('body failed');
      }, p),
    ).rejects.toThrow('body failed');

    expect(p.calls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(p.releases).toBe(1);
  });

  it('does not let a failed ROLLBACK mask the original error', async () => {
    const p = fakePool({ failOn: 'ROLLBACK' });
    await expect(
      withTx(async () => {
        throw new Error('the real cause');
      }, p),
    ).rejects.toThrow('the real cause');
    expect(p.releases).toBe(1);
    // The session may still be inside a transaction. It must be destroyed, not
    // returned to the pool for the next caller to inherit.
    expect(p.releasedWith).toEqual([true]);
  });

  it('returns a healthy connection to the pool untouched', async () => {
    const p = fakePool();
    await withTx(async () => {}, p);
    expect(p.releasedWith).toEqual([undefined]);
  });

  it('NESTS by reusing the outer transaction — one BEGIN, one connection', async () => {
    const p = fakePool();
    let innerSawSameExecutor = false;

    await withTx(async (outer) => {
      await withTx(async (inner) => {
        innerSawSameExecutor = inner === outer;
        await inner.query(sql`select ${'inner'} as who`);
      }, p);
      await outer.query(sql`select ${'outer'} as who`);
    }, p);

    expect(innerSawSameExecutor).toBe(true);
    expect(p.calls).toEqual(['BEGIN', 'select $1 as who', 'select $1 as who', 'COMMIT']);
    expect(p.calls.filter((c) => c === 'BEGIN')).toHaveLength(1);
    expect(p.connects).toBe(1);
    expect(p.releases).toBe(1);
  });

  it('rolls back ONCE when a nested body throws', async () => {
    const p = fakePool();
    await expect(
      withTx(async () => {
        await withTx(async () => {
          throw new Error('inner failed');
        }, p);
      }, p),
    ).rejects.toThrow('inner failed');

    expect(p.calls).toEqual(['BEGIN', 'ROLLBACK']);
    expect(p.connects).toBe(1);
    expect(p.releases).toBe(1);
  });

  it('a nested call never opens a second connection, even with its own connect', async () => {
    const outerPool = fakePool();
    const innerPool = fakePool();
    await withTx(async () => {
      await withTx(async () => {}, innerPool);
    }, outerPool);

    expect(innerPool.connects).toBe(0);
    expect(outerPool.calls).toEqual(['BEGIN', 'COMMIT']);
  });

  it('db() inside a transaction IS the transaction — repositories need no plumbing', async () => {
    const p = fakePool();
    expect(inTransaction()).toBe(false);
    await withTx(async (tx) => {
      expect(inTransaction()).toBe(true);
      expect(db()).toBe(tx);
      await db().query(sql`select ${1} as n`);
    }, p);
    expect(inTransaction()).toBe(false);
    expect(p.calls).toEqual(['BEGIN', 'select $1 as n', 'COMMIT']);
  });

  it('leaves no ambient transaction behind after a failure', async () => {
    const p = fakePool();
    await expect(
      withTx(async () => {
        throw new Error('x');
      }, p),
    ).rejects.toThrow();
    expect(inTransaction()).toBe(false);
  });
});
