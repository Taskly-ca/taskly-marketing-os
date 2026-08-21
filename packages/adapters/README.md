# @tmos/adapters

The ports, implemented. Postgres today; anything else that needs to know both a
schema and a domain type later.

## Why a separate package

Three reasons, in the order they bite:

1. **The domain packages must stay free of `pg`.** `packages/world` is pure and
   port-driven — "no package in this repo reaches a database or a network
   directly" is the first thing its index says. A `pg` import inside it makes
   the world model unloadable without a connection string and untestable
   without a database.
2. **Cross-package mappers have no other legal home.** `packages/surface`
   deliberately does **not** depend on `packages/world`; `FactRecord` exists
   precisely because a view should not be handed a `FactRow` (it drops
   `confidence` on purpose). So `FactRow → FactRecord` — the mapper Part 6
   records as a known gap — cannot live in either package without breaking that
   separation. It belongs here.
3. **One dependency edge to audit.** Everything that knows what the database
   really stores for a domain type is in one directory.

## Layout

```
src/
  errors.ts                        the error taxonomy + the SQLSTATE map
  pg/values.ts                     driver-independent column coercion
  pg/fact-row.ts                   FactRow ↔ fact columns (pure)
  pg/fact-store.ts                 FactStore
  pg/predicate-store.ts            PredicateStore
  testing/conformance.ts           the case type + assertion helpers
  testing/recording-executor.ts    an Executor fake, for SQL assertions
  testing/live.ts                  HAS_DATABASE · inRollback · fixture seeding
  testing/*.conformance.ts         the suites, run against BOTH stores
```

Public API (all re-exported from `src/index.ts`):

| Port            | Factory                          | Repository functions                                                                                            |
| --------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `FactStore`     | `createPostgresFactStore(ex?)`     | `insertFact` · `factById` · `factsForPredicate` · `factsForEntity` · `closeFactAsserted` · `closeFactValid` · `setFactStatus` |
| `PredicateStore`| `createPostgresPredicateStore(ex?)`| `predicateByName` · `predicateByAlias` · `upsertPredicate` · `allPredicates` · `recordPredicateOccurrence`        |

## House rules for anything added here

- **`ex: Executor = db()` is the LAST parameter** of every repository function.
  Called with nothing it uses the pool; called inside someone's `withTx` it
  enlists in that transaction. No plumbing either way.
- **The factories resolve their executor per call** (`ex ?? db()`), never in a
  default argument. `createPostgresFactStore(ex = db())` would bind the pool at
  construction and every write through a module-scope store would silently
  escape the caller's transaction.
- **Never import `pg`.** That is `@tmos/db`'s job. Driver errors are duck-typed
  in `errors.ts`.
- **There is no `sql.raw`.** Compose by nesting a `SqlQuery` inside another
  (placeholders renumber); pass a list as `= any(${ids})`, never a spliced
  `in (...)`.
- **The adapter never reads the clock.** Every instant comes from the caller —
  see the frozen-`now()` note below.
- **Reuse `errors.ts` and `pg/values.ts`** rather than minting a second
  taxonomy or a second coercion.
- **Write a conformance suite** beside the two in `src/testing/`, and run it
  against both the in-memory store and this one.

Adding an adapter for another domain package means adding that package to this
one's `dependencies` — that single line in `package.json` is the only file
outside `src/` an adapter ever needs to touch.

## Conformance: how "substitutable" is proven rather than asserted

Migration 009's own header says it best: *"the in-memory adapter has no trigger,
so the entire Part 3 suite exercised a store the Postgres one could never be."*
A thousand green tests said the bitemporal model worked; the first real database
found that `closeValid` had never been possible.

So the cases in `src/testing/*.conformance.ts` are **data, not tests** — a name
and an async function taking `(store, fixtures)`, asserting with
`node:assert/strict` so nothing in `src/` imports a test framework:

