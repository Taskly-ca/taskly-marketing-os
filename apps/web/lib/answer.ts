/**
 * The answer engine, client side: the SSE contract (packages/research/src/events.ts
 * plus the route's own `epilogue` and `unused`) and a pure reducer that turns
 * frames into one Turn. Live streams and replayed threads go through the same
 * reducer, so a stored answer and a fresh one cannot drift apart on screen.
 */

export type Mode = 'web' | 'grounded' | 'verified' | 'deep';
export const MODE_ORDER: Mode[] = ['web', 'grounded', 'verified', 'deep'];

export const MODES: Record<Mode, { name: string; short: string; about: string; placeholder: string; sub: string }> = {
  web: {
    name: 'Web', short: 'Open web, streams as it writes',
    about: 'Answers from pages fetched off the open web this run. Streams as it writes; each sentence is checked a beat behind.',
    placeholder: 'Ask about a market, a competitor, or a call you have to make',
    sub: 'Every figure comes back with the exact sentence it came from, on a page we actually fetched. What could not be sourced is listed, not smoothed over.',
  },
  grounded: {
    name: 'Grounded', short: 'Our own evidence only',
    about: 'Answers from our evidence only — competitor facts we read off their pages, our own documents, and the prediction ledger. No web search.',
    placeholder: 'Ask what we already know — competitors, our decisions, our forecasts',
    sub: 'Only what we have on record: competitor pages as we read them, our own documents, and forecasts we wrote down. Nothing is searched.',
  },
  verified: {
    name: 'Verified', short: 'Strict gate before anything shows',
    about: 'The strict gate: nothing is shown until the whole answer has passed a verbatim check. Slower, and the right tool when the answer feeds a decision.',
    placeholder: 'Ask something a decision will rest on',
    sub: 'Nothing appears until the whole answer has passed a word-for-word check against its sources. Slower, and built for decisions.',
  },
  deep: {
    name: 'Deep', short: '2–4 min, plan first, you can stop it',
    about: 'Two to four minutes. Breaks the question into sub-questions, publishes the plan before it searches anything, then reports what each step actually proved. It may ask you something first.',
    placeholder: 'Ask a bigger question — it will plan the research first',
    sub: 'It breaks the question into steps and shows you the plan before searching anything, then what each step proved, so you can stop it early.',
  },
};

export const SUGGESTED: Record<Mode, string[]> = {
  web: [
    'Should we run a snow-removal campaign in Toronto this October?',
    'What are Jiffy and TaskRabbit charging homeowners in the GTA right now?',
    'Which task category has the least competition in Toronto?',
    'What changed on our competitors’ pricing pages this month?',
  ],
  grounded: [
    'What do we know about Jiffy?',
    'What is our commission rate, and where is it written down?',
    'What did we decide about the poster platform fee?',
    'What have we forecast about competitor pricing?',
  ],
  verified: [],
  deep: [
    'Where should Taskly spend its first $5,000 of marketing in the GTA?',
    'Which Tasker skills are undersupplied in Toronto this winter, and why?',
    'How do Canadian task marketplaces win their first thousand Taskers?',
    'What would it take to launch Taskly in a second Canadian city next year?',
  ],
};
SUGGESTED.verified = SUGGESTED.web;

export type Phase = 'planning' | 'searching' | 'reading' | 'attributing' | 'writing' | 'checking' | 'done';
export type SourceKind = 'web' | 'world' | 'brain' | 'ledger';
export type Source = { i: number; url: string; title: string; domain: string; kind: SourceKind; observedAt?: string };
export type Span = { id: number; sourceIndex: number; quote: string };
export type Sentence = { n: number; text: string; verdict: 'pending' | 'confirmed' | 'flagged' | 'stored'; why?: string };
export type PlanStep = { n: number; question: string; why: string };
export type StepState = 'pending' | 'running' | 'done' | 'skipped';
export type DeepStep = PlanStep & { state: StepState; detail?: string; found?: number; added?: boolean; dropped?: boolean; was?: { question: string; outcome: string }[] };
export type Reflection = { after: number; stillOpen: string[]; note: string; stop?: string };
export type ActivityItem =
  | { kind: 'status'; at: number; phase: Phase; detail?: string }
  | { kind: 'plan'; at: number; revised: boolean; because?: string; changes?: string }
  | { kind: 'step'; at: number; n: number; state: StepState; detail?: string; found?: number }
  | { kind: 'reflect'; at: number; r: Reflection }
  | { kind: 'clarify'; at: number }
  | { kind: 'error'; at: number; message: string };

