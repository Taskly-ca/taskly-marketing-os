/**
 * The golden record is a VIEW, not a table.
 *
 * A materialized "golden record" is a second source of truth. The moment it is
 * written it begins drifting from the facts it summarizes: a correction lands,
 * a source is retracted, a rule changes — and the table keeps serving the old
 * answer until something remembers to rebuild it. Nothing ever remembers.
 * Deriving the record on read means it CANNOT be stale: it is a projection of
 * the fact rows that exist at the instant you ask.
 *
 * The second half of the design is per-attribute survivorship. A whole-record
 * "best source wins" strategy lets one bad source poison every field of an
 * entity at once. Choosing per attribute means a farm blog can lose the price
 * while still contributing the address, and a single wrong extraction is
 * contained to the one field it touched.
 *
 * The third half — the one that makes this auditable — is that every field
 * carries the `factId` it came from, and a `why` naming the rule that fired.
 * An entity summary you cannot trace back to evidence is precisely the artifact
 * this system exists to avoid: confident, tidy, and unfalsifiable.
 *
 * Which rule is right is DOMAIN knowledge, per predicate. `mostRecent` is
 * correct for a price and wrong for a founding year. `defaultRuleFor` exists so
 * an unconfigured predicate still resolves deterministically, not because a
 * global default is ever the considered answer.
 */
import { rangeContains } from './fact/types.js';
import type { FactRow, FactStore, FactValue } from './fact/types.js';

export type SurvivorshipRule =
  'mostRecent' | 'mostReliable' | 'mostConfident' | 'mostFrequent' | 'longestHeld';

export interface GoldenField {
  value: FactValue;
  /** The evidence. A field without one is not shippable. */
  factId: string;
  sourceId: string;
  confidence: number;
  rule: SurvivorshipRule;
  /** Which rule fired and why it fired, in words a reviewer can check. */
  why: string;
}

export interface GoldenRules {
  /** Per-predicate rule. Anything unlisted falls back to `defaultRuleFor`. */
  byPredicate?: Readonly<Record<string, SurvivorshipRule>>;
  /** Source reliability, injected: the Beta posterior lives in the `source`
   *  table, and this module must stay free of I/O to remain a pure projection. */
  reliabilityOf?: (sourceId: string) => number;
  /** Copy-chain collapse for `mostFrequent`. Three blogs quoting one press
   *  release are ONE observation; counting them as three is how a plurality
   *  vote gets captured by whoever is copied most. */
  independentRootOf?: (sourceId: string) => string;
  /** Q3: rebuild the record as we believed it at this instant, rather than as
   *  we believe it now. Post-mortems need this; dashboards do not. */
  assertedAt?: string;
}

interface Choice {
  row: FactRow;
  why: string;
}

const ms = (iso: string): number => new Date(iso).getTime();
const DAY = 86_400_000;
const days = (x: number): string => `${Math.round(x / DAY)}d`;

function valueKey(v: FactValue): string {
  switch (v.datatype) {
    case 'text':
      return `text:${v.text}`;
    case 'num':
      return `num:${v.num}`;
    case 'entity':
      return `entity:${v.entityId}`;
    case 'json':
      return `json:${JSON.stringify(v.json)}`;
  }
}

/**
 * ONE tie-break, shared by every rule: confidence, then recency, then fact id.
 *
 * The fact id is the last resort precisely because it is arbitrary — but an
 * arbitrary rule applied identically every time is the whole requirement. A tie
 * broken by row order gives a different golden record depending on how the
 * store happened to return the rows.
 */
function cmpTie(a: FactRow, b: FactRow): number {
  if (b.confidence !== a.confidence) return b.confidence - a.confidence;
  const byValid = ms(b.valid.from) - ms(a.valid.from);
  if (byValid !== 0) return byValid;
  return a.factId < b.factId ? -1 : 1;
}

/** How long this row's value has been true, measured up to `atMs`. */
function heldMs(r: FactRow, atMs: number): number {
  const end = r.valid.to === null ? atMs : Math.min(ms(r.valid.to), atMs);
  return Math.max(0, end - ms(r.valid.from));
}

