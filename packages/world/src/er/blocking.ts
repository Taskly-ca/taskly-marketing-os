/**
 * Trigram blocking + the weighted pair scorer — the scored path of ER.
 *
 * Two stages, and conflating them is the usual mistake:
 *
 *   BLOCKING — cheap, recall-oriented, runs over the whole pool. A pair that is
 *              never blocked can never be matched, so a miss here is
 *              UNRECOVERABLE, while a false candidate costs one scoring pass.
 *              That asymmetry is the entire justification for a low threshold.
 *   SCORING  — expensive-ish, precision-oriented, runs only on candidates.
 *
 * `trigrams`/`trigramSimilarity` mirror `pg_trgm` exactly, so the SQL blocker is
 * a mechanical translation of this file rather than a second implementation
 * that drifts. Everything below runs only when `identityVerdict` returned
 * `{decision:'score'}` — hard keys auto-merge BEFORE any of this.
 */
import { identityVerdict, mayFuzzyMatch } from '../identity.js';
import type { HardKey, NormalizedName } from '../identity.js';

/** The record shape the whole `er/` directory scores over. */
export interface ErRecord {
  id: string;
  name: NormalizedName;
  /** Coarse geography ('toronto', 'gta', 'mississauga'). Compared case-folded. */
  region?: string | null;
  keys?: readonly HardKey[];
}

/* ── pg_trgm ─────────────────────────────────────────────────────────────── */

/**
 * `pg_trgm` semantics, padding included.
 *
 * Lowercase, every non-alphanumeric run is a separator, and each WORD is padded
 * with **two leading spaces and one trailing space** before 3-char windows are
 * taken: `cat` → `"  cat "` → `{"  c", " ca", "cat", "at "}`. A word of length
 * L yields exactly L+1 trigrams.
 *
 * The padding is not cosmetic — it is what makes prefixes and suffixes count as
 * evidence. Without it a 3-letter word produces one trigram and matches
 * everything containing it. Get the padding wrong and every number downstream
 * is wrong.
 *
 * Deviation from Postgres: word chars are `\p{L}\p{N}`, not ASCII alnum.
 * `pg_trgm`'s `t_isalpha` is locale-aware, so this is the closer mirror and it
 * keeps transliterated names from shattering into single letters.
 */
export function trigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (const word of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (!word) continue;
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/**
 * `pg_trgm`'s `similarity()`: |intersection| / |union| over the trigram SETS.
 * Postgres computes it as `count / (len1 + len2 - count)`, which is the same
 * thing. Two empty strings return 0 rather than NaN — an empty name is missing
 * data, never a perfect match.
 */
export function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  const union = ta.size + tb.size - shared;
  return union > 0 ? shared / union : 0;
}

/**
 * Candidate-generation cutoff. Deliberately BELOW `pg_trgm`'s default
 * `similarity_threshold` of 0.3.
 *
 * At 0.3, `jiffy lube` vs `jiffy on demand` scores 0.286 and is dropped — which
 * happens to be the right answer, but only by luck: the same 0.014 of headroom
 * also drops real variants. Blocking is not allowed to be right by luck. We buy
 * recall at 0.25 and let the scorer, which has more signals, do the rejecting.
 *
 * The SQL translation must therefore `set pg_trgm.similarity_threshold = 0.25`
 * for the session, because the `%` operator reads that GUC, not a literal.
 */
export const BLOCK_THRESHOLD = 0.25;

export interface BlockCandidate {
  id: string;
  similarity: number;
}

export interface BlockOptions {
  threshold?: number;
  /** Top-N cap AFTER sorting. A cap is a recall risk; leave it unset by default. */
  limit?: number;
}

/**
 * Candidates for `target` from `pool`, above the block threshold, best first.
 *
 * Pairs that can never be fuzzy-matched (protected brand, too-short name) are
 * skipped — they are settled by exact equality or a hard key upstream in
 * `identityVerdict`, so emitting them here would only produce candidates the
 * scorer is required to refuse. This is the fuzzy path only; callers must run
 * the exact/hard-key pass first. Ties break on id, so output is stable.
 */
