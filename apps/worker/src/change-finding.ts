/**
 * A CHANGE ON A WATCHED PAGE BECOMES A FINDING — the step `watch.ts` promised
 * and did not take.
 *
 * Its header says "from run two onward every difference is a Finding", and
 * until now that sentence was aspirational: the watcher detected changes,
 * printed them with a `***` and wrote nothing to the ledger. Every Part gate
 * since Part 5 has carried the same admission — no Finding has ever been minted
 * from a real signal — and the reason was never the reasoning layer. T2, the
 * mint and the five gates were all built and all tested. Nothing joined them to
 * an observation that actually happened.
 *
 * ORDER IS THE WHOLE DESIGN HERE, and it is easy to get backwards. `correlate`
 * asks the world model what we currently hold, so it MUST run BEFORE
 * `recordChange` writes the new value. Recording first makes the observation
 * its own prior: every item classifies as `restated`, the tier that exists to
 * refuse repetition refuses everything, and the system looks healthy while
 * being structurally incapable of reporting a change.
 *
 * THE BASELINE RUN MUST MINT NOTHING. On the first pass we hold no prior, and
 * T2 classifies that as `changed_value` with `priorValue: null` — whose claim
 * template reads "we now hold a value where we previously held none". True, and
 * not intelligence: it is the instrument being installed. Twelve of those on day
 * one would teach a reader that this system's Findings are noise, which is a
 * lesson that cannot be untaught. So a change with no prior is `baseline` here
 * and is counted, not published.
 *
 * A REFUSAL IS AN OUTCOME, NOT AN EXCEPTION. `mintOrThrow` throws when a gate
 * rejects — and it will, legitimately: L0 requires every number in the claim to
 * appear verbatim in the cited span, and a count the model derived by counting
 * a page ("how many categories are listed") is exactly a number no span
 * contains. That refusal is correct and it is information. Every path below
 * returns a counted outcome, so the caller can report "3 changes, 1 minted, 2
 * refused by L0" instead of losing two of them to a stack trace.
 */
import { randomUUID } from 'node:crypto';

import type { EvidenceRef, Finding, Region } from '@tmos/contracts';
import { assertHonest } from '@tmos/guardrails';
import {
  assembleFinding,
  correlate,
  mintOrThrow,
  scoreFinding,
  type DomainScore,
  type EntityHistoryPort,
  type ObservedValue,
  type SourceTier,
  type T2Failure,
  type T2Verdict,
} from '@tmos/reason';

/**
 * The materiality T2 weighs at 0.35 — and a constant, deliberately.
 *
 * T1 never sees a watched page: triage reads a firehose of news and this path
 * reads three pages we chose on purpose, so there is no skim score to carry.
 * The alternative to a constant is inventing one, and an invented 0.7 would be
 * indistinguishable downstream from a number a model actually produced. Fixed
 * for every watch item, it cancels out: items rank against each other on
 * novelty, corroboration and stakes, which are the three terms this path can
 * honestly fill in.
 */
export const WATCH_MATERIALITY = 0.5;

/**
 * FINANCIAL-MODEL §5 in the taskly.ca brain: a 3:1 LTV:CAC ratio on a one-off
 * customer puts the sustainable ceiling at ~$16–22, and the conservative end is
 * the one to enforce. **It is not in the generated FACT-SHEET**, so AGENTS.md
 * rule 7 cannot be satisfied here and this constant is the named gap rather
 * than a silent hardcode. Nothing on this path reads it today — a competitor
 * page change never carries a `channel` proposal, and `checkCac` returns early
 * without one — which is asserted in the tests so the day it starts mattering
 * is the day a test tells someone to go and generate the fact.
 */
export const CAC_CEILING_CENTS = 1_600;

/* ── input ────────────────────────────────────────────────────────────────── */

