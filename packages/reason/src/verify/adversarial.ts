/**
 * The adversarial verifier — a second session whose job is to BREAK the finding.
 *
 * Three design commitments, each of which exists because the obvious cheaper
 * version does not work:
 *
 *  1. SEPARATE SESSION, DIFFERENT MODEL. A model asked to check its own output
 *     agrees with itself: it is scoring the continuation it would have written.
 *     So independence is not a convention here, it is a precondition — the port
 *     carries a model identity and this module REFUSES to run when that identity
 *     matches the finding's `generated_by`. A refusal is cheap; a rubber stamp
 *     that looks like verification is not.
 *  2. REFUTE, DO NOT RATE. "Score this claim 1-5" produces 4s. "Find the span
 *     that contradicts this claim" produces either a contradiction or nothing,
 *     and both are useful. Uncertainty defaults to refuted, stated in the
 *     request so the instruction and the behaviour cannot drift apart.
 *  3. CHEAPEST CHECK FIRST. L0 (free, deterministic) then the FACT-SHEET
 *     checklist (free, deterministic) then the model. There is no point asking
 *     a model whether a fabricated number is meaningful.
 *
 * `uncertain` is not a pass. It is routed to a human. See `passesVerification`.
 */
import { assertL0, extractNumbers, normalizeNumeric } from './l0.js';

/* ── the thing under test ─────────────────────────────────────────────────── */

/** Narrow local shapes: a real `Finding`/`EvidenceRef` from `@tmos/contracts`
 *  satisfies these structurally, and this module stays compilable on its own. */
export interface VerifiableEvidence {
  source_url: string;
  span: string;
  /** Carried only so L0 can be handed a real `EvidenceRef` without this module
   *  fabricating a timestamp it does not have. */
  observed_at: string;
}

export interface VerifiableFinding {
  claim: string;
  evidence: readonly VerifiableEvidence[];
  /** `agent:model@version` or `human:<id>` — the contracts format. */
  generated_by: string;
}

/* ── independence ─────────────────────────────────────────────────────────── */

export interface ModelIdentity {
  /** Provider-qualified name, e.g. `anthropic/claude-opus-4`. */
  model: string;
  /** Pinned snapshot. Recorded so an old verdict stays interpretable. */
  version: string;
}

/** `agent:model@version` → identity. Returns null for a human author or junk. */
export function parseGeneratedBy(generatedBy: string): ModelIdentity | null {
  const m = /^agent:([^@]+)@(.+)$/.exec(generatedBy.trim());
  if (!m) return null;
  return { model: m[1]!.trim(), version: m[2]!.trim() };
}

export type IndependenceCheck = { independent: true } | { independent: false; reason: string };

/**
 * A model FAMILY: the vendor, plus the base name with the size and version
 * qualifiers stripped. `openai/gpt-oss-120b` and `openai/gpt-oss-20b` are two
 * sizes of ONE family; `qwen/qwen3.6-27b` is a different one.
 *
 * Groq ids are usually vendor-prefixed (`openai/…`, `qwen/…`, `meta-llama/…`)
 * and sometimes not — `allam-2-7b` carries no prefix, and neither did any of
 * the historical Llama ids — so the vendor is optional. An unprefixed id is
 * vendor UNKNOWN, not vendor NONE: it matches any vendor sharing its stem, so
 * `llama-3.3-70b-versatile` and `meta-llama/llama-4-scout-17b` read as one
 * lineage under two naming conventions. Guessing the other way fails OPEN,
 * which is the one thing this check may not do.
 */
export interface ModelFamily {
  /** Everything before the last `/`, or null when the id carries no prefix. */
  vendor: string | null;
  /** The base name: leading words, up to where the qualifiers start. */
  stem: string;
}

export function modelFamily(model: string): ModelFamily {
  const id = model.trim().toLowerCase();
  const slash = id.lastIndexOf('/');
  const vendor = slash === -1 ? null : id.slice(0, slash) || null;
  const rest = id.slice(slash + 1);

  // Keep the leading words and stop at the first token carrying a digit: that
  // is where the size/version qualifiers begin (`-120b`, `-3.3`, `-v3`), and
  // those are precisely what separates siblings WITHIN a family.
  const kept: string[] = [];
  for (const part of rest.split('-')) {
    if (!/\d/.test(part)) {
      kept.push(part);
      continue;
    }
    const head = part.replace(/\d.*$/, '').replace(/v$/, '');
    if (head.length > 0) kept.push(head);
    break;
  }
  return { vendor, stem: kept.join('-') || rest };
}

const familyLabel = (f: ModelFamily): string =>
  f.vendor === null ? f.stem : `${f.vendor}/${f.stem}`;

