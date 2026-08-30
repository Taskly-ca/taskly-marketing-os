/**
 * WHAT GROUNDED RETRIEVAL OWES, PROVEN WITHOUT A DATABASE OR A KEY.
 *
 * The SQL is four `select`s and is deliberately the thinnest part of the
 * module; everything that decides what a reader ends up looking at is pure and
 * is tested here. Four things matter, and each is a way a grounded answer goes
 * wrong in a manner nobody would notice from the screen:
 *
 *  1. **Scope.** A question about Jiffy must not come back holding Stripe's
 *     pricing. A wrongly-scoped fact is real, current and correctly cited — the
 *     only thing wrong with it is that it is about somebody else, and no gate
 *     downstream can catch that.
 *  2. **The withdrawn must not return.** A superseded Finding is a mistake we
 *     already published a correction for.
 *  3. **A finding is cited by its EVIDENCE, never by its claim.** The claim is
 *     our paraphrase; quoting it would attach a badge meaning "verbatim on a
 *     page" to a sentence we wrote.
 *  4. **The card must say what it is holding.** The last block runs the records
 *     through the real `groundedUniverse` — no fake — because "the source
 *     events are right" is a claim about the two modules together, and a fake
 *     universe here would prove only that this file agrees with itself.
 */
import { describe, expect, it } from 'vitest';
import { groundedSourceEvents, groundedUniverse } from '@tmos/research';

import {
  matchEntities,
  narrowToSpan,
  overlap,
  questionTerms,
  retrieveGrounded,
  type BrainRead,
  type EntityRow,
  type FactRow,
  type FindingRow,
  type ForecastRow,
  type GroundedReader,
} from './grounded-retrieval.js';

/* ── fakes ──────────────────────────────────────────────────────────────── */

const JIFFY: EntityRow = { id: 'e-jiffy', name: 'Jiffy' };
const STRIPE: EntityRow = { id: 'e-stripe', name: 'Stripe' };

const fact = (over: Partial<FactRow> = {}): FactRow => ({
  id: 'fact-1',
  company: 'Jiffy',
  predicate: 'price_min',
  value: '129',
  url: 'https://jiffy.ca/pricing',
  snippet: 'Jobs start at $129 for a two-hour visit.',
  observedAt: '2026-08-20',
  ...over,
});

const finding = (over: Partial<FindingRow> = {}): FindingRow => ({
  id: 'f-1',
  claim: 'Jiffy raised its minimum job price',
  soWhat: 'Our commission looks cheaper against a higher floor',
  subjects: ['Jiffy'],
  span: 'Jobs now start at $129, up from $99.',
  sourceUrl: 'https://jiffy.ca/pricing',
  created: '2026-08-25',
  superseded: false,
  ...over,
});

const forecast = (over: Partial<ForecastRow> = {}): ForecastRow => ({
  id: 'p-1',
  claim: 'Jiffy will enter Vancouver before 2027',
  p: '0.35',
  resolves: '2027-01-01',
  created: '2026-08-01',
  ...over,
});

const passage = (over: Partial<BrainRead['passages'][number]> = {}) => ({
  chunkId: 'c-1',
  path: '60-business/PRICING_v3.md',
  heading: 'Commission',
  text: 'Commission is 20%, HST-inclusive.',
  right: 'grounds' as const,
  reviewed: '2026-08-01',
  ...over,
});

const NO_BRAIN: BrainRead = { passages: [], excluded: [] };

function reader(over: Partial<GroundedReader> = {}): GroundedReader {
  return {
    entities: async () => [JIFFY, STRIPE],
    facts: async () => [],
    findings: async () => [],
    forecasts: async () => [],
    brain: async () => NO_BRAIN,
    ...over,
  };
}

const ABOUT_JIFFY = 'What do we know about Jiffy pricing in Toronto?';

/* ── the pure pieces ────────────────────────────────────────────────────── */

describe('questionTerms', () => {
  it('keeps the words that discriminate and drops the ones in every question', () => {
    expect(questionTerms('What do we know about Jiffy pricing?')).toEqual(['jiffy', 'pricing']);
  });

  it('is deterministic and deduped — the same question reads the same rows twice', () => {
    expect(questionTerms('Jiffy Jiffy jiffy!')).toEqual(['jiffy']);
  });
});

