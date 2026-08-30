/**
 * WHAT SURVIVES — the gate between a model's answer and something you can act on.
 *
 * Three checks, in cost order, and each exists because of a specific way a
 * research answer goes wrong:
 *
 *  1. **The citation must name a document this run fetched.** This is L0's
 *     retrieval ledger, applied here for the same reason it exists there: a
 *     model asked for sources will invent plausible ones, and a URL that was
 *     never retrieved is the signature of an answer assembled from memory
 *     rather than from reading. (TMOS has already been bitten by the mirror
 *     image of this — the watcher cited a sitemap it HAD fetched and L0 refused
 *     it, because nothing told L0 about the fetch. Both directions are the same
 *     bug: the ledger must describe reality.)
 *
 *  2. **The span must actually appear in that document.** A model that has read
 *     a page will still paraphrase a quote and present it as one. Checking is
 *     cheap and the alternative is a citation that looks verifiable and is not.
 *
 *  3. **Every number in the claim must appear in some cited span.** Derived
 *     figures are where a research answer does its real damage: "the GTA
 *     home-services market is worth $2.1B" is actionable, unfalsifiable at a
 *     glance, and frequently invented.
 *
 * Whitespace is normalised before comparison and nothing else is. Case is kept
 * because a quote that differs in case differs, and lowering it would let a
 * headline masquerade as body text.
 */
import { checkHonesty } from '@tmos/guardrails';

import type { Citation, Dropped, Point, ReadDoc } from './types.js';

/** Collapse runs of whitespace so a line-wrapped quote still matches its page. */
export const normalise = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * Numbers a reader would treat as a fact, the way L0 counts them.
 *
 * Bare integers under 10 are deliberately NOT checked — demanding that "the top
 * 3 reasons" appear verbatim in a span is the fastest way to get a gate
 * ignored, and L0 made exactly this call with `BARE_INTEGER_FLOOR`.
 */
export function claimNumbers(claim: string): string[] {
  const out: string[] = [];
  const re = /\$?\d[\d,]*\.?\d*%?/g;
  for (const m of claim.matchAll(re)) {
    const raw = m[0];
    const bare = raw.replace(/[$,%]/g, '');
    const n = Number(bare);
    if (!Number.isFinite(n)) continue;
    const decorated = raw.includes('$') || raw.includes('%') || raw.includes(',') || bare.includes('.');
    if (!decorated && n < 10) continue;
    out.push(bare);
  }
  return out;
}

const numbersIn = (text: string): Set<string> => {
  const s = new Set<string>();
  for (const m of text.matchAll(/\$?\d[\d,]*\.?\d*%?/g)) {
    s.add(m[0].replace(/[$,%]/g, ''));
  }
  return s;
};

export interface Verdict {
  readonly kept: Point[];
  readonly dropped: Dropped[];
}

/**
 * Keep only the points the retrieved documents can carry.
 *
 * A dropped point is REPORTED, never silently removed: the reader needs to see
 * that the model asserted something the evidence did not support, both because
 * it is the honest record and because a run that drops most of its points is
 * telling you the sources were wrong, not that the topic is empty.
 */
export function verifyPoints(points: readonly Point[], docs: readonly ReadDoc[]): Verdict {
  const byUrl = new Map(docs.map((d) => [d.url, normalise(d.text)]));
  const kept: Point[] = [];
  const dropped: Dropped[] = [];

  for (const p of points) {
    const claim = p.claim.trim();
    if (claim === '') continue;

    if (p.citations.length === 0) {
      dropped.push({ claim, why: 'no source cited' });
      continue;
    }

    const good: Citation[] = [];
    let fault: string | null = null;

    for (const c of p.citations) {
      const doc = byUrl.get(c.url);
      if (doc === undefined) {
        fault ??= `cited a page this run never retrieved: ${c.url}`;
        continue;
      }
      const span = normalise(c.span);
      if (span.length < 12) {
        fault ??= 'the cited span is too short to be evidence';
        continue;
      }
      if (!doc.includes(span)) {
        fault ??= `the quoted span does not appear on ${c.url} — paraphrased, not quoted`;
        continue;
      }
      good.push({ url: c.url, span });
    }

    if (good.length === 0) {
      dropped.push({ claim, why: fault ?? 'no usable citation' });
      continue;
    }

    const spanNums = numbersIn(good.map((c) => c.span).join(' '));
    const missing = claimNumbers(claim).filter((n) => !spanNums.has(n));
    if (missing.length > 0) {
      dropped.push({
        claim,
        why: `${missing.map((m) => `"${m}"`).join(', ')} appears in the claim but in no cited span — derived or invented, either way it is not quoted`,
      });
      continue;
    }

    // The honesty boundary is legal, not stylistic, and it applies to anything
    // this system generates — including an internal research memo, because a
    // banned phrase in a memo is where the phrase enters a campaign later.
    const honesty = checkHonesty(claim, 'internal');
    if (!honesty.ok) {
      dropped.push({
        claim,
        why: `honesty gate: ${honesty.violations.map((v) => `"${v.match}" — ${v.reason}`).join('; ')}`,
      });
      continue;
    }

    kept.push({ claim, citations: good });
  }

  return { kept, dropped };
}
