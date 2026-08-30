/**
 * The grounded universe — selection over stored evidence, with no model and no
 * database anywhere in the file.
 *
 * Every case here is a record that LOOKS citable. That is the point: by the
 * time prose is streaming with a `[3]` on it, nobody re-opens the ledger row.
 * A draft Brain note, a superseded finding, a forecast, a June price — each
 * reads as perfectly good evidence to a human skimming the output, and each is
 * refused or labelled here, while it is still a field on an object.
 */
import { describe, expect, it } from 'vitest';

import type { CitableUniverse } from './attribute.js';
import { DEFAULT_ATTRIBUTE_LIMITS } from './attribute.js';
import {
  bindGrounded,
  groundedDocs,
  groundedSourceEvents,
  groundedSpanBlock,
  groundedSpanEvents,
  groundedUniverse,
} from './grounded.js';
import { checkSentence } from './stream.js';
import type {
  GroundedBrainPassage,
  GroundedFinding,
  GroundedForecast,
  GroundedRecord,
  GroundedWorldFact,
} from './grounded.js';

const JUNE = '2026-06-01T00:00:00.000Z';
const TODAY = '2026-08-31T00:00:00.000Z';

const fact = (over: Partial<GroundedWorldFact> = {}): GroundedWorldFact => ({
  type: 'world_fact',
  id: 'f1',
  title: 'Jiffy — visit rate',
  url: 'https://jiffyondemand.com/pricing',
  snippet: 'Their standard rate is $89 per visit for 2 hours.',
  observedAt: TODAY,
  ...over,
});

const finding = (over: Partial<GroundedFinding> = {}): GroundedFinding => ({
  type: 'finding',
  id: 'n1',
  title: 'TaskRabbit service fee',
  sourceUrl: 'https://taskrabbit.ca/fees',
  span: 'TaskRabbit charges a 15% service fee on every booking in Canada.',
  observedAt: JUNE,
  ...over,
});

const passage = (over: Partial<GroundedBrainPassage> = {}): GroundedBrainPassage => ({
  type: 'brain_passage',
  id: 'b1',
  title: 'PRICING_v3',
  path: '60-business/pricing/PRICING_v3.md',
  heading: 'Commission',
  text: 'Taskly keeps 20% of the agreed deal. The rate is HST-inclusive.',
  right: 'grounds',
  reviewed: '2026-08-02',
  ...over,
});

const forecast = (over: Partial<GroundedForecast> = {}): GroundedForecast => ({
  type: 'forecast',
  id: 'p1',
  title: 'Jiffy category count',
  locator: 'prediction:p1',
  claim: "Jiffy's category count exceeds 40 on 2026-11-01.",
  p: 0.65,
  resolveAt: '2026-11-01T00:00:00.000Z',
  ...over,
});

