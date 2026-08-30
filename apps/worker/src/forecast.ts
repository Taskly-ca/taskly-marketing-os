/**
 * WRITE YOUR OWN FORECAST — the other half of the calibration ledger.
 *
 * `SEED_QUESTIONS` ships without a `p`, deliberately, and its header says why:
 * the founder and the agent each supply their own probability for the SAME
 * question, and they are scored separately. That comparison is what the
 * architecture calls the most valuable output this system produces.
 *
 * It has had one side since August. Thirteen rows went in as
 * `agent:claude-opus-5` and `writePrediction` was never called from anywhere
 * else, so there was no way to author a human forecast that did not involve
 * editing TypeScript and re-running a seed script. This is the door.
 *
 * ── THE ANCHORING RULE, WHICH IS THE WHOLE REASON THIS IS NOT A ONE-LINER ───
 *
 * The agent's `p` lives one file away in `seed/probabilities.ts`. A human who
 * reads 0.85 before writing their own number does not produce an independent
 * forecast — they produce a slightly-adjusted copy, and scoring two correlated
 * numbers against each other measures nothing at all. Worse, it would look like
 * it was working: two columns, two Brier scores, one of them meaningless.
 *
 * So `list` shows the QUESTION and never the agent's answer. The agent's number
 * appears only after your own row exists, when it can no longer move you.
 *
 * ── WHAT IS NOT ENFORCED HERE, ON PURPOSE ──────────────────────────────────
 *
 * The resolver dry-run, the 0.01–0.99 clamp and the frozen evidence snapshot
 * all live in `writePrediction`, which is the only sanctioned way into the
 * ledger. This file does not re-implement any of them — a second copy of a gate
 * is a second answer to what the gate permits.
 */
import { SEED_QUESTIONS, writePrediction, PredictionRejected } from '@tmos/intel';
import { createPostgresPredictionStore, createResolverContext } from '@tmos/adapters';
import { closePool } from '@tmos/db';
import { pathToFileURL } from 'node:url';

type Question = (typeof SEED_QUESTIONS)[number];
interface Row {
  readonly author: string;
  readonly claim: string;
  readonly p: number;
}

/**
 * Whose forecast this is.
 *
 * `human:` is not decoration — `resolve.ts` splits the calibration report on
 * exactly this prefix, so a row authored any other way is scored into the
 * agent's column and quietly corrupts the comparison it was written to make.
 */
export const HUMAN_AUTHOR = 'human:nishant';

/**
 * A probability, or a refusal that names the mistake.
 *
 * `85` is the mistake worth catching by name. Clamping it to 0.99 would record
 * a near-certainty the founder never expressed and then score them on it, which
 * is the kind of silent corruption a ledger cannot recover from.
 */
export function parseProbability(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`"${raw}" is not a number — give a probability like 0.7`);
  if (n > 1) {
    throw new Error(
      `"${raw}" looks like a percentage — give a probability between 0.01 and 0.99 (${n}% is ${n / 100})`,
    );
  }
  if (n < 0.01 || n > 0.99) {
    throw new Error(
      `"${raw}" must be between 0.01 and 0.99 — a forecast that cannot be wrong is not a forecast`,
    );
  }
  return n;
}

const mine = (existing: readonly Row[], claim: string): Row | undefined =>
  existing.find((r) => r.author === HUMAN_AUTHOR && r.claim === claim);

/** The question named, or a refusal. Never a free-text claim: hand-picking the
 *  question is the selection bias `SEED_QUESTIONS` exists to prevent. */
export function chooseQuestion(
  questions: readonly Question[],
  key: string,
  existing: readonly Row[],
): Question {
  const q = questions.find((x) => x.key === key);
  if (!q) {
    throw new Error(
      `unknown question "${key}" — the open ones are:\n  ${questions.map((x) => x.key).join('\n  ')}`,
    );
  }
  if (mine(existing, q.claim)) {
    throw new Error(
      `you have already forecast "${key}". A second row under the same author double-counts in every score it touches.`,
    );
  }
  return q;
}

