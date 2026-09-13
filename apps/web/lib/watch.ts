// Shapes of the console's operational endpoints, as the Watch tab reads them.

export type Fact = { company: string; predicate: string; value: string; url: string | null; span: string | null; since: string; method: string };
export type Finding = { claim: string; so_what: string; subject: string; basis: string; score: string | number; created: string; by: string; url: string | null; span: string | null; supersede_reason: string | null };
export type Pred = { claim: string; p: number | string; resolves: string; resolver: string; author: string };
export type SourceHealth = 'healthy' | 'transient' | 'needs_operator' | 'refused';
export type SourceRow = { name: string; tier: string; last_ok: string | null; fails: number; reason: string | null; detail: string | null; failing_since: string | null; failing_days: number | null; health: SourceHealth };
export type ConsoleState = {
  facts: Fact[]; findings: Finding[]; preds: Pred[]; sources: SourceRow[];
  counts: { signals: number; events: number; entities: number; findings: number; facts: number; cents: string | null; calls: number };
  generated: string;
};
export type Question = { key: string; claim: string; resolve_at: string; yours: number | null; agent: number | null };
export type RunStatus = { running: boolean; stage: Stage | null; lines: string[] };

export const STAGES = ['all', 'collect', 'brain', 'watch', 'reason', 'resolve', 'digest', 'briefing'] as const;
export type Stage = (typeof STAGES)[number];

/** What each stage does — the same lines the worker prints about itself (apps/worker/src/run.ts). */
export const STAGE_INFO: Record<Stage, { name: string; why: string; spends: boolean }> = {
  all: { name: 'Full pass', why: 'All seven stages in order, about 90–150 seconds', spends: true },
  collect: { name: 'Collect', why: 'Free sources into signals, backed off per source', spends: false },
  brain: { name: 'Sync the Brain', why: 'Mirror our own documents so an answer can cite them', spends: false },
  watch: { name: 'Watch competitors', why: 'Read their pages; a change becomes a verified finding', spends: true },
  reason: { name: 'Reason', why: 'Triage what was collected, then synthesise what survives', spends: true },
  resolve: { name: 'Resolve forecasts', why: 'Settle every forecast that came due and score the record', spends: false },
  digest: { name: 'Send the digest', why: 'What earns an interruption, and sending it', spends: false },
  briefing: { name: 'Rebuild briefing', why: 'Regenerate the briefing page from the database — spends nothing', spends: false },
};

export const HEALTH_LABEL: Record<SourceHealth, string> = { needs_operator: 'needs you', refused: 'refused', transient: 'retrying', healthy: 'ok' };

export const days = (n: number | null | undefined) => (n === null || n === undefined ? '' : n === 0 ? 'today' : n === 1 ? '1 day' : `${n} days`);
export const clamp = (s: string | null | undefined, n = 200) => (!s ? '' : s.length <= n ? s : `${s.slice(0, n - 1)}…`);
export const httpUrl = (u: string | null | undefined) => (u && /^https?:\/\//i.test(u) ? u : null);

export type Draft = {
  note?: string;
  recommendations: { action: string; reasoning: string; falsifier: string; basis: string; horizon: string; evidence: string[] }[];
  dropped: { action: string; why: string }[];
  evidence: { id: string; kind: string; text: string; source: string }[];
  costCents: number;
};
export const BASIS: Record<string, string> = {
  inferred_from_sources: 'Rests on something observed',
  exploratory_unverified: 'Rests only on our own calendar and documents',
};

export type ResearchAnswer = {
  summary: string;
  points: { claim: string; citations: { url: string; span: string }[] }[];
  dropped: { claim: string; why: string }[];
  unanswered: string[];
  sources: { url: string; title: string }[];
  queries: string[];
  costCents?: number;
};

/** Colours only the three things worth spotting in a run log. */
export function lineClass(line: string): 'ok' | 'bad' | 'hd' | '' {
  if (/^\s*(ok|✓|=|collected|synced)/.test(line) || /all green/.test(line)) return 'ok';
  if (/FAILED|failed|✗|refused|blocked|error/i.test(line)) return 'bad';
  if (/^[▶━]|^PASS SUMMARY/.test(line)) return 'hd';
  return '';
}

/** The Watch sections, in the order the old dashboard had them. */
export const TABS = [
  { id: 'week', name: 'This week', icon: 'M5 4h14v16H5zM5 9h14M9 4v5' },
  { id: 'research', name: 'Research', icon: 'M11 5a6 6 0 1 0 0 12 6 6 0 0 0 0-12zm9 15-4.5-4.5' },
  { id: 'changed', name: 'What changed', icon: 'M4 12h4l3-7 4 14 3-7h2' },
  { id: 'competitors', name: 'Competitors', icon: 'M4 20V9l8-5 8 5v11M9 20v-6h6v6' },
  { id: 'forecasts', name: 'Forecasts', icon: 'M4 19h16M6 15l4-5 3 3 5-7' },
  { id: 'sources', name: 'Sources', icon: 'M5 6h14M5 12h14M5 18h9' },
] as const;
export type Tab = (typeof TABS)[number]['id'];
