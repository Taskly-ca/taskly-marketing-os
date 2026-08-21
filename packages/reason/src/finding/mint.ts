/**
 * THE MINT — the one place a `Finding` object is constructed.
 *
 * `synthesis.ts` has always said it: one writer, always. That was true of the
 * prose and false of the code. `assembleFinding` in `tier/t2-correlate.ts`
 * also returned a `Finding` — past one of the four gates, not four — and a
 * `Finding` is what every surface in this system accepts: the feed, the entity
 * page, the digest, the Slack push, the store. A value that can reach all five
 * is not an intermediate, whichever module built it.
 *
 * So the object literal lives here, exactly once, behind the gates. Both
 * writers call this; neither builds a Finding itself; `mint.test.ts` fails if a
 * third one appears.
 *
 *   1. so_what — a Finding without a consequence is a fact, not intelligence.
 *   2. honesty — over claim AND so_what. Both are generated prose; checking
 *                only the claim leaves half of every finding ungated.
 *   3. causal  — over claim AND so_what, at the finding's own rung.
 *   4. L0      — every number and date in the claim appears verbatim in a cited
 *                span, and every cited URL is one we retrieved.
 *   5. schema  — the contract, last, over the assembled object.
 *
 * Reasons are COLLECTED, never short-circuited, so a refusal explains itself
 * completely and a caller repairs a draft once rather than four times.
 *
 * THE CANARY. Every gate is first handed text it MUST reject. A gate that
 * accepts its canary is stubbed, mocked, or has regressed to a no-op, and this
 * module refuses to run at all rather than mint findings past a gate that is
 * not there. That check is the whole difference between "we run the honesty
 * gate" and "we have a call to something named honesty".
 *
 * A finding that fails a gate is NOT a draft to fix later. It is a fabrication
 * or a claim we are not allowed to make, and emitting it "for review" is how
 * both get reviewed by a tired human at 6pm and shipped. There is no `force`
 * flag here and there must never be one.
 */
import { findingSchema } from '@tmos/contracts';
import type { Basis, EvidenceRef, Finding, Region } from '@tmos/contracts';
import { assertCausalLanguage } from '@tmos/guardrails';
import type { CausalRung } from '@tmos/guardrails';
import { assertL0 } from '../verify/l0.js';

/* ── refusals ─────────────────────────────────────────────────────────────── */

export type RefusalCode = 'trivial_so_what' | 'honesty' | 'causal' | 'l0' | 'schema';

export interface RefusalReason {
  code: RefusalCode;
  detail: string;
}

/** `assertHonest` from `@tmos/guardrails`, or anything holding its contract:
 *  throw on a violation, return silently otherwise. Injected rather than
 *  imported so a caller can pin a surface-specific gate — and canary-tested on
 *  every mint, so injecting a no-op is not one of the things a caller can do. */
export type HonestyGate = (text: string, surface: string) => void;

/* ── so_what ──────────────────────────────────────────────────────────────── */

/** Shorter than this states a mood, not a consequence. */
export const MIN_SO_WHAT_CHARS = 20;

/** Share of so_what's words already in the claim, at or above which it is a
 *  restatement. 0.8 leaves room to reuse the subject nouns while still
 *  demanding new content words. */
export const SO_WHAT_MAX_OVERLAP = 0.8;

const words = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

function checkSoWhat(claim: string, soWhat: string): RefusalReason | null {
  const trimmed = soWhat.trim();
  if (trimmed.length < MIN_SO_WHAT_CHARS) {
    return {
      code: 'trivial_so_what',
      detail: `so_what is ${trimmed.length} chars; a consequence needs at least ${MIN_SO_WHAT_CHARS}`,
    };
  }
  const soWords = new Set(words(trimmed));
  if (soWords.size === 0) return { code: 'trivial_so_what', detail: 'so_what has no words' };
  const claimWords = new Set(words(claim));
  let shared = 0;
  for (const w of soWords) if (claimWords.has(w)) shared += 1;
  const overlap = shared / soWords.size;
  if (overlap >= SO_WHAT_MAX_OVERLAP) {
    return {
      code: 'trivial_so_what',
      detail:
        `so_what restates the claim (${overlap.toFixed(2)} word overlap, limit ` +
        `${SO_WHAT_MAX_OVERLAP}); say what changes because of it`,
    };
  }
  return null;
}

/* ── the canaries ─────────────────────────────────────────────────────────── */

/** Two independent forbidden claims, so even a partial honesty gate trips it. */
const HONESTY_CANARY =
  'Every Tasker carries $2M liability insurance and passes a criminal background check.';

/** Rung 0, so the causal gate must reject it. */
const CAUSAL_CANARY = 'The price cut caused a drop in our organic leads.';

/** A number in the claim that appears in no span — the characteristic
 *  fabrication L0 exists to catch. */
const L0_CANARY_URL = 'https://canary.invalid/rate';
const L0_CANARY: Parameters<typeof assertL0>[0] = {
  claim: 'Their flat rate rose to $4,321.',
  evidence: [
    {
      signal_id: null,
      fact_id: null,
      source_url: L0_CANARY_URL,
      span: 'Their flat rate is unchanged this quarter.',
      observed_at: '2026-01-01T00:00:00.000Z',
    },
  ],
  retrievedUrls: [L0_CANARY_URL],
};

const rejects = (run: () => void): boolean => {
  try {
    run();
    return false;
  } catch {
    return true;
  }
};