describe('matchEntities', () => {
  it('matches a name the question actually names, and nothing else', () => {
    expect(matchEntities(ABOUT_JIFFY, [JIFFY, STRIPE]).map((e) => e.name)).toEqual(['Jiffy']);
  });

  it('matches whole words only — "handyman" is not Handy', () => {
    expect(matchEntities('should we hire a handyman?', [{ id: 'e-handy', name: 'Handy' }])).toEqual([]);
  });

  it('matches a multi-word name as a phrase', () => {
    expect(matchEntities('how does task rabbit price a mount?', [{ id: 'e-tr', name: 'Task Rabbit' }])).toHaveLength(1);
  });
});

describe('overlap', () => {
  it('counts distinct terms, so repetition does not buy rank', () => {
    expect(overlap(['jiffy', 'pricing'], 'jiffy jiffy jiffy')).toBe(1);
    expect(overlap(['jiffy', 'pricing'], 'jiffy pricing page')).toBe(2);
  });
});

describe('narrowToSpan', () => {
  const long = [
    'The company was founded in Toronto in 2016 and has grown steadily since.',
    'Commission is 20% of the agreed price, HST-inclusive.',
    'Everything else on this page is background about the founding team and the office.',
    'None of it bears on what anybody is charged for anything at all, ever.',
  ].join(' ');

  it('leaves a chunk that already fits alone', () => {
    expect(narrowToSpan('Commission is 20%, HST-inclusive.', ['commission'])).toBe('Commission is 20%, HST-inclusive.');
  });

  it('picks the sentence that answers, out of a chunk too long to cite whole', () => {
    // Without this, `bindGrounded` drops the passage for exceeding the span cap
    // and a grounded answer loses the Brain entirely.
    expect(narrowToSpan(long, ['commission'], 90)).toBe('Commission is 20% of the agreed price, HST-inclusive.');
  });

  it('returns a CONTIGUOUS substring, never two sentences stitched together', () => {
    const span = narrowToSpan(long, ['commission', 'toronto'], 200);
    expect(span).toBeDefined();
    // `bindGrounded` string-checks the narrowing against the chunk for exactly
    // this reason: a quote assembled from non-adjacent text is a sentence the
    // document does not contain, and nothing downstream would notice.
    expect(long).toContain(span);
  });

  it('gives up rather than trimming when nothing in the chunk matches', () => {
    expect(narrowToSpan(long, ['snowplough'], 90)).toBeUndefined();
  });
});

/* ── scope: the rule the whole module exists for ────────────────────────── */

describe('retrieveGrounded — scope', () => {
  it('reads facts only for the entities the question named', async () => {
    const asked: string[][] = [];
    const evidence = await retrieveGrounded(
      ABOUT_JIFFY,
      reader({
        facts: async (ids) => {
          asked.push([...ids]);
          return [fact()];
        },
      }),
    );

    // Stripe is in the entity table and is not in the question. If its id ever
    // reaches this query, a question about Jiffy can be answered with Stripe's
    // pricing — correctly cited, current, and about the wrong company.
    expect(asked).toEqual([['e-jiffy']]);
    expect(evidence.entities).toEqual(['Jiffy']);
    expect(evidence.records.map((r) => r.type)).toEqual(['world_fact']);
  });

  it('reads no facts at all when the question names no company we hold', async () => {
    let called = false;
    const evidence = await retrieveGrounded(
      'How should we price snow removal this winter?',
      reader({
        facts: async () => {
          called = true;
          return [fact()];
        },
      }),
    );

    expect(called).toBe(false);
    expect(evidence.records).toEqual([]);
    // Refused out loud. An empty source strip with no reason reads as an empty
    // world model, which is a different and much more discouraging claim.
    expect(evidence.excluded.join(' ')).toMatch(/names no company/i);
  });

  it('drops a finding and a forecast that match nothing rather than padding', async () => {
    const evidence = await retrieveGrounded(
      ABOUT_JIFFY,
      reader({
        findings: async () => [
          finding(),
          finding({ id: 'f-2', claim: 'Our email open rate fell', soWhat: 'Creative fatigue', subjects: ['Taskly'] }),
        ],
        forecasts: async () => [forecast(), forecast({ id: 'p-2', claim: 'Interest rates fall in Q1' })],
      }),
    );

    expect(evidence.records.filter((r) => r.type === 'finding')).toHaveLength(1);
    expect(evidence.records.filter((r) => r.type === 'forecast')).toHaveLength(1);
  });

  it('ranks the fact that answers the question above the one that does not', async () => {
    const evidence = await retrieveGrounded(
      ABOUT_JIFFY,
      reader({
        facts: async () => [
          fact({ id: 'a', predicate: 'headcount', value: '40', snippet: 'The company employs 40 people.', observedAt: '2026-08-29' }),
          fact({ id: 'b', predicate: 'pricing', snippet: 'Jiffy pricing starts at $129.', observedAt: '2026-01-01' }),
        ],
      }),
    );
    // Recency is the tie-break, not the ranking: a newer irrelevant fact must
    // not outrank an older one that is about what was asked. `bindGrounded`
    // considers records in the order given and truncates the tail, so this
    // ordering is what survives a cap.
    expect(evidence.records[0]?.title).toBe('Jiffy — pricing');
  });
});

