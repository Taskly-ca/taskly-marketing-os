/**
 * Scoped chat — a conversation always starts from an object, never a blank box.
 *
 * This is a correctness decision, not a UX preference. A free-text box over a
 * corpus invites questions the corpus cannot ground; the honest answer to most
 * of them is "I don't know", and a surface that says that often enough teaches
 * people to stop asking — which is how a grounded system loses to a confident
 * one. Starting from a Finding or an entity fixes the scope, the evidence and
 * the citable URLs BEFORE the first token, so every question resolves to either
 * a cited answer or a precise refusal.
 *
 * Two invariants carry the rest of the file:
 *   1. An answer may cite ONLY the scoped evidence. A citation outside it is
 *      the retrieval equivalent of a fabrication — the text may even be true,
 *      but we cannot show where it came from, which is the whole product.
 *   2. An unanswerable question returns `cannot_answer_in_scope` plus what
 *      would be needed. A plausible guess is the failure this module prevents.
 */
import type { Basis, EvidenceRef } from '@tmos/contracts';
import { assertNoConfidenceNumber, mayQuoteAsFact, renderBasis, weakestBasis } from '../basis.js';

/* ── scope ────────────────────────────────────────────────────────────────── */

/**
 * There is deliberately NO `{ kind: 'open' }` member.
 *
 * Making the unscoped case structurally unspellable is the point: a discouraged
 * variant becomes the default the first time someone needs a demo, and every
 * guarantee below is downstream of a scope existing. An open variant would
 * compile everywhere and silently disable citation checking, because there
 * would be no evidence set left to check against.
 */
export type ChatScope =
  | { readonly kind: 'finding'; readonly findingId: string }
  | { readonly kind: 'entity'; readonly entityId: string };

/** Runtime half of the same guarantee — scopes arrive as JSON, where the type
 *  system is not present to help. */
export function isChatScope(v: unknown): v is ChatScope {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const id =
    o['kind'] === 'finding' ? o['findingId'] : o['kind'] === 'entity' ? o['entityId'] : null;
  return typeof id === 'string' && id.length > 0;
}

export const scopeKey = (s: ChatScope): string =>
  s.kind === 'finding' ? `finding:${s.findingId}` : `entity:${s.entityId}`;

/* ── the seeded context ───────────────────────────────────────────────────── */

export interface ScopedEvidence {
  ref: EvidenceRef;
  /** How this particular piece was established. Answers take the weakest. */
  basis: Basis;
  /**
   * Copy-chain-collapsed identity, supplied by the caller. REQUIRED rather than
   * defaulted to the URL: ten outlets republishing one press release share one
   * key, and defaulting to the URL renders that as ten independent sources —
   * the exact laundering `renderBasis` warns about.
   */
  independenceKey: string;
}

export interface ChatSubject {
  scope: ChatScope;
  /** A Finding's claim, or an entity's canonical name. */
  title: string;
  /** A Finding's so_what. Empty for an entity. */
  soWhat: string;
  basis: Basis;
  evidence: readonly ScopedEvidence[];
}

export interface SeedContext extends ChatSubject {
  /** The closed set an answer may cite. Normalised and sorted. */
  allowedUrls: readonly string[];
  /** Deterministic rendering — the same subject yields the same string. */
  text: string;
}

/* ── ports ────────────────────────────────────────────────────────────────── */

/** Mirrors `SpendOutcome` in `@tmos/shared/llm`. A port type rather than an
 *  import because surface must not depend on the LLM package; the caller wires
 *  `authorizeSpend`/`commitSpend`, which satisfy this shape structurally. */
export type SpendOutcome =
  | 'allowed'
  | 'blocked_run_tokens'
  | 'blocked_daily_cost'
  | 'blocked_tool_depth'
  | 'blocked_killswitch';

export interface SpendRequest {
  runId: string;
  estimatedTokens: number;
  estimatedCostCents: number;
  toolDepth: number;
}

export interface BudgetDecision {
  outcome: SpendOutcome;
  reason?: string;
}

/** The only route to money. A block is surfaced to the reader, never retried. */
export interface BudgetPort {
  authorize(req: SpendRequest): BudgetDecision;
  commit(req: SpendRequest): void;
}

export interface LlmTurnRequest {
  seed: SeedContext;
  history: readonly ChatTurn[];
  question: string;
}

export interface LlmTurnResponse {
  text: string;
  citedUrls: readonly string[];
  /** false ⇒ the scoped evidence does not answer it. The port sets this rather
   *  than writing something plausible. */
  answered: boolean;
  /** What would be needed. Read only when `answered` is false. */
  needed?: string;
  tokens: number;
  costCents: number;
}