const notWired = (gate: string, fix: string): Error =>
  new Error(
    `${gate} gate accepted its canary, so it is not a real implementation. ${fix} ` +
      'Refusing to mint a Finding past a gate that is not there.',
  );

/**
 * Prove each gate still refuses what it exists to refuse, before any real draft
 * is read. Cheap enough to run on every mint — four short scans — and the one
 * failure mode it covers (a gate quietly replaced by a no-op) is the failure
 * mode that makes every other check in this file decorative.
 */
export function assertGatesAreWired(honesty: HonestyGate): void {
  if (!rejects(() => honesty(HONESTY_CANARY, 'poster_facing'))) {
    throw notWired('honesty', 'Wire it to assertHonest from packages/guardrails/src/honesty.ts.');
  }
  if (!rejects(() => assertCausalLanguage(CAUSAL_CANARY, 0))) {
    throw notWired('causal', 'assertCausalLanguage from @tmos/guardrails is not refusing rung 0.');
  }
  if (assertL0(L0_CANARY).ok) {
    throw notWired('L0', 'assertL0 from ./verify/l0.js is not catching an unsourced number.');
  }
  if (findingSchema.safeParse({}).success) {
    throw notWired(
      'schema',
      'findingSchema from @tmos/contracts is not rejecting an empty object.',
    );
  }
}

/* ── the mint ─────────────────────────────────────────────────────────────── */

/** Everything a Finding needs that is not bookkeeping. `reviewed_by`,
 *  `superseded_by` and `supersede_reason` are not inputs: a freshly minted
 *  Finding is unreviewed and unsuperseded, and supersession is the store's. */
export interface MintDraft {
  id: string;
  claim: string;
  so_what: string;
  subject_refs: readonly string[];
  evidence: readonly EvidenceRef[];
  basis: Basis;
  causal_rung: CausalRung;
  stakes: Finding['stakes'];
  region: Region;
  domain_score: number;
  /** 'agent:model@version' | 'human:<id>'. */
  generated_by: string;
  /** Caller-supplied, so the same inputs yield the same Finding — no clock in
   *  library code. */
  created_at: string;
}

export interface MintGates {
  honesty: HonestyGate;
  /**
   * The honesty surface. Findings are internal intelligence, so 'internal' is
   * the default: the surface-word rules (escrow, commission, bids) name real
   * mechanics a competitive note must be able to discuss. FORBIDDEN claims —
   * insurance, background checks, guarantees, "vetted" — are banned on every
   * surface including this one, because an internal doc asserting them is how
   * they reach copy later. Unknown surfaces fail closed to poster_facing.
   */
  surface?: string;
  /** Every URL retrieval actually returned. L0 refuses a citation to anything
   *  else, so this must be the real retrieved set — not the citations. */
  retrievedUrls: Iterable<string>;
}

export type MintResult = { ok: true; finding: Finding } | { ok: false; reasons: RefusalReason[] };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function mintFinding(draft: MintDraft, gates: MintGates): MintResult {
  assertGatesAreWired(gates.honesty);
  const surface = gates.surface ?? 'internal';
  const reasons: RefusalReason[] = [];

  const trivial = checkSoWhat(draft.claim, draft.so_what);
  if (trivial) reasons.push(trivial);

  // Both generated fields, both gates, every time. There is no path through
  // this function that produces prose without checking it.
  for (const [field, text] of [
    ['claim', draft.claim],
    ['so_what', draft.so_what],
  ] as const) {
    try {
      gates.honesty(text, surface);
    } catch (err) {
      reasons.push({ code: 'honesty', detail: `${field}: ${message(err)}` });
    }
    try {
      assertCausalLanguage(text, draft.causal_rung);
    } catch (err) {
      reasons.push({ code: 'causal', detail: `${field}: ${message(err)}` });
    }
  }

  const evidence = draft.evidence.map((e) => ({ ...e }));
  const l0 = assertL0({ claim: draft.claim, evidence, retrievedUrls: gates.retrievedUrls });
  if (!l0.ok) {
    reasons.push({
      code: 'l0',
      detail: l0.violations.map((v) => `${v.code}: ${v.detail}`).join(' | '),
    });
  }

  // THE Finding literal. The only one in this package — see mint.test.ts.
  const finding: Finding = {
    id: draft.id,
    claim: draft.claim,
    so_what: draft.so_what,
    subject_refs: [...draft.subject_refs],
    evidence,
    basis: draft.basis,
    causal_rung: draft.causal_rung,
    stakes: draft.stakes,
    region: draft.region,
    domain_score: draft.domain_score,
    generated_by: draft.generated_by,
    reviewed_by: null,
    superseded_by: null,
    supersede_reason: null,
    created_at: draft.created_at,
  };

  const parsed = findingSchema.safeParse(finding);
  if (!parsed.success) {
    reasons.push({
      code: 'schema',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | '),
    });
  }

  return reasons.length > 0 ? { ok: false, reasons } : { ok: true, finding };
}

/**
 * The throwing form, for a caller that assembles one Finding at a time and has
 * nowhere to put a refusal. `synthesize` uses `mintFinding` instead, because a
 * batch must be able to report which drafts it refused and why.
 */
export function mintOrThrow(draft: MintDraft, gates: MintGates): Finding {
  const result = mintFinding(draft, gates);
  if (result.ok) return result.finding;
  const body = result.reasons.map((r) => `  [${r.code}] ${r.detail}`).join('\n');
  throw new Error(`refusing to mint finding ${draft.id}:\n${body}`);
}
