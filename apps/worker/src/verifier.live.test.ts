/**
 * The verifier against the real model — the one thing a fake cannot tell us.
 *
 * Two questions, and both have bitten this repo already. Does
 * `MODELS.verifier` still EXIST? Groq retired both of the models this system
 * was built on, silently, between one week and the next, and a verifier that
 * 404s returns `uncertain` — which withholds every Finding while the pipeline
 * reports no errors. And does the model obey the protocol: a verdict from the
 * three-word enum, a reason, and a span copied character-for-character from the
 * request or null? `verifyAdversarially` discards a verdict citing a span
 * nobody sent, so a model that paraphrases its citation is a verifier that
 * abstains on everything.
 *
 * The claim that reaches the model is refutable ON ITS SPAN and carries no
 * figure the span lacks — the first draft of this test used a claim with a
 * different price in it and never reached the model at all, because L0 refuted
 * it for free. That is the ladder working, so it is now the first case rather
 * than an accident. The second case asserts the PROTOCOL, not the verdict:
 * pinning "refuted" would turn an honest disagreement into a red build.
 */
import { describe, expect, it } from 'vitest';
import { MODELS } from '@tmos/shared';
import { passesVerification } from '@tmos/reason';

import { createGroqVerifier, verifyForPublication } from './verifier.js';

const HAS_KEY = Boolean(process.env.GROQ_API_KEY);
const URL = 'https://www.handy.com/';
const SPAN = 'Book a top-rated cleaner in Toronto from $39 per hour, with same-day availability.';

const limits = { maxRunTokens: 20_000, maxDailyCostCents: 200, maxToolDepth: 2 };

describe.skipIf(!HAS_KEY)('the adversarial verifier, live', () => {
  const verifier = createGroqVerifier({
    apiKey: process.env.GROQ_API_KEY ?? '',
    limits,
    runId: '00000000-0000-4000-8000-000000000000',
  });

  it('refutes a fabricated figure for free, without reaching the model', async () => {
    const outcome = await verifyForPublication(
      {
        claim: "Handy's lowest advertised price in Toronto is now $59 per hour.",
        evidence: [{ source_url: URL, span: SPAN, observed_at: '2026-08-23T00:00:00.000Z' }],
        generated_by: 'agent:openai/gpt-oss-120b@watch-3',
      },
      { verifier, retrievedUrls: [URL], facts: {} },
    );

    // $59 is in the claim and $39 in the span. Cheapest check first: there is
    // no point paying a model to judge whether a fabricated number is meaningful.
    expect(outcome.stage).toBe('l0');
    expect(outcome.verdict).toBe('refuted');
    expect(passesVerification(outcome)).toBe(false);
  });

  it('is a model that exists, and answers in the protocol', async () => {
    const outcome = await verifyForPublication(
      {
        // No figure the span lacks, so L0 passes and the model is actually
        // asked. The span says same-day availability; this says the opposite.
        claim: 'Handy no longer offers same-day availability in Toronto.',
        evidence: [{ source_url: URL, span: SPAN, observed_at: '2026-08-23T00:00:00.000Z' }],
        generated_by: 'agent:openai/gpt-oss-120b@watch-3',
      },
      { verifier, retrievedUrls: [URL], facts: {} },
    );

    // Reached the model at all. `stage` alone is not enough: a call that 400s
    // also lands on `refutation`, as `uncertain` with the HTTP error in
    // `reason`, and the first run of this test passed while the verifier was
    // rejecting every request. So the failure text is asserted against
    // explicitly — this is the assertion that catches a retired model, a
    // renamed parameter or an expired key.
    expect(outcome.stage).toBe('refutation');
    expect(outcome.reason).not.toMatch(/verifier (call )?failed/);
    expect(outcome.verifier?.model).toBe(MODELS.verifier);
    expect(['refuted', 'survives', 'uncertain']).toContain(outcome.verdict);
    expect(outcome.reason.trim().length).toBeGreaterThan(0);

    // The citation rule. A composed span is discarded upstream, so a model that
    // cannot quote verbatim can never do anything but abstain.
    if (outcome.span !== null) expect(outcome.span).toBe(SPAN);

    // The span asserts same-day availability and the claim denies it, so a
    // verifier reading the evidence should not wave this through. Reported
    // rather than asserted — see the header.
    if (passesVerification(outcome)) {
      console.warn(`verifier PASSED a claim its span contradicts: ${outcome.reason}`);
    } else {
      console.warn(`verdict ${outcome.verdict}: ${outcome.reason}`);
    }
  });
});
