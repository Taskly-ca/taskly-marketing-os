/**
 * The causal lint.
 *
 * Across 15 Facebook field experiments (500M observations), standard
 * observational methods routinely failed to recover the effects that
 * randomised experiments measured — sometimes by large multiples. Last-click,
 * platform-reported ROAS and "traffic went up after we posted" are all in that
 * failure class.
 *
 * So causal language is gated on the rung of evidence behind it. This is one
 * regex and a schema field, and it is the highest-value guardrail in the
 * system: it prevents the most common and most expensive failure, which is a
 * generated sentence that says "caused".
 *
 *   0 — no control group           → causal language BANNED
 *   1 — pre-registered before/after → still banned (protects against hindsight)
 *   2 — randomised holdout          → causal language allowed
 *   3 — geo experiment / TBR        → allowed
 *   4 — MMM (needs ~104 weeks)      → allowed
 */

export type CausalRung = 0 | 1 | 2 | 3 | 4;

/** Rung at which causal claims become defensible. */
export const MIN_CAUSAL_RUNG: CausalRung = 2;

/** Words and phrases that assert causation. Word-boundary anchored so
 *  "because" inside "becauseless" or a URL never trips it. */
const CAUSAL_PATTERNS: ReadonlyArray<{ re: RegExp; suggest: string }> = [
  { re: /\bcaus(?:e|es|ed|ing)\b/i, suggest: 'observed alongside' },
  { re: /\bdrove\b|\bdriving\b|\bdrives\b/i, suggest: 'coincided with' },
  { re: /\bresulted in\b/i, suggest: 'was followed by' },
  { re: /\bled to\b/i, suggest: 'preceded' },
  { re: /\bbecause of\b/i, suggest: 'alongside' },
  { re: /\bdue to\b/i, suggest: 'coinciding with' },
  { re: /\bthanks to\b/i, suggest: 'alongside' },
  { re: /\bimpact(?:ed|ing)\b/i, suggest: 'moved with' },
  { re: /\bboosted\b|\blifted\b/i, suggest: 'rose alongside' },
  { re: /\battributable to\b/i, suggest: 'associated with' },
  { re: /\bresponsible for\b/i, suggest: 'associated with' },
];

export interface CausalViolation {
  match: string;
  index: number;
  suggest: string;
}

export interface CausalCheck {
  ok: boolean;
  rung: CausalRung;
  violations: CausalViolation[];
}

/**
 * Fail-closed: any causal phrasing below rung 2 is a violation.
 *
 * Text inside a direct quotation is exempt — we quote sources verbatim, and
 * rewriting someone else's words would be a worse error than the one we are
 * preventing.
 */
export function checkCausalLanguage(text: string, rung: CausalRung): CausalCheck {
  if (rung >= MIN_CAUSAL_RUNG) return { ok: true, rung, violations: [] };

  const quoted = quotedRanges(text);
  const violations: CausalViolation[] = [];

  for (const { re, suggest } of CAUSAL_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(global)) {
      const idx = m.index ?? 0;
      if (quoted.some(([s, e]) => idx >= s && idx < e)) continue;
      violations.push({ match: m[0], index: idx, suggest });
    }
  }
  violations.sort((a, b) => a.index - b.index);
  return { ok: violations.length === 0, rung, violations };
}

/** Ranges covered by "..." or “...” so quoted evidence is not rewritten. */
function quotedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const m of text.matchAll(/"[^"]*"|“[^”]*”/g)) {
    const start = m.index ?? 0;
    ranges.push([start, start + m[0].length]);
  }
  return ranges;
}

export class CausalLanguageError extends Error {
  constructor(public readonly check: CausalCheck) {
    const list = check.violations.map((v) => `"${v.match}" → try "${v.suggest}"`).join('; ');
    super(
      `causal language at rung ${check.rung} (needs ≥${MIN_CAUSAL_RUNG}): ${list}. ` +
        `Say "observed", "associated with" or "consistent with" instead.`,
    );
    this.name = 'CausalLanguageError';
  }
}

/** Throwing form for the generation path. Fail-closed by construction. */
export function assertCausalLanguage(text: string, rung: CausalRung): void {
  const check = checkCausalLanguage(text, rung);
  if (!check.ok) throw new CausalLanguageError(check);
}
