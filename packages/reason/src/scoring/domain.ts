/**
 * Taskly's priors, encoded.
 *
 * A generic "importance" score produces generically useless findings: it ranks
 * a well-written article about a Vancouver competitor above a thin one about
 * the corridor we actually operate in. This module encodes what matters to a
 * GTA task marketplace, and — more importantly — SHOWS ITS WORK. Every score
 * carries a breakdown, because a number a human cannot argue with is a number
 * they will eventually ignore, and an ignored ranking is worse than none.
 *
 * Four terms, and their sizes are the argument:
 *
 *   source_tier  0.40 — what a claim rests on decides whether it can be acted
 *                       on at all, so it gets the largest single share.
 *   geography    0.35 — a true, well-sourced fact about a market we do not
 *                       serve still cannot drive a decision here.
 *   trust        0.15 — legal exposure outranks a commercial finding of equal
 *                       quality, but a bump, not a floor: it must not make a
 *                       badly-sourced claim look strong.
 *   competitor   0.10 — smallest. Naming a rival is a weak signal on its own;
 *                       a content farm naming Jiffy is still a content farm.
 *
 * Two things override the arithmetic entirely: a paid channel over the CAC
 * ceiling is REJECTED, not down-ranked; and a claim resting only on farm-tier
 * sources is capped below high confidence however many of them there are.
 */
import { forbiddenClaimPatterns } from '@tmos/guardrails';
import type { Source } from '@tmos/contracts';

/** Mirrors `sourceTierSchema` in contracts; changing it there breaks this. */
export type SourceTier = Source['tier'];

export type Stakes = 'low' | 'medium' | 'high';

export interface ChannelProposal {
  channel: string;
  /** The ceiling is about paid acquisition; organic effort is judged elsewhere. */
  paid: boolean;
  /** Integer cents, like all money in this system. */
  spend_cents: number;
  expected_customers: number;
}

export interface ScorableFinding {
  claim: string;
  so_what: string;
  /** The tier of every source the claim rests on. Empty ⇒ nothing to rest on. */
  source_tiers: readonly SourceTier[];
  /** Present when the finding recommends spending money on a channel. */
  channel?: ChannelProposal | null;
}

/* ── weights ──────────────────────────────────────────────────────────────── */

export const SOURCE_MAX = 0.4;
export const GEO_MAX = 0.35;
export const TRUST_BONUS = 0.15;
export const COMPETITOR_BONUS = 0.1;

/** Best tier wins; ten aggregators do not add up to one primary source. */
export const SOURCE_TIER_WEIGHT: Record<SourceTier, number> = {
  first_party: 1.0,
  primary: 0.9,
  trade: 0.7,
  aggregator: 0.45,
  farm: 0.2,
};

/**
 * A claim resting only on content farms cannot be high-confidence regardless of
 * how many farms repeat it — repetition of an unsourced claim is the copy-chain,
 * not corroboration.
 */
export const FARM_ONLY_CEILING = 0.4;

/**
 * `home`   — our market.
 * `elsewhere` — not our market, but a competitor moving there is a leading
 *               indicator of what they will try here, so it is weighted down,
 *               never zeroed. Below half of `home`, so an out-of-market finding
 *               can never outrank an in-market one on geography alone.
 * `unknown` — no place named. Most category news is about the category, so it
 *             sits nearer home than a finding explicitly about somewhere else.
 */
export const GEO_WEIGHT = { home: 1.0, unknown: 0.7, elsewhere: 0.45 } as const;

export interface GeoCorridor {
  home: readonly string[];
  elsewhere: readonly string[];
}

export const GTA_CORRIDOR: GeoCorridor = {
  home: [
    'toronto',
    'gta',
    'greater toronto',
    'mississauga',
    'brampton',
    'scarborough',
    'etobicoke',
    'north york',
    'vaughan',
    'markham',
    'richmond hill',
    'oakville',
    'burlington',
    'ajax',
    'pickering',
    'whitby',
    'oshawa',
    'ontario',
  ],
  elsewhere: [
    'vancouver',
    'calgary',
    'edmonton',
    'montreal',
    'ottawa',
    'winnipeg',
    'halifax',
    'quebec city',
    'victoria',
    'saskatoon',
    'regina',
  ],
};

