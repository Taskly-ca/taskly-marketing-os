/**
 * THE DOMAIN PACK SEAM.
 *
 * The architecture's claim for Part 10 is testable and worth testing: a second
 * domain should be addable "with **zero core changes**". Until now that claim
 * was unfalsifiable, because there was no seam — the sources, the competitors,
 * the measures and the geography were spread across three files in
 * `apps/worker` and one in `packages/reason`, and "add a domain" meant editing
 * all four.
 *
 * A pack is the answer to four questions, and nothing else:
 *
 *   WHERE DO WE LOOK?        `sources` — feeds and APIs, with the question each
 *                            one is FOR, because a source with no question is a
 *                            source nobody can decide to drop.
 *   WHAT DO WE WATCH?        `targets` — documents read on a fixed instrument.
 *   WHAT COUNTS AS RELEVANT? `scoring` — the geography and the named rivals.
 *   WHO ARE WE?              `id`, `region`, and the sentence that goes in a
 *                            prompt, so a triage model knows whose interests it
 *                            is scoring against.
 *
 * WHAT A PACK MAY NOT DO is as important. It carries no gates, no thresholds,
 * no model choice and no honesty rules. Those are the core's, and a pack that
 * could relax one would make "zero core changes" true by making the core
 * meaningless — a domain could ship a claim the denylist forbids simply by
 * declaring it. The seam is deliberately narrow enough that a bad pack produces
 * bad COVERAGE and never an unsafe claim.
 */
import type { Collector } from '@tmos/collectors';
import type { Region } from '@tmos/contracts';
import type { GeoCorridor } from '@tmos/reason';

/** `source.tier` — the rubric dimension that stops an agent preferring a farm. */
export type SourceTier = 'first_party' | 'primary' | 'trade' | 'aggregator' | 'farm';

export interface PackSource {
  readonly collector: Collector;
  readonly tier: SourceTier;
  readonly region: Region;
  /** The question this source is FOR — not the terms it uses. */
  readonly question: string;
}

/**
 * The one word a `quoted` measure may answer without quoting anything.
 *
 * "The page shows no price" is a real answer and there is no span for the
 * absence of a thing. Named, and the only exemption.
 */
export const UNSTATED = 'unstated';

/** How a measure's answer relates to the document it was read from. */
export type AnswerKind = 'bounded' | 'quoted' | 'open' | 'measured';

export interface Measure {
  readonly predicate: string;
  readonly datatype: 'num' | 'text';
  readonly unit: string | null;
  /** Asked verbatim. Must have one answer the document either states or does not. */
  readonly question: string;
  readonly answer: AnswerKind;
  /** `bounded` only: the complete answer set, lower-case. */
  readonly allowed?: readonly string[];
}

export interface WatchTarget {
  /** Display name, and the entity we resolve against. */
  readonly company: string;
  /** The registrable domain — the hard identity key, so an exact match
   *  auto-merges with no scoring at all. */
  readonly domain: string;
  readonly url: string;
  /** What this page is being read FOR. Goes in the prompt. */
  readonly reading_for: string;
  readonly measures: readonly Measure[];
  /** A sitemap worth reading, when the target publishes one that enumerates
   *  what it offers. Optional because most do not. */
  readonly sitemap?: { readonly url: string; readonly prefix: string };
}

/**
 * A recurring window this domain's demand actually moves in.
 *
 * Seasonality is domain data, not a gate — which is the test for whether it
 * belongs in a pack. GTA snow removal and Indian monsoon prep are the same
 * SHAPE and share no content, so hardcoding either in the core would be the
 * thing Part 10 exists to prevent. The `platform` pack declares none, and that
 * is the proof the field is genuinely optional rather than Canada with a
 * default.
 *
 * WHAT A WINDOW IS NOT: evidence that anything happened. A calendar entry is
 * something we wrote down, so a recommendation resting only on one can never
 * rise above `exploratory_unverified`. It is a REASON TO LOOK, and the draft
 * treats it that way.
 */
export interface SeasonWindow {
  /** What people buy. Reads inside a sentence: "demand for <name> opens…". */
  readonly name: string;
  /** Inclusive month numbers, 1–12. `starts > ends` wraps the new year. */
  readonly startsMonth: number;
  readonly endsMonth: number;
  /** How many weeks BEFORE the window supply has to be in place. Recruiting a
   *  snow crew the week it snows is the mistake this number exists to name. */
  readonly leadWeeks: number;
  /** Why this window matters here, in the words that go in a draft. */
  readonly why: string;
}

export interface PackScoring {
  readonly corridor: GeoCorridor;
  /** Named rivals. A weak signal alone — a farm naming one is still a farm. */
  readonly competitors: readonly string[];
}

export interface DomainPack {
  /** Stable key. Selects the pack on the command line and labels its rows. */
  readonly id: string;
  readonly region: Region;
  /**
   * One sentence naming whose interests a triage model is scoring against.
   *
   * Interpolated into prompts, which is why it is a plain declarative sentence
   * and not a persona: a persona changes the voice and leaves the criteria
   * unchanged, which is the failure mode MAST calls a specification issue.
   */
  readonly subject: string;
  readonly sources: readonly PackSource[];
  readonly targets: readonly WatchTarget[];
  readonly scoring: PackScoring;
  /** Recurring demand windows. Absent for a domain that has none — the
   *  `platform` pack watches services, and services have no season. */
  readonly calendar?: readonly SeasonWindow[];
}

/** True when a change in this measure may be published as a Finding. */
export const publishes = (m: Measure): boolean => m.answer === 'bounded' || m.answer === 'quoted';
