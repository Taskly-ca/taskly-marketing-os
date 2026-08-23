/**
 * COMPETITOR WATCH — the part of TMOS that compounds.
 *
 * News turned out to be a bad source for this business, and the run that proved
 * it is worth recording: Hacker News link posts carry no text so nothing can be
 * cited, Reuters disallows us outright, and a query-shaped feed returns a decade
 * of history that triage scores as if it were current. Three separate reasons,
 * one conclusion — free news cannot answer "what are our competitors doing".
 *
 * Their own pages can. A pricing page, a services page and a city list are
 * first-party statements by the company about itself, published deliberately,
 * and reading them is what the bitemporal world model was built for: not "what
 * does this page say" but "what did it say in June, and when did that change".
 *
 * SO THE FIRST RUN PRODUCES NO FINDINGS, AND THAT IS CORRECT. A change detector
 * needs a before and an after. Run one writes the baseline; from run two onward
 * every difference is a Finding with the old value, the new value, the date we
 * observed each, and the page it came from. That is intelligence that improves
 * by being left running, which is the entire thesis of the architecture:
 * "the durable asset is a world model with history".
 *
 * Every page here was checked against its own robots.txt before being added.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { MODELS, callGroq, createBudgetState, loadEnv, type BudgetLimits } from '@tmos/shared';
import {
  createPostgresEntityHistory,
  createPostgresFactStore,
  createPostgresFindingStore,
  createPostgresPredicateStore,
  entityByHardKey,
  insertEntity,
  attachHardKey,
} from '@tmos/adapters';
import { passesVerification } from '@tmos/reason';
import { recordChange, type FactInput } from '@tmos/world';
import { db, sql, closePool } from '@tmos/db';

import { createTransport } from './transport.js';
import {
  findingFromChange,
  type ChangeOutcome,
  type ClaimWriter,
} from './change-finding.js';
import {
  COMMON,
  SITEMAP_CATALOGUE,
  SITEMAP_COUNT,
  acceptAnswer,
  publishes,
  type Measure,
} from './measures.js';
import { quoteSlugs, readSitemap, type SitemapReading } from './sitemap.js';
import { catalogueClaim } from './catalogue-finding.js';
import { loadFactSheet } from './fact-sheet.js';
import { createGroqVerifier, verifyForPublication } from './verifier.js';

const RUN = randomUUID();

interface WatchTarget {
  /** Display name, and the entity we resolve against. */
  readonly company: string;
  /** The registrable domain — migration 001's hard identity key, so an exact
   *  match auto-merges with no scoring at all. */
  readonly domain: string;
  readonly url: string;
  /** What this page is being read FOR. Goes in the prompt. */
  readonly reading_for: string;
  /**
   * The measures to answer, FIXED — see `measures.ts`, which also owns the rule
   * that only a bounded or quoted answer may be published as a change.
   *
   * The first version of this asked the model to record "what the page states"
   * and let it choose the measures. Run one returned one predicate for Handy and
   * run two returned four different ones, on an unchanged page. A change
   * detector whose measures drift cannot detect change: every run mints new
   * facts, nothing is ever comparable, and a real move would be indistinguishable
   * from the extractor having a different idea that morning. The question set is
   * the instrument, and an instrument that re-calibrates itself measures nothing.
   */
  readonly measures: readonly Measure[];
  /**
   * A sitemap worth reading, when the company publishes one that enumerates
   * what it sells. Optional because most do not: TaskRabbit's lists marketing
   * pages, and counting those would measure their content strategy.
   */
  readonly sitemap?: { readonly url: string; readonly prefix: string };
}

/** One value read off one document, from either half of a pass. */
interface Reading {
  readonly measure: Measure;
  readonly value: string;
  readonly span: string;
  /**
   * Present when this measure's change needs DESCRIBING rather than rendering.
   * The catalogue is the case: "…is now 51" cannot be cited by any span, and
   * "now lists junk-removal" can be cited by the line junk-removal came from.
   */
  readonly writeClaim?: ClaimWriter;
}

