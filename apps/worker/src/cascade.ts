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
  passesVerification,
  scoreFinding,
  synthesize,
  type SkimItem,
  type SkimPort,
  type SkimInput,
  type SkimVerdict,
  type FindingDraft,
  type SourceTier,
} from '@tmos/reason';
import { createPostgresFindingStore } from '@tmos/adapters';

import { createTransport } from './transport.js';
import { CAC_CEILING_CENTS } from './change-finding.js';
import { loadFactSheet } from './fact-sheet.js';
import { createGroqVerifier, verifyForPublication } from './verifier.js';
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
        // PRINTED BEFORE IT IS THROWN. `skimItems` turns a throw into an
        // abstention reading "skim call failed — needs a look", which is the
        // right behaviour and discards the only copy of WHY. A run of 120
        // signals showed twenty of them abstaining on one failed batch with no
        // way to tell a rate limit from a bad request from an expired key.
        console.log(`[T1] batch of ${batch.length} failed: ${JSON.stringify(res).slice(0, 240)}`);
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



/* ── retrieval: a headline cannot be cited ─────────────────────────────────── */

/**
 * Fetch the article a promoted signal points at.
 *
 * Without this the pipeline cannot produce a Finding at all, and the reason is
 * structural rather than a tuning problem: L0 requires every number and date in
 * a claim to appear VERBATIM in a cited span, so a Finding needs text to quote.
 * 36 of 46 Hacker News gig-economy signals have an empty body — a link post
 * carries no story text — so the writer was being handed a headline and asked to
 * quote from nothing, and correctly declined every time.
 *
 * This is the retrieval half of T3's workers, which the design puts here and
 * nowhere else: `retrievedUrls` is the set L0 validates citations against, so a
 * URL enters it ONLY if the fetch actually returned. A URL that failed, or that
 * robots.txt refused, must never be citable — that is the difference between "we
 * read this" and "we linked to it".
 */