export type Turn = {
  key: string;
  question: string;
  mode: Mode;
  answers?: string[];               // clarify replies this run was started with
  asked?: string[];                 // the clarifying questions those replies answer
  startedAt: number;
  doneAt?: number;
  live: boolean;
  stored?: boolean;                 // replayed from the thread store
  phase?: Phase;
  phaseDetail?: string;
  activity: ActivityItem[];
  sources: Source[];
  spans: Span[];
  sentences: Sentence[];
  note?: string;                    // a stored body with no prose, or epilogue.note
  unanswered?: string[];
  related?: string[];
  dropped?: { claim: string; why: string }[];
  unused?: { dropped: { span: string; why: string }[]; expectations: { id: string; locator: string; title: string; claim: string; p: number; resolveAt: string }[] };
  plan?: DeepStep[];
  planRevisions: number;
  reflections: Reflection[];
  clarify?: { questions: string[]; because: string };
  reAsked?: boolean;
  error?: string;
  stopped?: boolean;
  costCents?: number;
  flagged?: number;
  messageId?: string | null;
  seq?: number;
};

export const newTurn = (question: string, mode: Mode, answers?: string[]): Turn => ({
  key: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
  question, mode, answers, startedAt: Date.now(), live: true, activity: [], sources: [], spans: [], sentences: [], planRevisions: 0, reflections: [],
});

const KINDS = new Set(['web', 'world', 'brain', 'ledger']);
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
/** Page titles arrive with HTML entities still in them (“&ndash;”); show the character. */
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
  e[0] === '#' ? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);
const kindOf = (k: unknown): SourceKind => (typeof k === 'string' && KINDS.has(k) ? (k as SourceKind) : 'web');

export type Frame = { event: string; data: unknown };

