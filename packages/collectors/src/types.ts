/**
 * The collector contract.
 *
 * Every adapter returns a DISCRIMINATED UNION, never a throw and never a bare
 * array. The reason is a documented agent failure mode: most pipelines cannot
 * distinguish "step 2 returned bad data" from "step 2 legitimately had no
 * data", so a broken source looks exactly like a quiet one and degrades in
 * silence for weeks.
 *
 * Here `ok: true, items: []` means *the source genuinely had nothing* and
 * `ok: false` means *we failed*. Those are different rows in the event log and
 * different alerts.
 */

export interface RawItem {
  /** Stable id from the source, used for idempotency. */
  externalId: string;
  url: string | null;
  title: string | null;
  body: string;
  publishedAt: string | null;
  /** Anything source-specific. Never PII — see policy.ts. */
  meta: Record<string, unknown>;
}

export type CollectResult =
  | { ok: true; items: RawItem[]; cursor?: string; etag?: string; notModified?: boolean }
  | { ok: false; reason: CollectFailure; detail: string; retryable: boolean };

export type CollectFailure =
  | 'network'
  | 'rate_limited'
  | 'auth'
  | 'parse'
  | 'blocked_by_policy'
  | 'not_configured';

/**
 * Method and body are first-class rather than smuggled.
 *
 * Two of our sources are POST-with-a-body (a GraphQL query, a Search Console
 * date range). An earlier pass encoded those in reserved `x-tmos-*` headers
 * that the transport was required to strip before the request left the
 * process — an invariant nothing enforced, where one missed strip leaks an
 * internal header to a third party. Naming the fields costs one optional
 * parameter and removes the whole class of mistake.
 */
export interface FetchInit {
  method?: 'GET' | 'POST';
  /** Serialized request body. Never put credentials here — use headers. */
  body?: string;
}

export interface CollectorContext {
  /** Injected so every collector is unit-testable with no network. */
  fetchText: (
    url: string,
    headers?: Record<string, string>,
    init?: FetchInit,
  ) => Promise<FetchTextResult>;
  now: () => Date;
  /** Previous cursor/etag for conditional requests. */
  cursor?: string;
  etag?: string;
}

export interface FetchTextResult {
  status: number;
  body: string;
  headers: Record<string, string>;
}

export interface Collector {
  /** Stable key, used as the `source.kind`. */
  readonly kind: string;
  /** Human label for the source registry. */
  readonly name: string;
  /** False when the collector needs a credential we do not have yet — the
   *  pipeline skips it cleanly instead of failing the run. */
  isConfigured(env: Record<string, string | undefined>): boolean;
  collect(ctx: CollectorContext): Promise<CollectResult>;
}

/** Convenience constructors so adapters stay declarative. */
export const ok = (items: RawItem[], extra: Partial<Extract<CollectResult, { ok: true }>> = {}) =>
  ({ ok: true, items, ...extra }) satisfies CollectResult;

export const fail = (reason: CollectFailure, detail: string, retryable = true) =>
  ({ ok: false, reason, detail, retryable }) satisfies CollectResult;

/** A 304 is a success with zero items — the cheapest possible outcome, and the
 *  single biggest lever on crawl budget. */
export const notModified = (etag?: string) =>
  ({ ok: true, items: [], notModified: true, ...(etag ? { etag } : {}) }) satisfies CollectResult;