function flatten(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

async function retrieve(
  transport: ReturnType<typeof createTransport>,
  url: string,
): Promise<string | null> {
  try {
    const res = await transport.fetchText(url, { Accept: 'text/html,text/plain' });
    if (res.status < 200 || res.status >= 300) return null;
    const text = flatten(res.body);
    // Under a few hundred characters this is a cookie wall or a redirect stub,
    // not an article, and quoting it would cite a consent banner as evidence.
    return text.length >= 400 ? text : null;
  } catch {
    return null;
  }
}

/* ── T3 / synthesis: turn a promoted signal into a Finding ─────────────────── */

interface WriterDraft {
  claim: string;
  so_what: string;
  subject: string;
  span: string;
}

/**
 * The writer prompt.
 *
 * Three constraints are not style, they are the gates the mint will apply, and
 * asking for them up front is cheaper than being refused:
 *
 *  - L0 checks every number and date in the claim appears VERBATIM in the cited
 *    span. So the span must be quoted exactly, and the claim may not contain a
 *    figure the span does not.
 *  - The causal lint refuses "caused" below rung 2. A news item is rung 0.
 *  - The honesty denylist is a legal boundary, not a tone preference.
 */
const WRITER_PROMPT = [
  'You write short competitive-intelligence notes for Taskly, a home-services task marketplace in the Greater Toronto Area.',
  '',
  'You are given ONE news item. Write a note about it, or refuse it.',
  '',
  'RULES, all of which are checked mechanically after you answer:',
  '1. "span" MUST be copied character-for-character from the item text. Do not paraphrase, tidy or shorten inside the quote.',
  '2. Any number or date in "claim" MUST also appear in "span". If the span has no figures, the claim must have none.',
  '3. Never write that something CAUSED something else. Say observed, associated with, or consistent with.',
  '4. Never describe anyone as vetted, handpicked, background-checked, insured or guaranteed, and never promise anything.',
  '5. "so_what" is what Taskly would DO about it, in one sentence. Not a summary of the news.',
  '6. "subject" is the company or body the note is about, as "company:name" or "regulator:name".',
  '',
  'If the item does not support a note worth a founder reading, return {"skip":true} and nothing else.',
  'Otherwise return {"claim":"...","so_what":"...","subject":"...","span":"..."}',
].join('\n');

async function writeDraft(
  apiKey: string,
  limits: BudgetLimits,
  item: { title: string | null; body: string; url: string | null },
): Promise<WriterDraft | null> {
  const state = createBudgetState();
  const res = await callGroq(
    {
      model: MODELS.strong,
      json: true,
      reasoningEffort: 'low',
      maxTokens: 4_000,
      messages: [
        { role: 'system', content: WRITER_PROMPT },
        { role: 'user', content: `TITLE: ${item.title ?? '(untitled)'}\n\nTEXT:\n${item.body.slice(0, 3_000)}` },
      ],
    },
    { apiKey, state, limits, runId: RUN },
  );

  if (!res.ok) return null;
  await logUsage({
    outcome: 'allowed',
    reason: 'synthesis',
    tokensIn: res.usage.promptTokens,
    tokensOut: res.usage.completionTokens,
    cents: res.usage.costCents,
  });

  const parsed = JSON.parse(res.text) as Partial<WriterDraft> & { skip?: boolean };
  if (parsed.skip || !parsed.claim || !parsed.so_what || !parsed.span || !parsed.subject) return null;
  return { claim: parsed.claim, so_what: parsed.so_what, subject: parsed.subject, span: parsed.span };
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
    observed_at: string | null; tier: string | null;
  }>(sql`
    select g.id::text as id,
           g.content_hash,
           g.payload->>'title' as title,
           coalesce(g.payload->>'body', '') as body,
           coalesce(g.canonical_url, g.url) as url,
           g.observed_at::text as observed_at,
           -- What the claim will REST on. The domain scorer weights source tier
           -- at 0.40, the largest single term, and reading it off the signal's
           -- own source is the difference between scoring the claim and scoring
           -- a guess about where it came from.
           s.tier
      from signal g
      join source s on s.id = g.source_id
     order by g.created_at desc
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

  /* ── synthesis: the promoted signals become Findings, or are refused ────── */

  const store = createPostgresFindingStore();
  const drafts: FindingDraft[] = [];
  const retrievedUrls: string[] = [];
  let skippedByWriter = 0;

  const transport = createTransport();
  let notRetrieved = 0;

  for (const v of promoted) {
    const r = byId.get(v.id);
    if (!r?.url) continue;

    // Retrieve BEFORE writing. The body we stored is feed metadata; a Finding
    // must quote the article itself.
    const article = await retrieve(transport, r.url);
    if (!article) {
      notRetrieved += 1;
      continue;
    }

    const d = await writeDraft(env.GROQ_API_KEY ?? '', limits, { ...r, body: article });
    if (!d) {
      skippedByWriter += 1;
      continue;
    }

    /**
     * The DOMAIN SCORER, not T1's materiality.
     *
     * `scoring/domain.ts` encodes the priors that make a ranking about this
     * business — source tier at 0.40, the GTA corridor at 0.35 — and shows its
     * work, which is the point: a number a reader cannot argue with is one they
     * will eventually ignore. Triage materiality stood in here until now, and a
     * relevance PROXY read by every surface as a relevance MEASUREMENT is the
     * quiet kind of wrong.
     */
    const scored = scoreFinding(
      {
        claim: d.claim,
        so_what: d.so_what,
        source_tiers: [(r.tier ?? 'aggregator') as SourceTier],
        channel: null,
      },
      { cacCeilingCents: CAC_CEILING_CENTS },
    );

    retrievedUrls.push(r.url);
    drafts.push({
      id: randomUUID(),
      claim: d.claim,
      so_what: d.so_what,
      subject_refs: [d.subject],
      evidence: [{ url: r.url, span: d.span, observed_at: r.observed_at ?? new Date().toISOString(), signal_id: r.id }],
      // A single news item, read once. Not a governed query over our own facts,
      // and emphatically not a verified metric.
      basis: 'inferred_from_sources',
      // Rung 0: this is an observation. Nothing here establishes a cause.
      causal_rung: 0,
      stakes: v.materiality >= 0.6 ? 'high' : 'medium',
      region: 'ca',
      domain_score: scored.domain_score,
    });
  }

  console.log(`\n[T3] retrieved ${promoted.length - notRetrieved}/${promoted.length} articles ` +
              `(${notRetrieved} unreadable or refused), drafts written: ${drafts.length} ` +
              `(writer declined ${skippedByWriter})`);
  for (const denial of transport.drainDenials()) console.log(`      policy: ${denial}`);

  if (drafts.length > 0) {
    const result = synthesize(
      { drafts, retrievedUrls, surface: 'internal' },
      { honesty: assertHonest, now: () => new Date(), generatedBy: `agent:${MODELS.strong}@2026-08-22` },
    );

    console.log(`[T3] minted: ${result.emitted.length}   refused by the gates: ${result.refused.length}`);
    for (const r of result.refused) {
      console.log(`      ✗ ${r.reasons.map((x) => `${x.code}: ${x.detail}`).join('; ')}`);
    }

    /**
     * VERIFIED BEFORE STORED, on this path too.
     *
     * The synthesis gates check that a claim is well-formed and sourced. They
     * do not ask a second model whether it is TRUE given the span, which is the
     * different question a news item most needs asked: the writer chose both
     * the claim and the quotation, from one article, in one pass.
     */
    const facts = loadFactSheet();
    const verifier = createGroqVerifier({
      apiKey: env.GROQ_API_KEY ?? '',
      limits,
      runId: RUN,
      onUsage: async (u) => {
        await logUsage({
          outcome: u.outcome,
          reason: u.reason,
          tokensIn: u.promptTokens,
          tokensOut: u.completionTokens,
          cents: u.costCents,
        });
      },
    });

    const published: typeof result.emitted = [];
    let withheld = 0;
    for (const f of result.emitted) {
      const check = await verifyForPublication(
        { claim: f.claim, evidence: f.evidence, generated_by: f.generated_by },
        { verifier, retrievedUrls, facts },
      );
      if (!passesVerification(check)) {
        withheld += 1;
        console.log(`      ✗ ${check.verdict} at ${check.stage}: ${check.reason.slice(0, 150)}`);
        continue;
      }
      published.push(f);
    }
    console.log(`[T3] verified: ${published.length} survive, ${withheld} withheld by ${MODELS.verifier}`);

    let stored = 0;
    let duplicate = 0;
    for (const f of published) {
      const put = await store.put(f);
      if (put.ok && put.stored) stored += 1;
      else if (put.ok) duplicate += 1;
      else console.log(`      ✗ store refused: ${put.reason} ${put.detail}`);
    }
    console.log(`[T3] STORED: ${stored}   already held: ${duplicate}`);

    for (const f of published) {
      console.log(`\n  ── ${f.claim}`);
      console.log(`     so what: ${f.so_what}`);
      console.log(`     subject: ${f.subject_refs.join(', ')} · basis ${f.basis} · rung ${f.causal_rung} · ${f.stakes}`);
      console.log(`     evidence: "${f.evidence[0]?.span.slice(0, 120)}"`);
      console.log(`     source: ${f.evidence[0]?.source_url}`);
    }
  }

  const total = await db().query<{ n: number }>(sql`select count(*)::int as n from finding`);
  console.log(`\nfinding table now holds ${total[0]?.n ?? 0} rows`);

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