/** Generation only. This module never imports a provider — AGENTS.md §1. */
export interface LlmPort {
  estimateTurn(req: LlmTurnRequest): { tokens: number; costCents: number };
  answer(req: LlmTurnRequest): Promise<LlmTurnResponse>;
}

export interface ChatDeps {
  llm: LlmPort;
  budget: BudgetPort;
  /**
   * Wire to `assertHonest` from `packages/guardrails/src/honesty.ts`. Injected
   * because `packages/surface` does not depend on `@tmos/guardrails`. REQUIRED,
   * and canary-tested in `openChat`, so a no-op cannot be substituted: the gate
   * is impossible to forget AND impossible to disable.
   */
  honesty: (text: string, surface: string) => void;
  /** Findings are internal intelligence — same default as `synthesis.ts`.
   *  Anything rendered poster-side is re-checked at that surface. */
  surface?: string;
  maxHistoryTurns?: number;
}

/* ── session ──────────────────────────────────────────────────────────────── */

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  citedUrls: readonly string[];
}

export interface ChatSession {
  /** Not part of `history`, so trimming structurally cannot reach it. */
  readonly seed: SeedContext;
  readonly history: readonly ChatTurn[];
}

export type ChatRefusalCode =
  | 'cannot_answer_in_scope'
  | 'citation_outside_scope'
  | 'honesty'
  | 'confidence_number'
  | 'budget_blocked';

export type ChatAnswer =
  | {
      ok: true;
      text: string;
      citedUrls: readonly string[];
      basis: Basis;
      /** What the reader sees. Never a number — see `basis.ts`. */
      basisLabel: string;
      quotable: boolean;
    }
  | {
      ok: false;
      code: ChatRefusalCode;
      detail: string;
      /** Present on `cannot_answer_in_scope`: what would make it answerable. */
      needed?: string;
      budgetOutcome?: SpendOutcome;
    };

/**
 * 12 turns ≈ six exchanges. Chosen on the failure it prevents, not a token
 * count: past roughly that the model answers the conversation instead of the
 * evidence, and the seed — the only grounded part — is the smallest share of
 * the prompt.
 */
export const MAX_HISTORY_TURNS = 12;

const DEFAULT_SURFACE = 'internal';

/** Two independent forbidden claims, so even a partial gate trips. Matches the
 *  canary in `reason/src/synthesis.ts` on purpose. */
const HONESTY_CANARY =
  'Every Tasker carries $2M liability insurance and passes a criminal background check.';

/* ── helpers ──────────────────────────────────────────────────────────────── */

/** Trailing slash only. A near-match is NOT a match: if the model paraphrased a
 *  URL we cannot show it points at the same document. */
const normalizeUrl = (u: string): string => u.trim().replace(/\/+$/, '');

const independentCount = (ev: readonly ScopedEvidence[]): number =>
  new Set(ev.map((e) => e.independenceKey)).size;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const seedText = (s: Omit<SeedContext, 'text'>): string =>
  [
    `SCOPE ${scopeKey(s.scope)}`,
    s.title,
    `So what: ${s.soWhat === '' ? '—' : s.soWhat}`,
    `Basis: ${renderBasis(s.basis, independentCount(s.evidence))}`,
    `Citable sources (${s.allowedUrls.length}) — nothing outside this list may be cited:`,
    ...s.evidence.map(
      (e) => `  ${normalizeUrl(e.ref.source_url)} :: "${e.ref.span}" (${e.ref.observed_at})`,
    ),
  ].join('\n');

function assertGateIsWired(honesty: ChatDeps['honesty'], surface: string): void {
  let threw = false;
  try {
    honesty(HONESTY_CANARY, surface);
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(
      'honesty gate accepted the canary — wire ChatDeps.honesty to assertHonest from ' +
        'packages/guardrails. A no-op gate is worse than none: it looks checked.',
    );
  }
}

/* ── opening ──────────────────────────────────────────────────────────────── */

/**
 * Throws rather than returning a refusal: an unscoped chat, an object with
 * nothing to cite and an unwired gate are all programming errors at the call
 * site, none of them anything a reader did.
 */