/**
 * A claim T2's template cannot write.
 *
 * The template renders the observed VALUE — "…is now 51" — which is right for a
 * price and unciteable for anything derived from a document, because L0 wants
 * every number in a claim to appear in a span and a count appears in none. A
 * measure whose change is better described than rendered supplies one of these
 * instead, and gets the same five gates.
 *
 * Returning null means the values differ but the THING does not: a sitemap that
 * reordered itself produces a new string and an identical catalogue. Saying
 * nothing is the correct output, and it is reported as `restated`.
 */
export interface WrittenClaim {
  readonly claim: string;
  readonly so_what: string;
  /** The evidence for THIS sentence — the lines carrying what the claim names. */
  readonly evidence: readonly EvidenceRef[];
}

export type ClaimWriter = (
  prior: ObservedValue,
  next: ObservedValue,
) => WrittenClaim | null;

export interface ObservedChange {
  /** `type:id` per `subjectRefSchema`; `company:<domain>` on this path. */
  readonly subjectRef: string;
  /** What a human calls them. Goes in the claim, so "TaskRabbit", not a uuid. */
  readonly subjectLabel: string;
  readonly predicate: string;
  readonly predicateLabel: string;
  /** `null` when the fact is entity- or json-valued: refused, never guessed. */
  readonly value: ObservedValue | null;
  readonly observedAt: string;
  readonly evidence: readonly EvidenceRef[];
  /**
   * The corroboration ROOT — one origin, because a company's own page is one
   * company saying one thing. Counting the page and the press release that
   * copies it as two would be the mechanism that launders a single claim into
   * consensus, which is what `collapseCopyChains` exists to prevent.
   */
  readonly rootSourceId: string;
  readonly sourceTier: SourceTier;
  readonly stakes: 'low' | 'medium' | 'high';
  /** Supplied by measures whose change needs describing rather than rendering. */
  readonly writeClaim?: ClaimWriter;
}

export interface ChangeFindingDeps {
  readonly history: EntityHistoryPort;
  readonly now: () => Date;
  readonly region: Region;
  /** `agent:model@version` — the identity the adversarial verifier must differ from. */
  readonly generatedBy: string;
  readonly newId?: () => string;
  readonly cacCeilingCents?: number;
}

/* ── outcome ──────────────────────────────────────────────────────────────── */

export type ChangeOutcome =
  /** Published. The Finding is minted and has passed every gate the mint runs. */
  | { readonly kind: 'minted'; readonly finding: Finding; readonly verdict: T2Verdict; readonly score: DomainScore }
  /** The page says what it said last time. The commonest outcome, and free. */
  | { readonly kind: 'restated' }
  /** First observation of this predicate. The instrument being installed. */
  | { readonly kind: 'baseline'; readonly detail: string }
  /** T2 declined to diff it — `unsupported_value`, `no_evidence`, … */
  | { readonly kind: 'refused'; readonly reason: T2Failure; readonly detail: string }
  /** A mint gate rejected the assembled Finding. L0 is the usual one. */
  | { readonly kind: 'rejected'; readonly detail: string };

/* ── the step ─────────────────────────────────────────────────────────────── */

