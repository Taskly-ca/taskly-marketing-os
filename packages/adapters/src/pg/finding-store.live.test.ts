/**
 * `FindingStore` against the real database. Opt-in, never run by CI.
 *
 *   DATABASE_URL=postgres://… pnpm test:live
 *
 * Beyond the shared conformance array, four things cannot be checked anywhere
 * else, and each corresponds to a decision made in the adapter:
 *
 *   · `claimFold` exists TWICE — once in TypeScript, once in SQL — and the
 *     second one is only justified because this file proves they agree. The
 *     inputs below are chosen to break it: the failure mode is a database whose
 *     `lower()` is C-locale, where a character that lowercases INTO ascii is
 *     left alone and the fold silently stops matching.
 *   · the dedupe key has NO unique index behind it, so "the duplicate is found"
 *     is a property of a scan this adapter writes, not of a constraint.
 *   · `chain` is a recursive CTE, and its cycle guard can only be exercised by
 *     making a cycle — which the port refuses to create and raw SQL will.
 *   · `finding`'s CHECK constraints (`>= 1` evidence, `causal_rung` 0–4,
 *     `domain_score` 0–1) are the database's opinion of a `Finding`, and the
 *     adapter's job is to never let one of them raise.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, sql } from '@tmos/db';

import { HAS_DATABASE, inRollback } from '../testing/live.js';
import {
  FINDING_STORE_CONFORMANCE,
  conformanceFinding,
  evidenceRef,
  makeFindingFixtures,
} from '../testing/finding.conformance.js';
import {
  claimFold,
  claimFoldSql,
  createPostgresFindingStore,
  findingChain,
} from './finding-store.js';

afterAll(async () => {
  if (HAS_DATABASE) await closePool();
});

describe.skipIf(!HAS_DATABASE)('FindingStore conformance — postgres', () => {
  for (const testCase of FINDING_STORE_CONFORMANCE) {
    it(testCase.name, async () => {
      await inRollback(async (tx) => {
        await testCase.run(createPostgresFindingStore(tx), makeFindingFixtures());
      });
    });
  }
});

describe.skipIf(!HAS_DATABASE)('the SQL fold agrees with the TypeScript one', () => {
  // Everything the narrowing filter has to survive: separators, punctuation,
  // case, and the three classes of character where `lower()` and
  // `String.prototype.toLowerCase` can genuinely disagree.
  const CLAIMS = [
    'Jiffy raised list prices to $129',
    'jiffy  raised   list prices to $129.',
    '   JIFFY RAISED LIST PRICES TO $129!!!   ',
    'dots...and---dashes',
    'MiXeD_CaSe',
    'ünïcode and émojis 🎉',
    'Ünïcode And Émojis 🎉',
    // U+212A KELVIN SIGN and U+0130 LATIN CAPITAL I WITH DOT ABOVE: both
    // lowercase INTO ascii under Unicode's simple mapping, and both are left
    // untouched by a C-locale `lower()`. If this test fails, that is why.
    'temperature K rising',
    'İstanbul pricing',
    '',
    '!!!',
    '123',
  ];

  it('produces the same string for every input, or the filter silently misses duplicates', async () => {
    await inRollback(async (tx) => {
      for (const claim of CLAIMS) {
        const row = await tx.one<{ folded: string }>(
          sql`select ${claimFoldSql(sql`${claim}::text`)} as folded`,
        );
        expect(row.folded, `input: ${JSON.stringify(claim)}`).toBe(claimFold(claim));
      }
    });
  });
});

describe.skipIf(!HAS_DATABASE)('what only the database can say', () => {
  it('finds a duplicate through the scan, with no unique index to help it', async () => {
    await inRollback(async (tx) => {
      const fx = makeFindingFixtures();
      const store = createPostgresFindingStore(tx);
      const first = await store.put(conformanceFinding(fx));
      expect(first.ok && first.stored).toBe(true);

      // Case, whitespace, punctuation and a tracking parameter — every one of
      // them folded away by a different half of the key.
      const noisy = await store.put(
        conformanceFinding(fx, {
          claim: `  ${conformanceFinding(fx).claim.toUpperCase().replace(/ /g, '  ')}.  `,
          evidence: [
            evidenceRef(
              `https://www.${new URL(fx.docUrl).host}${new URL(fx.docUrl).pathname}/?utm=1#x`,
            ),
          ],
        }),
      );
      expect(noisy.ok && !noisy.stored).toBe(true);

      // …and exactly one row exists, which is the property the missing unique
      // index cannot enforce for us.
      const row = await tx.one<{ n: string }>(sql`
        select count(*) as n from finding where ${claimFoldSql(sql`claim`)} = ${claimFold(conformanceFinding(fx).claim)}`);
      expect(Number(row.n)).toBe(1);
    });
  });

  it('takes a transaction-scoped advisory lock, and releases it with the transaction', async () => {
    await inRollback(async (tx) => {
      const fx = makeFindingFixtures();
      await createPostgresFindingStore(tx).put(conformanceFinding(fx));

      // The lock is the only thing standing between two workers skimming the
      // same article and two identical rows.
      const row = await tx.one<{ n: string }>(
        sql`select count(*) as n from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()`,
      );
      expect(Number(row.n)).toBeGreaterThanOrEqual(1);
    });
  });

  it('still deduplicates against a finding that has since been superseded', async () => {
    await inRollback(async (tx) => {
      const fx = makeFindingFixtures();
      const store = createPostgresFindingStore(tx);
      const original = conformanceFinding(fx);
      await store.put(original);

      const replacement = conformanceFinding(fx, { claim: `${fx.claimPrefix}: v2` });
      expect((await store.supersede(original.id, replacement, 'corrected')).ok).toBe(true);

      // Re-skimming the same article must not mint the closed claim again —
      // the memory store's key map is never pruned either.
      const again = await store.put(conformanceFinding(fx));
      expect(again.ok && !again.stored).toBe(true);
    });
  });

  it('terminates on a supersession CYCLE instead of spinning the server', async () => {
    await inRollback(async (tx) => {
      const fx = makeFindingFixtures();
      const store = createPostgresFindingStore(tx);
      const a = conformanceFinding(fx);
      const b = conformanceFinding(fx, { claim: `${fx.claimPrefix}: v2` });
      await store.put(a);
      expect((await store.supersede(a.id, b, 'corrected')).ok).toBe(true);

      // The port refuses self-supersession and would refuse this too; raw SQL
      // does not, and a cycle in the data must not become a hung query.
      await tx.execute(sql`
        update finding set superseded_by = ${a.id}::uuid, supersede_reason = 'loop'
         where id = ${b.id}::uuid`);

      expect((await findingChain(a.id, tx)).map((f) => f.id)).toEqual([a.id, b.id]);
    });
  });

  it('never lets a CHECK constraint raise: the schema check refuses first', async () => {
    await inRollback(async (tx) => {
      const fx = makeFindingFixtures();
      const store = createPostgresFindingStore(tx);

      // `finding_needs_evidence` would raise P0001-class noise and abort the
      // whole transaction; `invalid_finding` is a result the caller can act on.
      const noEvidence = await store.put(conformanceFinding(fx, { evidence: [] }));
      expect(noEvidence.ok === false && noEvidence.reason).toBe('invalid_finding');

      // The transaction is still usable — which is the entire point.
      const good = await store.put(conformanceFinding(fx));
      expect(good.ok && good.stored).toBe(true);
    });
  });

  it('round-trips numeric, text[] and jsonb exactly', async () => {
    await inRollback(async (tx) => {
      const fx = makeFindingFixtures();
      const store = createPostgresFindingStore(tx);
      const finding = conformanceFinding(fx, {
        domain_score: 0.125,
        subject_refs: [fx.subject, fx.otherSubject, 'market:gta'],
        evidence: [
          evidenceRef(fx.docUrl, {
            signal_id: randomUUID(),
            span: 'a span with "quotes" and \\ backslash',
          }),
          evidenceRef(fx.otherDocUrl, { fact_id: randomUUID() }),
        ],
      });

      const stored = await store.put(finding);
      expect(stored.ok && stored.stored).toBe(true);
      expect(await store.byId(finding.id)).toEqual(finding);
    });
  });
});