function groupByValue(rows: FactRow[]): Array<{ key: string; list: FactRow[] }> {
  const m = new Map<string, FactRow[]>();
  for (const r of rows) {
    const k = valueKey(r.value);
    const list = m.get(k);
    if (list) list.push(r);
    else m.set(k, [r]);
  }
  return [...m].map(([key, list]) => ({ key, list }));
}

/** Latest `valid.from` wins. Right for anything that genuinely moves — prices,
 *  headcounts, ratings. Wrong for anything stable, where the newest row is more
 *  often a bad extraction than a change. */
function mostRecent(rows: FactRow[]): Choice {
  const sorted = [...rows].sort((a, b) => ms(b.valid.from) - ms(a.valid.from) || cmpTie(a, b));
  const win = sorted[0]!;
  const next = sorted.find((r) => ms(r.valid.from) !== ms(win.valid.from));
  const tied = sorted.some((r) => r !== win && ms(r.valid.from) === ms(win.valid.from));
  return {
    row: win,
    why:
      `mostRecent: valid from ${win.valid.from}, the latest of ${rows.length} live candidate(s)` +
      (next ? `; next is ${next.valid.from}` : '') +
      (tied ? '; tied on that instant, broken by confidence then fact id' : ''),
  };
}

/** Highest source reliability wins. Right for anything a registry or a
 *  first-party page states and an aggregator merely repeats. */
function mostReliable(rows: FactRow[], reliabilityOf?: (sourceId: string) => number): Choice {
  if (!reliabilityOf) {
    // Scoring every source at zero would produce a confident-looking answer
    // from a rule that never ran. Say what happened instead.
    const fallback = mostRecent(rows);
    return {
      row: fallback.row,
      why: `mostReliable requested but no reliabilityOf supplied — fell back to ${fallback.why}`,
    };
  }
  const sorted = [...rows].sort(
    (a, b) => reliabilityOf(b.sourceId) - reliabilityOf(a.sourceId) || cmpTie(a, b),
  );
  const win = sorted[0]!;
  const top = reliabilityOf(win.sourceId);
  const next = sorted.find((r) => reliabilityOf(r.sourceId) !== top);
  return {
    row: win,
    why:
      `mostReliable: source ${win.sourceId} scores reliability ${top}` +
      (next ? `, next best ${reliabilityOf(next.sourceId)} (${next.sourceId})` : '') +
      (sorted.some((r) => r !== win && reliabilityOf(r.sourceId) === top)
        ? '; tied, broken by confidence then recency then fact id'
        : ''),
  };
}

/** Highest extraction confidence wins. Note this is the EXTRACTOR's confidence
 *  in having read the page correctly — not a claim about the source. */
function mostConfident(rows: FactRow[]): Choice {
  const sorted = [...rows].sort((a, b) => b.confidence - a.confidence || cmpTie(a, b));
  const win = sorted[0]!;
  const next = sorted.find((r) => r.confidence !== win.confidence);
  return {
    row: win,
    why:
      `mostConfident: ${win.confidence} extraction confidence` +
      (next ? ` vs ${next.confidence} for the next candidate` : '') +
      (sorted.some((r) => r !== win && r.confidence === win.confidence)
        ? '; tied, broken by recency then fact id'
        : ''),
  };
}

/** Plurality across INDEPENDENT sources. Right where corroboration is the only
 *  signal available — names, addresses, categories. */
function mostFrequent(rows: FactRow[], independentRootOf?: (sourceId: string) => string): Choice {
  const root = independentRootOf ?? ((s: string) => s);
  const groups = groupByValue(rows)
    .map((g) => ({
      ...g,
      independent: new Set(g.list.map((r) => root(r.sourceId))).size,
      newest: Math.max(...g.list.map((r) => ms(r.valid.from))),
    }))
    .sort(
      (a, b) => b.independent - a.independent || b.newest - a.newest || (a.key < b.key ? -1 : 1),
    );

  const win = groups[0]!;
  const next = groups[1];
  const total = new Set(rows.map((r) => root(r.sourceId))).size;
  return {
    row: [...win.list].sort(cmpTie)[0]!,
    why:
      `mostFrequent: ${win.independent} of ${total} independent source(s) agree` +
      (next ? `, next value has ${next.independent}` : '') +
      (next && next.independent === win.independent
        ? '; tied, broken by recency then value key'
        : '') +
      ' (sources that copy each other collapse to one observation)',
  };
}

