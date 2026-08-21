/**
 * THE SEAMS BETWEEN THE TIERS — settled by the compiler, not by inspection.
 *
 * T1, T2, T3 and synthesis were built in separate lanes that were forbidden to
 * import one another, so each declared its own input shape. That was the right
 * call: it is what let them be built in parallel and changed independently. The
 * cost is that nothing had ever checked that T1's output can actually feed T2,
 * T2's T3, or T3's synthesis. "Structurally compatible by inspection" is a
 * claim ABOUT TYPES, and a claim about types is exactly the kind a compiler
 * should be made to settle.
 *
 * Two proofs, deliberately both:
 *
 *  · The ADAPTERS below are typed. They are the small functions each module's
 *    header tells the integrator to write, and they stop compiling the day a
 *    field on either side is renamed, retyped or dropped — which is better than
 *    a runtime check, because it fails at the drift rather than the next run.
 *  · The walk at the bottom carries ONE item from a skimmed signal to a
 *    synthesised Finding, with real values, through all four synthesis gates.
 *
 * WHAT THIS FOUND. Three seams need a deliberate hand and none of them is a
 * break: T2 holds one `subjectRef` where T3 takes a list; T3 returns ACCOUNTING
 * only, so worker evidence leaves through the executor closure; and
 * `EvidenceRef.source_url` is `SynthesisEvidence.url` under another name — the
 * only field NAME the two sides disagree on, pinned below so that a future
 * reconciliation is noticed rather than discovered.
 */
import { describe, expect, it } from 'vitest';

import { assertHonest } from '@tmos/guardrails';
import type { EvidenceRef, Finding } from '@tmos/contracts';

import { createMemorySkimCache, skimItems } from './tier/t1-skim.js';
import type { SkimItem, SkimPort, SkimResult } from './tier/t1-skim.js';
import { assembleFinding, correlate } from './tier/t2-correlate.js';
import type {
  CorrelateInput,
  EntityHistoryPort,
  ObservedValue,
  T2Verdict,
} from './tier/t2-correlate.js';
import { T3_DEFAULT_LIMITS, createT3Quota, runT3 } from './tier/t3-orchestrator.js';
import type { BudgetPort, T3Candidate, T3Executor } from './tier/t3-orchestrator.js';
import { runWorkers } from './tier/workers.js';
import type { ToolImpl, WorkerOutcome, WorkerSpec } from './tier/workers.js';
import { evidencePoolFromWorkers, synthesize } from './synthesis.js';
import type { FindingDraft, SynthesisDeps, SynthesisEvidence } from './synthesis.js';

const URL_ = 'https://jiffyondemand.com/pricing';
const OBSERVED = '2026-08-04T00:00:00.000Z';
const EARLIER = '2026-06-01T00:00:00.000Z';
const SPAN = 'Jiffy now charges 6000 cents an hour for drain clearing, up from 5000.';
const SIGNAL = '00000000-0000-4000-8000-000000000900';
const FINDING_ID = '00000000-0000-4000-8000-000000000001';

/* ── the adapters: the proof ─────────────────────────────────────────────── */

/** Compiles only when the argument's type is assignable to `To`. Identity at
 *  run time, so a drift is a build failure and never a silent pass. */
const carries =
  <To>() =>
  <From extends To>(v: From): From =>
    v;

/**
 * T1 → T2. Exactly ONE field crosses: the skim's materiality is the number T2
 * weights at 0.35. Subject, predicate, value and evidence come from the signal,
 * because T1 is triage and may not have opinions about truth.
 *
 * What does NOT cross is `SkimResult.id`: `CorrelateInput` has no id field at
 * all, so the only thread back to the skimmed signal is `EvidenceRef.signal_id`
 * — nullable in the contract. Item identity here is a convention, not a type.
 */
const toCorrelateInput = (
  skimmed: SkimResult,
  observed: {
    subjectRef: string;
    predicate: string;
    value: ObservedValue;
    observedAt: string;
    evidence: readonly EvidenceRef[];
  },
): CorrelateInput => ({
  subjectRef: observed.subjectRef,
  predicate: observed.predicate,
  observation: { value: observed.value, observedAt: observed.observedAt },
  evidence: observed.evidence,
  materiality: skimmed.materiality,
  stakes: 'medium',
  corroboration: { kind: 'roots', roots: ['jiffy_site', 'trade_outlet'] },
  labels: { subject: 'Jiffy', predicate: 'hourly rate' },
});