interface Summary {
  readonly key: string;
  readonly claim: string;
  readonly resolve_at: string;
  readonly yours: number | null;
  /** The agent's `p`, revealed ONLY once yours exists. See the anchoring rule. */
  readonly agent: number | null;
}

export function summarise(questions: readonly Question[], existing: readonly Row[]): Summary[] {
  return questions.map((q) => {
    const ours = mine(existing, q.claim);
    const agent = existing.find((r) => r.author.startsWith('agent:') && r.claim === q.claim);
    return {
      key: q.key,
      claim: q.claim,
      resolve_at: q.resolve_at,
      yours: ours?.p ?? null,
      agent: ours ? (agent?.p ?? null) : null,
    };
  });
}

/* ── the CLI ──────────────────────────────────────────────────────────────── */

const HELP = `tmos forecast — write your own probability on a seed question

  forecast                          list the questions and which you have answered
  forecast <key> <p> "<because>"    record your forecast

  <p>        a probability, 0.01 to 0.99 (not a percentage)
  <because>  why. Required — a forecast with no reasoning teaches nothing when
             it resolves, and the reasoning is frozen at write time so it cannot
             be rewritten once you know the answer.

The agent's forecast for a question is hidden until you have written yours.
That is deliberate: reading it first makes your number a copy of it, and two
correlated numbers cannot be scored against each other.`;

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return;
  }

  const store = createPostgresPredictionStore();
  const existing = (await store.all()) as unknown as Row[];

  const args = argv.filter((a) => a !== '--');
  if (args.length === 0) {
    const rows = summarise(SEED_QUESTIONS, existing);
    const open = rows.filter((r) => r.yours === null);
    console.log(`\n${rows.length} seed questions · you have forecast ${rows.length - open.length}\n`);
    for (const r of rows) {
      const head = r.yours === null ? '  ○' : '  ●';
      const you = r.yours === null ? 'you: —    ' : `you: ${r.yours.toFixed(2)} `;
      const ag = r.agent === null ? '' : `  agent: ${r.agent.toFixed(2)}`;
      console.log(`${head} ${r.key.padEnd(28)} ${you}${ag}`);
      console.log(`      ${r.claim}`);
      console.log(`      resolves ${r.resolve_at.slice(0, 10)}\n`);
    }
    if (open.length > 0) {
      console.log(`Write one:  pnpm --filter @tmos/worker forecast ${open[0]!.key} 0.6 "your reasoning"`);
    }
    return;
  }

  const [key, prob, ...rest] = args;
  const because = rest.join(' ').trim();
  if (!key || !prob || because === '') {
    throw new Error('need a question key, a probability and a reason.\n\n' + HELP);
  }

  const q = chooseQuestion(SEED_QUESTIONS, key, existing);
  const p = parseProbability(prob);

  const rec = await writePrediction(
    store,
    {
      claim: q.claim,
      p,
      author: HUMAN_AUTHOR,
      resolve_at: q.resolve_at,
      resolver: q.resolver,
      // Frozen and hashed at write time — the temporal-leakage guard. What you
      // knew when you forecast cannot be edited once the outcome is known.
      evidence: { key: q.key, rationale: q.rationale, because },
    },
    createResolverContext(),
  );

  const agent = existing.find((r) => r.author.startsWith('agent:') && r.claim === q.claim);
  console.log(`\n✓ recorded — ${q.key}  p=${p}  resolves ${rec.resolve_at.slice(0, 10)}`);
  console.log(`  ${q.claim}`);
  if (agent) {
    console.log(`\n  the agent said ${agent.p.toFixed(2)} on this one. Scored separately; neither moves the other.`);
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
    .catch((err: unknown) => {
      console.error(err instanceof PredictionRejected ? `refused: ${err.message}` : String(err instanceof Error ? err.message : err));
      process.exitCode = 1;
    })
    .finally(closePool);
}
