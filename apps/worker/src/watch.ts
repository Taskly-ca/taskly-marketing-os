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

import { MODELS, callGroq, createBudgetState, loadEnv, type BudgetLimits } from '@tmos/shared';
import {
  createPostgresFactStore,
  createPostgresPredicateStore,
  entityByHardKey,
  insertEntity,
  attachHardKey,
} from '@tmos/adapters';
import { recordChange, type FactInput } from '@tmos/world';
import { db, sql, closePool } from '@tmos/db';

import { createTransport } from './transport.js';

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
   * The measures to answer, FIXED. Not a suggestion — the model is asked to fill
   * these in and nothing else.
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
}

interface Measure {
  readonly predicate: string;
  readonly datatype: 'num' | 'text';
  readonly unit: string | null;
  /** Asked verbatim. Must have one answer the page either states or does not. */
  readonly question: string;
}

const COMMON: readonly Measure[] = [
  { predicate: 'service_categories_count', datatype: 'num', unit: 'count',
    question: 'How many distinct service categories does this page list? Count them.' },
  { predicate: 'serves_canada', datatype: 'text', unit: null,
    question: 'Does the page indicate service in Canada? Answer exactly yes, no, or unstated.' },
  { predicate: 'cities_listed', datatype: 'text', unit: null,
    question: 'Which cities does the page name, comma-separated and alphabetised? If none, answer none.' },
  { predicate: 'lowest_advertised_price', datatype: 'text', unit: null,
    question: 'What is the lowest price the page advertises, with its currency and unit exactly as written? If no price is shown, answer unstated.' },
  { predicate: 'offers_snow_removal', datatype: 'text', unit: null,
    question: 'Does the page list snow removal? Answer exactly yes, no, or unstated.' },
  { predicate: 'offers_cleaning', datatype: 'text', unit: null,
    question: 'Does the page list house or home cleaning? Answer exactly yes, no, or unstated.' },
];

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

async function main(): Promise<void> {
  const env = loadEnv();
  const limits: BudgetLimits = {
    maxRunTokens: env.TMOS_MAX_RUN_TOKENS,
    maxDailyCostCents: env.TMOS_MAX_DAILY_COST_CENTS,
    maxToolDepth: env.TMOS_MAX_TOOL_DEPTH,
  };
  const transport = createTransport();
  const factStore = createPostgresFactStore();
  const sourceId = await ensureSource();
  const now = new Date().toISOString();

  let spent = 0;
  const changes: string[] = [];
  let opened = 0;
  let unchanged = 0;

  for (const t of TARGETS) {
    process.stdout.write(`\n${t.company.padEnd(12)} ${t.url}\n`);

    let page: string | null = null;
    try {
      const res = await transport.fetchText(t.url, { Accept: 'text/html' });
      page = res.status >= 200 && res.status < 300 ? flatten(res.body) : null;
      if (!page) console.log(`  unreadable: HTTP ${res.status}`);
    } catch (err) {
      console.log(`  refused: ${err instanceof Error ? err.message.slice(0, 90) : String(err)}`);
      continue;
    }
    if (!page || page.length < 400) {
      console.log('  too little text to read — not recording anything');
      continue;
    }

    const state = createBudgetState();
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
              t.measures.map((m) => `- ${m.predicate}: ${m.question}`).join('\n') +
              `\n\nPAGE:\n${page.slice(0, 12_000)}`,
          },
        ],
      },
      { apiKey: env.GROQ_API_KEY ?? '', state, limits, runId: RUN },
    );
    if (!res.ok) {
      console.log(`  extraction failed: ${JSON.stringify(res).slice(0, 140)}`);
      continue;
    }
    spent += res.usage.costCents;
    await db().execute(sql`
      insert into ai_usage_log (run_id, provider, model, tokens_in, tokens_out, cost_cents, outcome, reason)
      values (${RUN}, 'groq', ${MODELS.strong}, ${res.usage.promptTokens}, ${res.usage.completionTokens},
              ${res.usage.costCents}, 'allowed', 'competitor-watch')`);

    const parsed = JSON.parse(res.text) as { answers?: Answer[] };
    const byPredicate = new Map(t.measures.map((m) => [m.predicate, m]));
    const haystack = page.toLowerCase();

    const answers = (parsed.answers ?? []).filter((a) => {
      if (!a?.predicate || !a?.span || a.value === undefined || a.value === null) return false;
      // An invented predicate is discarded rather than stored: the instrument is
      // the fixed set, and a stray key would be a fact nothing ever compares.
      if (!byPredicate.has(a.predicate)) return false;
      // THE SPAN MUST ACTUALLY BE ON THE PAGE. Without this the evidence is
      // whatever the model felt like typing, and every downstream citation
      // inherits that. Cheap to check, and it is the difference between a
      // sourced fact and a plausible one.
      return haystack.includes(String(a.span).toLowerCase().slice(0, 60));
    });

    const discarded = (parsed.answers ?? []).length - answers.length;
    if (discarded > 0) console.log(`  (${discarded} answer(s) discarded: unknown predicate or span not on the page)`);

    const entityId = await ensureEntity(t.company, t.domain);

    for (const a of answers) {
      const o = byPredicate.get(a.predicate)!;
      // Never write a fact from raw text: the span is carried as evidence with
      // the URL, so every value can be traced to the sentence it came from.
      await ensurePredicate(o);

      const input: FactInput = {
        entityId,
        predicate: o.predicate,
        value:
          o.datatype === 'num'
            ? { datatype: 'num', num: Number(a.value) }
            : { datatype: 'text', text: String(a.value).trim().toLowerCase() },
        validFrom: now,
        sourceId,
        observedAt: now,
        confidence: 0.9,
        method: 'llm_extract',
        evidence: { url: t.url, snippet: String(a.span).slice(0, 500), extractorVersion: 'watch@2' },
      };

      const outcome = await recordChange(factStore, { ...input, validFrom: now }, now);

      const shown = o.datatype === 'num' ? `${a.value}${o.unit ? ' ' + o.unit : ''}` : String(a.value).trim().toLowerCase().slice(0, 60);
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
      }
    }
  }

  console.log(`\n${'─'.repeat(72)}`);
  console.log(`baseline written: ${opened} new · ${unchanged} unchanged · ${changes.length} CHANGED`);
  for (const c of changes) console.log(`  ! ${c}`);
  if (changes.length === 0 && opened > 0) {
    console.log('\nNo changes because this is the baseline. Every difference from here is a Finding.');
  }
  console.log(`cost: ${spent.toFixed(4)}¢`);

  const counts = await db().query<{ facts: number; entities: number }>(sql`
    select (select count(*) from fact)::int as facts, (select count(*) from entity)::int as entities`);
  console.log(`world model now holds ${counts[0]?.facts ?? 0} facts about ${counts[0]?.entities ?? 0} entities`);

  await closePool();
}

main().catch(async (err) => {
  console.error('watch failed:', err);
  await closePool();
  process.exit(1);
});