/**
 * T2 → T3. The rank score crosses unchanged — the point of T2 emitting a [0,1]
 * number rather than a verdict — and the single `subjectRef` widens into T3's
 * list. The question and the estimates are the caller's: T2 does not know what
 * will be asked, or what asking it will cost.
 */
const toCandidate = (
  verdict: T2Verdict,
  ask: { id: string; question: string; estimatedTokens: number; estimatedCostCents: number },
): T3Candidate => ({
  id: ask.id,
  question: ask.question,
  score: verdict.score,
  subjectRefs: [verdict.subjectRef],
  estimatedTokens: ask.estimatedTokens,
  estimatedCostCents: ask.estimatedCostCents,
});

/**
 * T2/T3 → synthesis. A Finding T2 assembled re-enters as a draft with claim,
 * consequence, basis, rung, stakes, region and score intact — seven fields the
 * two modules agree on, `causal_rung` included, which is guardrails' CausalRung
 * on one side and the contract's literal union on the other.
 *
 * The evidence is REPLACED, not carried: it comes from the workers the deep run
 * executed, which is also the set L0 checks the citations against.
 */
const toDraft = (assembled: Finding, evidence: readonly SynthesisEvidence[]): FindingDraft => ({
  id: assembled.id,
  claim: assembled.claim,
  so_what: assembled.so_what,
  subject_refs: assembled.subject_refs,
  evidence,
  basis: assembled.basis,
  causal_rung: assembled.causal_rung,
  stakes: assembled.stakes,
  region: assembled.region,
  domain_score: assembled.domain_score,
});

/* ── fixtures ────────────────────────────────────────────────────────────── */

const skimPort: SkimPort = {
  async skim(batch) {
    return batch.map((b) => ({ id: b.id, materiality: 0.72, reason: 'a price we benchmark' }));
  },
};

const item: SkimItem = {
  id: SIGNAL,
  contentHash: 'sha256:jiffy-pricing-v2',
  title: null,
  body: SPAN,
};

const evidenceRef: EvidenceRef = {
  signal_id: SIGNAL,
  fact_id: null,
  source_url: URL_,
  span: SPAN,
  observed_at: OBSERVED,
};

/** Known entity, an older value on record — so this observation is a change. */
const history: EntityHistoryPort = {
  async lookup() {
    return {
      entityKnown: true,
      current: { value: { kind: 'num', num: 5000 }, observedAt: EARLIER },
    };
  },
};

const budget: BudgetPort = { authorize: () => ({ outcome: 'allowed' }), commit: () => {} };

const tools: Record<string, ToolImpl> = { fetch_page: async () => SPAN };

const worker: WorkerSpec = {
  id: 'pricing',
  tools: ['fetch_page'],
  async run(ctx) {
    const body = await ctx.toolbox.call('fetch_page', URL_);
    return { evidence: [{ url: URL_, span: body, observed_at: OBSERVED }] };
  },
};

const deps: SynthesisDeps = {
  honesty: assertHonest,
  now: () => new Date('2026-08-04T06:00:00Z'),
  generatedBy: 'agent:qwen/qwen3.6-27b@2026-06-01',
};

/* ── the walk ────────────────────────────────────────────────────────────── */