describe('bindGrounded — selection, not attribution', () => {
  it('numbers stored spans straight out of the records, with no model call', () => {
    const r = bindGrounded([fact(), finding(), passage()]);

    expect(r.dropped).toEqual([]);
    expect(r.spans.map((s) => s.id)).toEqual([1, 2, 3]);
    expect(r.spans[0]?.span).toBe('Their standard rate is $89 per visit for 2 hours.');
    expect(r.spans[1]?.span).toBe(
      'TaskRabbit charges a 15% service fee on every booking in Canada.',
    );
    // The chunk body IS the span when the caller narrowed nothing.
    expect(r.spans[2]?.span).toBe('Taskly keeps 20% of the agreed deal. The rate is HST-inclusive.');
  });

  it('carries the SourceKind that tells a reader what they are holding', () => {
    const r = bindGrounded([fact(), finding(), passage()]);
    expect(r.spans.map((s) => s.kind)).toEqual(['world', 'world', 'brain']);
  });

  it('keeps the caller’s retrieval order — it never re-ranks by date', () => {
    // The June record is first because the caller's retrieval put it first.
    // Promoting the fresher one would be this module overruling relevance with
    // a freshness policy nobody has set.
    const r = bindGrounded([finding(), fact()]);
    expect(r.spans.map((s) => s.observedAt)).toEqual([JUNE, TODAY]);
  });

  it('refuses a record whose stored evidence is empty', () => {
    const r = bindGrounded([fact({ snippet: '   ' })]);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/no stored evidence/);
  });

  it('refuses a span under the 12-character floor the web path uses', () => {
    const r = bindGrounded([fact({ snippet: '$89 a visit' })]);
    expect(DEFAULT_ATTRIBUTE_LIMITS.minSpanChars).toBe(12);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/too short to be evidence/);
  });

  it('refuses an over-long passage instead of trimming it, and says how to fix it', () => {
    const long = `${'Taskly keeps twenty percent of the agreed deal. '.repeat(12)}`;
    const r = bindGrounded([passage({ text: long })]);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/narrower span/);
  });

  it('checks a narrowed Brain span against the chunk it claims to come from', () => {
    const good = bindGrounded([
      passage({ span: 'Taskly keeps 20% of the agreed deal.' }),
    ]);
    expect(good.spans[0]?.span).toBe('Taskly keeps 20% of the agreed deal.');

    const bad = bindGrounded([
      passage({ span: 'Taskly keeps 25% of the agreed deal.' }),
    ]);
    expect(bad.spans).toEqual([]);
    expect(bad.dropped[0]?.why).toMatch(/does not appear in the passage/);
  });

  it('matches a narrowed span across a line wrap, because whitespace is normalised', () => {
    const r = bindGrounded([
      passage({
        text: 'Taskly keeps 20% of\n   the agreed deal. The rate is HST-inclusive.',
        span: 'Taskly keeps 20% of the agreed deal.',
      }),
    ]);
    expect(r.spans).toHaveLength(1);
  });

  it('refuses a draft Brain document — context_only may never be cited', () => {
    const r = bindGrounded([passage({ right: 'context_only' })]);
    expect(r.spans).toEqual([]);
    expect(r.dropped[0]?.why).toMatch(/unreviewed thinking|may not be cited/);
  });

  it('refuses a superseded document and a superseded finding', () => {
    const r = bindGrounded([
      passage({ right: 'never_retrieved' }),
      finding({ superseded: true }),
    ]);
    expect(r.spans).toEqual([]);
    expect(r.dropped).toHaveLength(2);
    expect(r.dropped[1]?.why).toMatch(/superseded/);
  });

  it('admits a corroborating passage — it is weaker evidence, not absent evidence', () => {
    const r = bindGrounded([passage({ right: 'corroborates' })]);
    expect(r.spans).toHaveLength(1);
  });

  it('drops the same span from the same locator twice, and keeps corroboration', () => {
    const dup = bindGrounded([fact(), fact({ id: 'f2' })]);
    expect(dup.spans).toHaveLength(1);
    expect(dup.dropped[0]?.why).toMatch(/already in the universe/);

    const two = bindGrounded([
      fact(),
      fact({
        id: 'f3',
        url: 'https://example.com/mirror',
      }),
    ]);
    expect(two.spans).toHaveLength(2);
  });

  it('caps the universe, and a refused record never consumes a slot', () => {
    const many: GroundedRecord[] = [];
    for (let i = 0; i < 30; i += 1) {
      many.push(fact({ id: `f${i}`, snippet: `Their standard rate is $${i}00 per visit.` }));
    }
    const r = bindGrounded(many, { ...DEFAULT_ATTRIBUTE_LIMITS, maxSpans: 3 });
    expect(r.spans).toHaveLength(3);
    expect(r.dropped.every((d) => /capped at 3/.test(d.why))).toBe(true);
  });
});

describe('staleness is carried, never hidden', () => {
  it('keeps a June observation and stamps it with its own date', () => {
    const r = bindGrounded([finding()]);
    expect(r.spans[0]?.observedAt).toBe(JUNE);
    expect(r.sources[0]?.observedAt).toBe(JUNE);
  });

  it('splits one locator into two sources when it was observed on two dates', () => {
    // A page read in June and the same page read today are two observations.
    // Collapsing them would put ONE date on evidence that has two, and the wire
    // contract carries the date on the source card, not on the span event.
    const r = bindGrounded([
      fact({ snippet: 'Their standard rate is $79 per visit for 2 hours.', observedAt: JUNE }),
      fact({ id: 'f2', snippet: 'Their standard rate is $89 per visit for 2 hours.' }),
    ]);
    expect(r.sources).toHaveLength(2);
    expect(r.sources.map((s) => s.observedAt)).toEqual([JUNE, TODAY]);
    expect(r.spans.map((s) => s.docIndex)).toEqual([1, 2]);
  });

  it('gives two spans off one observation a single source card', () => {
    const r = bindGrounded([
      fact(),
      fact({ id: 'f2', snippet: 'Jiffy operates in Toronto and Ottawa.' }),
    ]);
    expect(r.sources).toHaveLength(1);
    expect(r.spans.map((s) => s.docIndex)).toEqual([1, 1]);
  });
});

