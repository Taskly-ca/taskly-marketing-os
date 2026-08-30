/**
 * THE GATE — what a proposal must carry to be shown at all.
 *
 * The checks are cheap and the reason they exist is not: a marketing
 * recommendation is the highest-leverage place in this system for an
 * unsupported claim to escape, because it is the output a human acts on and
 * the one least likely to be checked against a source.
 */
import { checkCausalLanguage, checkHonesty } from '@tmos/guardrails';
import type { Basis } from '@tmos/contracts';

import type { DroppedRecommendation, Evidence, Recommendation } from './types.js';

/**
 * Strip the model's own inline evidence markers before looking for figures.
 *
 * A reasoner told to cite by number writes "demand is open (22) and campus
 * moves start (24)", and every one of those markers looks exactly like an
 * unsourced integer. The first version of this check read them as claims and
 * dropped EVERY recommendation in the draft — a gate that fires on all input
 * is indistinguishable from a broken one, and it would have been read as "the
 * model produced nothing useful" rather than "the check is wrong".
 *
 * Only a parenthetical that is ENTIRELY reference — digits, separators, and
 * optionally the word evidence — is removed. "(a 20% lift)" keeps its figure,
 * because that is a claim wearing brackets.
 */
/** Ends on a digit, so a trailing comma is never swallowed into the token. */
const NUMBER_TOKEN = /\$?\d(?:[\d,]*\d)?(?:\.\d+)?%?/g;

const normaliseFigure = (raw: string): string =>
  raw.replace(/[$%]/g, '').replace(/,(?=\d{3}(?!\d))/g, '');

export const stripEvidenceRefs = (text: string): string =>
  text
    .replace(/\(\s*(?:evidence|ev\.?|refs?)?\s*\d+(?:\s*[,;&–—-]\s*\d+)*\s*\)/gi, ' ')
    // Square brackets are not an afterthought: the evidence file numbers its
    // own entries as `[22]`, so that is the form the model copies most often.
    // Handling only parentheses left the commonest case unstripped.
    .replace(/\[\s*(?:evidence|ev\.?|refs?)?\s*\d+(?:\s*[,;&–—-]\s*\d+)*\s*\]/gi, ' ');

/**
 * Figures a reader would treat as sourced.
 *
 * Bare integers under 10 are skipped for the same reason L0 skips them — "the
 * top 3 channels" is prose, and demanding a citation for it is how a gate gets
 * switched off.
 *
 * Two normalisation rules, each fixing a way this went wrong on a real draft:
 *
 *  - **A token must END in a digit.** `$49, $69 and $95` otherwise matches
 *    `"$49,"`, whose trailing comma makes `Number()` return NaN, so the figure
 *    is silently skipped — the check quietly stops checking the one case it
 *    was written for.
 *  - **A comma is a thousands separator only before exactly three digits.**
 *    Stripping commas globally fused the citation list `44,46` into `4446`,
 *    a figure appearing nowhere, reported as an invented number.
 */
function figures(text: string): string[] {
  const out: string[] = [];
  for (const m of stripEvidenceRefs(text).matchAll(NUMBER_TOKEN)) {
    const raw = m[0];
    const bare = normaliseFigure(raw);
    const n = Number(bare);
    if (!Number.isFinite(n)) continue;
    const decorated = raw.includes('$') || raw.includes('%') || raw.includes(',') || bare.includes('.');
    if (!decorated && n < 10) continue;
    out.push(bare);
  }
  return out;
}

const figuresIn = (text: string): Set<string> =>
  new Set([...text.matchAll(NUMBER_TOKEN)].map((m) => normaliseFigure(m[0])));

/**
 * The basis a set of evidence can support — derived, never asserted.
 *
 * `verified_metric` is unreachable BY CONSTRUCTION and that is the point: a
 * recommendation is an inference from evidence to an action, and no amount of
 * good evidence makes a "should" into a measurement. The strongest available is
 * `inferred_from_sources`, and it requires at least one thing actually observed
 * in the world — a competitor change or a value read off their page.
 *
 * A proposal resting only on our own calendar and our own documents is
 * `exploratory_unverified`, however sensible it sounds. Nothing outside Taskly
 * was consulted, so nothing outside Taskly is evidence for it.
 */
export function basisForEvidence(cited: readonly Evidence[]): Basis {
  const observed = cited.some((e) => e.kind === 'finding' || e.kind === 'fact');
  return observed ? 'inferred_from_sources' : 'exploratory_unverified';
}