/** Same stem, and vendors that do not contradict each other. */
const sameFamily = (a: string, b: string): boolean => {
  const x = modelFamily(a);
  const y = modelFamily(b);
  if (x.stem !== y.stem) return false;
  return x.vendor === null || y.vendor === null || x.vendor === y.vendor;
};

/**
 * Same model ⇒ not independent, **even at a different version**; same FAMILY
 * ⇒ not independent either, because a later snapshot or a smaller sibling
 * shares the training and therefore the blind spots. Anything unparseable ⇒
 * also not independent, because we cannot prove it is — fail closed.
 *
 * The family comparison is not a refinement, it is the point: with two sizes of
 * one family in `MODELS` (`openai/gpt-oss-120b` writing, `openai/gpt-oss-20b`
 * the tempting cheap verifier), comparing ids alone lets exactly the collision
 * this guard exists to prevent read as independence.
 */
export function checkIndependence(verifier: ModelIdentity, generatedBy: string): IndependenceCheck {
  if (/^human:/.test(generatedBy.trim())) return { independent: true };

  const writer = parseGeneratedBy(generatedBy);
  if (!writer) {
    return {
      independent: false,
      reason: `cannot establish verifier independence: generated_by "${generatedBy}" is not "agent:model@version" or "human:<id>"`,
    };
  }
  if (writer.model.trim().toLowerCase() === verifier.model.trim().toLowerCase()) {
    return {
      independent: false,
      reason: `verifier and writer are the same model (${writer.model}); a model asked to check its own output agrees with itself`,
    };
  }
  if (sameFamily(writer.model, verifier.model)) {
    return {
      independent: false,
      reason:
        `verifier ${verifier.model} and writer ${writer.model} are the same model family ` +
        `(${familyLabel(modelFamily(writer.model))}); a sibling shares the training and ` +
        `therefore the blind spots`,
    };
  }
  return { independent: true };
}

/* ── the FACT-SHEET checklist ─────────────────────────────────────────────── */

export interface FactConstant {
  /** The value exactly as the FACT-SHEET writes it: `20%`, `$2.99`. */
  value: string;
  /** Where the code defines it, so a reviewer can go and check. */
  source: string;
  /** Words that identify the subject in prose. Defaults to the key's words. */
  subject?: readonly string[];
}

/** Injected, never copied into this module — a second copy is a second thing
 *  that can go stale, and the whole point of the sheet is that it cannot. */
export type FactSheet = Readonly<Record<string, FactConstant>>;

export interface FactContradiction {
  fact: string;
  expected: string;
  found: string;
  source: string;
  sentence: string;
}

type Unit = 'percent' | 'currency' | 'bare';

const unitOf = (token: string): Unit =>
  token.includes('%') ? 'percent' : token.includes('$') ? 'currency' : 'bare';

const subjectsOf = (key: string, fact: FactConstant): readonly string[] =>
  fact.subject ?? key.split(/[_\s]+/).filter((w) => w.length >= 3);

/**
 * Flag any sentence that names a constant's subject and states a different
 * value of the same unit. Sentence-scoped, because "Taskly takes 20%. Ratings
 * rose 25%." contains both numbers and contradicts nothing; and unit-matched,
 * because a dollar figure can never contradict a percentage.
 *
 * If the correct value appears anywhere in the sentence, the sentence is clean —
 * a claim may compare our 20% against a competitor's 15% without being wrong.
 */
export function checkFactSheet(claim: string, facts: FactSheet): FactContradiction[] {
  const out: FactContradiction[] = [];
  const sentences = claim.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim().length > 0);

  for (const [key, fact] of Object.entries(facts)) {
    const unit = unitOf(fact.value);
    const want = normalizeNumeric(fact.value);
    const subjects = subjectsOf(key, fact).map((s) => s.toLowerCase());

    for (const sentence of sentences) {
      const haystack = sentence.toLowerCase();
      if (!subjects.some((s) => haystack.includes(s))) continue;

      const sameUnit = extractNumbers(sentence).filter((t) => unitOf(t) === unit);
      if (sameUnit.length === 0) continue;
      if (sameUnit.some((t) => normalizeNumeric(t) === want)) continue;

      out.push({
        fact: key,
        expected: fact.value,
        found: sameUnit[0]!,
        source: fact.source,
        sentence: sentence.trim(),
      });
    }
  }
  return out;
}

/* ── the request ──────────────────────────────────────────────────────────── */

export const REFUTE_INSTRUCTION =
  "You are checking another model's work. REFUTE the claim below — do not rate it. " +
  'Use ONLY the spans provided; they are everything the reader will be shown. ' +
  'Quote verbatim the one span your refutation turns on. ' +
  'If you cannot decide, answer "refuted": a claim nobody can confirm must not ship.';

