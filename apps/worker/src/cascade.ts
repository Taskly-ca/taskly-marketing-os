/**
 * T1 skim over real signals — the first tier, against the real database.
 *
 * Every Part gate since August has carried the same admission: "No Finding has
 * been produced from a REAL signal. Every tier and judge runs against fixtures
 * and fake ports." This is the consumer for the 236 signals the ingest pass
 * wrote, and the first time `skimItems` has met an actual model.
 *
 * THE SYSTEM PROMPT IS GATED. AGENTS.md rule 5 says the honesty denylist applies
 * to prompts too, "since a banned word in a prompt generates itself into
 * output" — and that is not hypothetical: the prompt this one is derived from
 * described Taskers as "vetted", a term the business is not permitted to claim.
 * `assertHonest` runs over the prompt at startup, so a banned word is a crash on
 * boot rather than a claim on a page.
 */
import { randomUUID } from 'node:crypto';

import { MODELS, callGroq, createBudgetState, loadEnv, type BudgetLimits } from '@tmos/shared';
import { assertHonest } from '@tmos/guardrails';
import {
  skimItems,
  createMemorySkimCache,
  type SkimItem,
  type SkimPort,
  type SkimInput,
  type SkimVerdict,
} from '@tmos/reason';
import { db, sql, closePool } from '@tmos/db';

const RUN = randomUUID();

/**
 * How old each signal is, in words the model can act on.
 *
 * T1's first real run scored a 2012 Home Depot acquisition at 0.60 and a 2015
 * Google hire at 0.50 — correctly, for topical relevance, and uselessly, because
 * nothing in the prompt said how old they were. A feed that answers a QUERY
 * rather than serving a window returns its whole history, so 55 of 236 signals
 * predate 2026. Without the age, triage cannot tell a competitor's move this
 * month from the one that created the market a decade ago.
 */
const ageByItemId = new Map<string, string>();

function describeAge(observedAt: string | null, now: Date): string {
  if (!observedAt) return 'age unknown';
  const days = Math.floor((now.getTime() - new Date(observedAt).getTime()) / 86_400_000);
  if (!Number.isFinite(days)) return 'age unknown';
  if (days < 0) return 'dated in the future';
  if (days <= 1) return 'today';
  if (days < 14) return `${days}d old`;
  if (days < 365) return `${Math.floor(days / 30)}mo old`;
  return `${Math.floor(days / 365)}y old`;
}

const SYSTEM_PROMPT = [
  'You triage market signals for Taskly: a home-services task marketplace in the Greater Toronto Area.',
  'Customers post a task, Taskers make offers, and the money is held until the customer confirms the work is done.',
  '',
  'Score MATERIALITY 0..1 = "would this change what Taskly does in the next 90 days?"',
  'NOT "is this interesting". Be harsh. Most news is 0.0-0.2 and you should say so.',
  '',
  'Each line begins with how old the item is. AGE IS DECISIVE: a competitor move',
  'from years ago already shaped the market we are in — it is history, not news,',
  'and it cannot change what we do in the next 90 days. Score anything over a year',
  'old at most 0.1 however important it once was, and say so in the reason.',
  '  0.8-1.0 a direct competitor changed price, coverage or model in the GTA, or a regulation lands on gig labour in Ontario',
  '  0.4-0.7 adjacent market shift, supply-side labour change in Ontario, a competitor raised money',
  '  0.0-0.3 general business news, other geographies, listicles, SEO filler',
  '',
  'Return JSON only: {"items":[{"i":<index>,"materiality":<0..1>,"reason":"<12 words: why that score>"}]}',
].join('\n');

/** The canary: prove the gate is live before trusting it, then prove the prompt passes. */
function assertPromptIsClean(): void {
  let threw = false;
  try {
    assertHonest('every Tasker is vetted and background-checked', 'skim_prompt_canary');
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('honesty gate is a no-op — refusing to send any prompt');
  assertHonest(SYSTEM_PROMPT, 'skim_system_prompt');
}

function makeSkimPort(apiKey: string, limits: BudgetLimits): SkimPort & { spentCents: number; calls: number } {
  const state = createBudgetState();
  const port = {
    spentCents: 0,
    calls: 0,
    async skim(batch: readonly SkimInput[]): Promise<readonly SkimVerdict[]> {
      const listing = batch
        .map((s, i) => {
          const age = ageByItemId.get(s.id);
          return `${i}. [${age ?? 'age unknown'}] ${s.title ?? '(untitled)'} — ${s.body.slice(0, 400)}`;
        })
        .join('\n');

      const res = await callGroq(
        {
          model: MODELS.small,
          json: true,
          // Reasoning tokens come out of this ceiling; triage does not need them.
          reasoningEffort: 'low',
          maxTokens: 6_000,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: listing },
          ],
        },
        { apiKey, state, limits, runId: RUN },
      );

      port.calls += 1;

      if (!res.ok) {
        await logUsage({ outcome: res.reason === 'blocked' ? res.outcome : 'allowed', reason: res.reason, tokensIn: 0, tokensOut: 0, cents: 0 });
        // A tier that cannot score returns nothing rather than guessing zero:
        // a fabricated 0 is indistinguishable from "we looked and it was dull".
        throw new Error(`skim failed: ${JSON.stringify(res).slice(0, 200)}`);
      }

      port.spentCents += res.usage.costCents;
      await logUsage({
        outcome: 'allowed',
        reason: null,
        tokensIn: res.usage.promptTokens,
        tokensOut: res.usage.completionTokens,
        cents: res.usage.costCents,
      });

      const parsed = JSON.parse(res.text) as {
        items?: Array<{ i?: number; materiality?: number; reason?: string }>;
      };
      return (parsed.items ?? [])
        .filter((r): r is { i: number; materiality: number; reason?: string } =>
          typeof r.i === 'number' && typeof r.materiality === 'number' && !!batch[r.i])
        .map((r) => ({
          id: batch[r.i]!.id,
          materiality: Math.max(0, Math.min(1, r.materiality)),
          reason: r.reason ?? '',
        }));
    },
  };
  return port;
}

