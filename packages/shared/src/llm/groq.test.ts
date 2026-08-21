/**
 * THE UNIT TEST — literally.
 *
 * `estimateCostCents` is the only thing standing between this system and an
 * unbounded bill, and it fails silently in one specific way: if the numbers in
 * `PRICE_CENTS_PER_MTOK` are in the wrong unit, every call still returns a
 * plausible-looking number, every ledger entry still adds up, and the daily
 * ceiling simply stops at ten times the money it was set to. Nothing throws and
 * nothing looks wrong until the invoice arrives.
 *
 * The unit is not declared by the comment above the table — it is DERIVED from
 * the arithmetic:
 *
 *     cents = (tokens / 1_000_000) * rate
 *
 * For the left-hand side to be cents (which `BudgetLimits.maxDailyCostCents`
 * requires, since the ledger compares them directly), `rate` must be cents per
 * million tokens. Groq publishes dollars per million, so the table is the
 * published figure × 100. The previous table used × 10.
 *
 * So this file pins the unit with a worked example against the published price,
 * and then pins the consequence: how many calls the default $20/day ceiling
 * actually permits. A tenfold unit slip changes 26 into 266, and that assertion
 * is the one that cannot be argued with.
 */
import { describe, it, expect } from 'vitest';
import { MODELS, callGroq, estimateCostCents } from './groq.js';
import { authorizeSpend, commitSpend, createBudgetState } from './budget.js';
import type { BudgetLimits } from './budget.js';

/** One million tokens — the denominator the table is quoted in. */
const M = 1_000_000;

/**
 * Groq's published rates, in DOLLARS per million tokens, read from
 * https://console.groq.com/docs/models on 2026-08-22. Restated here in the
 * provider's own unit so the conversion is visible in the assertion rather than
 * hidden in the table.
 */
const PUBLISHED_USD_PER_MTOK = {
  [MODELS.strong]: { in: 0.15, out: 0.6 },
  [MODELS.small]: { in: 0.075, out: 0.3 },
  [MODELS.verifier]: { in: 0.6, out: 3.0 },
} as const;

describe('the cost table is CENTS per MILLION tokens', () => {
  it('worked example: 1M in + 1M out on the strong model costs 75¢, not 7.5¢', () => {
    // openai/gpt-oss-120b is published at $0.15 per 1M input and $0.60 per 1M
    // output. In the unit the ledger speaks:
    //     1M input  → $0.15 → 15¢
    //     1M output → $0.60 → 60¢
    //     together             75¢  = $0.75
    expect(estimateCostCents(MODELS.strong, M, 0)).toBe(15);
    expect(estimateCostCents(MODELS.strong, 0, M)).toBe(60);
    expect(estimateCostCents(MODELS.strong, M, M)).toBe(75);
  });

  it('every named model converts from the published dollar rate by exactly ×100', () => {
    for (const [model, usd] of Object.entries(PUBLISHED_USD_PER_MTOK)) {
      expect(estimateCostCents(model, M, 0)).toBeCloseTo(usd.in * 100, 9);
      expect(estimateCostCents(model, 0, M)).toBeCloseTo(usd.out * 100, 9);
    }
  });

  it('a realistic T1 skim is a fraction of a cent — the tier is only cheap in the right unit', () => {
    // 6k prompt tokens (20 items × ~1200 chars) and 800 completion tokens.
    const skim = estimateCostCents(MODELS.small, 6_000, 800);
    expect(skim).toBeCloseTo(0.069, 6); // 6000/1e6*7.5 + 800/1e6*30
    expect(skim).toBeLessThan(0.1);
    // And the whole reason T1 does not use the strong model.
    expect(skim).toBeLessThan(estimateCostCents(MODELS.strong, 6_000, 800));
  });
});

describe('the unit is the daily ceiling', () => {
  it('$20/day buys 26 million-token calls on the strong model, not 266', () => {
    // TMOS_MAX_DAILY_COST_CENTS defaults to 2000 — twenty dollars.
    const limits: BudgetLimits = {
      maxRunTokens: Number.MAX_SAFE_INTEGER,
      maxDailyCostCents: 2_000,
      maxToolDepth: 8,
    };
    const state = createBudgetState();
    const costCents = estimateCostCents(MODELS.strong, M, M); // 75

    let allowed = 0;
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const req = {
        runId: 'ceiling',
        estimatedTokens: 2 * M,
        estimatedCostCents: costCents,
        toolDepth: 0,
      };
      if (authorizeSpend(state, limits, req).outcome !== 'allowed') break;
      commitSpend(state, req);
      allowed += 1;
    }

    // 26 × 75¢ = 1950¢; the 27th would reach 2025¢ and is refused.
    expect(allowed).toBe(26);
    expect(state.dailyCostCents).toBe(1_950);
    // The slip this test exists to catch: at ×10 too small, the same ceiling
    // would have waved through 266 of these and spent $200.
    expect(allowed).toBeLessThan(30);
  });

  it('the ledger records the same cents the table quotes, through the chokepoint', async () => {
    const state = createBudgetState();
    const limits: BudgetLimits = {
      maxRunTokens: 10 * M,
      maxDailyCostCents: 2_000,
      maxToolDepth: 8,
    };
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: M, completion_tokens: M },
          model: MODELS.strong,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const res = await callGroq(
      { model: MODELS.strong, messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: 'test', state, limits, runId: 'ledger', fetchImpl, now: () => 0 },
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.usage.costCents).toBe(75);
    expect(state.dailyCostCents).toBe(75);
  });
});

describe('the model roles', () => {
  const family = (id: string): string => id.split('/')[0]!;

  it('the verifier is a different FAMILY from the models that write', () => {
    // `verify/adversarial.ts` refuses a verifier whose identity matches the
    // writer's. That check compares ids, so it would NOT catch a same-family
    // pair — and strong/small ARE the same family. The separation therefore has
    // to hold here, in the registry, which is what this pins.
    expect(family(MODELS.strong)).toBe(family(MODELS.small));
    expect(family(MODELS.verifier)).not.toBe(family(MODELS.strong));
    expect(family(MODELS.verifier)).not.toBe(family(MODELS.small));
  });

  it('no named model is silently free, and the fallback is the dearest one', () => {
    for (const model of Object.values(MODELS)) {
      expect(estimateCostCents(model, M, M)).toBeGreaterThan(0);
    }
    // An id we do not know is priced as the most expensive one we do: an
    // over-estimate costs a call, an under-estimate costs money.
    const unknown = estimateCostCents('some/model-shipped-tomorrow', M, M);
    expect(unknown).toBe(360);
    for (const model of Object.values(MODELS)) {
      expect(unknown).toBeGreaterThanOrEqual(estimateCostCents(model, M, M));
    }
  });

  it('a retired id prices at the fallback, so a stale call site is expensive, not cheap', () => {
    // Groq answers `model_not_found` for both of these now. If one survives in
    // a call site somewhere, it must not also look like the bargain it used to
    // be — 5.9¢/Mtok in the old table, which was itself ten times too low.
    expect(estimateCostCents('llama-3.3-70b-versatile', M, 0)).toBe(60);
    expect(estimateCostCents('llama-3.1-8b-instant', M, 0)).toBe(60);
  });
});
