/**
 * The honesty gate.
 *
 * Taskly's positioning depends on every trust claim being literally true, and
 * the boundary is not a matter of taste — it is in
 * `taskly-brain/60-business/brand/BRAND-VOICE.md` §5 and
 * `Final business plan.md` §7, both founder-locked. This module encodes that
 * boundary so a generated sentence cannot quietly cross it.
 *
 * Two categories, and they behave differently:
 *
 *   FORBIDDEN CLAIMS  — factually untrue of Taskly today (criminal background
 *                       checks, insurance, guarantees). Banned on EVERY surface,
 *                       including internal notes: an internal doc asserting we
 *                       carry $2M insurance is how the claim reaches copy six
 *                       months later.
 *   SURFACE WORDS     — true, but wrong for the audience. "Escrow" is the
 *                       correct legal term in Terms and the wrong word in
 *                       poster copy. A context-blind checker fires on every
 *                       legal page and gets switched off.
 *
 * Fail-closed: an unknown surface is treated as poster-facing, the strictest.
 *
 * Negation-aware, because the sentences that *state the boundary* contain the
 * banned phrases — "we do not run criminal background checks" is the honest
 * line, and a naive substring match flags it. That exact false positive already
 * bit the trust-word sweep in taskly.ca's brain gate.
 */

export type Surface = 'poster_facing' | 'tasker_facing' | 'internal' | 'legal';

export type HonestySeverity = 'forbidden_claim' | 'surface_word' | 'unsupported_number';

export interface HonestyViolation {
  severity: HonestySeverity;
  /** The matched text, as it appeared. */
  match: string;
  /** Character offset in the input, so a caller can highlight it. */
  index: number;
  /** What is wrong, in the words a reviewer needs. */
  reason: string;
  /** What to say instead. Empty when the claim must simply be dropped. */
  instead: string;
}

interface Rule {
  /** Must be global + case-insensitive; the scanner relies on lastIndex. */
  pattern: RegExp;
  reason: string;
  instead: string;
  /** Surfaces the rule does NOT apply to. Empty means: everywhere. */
  exemptSurfaces?: Surface[];
}

/**
 * None of these are true of Taskly. Banned on every surface.
 *
 * Source: BRAND-VOICE §5 "Never claim (none of these are real)".
 */
const FORBIDDEN_CLAIMS: Rule[] = [
  {
    pattern: /\b(criminal|cpic|police)[\s-]?(record|history|background)?[\s-]?check\w*\b/gi,
    reason: 'Taskly runs NO criminal or CPIC background check. Stripe Identity is ID-only.',
    instead: 'identity-verified (government photo ID + selfie), reviewed & approved',
  },
  {
    pattern: /\bbackground[\s-]?check\w*\b/gi,
    reason: 'No background check of any kind is operational.',
    instead: 'identity-verified via Stripe Identity — confirms WHO they are, not their record',
  },
  {
    pattern: /\b(\$?\s?\d+\s?m(illion)?\s+)?(liability\s+)?insur(ance|ed)\b/gi,
    reason: 'Taskly carries no liability insurance and offers none. There is no $2M policy.',
    instead: '',
  },
  {
    pattern: /\b(property[\s-]damage|satisfaction|money[\s-]back|re[\s-]?do)\s+guarantee\w*\b/gi,
    reason: 'No guarantee of any kind exists.',
    instead: 'a real person decides disputes; your money is held until you confirm',
  },
  {
    pattern: /\bwsib\b/gi,
    reason: 'There is no WSIB program.',
    instead: '',
  },
  {
    pattern: /\b(trade[\s-]?licen[cs]e|licen[cs]e)[\s-]?verif\w*\b/gi,
    reason: 'Trade licences are not verified.',
    instead: '',
  },
  {
    pattern: /\b24[\s-]?hour\s+payout\w*\b/gi,
    reason: 'There is no 24-hour payout guarantee.',
    instead: '',
  },
  {
    pattern: /\bfully\s+vetted\b|\bvetted\s+(professional|pro|tasker)\w*\b/gi,
    reason: '"Vetted" asserts curation we do not perform.',
    instead: 'reviewed & approved before they can take jobs',
  },
];