export async function findingFromChange(
  change: ObservedChange,
  deps: ChangeFindingDeps,
): Promise<ChangeOutcome> {
  const result = await correlate(
    {
      subjectRef: change.subjectRef,
      predicate: change.predicate,
      observation: { value: change.value, observedAt: change.observedAt },
      evidence: change.evidence,
      materiality: WATCH_MATERIALITY,
      stakes: change.stakes,
      // Already collapsed: one first-party page is one root, stated rather than
      // counted, so there is no copy chain to walk and no naive count to make.
      corroboration: { kind: 'roots', roots: [change.rootSourceId] },
      labels: { subject: change.subjectLabel, predicate: change.predicateLabel },
    },
    { history: deps.history },
  );

  if (!result.ok) return { kind: 'refused', reason: result.reason, detail: result.detail };

  const verdict = result.verdict;
  if (verdict.classification === 'restated') return { kind: 'restated' };
  if (verdict.priorValue === null) {
    return {
      kind: 'baseline',
      detail:
        `first value held for ${change.subjectLabel} ${change.predicateLabel} — ` +
        'a change detector needs a before and an after, and this is the before',
    };
  }

  const id = (deps.newId ?? randomUUID)();
  const createdAt = deps.now().toISOString();
  const assemble = {
    id,
    createdAt,
    region: deps.region,
    generatedBy: deps.generatedBy,
  };

  if (change.writeClaim) {
    return mintWritten(change, verdict, { id, createdAt, ...deps }, change.writeClaim);
  }

  /**
   * ASSEMBLED TWICE, ON PURPOSE. The domain scorer reads `claim` and `so_what`
   * — the corridor term looks for Toronto in the text — and the assembler is
   * what writes them, so the score cannot be computed before the first pass.
   * Both passes are pure and both are handed the same id and instant, so the
   * second differs from the first in exactly one field. The alternative is
   * `domain_score = verdict.score`, T2's RANKING number, which is what
   * `AssembleOptions` defaults to and which the cascade already ships as a
   * stand-in — a relevance proxy read by every surface as a relevance
   * measurement.
   */
  let draft: Finding;
  try {
    draft = assembleFinding(verdict, assemble);
  } catch (error) {
    return { kind: 'rejected', detail: error instanceof Error ? error.message : String(error) };
  }

  const score = scoreFinding(
    {
      claim: draft.claim,
      so_what: draft.so_what,
      source_tiers: [change.sourceTier],
      channel: null,
    },
    { cacCeilingCents: deps.cacCeilingCents ?? CAC_CEILING_CENTS },
  );

  let finding: Finding;
  try {
    finding = assembleFinding(verdict, { ...assemble, domainScore: score.domain_score });
  } catch (error) {
    return { kind: 'rejected', detail: error instanceof Error ? error.message : String(error) };
  }

  return { kind: 'minted', finding, verdict, score };
}

/* ── the written-claim path ───────────────────────────────────────────────── */

/**
 * Mint a caller-written claim through the same door.
 *
 * `assembleFinding` is not skipped to avoid the gates — it is skipped because
 * its claim template cannot say this sentence. Everything after the sentence is
 * identical: `mintOrThrow` runs the same five gates `assembleFinding` runs,
 * including the honesty denylist over both prose fields, and the evidence the
 * writer chose is the retrieval set L0 validates against, because those spans
 * came off a document we fetched and no model picked a URL.
 */
async function mintWritten(
  change: ObservedChange,
  verdict: T2Verdict,
  ctx: { id: string; createdAt: string } & ChangeFindingDeps,
  write: ClaimWriter,
): Promise<ChangeOutcome> {
  const prior = verdict.priorValue;
  if (prior === null) return { kind: 'baseline', detail: 'no prior to describe a change against' };

  const written = write(prior, verdict.observedValue);
  // The values differ and the thing does not — a reordered document. Nothing
  // to say, and `restated` is exactly what that means.
  if (written === null) return { kind: 'restated' };
  if (written.evidence.length === 0) {
    return {
      kind: 'rejected',
      detail: 'a written claim with no evidence for the values it names is refused',
    };
  }

  const score = scoreFinding(
    {
      claim: written.claim,
      so_what: written.so_what,
      source_tiers: [change.sourceTier],
      channel: null,
    },
    { cacCeilingCents: ctx.cacCeilingCents ?? CAC_CEILING_CENTS },
  );

  let finding: Finding;
  try {
    finding = mintOrThrow(
      {
        id: ctx.id,
        claim: written.claim,
        so_what: written.so_what,
        subject_refs: [change.subjectRef],
        evidence: written.evidence,
        basis: 'inferred_from_sources',
        causal_rung: 0,
        stakes: change.stakes,
        region: ctx.region,
        domain_score: score.domain_score,
        generated_by: ctx.generatedBy,
        created_at: ctx.createdAt,
      },
      {
        honesty: assertHonest,
        surface: 'internal',
        retrievedUrls: written.evidence.map((e) => e.source_url),
      },
    );
  } catch (error) {
    return { kind: 'rejected', detail: error instanceof Error ? error.message : String(error) };
  }

  return { kind: 'minted', finding, verdict, score };
}
