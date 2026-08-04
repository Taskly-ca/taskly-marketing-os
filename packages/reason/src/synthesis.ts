/**
 * SYNTHESIS — ONE WRITER, ALWAYS.
 *
 * Exactly one component turns worker output into Findings. Multiple agents
 * writing into one document produce contradictions that no reviewer can see:
 * each paragraph is locally defensible, the disagreement lives between them,
 * and the person reading at 6pm has no way to notice. Workers gather; this
 * module writes; nothing else may.
 *
 * It refuses more than it emits, on purpose. Four gates, in order, all of them
 * collected so a refusal explains itself completely:
 *
 *   1. so_what — a Finding without a consequence is a fact, not intelligence.
 *                Empty, too short, or a restatement of the claim is refused.
 *   2. honesty — `assertHonest` over claim AND so_what. Both are generated
 *                prose; checking only the claim leaves half of every finding
 *                ungated.
 *   3. causal  — `assertCausalLanguage` against the finding's own causal_rung.
 *                Below rung 2, causal verbs are refused.
 *   4. L0      — every number and date in the claim must appear verbatim in a
 *                cited span, and every cited URL must be one we retrieved.
 *
 * A finding that fails L0 is NOT a draft to fix later. It is a fabrication, and
 * emitting it "for review" is how fabrications get reviewed by a tired human at
 * 6pm and shipped. There is no `force` flag here and there must never be one.
 */
import { findingSchema } from '@tmos/contracts';
import type { Basis, EvidenceRef, Finding, Region } from '@tmos/contracts';
import { assertCausalLanguage } from '@tmos/guardrails';
import type { CausalRung } from '@tmos/guardrails';
import { assertL0 } from './verify/l0.js';
import type { WorkerOutcome } from './tier/workers.js';

/* ── inputs ───────────────────────────────────────────────────────────────── */

export interface SynthesisEvidence {
  url: string;
  span: string;
  observed_at: string;
  signal_id?: string | null;
  fact_id?: string | null;
}

/** What the writer is asked to say. Ids are caller-supplied so the same inputs
 *  yield the same Findings — no uuid generation in library code. */
export interface FindingDraft {
  id: string;
  claim: string;
  so_what: string;
  subject_refs: readonly string[];
  evidence: readonly SynthesisEvidence[];
  basis: Basis;
  causal_rung: CausalRung;
  stakes: 'low' | 'medium' | 'high';
  region: Region;
  domain_score: number;
}

export interface SynthesisDeps {
  /**
   * Wire to `assertHonest` from `packages/guardrails/src/honesty.ts`.
   *
   * Injected only because `@tmos/guardrails`' barrel does not export honesty
   * yet. It is REQUIRED (no default) and is canary-tested before any draft is
   * read, so a no-op cannot be substituted: the gate is impossible to forget
   * AND impossible to disable.
   */
  honesty: (text: string, surface: string) => void;
  /** Injected — no Date.now() in library code. */
  now: () => Date;
  /** 'agent:model@version'. Recorded on every emitted Finding. */
  generatedBy: string;
}

export interface SynthesisInput {
  drafts: readonly FindingDraft[];
  /** Every URL retrieval actually returned this run. L0 refuses anything else. */
  retrievedUrls: readonly string[];
  /**
   * Findings are internal intelligence, so 'internal' is the default: the
   * surface-word rules (escrow, commission, bids) name real mechanics a
   * competitive note must be able to discuss. FORBIDDEN claims — insurance,
   * background checks, guarantees — are banned on every surface including this
   * one, because an internal doc asserting them is how they reach copy later.
   * Anything destined for a poster-facing render is re-checked there.
   */
  surface?: string;
}

/* ── refusals ─────────────────────────────────────────────────────────────── */

export type RefusalCode = 'trivial_so_what' | 'honesty' | 'causal' | 'l0' | 'schema';

export interface RefusalReason {
  code: RefusalCode;
  detail: string;
}

export interface Refusal {
  draftId: string;
  reasons: RefusalReason[];
}

export interface SynthesisResult {
  emitted: Finding[];
  refused: Refusal[];
}

/* ── so_what ──────────────────────────────────────────────────────────────── */

/** Shorter than this states a mood, not a consequence. */
export const MIN_SO_WHAT_CHARS = 20;

/** Share of so_what's words already in the claim, at or above which it is a
 *  restatement. 0.8 leaves room to reuse the subject nouns while still
 *  demanding new content words. */
export const SO_WHAT_MAX_OVERLAP = 0.8;

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function checkSoWhat(claim: string, soWhat: string): RefusalReason | null {
  const trimmed = soWhat.trim();
  if (trimmed.length < MIN_SO_WHAT_CHARS) {
    return {
      code: 'trivial_so_what',
      detail: `so_what is ${trimmed.length} chars; a consequence needs at least ${MIN_SO_WHAT_CHARS}`,
    };
  }
  const soWords = new Set(words(trimmed));
  if (soWords.size === 0) return { code: 'trivial_so_what', detail: 'so_what has no words' };
  const claimWords = new Set(words(claim));
  let shared = 0;
  for (const w of soWords) if (claimWords.has(w)) shared += 1;
  const overlap = shared / soWords.size;
  if (overlap >= SO_WHAT_MAX_OVERLAP) {
    return {
      code: 'trivial_so_what',
      detail:
        `so_what restates the claim (${overlap.toFixed(2)} word overlap, limit ` +
        `${SO_WHAT_MAX_OVERLAP}); say what changes because of it`,
    };
  }
  return null;
}