/** Applies one SSE frame. Returns a new Turn; never mutates. */
export function reduce(turn: Turn, { event, data }: Frame): Turn {
  const at = Date.now();
  const d = (data ?? {}) as Record<string, unknown>;
  switch (event) {
    case 'status': {
      const phase = d['phase'] as Phase;
      const detail = typeof d['detail'] === 'string' ? d['detail'] : undefined;
      return { ...turn, phase, phaseDetail: detail, activity: [...turn.activity, { kind: 'status', at, phase, detail }] };
    }
    case 'source': {
      const s: Source = { i: Number(d['i']), url: String(d['url'] ?? ''), title: decode(String(d['title'] ?? '')), domain: String(d['domain'] ?? ''), kind: kindOf(d['kind']), observedAt: typeof d['observedAt'] === 'string' ? d['observedAt'] : undefined };
      if (turn.sources.some(x => x.i === s.i)) return turn;
      return { ...turn, sources: [...turn.sources, s] };
    }
    case 'span': {
      const s: Span = { id: Number(d['id']), sourceIndex: Number(d['sourceIndex']), quote: String(d['quote'] ?? '') };
      return { ...turn, spans: [...turn.spans.filter(x => x.id !== s.id), s] };
    }
    case 'delta': {
      const n = Number(d['n']);
      const text = String(d['text'] ?? '');
      const i = turn.sentences.findIndex(s => s.n === n);
      const sentences = i === -1
        ? [...turn.sentences, { n, text, verdict: 'pending' as const }].sort((a, b) => a.n - b.n)
        : turn.sentences.map((s, j) => (j === i ? { ...s, text: s.text + text } : s));
      return { ...turn, sentences };
    }
    case 'sentence': {
      const n = Number(d['n']);
      const verdict: Sentence['verdict'] = d['verdict'] === 'flagged' ? 'flagged' : 'confirmed';
      const why = typeof d['why'] === 'string' ? d['why'] : undefined;
      const exists = turn.sentences.some(s => s.n === n);
      const sentences = exists ? turn.sentences.map(s => (s.n === n ? { ...s, verdict, why } : s)) : [...turn.sentences, { n, text: '', verdict, why }];
      return { ...turn, sentences };
    }
    case 'unused':
      return { ...turn, unused: { dropped: (d['dropped'] as never[]) ?? [], expectations: (d['expectations'] as never[]) ?? [] } };
    case 'epilogue':
      return {
        ...turn,
        unanswered: Array.isArray(d['unanswered']) ? (d['unanswered'] as string[]) : turn.unanswered,
        related: Array.isArray(d['related']) ? (d['related'] as string[]) : turn.related,
        note: typeof d['note'] === 'string' && d['note'] ? d['note'] : turn.note,
      };
    case 'plan':
      return applyPlan(turn, d, at);
    case 'step': {
      const n = Number(d['n']);
      const state = String(d['state']) as StepState;
      const detail = typeof d['detail'] === 'string' ? d['detail'] : undefined;
      const found = typeof d['found'] === 'number' ? d['found'] : undefined;
      const plan = turn.plan ?? [];
      const has = plan.some(s => s.n === n);
      const next = has
        ? plan.map(s => (s.n === n ? { ...s, state, detail: detail ?? s.detail, found: found ?? s.found } : s))
        : [...plan, { n, question: detail ?? `Step ${n}`, why: 'Not in the published plan', state, detail, found }];
      return { ...turn, plan: next, activity: [...turn.activity, { kind: 'step', at, n, state, detail, found }] };
    }
    case 'reflect': {
      const r: Reflection = { after: Number(d['after']), stillOpen: (d['stillOpen'] as string[]) ?? [], note: String(d['note'] ?? ''), stop: typeof d['stop'] === 'string' ? d['stop'] : undefined };
      return { ...turn, reflections: [...turn.reflections, r], activity: [...turn.activity, { kind: 'reflect', at, r }] };
    }
    case 'clarify': {
      const questions = (d['questions'] as string[]) ?? [];
      const because = String(d['because'] ?? '');
      const reAsked = !!turn.asked && JSON.stringify(questions) === JSON.stringify(turn.asked);
      return { ...turn, clarify: { questions, because }, reAsked, live: false, activity: [...turn.activity, { kind: 'clarify', at }] };
    }
    case 'done':
      return {
        ...turn, live: false, doneAt: at, phase: 'done',
        costCents: Number(d['costCents'] ?? 0), flagged: Number(d['flagged'] ?? 0), messageId: (d['messageId'] as string | null) ?? null,
      };
    case 'error_msg': {
      const message = typeof data === 'string' ? data : String(d['message'] ?? 'The run stopped.');
      return { ...turn, live: false, doneAt: at, error: message, activity: [...turn.activity, { kind: 'error', at, message }] };
    }
    default:
      return turn; // an event this page does not know yet is ignored, as SSE does
  }
}

/** A revision changes the plan on screen; it never replaces it. Reworded steps keep their old question, struck. */
function applyPlan(turn: Turn, d: Record<string, unknown>, at: number): Turn {
  const steps = ((d['steps'] as PlanStep[]) ?? []).map(s => ({ n: Number(s.n), question: String(s.question), why: String(s.why ?? '') }));
  const because = typeof d['revisedBecause'] === 'string' ? d['revisedBecause'] : undefined;
  if (!turn.plan || turn.plan.length === 0 || !because) {
    return { ...turn, plan: steps.map(s => ({ ...s, state: 'pending' })), activity: [...turn.activity, { kind: 'plan', at, revised: false }] };
  }
  let reworded = 0, added = 0, dropped = 0;
  const byN = new Map(turn.plan.map(s => [s.n, s]));
  const next: DeepStep[] = steps.map(s => {
    const old = byN.get(s.n);
    if (!old) { added++; return { ...s, state: 'pending', added: true }; }
    byN.delete(s.n);
    if (old.question === s.question) return { ...old, why: s.why, dropped: false };
    reworded++;
    const outcome = old.state === 'done' ? (old.found ? `+${old.found} proved` : 'nothing proved') : old.state;
    return { ...s, state: 'pending', was: [{ question: old.question, outcome }, ...(old.was ?? [])] };
  });
  for (const left of byN.values()) { dropped++; next.push({ ...left, dropped: true }); }
  next.sort((a, b) => a.n - b.n);
  const changes = [reworded && `reworded ${reworded}`, added && `added ${added}`, dropped && `dropped ${dropped}`].filter(Boolean).join(' · ');
  return { ...turn, plan: next, planRevisions: turn.planRevisions + 1, activity: [...turn.activity, { kind: 'plan', at, revised: true, because, changes }] };
}

