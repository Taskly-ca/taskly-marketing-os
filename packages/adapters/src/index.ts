/**
 * @tmos/adapters — the ports, implemented.
 *
 * WHY THIS PACKAGE EXISTS AT ALL, since the alternative (an `adapters/` folder
 * inside each domain package) looks simpler until it is tried:
 *
 *  1. The domain packages must stay free of `pg`. `packages/world` is pure and
 *     port-driven — "no package in this repo reaches a database or a network
 *     directly" is the first thing its index says — and a `pg` import inside it
 *     would make the world model unloadable without a connection string, and
 *     untestable without a database.
 *
 *  2. Cross-package mappers have no other legal home. `packages/surface`
 *     deliberately does NOT depend on `packages/world`: a view model that
 *     imports the world model acquires its whole dependency graph and its
 *     bitemporal vocabulary, and `FactRecord` exists precisely because a surface
 *     should not be handed a `FactRow` (it drops `confidence` on purpose). So
 *     `FactRow → FactRecord` — the mapper Part 6 records as a known gap — cannot
 *     live in either package without breaking that separation. It lives here.
 *
 *  3. One dependency edge, one place to audit. Everything that knows both a SQL
 *     schema and a domain type is in this package, so "what does the database
 *     actually store for X" is a single directory rather than a search.
 *
 * WHAT IS IN HERE
 *
 *   errors      the taxonomy every adapter throws, and the pg → taxonomy map
 *   pg/values   driver-independent column coercion (the driver's type parsers
 *               are global mutable state; nothing here depends on them)
 *   pg/*-store  one file per port. Repository functions take `ex: Executor =
 *               db()` LAST, so each one works standalone and composes inside
 *               someone else's `withTx` with no plumbing; a `create*Store`
 *               factory binds them to the port interface.
 *   testing     the conformance suites — one set of assertions run against BOTH
 *               the in-memory store and this one — plus the fakes and the live
 *               harness that make them runnable.
 *
 * ADDING AN ADAPTER: put it under `src/`, reuse `errors.ts` and `pg/values.ts`
 * rather than minting new ones, write a conformance suite beside the ones in
 * `src/testing/`, and add its domain package to this package's dependencies —
 * that one line in `package.json` is the only file outside `src/` an adapter
 * ever needs to touch.
 */
export * from './errors.js';

export * from './pg/values.js';
export * from './pg/fact-row.js';
export * from './pg/fact-record.js';
export * from './pg/fact-store.js';
export * from './pg/predicate-store.js';
export * from './pg/er-labels.js';
export * from './pg/entity-directory.js';
export * from './pg/query-tools.js';
export * from './pg/brain-store.js';
export * from './pg/brain-index.js';
export * from './pg/prediction-store.js';
export * from './pg/resolver-context.js';
export * from './pg/decision-store.js';
export * from './pg/playbook-store.js';
export * from './pg/outbox.js';
export * from './pg/source-store.js';
export * from './pg/finding-store.js';
export * from './pg/entity-history.js';

export * from './testing/conformance.js';
export * from './testing/recording-executor.js';
export * from './testing/live.js';
export * from './testing/fact-store.conformance.js';
export * from './testing/predicate-store.conformance.js';
export * from './testing/er.conformance.js';
export * from './testing/brain.conformance.js';
export * from './testing/prediction.conformance.js';
export * from './testing/decide.conformance.js';
export * from './testing/outbox.conformance.js';
export * from './testing/finding.conformance.js';
