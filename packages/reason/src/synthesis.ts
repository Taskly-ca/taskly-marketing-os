/**
 * SYNTHESIS — the batch writer.
 *
 * Exactly one component turns worker output into Findings. Multiple agents
 * writing into one document produce contradictions that no reviewer can see:
 * each paragraph is locally defensible, the disagreement lives between them,
 * and the person reading at 6pm has no way to notice. Workers gather; this
 * module writes; nothing else may.
 *
 * "Nothing else may" is now enforced rather than asserted. The Finding object
 * itself is built by `finding/mint.ts`, which runs the gates and is the only
 * module in this package that constructs one — this file assembles drafts and
 * hands them over. T2's `assembleFinding` goes through the same door.
 *
 * What is left here is the batch shape: pooling worker evidence, and emitting
 * or refusing each draft in a single deterministic pass. It refuses more than
 * it emits, on purpose, and every reason a draft was refused comes back at
 * once rather than one per round-trip.
 *
 * A finding that fails L0 is NOT a draft to fix later. It is a fabrication, and
 * emitting it "for review" is how fabrications get reviewed by a tired human at
 * 6pm and shipped. There is no `force` flag here and there must never be one.
 */
import type { Basis, EvidenceRef, Finding, Region } from '@tmos/contracts';
import type { CausalRung } from '@tmos/guardrails';
import { assertGatesAreWired, mintFinding } from './finding/mint.js';
import type { HonestyGate, RefusalReason } from './finding/mint.js';
import type { WorkerOutcome } from './tier/workers.js';

/** The gate set and the so_what thresholds live with the mint now. Re-exported
 *  because they were part of this module's surface first, and a consumer
 *  should not have to care which file the rule moved to. */
export type { RefusalCode, RefusalReason } from './finding/mint.js';
export { MIN_SO_WHAT_CHARS, SO_WHAT_MAX_OVERLAP } from './finding/mint.js';

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
   * Injected so a caller can pin a surface-specific gate, not so the gate can
   * be opted out of. It is REQUIRED (no default) and canary-tested before any
   * draft is read AND again inside the mint, so a no-op cannot be substituted:
   * the gate is impossible to forget AND impossible to disable.
   */
  honesty: HonestyGate;
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

export interface Refusal {
  draftId: string;
  reasons: RefusalReason[];
}

export interface SynthesisResult {
  emitted: Finding[];
  refused: Refusal[];
}

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
  // The mint canaries the gates too. This up-front call is what makes a stubbed
  // gate fail a run of ZERO drafts — the case where nothing else would notice.
  assertGatesAreWired(deps.honesty);
  const gates = {
    honesty: deps.honesty,
    surface: input.surface ?? 'internal',
    retrievedUrls: input.retrievedUrls,
  };
  const createdAt = deps.now().toISOString();

  const emitted: Finding[] = [];
  const refused: Refusal[] = [];

  for (const d of input.drafts) {
    const result = mintFinding(
      {
        id: d.id,
        claim: d.claim,
        so_what: d.so_what,
        subject_refs: d.subject_refs,
        evidence: d.evidence.map(toEvidenceRef),
        basis: d.basis,
        causal_rung: d.causal_rung,
        stakes: d.stakes,
        region: d.region,
        domain_score: d.domain_score,
        generated_by: deps.generatedBy,
        created_at: createdAt,
      },
      gates,
    );
    if (result.ok) emitted.push(result.finding);
    else refused.push({ draftId: d.id, reasons: result.reasons });
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