/**
 * Write the spend row. Migration 012 created this table so the daily ceiling
 * survives a restart, and `composition.ts` already reconstructs the day's spend
 * from it — but until now NOTHING inserted, so it reconstructed to zero forever
 * and the ceiling was still per-process. Blocked attempts are recorded too: a
 * run of `blocked_daily_cost` is the ceiling working, and it is the row you want
 * when asking why the system went quiet.
 */
async function logUsage(u: {
  outcome: string;
  reason: string | null;
  tokensIn: number;
  tokensOut: number;
  cents: number;
}): Promise<void> {
  await db().execute(sql`
    insert into ai_usage_log (run_id, provider, model, tokens_in, tokens_out, cost_cents, outcome, reason)
    values (${RUN}, 'groq', ${MODELS.small}, ${u.tokensIn}, ${u.tokensOut},
            ${u.cents}, ${u.outcome}, ${u.reason})`);
}

async function main(): Promise<void> {
  assertPromptIsClean();
  console.log('honesty gate: live, and the system prompt passes it\n');

  const env = loadEnv();
  const limits: BudgetLimits = {
    maxRunTokens: env.TMOS_MAX_RUN_TOKENS,
    maxDailyCostCents: env.TMOS_MAX_DAILY_COST_CENTS,
    maxToolDepth: env.TMOS_MAX_TOOL_DEPTH,
  };

  const rows = await db().query<{
    id: string; content_hash: string; title: string | null; body: string; url: string | null;
    observed_at: string | null;
  }>(sql`
    select id::text as id,
           content_hash,
           payload->>'title' as title,
           coalesce(payload->>'body', '') as body,
           coalesce(canonical_url, url) as url,
           observed_at::text as observed_at
      from signal
     order by created_at desc
     limit 120`);

  const now = new Date();
  for (const r of rows) ageByItemId.set(r.id, describeAge(r.observed_at, now));
  const stale = rows.filter((r) => (ageByItemId.get(r.id) ?? '').endsWith('y old')).length;
  console.log(`read ${rows.length} signals from the database (${stale} over a year old)\n`);

  const items: SkimItem[] = rows.map((r) => ({
    id: r.id, contentHash: r.content_hash, title: r.title, body: r.body,
  }));

  const port = makeSkimPort(env.GROQ_API_KEY ?? '', limits);
  const started = Date.now();
  const result = await skimItems(items, { port, cache: createMemorySkimCache() });
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  const verdicts = [...result.results].sort((a, b) => b.materiality - a.materiality);
  const dist = [0, 0, 0, 0, 0];
  for (const v of verdicts) dist[Math.min(4, Math.floor(v.materiality * 5))]! += 1;

  const promoted = verdicts.filter((v) => v.proceed);
  const abstained = verdicts.filter((v) => v.abstained);

  console.log(`[T1] ${MODELS.small}: ${verdicts.length} scored in ${result.portCalls} calls, ` +
              `${port.spentCents.toFixed(4)}¢, ${elapsed}s`);
  console.log(`[T1] materiality: 0-.2:${dist[0]} .2-.4:${dist[1]} .4-.6:${dist[2]} ` +
              `.6-.8:${dist[3]} .8-1:${dist[4]}`);
  console.log(`[T1] promoted past the gate: ${promoted.length}`);
  // An abstention ALWAYS proceeds — `uncertain` never silently passes as a low
  // score, because a timeout read as "dull" is a pipeline that looks healthy
  // while going blind.
  console.log(`[T1] abstained (proceed anyway): ${abstained.length}`);
  if (result.unknownIds.length) {
    console.log(`[T1] verdicts for ids we never sent: ${result.unknownIds.length} — reported, not guessed at`);
  }
  console.log('');

  const byId = new Map(rows.map((r) => [r.id, r]));
  console.log('TOP 10 BY MATERIALITY');
  for (const v of verdicts.slice(0, 10)) {
    const r = byId.get(v.id);
    console.log(`  ${v.materiality.toFixed(2)}  ${(r?.title ?? '').slice(0, 88)}`);
    console.log(`        ${v.reason}`);
  }

  const spend = await db().query<{ n: number; cents: string | null }>(sql`
    select count(*)::int as n, coalesce(sum(cost_cents), 0)::text as cents
      from ai_usage_log where utc_day = current_date`);
  console.log(`\nai_usage_log today: ${spend[0]?.n ?? 0} rows, ` +
              `${Number(spend[0]?.cents ?? 0).toFixed(4)}¢ — reconstructed from the ledger, ` +
              `so the daily ceiling now survives a restart`);

  await closePool();
}

main().catch(async (err) => {
  console.error('cascade failed:', err);
  await closePool();
  process.exit(1);
});
