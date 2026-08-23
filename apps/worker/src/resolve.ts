/**
 * `pnpm --filter @tmos/worker resolve` — the loop the whole architecture is
 * an argument for.
 *
 * TMOS-ARCHITECTURE §1: "The durable asset is not the digest. It is a scored
 * track record, a world model with history, and a playbook library whose claims
 * are ledgered." Three things compound; calibration is the first, and it is the
 * one that cannot be faked later — a track record has to be accumulated in
 * order, with the prediction written before the outcome was known.
 *
 * Part 1 built every piece in August: `runDueResolvers`, four resolver kinds,
 * Brier and log scoring, the Murphy decomposition, Platt scaling, a Postgres
 * store, and a resolver context whose SQL capability authenticates as an
 * unprivileged read-only role. Thirteen predictions have been sitting in the
 * database with `resolve_at` dates since the seeding run.
 *
 * **Nothing has ever resolved one.** The ledger has been accumulating unresolved
 * predictions, which is a to-do list, not a track record.
 *
 * ── WHAT THIS DOES NOT DO, AND WHY THAT IS THE DESIGN
 *
 * It never guesses. `runDueResolvers` annuls on ambiguity — no score, no
 * penalty — because a guessed resolution is indistinguishable from a real one
 * in the aggregate and quietly destroys the only asset that compounds here. An
 * unreachable source, a missing capability, a resolver kind nobody implemented:
 * all annul with the reason recorded, none of them counts against a forecast.
 *
 * ── THE SQL CAPABILITY IS THE UNPRIVILEGED ROLE, ALWAYS
 *
 * A resolver spec is DATA — a string in a jsonb column written weeks ago — so
 * `ctx.query` runs it as `tmos_analyst` over `DATABASE_ANALYST_URL`, read-only,
 * with a statement timeout. When that connection is absent the capability is
 * OMITTED rather than stubbed, and sql resolvers annul naming it. Falling back
 * to the app connection would route caller-supplied SQL through the role that
 * can write facts, which is the entire boundary the analyst role exists to be.
 *
 * ── HUMANS AND AGENTS ARE SCORED SEPARATELY, ALWAYS
 *
 * `PredictionRecord.author` says so in its own comment: "the human-vs-agent
 * comparison on one question set is the most valuable output this system
 * produces". Pooling them produces one number that describes nobody.
 */
import { pathToFileURL } from 'node:url';

import { closePool } from '@tmos/db';
import { createPostgresPredictionStore, createResolverContext } from '@tmos/adapters';
import {
  decompose,
  meanBrier,
  runDueResolvers,
  type PredictionRecord,
  type PredictionStore,
  type ResolvedForecast,
} from '@tmos/intel';

const write = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const ANALYST_URL_ENV = 'DATABASE_ANALYST_URL';

/** `human:nishant` → `human`, `agent:openai/gpt-oss-120b@x` → `agent`. */
export const authorClass = (author: string): 'human' | 'agent' | 'other' => {
  if (author.startsWith('human:')) return 'human';
  if (author.startsWith('agent:')) return 'agent';
  return 'other';
};

/** Only settled forecasts score. Annulled and open ones are not evidence. */
export function scorable(records: readonly PredictionRecord[]): ResolvedForecast[] {
  return records
    .filter((r) => r.outcome === 0 || r.outcome === 1)
    .map((r) => ({ p: r.p, outcome: r.outcome as 0 | 1 }));
}

const pct = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : '—');

/**
 * The report.
 *
 * Deliberately shows the counts BEFORE the scores. A Brier of 0.11 over four
 * resolved questions is not a track record, and a number printed without its n
 * invites exactly the reading it cannot support.
 */
export function calibrationReport(records: readonly PredictionRecord[]): string[] {
  const lines: string[] = [];
  const open = records.filter((r) => r.outcome === null).length;
  const annulled = records.filter((r) => r.outcome === 'annulled').length;
  const settled = scorable(records);

  lines.push('');
  lines.push('CALIBRATION');
  lines.push(
    `  ${records.length} prediction(s): ${settled.length} settled · ${open} open · ${annulled} annulled`,
  );

  if (settled.length === 0) {
    lines.push('');
    lines.push('  No settled forecasts yet, so there is no score — which is the honest');
    lines.push('  output, not a gap. A track record has to be accumulated in order.');
    return lines;
  }

  const d = decompose(settled);
  lines.push('');
  lines.push(`  Brier ${pct(d.brier)}  (lower is better; 0.25 is answering 50% to everything)`);
  lines.push(`  = reliability ${pct(d.reliability)} − resolution ${pct(d.resolution)} + uncertainty ${pct(d.uncertainty)}`);
  lines.push(`  skill ${pct(d.skill)}  (>0 beats the base rate)`);
  lines.push('');
  // The two failure modes, named, because the second is the one a startup has
  // and mistakes for humility.
  lines.push('  high reliability → overconfident, and fixable by a calibration shift');
  lines.push('  low resolution   → we say ~50% about everything: honest and useless');

  const byAuthor = new Map<string, PredictionRecord[]>();
  for (const r of records) {
    const key = authorClass(r.author);
    byAuthor.set(key, [...(byAuthor.get(key) ?? []), r]);
  }
  if (byAuthor.size > 1) {
    lines.push('');
    lines.push('  scored separately — pooling them produces one number describing nobody:');
    for (const [who, rs] of [...byAuthor].sort()) {
      const s = scorable(rs);
      lines.push(`    ${who.padEnd(6)} n=${String(s.length).padStart(3)}  Brier ${pct(meanBrier(s))}`);
    }
  }

  return lines;
}

export interface ResolveDeps {
  /** Injected so the live suite can drive a real resolution inside a
   *  transaction it then rolls back — proving the path without writing an
   *  outcome to a real prediction weeks before it is due. */
  readonly store?: PredictionStore;
}

export async function resolveDue(
  now: Date = new Date(),
  deps: ResolveDeps = {},
): Promise<PredictionRecord[]> {
  const store = deps.store ?? createPostgresPredictionStore();

  // Absent analyst connection ⇒ the capability is OMITTED, and sql resolvers
  // annul naming it. Never a fallback to the app connection: that would run
  // caller-supplied SQL as the role that can write facts.
  const hasAnalyst = Boolean(process.env[ANALYST_URL_ENV]?.trim());
  if (!hasAnalyst) {
    write(`(${ANALYST_URL_ENV} not set — sql resolvers will annul, naming the missing capability)`);
  }

  const summary = await runDueResolvers(
    store,
    createResolverContext({ query: hasAnalyst ? {} : false, now: () => now }),
    now,
  );

  write('');
  write(
    `resolved ${summary.resolved} · annulled ${summary.annulled} · of ${summary.scanned} due`,
  );
  for (const f of summary.failures) write(`  ✗ ${f.id}: ${f.reason}`);

  return store.all();
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  resolveDue()
    .then((records) => {
      for (const line of calibrationReport(records)) write(line);
    })
    .catch((error: unknown) => {
      process.stderr.write(`resolve failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(closePool);
}
