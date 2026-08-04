/**
 * SCOPE-ISOLATED WORKERS.
 *
 * Each worker owns a NAMED tool set and can see no other. The isolation is the
 * point, not tidiness: a worker handed every tool reaches for the wrong one,
 * and its context fills with results nobody asked for. That is how multi-agent
 * research gets simultaneously more expensive and less accurate.
 *
 * Three properties, all structural rather than advisory:
 *
 *   1. tool scope — calling outside the owned set is an error, not a warning.
 *   2. depth cap  — recursion stops at a configured depth, locally, before the
 *                   budget module's global backstop is ever consulted.
 *   3. evidence   — a worker returns EVIDENCE (url + span + observed_at), never
 *                   prose. A summary cannot be checked by L0, so a summary is
 *                   not an acceptable return value. `EvidenceList` says so at
 *                   compile time; a runtime check catches the casts.
 *
 * Compression is deterministic and NEVER splits an evidence span. A half-span
 * cannot be located in its source, so it cannot be verified — it is strictly
 * worse than no span, because it still looks like a citation. We drop whole
 * items instead and report how many. Prose notes, which nothing verifies, are
 * truncated freely.
 *
 * A worker that fails does not fail the run. Outcomes are per-worker.
 */

/* ── tokens & budget ──────────────────────────────────────────────────────── */

/** Rough but stable. A model-specific tokenizer would be more accurate and
 *  would drift; this one cannot, and the budget is a soft envelope anyway. */
export const CHARS_PER_TOKEN = 4;

/** The envelope the brief asks for. 1-2k per worker keeps the synthesis context
 *  bounded even with a dozen workers: the failure this prevents is a synthesis
 *  prompt that no longer fits, discovered at the most expensive tier. */
export const WORKER_TOKEN_BUDGET_MIN = 1_000;
export const WORKER_TOKEN_BUDGET_MAX = 2_000;
export const WORKER_TOKEN_BUDGET_DEFAULT = 1_500;

/** Notes are unverifiable prose, so they get a small fixed slice and are cut
 *  first. Evidence always outranks commentary. */
export const NOTES_TOKEN_CAP = 120;

/** A span shorter than this cannot locate the claim in its source, so it fails
 *  the only job a span has. L0 accepts any non-empty span; we are stricter at
 *  the point of production, where the fix is cheap. */
export const MIN_SPAN_CHARS = 8;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export const clampTokenBudget = (n: number): number =>
  Math.min(WORKER_TOKEN_BUDGET_MAX, Math.max(WORKER_TOKEN_BUDGET_MIN, Math.floor(n)));

/* ── types ────────────────────────────────────────────────────────────────── */

export type ToolName = string;
export type ToolImpl = (input: string, depth: number) => Promise<string>;

export interface WorkerEvidence {
  url: string;
  span: string;
  observed_at: string;
}

/** Non-empty by construction: a worker with nothing to cite has nothing to say. */
export type EvidenceList = readonly [WorkerEvidence, ...WorkerEvidence[]];

export interface WorkerResult {
  evidence: EvidenceList;
  /** Optional commentary. Never a substitute for evidence, freely truncated. */
  notes?: string;
}

export interface Toolbox {
  /** Sorted, so the same worker sees the same list every run. */
  readonly names: readonly ToolName[];
  readonly depth: number;
  call(tool: ToolName, input: string): Promise<string>;
  /** The recursion path. One level deeper; refused past the cap. */
  descend(): Toolbox;
}

export interface WorkerContext {
  readonly workerId: string;
  readonly question: string;
  readonly toolbox: Toolbox;
}

export interface WorkerSpec {
  id: string;
  /** The named tool set this worker owns. It can see no other. */
  tools: readonly ToolName[];
  run(ctx: WorkerContext): Promise<WorkerResult>;
}

export interface CompressionReport {
  budgetTokens: number;
  estimatedTokens: number;
  kept: number;
  dropped: number;
  notesTruncated: boolean;
  /** A single item exceeded the budget on its own. We kept it WHOLE — an
   *  unverifiable half-span is the worse outcome — and say so here. */
  overBudget: boolean;
}

export type WorkerOutcome =
  | {
      status: 'ok';
      workerId: string;
      evidence: readonly WorkerEvidence[];
      notes: string;
      compression: CompressionReport;
    }
  | {
      status: 'rejected';
      workerId: string;
      code: 'no_evidence' | 'invalid_evidence';
      detail: string;
    }
  | {
      status: 'failed';
      workerId: string;
      code: 'tool_scope' | 'tool_depth' | 'threw';
      detail: string;
    };

export interface RunWorkersOptions {
  question: string;
  tools: Readonly<Record<ToolName, ToolImpl>>;
  maxToolDepth: number;
  tokenBudget?: number;
}

export interface RunWorkersResult {
  outcomes: readonly WorkerOutcome[];
  /** Every URL a worker actually retrieved this run. L0 refuses any citation
   *  that is not in this set, so it must come from here and nowhere else. */
  retrievedUrls: readonly string[];
}

export class ToolScopeError extends Error {
  constructor(workerId: string, tool: ToolName, owned: readonly ToolName[]) {
    super(`worker "${workerId}" called "${tool}"; it owns [${owned.join(', ')}]`);
    this.name = 'ToolScopeError';
  }
}

export class ToolDepthError extends Error {
  constructor(workerId: string, depth: number, max: number) {
    super(`worker "${workerId}" reached tool depth ${depth}; cap is ${max}`);
    this.name = 'ToolDepthError';
  }
}

/* ── toolbox ──────────────────────────────────────────────────────────────── */