export const DEFAULT_COMPETITORS: readonly string[] = [
  'jiffy',
  'airtasker',
  'taskrabbit',
  'handy',
  'thumbtack',
  'angi',
  'homestars',
  'jobber',
  'urban company',
];

/**
 * Trust-boundary language. Mirrors the FORBIDDEN_CLAIMS list in
 * `packages/guardrails/src/honesty.ts` (itself derived from BRAND-VOICE §5),
 * for the opposite purpose: honesty.ts stops US saying these things, this stops
 * us UNDER-READING a finding that says them.
 *
 * Deliberately NOT negation-aware, unlike honesty.ts. "Jiffy does not run
 * background checks" is still a trust-boundary finding and carries the same
 * legal weight — the stakes come from the topic, not from the polarity.
 */
/** Topics that carry the same legal weight but are not claims Taskly could make
 *  falsely, so they have no counterpart in the honesty gate. */
const TRUST_CLAIM_EXTRAS: readonly RegExp[] = [
  /\bscreen(ing|ed)\b/i,
  /\bwarrant(y|ies)\b/i,
  /\b(bonded|licen[cs]ed)\b/i,
];

/** Sourced from the gate, never copied — a second copy of a LEGAL boundary is
 *  exactly the drift this repo exists to prevent. */
const TRUST_CLAIM_PATTERNS: readonly RegExp[] = [
  ...forbiddenClaimPatterns(),
  ...TRUST_CLAIM_EXTRAS,
];

/* ── output ───────────────────────────────────────────────────────────────── */

export interface Contribution {
  name: string;
  /** What this term added. Negative for a clamp, so the breakdown always sums
   *  to the final score — an unexplainable score cannot be argued with. */
  delta: number;
  why: string;
}

export interface CacRejection {
  channel: string;
  implied_cac_cents: number;
  ceiling_cents: number;
  /** The arithmetic, spelled out. A rejection a human cannot check is one they
   *  will overrule on instinct, and then stop reading the rest. */
  arithmetic: string;
}

export interface DomainScore {
  domain_score: number;
  stakes: Stakes;
  breakdown: readonly Contribution[];
  rejection: CacRejection | null;
}

