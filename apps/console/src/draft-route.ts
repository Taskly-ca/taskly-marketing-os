/**
 * The draft endpoint — the join, wired to the real tables.
 *
 * `packages/draft` is deliberately keyless and database-free; this is where it
 * meets Postgres, the Brain index and Groq. The only decisions here are which
 * slice of each source to hand over, and every one of them is a judgement about
 * evidence quality rather than about prompt size:
 *
 *  - **Findings**: all of them, but only the live ones. A superseded Finding is
 *    something we withdrew, and feeding a retracted claim back in as evidence
 *    would let a mistake we already caught drive a recommendation.
 *  - **Facts**: current on BOTH bitemporal axes. `upper_inf(asserted)` alone
 *    means "never retracted", which is not "true now" — the world changing
 *    closes `valid`. Reading one axis fed six superseded versions of Handy's
 *    city list into the evidence file as if all seven were current.
 *  - **Brain**: retrieved against the season and the competitors actually in
 *    play, not "marketing" — a generic query returns the brand guide every
 *    time and never the roadmap page that matters this month.
 */
import type { ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import { db, sql } from '@tmos/db';
import { loadEnv, createGeminiEmbedder, type BudgetLimits } from '@tmos/shared';
import { createAsk } from '@tmos/adapters';
import { createPostgresBrainIndex } from '@tmos/adapters';
import { retrieve, citationFor } from '@tmos/brain';
import { activeSeasons, composeDraft, type DraftInputs } from '@tmos/draft';
import { packById, DEFAULT_PACK_ID } from '@tmos/packs';

import { send } from './sse.js';

/**
 * What to ask the Brain.
 *
 * Built from what is actually in play right now — the open seasons and the
 * companies we hold facts about — rather than a fixed string. A constant query
 * retrieves a constant answer, which would make the Brain a decoration on every
 * draft rather than an input to it.
 */
export function brainQueries(seasons: readonly string[], companies: readonly string[]): string[] {
  const qs = [
    'Taskly positioning and what makes it different',
    'current priorities and roadmap',
    'pricing, commission and fees',
  ];
  for (const s of seasons.slice(0, 2)) qs.push(`${s} — our categories, supply and past campaigns`);
  if (companies.length > 0) qs.push(`how we compare to ${companies.slice(0, 4).join(', ')}`);
  return qs;
}

export async function runDraft(res: ServerResponse): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const env = loadEnv();
  // `packById` returns undefined for an unknown id; the default id is a
  // constant from the same module, so this is a build-time impossibility that
  // the type system cannot see. Failing loudly beats a draft with no calendar.
  const pack = packById(DEFAULT_PACK_ID);
  if (!pack) {
    send(res, 'error_msg', `pack "${DEFAULT_PACK_ID}" is not registered`);
    res.end();
    return;
  }
  const now = new Date();

  try {
    send(res, 'step', 'reading the world model…');
    const findings = await db().query<{ claim: string; soWhat: string; url: string | null; created: string }>(sql`
      select f.claim, f.so_what as "soWhat", f.evidence->0->>'source_url' as url,
             to_char(f.created_at,'YYYY-MM-DD') as created
        from finding f
       where f.supersede_reason is null
       order by f.created_at desc limit 12`);

    /**
     * ONLY THIS PACK'S SUBJECTS.
     *
     * The world model holds every pack's entities in one table, so an
     * unfiltered read hands a MARKETING strategist the `platform` pack's facts
     * about Supabase, Stripe and Resend. It did exactly that on the first live
     * run and produced "migrate backend infrastructure to Supabase's free
     * tier" — coherent, well-cited, correctly marked as resting on observed
     * evidence, and not a marketing recommendation at all. Worse, it was ABOUT
     * a service the company already runs on, which no amount of gate could
     * catch: the claim was true and the evidence was real. Only the scope was
     * wrong.
     *
     * The pack already declares who it is about. That declaration is the
     * filter, which is also what keeps a second pack's draft meaningful rather
     * than a copy of this one's.
     */
    const subjects = pack.targets.map((t) => t.company);
    const facts = await db().query<{ company: string; predicate: string; value: string; url: string | null; since: string }>(sql`
      select e.name as company, f.predicate,
             coalesce(f.object_text, f.object_num::text) as value,
             f.evidence->>'url' as url, to_char(lower(f.valid),'YYYY-MM-DD') as since
        from fact f join entity e on e.id = f.entity_id
     -- BITEMPORAL, BOTH AXES. "upper_inf(asserted)" alone means "we never
     -- retracted this", which is NOT "this is true now": the world changing
     -- closes "valid", and a closed "valid" is a PAST state we deliberately
     -- kept. Reading only the asserted axis showed Handy in seven contradictory
     -- city lists at once and called all of them current — 43 rows where the
     -- world model holds 29. AGENTS.md rule 3 names this exact conflation as
     -- the single most damaging error available here.
       where upper_inf(f.asserted) and upper_inf(f.valid) and f.status = 'active'
         and e.name = any(${subjects})
       order by lower(f.valid) desc limit 40`);

    const forecasts = await db().query<{ claim: string; p: string; resolves: string }>(sql`
      select claim, p::text as p, to_char(resolve_at,'YYYY-MM-DD') as resolves
        from prediction where outcome is null order by resolve_at limit 10`);

    send(res, 'step', `${findings.length} finding(s), ${facts.length} fact(s), ${forecasts.length} forecast(s)`);

    const seasons = activeSeasons(pack.calendar, now);
    for (const s of seasons) send(res, 'step', `season: ${s.window.name} (${s.phase})`);

    /* ── the Brain ────────────────────────────────────────────────────────── */
    const brain: { text: string; citation: string }[] = [];
    const geminiKey = env.GEMINI_API_KEY;
    if (geminiKey) {
      const embedder = createGeminiEmbedder({ apiKey: geminiKey });
      const index = createPostgresBrainIndex();
      const companies = [...new Set(facts.map((f) => f.company))];
      const queries = brainQueries(seasons.map((s) => s.window.name), companies);
      for (const q of queries) {
        try {
          const [vector] = await embedder.embed([q]);
          if (!vector) continue;
          const result = await retrieve(index, { vector, limit: 3 }, now);
          for (const hit of result.hits) {
            brain.push({ text: hit.chunk.text, citation: citationFor(hit) });
          }
        } catch {
          // A Brain miss degrades the draft; it does not fail it. The world
          // model is the evidence that matters, and it is already in hand.
          send(res, 'step', `  brain lookup failed for "${q.slice(0, 40)}"`);
        }
      }
      send(res, 'step', `${brain.length} Brain passage(s) retrieved`);
    } else {
      send(res, 'step', 'no GEMINI_API_KEY — drafting without the Brain');
    }

    /* ── compose ──────────────────────────────────────────────────────────── */
    const runId = randomUUID();
    const limits: BudgetLimits = {
      maxRunTokens: env.TMOS_MAX_RUN_TOKENS,
      maxDailyCostCents: env.TMOS_MAX_DAILY_COST_CENTS,
      maxToolDepth: env.TMOS_MAX_TOOL_DEPTH,
    };
    send(res, 'step', 'reasoning over the evidence file…');

    const inputs: DraftInputs = { findings, facts, forecasts, brain, calendar: pack.calendar, subject: pack.subject };
    const draft = await composeDraft(
      inputs,
      createAsk({
        apiKey: env.GROQ_API_KEY ?? '',
        limits,
        runId,
        onUsage: async (usage, model) => {
          await db().execute(sql`
            insert into ai_usage_log (run_id, provider, model, tokens_in, tokens_out, cost_cents, outcome, reason)
            values (${runId}, 'groq', ${model}, ${usage.promptTokens}, ${usage.completionTokens},
                    ${usage.costCents}, 'allowed', 'draft')`);
        },
      }),
      now,
    );

    send(res, 'step', `${draft.recommendations.length} kept, ${draft.dropped.length} dropped`);
    send(res, 'draft', draft);
  } catch (err) {
    send(res, 'error_msg', err instanceof Error ? err.message : String(err));
  }
  res.end();
}
