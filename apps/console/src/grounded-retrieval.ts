/**
 * GROUNDED RETRIEVAL — what TMOS already knows, found for one question.
 *
 * Part 6 of the answer-engine plan. Every other part of TMOS produces evidence
 * — the world model, Findings, the Brain, the prediction ledger — and until now
 * the answer box could not read any of it. "What do we know about Jiffy?" went
 * to Tavily and came back with what the open web says about Jiffy, which is the
 * one question we should never have had to ask a search engine.
 *
 * This module is the READ side, and only the read side. It finds the rows,
 * decides which are relevant, and hands them over as
 * `GroundedRecord`s — `packages/research/src/grounded.ts` owns everything after
 * that: the trust ladders, the length floor, deduplication, the numbering, and
 * the refusal messages. Deliberately not duplicated here. Two copies of "a
 * draft may not be cited" disagree eventually, and the copy that is wrong is
 * always the one nobody re-reads.
 *
 * ── HOW RELEVANCE IS DECIDED, AND WHY IT IS NOT ONE MECHANISM ──────────────
 *
 * A question about Jiffy must not retrieve Stripe's pricing. Three different
 * matches do that job, because the three kinds of record fail differently:
 *
 *  - **Facts are scoped by ENTITY NAME, matched literally.** A world-model fact
 *    is about a named company, and a question that wants it names that company.
 *    A nearest-neighbour search over `entity.embedding` (migration 012) would
 *    put "Jiffy" beside "Handy" and every other short service brand, then
 *    answer a question about one with facts about the other — currently, with a
 *    real citation, and undetectably. So the entity list is read (it is small:
 *    a competitor watch, not a CRM), normalised, and matched as whole words
 *    against the question. **No entity named ⇒ no facts are read at all.** That
 *    refusal is the Stripe rule, structural rather than a ranking.
 *
 *  - **Brain passages are matched by EMBEDDING.** A Brain document answers a
 *    question it shares no vocabulary with — "what do we charge" is answered by
 *    a page about commission — which is exactly where a keyword match fails and
 *    a vector does not. `retrieve()` already owns the trust ladder and reports
 *    what it refused, so this module asks it rather than filtering statuses.
 *
 *  - **Findings and forecasts are matched by TERM OVERLAP, weighted by the
 *    entities the question named.** Short internal text, written by us, in our
 *    own vocabulary, with no embedding of its own; adding one is a migration.
 *    Term overlap over a live set of a few hundred rows is deterministic, free,
 *    and explainable in the one place it matters — a reader asking why a
 *    Finding was cited.
 *
 * Anything scoring zero is DROPPED rather than ranked last. Padding an answer
 * out to a comfortable number of sources with records that matched nothing is
 * how a grounded answer comes to look better-evidenced than it is.
 *
 * ── THE TWO FILTERS THAT ARE NOT OPTIMISATIONS ─────────────────────────────
 *
 *  1. **Facts are read on BOTH bitemporal axes** — `upper_inf(asserted) and
 *     upper_inf(valid) and status = 'active'`. AGENTS.md rule 3; the comment on
 *     the query itself says what reading one axis did.
 *  2. **Findings are read live only** — `supersede_reason is null`. A withdrawn
 *     Finding is a mistake we already published a correction for; feeding it
 *     back as evidence re-publishes it wearing a citation.
 */
import { db, sql } from '@tmos/db';
import { createPostgresBrainIndex } from '@tmos/adapters';
import { createGeminiEmbedder, loadEnv } from '@tmos/shared';
import { retrieve } from '@tmos/brain';
import { DEFAULT_ATTRIBUTE_LIMITS, type GroundedRecord } from '@tmos/research';

/* ── what comes back ────────────────────────────────────────────────────── */

export interface GroundedEvidence {
  /** In relevance order. `bindGrounded` considers records in the order given
   *  and truncates the tail, deliberately: only the caller ran the retrieval. */
  readonly records: readonly GroundedRecord[];
  readonly terms: readonly string[];
  /** Entity names the question actually named. Empty ⇒ no facts were read. */
  readonly entities: readonly string[];
  /** What was looked for and not found, in words. Surfaced, never swallowed: a
   *  silent filter is indistinguishable from an empty world model. */
  readonly excluded: readonly string[];
}

/* ── the read port ──────────────────────────────────────────────────────── */

