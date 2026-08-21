/**
 * The `FindingStore` conformance suite.
 *
 * Every case runs against a FRESH store, so nothing here may depend on what
 * another case left behind. Four constraints shape the assertions:
 *
 *   · ids are supplied by the caller, so they must be real uuids, and
 *     `subject_refs` must match the contract's `type:id` regex — the memory
 *     store validates with the same Zod schema the database's CHECK
 *     constraints mirror, so an invalid fixture fails both, differently.
 *   · nothing asserts row ORDER except where `created_at` differs. The memory
 *     store breaks ties by insertion; `finding` has no insertion counter.
 *   · nothing asserts `recent()`'s or `unsuperseded()`'s absolute contents
 *     against a real database, which does not start empty. Cases filter to
 *     their own fixtures.
 *   · nothing mutates a row and expects isolation: `createMemoryFindingStore`'s
 *     `byId` returns the STORED object, not a copy, while Postgres necessarily
 *     returns a new one. That divergence is in the README rather than here,
 *     because a case asserting either behaviour would fail against the other.
 *
 * `finding` has exactly one foreign key — `superseded_by references
 * finding(id)` — and it is satisfied by the order `supersede` writes in, so
 * there is nothing to seed and the fixtures are values rather than rows.
 */
import { randomUUID } from 'node:crypto';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import type { EvidenceRef, Finding } from '@tmos/contracts';
import type { FindingStore } from '@tmos/reason';

import { ABSENT_UUID, type ConformanceCase } from './conformance.js';

export interface FindingStoreFixtures {
  /** `type:id`, per `subjectRefSchema`. */
  readonly subject: string;
  readonly otherSubject: string;
  /** Prefixes every claim, so a case never collides with a real row's dedupe key. */
  readonly claimPrefix: string;
  readonly docUrl: string;
  readonly otherDocUrl: string;
}

export type FindingStoreCase = ConformanceCase<FindingStore, FindingStoreFixtures>;

export function makeFindingFixtures(): FindingStoreFixtures {
  const slug = randomUUID().slice(0, 8);
  return {
    subject: `company:conf-${slug}`,
    otherSubject: `company:other-${slug}`,
    claimPrefix: `tmos conf ${slug}`,
    docUrl: `https://example.test/${slug}/pricing`,
    otherDocUrl: `https://example.test/${slug}/hiring`,
  };
}

const T0 = '2026-07-01T00:00:00.000Z';
const T1 = '2026-07-15T00:00:00.000Z';
const T2 = '2026-08-01T00:00:00.000Z';

export const evidenceRef = (url: string, over: Partial<EvidenceRef> = {}): EvidenceRef => ({
  signal_id: null,
  fact_id: null,
  source_url: url,
  span: 'list prices rose to $129 in July',
  observed_at: T0,
  ...over,
});

export const conformanceFinding = (
  fx: FindingStoreFixtures,
  over: Partial<Finding> = {},
): Finding => ({
  id: randomUUID(),
  claim: `${fx.claimPrefix}: list prices rose to $129`,
  so_what: 'their entry price now sits above ours in the same postal codes',
  subject_refs: [fx.subject],
  evidence: [evidenceRef(fx.docUrl)],
  basis: 'inferred_from_sources',
  causal_rung: 0,
  stakes: 'medium',
  region: 'ca',
  domain_score: 0.62,
  generated_by: 'agent:conformance@1',
  reviewed_by: null,
  superseded_by: null,
  supersede_reason: null,
  created_at: T1,
  ...over,
});

const ids = (rows: readonly Finding[]): string[] => rows.map((f) => f.id).sort();

/** `put`, asserting it stored rather than deduplicated. Most cases need a row, not a result. */
async function store1(store: FindingStore, finding: Finding): Promise<Finding> {
  const result = await store.put(finding);
  ok(result.ok && result.stored, `expected a stored finding, got ${JSON.stringify(result)}`);
  return result.finding;
}

