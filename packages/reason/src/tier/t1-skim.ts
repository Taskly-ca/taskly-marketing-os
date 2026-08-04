/**
 * T1 — SKIM. The first tier that costs money, and therefore the one with the
 * strictest job description: **triage, not truth.**
 *
 * T1 decides only whether an item is worth a more expensive look. It never
 * decides what is true, never writes a Finding, and never uses a large model.
 * If it starts deciding truth, the cheapest tier becomes the one whose errors
 * are hardest to see, because nothing downstream re-examines what it discarded.
 *
 * MATERIALITY IS "WOULD THIS CHANGE WHAT WE DO?", NOT "IS THIS INTERESTING?"
 * The distinction is the whole product. Interestingness is unbounded — every
 * competitor blog post is mildly interesting — and a digest scored on it grows
 * until nobody reads it. Materiality is scarce by construction: a competitor
 * changing a price we benchmark against is material; the same competitor
 * publishing a listicle is not, however readable it is.
 *
 * SPEND. Every call goes through `SkimPort`, which the caller wires to
 * `@tmos/shared/llm` (`authorizeSpend` / `commitSpend`). This module never
 * imports a provider, never estimates a cost and never retries a refusal: a
 * budget block surfaces here as a port failure, and a port failure abstains.
 */

/* ── constants, each with its reasoning ───────────────────────────────────── */

/**
 * Below this, an item stops at T1.
 *
 * 0.35 is deliberately LOW and is **a starting point to be tuned by outcome
 * data, not a validated constant.** The two errors are not symmetric: a false
 * negative dies invisibly and we never learn we missed it, while a false
 * positive costs one cheap T2 correlate and shows up in the dismissal log where
 * it can be counted. Tune it against `finding_feedback.dismiss_reason` — a run
 * of `obvious` / `not_actionable` says raise it; anything we find out about
 * late from somewhere else says lower it.
 */
export const DEFAULT_MATERIALITY_GATE = 0.35;

/**
 * Items per port call.
 *
 * 20 is chosen on blast radius rather than throughput: one malformed response
 * abstains at most 20 items, and abstentions are the expensive outcome
 * downstream. Larger batches amortise the prompt slightly better and make that
 * failure worse; much smaller ones pay for the instructions over and over.
 */
export const SKIM_BATCH_SIZE = 20;

/** Characters of body sent per item. A lede and the first substantive
 *  paragraph is where materiality is decidable; if it is not decidable there,
 *  that is precisely what T2 and T3 are for. */
export const SKIM_BODY_CHARS = 1200;

/** One line, so a human scanning a digest reads reasons, not paragraphs. */
export const SKIM_REASON_CHARS = 160;

/** Prompt/model generation. Part of the cache key — see `skimCacheKey`. */
export const SKIM_VERSION = 'skim@1';

/* ── ports ────────────────────────────────────────────────────────────────── */

export interface SkimItem {
  /** Stable item id — in practice `signal.id`. */
  id: string;
  /** `signal.content_hash`. Unchanged content must never be re-skimmed. */
  contentHash: string;
  title: string | null;
  body: string;
}

/** What the port is handed: bounded, and stripped of anything it cannot use. */
export interface SkimInput {
  id: string;
  title: string | null;
  body: string;
}

/**
 * What the port promises to return.
 *
 * The model has not read this declaration, so every field is re-checked at
 * runtime. Treating a type annotation as a validation of model output is one of
 * the more expensive mistakes available here.
 */
export interface SkimVerdict {
  id: string;
  /** [0,1]. Would this change what we do? */
  materiality: number;
  /** One line. Why. */
  reason: string;
}

/** The small-model seam. The implementation owns the budget call; this module
 *  never sees a provider, a key or a token count. */
export interface SkimPort {
  skim(batch: readonly SkimInput[]): Promise<readonly SkimVerdict[]>;
}

export interface SkimCache {
  get(key: string): SkimVerdict | undefined;
  set(key: string, verdict: SkimVerdict): void;
}

/**
 * Cache key = **skim version + content hash**.
 *
 * The hash alone is the obvious choice and the wrong one: it would serve
 * verdicts from a retired prompt forever, so a prompt fix would silently never
 * apply to anything already seen. Versioning the key makes an upgrade a
 * deliberate, visible re-spend.
 */
export const skimCacheKey = (contentHash: string, version: string): string =>
  `${version}:${contentHash}`;

export const createMemorySkimCache = (): SkimCache => {
  const m = new Map<string, SkimVerdict>();
  return { get: (k) => m.get(k), set: (k, v) => void m.set(k, v) };
};

/* ── results ──────────────────────────────────────────────────────────────── */

export type SkimAbstainCode =
  'missing_verdict' | 'malformed_score' | 'duplicate_verdict' | 'port_failed';

export interface SkimResult {
  id: string;
  contentHash: string;
  materiality: number;
  reason: string;
  /** Passed the gate, or abstained. Abstentions always pass. */
  proceed: boolean;
  cached: boolean;
  abstained: boolean;
  abstainCode: SkimAbstainCode | null;
}

export interface SkimBatchResult {
  /** One per input item, in input order. Nothing is ever dropped. */
  results: SkimResult[];
  portCalls: number;
  /** Verdict ids that matched no item we sent. Reported, never guessed at. */
  unknownIds: string[];
}

