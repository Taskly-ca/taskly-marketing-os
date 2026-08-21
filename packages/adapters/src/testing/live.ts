/**
 * The live harness: a real database, and nothing left behind.
 *
 * `inRollback` is the whole idea — every live test runs inside a transaction
 * that is deliberately aborted, so the assertions see real triggers, real
 * foreign keys and real type coercion, and the database ends the run at exactly
 * the row count it started with. The migration agent used `begin; … rollback;`
 * throughout for the same reason.
 *
 * TWO CONSEQUENCES OF TESTING INSIDE A TRANSACTION, both load-bearing:
 *
 *   `now()` IS FROZEN for its entire duration. Every `default now()` in the
 *   schema, and every `now()` this package writes, therefore returns the same
 *   instant to every statement in a case. That is not an artefact of testing —
 *   it is exactly what the worker will experience when it asserts and closes a
 *   fact in one unit of work, which is why the adapter takes every instant from
 *   its caller and never reads the clock itself.
 *
 *   AN ERROR POISONS THE REST OF THE TRANSACTION. `@tmos/db` has no savepoints
 *   by design, so once Postgres raises, every later statement in the same case
 *   fails with "current transaction is aborted". A case that expects a
 *   constraint to fire must expect nothing after it.
 */
import { sql, withTx, type Executor } from '@tmos/db';

import type { FactStoreFixtures } from './fact-store.conformance.js';
import type { PredicateStoreFixtures } from './predicate-store.conformance.js';

/**
 * Read once, at import. The live suites decide whether to skip from this, so it
 * has to be settled before any test body runs — `vitest.live.config.ts` puts
 * the repo `.env` into `process.env` before importing a single test file.
 */
export const HAS_DATABASE = Boolean(process.env.DATABASE_URL);

/** Runs `fn` in a transaction and always rolls it back. Its value still returns. */
export async function inRollback<T>(fn: (tx: Executor) => Promise<T>): Promise<T> {
  const rollback = new Error('tmos: intentional rollback');
  let result: T | undefined;
  let ran = false;

  try {
    await withTx(async (tx) => {
      result = await fn(tx);
      ran = true;
      // The only way to make `withTx` roll back is to throw out of it, which is
      // correct: there is no "commit nothing" and there should not be.
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  }

  if (!ran) throw new Error('inRollback: body did not complete');
  return result as T;
}

const CONF = 'tmos_conf';

async function insertSource(tx: Executor, name: string): Promise<string> {
  const row = await tx.one<{ id: string }>(sql`
    insert into source (kind, name, tier, region)
    values ('test', ${`${CONF}_${name}`}, 'first_party', 'ca')
    returning id::text as id`);
  return row.id;
}

async function insertEntity(tx: Executor, name: string): Promise<string> {
  const row = await tx.one<{ id: string }>(sql`
    insert into entity (entity_type, name, name_norm, region)
    values ('company', ${name}, ${name.toLowerCase()}, 'ca')
    returning id::text as id`);
  return row.id;
}

async function insertPredicateDef(tx: Executor, predicate: string, datatype: string): Promise<void> {
  await tx.execute(sql`
    insert into predicate_def (predicate, entity_type, datatype, description)
    values (${predicate}, 'company', ${datatype}, 'conformance fixture')
    on conflict (predicate) do nothing`);
}

/**
 * `fact` has three foreign keys — entity, predicate and source — so the rows
 * the memory store never needed have to exist before a single fact can be
 * written. All of them vanish with the rollback.
 */
export async function seedFactFixtures(tx: Executor): Promise<FactStoreFixtures> {
  // Sequential, not `Promise.all`: a transaction is ONE connection, and
  // node-postgres queues concurrent queries on it anyway. Writing it as
  // parallel would only advertise a concurrency that does not exist.
  const sourceId = await insertSource(tx, 'facts');
  const entityId = await insertEntity(tx, `${CONF} Entity A`);
  const otherEntityId = await insertEntity(tx, `${CONF} Entity B`);

  const predicate = `${CONF}_fact_alpha`;
  const otherPredicate = `${CONF}_fact_beta`;
  await insertPredicateDef(tx, predicate, 'num');
  await insertPredicateDef(tx, otherPredicate, 'text');

  return { entityId, otherEntityId, predicate, otherPredicate, sourceId };
}

export async function seedPredicateFixtures(tx: Executor): Promise<PredicateStoreFixtures> {
  const sourceA = await insertSource(tx, 'predicates_a');
  const sourceB = await insertSource(tx, 'predicates_b');
  return { entityType: 'company', sourceA, sourceB };
}