describe('one item, T1 → T2 → T3 → synthesis', () => {
  it('reaches a schema-valid Finding, refusing nothing on the way', async () => {
    // T1 — triage.
    const skim = await skimItems([item], { port: skimPort, cache: createMemorySkimCache() });
    const skimmed = skim.results[0]!;
    expect(skimmed.proceed).toBe(true);
    expect(carries<CorrelateInput['materiality']>()(skimmed.materiality)).toBe(0.72);

    // T2 — is it new, and does anyone independent say it?
    const result = await correlate(
      toCorrelateInput(skimmed, {
        subjectRef: 'company:jiffy',
        predicate: 'price.hourly_rate_cents',
        value: { kind: 'num', num: 6000 },
        observedAt: OBSERVED,
        evidence: [evidenceRef],
      }),
      { history },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const verdict = result.verdict;
    expect(verdict.classification).toBe('changed_value');
    expect(verdict.promote).toBe(true);
    // The only identity linking this verdict to the skimmed item.
    expect(verdict.evidence[0]?.signal_id).toBe(item.id);

    // T3 — the deep run. Its result carries ACCOUNTING, so the evidence has to
    // leave through the executor's closure; there is no field for it to ride.
    const gathered = new Map<string, readonly WorkerOutcome[]>();
    const execute: T3Executor = async (c, ctx) => {
      const run = await runWorkers([worker], {
        question: c.question,
        tools,
        maxToolDepth: ctx.toolDepth,
      });
      gathered.set(c.id, run.outcomes);
      return { actualTokens: 4_000, actualCostCents: 90 };
    };

    const t3 = await runT3({
      runId: 'run-1',
      candidates: [
        toCandidate(verdict, {
          id: 'cand-1',
          question: "What changed in Jiffy's hourly rate, and when?",
          estimatedTokens: 5_000,
          estimatedCostCents: 100,
        }),
      ],
      quota: createT3Quota('2026-08-04'),
      limits: T3_DEFAULT_LIMITS,
      deps: { budget, clock: () => new Date('2026-08-04T06:00:00Z'), execute },
    });
    expect(t3.promoted.map((p) => p.status)).toEqual(['ok']);
    expect(t3.quotaExhausted).toBe(false);

    // Synthesis — the one writer.
    const pool = evidencePoolFromWorkers(gathered.get(t3.promoted[0]!.candidateId) ?? []);
    expect(pool.retrievedUrls).toEqual([URL_]);

    const assembled = assembleFinding(verdict, {
      id: FINDING_ID,
      createdAt: OBSERVED,
      region: 'ca',
      generatedBy: deps.generatedBy,
    });
    const out = synthesize(
      { drafts: [toDraft(assembled, pool.evidence)], retrievedUrls: pool.retrievedUrls },
      deps,
    );

    // Not merely "the shapes fit": T2's own claim template and default so_what
    // survive honesty, causal-rung 0 and L0 against a span a worker retrieved.
    expect(out.refused).toEqual([]);
    expect(out.emitted).toHaveLength(1);
    expect(out.emitted[0]?.claim).toBe(assembled.claim);
    expect(out.emitted[0]?.evidence[0]).toMatchObject({ source_url: URL_, span: SPAN });
    expect(out.emitted[0]?.domain_score).toBe(verdict.score);
  });
});

/* ── the divergences, pinned ─────────────────────────────────────────────── */

/** `true` only while `A` is NOT assignable to `B`. */
type NotAssignable<A, B> = A extends B ? false : true;

describe('where the shapes do not simply line up', () => {
  it('needs a rename to carry T2 evidence into a draft: source_url → url', () => {
    // Pinned in the type system, in the direction that matters: the day someone
    // reconciles the two names, this constant stops being `true` and this file
    // stops compiling — which is the correct way to be told.
    const renameRequired: NotAssignable<EvidenceRef, SynthesisEvidence> = true;
    expect(renameRequired).toBe(true);

    expect(Object.keys(evidenceRef)).toContain('source_url');
    expect('url' in evidenceRef).toBe(false);
    const asDraftEvidence: SynthesisEvidence = {
      url: evidenceRef.source_url,
      span: evidenceRef.span,
      observed_at: evidenceRef.observed_at,
      signal_id: evidenceRef.signal_id,
      fact_id: evidenceRef.fact_id,
    };
    expect(asDraftEvidence.url).toBe(URL_);
  });

  it('has exactly two observed-value kinds, so entity and json facts cannot enter T2', () => {
    // `@tmos/world`'s FactValue has four variants (num, text, entity, json) and
    // discriminates on `datatype`, not `kind` — so nothing crosses that seam
    // without an adapter, and the adapter cannot silently forward an entity or
    // a json fact: there is no T2 value to forward it AS. Adding a variant here
    // stops this exhaustive map compiling, which is the moment to decide what
    // `classify` and the claim template should do with it.
    const kinds: Record<ObservedValue['kind'], true> = { num: true, text: true };
    expect(Object.keys(kinds).sort()).toEqual(['num', 'text']);
  });
});