describe('a forecast is not an observation', () => {
  it('never enters the spans, and is listed as an expectation instead', () => {
    const r = bindGrounded([fact(), forecast()]);
    expect(r.spans).toHaveLength(1);
    expect(r.spans.every((s) => s.kind !== 'ledger')).toBe(true);
    expect(r.expectations).toEqual([
      {
        id: 'p1',
        locator: 'prediction:p1',
        title: 'Jiffy category count',
        claim: "Jiffy's category count exceeds 40 on 2026-11-01.",
        p: 0.65,
        resolveAt: '2026-11-01T00:00:00.000Z',
      },
    ]);
  });

  it('is not a dropped span either — it never failed a check, it is a different thing', () => {
    const r = bindGrounded([forecast()]);
    expect(r.dropped).toEqual([]);
  });

  it('keeps forecast text out of the block handed to the writer', () => {
    const u = groundedUniverse('what do we know about Jiffy?', [fact(), forecast()]);
    const block = groundedSpanBlock(u);
    expect(block).toContain('$89 per visit');
    expect(block).not.toContain('exceeds 40');
    expect(block).not.toContain('0.65');
  });
});

describe('groundedUniverse — a CitableUniverse phase B can consume unchanged', () => {
  it('costs nothing, because no model was asked anything', () => {
    const u = groundedUniverse('what do we charge?', [passage()]);
    expect(u.costCents).toBe(0);
    expect(u.question).toBe('what do we charge?');
    expect(u.note).toBe('');
  });

  it('says so plainly when the caller retrieved nothing', () => {
    const u = groundedUniverse('what do we know about Acme?', []);
    expect(u.spans).toEqual([]);
    expect(u.note).toMatch(/no internal records/);
  });

  it('says so plainly when records matched but none could be quoted', () => {
    const u = groundedUniverse('q', [passage({ right: 'context_only' })]);
    expect(u.spans).toEqual([]);
    expect(u.note).toMatch(/carried nothing quotable/);
  });

  it('names the expectations when they are all that survived', () => {
    const u = groundedUniverse('will Jiffy grow?', [forecast()]);
    expect(u.spans).toEqual([]);
    expect(u.note).toMatch(/expect/i);
  });
});

describe('projections — what the streaming phases consume', () => {
  const u = groundedUniverse('q', [fact(), passage()]);

  it('projects one ReadDoc per source, in span-index order', () => {
    const docs = groundedDocs(u);
    expect(docs).toHaveLength(2);
    expect(docs[0]?.url).toBe('https://jiffyondemand.com/pricing');
    // A Brain locator is not a link, and is not dressed up as one.
    expect(docs[1]?.url).toBe('60-business/pricing/PRICING_v3.md § Commission');
    // Every span resolves to the doc it names.
    for (const s of u.spans) expect(docs[s.docIndex - 1]?.title).toBeTruthy();
  });

  it('emits source events carrying kind and the observation date', () => {
    const events = groundedSourceEvents(u);
    expect(events[0]).toMatchObject({ i: 1, kind: 'world', domain: 'jiffyondemand.com' });
    expect(events[0]?.observedAt).toBe(TODAY);
    expect(events[1]).toMatchObject({ i: 2, kind: 'brain', domain: 'brain' });
  });

  it('emits span events matching the wire contract', () => {
    expect(groundedSpanEvents(u)[0]).toEqual({
      id: 1,
      sourceIndex: 1,
      quote: 'Their standard rate is $89 per visit for 2 hours.',
    });
  });

  it('builds a span block with no dates in it', () => {
    // A date in the block invites "as of June 2026", whose "2026" is in no
    // cited span — phase C would flag a sentence for repeating what we told it.
    const block = groundedSpanBlock(u);
    expect(block).toContain('[1] (source 1 — Jiffy — visit rate)');
    expect(block).not.toContain('2026-08-31');
  });
});

describe('phase B and phase C consume it unchanged — the point of the design', () => {
  // If any of these stop compiling or passing, the grounded path has become a
  // second pipeline, which is the outcome the shared shapes exist to prevent.
  const u = groundedUniverse('what do we charge?', [fact(), passage()]);

  it('is a CitableUniverse, so nothing downstream needs a grounded variant', () => {
    const asWeb: CitableUniverse = u;
    expect(asWeb.spans[0]?.span).toBe(u.spans[0]?.span);
  });

  it('confirms a sentence whose figure is in the grounded span it cites', () => {
    expect(checkSentence(0, 'Their standard rate is $89 per visit [1].', u.spans)).toEqual({
      n: 0,
      verdict: 'confirmed',
    });
  });

  it('flags a figure that is in no grounded span — a stored span is not a licence', () => {
    const v = checkSentence(0, 'Their standard rate is $120 per visit [1].', u.spans);
    expect(v.verdict).toBe('flagged');
    expect(v.why).toMatch(/"120"/);
  });

  it('flags a marker pointing past the end of the grounded universe', () => {
    const v = checkSentence(0, 'Taskly keeps 20% of the agreed deal [9].', u.spans);
    expect(v.verdict).toBe('flagged');
    expect(v.why).toMatch(/\[9\]/);
  });
});