/* ── rendering helpers ─────────────────────────────────────────────────── */

type Piece = { t: 'text'; text: string } | { t: 'cite'; n: number };
const MARKER = /\[(\d{1,3}(?:\s*[,;]\s*\d{1,3})*)\]/g;

/** Splits sentence text into prose and citation markers; an unclosed `[` at the end is held back until it closes. */
export function pieces(text: string, live: boolean): Piece[] {
  const src = live ? text.replace(/\[[\d,;\s]{0,32}$/, '') : text;
  const out: Piece[] = [];
  let last = 0;
  for (const m of src.matchAll(MARKER)) {
    const before = src.slice(last, m.index).replace(/[\s\u202f]$/, '');
    if (before) out.push({ t: 'text', text: before });
    for (const part of (m[1] ?? '').split(/[,;]/)) out.push({ t: 'cite', n: Number(part.trim()) });
    last = (m.index ?? 0) + m[0].length;
  }
  const rest = src.slice(last);
  if (rest) out.push({ t: 'text', text: rest });
  return out;
}

export const stripMarkers = (s: string) => s.replace(MARKER, '').replace(/\s+([.,;:!?])/g, '$1').trim();

export function sourceForCite(turn: Turn, n: number): { source?: Source; span?: Span } {
  const span = turn.spans.find(s => s.id === n);
  const source = span ? turn.sources.find(s => s.i === span.sourceIndex) : undefined;
  return { span, source };
}

export const KIND_INFO: Record<SourceKind, { group: string; hint?: string; glyph: string; noun: [string, string]; linkable: boolean; says: string }> = {
  web: { group: 'From the open web', glyph: '↗', noun: ['page', 'pages'], linkable: true, says: 'a page off the open web' },
  world: { group: 'Competitor pages, as we read them', hint: 'What their page said on the date we read it. The link opens their page as it stands today, which may differ.', glyph: '◉', noun: ['competitor page', 'competitor pages'], linkable: true, says: 'a competitor’s page, as we read it on a date' },
  brain: { group: 'Our own documents', hint: 'Documents in our own vault — this is us citing ourselves. Nothing outside Taskly says them.', glyph: '§', noun: ['document of ours', 'documents of ours'], linkable: false, says: 'a document we wrote' },
  ledger: { group: 'Forecasts we recorded', hint: 'What we expect, written down before the fact. Not measurements, and not things that have happened.', glyph: '~', noun: ['forecast', 'forecasts'], linkable: false, says: 'a forecast — what we expect, never what we measured' },
};
export const KIND_ORDER: SourceKind[] = ['web', 'world', 'brain', 'ledger'];

const PHASE_LABEL: Record<Phase, string> = {
  planning: 'Planning searches', searching: 'Searching the web', reading: 'Reading sources', attributing: 'Finding quotable spans',
  writing: 'Writing', checking: 'Checking every figure', done: 'Done',
};
const PHASE_LABEL_GROUNDED: Partial<Record<Phase, string>> = {
  planning: 'Planning what to look up', searching: 'Searching our own records', reading: 'Reading our own records', attributing: 'Finding quotable passages',
};
export const phaseLabel = (turn: Turn, phase: Phase) =>
  (turn.mode === 'grounded' && turn.sources.some(s => s.kind !== 'web') ? PHASE_LABEL_GROUNDED[phase] : undefined) ?? PHASE_LABEL[phase];

export const safeUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; } };

/* ── replay ────────────────────────────────────────────────────────────── */

export type StoredMessage = {
  id: string; seq: number; role: 'user' | 'assistant'; body: string; mode: 'fast' | 'verified' | 'grounded' | 'deep' | null;
  costCents: number; createdAt: string;
  answer: { dropped?: { claim: string; why: string }[]; unanswered?: string[]; sources?: { url: string; title: string }[] } | null;
  citations: { ordinal: number; sourceUrl: string; span: string; title: string | null }[];
};
export type ThreadDetail = { id: string; title: string; messages: StoredMessage[] };

