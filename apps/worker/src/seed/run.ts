/**
 * Instantiate the seed questions as real predictions.
 *
 * Part 1's gate has carried this since August: "seed questions are written but
 * not yet instantiated as predictions — that needs a live DB and a `p` per
 * question." The database exists now.
 *
 * Every write goes through `writePrediction`, which DRY-RUNS the resolver and
 * refuses the claim if it cannot execute today. That gate is the point of the
 * ledger, so this script does not route around it: a question that cannot be
 * machine-scored is reported as refused, with its reason, rather than being
 * quietly downgraded to `manual` so the count comes out at twenty.
 */
import { SEED_QUESTIONS, writePrediction, PredictionRejected } from '@tmos/intel';
import { createPostgresPredictionStore, createResolverContext } from '@tmos/adapters';
import { closePool } from '@tmos/db';

import { AGENT_FORECASTS } from './probabilities.js';

/** This agent, at this version. Not `human:` — nobody has given a human `p`. */
const AUTHOR = 'agent:claude-opus-5@2026-08-22';

async function main(): Promise<void> {
  const store = createPostgresPredictionStore();
  const ctx = createResolverContext();

  const written: string[] = [];
  const skipped: string[] = [];
  const refused: Array<{ key: string; reason: string }> = [];

  // IDEMPOTENT BY CLAIM+AUTHOR. There is no unique index behind this — and there
  // should not be, because the whole design is that the founder writes a SECOND
  // row for the same claim under a `human:` author, scored separately. So the
  // key is (claim, author), not claim. Learned the hard way: running this twice
  // produced 24 rows for 13 questions, and a duplicated forecast double-counts
  // in every calibration score it touches.
  const existing = new Set((await store.all()).map((r) => `${r.author}\u0000${r.claim}`));

  for (const q of SEED_QUESTIONS) {
    if (existing.has(`${AUTHOR}\u0000${q.claim}`)) {
      skipped.push(q.key);
      continue;
    }
    const forecast = AGENT_FORECASTS[q.key];
    if (!forecast) {
      refused.push({ key: q.key, reason: 'no agent forecast authored for this question' });
      continue;
    }

    try {
      const rec = await writePrediction(
        store,
        {
          claim: q.claim,
          p: forecast.p,
          author: AUTHOR,
          resolve_at: q.resolve_at,
          resolver: q.resolver,
          // Frozen at write time — Part 1's temporal-leakage guard. A prediction
          // that can see evidence gathered later resolves itself.
          evidence: { key: q.key, rationale: q.rationale, because: forecast.because },
        },
        ctx,
      );
      written.push(`  ✓ ${q.key.padEnd(28)} p=${String(forecast.p).padEnd(5)} ${rec.resolver.kind.padEnd(14)} ${q.resolve_at.slice(0, 10)}`);
    } catch (err) {
      refused.push({
        key: q.key,
        reason: err instanceof PredictionRejected ? err.message : String(err),
      });
    }
  }

  console.log(`\nWRITTEN (${written.length}/${SEED_QUESTIONS.length})`);
  written.forEach((l) => console.log(l));

  if (skipped.length) {
    console.log(`\nALREADY IN THE LEDGER (${skipped.length}): ${skipped.join(', ')}`);
  }

  if (refused.length) {
    console.log(`\nREFUSED (${refused.length}) — reported, not worked around:`);
    for (const r of refused) console.log(`  ✗ ${r.key}\n      ${r.reason}`);
  }

  const all = await store.all();
  const mine = all.filter((p) => p.author === AUTHOR);
  console.log(`\nledger now holds ${all.length} predictions (${mine.length} by ${AUTHOR})`);

  const due = await store.due(new Date());
  console.log(`due for resolution right now: ${due.length} (expected 0 — every horizon is in the future)`);

  await closePool();
}

main().catch(async (err) => {
  console.error('seed failed:', err);
  await closePool();
  process.exit(1);
});