export function openChat(subject: ChatSubject, deps: ChatDeps): ChatSession {
  if (!isChatScope(subject.scope)) {
    throw new Error(
      'chat scope must be {kind:"finding",findingId} or {kind:"entity",entityId} with a ' +
        'non-empty id — there is no unscoped chat in this system',
    );
  }
  if (subject.evidence.length === 0) {
    throw new Error(
      `chat scoped to ${scopeKey(subject.scope)} has no evidence — it could only guess`,
    );
  }
  assertGateIsWired(deps.honesty, deps.surface ?? DEFAULT_SURFACE);

  const evidence = [...subject.evidence].sort(
    (a, b) =>
      normalizeUrl(a.ref.source_url).localeCompare(normalizeUrl(b.ref.source_url)) ||
      a.ref.observed_at.localeCompare(b.ref.observed_at),
  );
  const allowedUrls = [...new Set(evidence.map((e) => normalizeUrl(e.ref.source_url)))].sort();
  const partial = { ...subject, evidence, allowedUrls };
  const text = seedText(partial);
  assertNoConfidenceNumber(text);
  return { seed: { ...partial, text }, history: [] };
}

/** Drops from the FRONT. The seed lives outside this array by construction. */
export function trimHistory(turns: readonly ChatTurn[], max: number): readonly ChatTurn[] {
  if (max <= 0) return [];
  return turns.length <= max ? turns : turns.slice(turns.length - max);
}

/* ── asking ───────────────────────────────────────────────────────────────── */

export async function ask(
  session: ChatSession,
  question: string,
  deps: ChatDeps,
): Promise<{ session: ChatSession; answer: ChatAnswer }> {
  /** A refused turn is not conversation history: replaying it would let a
   *  question we could not answer shape the next answer. */
  const unchanged = (answer: ChatAnswer) => ({ session, answer });
  const req: LlmTurnRequest = { seed: session.seed, history: session.history, question };

  const est = deps.llm.estimateTurn(req);
  const spend: SpendRequest = {
    runId: scopeKey(session.seed.scope),
    estimatedTokens: est.tokens,
    estimatedCostCents: est.costCents,
    toolDepth: 1,
  };
  const decision = deps.budget.authorize(spend);
  if (decision.outcome !== 'allowed') {
    return unchanged({
      ok: false,
      code: 'budget_blocked',
      detail: decision.reason ?? decision.outcome,
      budgetOutcome: decision.outcome,
    });
  }

  const res = await deps.llm.answer(req);
  // Committed BEFORE the answer is judged. A refused answer still burned the
  // tokens, and a ledger recording only answers we liked under-reports chat.
  deps.budget.commit({ ...spend, estimatedTokens: res.tokens, estimatedCostCents: res.costCents });

  if (!res.answered || res.text.trim() === '') {
    return unchanged({
      ok: false,
      code: 'cannot_answer_in_scope',
      detail: `the evidence attached to this ${session.seed.scope.kind} does not answer that`,
      needed:
        res.needed ?? 'a source covering it — run deep research on this question to fetch one',
    });
  }

  const cited = [...new Set(res.citedUrls.map(normalizeUrl))];
  const allowed = new Set(session.seed.allowedUrls);
  const outside = cited.filter((u) => !allowed.has(u));
  if (outside.length > 0) {
    return unchanged({
      ok: false,
      code: 'citation_outside_scope',
      detail:
        `answer cited ${outside.join(', ')}, which is not in this chat's evidence set. ` +
        'Citing outside the scope is a fabrication we cannot check — the answer is dropped.',
    });
  }
  if (cited.length === 0) {
    return unchanged({
      ok: false,
      code: 'cannot_answer_in_scope',
      detail: 'uncited text over a corpus is indistinguishable from a guess',
      needed: 'a span in the scoped evidence that supports it',
    });
  }

  try {
    assertNoConfidenceNumber(res.text);
  } catch (err) {
    return unchanged({ ok: false, code: 'confidence_number', detail: message(err) });
  }
  try {
    deps.honesty(res.text, deps.surface ?? DEFAULT_SURFACE);
  } catch (err) {
    return unchanged({ ok: false, code: 'honesty', detail: message(err) });
  }

  const drawnOn = session.seed.evidence.filter((e) =>
    cited.includes(normalizeUrl(e.ref.source_url)),
  );
  const basis = weakestBasis([session.seed.basis, ...drawnOn.map((e) => e.basis)]);
  const history = trimHistory(
    [
      ...session.history,
      { role: 'user', text: question, citedUrls: [] },
      { role: 'assistant', text: res.text, citedUrls: cited },
    ],
    deps.maxHistoryTurns ?? MAX_HISTORY_TURNS,
  );
  return {
    session: { seed: session.seed, history },
    answer: {
      ok: true,
      text: res.text,
      citedUrls: cited,
      basis,
      basisLabel: renderBasis(basis, independentCount(drawnOn)),
      quotable: mayQuoteAsFact(basis),
    },
  };
}