function makeToolbox(
  workerId: string,
  owned: readonly ToolName[],
  registry: Readonly<Record<ToolName, ToolImpl>>,
  maxDepth: number,
  depth: number,
): Toolbox {
  const names = [...owned].sort();
  return {
    names,
    depth,
    async call(tool, input) {
      if (depth > maxDepth) throw new ToolDepthError(workerId, depth, maxDepth);
      if (!names.includes(tool)) throw new ToolScopeError(workerId, tool, names);
      const impl = registry[tool];
      if (!impl) throw new ToolScopeError(workerId, tool, names);
      return impl(input, depth);
    },
    descend: () => makeToolbox(workerId, owned, registry, maxDepth, depth + 1),
  };
}

/* ── compression ──────────────────────────────────────────────────────────── */

const evidenceTokens = (e: WorkerEvidence): number =>
  estimateTokens(e.url) + estimateTokens(e.span) + estimateTokens(e.observed_at);

function truncateNotes(notes: string, capTokens: number): { text: string; truncated: boolean } {
  if (estimateTokens(notes) <= capTokens) return { text: notes, truncated: false };
  const cut = notes.slice(0, capTokens * CHARS_PER_TOKEN);
  const lastSpace = cut.lastIndexOf(' ');
  return { text: `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`, truncated: true };
}

export interface CompressedResult {
  evidence: readonly WorkerEvidence[];
  notes: string;
  report: CompressionReport;
}

/**
 * Deterministic: dedupe by (url, span) keeping first occurrence, then keep a
 * PREFIX of the worker's own ordering. The worker ranked its findings; we
 * respect that ranking rather than inventing a second one.
 */
export function compressWorkerResult(result: WorkerResult, budgetTokens: number): CompressedResult {
  const notes = truncateNotes(result.notes ?? '', NOTES_TOKEN_CAP);
  const notesTokens = estimateTokens(notes.text);
  const evidenceBudget = Math.max(budgetTokens - notesTokens, 1);

  const seen = new Set<string>();
  const unique: WorkerEvidence[] = [];
  for (const e of result.evidence) {
    const key = `${e.url} ${e.span}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(e);
  }

  const kept: WorkerEvidence[] = [];
  let used = 0;
  for (const e of unique) {
    const t = evidenceTokens(e);
    // Always keep the first item whole, even when it alone blows the budget:
    // truncating it would produce a span nobody can check.
    if (kept.length > 0 && used + t > evidenceBudget) break;
    kept.push(e);
    used += t;
  }

  return {
    evidence: kept,
    notes: notes.text,
    report: {
      budgetTokens,
      estimatedTokens: used + notesTokens,
      kept: kept.length,
      dropped: unique.length - kept.length,
      notesTruncated: notes.truncated,
      overBudget: used + notesTokens > budgetTokens,
    },
  };
}

/* ── validation ───────────────────────────────────────────────────────────── */

const isUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

const isIsoInstant = (raw: string): boolean =>
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(raw) &&
  !Number.isNaN(Date.parse(raw));

/** Returns a human reason, or null when the list is usable. */
export function validateEvidence(items: readonly WorkerEvidence[]): string | null {
  for (const [i, e] of items.entries()) {
    if (!isUrl(e.url)) return `evidence[${i}] url is not an http(s) url: "${e.url}"`;
    if (e.span.trim().length < MIN_SPAN_CHARS) {
      return `evidence[${i}] span is shorter than ${MIN_SPAN_CHARS} chars — too short to locate in its source`;
    }
    if (!isIsoInstant(e.observed_at)) {
      return `evidence[${i}] observed_at is not an ISO instant: "${e.observed_at}"`;
    }
  }
  return null;
}

/* ── the run ──────────────────────────────────────────────────────────────── */

async function runOne(spec: WorkerSpec, opts: RunWorkersOptions): Promise<WorkerOutcome> {
  const budget = clampTokenBudget(opts.tokenBudget ?? WORKER_TOKEN_BUDGET_DEFAULT);
  const toolbox = makeToolbox(spec.id, spec.tools, opts.tools, opts.maxToolDepth, 1);

  let result: WorkerResult;
  try {
    result = await spec.run({ workerId: spec.id, question: opts.question, toolbox });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (err instanceof ToolDepthError) {
      return { status: 'failed', workerId: spec.id, code: 'tool_depth', detail };
    }
    if (err instanceof ToolScopeError) {
      return { status: 'failed', workerId: spec.id, code: 'tool_scope', detail };
    }
    return { status: 'failed', workerId: spec.id, code: 'threw', detail };
  }

  if (result.evidence.length === 0) {
    return {
      status: 'rejected',
      workerId: spec.id,
      code: 'no_evidence',
      detail: 'worker returned prose with no evidence span; a summary cannot be checked by L0',
    };
  }
  const invalid = validateEvidence(result.evidence);
  if (invalid) {
    return { status: 'rejected', workerId: spec.id, code: 'invalid_evidence', detail: invalid };
  }

  const compressed = compressWorkerResult(result, budget);
  return {
    status: 'ok',
    workerId: spec.id,
    evidence: compressed.evidence,
    notes: compressed.notes,
    compression: compressed.report,
  };
}

/**
 * Sorted by worker id and awaited in order: identical inputs must produce a
 * byte-identical result, and concurrent scheduling would put the outcome order
 * at the mercy of whichever mock resolved first.
 */
export async function runWorkers(
  specs: readonly WorkerSpec[],
  opts: RunWorkersOptions,
): Promise<RunWorkersResult> {
  const ordered = [...specs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const outcomes: WorkerOutcome[] = [];
  for (const spec of ordered) outcomes.push(await runOne(spec, opts));

  const urls = new Set<string>();
  for (const o of outcomes) if (o.status === 'ok') for (const e of o.evidence) urls.add(e.url);

  return { outcomes, retrievedUrls: [...urls].sort() };
}