/** The value that has been true longest wins. Right for stable attributes —
 *  founding year, incorporation number, legal name — where a value that has
 *  held for years outweighs a scrape that appeared this morning. */
function longestHeld(rows: FactRow[], atMs: number): Choice {
  const groups = groupByValue(rows)
    .map((g) => ({
      ...g,
      held: g.list.reduce((sum, r) => sum + heldMs(r, atMs), 0),
      earliest: Math.min(...g.list.map((r) => ms(r.valid.from))),
    }))
    .sort((a, b) => b.held - a.held || a.earliest - b.earliest || (a.key < b.key ? -1 : 1));

  const win = groups[0]!;
  const next = groups[1];
  return {
    row: [...win.list].sort((a, b) => heldMs(b, atMs) - heldMs(a, atMs) || cmpTie(a, b))[0]!,
    why:
      `longestHeld: held ${days(win.held)}` +
      (next ? ` vs ${days(next.held)} for the next candidate` : '') +
      ' — a long-standing value is not overwritten by a fresh observation, which is' +
      ' more often an extraction error than a change',
  };
}

/**
 * The fallback of last resort, by datatype.
 *
 * These are defensible defaults, NOT recommendations: the right rule is a
 * property of the predicate, and belongs in the predicate registry. `num`
 * defaults to `mostRecent` because most numbers we track genuinely move — which
 * is exactly wrong for `founded_year`, and that is the point.
 */
export function defaultRuleFor(datatype: FactValue['datatype']): SurvivorshipRule {
  switch (datatype) {
    case 'num':
      return 'mostRecent'; // prices, counts, ratings: the newest reading is the truth
    case 'text':
      return 'mostFrequent'; // names and addresses: agreement beats recency
    case 'entity':
      return 'mostReliable'; // relationships: a registry outranks a blog
    case 'json':
      return 'mostRecent'; // whole-object snapshots — never mix two versions
  }
}

function choose(rule: SurvivorshipRule, rows: FactRow[], at: string, rules: GoldenRules): Choice {
  switch (rule) {
    case 'mostRecent':
      return mostRecent(rows);
    case 'mostReliable':
      return mostReliable(rows, rules.reliabilityOf);
    case 'mostConfident':
      return mostConfident(rows);
    case 'mostFrequent':
      return mostFrequent(rows, rules.independentRootOf);
    case 'longestHeld':
      return longestHeld(rows, ms(at));
  }
}

/**
 * Derive the golden record for one entity at one instant.
 *
 * Candidates are the rows we currently believe (`asserted` still open, not
 * retracted) whose `valid` range covers `at` — i.e. our corrected, present-day
 * understanding of that instant. Pass `rules.assertedAt` to rebuild what we
 * believed at a past instant instead; retracted rows are then included when the
 * retraction came later, because we did believe them at the time.
 */
export async function goldenRecord(
  store: FactStore,
  entityId: string,
  at: string,
  rules: GoldenRules = {},
): Promise<Map<string, GoldenField>> {
  const rows = await store.forEntity(entityId);
  const candidates = new Map<string, FactRow[]>();

  for (const r of rows) {
    const believed =
      rules.assertedAt === undefined
        ? r.asserted.to === null && r.status === 'active'
        : rangeContains(r.asserted, rules.assertedAt);
    if (!believed || !rangeContains(r.valid, at)) continue;
    const list = candidates.get(r.predicate);
    if (list) list.push(r);
    else candidates.set(r.predicate, [r]);
  }

  const out = new Map<string, GoldenField>();
  for (const [predicate, list] of candidates) {
    const rule = rules.byPredicate?.[predicate] ?? defaultRuleFor(list[0]!.value.datatype);
    const { row, why } = choose(rule, list, at, rules);
    out.set(predicate, {
      value: row.value,
      factId: row.factId,
      sourceId: row.sourceId,
      confidence: row.confidence,
      rule,
      why,
    });
  }
  return out;
}