export interface Verdict {
  readonly kept: Recommendation[];
  readonly dropped: DroppedRecommendation[];
}

export interface RawRecommendation {
  action?: unknown;
  reasoning?: unknown;
  falsifier?: unknown;
  evidence?: unknown;
  horizon?: unknown;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

export function verifyRecommendations(
  raw: readonly RawRecommendation[],
  evidence: readonly Evidence[],
): Verdict {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const kept: Recommendation[] = [];
  const dropped: DroppedRecommendation[] = [];

  for (const r of raw) {
    const action = text(r.action);
    if (action === '') continue;

    const falsifier = text(r.falsifier);
    if (falsifier === '') {
      // The ledger made `falsifier` NOT NULL for this exact reason: a proposal
      // nobody can be wrong about is astrology, and it is free to produce.
      dropped.push({ action, why: 'no falsifier — nothing that would show this was the wrong call' });
      continue;
    }

    const ids = Array.isArray(r.evidence)
      ? [...new Set(r.evidence.map(Number).filter((n) => Number.isInteger(n)))]
      : [];
    const cited = ids.map((id) => byId.get(id)).filter((e): e is Evidence => e !== undefined);

    if (cited.length === 0) {
      dropped.push({
        action,
        why: ids.length > 0
          ? `cited evidence that does not exist (${ids.join(', ')}) — invented, not retrieved`
          : 'no evidence cited',
      });
      continue;
    }

    // Everything rendered goes through the honesty boundary, including the
    // reasoning: a banned claim in an internal draft is where it enters a
    // campaign two weeks later with nobody remembering it was never checked.
    const body = `${action}\n${text(r.reasoning)}\n${falsifier}`;
    const honesty = checkHonesty(body, 'internal');
    if (!honesty.ok) {
      dropped.push({
        action,
        why: `honesty gate: ${honesty.violations.map((v) => `"${v.match}" — ${v.reason}`).join('; ')}`,
      });
      continue;
    }

    /**
     * A FIGURE IN A CLAIM MUST BE IN THE EVIDENCE IT CITES.
     *
     * Checked on `action` and `reasoning` only, and the line is deliberate:
     * those two describe the world, so a number in them is a claim. The
     * `falsifier` and `horizon` PROPOSE thresholds — "wrong if bookings stay
     * below 5%" is a target being set, not an assertion about anything, and
     * requiring a source for it would force the model to stop setting them.
     *
     * The first live draft is why this exists. It recommended listing snow
     * removal "at $49, $69 and $95" while citing a season window, a forecast
     * and a competitor fact — none of which contain a price. The figures were
     * real and came from our own validated pricing research, sitting in the
     * evidence file uncited. Right numbers, wrong citation, and completely
     * invisible to a reader who trusted the evidence links.
     */
    const cause = `${action}\n${text(r.reasoning)}`;
    const supported = figuresIn(cited.map((e) => e.text).join(' '));
    const unsourced = figures(cause).filter((n) => !supported.has(n));
    if (unsourced.length > 0) {
      dropped.push({
        action,
        why: `${unsourced.map((n) => `"${n}"`).join(', ')} appears in the recommendation but in none of the evidence it cites — cite the evidence that carries the figure, or drop it`,
      });
      continue;
    }

    // Rung 0: nothing here has a control group. "Their price cut caused the
    // drop" is unsupportable from observation alone, and the lint is the only
    // thing standing between a correlation and a sentence that reads as cause.
    const causal = checkCausalLanguage(body, 0);
    if (!causal.ok) {
      dropped.push({
        action,
        why: `causal language without a control group: ${causal.violations.map((v) => `"${v.match}"`).join(', ')}`,
      });
      continue;
    }

    kept.push({
      action,
      reasoning: text(r.reasoning),
      falsifier,
      evidence: cited.map((e) => e.id),
      horizon: text(r.horizon) || 'unstated',
      basis: basisForEvidence(cited),
    });
  }

  // Observed-world proposals first. Not a score — an ordering by what the
  // recommendation rests on, which is the only ranking we can defend.
  kept.sort((a, b) => {
    const rank = (x: Recommendation): number => (x.basis === 'inferred_from_sources' ? 0 : 1);
    return rank(a) - rank(b);
  });

  return { kept, dropped };
}