export const FINDING_STORE_CONFORMANCE: readonly FindingStoreCase[] = [
  {
    name: 'put stores the finding it was given, and byId reads it back identically',
    async run(store, fx) {
      const f = conformanceFinding(fx, {
        reviewed_by: 'human:nishant',
        subject_refs: [fx.subject, fx.otherSubject],
        evidence: [evidenceRef(fx.docUrl), evidenceRef(fx.otherDocUrl, { span: 'and hiring' })],
      });

      const stored = await store1(store, f);
      deepStrictEqual(stored, f);
      deepStrictEqual(await store.byId(f.id), f);
    },
  },

  {
    name: 'byId returns null for an id nothing holds — it does not throw',
    async run(store) {
      strictEqual(await store.byId(ABSENT_UUID), null);
    },
  },

  {
    name: 'the same claim from the same document is a DUPLICATE, and the original comes back',
    async run(store, fx) {
      const original = await store1(store, conformanceFinding(fx));

      // A re-skim: new id, reworded consequence, different score, different
      // generator. None of those are in the dedupe key, on purpose.
      const again = await store.put(
        conformanceFinding(fx, {
          so_what: 'reworded on a later pass',
          domain_score: 0.9,
          generated_by: 'agent:conformance@2',
          created_at: T2,
        }),
      );

      ok(again.ok && !again.stored, 'a re-skim is a normal outcome, not a failure');
      deepStrictEqual(again.duplicateOf, original);
    },
  },

  {
    name: 'the claim is normalised: case, whitespace and trailing punctuation do not make a new finding',
    async run(store, fx) {
      const base = conformanceFinding(fx);
      await store1(store, base);

      // Upper-cased, every space doubled, wrapped in padding, and a full stop
      // added — exactly the four things `normalizeClaim` folds away.
      const noisy = await store.put(
        conformanceFinding(fx, { claim: `  ${base.claim.toUpperCase().replace(/ /g, '  ')}.  ` }),
      );
      ok(noisy.ok && !noisy.stored, 'punctuation and case are not new information');
    },
  },

  {
    name: 'evidence identity is the DOCUMENT, not the quotation or the tracking parameters',
    async run(store, fx) {
      await store1(store, conformanceFinding(fx));

      // Same page: `www.`, a query string and a fragment added, trailing slash,
      // and a span the model chose differently on this pass.
      const withNoise = new URL(fx.docUrl);
      const noisyUrl = `https://www.${withNoise.host}${withNoise.pathname}/?utm_source=x#section-2`;

      const again = await store.put(
        conformanceFinding(fx, {
          evidence: [evidenceRef(noisyUrl, { span: 'a different sentence' })],
        }),
      );
      ok(again.ok && !again.stored, 'one document must not yield a new finding per pass');
    },
  },

  {
    name: 'the same claim from a DIFFERENT document is a second sighting, and is stored',
    async run(store, fx) {
      const first = await store1(store, conformanceFinding(fx));
      const second = await store1(
        store,
        conformanceFinding(fx, { evidence: [evidenceRef(fx.otherDocUrl)] }),
      );

      // Corroboration is made of exactly this: the same statement, independently.
      deepStrictEqual(ids(await store.bySubject(fx.subject)), ids([first, second]));
    },
  },

  {
    name: 'a different claim from the same document is stored, not collapsed',
    async run(store, fx) {
      const first = await store1(store, conformanceFinding(fx));
      const second = await store1(
        store,
        conformanceFinding(fx, { claim: `${fx.claimPrefix}: they opened a second depot` }),
      );

      deepStrictEqual(ids(await store.bySubject(fx.subject)), ids([first, second]));
    },
  },

  {
    name: 'putting the SAME id twice is a duplicate_id failure, not a silent no-op',
    async run(store, fx) {
      const f = conformanceFinding(fx);
      await store1(store, f);

      const again = await store.put(f);
      ok(!again.ok);
      strictEqual(again.reason, 'duplicate_id');
    },
  },

  {
    name: 'a finding with no evidence is refused as invalid — no claim ships without a source',
    async run(store, fx) {
      const result = await store.put(conformanceFinding(fx, { evidence: [] }));
      ok(!result.ok);
      strictEqual(result.reason, 'invalid_finding');
      // And nothing was stored on the way to finding out.
      deepStrictEqual(await store.bySubject(fx.subject), []);
    },
  },

  {
    name: 'supersede closes the original, links it, records the reason, and stores the replacement',
    async run(store, fx) {
      const original = await store1(store, conformanceFinding(fx));
      const replacement = conformanceFinding(fx, {
        claim: `${fx.claimPrefix}: list prices rose to $139`,
        created_at: T2,
      });

      const result = await store.supersede(
        original.id,
        replacement,
        'the first read misread the table',
      );
      ok(result.ok, 'expected the supersession to succeed');
      strictEqual(result.original.superseded_by, replacement.id);
      strictEqual(result.original.supersede_reason, 'the first read misread the table');
      strictEqual(result.replacement.id, replacement.id);

      // The original is still THERE — corrections are new rows, never edits.
      const read = await store.byId(original.id);
      strictEqual(read?.claim, original.claim, 'a correction must not rewrite the past');
      strictEqual(read?.superseded_by, replacement.id);
    },
  },

  {
    name: 'supersede with no stated reason is refused — the reason is the repair',
    async run(store, fx) {
      const original = await store1(store, conformanceFinding(fx));
      const result = await store.supersede(original.id, conformanceFinding(fx), '   ');

      ok(!result.ok);
      strictEqual(result.reason, 'missing_reason');
      strictEqual((await store.byId(original.id))?.superseded_by, null);
    },
  },

  {
    name: 'supersede reports each of its five failures as itself',
    async run(store, fx) {
      const original = await store1(store, conformanceFinding(fx));

      const notFound = await store.supersede(ABSENT_UUID, conformanceFinding(fx), 'because');
      ok(!notFound.ok);
      strictEqual(notFound.reason, 'not_found');

      const self = await store.supersede(original.id, original, 'because');
      ok(!self.ok);
      strictEqual(self.reason, 'self_supersede');

      const invalid = await store.supersede(
        original.id,
        conformanceFinding(fx, { evidence: [] }),
        'because',
      );
      ok(!invalid.ok);
      strictEqual(invalid.reason, 'invalid_finding');

      // …and the original is still open after all three refusals.
      strictEqual((await store.byId(original.id))?.superseded_by, null);

      const replacement = conformanceFinding(fx, { created_at: T2 });
      ok((await store.supersede(original.id, replacement, 'corrected')).ok);

      const twice = await store.supersede(original.id, conformanceFinding(fx), 'again');
      ok(!twice.ok);
      strictEqual(twice.reason, 'already_superseded');
    },
  },

  {
    name: 'supersede deliberately bypasses deduplication — a reworded so_what is still stored',
    async run(store, fx) {
      const original = await store1(store, conformanceFinding(fx));
      // Same claim, same evidence: identical dedupe key. `put` would refuse it;
      // `supersede` must not, or the correction is silently swallowed.
      const replacement = conformanceFinding(fx, {
        so_what: 'and it is now above ours in every postal code, not just some',
        created_at: T2,
      });

      const result = await store.supersede(
        original.id,
        replacement,
        'the consequence was understated',
      );
      ok(result.ok);
      strictEqual((await store.byId(replacement.id))?.id, replacement.id);
    },
  },

  {
    name: 'reads are live by default and include the past only when asked',
    async run(store, fx) {
      const original = await store1(store, conformanceFinding(fx));
      const replacement = conformanceFinding(fx, { created_at: T2 });
      ok((await store.supersede(original.id, replacement, 'corrected')).ok);

      deepStrictEqual(ids(await store.bySubject(fx.subject)), [replacement.id]);
      deepStrictEqual(
        ids(await store.bySubject(fx.subject, { includeSuperseded: true })),
        ids([original, replacement]),
      );

      // Filtered to this case's rows: `byStakes` and `unsuperseded` are
      // unqualified reads, and a live `finding` table is not guaranteed empty.
      const mineOnly = (rows: readonly Finding[]): string[] =>
        ids(rows.filter((f) => f.claim.startsWith(fx.claimPrefix)));
      deepStrictEqual(mineOnly(await store.byStakes('medium')), [replacement.id]);
      deepStrictEqual(mineOnly(await store.unsuperseded()), [replacement.id]);
    },
  },

  {
    name: 'bySubject and byStakes filter, and an unknown value is empty rather than an error',
    async run(store, fx) {
      const mine = await store1(store, conformanceFinding(fx));
      await store1(
        store,
        conformanceFinding(fx, {
          claim: `${fx.claimPrefix}: they hired 4 dispatchers`,
          subject_refs: [fx.otherSubject],
          stakes: 'high',
        }),
      );

      deepStrictEqual(ids(await store.bySubject(fx.subject)), [mine.id]);
      deepStrictEqual(await store.bySubject('company:nobody-holds-this'), []);
      deepStrictEqual(
        (await store.byStakes('high')).filter((f) => f.claim.startsWith(fx.claimPrefix)).length,
        1,
      );
    },
  },

  {
    name: 'recent is newest-first and honours its limit; a zero or negative limit is empty',
    async run(store, fx) {
      const older = await store1(store, conformanceFinding(fx, { created_at: T0 }));
      const newer = await store1(
        store,
        conformanceFinding(fx, { claim: `${fx.claimPrefix}: second`, created_at: T2 }),
      );

      // Filtered to this case's rows: a live `finding` table is not empty.
      const mine = (await store.recent(500)).filter((f) => f.claim.startsWith(fx.claimPrefix));
      deepStrictEqual(
        mine.map((f) => f.id),
        [newer.id, older.id],
      );

      strictEqual((await store.recent(1)).length, 1);
      deepStrictEqual(await store.recent(0), []);
      deepStrictEqual(await store.recent(-3), []);
      deepStrictEqual(await store.recent(Number.NaN), []);
    },
  },

  {
    name: 'chain walks the supersession chain to the live tip, and is empty for an unknown id',
    async run(store, fx) {
      const first = await store1(store, conformanceFinding(fx));
      const second = conformanceFinding(fx, { claim: `${fx.claimPrefix}: v2`, created_at: T1 });
      ok((await store.supersede(first.id, second, 'v2')).ok);
      const third = conformanceFinding(fx, { claim: `${fx.claimPrefix}: v3`, created_at: T2 });
      ok((await store.supersede(second.id, third, 'v3')).ok);

      deepStrictEqual(
        (await store.chain(first.id)).map((f) => f.id),
        [first.id, second.id, third.id],
      );
      deepStrictEqual(
        (await store.chain(second.id)).map((f) => f.id),
        [second.id, third.id],
      );
      deepStrictEqual(await store.chain(ABSENT_UUID), []);
    },
  },
];