/* ── the honesty canary ───────────────────────────────────────────────────── */

/** A sentence the real gate must reject. Two independent forbidden claims, so
 *  even a partial implementation trips it. */
const HONESTY_CANARY =
  'Every Tasker carries $2M liability insurance and passes a criminal background check.';

function assertGateIsWired(honesty: SynthesisDeps['honesty']): void {
  let threw = false;
  try {
    honesty(HONESTY_CANARY, 'poster_facing');
  } catch {
    threw = true;
  }
  if (!threw) {
    throw new Error(
      'honesty gate is not wired to a real implementation: it accepted the canary. ' +
        'Wire SynthesisDeps.honesty to assertHonest from packages/guardrails.',
    );
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/* ── worker output ────────────────────────────────────────────────────────── */

/** Pool the evidence workers actually produced, plus the URL set L0 checks
 *  citations against. Failed and rejected workers contribute nothing. */
export function evidencePoolFromWorkers(outcomes: readonly WorkerOutcome[]): {
  evidence: SynthesisEvidence[];
  retrievedUrls: string[];
} {
  const evidence: SynthesisEvidence[] = [];
  const urls = new Set<string>();
  for (const o of outcomes) {
    if (o.status !== 'ok') continue;
    for (const e of o.evidence) {
      evidence.push({ url: e.url, span: e.span, observed_at: e.observed_at });
      urls.add(e.url);
    }
  }
  return { evidence, retrievedUrls: [...urls].sort() };
}

/* ── the writer ───────────────────────────────────────────────────────────── */

const toEvidenceRef = (e: SynthesisEvidence): EvidenceRef => ({
  signal_id: e.signal_id ?? null,
  fact_id: e.fact_id ?? null,
  source_url: e.url,
  span: e.span,
  observed_at: e.observed_at,
});

export function synthesize(input: SynthesisInput, deps: SynthesisDeps): SynthesisResult {
  assertGateIsWired(deps.honesty);
  const surface = input.surface ?? 'internal';
  const createdAt = deps.now().toISOString();

  const emitted: Finding[] = [];
  const refused: Refusal[] = [];

  for (const d of input.drafts) {
    const reasons: RefusalReason[] = [];

    const trivial = checkSoWhat(d.claim, d.so_what);
    if (trivial) reasons.push(trivial);

    // Both generated fields, both gates, every time. There is no path through
    // this loop that generates prose without checking it.
    for (const [field, text] of [
      ['claim', d.claim],
      ['so_what', d.so_what],
    ] as const) {
      try {
        deps.honesty(text, surface);
      } catch (err) {
        reasons.push({ code: 'honesty', detail: `${field}: ${message(err)}` });
      }
      try {
        assertCausalLanguage(text, d.causal_rung);
      } catch (err) {
        reasons.push({ code: 'causal', detail: `${field}: ${message(err)}` });
      }
    }

    const evidence = d.evidence.map(toEvidenceRef);
    const l0 = assertL0({ claim: d.claim, evidence, retrievedUrls: input.retrievedUrls });
    if (!l0.ok) {
      reasons.push({
        code: 'l0',
        detail: l0.violations.map((v) => `${v.code}: ${v.detail}`).join(' | '),
      });
    }

    const finding: Finding = {
      id: d.id,
      claim: d.claim,
      so_what: d.so_what,
      subject_refs: [...d.subject_refs],
      evidence,
      basis: d.basis,
      causal_rung: d.causal_rung,
      stakes: d.stakes,
      region: d.region,
      domain_score: d.domain_score,
      generated_by: deps.generatedBy,
      reviewed_by: null,
      superseded_by: null,
      supersede_reason: null,
      created_at: createdAt,
    };

    const parsed = findingSchema.safeParse(finding);
    if (!parsed.success) {
      reasons.push({
        code: 'schema',
        detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | '),
      });
    }

    if (reasons.length > 0) refused.push({ draftId: d.id, reasons });
    else emitted.push(finding);
  }

  return { emitted, refused };
}

/**
 * The loud form. A refusal that is only returned can be logged and forgotten;
 * a call site that wants the run to stop uses this and gets every reason at
 * once rather than the first one.
 */
export function assertSynthesisClean(result: SynthesisResult): void {
  if (result.refused.length === 0) return;
  const body = result.refused
    .map((r) => `  ${r.draftId}\n${r.reasons.map((x) => `    [${x.code}] ${x.detail}`).join('\n')}`)
    .join('\n');
  throw new Error(`synthesis refused ${result.refused.length} finding(s):\n${body}`);
}