- `testing/memory-conformance.test.ts` runs them against
  `createMemoryFactStore` / `createMemoryPredicateStore`. Deterministic, keyless,
  in CI. **30 cases, green.**
- `pg/*.live.test.ts` runs the *same arrays* against Postgres, each case inside a
  transaction that is rolled back. **42 cases, skipping** until `DATABASE_URL`
  exists.

`fixtures` is the seam: the Postgres store needs real `entity`, `source` and
`predicate_def` rows for its foreign keys, and the memory store does not care.

## Mapping decisions — `FactStore`

| Concern | Decision |
| --- | --- |
| `FactValue` → columns | Exactly one `object_*` column per variant. |
| columns → `FactValue` | Decoded from **whichever column is populated**, not from `predicate_def.datatype`. No join on any read, and a fact whose value contradicts its predicate still round-trips — which the memory store does too. Catching that contradiction is `validateValue`'s job, in the domain, before the write. |
| `object_json` | The query selects `object_json is not null` as `has_json`: SQL NULL and the jsonb document `null` are indistinguishable once they reach JavaScript. |
| `Range` ↔ `tstzrange` | Written as `tstzrange(from, to)` (`[)` bounds, `null` upper = open). **Read as `lower()`/`upper()`, never as the range** — node-postgres has no `tstzrange` parser and would hand back the literal text. |
| `asserted` | Always supplied by the caller. The column's `default tstzrange(now(), null)` is never used. |
| `Evidence` | **snake_case on disk, camelCase in TypeScript.** 002's column comment documents `extractor_version`/`prompt_version`; `packages/world` declares `extractorVersion`/`promptVersion`. Both files are outside this lane, so one had to be translated: disk wins, because every other identifier in this database is snake_case and `evidence->>'extractor_version'` must not silently return NULL to whoever follows the comment. Unknown keys pass through verbatim in both directions — evidence is the audit trail. |
| ids | uuids cast `::text` in the query; a non-canonical id is a **miss**, not a crash (`byId('fact_00000a')` → `null`, as in memory). |
| ordering | `order by lower(asserted), fact_id`. The port says "insertion order"; `fact` has no insertion counter and a random-uuid PK. Nothing depends on it — `query.ts` sorts before choosing, and `golden.test.ts` deliberately reverses the store's output to prove independence. |
| `closeAsserted`/`closeValid` | Preconditions are guarded **in the WHERE clause**, so a violation returns zero rows instead of raising. A second read then diagnoses which precondition failed. This is not decoration: `withTx` has no savepoints, so a raised exception aborts the whole transaction and the diagnosis would fail with "current transaction is aborted". |

## Mapping decisions — `PredicateStore`

| Concern | Decision |
| --- | --- |
| `distinctSources` | Not a column. Aggregated from `predicate_occurrence` in a correlated subquery (a join would drop a predicate with no occurrences — exactly the row promotion cares about). |
| `occurrences` | A column this adapter **never writes**. 007's `predicate_occurrence_sync` trigger recomputes it from `sum(count)` after every ledger write. |
| `upsert(def)` | Stores the definition, then reconciles the ledger — see the divergence table. `insert … on conflict (predicate) do update` leaves `created_at` alone, so insertion order survives. |
| Not atomic | Three statements (read, upsert, reconcile). Wrap in `withTx` for all-or-nothing; that is also what makes the read-then-write safe against a concurrent proposer. |
| `count` | Quoted in every statement — it is also a function name. |
| Name normalization | `normalizePredicateName` exists **twice**: in TypeScript and as SQL (`normalizePredicateNameSql`). Justified only because the live suite runs both over the same adversarial inputs and fails if they disagree. Do not change one without running it. |
| `byAlias` | Normalizes **both sides** in SQL, matching the memory store, because `upsert` does not normalize the alias array. A full scan with `unnest` over a curated table of hundreds of rows; `limit 1` on `created_at` keeps "which definition wins" the same answer in both stores. |

## Where the two stores disagree

Some of these are the database being right. All of them are places a caller can
be surprised.