export interface RefutationRequest {
  readonly task: 'refute';
  readonly instruction: string;
  readonly claim: string;
  /** Only the cited spans. The verifier sees what the reader will see. */
  readonly spans: readonly string[];
  readonly constants: ReadonlyArray<{ name: string; value: string; source: string }>;
  readonly default_on_uncertainty: 'refuted';
}

/** Loosely typed on purpose: this crosses a model boundary and is validated. */
export interface RefutationResponse {
  verdict: string;
  reason: string;
  span: string | null;
}

export interface VerifierPort {
  readonly identity: ModelIdentity;
  refute(request: RefutationRequest): Promise<RefutationResponse>;
}

/* ── the verdict ──────────────────────────────────────────────────────────── */

export type Verdict = 'refuted' | 'survives' | 'uncertain';

export interface VerificationOutcome {
  verdict: Verdict;
  /** Which gate decided it. `independence` means the run was refused. */
  stage: 'independence' | 'l0' | 'fact_sheet' | 'refutation';
  reason: string;
  /** The span the verdict turned on, when there is one. */
  span: string | null;
  /** True when nothing automated can settle this. Set for every `uncertain`,
   *  and never for `refuted` — a refutation is already actionable. */
  needs_human: boolean;
  verifier: ModelIdentity | null;
}

/**
 * The only place a caller should decide whether a finding may ship.
 *
 * `uncertain` returns false. It has to: an abstention read as a pass converts
 * every failure of the verifier — a timeout, a malformed response, a model we
 * could not prove independent — into a silent approval, which is worse than
 * having no verifier at all, because the pipeline still looks healthy.
 */
export const passesVerification = (o: VerificationOutcome): boolean => o.verdict === 'survives';

export interface AdversarialOptions {
  verifier: VerifierPort;
  /** Every URL retrieval actually returned this run — L0 needs it. */
  retrievedUrls: Iterable<string>;
  facts: FactSheet;
}

const VERDICTS: readonly string[] = ['refuted', 'survives', 'uncertain'];

export async function verifyAdversarially(
  finding: VerifiableFinding,
  opts: AdversarialOptions,
): Promise<VerificationOutcome> {
  const { verifier, facts } = opts;
  const spans = finding.evidence.map((e) => e.span);

  const independence = checkIndependence(verifier.identity, finding.generated_by);
  if (!independence.independent) {
    return {
      verdict: 'uncertain',
      stage: 'independence',
      reason: independence.reason,
      span: null,
      needs_human: true,
      verifier: null,
    };
  }

  const l0 = assertL0({
    claim: finding.claim,
    evidence: finding.evidence.map((e) => ({ ...e, signal_id: null, fact_id: null })),
    retrievedUrls: opts.retrievedUrls,
  });
  if (!l0.ok) {
    return {
      verdict: 'refuted',
      stage: 'l0',
      reason: `L0: ${l0.violations.map((v) => v.detail).join('; ')}`,
      span: spans[0] ?? null,
      needs_human: false,
      verifier: verifier.identity,
    };
  }

  const contradictions = checkFactSheet(finding.claim, facts);
  const first = contradictions[0];
  if (first) {
    return {
      verdict: 'refuted',
      stage: 'fact_sheet',
      reason: `contradicts ${first.fact} — the claim states ${first.found}, ${first.source} defines ${first.expected}`,
      span: first.sentence,
      needs_human: false,
      verifier: verifier.identity,
    };
  }

  const request: RefutationRequest = {
    task: 'refute',
    instruction: REFUTE_INSTRUCTION,
    claim: finding.claim,
    spans,
    constants: Object.entries(facts).map(([name, f]) => ({
      name,
      value: f.value,
      source: f.source,
    })),
    default_on_uncertainty: 'refuted',
  };

  const abstain = (reason: string): VerificationOutcome => ({
    verdict: 'uncertain',
    stage: 'refutation',
    reason,
    span: null,
    needs_human: true,
    verifier: verifier.identity,
  });

  let response: RefutationResponse;
  try {
    response = await verifier.refute(request);
  } catch (err) {
    return abstain(`verifier failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!VERDICTS.includes(response.verdict)) {
    return abstain(`verifier returned an unrecognised verdict "${response.verdict}"`);
  }
  if (typeof response.reason !== 'string' || response.reason.trim().length === 0) {
    return abstain(
      'verifier returned a verdict with no reason — unreviewable, so it does not count',
    );
  }
  // A verifier quoting a span nobody sent it is not reading the evidence; its
  // verdict, whichever way it went, cannot be trusted.
  if (response.span !== null && !spans.includes(response.span)) {
    return abstain('verifier cited a span that was never sent to it');
  }

  return {
    verdict: response.verdict as Verdict,
    stage: 'refutation',
    reason: response.reason,
    span: response.span,
    needs_human: response.verdict === 'uncertain',
    verifier: verifier.identity,
  };
}