/**
 * True or neutral, but wrong for the audience.
 *
 * Source: BRAND-VOICE §4 word table + §5 "banned outright in poster-facing copy".
 */
const SURFACE_WORDS: Rule[] = [
  {
    pattern: /\bescrow\w*\b/gi,
    reason: 'Jargon in poster copy, and it does not answer WHO holds the money.',
    instead: "held by Taskly — it goes to your Tasker only when you tap 'Task done'",
    // The accurate legal term in Terms/Privacy, and correct internally.
    exemptSurfaces: ['internal', 'legal'],
  },
  {
    pattern: /\bhandpicked\b/gi,
    reason: 'Asserts curation instead of naming what we do (swept 2026-07-25).',
    instead: 'personally interviewed and approved by our founder',
    exemptSurfaces: ['internal'],
  },
  {
    pattern: /\bpros\b/gi,
    reason: 'Banned noun (swept 2026-08-01).',
    instead: 'Taskers, or "matches"',
    exemptSurfaces: ['internal', 'legal'],
  },
  {
    pattern: /\b(taskly\s+fee|service\s+fee)\b/gi,
    reason: 'Reads as a fee on top; locked out 2026-08-01.',
    instead: 'Keeps Taskly running (incl. HST)',
    exemptSurfaces: ['internal', 'legal'],
  },
  {
    pattern: /\bcommission\b/gi,
    reason: 'Not poster-facing language.',
    instead: 'Keeps Taskly running',
    exemptSurfaces: ['internal', 'legal', 'tasker_facing'],
  },
  {
    pattern: /\bbids?\b/gi,
    reason: 'Softer word preferred poster-side.',
    instead: 'offers ("pick from real offers")',
    exemptSurfaces: ['internal', 'legal', 'tasker_facing'],
  },
];

/**
 * The only take rate that may be stated. BRAND-VOICE §5 lists "any take-rate but
 * 20%" among the forbidden claims, so a wrong number here is not a typo — it is
 * a false statement about what we charge.
 */
export const TAKE_RATE_PERCENT = 20;

/**
 * The forbidden-claim patterns, exposed so other modules detect the same TOPICS
 * without keeping a second copy of the boundary.
 *
 * Consumers legitimately want different *semantics*. This module polices what we
 * assert, so it is negation-aware: "we do not run background checks" is an
 * honest sentence and must pass. A stakes scorer wants the opposite — a finding
 * that a competitor does NOT run background checks is still about the legal
 * trust surface and still high stakes. Same topics, different question, so the
 * patterns are shared and the matching rules are not.
 */
export const forbiddenClaimPatterns = (): RegExp[] =>
  FORBIDDEN_CLAIMS.map((r) => new RegExp(r.pattern.source, 'i'));

/** Words that flip a claim into a denial, i.e. into an honest sentence. */
const NEGATORS = [
  'no',
  'not',
  'never',
  'without',
  'lacks',
  'lack',
  'excludes',
  'exclude',
  'excluding',
  'absent',
  'nor',
  'neither',
  "aren't",
  "isn't",
  "doesn't",
  "don't",
  "won't",
  'cannot',
  "can't",
  'avoid',
  'avoids',
  'prohibited',
  'forbidden',
  'banned',
  'unlike',
];

/** How far back to look for a negator, in characters. */
const NEGATION_WINDOW = 60;

/**
 * Is the match negated by nearby text *in its own sentence*?
 *
 * Deliberately a window rather than a parser: the sentences we must not flag
 * ("we do NOT run criminal background checks", "no insurance is offered") put
 * the negator within a few words.
 *
 * The window is clipped at the previous sentence boundary, and that clip is
 * load-bearing rather than tidiness. Without it, "We do not run background
 * checks. Every Tasker carries $2M liability insurance." reads the `not` from
 * the first sentence and suppresses the false claim in the second — a denial
 * silently licensing the very claim it disclaims. That is the worst possible
 * failure for this module, and it is the case the test pins.
 */