| # | Behaviour | In memory | In Postgres |
| --- | --- | --- | --- |
| 1 | `closeValid` on an already-closed bound | silently overwrites | `AppendOnlyError` (009: infinite → finite, once) |
| 2 | `closeAsserted` with `at` **before** `asserted.from` | accepted (no check) | `AppendOnlyError`, worded like memory's `closeValid` |
| 3 | Closing **at** the instant the range opened | stores a zero-width range | `EmptyRangeError` — and `now()` is frozen per transaction, so insert-then-close in one `withTx` always lands here |
| 4 | Unknown `entityId` / `predicate` / `sourceId` on insert | accepted (no FKs) | `MissingReferenceError` |
| 5 | `PredicateDef.occurrences` on `upsert` | stored verbatim | ignored; the ledger is the truth |
| 6 | A repeat sighting through `upsert` | exact | attributed to the **last** source in `distinctSources`. Totals and the distinct set — everything promotion reads — are identical; per-source `count` can be off. `recordPredicateOccurrence` is exact. |
| 7 | Dangling `supersededBy` | tolerated (`resolveAlias` handles it) | FK violation; write the replacement first |
| 8 | Non-uuid ids | any string is an id | reads miss, mutations `NotFoundError`. Unhyphenated uuids that Postgres would accept are rejected by the guard. |
| 9 | `confidence` | full float64 | `real` — ~7 significant digits |
| 10 | `FactValue.num` | full float64 | `numeric` is exact on disk; truncated to float64 on the way out |
| 11 | Timestamps | as given | µs on disk, ms once through `Date` |
| 12 | Row order | insertion | `lower(asserted)`, then id |
| 13 | `all()` | starts empty | the live `predicate_def`, which has rows in it |
| 14 | An **empty** range on INSERT | accepted | accepted — 009's guards are UPDATE/DELETE only |

### Two of these are worth acting on

- **`recordChange` can hit #1 in production.** `packages/world/src/fact/write.ts`
  closes `valid` when the covering row is open **or** when its existing end is
  later than the change instant. The second branch re-closes an already-closed
  bound, which 009 forbids. In memory it silently moves the end date; against
  Postgres it will throw. Not fixed here — `packages/world` is another lane.
- **`PredicateStore.upsert` is a leaky port.** It carries two derived fields, and
  `recordOccurrence` folds the source id into them before the store ever sees it,
  which is what forces the attribution guess in #6. A port method taking
  `(predicate, sourceId)` removes it entirely. That is a `packages/world` change,
  and a serial one.

## What is NOT verified

`DATABASE_URL` is unset, so **no statement in this package has ever been
executed**. The deterministic suite proves the mapping, the error taxonomy and
the shape of the SQL; it cannot prove Postgres accepts any of it. Specifically
still open until `pnpm test:live` runs green:

1. Every statement parses and the projections match the real columns.
2. The 42 conformance + adapter cases behave as the memory store does.
3. `normalizePredicateNameSql` really equals `normalizePredicateName` (locale-
   dependent `lower()` is the likeliest place to differ).
4. The frozen-`now()` guard produces `EmptyRangeError` rather than a raised
   trigger, i.e. that the WHERE-clause guards fire before the trigger does.
5. That 009's messages match the `APPEND_ONLY_PATTERNS` in `errors.ts` — they
   were written from the migration text, not from a raised error.
6. Precision: `real` confidence and wide `numeric` values (both asserted in the
   live suite as *lossy*, which is the honest expectation, not a wish).
7. Whether `predicate_occurrence`'s `first_seen` ordering is stable enough for
   `distinctSources` to be worth ordering at all.
8. **Which role the connection string authenticates as.** 011 gave every table
   in `public` RLS with a service-role-only policy, and 010 was written because
   grants and RLS are independent gates that fail by returning *empty results,
   not an error*. If a live run fails at the first `insert … returning` with
   "expected exactly one row, got 0", suspect the role before the SQL.