const storedMode = (m: StoredMessage['mode']): Mode => (m === 'verified' || m === 'grounded' || m === 'deep' ? m : 'web');
const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u.split(' § ')[0] ?? u; } };
const guessKind = (u: string): SourceKind => (safeUrl(u) ? 'web' : /ledger|forecast|prediction/i.test(u) ? 'ledger' : 'brain');

/** Rebuilds turns from stored messages. Verdicts are not persisted, so every sentence reads as `stored`. */
export function replay(detail: ThreadDetail): Turn[] {
  const turns: Turn[] = [];
  let question = '';
  for (const m of detail.messages) {
    if (m.role === 'user') { question = m.body; continue; }
    const t = newTurn(question, storedMode(m.mode));
    t.key = m.id; t.live = false; t.stored = true; t.startedAt = t.doneAt = Date.parse(m.createdAt);
    t.messageId = m.id; t.seq = m.seq; t.costCents = m.costCents;
    const urls: string[] = [];
    for (const u of [...(m.answer?.sources ?? []).map(s => s.url), ...m.citations.map(c => c.sourceUrl)]) if (u && !urls.includes(u)) urls.push(u);
    t.sources = urls.map((url, i) => {
      const title = m.citations.find(c => c.sourceUrl === url)?.title ?? m.answer?.sources?.find(s => s.url === url)?.title ?? domainOf(url);
      return { i: i + 1, url, title: decode(title), domain: domainOf(url), kind: guessKind(url) };
    });
    t.spans = m.citations.map(c => ({ id: c.ordinal, sourceIndex: urls.indexOf(c.sourceUrl) + 1, quote: c.span }));
    const hasMarkers = /\[\d{1,3}\]/.test(m.body) || m.citations.length > 0;
    if (hasMarkers) {
      const parts = m.body.match(/[^.!?]+(?:[.!?]+(?:\s*\[[\d,;\s]+\])*)\s*|[^.!?]+$/g) ?? [m.body];
      t.sentences = parts.map((text, n): Sentence => ({ n, text, verdict: 'stored' }));
    } else {
      t.note = m.body;
    }
    t.dropped = m.answer?.dropped?.length ? m.answer.dropped : undefined;
    t.unanswered = m.answer?.unanswered?.length ? m.answer.unanswered : undefined;
    turns.push(t);
  }
  if (question && (turns.length === 0 || detail.messages.at(-1)?.role === 'user')) {
    const t = newTurn(question, 'web'); t.live = false; t.stored = true; t.note = 'This question was saved without an answer — the run did not finish. Ask it again to re-run it.';
    turns.push(t);
  }
  return turns;
}

/* ── copy ──────────────────────────────────────────────────────────────── */

export function plainAnswer(turn: Turn, withSources: boolean): string {
  const raw = turn.sentences.map(s => s.text).join('');
  const prose = (withSources ? raw.trim() : stripMarkers(raw)) || turn.note || '';
  if (!withSources) return prose;
  const lines = [`Q: ${turn.question}`, '', prose];
  if (turn.plan?.length) {
    lines.push('', 'Research plan:');
    for (const s of turn.plan) lines.push(`  ${s.n}. ${s.question} — ${s.dropped ? 'dropped' : s.state === 'done' ? (s.found ? `+${s.found} proved` : 'nothing proved') : s.state}`);
  }
  if (turn.spans.length) {
    lines.push('', 'Sources:');
    for (const sp of [...turn.spans].sort((a, b) => a.id - b.id)) {
      const src = turn.sources.find(s => s.i === sp.sourceIndex);
      lines.push(`  [${sp.id}] ${src?.title ?? ''} — ${src?.url ?? ''}`, `      “${sp.quote}”`);
    }
  }
  const flagged = turn.sentences.filter(s => s.verdict === 'flagged');
  if (flagged.length) {
    lines.push('', 'Could not be confirmed:');
    for (const s of flagged) lines.push(`  • ${stripMarkers(s.text)}${s.why ? ` (${s.why})` : ''}`);
  }
  return lines.join('\n');
}