export function isNegated(text: string, index: number): boolean {
  const windowStart = Math.max(0, index - NEGATION_WINDOW);
  const scanned = text.slice(windowStart, index);
  // Never look past the end of the previous sentence.
  const boundary = Math.max(
    scanned.lastIndexOf('.'),
    scanned.lastIndexOf('!'),
    scanned.lastIndexOf('?'),
    scanned.lastIndexOf('\n'),
    scanned.lastIndexOf(';'),
  );
  const before = (boundary === -1 ? scanned : scanned.slice(boundary + 1)).toLowerCase();
  return NEGATORS.some((n) => new RegExp(`(^|[^\\p{L}])${n}([^\\p{L}]|$)`, 'u').test(before));
}

/** Quoted text is being reported, not asserted — a Finding quoting a competitor's
 *  insurance claim is honest. Ranges are computed once per scan. */
function quotedRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(/"[^"]*"|“[^”]*”|'[^']{8,}'/g)) {
    if (m.index !== undefined) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

const inRanges = (ranges: Array<[number, number]>, i: number): boolean =>
  ranges.some(([a, b]) => i >= a && i < b);

function scan(text: string, rules: Rule[], severity: HonestySeverity, surface: Surface) {
  const quoted = quotedRanges(text);
  const out: HonestyViolation[] = [];
  for (const rule of rules) {
    if (rule.exemptSurfaces?.includes(surface)) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      if (inRanges(quoted, index)) continue;
      if (isNegated(text, index)) continue;
      out.push({ severity, match: m[0], index, reason: rule.reason, instead: rule.instead });
    }
  }
  return out;
}

/** Any take-rate percentage stated that is not 20%. */
function checkTakeRate(text: string): HonestyViolation[] {
  const out: HonestyViolation[] = [];
  const re = /(\d{1,2}(?:\.\d+)?)\s?%\s*(?:take[\s-]?rate|commission|cut|fee\s+to\s+taskly)/gi;
  for (const m of text.matchAll(re)) {
    const pct = Number(m[1]);
    if (Number.isFinite(pct) && pct !== TAKE_RATE_PERCENT) {
      out.push({
        severity: 'forbidden_claim',
        match: m[0],
        index: m.index ?? 0,
        reason: `Taskly's take rate is ${TAKE_RATE_PERCENT}%. Stating any other rate is a false claim about what we charge.`,
        instead: `${TAKE_RATE_PERCENT}% — "Keeps Taskly running (incl. HST)"`,
      });
    }
  }
  return out;
}

export interface HonestyResult {
  ok: boolean;
  violations: HonestyViolation[];
  surface: Surface;
}

const KNOWN_SURFACES: Surface[] = ['poster_facing', 'tasker_facing', 'internal', 'legal'];

/**
 * Check a piece of generated text.
 *
 * Fail-closed on the surface: anything unrecognised is treated as poster-facing,
 * because the expensive mistake is publishing a banned claim to a customer, not
 * over-flagging an internal note.
 */
export function checkHonesty(text: string, surface: string): HonestyResult {
  const resolved: Surface = KNOWN_SURFACES.includes(surface as Surface)
    ? (surface as Surface)
    : 'poster_facing';

  const violations = [
    ...scan(text, FORBIDDEN_CLAIMS, 'forbidden_claim', resolved),
    ...scan(text, SURFACE_WORDS, 'surface_word', resolved),
    ...checkTakeRate(text),
  ].sort((a, b) => a.index - b.index);

  return { ok: violations.length === 0, violations, surface: resolved };
}

/**
 * The generation-path guard. Throws rather than returning, so a caller cannot
 * ignore the result by accident — the gate has to be impossible to forget at
 * the three call sites, not merely available at them.
 */
export function assertHonest(text: string, surface: string): void {
  const r = checkHonesty(text, surface);
  if (r.ok) return;
  const lines = r.violations.map(
    (v) => `  [${v.severity}] "${v.match}" — ${v.reason}${v.instead ? ` → say: ${v.instead}` : ''}`,
  );
  throw new Error(
    `honesty gate blocked ${r.violations.length} violation(s) on ${r.surface}:\n${lines.join('\n')}`,
  );
}
