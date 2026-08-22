/**
 * THE ADVERSARIAL VERIFIER, ON THE LIVE PATH.
 *
 * `verify/adversarial.ts` was built in Part 5 with a port and no
 * implementation: three design commitments, a full ladder, 100% tested against
 * a fake, and nothing that ever called a model. So every Finding this system
 * has minted shipped unverified, including the one that turned out to be
 * extractor drift.
 *
 * The module's first commitment is the one that shapes this file: SEPARATE
 * SESSION, DIFFERENT MODEL. `adversarial.ts` refuses to run when the verifier
 * shares the writer's family, and it compares FAMILIES rather than ids because
 * `MODELS` holds two sizes of gpt-oss and the cheap 20b sibling is exactly the
 * tempting wrong choice. `MODELS.verifier` is `qwen/qwen3.6-27b` for that
 * reason and no other, and its output costs 5× the strong model's — an argument
 * for short refutations, never for verifying with a relative of the writer.
 *
 * ── THE SCOPE RULE, and why it lives here rather than in the FACT-SHEET reader
 *
 * `checkFactSheet` flags a sentence that names any of a constant's subject
 * words and states a different value of the same unit. That is right for a
 * claim about our own numbers and wrong for a claim about someone else's:
 * "Handy's commission is 15%" names a commission and a percentage and would be
 * refuted for disagreeing with OUR 20%. Refuting a true statement about a
 * competitor is worse than missing a false one about ourselves, because it
 * trains a reader to overrule the gate.
 *
 * The sheet's constants are all statements about Taskly, so a claim that does
 * not mention Taskly cannot contradict one. That is the scope rule, it needs
 * the claim to evaluate, and the claim is only known here.
 *
 * ── WHAT AN ABSTENTION MEANS
 *
 * `passesVerification` is false for `uncertain`, and this file does not soften
 * that. A timeout, a malformed response, a model we cannot prove independent —
 * each returns a Finding that does not ship and does need a human. The
 * alternative converts every failure of the verifier into a silent approval
 * while the pipeline still looks healthy.
 */
import {
  MODELS,
  callGroq,
  createBudgetState,
  type BudgetLimits,
  type GroqUsage,
} from '@tmos/shared';
import {
  verifyAdversarially,
  type FactSheet,
  type RefutationRequest,
  type RefutationResponse,
  type VerificationOutcome,
  type VerifiableFinding,
  type VerifierPort,
} from '@tmos/reason';

/**
 * Pinned so an old verdict stays interpretable: `identity.version` is recorded
 * with the outcome, and "verified by qwen" is not a fact anyone can re-check a
 * month later. Bump it when the prompt or the model snapshot changes — those
 * are the two things that make two verdicts incomparable.
 */
export const VERIFIER_VERSION = '2026-08-23';

/** Reasoning tokens bill at the output rate, and the answer is three fields. */
const MAX_TOKENS = 2_000;

/**
 * `none`, and it must be spelled that way for THIS model.
 *
 * gpt-oss takes `low | medium | high`; qwen3.6 takes `none | default` and Groq
 * answers `low` with a 400. A 400 here is not a loud failure — it becomes
 * `uncertain`, which withholds every Finding while the run reports no errors —
 * so it is worth stating plainly: this constant is tied to `MODELS.verifier`
 * and moves with it. Found on the verifier's first live call, 2026-08-23.
 */
const VERIFIER_REASONING = 'none' as const;

interface GroqVerifierOptions {
  readonly apiKey: string;
  readonly limits: BudgetLimits;
  readonly runId: string;
  /** Called for every attempt, spent or blocked, so the daily ceiling and the
   *  audit trail see verification spend like any other. */
  readonly onUsage?: (usage: GroqUsage & { outcome: string; reason: string }) => Promise<void>;
}

/**
 * The request goes over as JSON, verbatim.
 *
 * `RefutationRequest` already carries the instruction, the claim, the spans,
 * the constants and `default_on_uncertainty`. Rewriting it into prose here
 * would put a second, drifting copy of the refutation protocol in this file —
 * the same failure as copying the FACT-SHEET. The model is told to answer in
 * the shape `RefutationResponse` declares and nothing else.
 */
const SYSTEM = [
  'You are an adversarial verifier. The user message is a JSON refutation request.',
  'Follow its "instruction" field exactly. It is the protocol; this message is only the envelope.',
  '',
  'Answer with JSON only: {"verdict":"refuted"|"survives"|"uncertain","reason":"<one sentence>","span":"<a span copied verbatim from the request, or null>"}',
  '',
  '"span" must be one of the strings in the request\'s "spans" array, character for character, or null.',
  'A span you compose yourself, or trim, is not a citation and the verdict will be discarded.',
].join('\n');

export function createGroqVerifier(options: GroqVerifierOptions): VerifierPort {
  return {
    identity: { model: MODELS.verifier, version: VERIFIER_VERSION },

    async refute(request: RefutationRequest): Promise<RefutationResponse> {
      const state = createBudgetState();
      const res = await callGroq(
        {
          model: MODELS.verifier,
          json: true,
          reasoningEffort: VERIFIER_REASONING,
          maxTokens: MAX_TOKENS,
          messages: [
            { role: 'system', content: SYSTEM },
            { role: 'user', content: JSON.stringify(request) },
          ],
        },
        { apiKey: options.apiKey, state, limits: options.limits, runId: options.runId },
      );

      if (!res.ok) {
        await options.onUsage?.({
          promptTokens: 0,
          completionTokens: 0,
          costCents: 0,
          outcome: res.reason === 'blocked' ? res.outcome : 'failed',
          reason: `verify:${res.reason}`,
        });
        // Thrown, not swallowed into a verdict: `verifyAdversarially` catches
        // this and returns `uncertain`, which does not ship and does reach a
        // human. A caught error turned into "survives" is the failure mode the
        // whole ladder exists to prevent.
        throw new Error(`verifier call failed: ${JSON.stringify(res).slice(0, 200)}`);
      }

      await options.onUsage?.({ ...res.usage, outcome: 'allowed', reason: 'verify' });

      const parsed = JSON.parse(res.text) as Partial<RefutationResponse>;
      return {
        verdict: String(parsed.verdict ?? ''),
        reason: String(parsed.reason ?? ''),
        span: typeof parsed.span === 'string' ? parsed.span : null,
      };
    },
  };
}

/* ── the scope rule ───────────────────────────────────────────────────────── */

/**
 * Does this claim make a statement the FACT-SHEET could contradict?
 *
 * Substring, not word-boundary: "Taskly's" and "Taskly.ca" both count, and
 * there is no second brand this could collide with.
 */
export const mentionsTaskly = (text: string): boolean => /taskly/i.test(text);

interface VerifyOptions {
  readonly verifier: VerifierPort;
  readonly retrievedUrls: Iterable<string>;
  /** The whole sheet. Applied only to claims that mention Taskly. */
  readonly facts: FactSheet;
}

export async function verifyForPublication(
  finding: VerifiableFinding,
  opts: VerifyOptions,
): Promise<VerificationOutcome> {
  return verifyAdversarially(finding, {
    verifier: opts.verifier,
    retrievedUrls: opts.retrievedUrls,
    // Out of scope ⇒ no constants, never a softer check on the ones in scope.
    facts: mentionsTaskly(finding.claim) ? opts.facts : {},
  });
}
