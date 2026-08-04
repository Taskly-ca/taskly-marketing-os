/**
 * Six lines per finding, and the limit IS the design.
 *
 * A digest line competes with everything else on a phone screen, so the budget
 * is set at the point where the reader can take the whole thing in without
 * deciding to read it. Six lines is not a stylistic preference: it is the
 * forcing function that makes the upstream pipeline produce a claim and a
 * consequence rather than a paragraph. If a finding does not fit in six lines
 * it is not too long — it is not finished, and the honest move is to refuse it
 * rather than to compress it until it is technically true.
 *
 * Every rendered finding carries four things without exception: the claim, the
 * so_what, the BASIS (via `renderBasis`, as a category — never a number), and a
 * deep link so the reader can leave this summary behind. The other two lines are
 * evidence and stakes, and they are the ones dropped under pressure.
 *
 * Three guards run on the way out, and all three REFUSE rather than repair:
 *
 *   - `assertNoConfidenceNumber` runs on the SOURCE text before any trimming.
 *     Running it only on the rendered output would let a leak fall off the end
 *     of a truncated line, which ships a violated rule that no test can see.
 *   - the honesty gate, at surface `internal`.
 *   - the causal lint, at the finding's own rung.
 *
 * Repairing text to satisfy a guard is how a guard becomes a formatter. A
 * finding that trips one is a defect upstream, and returning it as a refusal is
 * what makes the defect visible.
 */
import type { Finding } from '@tmos/contracts';
import { assertNoConfidenceNumber, renderBasis } from '../basis.js';

/** Hard line budget. Not a target, not a soft limit — enforced below. */
export const MAX_LINES = 6;

/** Per-line character budget. Comfortably under Slack's 3000-char text limit
 *  even at six full lines, so the block builder never has to trim prose. */
export const LINE_MAX_CHARS = 240;

/**
 * The honesty surface for a digest.
 *
 * `internal`, and the choice is not casual. This message goes to the founder
 * and to nobody else, and the SURFACE WORDS the gate polices — escrow,
 * commission, offers-vs-bids — name real mechanics that a competitive note must
 * be able to discuss by their right names. Blocking them here would make the
 * gate an obstacle to accurate internal writing, which is how gates get turned
 * off. The FORBIDDEN CLAIMS — insurance, background checks, guarantees — are
 * banned on `internal` too, and that is the half that matters: an internal note
 * asserting we carry insurance is exactly how the claim reaches customer copy
 * six months later. Anything from this digest that is later re-rendered
 * poster-facing must be re-checked at that surface, not trusted from here.
 */
export const DIGEST_SURFACE = 'internal';

/** The evidence line is dropped whole rather than squeezed below this. */
const MIN_SPAN_CHARS = 24;

type Rung = Finding['causal_rung'];

/** Plain-language rung, with no bare number: a lone "0" next to a claim reads
 *  as a score, and this package does not print scores. */
const RUNG_LABEL: Record<Rung, string> = {
  0: 'observational, no control group',
  1: 'pre-registered before/after',
  2: 'randomised holdout',
  3: 'geo experiment',
  4: 'marketing mix model',
};

/* ── injected guards ──────────────────────────────────────────────────────── */

/**
 * The two guardrails, injected.
 *
 * Both are REQUIRED and neither has a default, for the same reason
 * `packages/reason/src/synthesis.ts` does it this way: a gate with a permissive
 * default is a gate that is off in exactly the code path nobody reviewed.
 * They are injected rather than imported because `packages/surface` does not
 * declare `@tmos/guardrails` as a dependency yet — see the report on this lane.
 *
 * Wire `honesty` to `assertHonest` and `causal` to `assertCausalLanguage` from
 * `packages/guardrails`. Substituting a no-op is caught by the canary below.
 */
export interface FormatDeps {
  honesty: (text: string, surface: string) => void;
  causal: (text: string, rung: Rung) => void;
}

const HONESTY_CANARY = 'Every Tasker carries $2M liability insurance.';
const CAUSAL_CANARY = 'The July rate change caused the drop in offers.';

/**
 * Prove the injected gates are the real ones before trusting them.
 *
 * A silently-passing guard is worse than no guard: it produces a green run and
 * a false record that the text was checked. So each gate is handed something it
 * must reject, and failing to reject is a hard throw — a programming error, not
 * a content refusal.
 */
export function assertGatesLive(deps: FormatDeps): void {
  let honestyRejected = false;
  try {
    deps.honesty(HONESTY_CANARY, DIGEST_SURFACE);
  } catch {
    honestyRejected = true;
  }
  if (!honestyRejected) {
    throw new Error(
      'honesty gate canary passed a forbidden trust claim — the injected gate is a no-op. ' +
        'Wire deps.honesty to assertHonest from packages/guardrails/src/honesty.ts.',
    );
  }

  let causalRejected = false;
  try {
    deps.causal(CAUSAL_CANARY, 0);
  } catch {
    causalRejected = true;
  }
  if (!causalRejected) {
    throw new Error(
      'causal gate canary passed "caused" at rung 0 — the injected gate is a no-op. ' +
        'Wire deps.causal to assertCausalLanguage from packages/guardrails/src/causal.ts.',
    );
  }
}

/* ── truncation ───────────────────────────────────────────────────────────── */

const HAS_DIGIT = /\d/;

/** Would cutting here leave a number in two pieces? Covers "1,299" cut at the
 *  comma via the whole-token rule, and "12 %" / "1 299" — numbers that contain
 *  a space and so survive a naive word-boundary cut looking perfectly intact. */
const splitsANumber = (text: string, cut: number): boolean =>
  /\d\s*$/.test(text.slice(0, cut)) && /^\s*[%\d.,]/.test(text.slice(cut));