export function blockCandidates(
  target: ErRecord,
  pool: readonly ErRecord[],
  opts: BlockOptions = {},
): BlockCandidate[] {
  const threshold = opts.threshold ?? BLOCK_THRESHOLD;
  const out: BlockCandidate[] = [];
  for (const rec of pool) {
    if (rec.id === target.id) continue;
    if (!mayFuzzyMatch(target.name, rec.name)) continue;
    const similarity = trigramSimilarity(target.name.norm, rec.name.norm);
    if (similarity >= threshold) out.push({ id: rec.id, similarity });
  }
  out.sort((a, b) => b.similarity - a.similarity || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return opts.limit === undefined ? out : out.slice(0, opts.limit);
}

/* ── IDF ─────────────────────────────────────────────────────────────────── */

const tokensOf = (n: NormalizedName): string[] => n.norm.split(' ').filter(Boolean);

export interface TokenIdf {
  readonly docCount: number;
  idf(token: string): number;
}

/**
 * Inverse document frequency over the pool's names. A shared token is only as
 * strong as it is rare: two GTA listings sharing `services` share nothing, two
 * sharing `zamboni` are almost certainly the same business. Smoothed as
 * `ln((N+1)/(df+1)) + 1`, so every idf is ≥ 1 and an unseen token cannot
 * divide by zero.
 */
export function buildTokenIdf(names: readonly NormalizedName[]): TokenIdf {
  const df = new Map<string, number>();
  for (const n of names) {
    for (const t of new Set(tokensOf(n))) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const total = names.length;
  return {
    docCount: total,
    idf: (token: string) => Math.log((total + 1) / ((df.get(token) ?? 0) + 1)) + 1,
  };
}

/** No pool: every token weighs the same, so the rare-token signal degrades to
 *  plain token coverage instead of silently disappearing. */
export const UNIFORM_IDF: TokenIdf = { docCount: 0, idf: () => 1 };

/* ── scoring ─────────────────────────────────────────────────────────────── */

export interface Signal {
  name: string;
  /** The raw measurement, so a reviewer can see what was observed. */
  value: number;
  /** Log-odds added to the running total. Negative = evidence AGAINST a match. */
  contribution: number;
  detail: string;
}

export type Band = 'reject' | 'adjudicate' | 'merge';

export interface PairScore {
  left: string;
  right: string;
  /** 0..1. NOT a calibrated probability until `labels.ts` says it is. */
  score: number;
  band: Band;
  /** False when the score came from an identity verdict, not from similarity. */
  scorable: boolean;
  signals: Signal[];
}

/**
 * Band edges. CALIBRATION STARTING POINTS, not validated thresholds — nothing
 * here was fitted to labelled data, because there is none yet. `labels.ts`
 * exists to replace them: it measures precision at each candidate cutoff and
 * suggests the one that hits the target on this pool. Until it has enough
 * labels, treat both numbers as opinion.
 *
 * The asymmetry is deliberate: an auto-merge is unreviewable and irreversible
 * in practice (two entities' histories get fused), so it sits far out at 0.95,
 * while auto-reject at 0.75 only costs a link a later run can still find.
 */
export const AUTO_REJECT = 0.75;
export const AUTO_MERGE = 0.95;

export function bandFor(score: number): Band {
  if (score >= AUTO_MERGE) return 'merge';
  if (score < AUTO_REJECT) return 'reject';
  return 'adjudicate';
}

/* Signal calibration. Contributions are log-odds, combined additively
 * (Fellegi–Sunter) rather than as a weighted mean, so a signal with no evidence
 * contributes exactly 0 instead of dragging an average down. Real caveat: the
 * two trigram signals are strongly correlated, so the conditional-independence
 * assumption behind that model is violated and confident scores come out
 * over-confident — another reason these are a starting point. */
export const SCORE_PRIOR_LOG_ODDS = -1.0;
export const TRIGRAM_GAIN = 5.0;
export const TRIGRAM_NEUTRAL = 0.45;
export const DESPACED_GAIN = 3.0;
export const DESPACED_NEUTRAL = 0.5;
export const RARE_TOKEN_GAIN = 3.0;
export const RARE_TOKEN_NEUTRAL = 0.35;
export const REGION_AGREE = 0.8;
export const REGION_DISAGREE = -1.2;
export const NUMERIC_AGREE = 0.5;
export const NUMERIC_ONE_SIDED = -1.0;
export const NUMERIC_DISAGREE = -3.0;

const logistic = (x: number): number => 1 / (1 + Math.exp(-x));
const despace = (s: string): string => s.replace(/\s+/g, '');
const digitsOf = (s: string): string => (s.match(/\p{N}/gu) ?? []).join('');

/** IDF-weighted overlap, normalized by the SMALLER name's mass. Normalizing by
 *  the union would punish `Jiffy` for `Jiffy On Demand Services Toronto` having
 *  more words, which is a length difference, not evidence of a different firm. */
function rareTokenCoverage(a: readonly string[], b: readonly string[], idf: TokenIdf): number {
  const sa = new Set(a);
  const sb = new Set(b);
  let shared = 0;
  let massA = 0;
  let massB = 0;
  for (const t of sa) {
    massA += idf.idf(t);
    if (sb.has(t)) shared += idf.idf(t);
  }
  for (const t of sb) massB += idf.idf(t);
  const denom = Math.min(massA, massB);
  return denom > 0 ? shared / denom : 0;
}

/**
 * Numeric tokens are identity, not decoration: `Cleaner 1` and `Cleaner 2` are
 * two crews, and every other signal says they are the same name.
 *
 * The one case that must NOT be penalised is a tokenisation artefact —
 * `Toronto 24/7` splits to `24`,`7` while `Toronto 247` is one token, yet the
 * DIGIT SIGNATURE (`247`) is identical. Same digits in the same order is
 * formatting; different digits are a different entity.
 */
function numericSignal(left: NormalizedName, right: NormalizedName): Signal {
  const la = tokensOf(left).filter((t) => /\p{N}/u.test(t));
  const rb = tokensOf(right).filter((t) => /\p{N}/u.test(t));
  const mk = (value: number, contribution: number, detail: string): Signal => ({
    name: 'numeric',
    value,
    contribution,
    detail,
  });
  if (la.length === 0 && rb.length === 0) return mk(0, 0, 'no numeric tokens on either side');

  const sameTokens = la.length === rb.length && la.every((t, i) => t === rb[i]);
  if (sameTokens) return mk(1, NUMERIC_AGREE, `numeric tokens agree (${la.join(',')})`);

  const dl = digitsOf(left.norm);
  const dr = digitsOf(right.norm);
  if (dl === dr) {
    return mk(0, 0, `numeric tokens differ but the digit signature matches (${dl}) — tokenisation`);
  }
  if (la.length === 0 || rb.length === 0) {
    return mk(-0.5, NUMERIC_ONE_SIDED, `one side carries digits (${dl || '∅'} vs ${dr || '∅'})`);
  }
  return mk(-1, NUMERIC_DISAGREE, `numeric tokens disagree (${dl} vs ${dr}) — near-veto`);
}

function regionSignal(left: ErRecord, right: ErRecord): Signal {
  const a = left.region?.trim().toLowerCase() ?? '';
  const b = right.region?.trim().toLowerCase() ?? '';
  if (!a || !b) return { name: 'region', value: 0, contribution: 0, detail: 'region unknown' };
  if (a === b) return { name: 'region', value: 1, contribution: REGION_AGREE, detail: `both ${a}` };
  return { name: 'region', value: -1, contribution: REGION_DISAGREE, detail: `${a} vs ${b}` };
}

export interface ScoreOptions {
  idf?: TokenIdf;
}

/**
 * The weighted scorer.
 *
 * Refuses outright on an exact-only name: a protected brand or a name below
 * `MIN_FUZZY_LENGTH` never receives a similarity NUMBER at all, because a
 * number invites someone downstream to compare it to a threshold. `3M` vs
 * `3M Innovations` returns 0 with a reason, not 0.41.
 */
export function scorePair(left: ErRecord, right: ErRecord, opts: ScoreOptions = {}): PairScore {
  const verdict = identityVerdict(
    { keys: [...(left.keys ?? [])], name: left.name },
    { keys: [...(right.keys ?? [])], name: right.name },
  );
  const frame = (score: number, scorable: boolean, signals: Signal[]): PairScore => ({
    left: left.id,
    right: right.id,
    score,
    band: bandFor(score),
    scorable,
    signals,
  });

  if (verdict.decision === 'merge') {
    const detail =
      verdict.via === 'hard_key'
        ? `shared hard key ${verdict.key.kind}:${verdict.key.valueNorm} — merged before scoring`
        : `exact equality on protected name "${verdict.name}" — merged before scoring`;
    return frame(1, false, [{ name: 'identity', value: 1, contribution: 0, detail }]);
  }
  if (verdict.decision === 'reject') {
    return frame(0, false, [
      {
        name: 'identity',
        value: 0,
        contribution: 0,
        detail: `${verdict.reason} — refusing to compute a similarity for an exact-only name`,
      },
    ]);
  }

  const idf = opts.idf ?? UNIFORM_IDF;
  const tri = trigramSimilarity(left.name.norm, right.name.norm);
  const despaced = trigramSimilarity(despace(left.name.norm), despace(right.name.norm));
  const rare = rareTokenCoverage(tokensOf(left.name), tokensOf(right.name), idf);

  const signals: Signal[] = [
    {
      name: 'trigram',
      value: tri,
      contribution: TRIGRAM_GAIN * (tri - TRIGRAM_NEUTRAL),
      detail: `pg_trgm similarity ${tri.toFixed(3)} on the normalized names`,
    },
    {
      name: 'trigram_despaced',
      value: despaced,
      contribution: DESPACED_GAIN * (despaced - DESPACED_NEUTRAL),
      detail: `${despaced.toFixed(3)} with spaces removed — catches "On Demand" vs "OnDemand"`,
    },
    {
      name: 'rare_token',
      value: rare,
      contribution: RARE_TOKEN_GAIN * (rare - RARE_TOKEN_NEUTRAL),
      detail: `idf-weighted shared-token coverage ${rare.toFixed(3)} (pool n=${idf.docCount})`,
    },
    regionSignal(left, right),
    numericSignal(left.name, right.name),
  ];

  const total = signals.reduce((acc, s) => acc + s.contribution, SCORE_PRIOR_LOG_ODDS);
  return frame(logistic(total), true, signals);
}