const TARGETS: readonly WatchTarget[] = [
  {
    company: 'TaskRabbit',
    domain: 'taskrabbit.ca',
    url: 'https://www.taskrabbit.ca/services',
    reading_for: 'Which services they offer in Canada, and in which cities.',
    measures: COMMON,
  },
  {
    company: 'Jiffy',
    domain: 'jiffyondemand.com',
    url: 'https://jiffyondemand.com/',
    reading_for: 'Which services they offer, how they price, and which cities they name.',
    measures: COMMON,
    /**
     * The homepage flattens to 29 characters — it is assembled in the browser —
     * so Jiffy contributed nothing at all until this. Their sitemap lists every
     * service they sell as a URL, is server-rendered, and `robots.txt` allows
     * everything except `/admin` and `/jobs/new`. Verified 2026-08-23.
     */
    sitemap: {
      url: 'https://jiffyondemand.com/sitemap.xml',
      prefix: 'https://jiffyondemand.com/service/',
    },
  },
  {
    company: 'Handy',
    domain: 'handy.com',
    url: 'https://www.handy.com/',
    reading_for: 'Whether they serve Canada at all, what they offer, and how they price.',
    measures: COMMON,
  },
];

const EXTRACT_PROMPT = [
  'You read a competitor web page and ANSWER A FIXED SET OF QUESTIONS about it.',
  'The same questions are asked of the same page every week, and the answers are compared.',
  '',
  'Return JSON: {"answers":[{"predicate":"<the exact key given>","value":...,"span":"..."}]}',
  '',
  'RULES:',
  '1. Answer ONLY the predicates you are given. Do not invent, rename, merge or add any.',
  '2. If the page does not state an answer, OMIT that predicate entirely. Never guess, never',
  '   estimate, and never carry an answer over from what you know about the company.',
  '3. "span" MUST be copied character-for-character from the page. It is the evidence for',
  '   that answer, and a value whose span does not contain it will be thrown away.',
  '4. Answer the question as asked — exactly "yes"/"no"/"unstated" where that is requested,',
  '   a bare number where a count is requested.',
  '5. Be consistent: the same page next week must produce the same answer.',
].join('\n');

interface Answer {
  predicate: string;
  value: number | string;
  span: string;
}