/**
 * Truncate to whole tokens, never through a figure.
 *
 * A half-number is worse than an omitted one: "$1,29…" is read as a real,
 * smaller price, and the reader has no way to know the digits were cut. So the
 * cut point walks back to a whitespace boundary, then keeps walking while the
 * boundary would divide a numeric token. A single token longer than the budget
 * that carries a digit is dropped entirely rather than halved.
 */
export function truncateLine(text: string, max: number): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - 1); // one char for the ellipsis

  let cut = text.lastIndexOf(' ', room);
  while (cut > 0 && splitsANumber(text, cut)) cut = text.lastIndexOf(' ', cut - 1);

  if (cut <= 0) {
    const head = text.slice(0, room);
    return HAS_DIGIT.test(head) ? '…' : `${head}…`;
  }
  return `${text.slice(0, cut).trimEnd()}…`;
}

/* ── rendering ────────────────────────────────────────────────────────────── */

export interface RenderInput {
  finding: Finding;
  /** Root of the surface the reader lands on, e.g. `https://tmos.example/app`. */
  deepLinkBase: string;
  /**
   * INDEPENDENT sources after copy-chain collapse.
   *
   * Never inferred from the evidence array here. Ten outlets republishing one
   * press release are ten evidence rows and one source, and counting the rows
   * is the exact mechanism by which a single fabricated claim becomes "widely
   * reported". When the caller cannot supply a collapsed count, the basis
   * renders as a bare category — which is honest — rather than as a number this
   * module guessed.
   */
  independentSources?: number;
}

export interface RenderedFinding {
  id: string;
  lines: string[];
  /** `lines` joined with newlines. Never contains more than MAX_LINES lines. */
  text: string;
  deepLink: string;
}

export type RefusalCode = 'confidence_number' | 'honesty' | 'causal' | 'too_long';

export interface RenderRefusal {
  ok: false;
  id: string;
  code: RefusalCode;
  detail: string;
}

export type RenderResult = { ok: true; rendered: RenderedFinding } | RenderRefusal;

/** Newlines are collapsed, not preserved: a claim containing one would make the
 *  six-line contract true of the array and false of the message. */
const oneLine = (s: string) => s.replace(/\s*\n+\s*/g, ' ').trim();

const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const labelled = (label: string, body: string) =>
  `${label}${truncateLine(body, Math.max(0, LINE_MAX_CHARS - label.length))}`;

export const deepLinkFor = (base: string, id: string): string =>
  `${base.replace(/\/+$/, '')}/findings/${id}`;

export function renderFinding(input: RenderInput, deps: FormatDeps): RenderResult {
  assertGatesLive(deps);
  const f = input.finding;

  // Guard the SOURCE, before anything is trimmed. A leak that truncation would
  // have hidden is still a leak, and the hidden one is the dangerous one.
  const source = [f.claim, f.so_what, ...f.evidence.map((e) => e.span)].join('\n');
  try {
    assertNoConfidenceNumber(source);
  } catch (e) {
    return { ok: false, id: f.id, code: 'confidence_number', detail: message(e) };
  }

  const deepLink = deepLinkFor(input.deepLinkBase, f.id);
  const lines: string[] = [
    truncateLine(oneLine(f.claim), LINE_MAX_CHARS),
    labelled('So what — ', oneLine(f.so_what)),
    `Basis — ${renderBasis(f.basis, input.independentSources)}`,
  ];

  const ev = f.evidence[0];
  if (ev) {
    // Quoted with curly quotes on purpose: both guardrails treat a quotation as
    // reported rather than asserted, which is what an evidence span is.
    const suffix = ` (${hostOf(ev.source_url)}, ${ev.observed_at.slice(0, 10)})`;
    const budget = LINE_MAX_CHARS - 'Evidence — '.length - suffix.length - 2;
    if (budget >= MIN_SPAN_CHARS) {
      lines.push(`Evidence — “${truncateLine(oneLine(ev.span), budget)}”${suffix}`);
    }
  }

  lines.push(`Stakes — ${f.stakes} · ${RUNG_LABEL[f.causal_rung]}`);
  lines.push(deepLink);

  const text = lines.join('\n');
  if (lines.length > MAX_LINES) {
    return {
      ok: false,
      id: f.id,
      code: 'too_long',
      detail: `${lines.length} lines rendered, budget is ${MAX_LINES}`,
    };
  }

  try {
    assertNoConfidenceNumber(text);
  } catch (e) {
    return { ok: false, id: f.id, code: 'confidence_number', detail: message(e) };
  }
  try {
    deps.honesty(text, DIGEST_SURFACE);
  } catch (e) {
    return { ok: false, id: f.id, code: 'honesty', detail: message(e) };
  }
  try {
    deps.causal(text, f.causal_rung);
  } catch (e) {
    return { ok: false, id: f.id, code: 'causal', detail: message(e) };
  }

  return { ok: true, rendered: { id: f.id, lines, text, deepLink } };
}

export interface RenderBatch {
  rendered: RenderedFinding[];
  refused: RenderRefusal[];
}

/** Render many, keeping input order and keeping refusals visible. A refusal
 *  that is merely filtered out is a defect the pipeline never learns about. */
export function renderFindings(inputs: readonly RenderInput[], deps: FormatDeps): RenderBatch {
  assertGatesLive(deps);
  const out: RenderBatch = { rendered: [], refused: [] };
  for (const input of inputs) {
    const r = renderFinding(input, deps);
    if (r.ok) out.rendered.push(r.rendered);
    else out.refused.push(r);
  }
  return out;
}