/* ── what each record carries downstream ────────────────────────────────── */

describe('retrieveGrounded — the records handed to grounded.ts', () => {
  it('gives a world fact its stored snippet, its source page and the day we looked', async () => {
    const evidence = await retrieveGrounded(ABOUT_JIFFY, reader({ facts: async () => [fact()] }));
    expect(evidence.records[0]).toEqual({
      type: 'world_fact',
      id: 'fact-1',
      title: 'Jiffy — price_min',
      url: 'https://jiffy.ca/pricing',
      snippet: 'Jobs start at $129 for a two-hour visit.',
      observedAt: '2026-08-20',
    });
  });

  it('gives a fact with no source URL a locator instead of a link that 404s', async () => {
    const evidence = await retrieveGrounded(ABOUT_JIFFY, reader({ facts: async () => [fact({ url: null })] }));
    expect(evidence.records[0]).toMatchObject({ url: 'world model · Jiffy · price_min' });
  });

  it('cites a finding by its evidence span, never by our own claim', async () => {
    const evidence = await retrieveGrounded(ABOUT_JIFFY, reader({ findings: async () => [finding()] }));
    const record = evidence.records[0];
    expect(record).toMatchObject({
      type: 'finding',
      span: 'Jobs now start at $129, up from $99.',
      sourceUrl: 'https://jiffy.ca/pricing',
    });
    // The claim is the card's TITLE — what the finding says — and is nowhere in
    // the quotable field. A badge meaning "verbatim on a page" over a sentence
    // we wrote is the whole failure this split exists to prevent.
    expect(record).toMatchObject({ title: 'Jiffy raised its minimum job price' });
    if (record?.type !== 'finding') throw new Error('expected a finding');
    expect(record.span).not.toContain('raised its minimum job price');
  });

  it('carries the superseded flag so a corrected finding is refused downstream', async () => {
    // Belt and braces beside the live-only SQL filter: a row corrected without
    // a `supersede_reason` recorded is still a correction, and `bindGrounded`
    // fails closed on the flag.
    const evidence = await retrieveGrounded(
      ABOUT_JIFFY,
      reader({ findings: async () => [finding({ superseded: true })] }),
    );
    expect(evidence.records[0]).toMatchObject({ superseded: true });
  });

  it('carries a Brain passage’s grounding right rather than deciding it here', async () => {
    const evidence = await retrieveGrounded(
      ABOUT_JIFFY,
      reader({
        brain: async () => ({
          passages: [passage(), passage({ chunkId: 'c-2', path: 'd/IDEAS.md', right: 'context_only', reviewed: null })],
          excluded: [],
        }),
      }),
    );
    // Both are handed over. The draft is refused by `bindGrounded`, with a
    // reason a reader can act on — a second copy of the ladder here would
    // eventually disagree with the first.
    expect(evidence.records.map((r) => (r.type === 'brain_passage' ? r.right : null))).toEqual([
      'grounds',
      'context_only',
    ]);
  });

  it('carries the trust ladder’s own refusals out instead of swallowing them', async () => {
    const evidence = await retrieveGrounded(
      ABOUT_JIFFY,
      reader({ brain: async () => ({ passages: [], excluded: ['old/PRICING.md — superseded'] }) }),
    );
    expect(evidence.excluded).toContain('old/PRICING.md — superseded');
  });

  it('narrows a Brain chunk too long to cite, and keeps the narrowing checkable', async () => {
    const text = `${'Background prose that answers nothing at all. '.repeat(12)}Commission is 20%, HST-inclusive.`;
    const evidence = await retrieveGrounded(
      'What commission do we charge?',
      reader({ brain: async () => ({ passages: [passage({ text })], excluded: [] }) }),
    );
    const record = evidence.records[0];
    expect(record?.type).toBe('brain_passage');
    if (record?.type !== 'brain_passage') throw new Error('expected a brain passage');
    expect(record.span).toBe('Commission is 20%, HST-inclusive.');
    expect(record.text).toContain(record.span ?? '');
  });

  it('renders a forecast’s probability as a number, not the string Postgres returns', async () => {
    const evidence = await retrieveGrounded(ABOUT_JIFFY, reader({ forecasts: async () => [forecast()] }));
    expect(evidence.records[0]).toEqual({
      type: 'forecast',
      id: 'p-1',
      title: 'Jiffy will enter Vancouver before 2027',
      locator: 'prediction · p-1',
      claim: 'Jiffy will enter Vancouver before 2027',
      p: 0.35,
      resolveAt: '2027-01-01',
    });
  });
});