export interface DomainScoringConfig {
  /** Injected: the ceiling belongs to the financial model, not to this file. */
  cacCeilingCents: number;
  corridor?: GeoCorridor;
  competitors?: readonly string[];
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mentionsAny = (text: string, terms: readonly string[]): boolean =>
  terms.some((t) => new RegExp(`\\b${escape(t)}\\b`, 'i').test(text));

/** Deterministic, locale-free money formatting. */
function formatCents(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${cents < 0 ? '-' : ''}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

function checkCac(
  channel: ChannelProposal | null | undefined,
  ceilingCents: number,
): CacRejection | null {
  if (!channel || !channel.paid) return null;

  if (channel.expected_customers <= 0) {
    return {
      channel: channel.channel,
      implied_cac_cents: Number.POSITIVE_INFINITY,
      ceiling_cents: ceilingCents,
      arithmetic: `${formatCents(channel.spend_cents)} spend ÷ ${channel.expected_customers} customers — no expected customers, so the implied CAC is unbounded and cannot clear a ${formatCents(ceilingCents)} ceiling`,
    };
  }

  const implied = channel.spend_cents / channel.expected_customers;
  if (implied <= ceilingCents) return null;
  return {
    channel: channel.channel,
    implied_cac_cents: Math.round(implied),
    ceiling_cents: ceilingCents,
    arithmetic: `${formatCents(channel.spend_cents)} spend ÷ ${channel.expected_customers} customers = ${formatCents(implied)} CAC > ${formatCents(ceilingCents)} ceiling`,
  };
}

function geoTerm(text: string, corridor: GeoCorridor): keyof typeof GEO_WEIGHT {
  // Home wins a tie: "expanding from Vancouver into Toronto" is about us.
  if (mentionsAny(text, corridor.home)) return 'home';
  if (mentionsAny(text, corridor.elsewhere)) return 'elsewhere';
  return 'unknown';
}

const bestTier = (tiers: readonly SourceTier[]): SourceTier | null =>
  tiers.reduce<SourceTier | null>(
    (best, t) => (best === null || SOURCE_TIER_WEIGHT[t] > SOURCE_TIER_WEIGHT[best] ? t : best),
    null,
  );

/* ── the score ────────────────────────────────────────────────────────────── */

export function scoreFinding(finding: ScorableFinding, cfg: DomainScoringConfig): DomainScore {
  const text = `${finding.claim}\n${finding.so_what}`;
  const isTrustClaim = TRUST_CLAIM_PATTERNS.some((re) => re.test(text));

  const rejection = checkCac(finding.channel, cfg.cacCeilingCents);
  if (rejection) {
    // Auto-rejected, not down-ranked. A channel that cannot pay for itself is
    // not a weaker recommendation than one that can — it is a different kind of
    // thing, and burying it at rank 40 invites someone to try it anyway.
    return {
      domain_score: 0,
      stakes: isTrustClaim ? 'high' : 'medium',
      breakdown: [
        { name: 'cac_ceiling', delta: 0, why: `auto-rejected — ${rejection.arithmetic}` },
      ],
      rejection,
    };
  }

  const corridor = cfg.corridor ?? GTA_CORRIDOR;
  const competitors = cfg.competitors ?? DEFAULT_COMPETITORS;

  const geo = geoTerm(text, corridor);
  const tier = bestTier(finding.source_tiers);
  const namesCompetitor = mentionsAny(text, competitors);

  const breakdown: Contribution[] = [
    {
      name: 'source_tier',
      delta: (tier === null ? 0 : SOURCE_TIER_WEIGHT[tier]) * SOURCE_MAX,
      why:
        tier === null
          ? 'no sources: nothing for the claim to rest on'
          : `best source is ${tier} (${SOURCE_TIER_WEIGHT[tier]} of ${SOURCE_MAX}) — the best tier counts, not the count`,
    },
    {
      name: 'geography',
      delta: GEO_WEIGHT[geo] * GEO_MAX,
      why:
        geo === 'home'
          ? 'names the GTA corridor — our market'
          : geo === 'elsewhere'
            ? 'names a market we do not serve; kept as a leading indicator, weighted down'
            : 'no market named; most category news is about the category',
    },
    {
      name: 'trust',
      delta: isTrustClaim ? TRUST_BONUS : 0,
      why: isTrustClaim
        ? 'touches the trust boundary (checks, insurance, guarantees) — the downside is legal'
        : 'no trust-boundary language',
    },
    {
      name: 'competitor',
      delta: namesCompetitor ? COMPETITOR_BONUS : 0,
      why: namesCompetitor ? 'names a direct competitor' : 'no named competitor',
    },
  ];

  const raw = Math.min(
    1,
    Math.max(
      0,
      breakdown.reduce((s, c) => s + c.delta, 0),
    ),
  );

  let score = raw;
  if (tier === null || tier === 'farm') {
    score = Math.min(raw, FARM_ONLY_CEILING);
    if (score < raw) {
      breakdown.push({
        name: 'farm_only_ceiling',
        delta: score - raw,
        why: `nothing above farm tier: capped at ${FARM_ONLY_CEILING}, because repeating an unsourced claim is a copy-chain, not corroboration`,
      });
    }
  }

  return {
    domain_score: score,
    // Stakes are a SEPARATE axis from the score on purpose. A farm-sourced
    // trust claim is high stakes AND low confidence; collapsing the two into
    // one number is exactly how a legal exposure gets buried under a low score.
    stakes: isTrustClaim ? 'high' : geo === 'home' || namesCompetitor ? 'medium' : 'low',
    breakdown,
    rejection: null,
  };
}