export interface SkimDeps {
  port: SkimPort;
  cache: SkimCache;
  gate?: number;
  batchSize?: number;
  version?: string;
  bodyChars?: number;
}

/* ── implementation ───────────────────────────────────────────────────────── */

const ABSTAIN_REASON: Record<SkimAbstainCode, string> = {
  missing_verdict: 'no verdict returned for this item — needs a look',
  malformed_score: 'model returned an unusable score — needs a look',
  duplicate_verdict: 'model returned conflicting verdicts for this item — needs a look',
  port_failed: 'skim call failed — needs a look',
};

const validVerdict = (v: unknown): v is SkimVerdict => {
  if (typeof v !== 'object' || v === null) return false;
  const m = (v as { materiality?: unknown }).materiality;
  return typeof m === 'number' && Number.isFinite(m) && m >= 0 && m <= 1;
};

const idOf = (v: unknown): string | null => {
  if (typeof v !== 'object' || v === null) return null;
  const id = (v as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

/** A malformed reason is cosmetic, not disqualifying — abstaining over prose
 *  would throw away a usable score. It is replaced, and the score kept. */
const cleanReason = (v: unknown): string => {
  const r = (v as { reason?: unknown }).reason;
  if (typeof r !== 'string' || r.trim().length === 0) return '(no reason returned)';
  return r.replace(/\s+/g, ' ').trim().slice(0, SKIM_REASON_CHARS);
};

interface Group {
  key: string;
  representative: SkimItem;
  memberIds: string[];
}

export async function skimItems(
  items: readonly SkimItem[],
  deps: SkimDeps,
): Promise<SkimBatchResult> {
  const gate = deps.gate ?? DEFAULT_MATERIALITY_GATE;
  const version = deps.version ?? SKIM_VERSION;
  const bodyChars = deps.bodyChars ?? SKIM_BODY_CHARS;
  const batchSize = Math.max(1, deps.batchSize ?? SKIM_BATCH_SIZE);

  // One group per distinct cache key, so the same content in a batch twice is
  // one item's worth of spend.
  const groups = new Map<string, Group>();
  for (const it of items) {
    const key = skimCacheKey(it.contentHash, version);
    const g = groups.get(key);
    if (g) g.memberIds.push(it.id);
    else groups.set(key, { key, representative: it, memberIds: [it.id] });
  }

  const verdicts = new Map<string, SkimVerdict>();
  const cached = new Set<string>();
  const abstain = new Map<string, SkimAbstainCode>();
  const unknownIds: string[] = [];
  let portCalls = 0;

  const misses: Group[] = [];
  for (const g of groups.values()) {
    const hit = deps.cache.get(g.key);
    if (hit) {
      verdicts.set(g.key, hit);
      cached.add(g.key);
    } else {
      misses.push(g);
    }
  }

  for (let i = 0; i < misses.length; i += batchSize) {
    const slice = misses.slice(i, i + batchSize);
    const byRepId = new Map(slice.map((g) => [g.representative.id, g]));
    const inputs: SkimInput[] = slice.map((g) => ({
      id: g.representative.id,
      title: g.representative.title,
      body: g.representative.body.slice(0, bodyChars),
    }));

    portCalls += 1;
    let returned: readonly unknown[];
    try {
      returned = await deps.port.skim(inputs);
    } catch {
      // Includes a budget refusal. Nothing is cached: a transient failure must
      // not poison these items for every future run.
      for (const g of slice) abstain.set(g.key, 'port_failed');
      continue;
    }

    const seen = new Set<string>();
    for (const raw of Array.isArray(returned) ? returned : []) {
      const id = idOf(raw);
      if (id === null) continue;
      const g = byRepId.get(id);
      if (!g) {
        unknownIds.push(id);
        continue;
      }
      if (seen.has(id)) {
        abstain.set(g.key, 'duplicate_verdict');
        verdicts.delete(g.key);
        continue;
      }
      seen.add(id);
      if (!validVerdict(raw)) {
        abstain.set(g.key, 'malformed_score');
        continue;
      }
      const verdict: SkimVerdict = {
        id,
        materiality: raw.materiality,
        reason: cleanReason(raw),
      };
      verdicts.set(g.key, verdict);
      deps.cache.set(g.key, verdict);
    }

    for (const g of slice) {
      if (!verdicts.has(g.key) && !abstain.has(g.key)) abstain.set(g.key, 'missing_verdict');
    }
  }

  const results: SkimResult[] = items.map((it) => {
    const key = skimCacheKey(it.contentHash, version);
    const code = abstain.get(key);
    const verdict = code === undefined ? verdicts.get(key) : undefined;
    if (!verdict) {
      const abstainCode = code ?? 'missing_verdict';
      return {
        id: it.id,
        contentHash: it.contentHash,
        // Exactly at the gate: the least committal score that still passes.
        // `proceed` is set by fiat below, not by this comparison.
        materiality: gate,
        reason: ABSTAIN_REASON[abstainCode],
        proceed: true,
        cached: false,
        abstained: true,
        abstainCode,
      };
    }
    return {
      id: it.id,
      contentHash: it.contentHash,
      materiality: verdict.materiality,
      reason: verdict.reason,
      proceed: verdict.materiality >= gate,
      cached: cached.has(key),
      abstained: false,
      abstainCode: null,
    };
  });

  return { results, portCalls, unknownIds };
}