/* ── through the real universe builder ──────────────────────────────────── */

describe('the records, through the real groundedUniverse', () => {
  const everything = reader({
    facts: async () => [fact()],
    findings: async () => [finding()],
    forecasts: async () => [forecast()],
    brain: async () => ({ passages: [passage()], excluded: [] }),
  });

  it('tells the renderer what each card is holding — never `web`, never a fake link', async () => {
    const evidence = await retrieveGrounded(ABOUT_JIFFY, everything);
    const universe = groundedUniverse(ABOUT_JIFFY, evidence.records);
    const sources = groundedSourceEvents(universe);

    expect(sources.map((s) => s.kind)).toEqual(['world', 'brain', 'world']);
    // Only what was genuinely read off a page keeps an http URL. The Brain card
    // carries `path § heading`, which is a locator and not a link, and `kind`
    // is what tells the renderer not to try to open it.
    expect(sources.find((s) => s.kind === 'brain')?.url).toBe('60-business/PRICING_v3.md § Commission');
    expect(sources.every((s) => s.url.startsWith('http') || s.kind !== 'world')).toBe(true);
  });

  it('dates every card, because a June observation and today’s are not equal evidence', async () => {
    const evidence = await retrieveGrounded(ABOUT_JIFFY, everything);
    const sources = groundedSourceEvents(groundedUniverse(ABOUT_JIFFY, evidence.records));
    expect(sources.map((s) => s.observedAt)).toEqual(['2026-08-20', '2026-08-01', '2026-08-25']);
  });

  it('keeps the forecast out of the citable spans and beside the answer instead', async () => {
    const evidence = await retrieveGrounded(ABOUT_JIFFY, everything);
    const universe = groundedUniverse(ABOUT_JIFFY, evidence.records);

    // A forecast is what we expect, not something we measured. Handed to the
    // writer as a span it would be written up as a measurement and the number
    // check would confirm it, because the figure really is in the span.
    expect(universe.spans.some((s) => s.span.includes('Vancouver'))).toBe(false);
    expect(universe.expectations.map((e) => e.p)).toEqual([0.35]);
  });

  it('produces an empty universe with a stated reason when nothing matched', async () => {
    const evidence = await retrieveGrounded('How should we price snow removal?', reader());
    const universe = groundedUniverse('How should we price snow removal?', evidence.records);
    expect(universe.spans).toEqual([]);
    expect(universe.note).toMatch(/no internal records/i);
  });
});
