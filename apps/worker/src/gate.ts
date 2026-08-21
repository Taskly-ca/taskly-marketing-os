/**
 * T0 — the gate, assembled.
 *
 * Every piece here already existed and none of them had ever been run in
 * sequence against real volume: `canonicalizeUrl` and `urlHash` from
 * `@tmos/gate`, `simhash`/`hammingDistance`/`NEAR_DUP_THRESHOLD` from the same
 * package, and `checkHost`/`stripPii`/`containsPii` from the collectors'
 * policy module. This file is the ORDER, the memory of what we have already
 * seen, and nothing else — it deliberately implements no new dedup or policy
 * logic of its own, because a second opinion about what a duplicate is would be
 * a second threshold to keep calibrated.
 *
 * The order is fixed by cost, cheapest first, so the expensive comparison never
 * runs on an item a free check would have dropped:
 *
 *   1. host policy      string compare against the never-scrape list
 *   2. canonical URL    parse + normalise, then exact-match against what we hold
 *   3. content hash     sha256 of the text, exact-match
 *   4. SimHash          64-bit signature, Hamming ≤ 8 against a recent window
 *
 * PII is not a drop. `stripPii` runs inside every collector already; this is the
 * second pass that catches anything a collector assembled AFTER stripping (a
 * title concatenated with a body, a field a collector forgot). Dropping the item
 * would throw away the aggregate signal we collect for; redacting keeps it. The
 * count is reported, because a rising number means a collector has a hole.
 *
 * WHAT THIS DOES NOT DO: the statistical detectors and BH-FDR (2.11–2.14) are
 * also T0 and also in `@tmos/gate`, but they score a TIME SERIES, not an item —
 * they need a baseline this system has not accumulated yet. Running them on the
 * first two passes of an empty database would produce z-scores against a sample
 * of one. They belong to the pass that has history behind it; see the report.
 */
import { createHash } from 'node:crypto';

import { checkHost, containsPii, stripPii, type RawItem } from '@tmos/collectors';
import { canonicalizeUrl, hammingDistance, NEAR_DUP_THRESHOLD, simhash } from '@tmos/gate';

/** Why an item did not survive. One string per stage, so the report is a histogram. */
type DropReason =
  | 'banned_host'
  | 'unusable_url'
  | 'empty_content'
  | 'duplicate_url'
  | 'duplicate_content'
  | 'near_duplicate';

export interface GatedItem {
  readonly item: RawItem;
  readonly canonicalUrl: string | null;
  readonly contentHash: string;
  /** 64-bit signature as a decimal string — bigint-safe both directions. */
  readonly simhash: string;
  /** True when this pass had to redact something the collector left in. */
  readonly piiRedacted: boolean;
}

export interface Dropped {
  readonly externalId: string;
  readonly reason: DropReason;
  readonly detail: string;
}

export interface GateOutcome {
  readonly kept: GatedItem[];
  readonly dropped: Dropped[];
}

/**
 * What we already hold. MUTATED as the gate runs, so an item is compared
 * against both the database's history and everything kept earlier in the same
 * pass — the two feeds that both carry one wire story arrive minutes apart in
 * the same run, and a memory that only knew about committed rows would let the
 * second one through.
 */
export interface SeenContent {
  readonly contentHashes: Set<string>;
  readonly canonicalUrls: Set<string>;
  /** Recent signatures, newest first. Scanned linearly — see `isNearDuplicate`. */
  readonly signatures: string[];
}

export const emptySeen = (): SeenContent => ({
  contentHashes: new Set(),
  canonicalUrls: new Set(),
  signatures: [],
});

/** The text an item IS, for hashing and for near-dup. Title carries most of the
 *  signal in a headline-only source, so it is part of the identity. */
function contentOf(item: RawItem): string {
  return `${item.title ?? ''}\n${item.body}`.trim();
}

export function contentHashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

/**
 * A LINEAR scan over the recent window, on purpose.
 *
 * The proper structure is a banded index on the signature, and at millions of
 * rows it would be required. At the volume this system actually runs — hundreds
 * of items against a window of a few thousand — a bigint XOR and a popcount per
 * pair is faster than maintaining the index, and it cannot go subtly wrong the
 * way a band that drops a candidate can. The window is what bounds it; see
 * `NEAR_DUP_WINDOW_DAYS` in the store.
 */
function nearestSignature(sig: string, signatures: readonly string[]): { at: string; distance: number } | null {
  let best: { at: string; distance: number } | null = null;
  for (const other of signatures) {
    const distance = hammingDistance(sig, other);
    if (best === null || distance < best.distance) best = { at: other, distance };
    if (distance === 0) break;
  }
  return best;
}

export function runGate(items: readonly RawItem[], seen: SeenContent): GateOutcome {
  const kept: GatedItem[] = [];
  const dropped: Dropped[] = [];
  const drop = (item: RawItem, reason: DropReason, detail: string): void => {
    dropped.push({ externalId: item.externalId, reason, detail });
  };

  for (const item of items) {
    // 1. Host policy. Liability follows the data: an aggregator handing us a
    //    link to a never-scrape host does not make it collectable.
    if (item.url !== null) {
      const verdict = checkHost(item.url);
      if (!verdict.allowed) {
        drop(item, 'banned_host', verdict.reason);
        continue;
      }
    }

    // 2. Canonical URL. A url we cannot parse is a url we cannot dedup on, and
    //    an item we cannot dedup on will be re-ingested forever.
    const canonicalUrl = item.url === null ? null : canonicalizeUrl(item.url);
    if (item.url !== null && canonicalUrl === null) {
      drop(item, 'unusable_url', `not an http(s) url: ${item.url}`);
      continue;
    }

    const raw = contentOf(item);
    if (raw.length === 0) {
      drop(item, 'empty_content', 'no title and no body');
      continue;
    }

    const piiRedacted = containsPii(raw);
    const text = piiRedacted ? stripPii(raw) : raw;

    // 3. Exact content. Cheapest of the two dedup stages and the one that fires
    //    on the second pass of an unchanged feed.
    const contentHash = contentHashOf(text);
    if (seen.contentHashes.has(contentHash)) {
      drop(item, 'duplicate_content', `content hash ${contentHash} already held`);
      continue;
    }
    if (canonicalUrl !== null && seen.canonicalUrls.has(canonicalUrl)) {
      drop(item, 'duplicate_url', `canonical url already held: ${canonicalUrl}`);
      continue;
    }

    // 4. Near-duplicate. Same story, different wrapper.
    const sig = simhash(text);
    const nearest = nearestSignature(sig, seen.signatures);
    if (nearest !== null && nearest.distance <= NEAR_DUP_THRESHOLD) {
      drop(item, 'near_duplicate', `hamming ${nearest.distance} <= ${NEAR_DUP_THRESHOLD}`);
      continue;
    }

    seen.contentHashes.add(contentHash);
    if (canonicalUrl !== null) seen.canonicalUrls.add(canonicalUrl);
    seen.signatures.push(sig);
    kept.push({
      item: piiRedacted ? { ...item, title: item.title === null ? null : stripPii(item.title), body: stripPii(item.body) } : item,
      canonicalUrl,
      contentHash,
      simhash: sig,
      piiRedacted,
    });
  }

  return { kept, dropped };
}

/** The drop histogram the report prints. */
export function dropHistogram(dropped: readonly Dropped[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of dropped) out[d.reason] = (out[d.reason] ?? 0) + 1;
  return out;
}