function flatten(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The entity, by its hard key. Migration 001: an exact domain match auto-merges. */
async function ensureEntity(company: string, domain: string): Promise<string> {
  const existing = await entityByHardKey({ kind: 'domain', valueNorm: domain });
  if (existing) return existing.entityId;

  const created = await insertEntity({
    entityType: 'company',
    name: company,
    nameNorm: company.toLowerCase(),
    region: 'ca',
  });
  await attachHardKey({ entityId: created.entityId, key: { kind: 'domain', valueNorm: domain } });
  return created.entityId;
}

/** `fact.predicate` is a FK to `predicate_def`, so a predicate must exist first.
 *  They arrive as `proposed`; 007's promotion rule moves them to `active` once
 *  they recur across enough distinct sources. Predicates are data, not DDL. */
async function ensurePredicate(p: Measure): Promise<void> {
  const store = createPostgresPredicateStore();
  const existing = await store.get(p.predicate);
  if (existing) return;
  await store.upsert({
    predicate: p.predicate,
    entityType: 'company',
    datatype: p.datatype,
    unit: p.unit,
    cardinality: 'one',
    status: 'proposed',
    description: `Observed on a competitor page: ${p.predicate}`,
    aliases: [],
    supersededBy: null,
    occurrences: 0,
    subjective: false,
    distinctSources: [],
  });
}

/** The `source` row this watcher writes under. */
async function ensureSource(): Promise<string> {
  const found = await db().query<{ id: string }>(
    sql`select id::text as id from source where kind = 'watch' and name = 'competitor-pages' limit 1`,
  );
  if (found[0]) return found[0].id;
  const made = await db().query<{ id: string }>(sql`
    insert into source (kind, name, tier, region)
    values ('watch', 'competitor-pages', 'first_party', 'ca')
    returning id::text as id`);
  return made[0]!.id;
}

/* ── the two halves of a pass ─────────────────────────────────────────────── */

/**
 * The catalogue's claim writer, bound to the reading it will cite from.
 *
 * The span is built from THIS run's `<loc>` lines for exactly the slugs the
 * claim names. A removed service has no line in this run — it is gone from the
 * document, which is the point — so it cannot be cited from here and
 * `quoteSlugs` drops it. That is the honest limit of a one-document citation:
 * we can prove what a sitemap says, never what it stopped saying, and closing
 * that needs the prior fact's own evidence ref. Flagged rather than papered
 * over — the claim still names the removal, and L0 will refuse it if the
 * removal's slug carries a figure the span lacks.
 */
function catalogueWriter(company: string, reading: SitemapReading): ClaimWriter {
  return (prior, next) => {
    if (prior.kind !== 'text' || next.kind !== 'text') return null;
    const written = catalogueClaim(company, prior.text, next.text);
    if (written === null) return null;

    const span = quoteSlugs(reading.urls, written.cited);
    if (span === '') return null;

    return {
      claim: written.claim,
      so_what: written.so_what,
      evidence: [
        {
          signal_id: null,
          fact_id: null,
          source_url: reading.sourceUrl,
          span: span.slice(0, 1_000),
          observed_at: reading.observedAt,
        },
      ],
    };
  };
}

/** The sitemap, or null when it cannot be read. Never throws a run down. */
async function readSitemapFor(
  transport: ReturnType<typeof createTransport>,
  sitemap: { url: string; prefix: string },
  observedAt: string,
): Promise<SitemapReading | null> {
  try {
    const res = await transport.fetchText(sitemap.url, { Accept: 'application/xml,text/xml' });
    if (res.status < 200 || res.status >= 300) return null;
    const reading = readSitemap(res.body, sitemap.prefix, { sourceUrl: sitemap.url, observedAt });
    // Zero services is a parse that found nothing, not a company that sells
    // nothing, and recording it would open a fact whose next reading looks like
    // a company inventing an entire catalogue overnight.
    return reading.count === 0 ? null : reading;
  } catch {
    return null;
  }
}

/** The page as flat text, or null when there is too little of it to read. */
async function readPage(
  transport: ReturnType<typeof createTransport>,
  url: string,
): Promise<string | null> {
  try {
    const res = await transport.fetchText(url, { Accept: 'text/html' });
    if (res.status < 200 || res.status >= 300) return null;
    const text = flatten(res.body);
    return text.length >= 400 ? text : null;
  } catch {
    return null;
  }
}

interface Extraction {
  readonly readings: Reading[];
  readonly discarded: number;
  readonly refusals: string[];
  readonly spentCents: number;
}

/** The model half: ask the fixed questions, keep only the answers that hold up. */
async function extractFromPage(
  env: ReturnType<typeof loadEnv>,
  limits: BudgetLimits,
  t: WatchTarget,
  page: string,
): Promise<Extraction> {
  const empty: Extraction = { readings: [], discarded: 0, refusals: [], spentCents: 0 };
  const state = createBudgetState();
  const asked = t.measures.filter((m) => m.answer !== 'measured');

  const res = await callGroq(
    {
      model: MODELS.strong,
      json: true,
      reasoningEffort: 'low',
      maxTokens: 4_000,
      messages: [
        { role: 'system', content: EXTRACT_PROMPT },
        {
          role: 'user',
          content:
            `COMPANY: ${t.company}\nREADING FOR: ${t.reading_for}\n\nQUESTIONS:\n` +
            asked.map((m) => `- ${m.predicate}: ${m.question}`).join('\n') +
            `\n\nPAGE:\n${page.slice(0, 12_000)}`,
        },
      ],
    },
    { apiKey: env.GROQ_API_KEY ?? '', state, limits, runId: RUN },
  );
  if (!res.ok) {
    console.log(`  extraction failed: ${JSON.stringify(res).slice(0, 140)}`);
    return empty;
  }

  await db().execute(sql`
    insert into ai_usage_log (run_id, provider, model, tokens_in, tokens_out, cost_cents, outcome, reason)
    values (${RUN}, 'groq', ${MODELS.strong}, ${res.usage.promptTokens}, ${res.usage.completionTokens},
            ${res.usage.costCents}, 'allowed', 'competitor-watch')`);

  const parsed = JSON.parse(res.text) as { answers?: Answer[] };
  const byPredicate = new Map(asked.map((m) => [m.predicate, m]));
  const haystack = page.toLowerCase();

  const readings: Reading[] = [];
  const refusals: string[] = [];
  let discarded = 0;

  for (const a of parsed.answers ?? []) {
    if (!a?.predicate || !a?.span || a.value === undefined || a.value === null) {
      discarded += 1;
      continue;
    }
    // An invented predicate is discarded rather than stored: the instrument is
    // the fixed set, and a stray key would be a fact nothing ever compares.
    const measure = byPredicate.get(a.predicate);
    if (!measure) {
      discarded += 1;
      continue;
    }
    // THE SPAN MUST ACTUALLY BE ON THE PAGE. Without this the evidence is
    // whatever the model felt like typing, and every downstream citation
    // inherits that. Cheap to check, and it is the difference between a sourced
    // fact and a plausible one.
    if (!haystack.includes(String(a.span).toLowerCase().slice(0, 60))) {
      discarded += 1;
      continue;
    }
    // And the ANSWER must be supported by the span it was given — off-menu for
    // a bounded measure, absent from its own quote for a quoted one. The span
    // being real does not make the answer read off it.
    const verdict = acceptAnswer(measure, a.value, String(a.span));
    if (!verdict.ok) {
      discarded += 1;
      refusals.push(`${measure.predicate.padEnd(34)} ${verdict.why}`);
      continue;
    }
    readings.push({ measure, value: verdict.value, span: String(a.span) });
  }

  return { readings, discarded, refusals, spentCents: res.usage.costCents };
}

export async function watchCompetitors(): Promise<void> {
  const env = loadEnv();
  const limits: BudgetLimits = {
    maxRunTokens: env.TMOS_MAX_RUN_TOKENS,
    maxDailyCostCents: env.TMOS_MAX_DAILY_COST_CENTS,
    maxToolDepth: env.TMOS_MAX_TOOL_DEPTH,
  };
  const transport = createTransport();
  const factStore = createPostgresFactStore();
  const findingStore = createPostgresFindingStore();
  // Reads what we hold NOW — so every lookup must happen before `recordChange`
  // writes the new value, or the observation becomes its own prior.
  const history = createPostgresEntityHistory();
  const sourceId = await ensureSource();
  const now = new Date().toISOString();

  let spent = 0;
  const changes: string[] = [];
  let opened = 0;
  let unchanged = 0;
  /** `recorded_only` is not a `ChangeOutcome`: nothing was correlated, on
   *  purpose, and the tally must show that rather than an absence. */
  const outcomes: Array<ChangeOutcome | { kind: 'recorded_only'; predicate: string }> = [];
  /**
   * Loaded BEFORE the first page is fetched, and allowed to throw.
   *
   * A missing FACT-SHEET is a missing gate, and finding that out after three
   * model calls and a Finding is worse than finding it out at second zero — the
   * run would have to be thrown away anyway. Fail closed, early, cheaply.
   */
  const facts = loadFactSheet();
  const verifier = createGroqVerifier({
    apiKey: env.GROQ_API_KEY ?? '',
    limits,
    runId: RUN,
    onUsage: async (u) => {
      await db().execute(sql`
        insert into ai_usage_log (run_id, provider, model, tokens_in, tokens_out, cost_cents, outcome, reason)
        values (${RUN}, 'groq', ${MODELS.verifier}, ${u.promptTokens}, ${u.completionTokens},
                ${u.costCents}, ${u.outcome}, ${u.reason})`);
    },
  });
  let refused = 0;
  const minted: string[] = [];
  let stored = 0;
  let alreadyHeld = 0;

  for (const t of TARGETS) {
    process.stdout.write(`\n${t.company.padEnd(12)} ${t.url}\n`);

    /**
     * TWO SOURCES, ONE LOOP.
     *
     * The deterministic half runs FIRST and runs independently, which is the
     * point of restructuring this: Jiffy's homepage flattens to 29 characters,
     * so the old shape hit `continue` and the company contributed nothing at
     * all — including the sitemap it publishes precisely for machines. A page
     * a browser has to assemble is not a reason to skip a document that needs
     * no assembling.
     */
    const readings: Reading[] = [];

    if (t.sitemap) {
      const reading = await readSitemapFor(transport, t.sitemap, now);
      if (reading === null) {
        console.log('  sitemap unreadable — nothing recorded from it');
      } else {
        readings.push(
          // The count is recorded and never published: no span contains it, and
          // no rewording of the claim can change that.
          { measure: SITEMAP_COUNT, value: String(reading.count), span: reading.span },
          {
            measure: SITEMAP_CATALOGUE,
            value: reading.catalogue,
            span: reading.span,
            writeClaim: catalogueWriter(t.company, reading),
          },
        );
        console.log(`  sitemap: ${reading.count} services listed (no model involved)`);
      }
    }

    const page = await readPage(transport, t.url);
    if (page === null) {
      console.log('  page: too little text to read, or refused');
    } else {
      const extracted = await extractFromPage(env, limits, t, page);
      spent += extracted.spentCents;
      readings.push(...extracted.readings);
      if (extracted.discarded > 0) console.log(`  (${extracted.discarded} answer(s) discarded)`);
      for (const why of extracted.refusals) console.log(`  ✗ ${why}`);
    }

    if (readings.length === 0) continue;

    const entityId = await ensureEntity(t.company, t.domain);

    for (const a of readings) {
      const o = a.measure;
      // Never write a fact from raw text: the span is carried as evidence with
      // the URL, so every value can be traced to the sentence it came from.
      await ensurePredicate(o);

      const input: FactInput = {
        entityId,
        predicate: o.predicate,
        value:
          o.datatype === 'num'
            ? { datatype: 'num', num: Number(a.value) }
            : { datatype: 'text', text: a.value },
        validFrom: now,
        sourceId,
        observedAt: now,
        confidence: 0.9,
        method: 'llm_extract',
        evidence: {
          url: a.measure.answer === 'measured' ? (t.sitemap?.url ?? t.url) : t.url,
          snippet: a.span.slice(0, 500),
          extractorVersion: a.measure.answer === 'measured' ? 'sitemap@1' : 'watch@3',
        },
      };

      /**
       * BEFORE the write, never after. `correlate` asks the world model what we
       * currently hold; recording first would make this observation its own
       * prior and classify every item as `restated` — a change detector that
       * can never detect a change, and which looks perfectly healthy doing it.
       */
      // A `measured` measure publishes only when it brought a sentence with it.
      // That is the whole exemption: not "we trust it more", but "there is a
      // claim about it that a span can carry".
      const publishable = publishes(o) || a.writeClaim !== undefined;
      const judged: ChangeOutcome | null = !publishable
        ? null
        : await findingFromChange(
        {
          subjectRef: `company:${t.domain}`,
          subjectLabel: t.company,
          predicate: o.predicate,
          predicateLabel: o.predicate.replace(/_/g, ' '),
          value:
            o.datatype === 'num'
              ? { kind: 'num', num: Number(a.value) }
              : { kind: 'text', text: a.value },
          observedAt: now,
          evidence: [
            {
              signal_id: null,
              // The fact does not exist yet — it is written on the next line —
              // and citing one we have not inserted would be a dangling id.
              fact_id: null,
              source_url: a.measure.answer === 'measured' ? (t.sitemap?.url ?? t.url) : t.url,
              span: a.span.slice(0, 500),
              observed_at: now,
            },
          ],
          rootSourceId: sourceId,
          sourceTier: 'first_party',
          writeClaim: a.writeClaim,
          // A competitor's own page changing what it advertises is the highest
          // stake this path can observe; nothing here is a legal exposure.
          stakes: 'high',
        },
        {
          history,
          now: () => new Date(),
          region: 'ca',
          generatedBy: `agent:${MODELS.strong}@watch-3`,
        },
      );
      // An open measure is still recorded — the fact is written below — but it
      // is counted here as what it is: a reading we cannot publish a change
      // from, rather than a change we happened not to find.
      outcomes.push(judged ?? { kind: 'recorded_only', predicate: o.predicate });

      const outcome = await recordChange(factStore, { ...input, validFrom: now }, now);

      const shown = o.datatype === 'num' ? `${a.value}${o.unit ? ' ' + o.unit : ''}` : a.value.slice(0, 60);
      if (outcome.kind === 'opened') {
        opened += 1;
        console.log(`  + ${o.predicate.padEnd(34)} ${shown}`);
      } else if (outcome.kind === 'unchanged') {
        unchanged += 1;
        console.log(`  = ${o.predicate.padEnd(34)} ${shown}`);
      } else {
        const before = outcome.closed?.value;
        const beforeShown = before?.datatype === 'num' ? String(before.num)
          : before?.datatype === 'text' ? before.text.slice(0, 40) : '?';
        changes.push(`${t.company}: ${o.predicate} — was "${beforeShown}", now "${shown}" (${t.url})`);
        console.log(`  ! ${o.predicate.padEnd(34)} ${beforeShown} → ${shown}   *** CHANGED ***`);

        if (judged === null) {
          console.log('      · recorded, not published: an open measure cannot tell drift from change');
        } else if (judged.kind === 'minted') {
          /**
           * NOTHING SHIPS UNVERIFIED. A second model, of a different family by
           * requirement, is asked to REFUTE the claim using only the spans the
           * reader will see — and `passesVerification` is false for `uncertain`,
           * so a timeout or a malformed answer withholds the Finding rather
           * than waving it through.
           */
          const check = await verifyForPublication(
            {
              claim: judged.finding.claim,
              evidence: judged.finding.evidence,
              generated_by: judged.finding.generated_by,
            },
            { verifier, retrievedUrls: [t.url], facts },
          );

          if (!passesVerification(check)) {
            refused += 1;
            console.log(
              `      ✗ ${check.verdict} at ${check.stage}: ${check.reason.slice(0, 150)}` +
                (check.needs_human ? '  → needs a human' : ''),
            );
            continue;
          }

          const put = await findingStore.put(judged.finding);
          if (put.ok && put.stored) stored += 1;
          else if (put.ok) alreadyHeld += 1;
          else console.log(`      ✗ store refused: ${put.reason} ${put.detail}`);
          minted.push(
            `${judged.finding.claim}  [score ${judged.finding.domain_score.toFixed(2)}]\n` +
              `        so what: ${judged.finding.so_what}\n` +
              `        verified: ${check.verifier?.model} — ${check.reason.slice(0, 110)}`,
          );
        } else if (judged.kind === 'rejected') {
          // The gates doing their job. Printed rather than swallowed: an L0
          // rejection is the one place a fabricated number would have surfaced.
          console.log(`      ✗ refused by a mint gate: ${judged.detail.slice(0, 160)}`);
        } else if (judged.kind === 'refused') {
          console.log(`      ✗ T2 declined to diff it: ${judged.reason}`);
        }
      }
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`baseline written: ${opened} new · ${unchanged} unchanged · ${changes.length} CHANGED`);
  for (const c of changes) console.log(`  ! ${c}`);
  if (changes.length === 0 && opened > 0) {
    console.log('\nNo changes because this is the baseline. Every difference from here is a Finding.');
  }
  const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o.kind] = (acc[o.kind] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `\nT2: ${Object.entries(tally).map(([k, n]) => `${k}=${n}`).join(' ') || 'nothing observed'}`,
  );
  if (refused > 0) {
    console.log(`${refused} change(s) withheld by the verifier — refuted or unproven, never silently shipped`);
  }
  if (minted.length > 0) {
    console.log(`\nFINDINGS MINTED (${stored} stored, ${alreadyHeld} already held):`);
    for (const m of minted) console.log(`  ── ${m}`);
  }
  console.log(`cost: ${spent.toFixed(4)}¢`);

  const counts = await db().query<{ facts: number; entities: number }>(sql`
    select (select count(*) from fact)::int as facts, (select count(*) from entity)::int as entities`);
  console.log(`world model now holds ${counts[0]?.facts ?? 0} facts about ${counts[0]?.entities ?? 0} entities`);

}

/**
 * Run only when this file IS the process.
 *
 * `run.ts` imports these to drive a whole pass on ONE pool, so a module that
 * acted on import would run a stage twice and a module that closed the pool
 * would take the next stage down with it. Ownership of the pool therefore
 * belongs to whoever started the process — here, this block; there, the runner.
 */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  watchCompetitors()
    .catch((err: unknown) => {
      console.error('watch failed:', err);
      process.exitCode = 1;
    })
    .finally(closePool);
}