export type EntityRow = {
  readonly id: string;
  readonly name: string;
};

export type FactRow = {
  readonly id: string;
  readonly company: string;
  readonly predicate: string;
  readonly value: string;
  readonly url: string | null;
  /** `evidence.snippet` — the sentence the value was read out of. */
  readonly snippet: string | null;
  /** When we looked, which is not when it became true. `observed_at` is
   *  `not null` in the schema, so this is never absent for a real row. */
  readonly observedAt: string;
};

export type FindingRow = {
  readonly id: string;
  readonly claim: string;
  readonly soWhat: string;
  readonly subjects: readonly string[];
  /** `evidence[0].span` — the PAGE's words. The claim is our paraphrase of
   *  them and is never what gets quoted. */
  readonly span: string | null;
  readonly sourceUrl: string | null;
  readonly created: string;
  /** True when `superseded_by` is set. Belt and braces beside the live-only
   *  filter: a row corrected without a reason recorded is still a correction. */
  readonly superseded: boolean;
};

export type ForecastRow = {
  readonly id: string;
  readonly claim: string;
  readonly p: string;
  readonly resolves: string;
  readonly created: string;
};

export interface BrainPassageRow {
  readonly chunkId: string;
  readonly path: string;
  readonly heading: string;
  readonly text: string;
  /** Restated rather than imported from `@tmos/contracts`: the console does not
   *  depend on that package, and `grounded.ts` restates it for the same reason. */
  readonly right: 'grounds' | 'corroborates' | 'context_only' | 'never_retrieved';
  readonly reviewed: string | null;
}

export interface BrainRead {
  readonly passages: readonly BrainPassageRow[];
  /** What the trust ladder, a missing key or a failed lookup refused. */
  readonly excluded: readonly string[];
}

/** The four reads a grounded answer makes. A port rather than the module, so
 *  the relevance policy above is provable without Postgres or a key. */
export interface GroundedReader {
  entities(): Promise<readonly EntityRow[]>;
  facts(entityIds: readonly string[]): Promise<readonly FactRow[]>;
  findings(): Promise<readonly FindingRow[]>;
  forecasts(): Promise<readonly ForecastRow[]>;
  brain(question: string, limit: number): Promise<BrainRead>;
}

/* ── the pure pieces ────────────────────────────────────────────────────── */

/** Words that are in every question and therefore discriminate nothing. */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'our', 'what', 'when', 'where',
  'which', 'who', 'whom', 'why', 'how', 'does', 'did', 'do', 'is', 'was', 'were',
  'about', 'from', 'with', 'that', 'this', 'they', 'them', 'their', 'there',
  'have', 'has', 'had', 'been', 'being', 'can', 'could', 'should', 'would',
  'we', 'us', 'it', 'its', 'his', 'her', 'him', 'she', 'he', 'a', 'an', 'of',
  'on', 'in', 'to', 'at', 'by', 'as', 'or', 'if', 'so', 'than', 'then', 'know',
  'tell', 'give', 'show', 'me', 'my', 'any', 'all', 'much', 'many', 'more',
]);

/** Whole words, lower case, punctuation gone. The same normalisation is applied
 *  to an entity name, so `TaskRabbit?` and `taskrabbit` are one token. */
const normaliseText = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();

const MAX_TERMS = 14;

/**
 * The words in a question worth matching on.
 *
 * Deterministic and free — no model. Grounded mode's argument is that the
 * evidence is already ours; spending a planning call to decide which of our own
 * rows to read would put a model between the question and the ledger for no
 * precision a stopword list does not already buy.
 */
export function questionTerms(question: string): string[] {
  const out: string[] = [];
  for (const word of normaliseText(question).split(' ')) {
    if (word.length < 3 || STOPWORDS.has(word) || out.includes(word)) continue;
    out.push(word);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/**
 * The entities this question actually names.
 *
 * Whole-name containment, not fuzzy: `" jiffy "` inside `" what do we know
 * about jiffy in toronto "`. A multi-word name matches as a phrase. What this
 * deliberately does NOT do is match a name the question spelled differently
 * ("Task Rabbit" against `TaskRabbit`); that failure is a missing fact, which
 * is visible, rather than a fact about the wrong company, which is not.
 */
export function matchEntities(
  question: string,
  entities: readonly EntityRow[],
): EntityRow[] {
  const haystack = ` ${normaliseText(question)} `;
  const out: EntityRow[] = [];
  for (const e of entities) {
    const name = normaliseText(e.name);
    if (name.length < 2 || !haystack.includes(` ${name} `)) continue;
    if (out.some((k) => k.id === e.id)) continue;
    out.push(e);
  }
  return out;
}

/** How many of the question's terms appear in this text. Distinct terms, so a
 *  row repeating one word twenty times does not outrank one that answers. */
export function overlap(terms: readonly string[], text: string): number {
  const haystack = ` ${normaliseText(text)} `;
  return terms.filter((t) => haystack.includes(` ${t} `)).length;
}

/**
 * The sentences of a Brain chunk that answer the question, as ONE CONTIGUOUS
 * SLICE of the chunk.
 *
 * Required, not an optimisation. `bindGrounded` caps a span at
 * `maxSpanChars` — because phase C's number check degrades to nothing as a span
 * grows, a span the length of a page containing every figure on it — and a
 * Brain chunk is routinely longer than the cap. An unnarrowed chunk is dropped
 * with a reason telling the caller to narrow it. This is that caller.
 *
 * A CONTIGUOUS slice, and that is the load-bearing word: `bindGrounded`
 * string-checks the narrowed span against the chunk precisely because a caller
 * stitching two non-adjacent sentences together produces a sentence the
 * document does not contain, and nothing downstream would ever notice.
 *
 * Returns undefined when no window scores — the record is then handed over
 * un-narrowed and refused downstream, which keeps the refusal in one place.
 */
export function narrowToSpan(
  text: string,
  terms: readonly string[],
  maxChars: number = DEFAULT_ATTRIBUTE_LIMITS.maxSpanChars,
  minChars: number = DEFAULT_ATTRIBUTE_LIMITS.minSpanChars,
): string | undefined {
  const body = text.trim();
  if (body.length <= maxChars) return body.length >= minChars ? body : undefined;

  // Boundaries, not pieces: every window below is `body.slice(a, b)`, so it is
  // a substring of the chunk by construction rather than by reassembly.
  const bounds: number[] = [0];
  for (const m of body.matchAll(/[.!?…]["')\]]?\s+/g)) {
    const end = m.index + m[0].length;
    if (end < body.length) bounds.push(end);
  }
  bounds.push(body.length);

  let best: { span: string; score: number } | undefined;
  const starts = bounds.slice(0, -1).slice(0, 60);
  for (let i = 0; i < starts.length; i += 1) {
    for (let j = i + 1; j < bounds.length; j += 1) {
      const a = bounds[i];
      const b = bounds[j];
      if (a === undefined || b === undefined) continue;
      const span = body.slice(a, b).trim();
      if (span.length > maxChars) break;
      if (span.length < minChars) continue;
      const score = overlap(terms, span);
      // Highest overlap wins; the shortest window wins a tie, because a longer
      // quote that adds no matching term adds only figures the number check
      // will then accept without them having been asked for.
      if (best === undefined || score > best.score || (score === best.score && span.length < best.span.length)) {
        best = { span, score };
      }
    }
  }
  return best !== undefined && best.score > 0 ? best.span : undefined;
}

/** A named entity is worth more than a shared word: it is what the question is
 *  ABOUT, and term overlap on a short internal claim is noisy at 1. */
const ENTITY_WEIGHT = 2;

const MAX_ENTITY_NAMES = 500;
const MAX_FACTS = 12;
const MAX_FINDINGS = 6;
const MAX_BRAIN = 6;
const MAX_FORECASTS = 4;

/** Score first, then recency, then a total tie-break so two identical questions
 *  against an unordered read can never produce two different answers. */
function ranked<T>(
  scored: readonly { row: T; score: number; recency: string; key: string }[],
  cap: number,
): T[] {
  return [...scored]
    .sort((a, b) =>
      b.score - a.score ||
      (a.recency < b.recency ? 1 : a.recency > b.recency ? -1 : 0) ||
      (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, cap)
    .map((s) => s.row);
}

const trim = (s: string, n: number): string =>
  s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`;

/* ── the read ───────────────────────────────────────────────────────────── */

export async function retrieveGrounded(
  question: string,
  reader: GroundedReader,
): Promise<GroundedEvidence> {
  const terms = questionTerms(question);
  const excluded: string[] = [];

  /* 1 ─ who the question is about. This is the Stripe rule. */
  const named = matchEntities(question, await reader.entities());
  const entityNames = named.map((e) => e.name);
  if (named.length === 0) {
    excluded.push(
      'no world-model facts: the question names no company we hold facts about, and answering it with another company’s facts is the failure this scoping exists to prevent',
    );
  }

  /* 2 ─ facts, for those entities only, on both bitemporal axes (in the SQL) */
  const factRows = named.length > 0 ? await reader.facts(named.map((e) => e.id)) : [];
  const facts = ranked(
    factRows.map((row) => ({
      row,
      // Every candidate is already about a named entity, so the floor of 1 is
      // "this is about who you asked about" and the overlap is "and about what".
      score: 1 + overlap(terms, `${row.predicate} ${row.value} ${row.snippet ?? ''}`),
      recency: row.observedAt,
      key: row.id,
    })),
    MAX_FACTS,
  );

  /* 3 ─ the Brain, by embedding. The ladder is `retrieve()`'s, and the refusal
   *     of a draft is `bindGrounded`'s — neither is re-implemented here. */
  const brainRead = await reader.brain(question, MAX_BRAIN * 2);
  excluded.push(...brainRead.excluded);
  const brain = brainRead.passages.slice(0, MAX_BRAIN);

  /* 4 ─ findings, live only, by term overlap weighted by the named entities */
  const findingRows = await reader.findings();
  const findings = ranked(
    findingRows
      .map((row) => ({
        row,
        // Scored on the CLAIM and the so-what — our analysis, which is what
        // makes a finding findable — while only its evidence span is quotable.
        score:
          overlap(terms, `${row.claim} ${row.soWhat}`) +
          ENTITY_WEIGHT *
            row.subjects.filter((s) => entityNames.some((n) => normaliseText(n) === normaliseText(s))).length,
        recency: row.created,
        key: row.id,
      }))
      .filter((s) => s.score > 0),
    MAX_FINDINGS,
  );

  /* 5 ─ open forecasts, same rule */
  const forecastRows = await reader.forecasts();
  const forecasts = ranked(
    forecastRows
      .map((row) => ({
        row,
        score:
          overlap(terms, row.claim) +
          ENTITY_WEIGHT * entityNames.filter((n) => overlap([normaliseText(n)], row.claim) > 0).length,
        recency: row.created,
        key: row.id,
      }))
      .filter((s) => s.score > 0),
    MAX_FORECASTS,
  );

  /* 6 ─ hand them over in relevance order. World, Brain, findings, forecasts —
   *     fixed, so the same question twice numbers the same record the same way.
   *     Nothing is filtered for citability here: a fact with no snippet, a
   *     finding with no span and a draft passage are all refused by
   *     `bindGrounded`, with a reason a reader can act on. */
  const records: GroundedRecord[] = [];

  for (const f of facts) {
    records.push({
      type: 'world_fact',
      id: f.id,
      title: `${f.company} — ${f.predicate}`,
      // The fact's own source URL: the page the value was read off, and the one
      // link on a grounded card that a reader can actually open. Absent, a
      // locator goes in its place rather than an http URL invented to make the
      // strip look uniform — `events.ts` is explicit about that.
      url: (f.url ?? '').trim() !== '' ? (f.url ?? '') : `world model · ${f.company} · ${f.predicate}`,
      snippet: (f.snippet ?? '').trim(),
      observedAt: f.observedAt,
    });
  }
  for (const p of brain) {
    const span = narrowToSpan(p.text, terms);
    records.push({
      type: 'brain_passage',
      id: p.chunkId,
      title: p.path,
      path: p.path,
      heading: p.heading,
      text: p.text,
      ...(span !== undefined ? { span } : {}),
      right: p.right,
      reviewed: p.reviewed,
    });
  }
  for (const f of findings) {
    records.push({
      type: 'finding',
      id: f.id,
      title: trim(f.claim, 90),
      sourceUrl: (f.sourceUrl ?? '').trim(),
      span: (f.span ?? '').trim(),
      observedAt: f.created,
      superseded: f.superseded,
    });
  }
  for (const f of forecasts) {
    records.push({
      type: 'forecast',
      id: f.id,
      title: trim(f.claim, 90),
      locator: `prediction · ${f.id}`,
      claim: f.claim,
      p: Number(f.p),
      resolveAt: f.resolves,
    });
  }

  return { records, terms, entities: entityNames, excluded };
}

/* ── the Postgres side ──────────────────────────────────────────────────── */

/**
 * The real reader. Deliberately thin — every decision above is in pure code,
 * and what is left here is four `select`s and the two filters that must not
 * live anywhere else.
 */
export function createPostgresGroundedReader(): GroundedReader {
  return {
    async entities() {
      // The whole (small) list, matched in memory. A competitor watch holds
      // tens of rows; if it ever holds thousands this must move into SQL and
      // use `entity_name_trgm_idx`. The cap is what makes that visible rather
      // than silently returning a partial match set.
      return db().query<EntityRow>(sql`
        select id::text as id, name from entity
         order by name limit ${MAX_ENTITY_NAMES}`);
    },

    async facts(entityIds) {
      return db().query<FactRow>(sql`
        select f.fact_id::text as id, e.name as company, f.predicate,
               coalesce(f.object_text, f.object_num::text) as value,
               f.evidence->>'url' as url, f.evidence->>'snippet' as snippet,
               to_char(f.observed_at,'YYYY-MM-DD') as "observedAt"
          from fact f join entity e on e.id = f.entity_id
     -- BITEMPORAL, BOTH AXES. "upper_inf(asserted)" alone means "we never
     -- retracted this", which is NOT "this is true now": the world changing
     -- closes "valid", and a closed "valid" is a PAST state we deliberately
     -- kept. Reading only the asserted axis showed a competitor in seven
     -- contradictory states at once and called all of them current — 43 rows
     -- where the world model holds 29. AGENTS.md rule 3 names this conflation
     -- as the single most damaging error available here, and an answer engine
     -- is where it does the most damage: the reader gets a real citation to a
     -- real page for a value that stopped being true months ago.
         where upper_inf(f.asserted) and upper_inf(f.valid) and f.status = 'active'
           and f.entity_id = any(${entityIds}::uuid[])
         order by f.observed_at desc limit 60`);
    },

    async findings() {
      return db().query<FindingRow>(sql`
        select f.id::text as id, f.claim, f.so_what as "soWhat",
               f.subject_refs as subjects,
               f.evidence->0->>'span' as span,
               f.evidence->0->>'source_url' as "sourceUrl",
               to_char(f.created_at,'YYYY-MM-DD') as created,
               (f.superseded_by is not null) as superseded
          from finding f
     -- LIVE ONLY. A superseded Finding is something we withdrew and published a
     -- correction for; citing it in a new answer re-publishes the mistake with
     -- a citation attached, which is worse than never having caught it. The
     -- "superseded" column above is carried as well, so a row corrected without
     -- a reason recorded is still refused downstream.
         where f.supersede_reason is null
         order by f.created_at desc limit 150`);
    },

    async forecasts() {
      return db().query<ForecastRow>(sql`
        select id::text as id, claim, p::text as p,
               to_char(resolve_at,'YYYY-MM-DD') as resolves,
               to_char(created_at,'YYYY-MM-DD') as created
          from prediction where outcome is null order by resolve_at limit 60`);
    },

    async brain(question, limit) {
      const key = loadEnv().GEMINI_API_KEY;
      if (!key) {
        return { passages: [], excluded: ['the Brain was not searched — no GEMINI_API_KEY'] };
      }
      try {
        const [vector] = await createGeminiEmbedder({ apiKey: key }).embed([question]);
        if (!vector) return { passages: [], excluded: ['the Brain returned no embedding for the question'] };
        const result = await retrieve(createPostgresBrainIndex(), { vector, limit }, new Date());
        return {
          passages: result.hits.map((hit) => ({
            chunkId: hit.chunk.chunkId,
            path: hit.doc.path,
            heading: hit.chunk.heading,
            text: hit.chunk.text,
            right: hit.right,
            reviewed: hit.doc.reviewed,
          })),
          // Named by path, the same way `bindGrounded` names a kept passage,
          // so a reader comparing a refusal to a citation sees one vocabulary.
          excluded: result.excluded.map((x) => `${x.path} — ${x.reason}`),
        };
      } catch (err) {
        // A Brain miss narrows a grounded answer; it does not fail it. The
        // reason is carried out rather than logged, because a reader looking at
        // four sources instead of six is owed the reason there are four.
        return {
          passages: [],
          excluded: [`the Brain lookup failed: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    },
  };
}
