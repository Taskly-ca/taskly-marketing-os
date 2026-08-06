/**
 * The first run against reality.
 *
 * Everything else in this repo is proven against fixtures and injected ports.
 * This file wires the real modules to the real world — a live RSS fetch, a real
 * robots.txt check, a real Groq call — and asserts the properties the system
 * claims. It is `*.live.test.ts`, so CI never runs it: the deterministic suite
 * stays keyless and this one is opt-in.
 *
 *   collectors → gate (canonical + SimHash) → T1 skim (Groq) → Finding
 *              → L0 (numbers verbatim) → honesty gate → basis rendering
 *
 * What it is really testing is whether the guards fire on data nobody wrote for
 * them. A test corpus is written by someone who knows the check exists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  createRssCollector,
  USER_AGENT,
  parseRobots,
  robotsAllows,
  effectiveDelayMs,
  stripPii,
} from '@tmos/collectors';
import type { CollectorContext, FetchTextResult, RawItem } from '@tmos/collectors';
import { canonicalizeUrl, simhash, isNearDuplicate } from '@tmos/gate';
import { callGroq, createBudgetState } from '@tmos/shared';
import type { BudgetLimits } from '@tmos/shared';
import { assertL0, extractNumbers } from '@tmos/reason';
import { checkHonesty } from '@tmos/guardrails';
import { renderBasis, assertNoConfidenceNumber } from '@tmos/surface';

/* ── environment ──────────────────────────────────────────────────────────── */

function envFromTasklyRepo(): { key: string; model: string } {
  // The key lives in the marketplace repo's .env.local. Read at runtime, never
  // written anywhere, never logged.
  const raw = readFileSync('/Users/nishant/Documents/Taskly/.env.local', 'utf8');
  const pick = (name: string): string => {
    const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
    return (line ?? '').slice(name.length + 1).replace(/^["']|["']$/g, '').trim();
  };
  return { key: pick('GROQ_API_KEY'), model: pick('GROQ_MODEL') || 'llama-3.3-70b-versatile' };
}

const { key: GROQ_KEY, model: GROQ_MODEL } = envFromTasklyRepo();

const LIMITS: BudgetLimits = {
  maxRunTokens: 100_000,
  maxDailyCostCents: 200,
  maxToolDepth: 8,
};

const RUN = 'smoke-run-1';

/** Real network, honest UA. */
const realFetchText = async (
  url: string,
  headers?: Record<string, string>,
): Promise<FetchTextResult> => {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers } });
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k] = v;
  });
  return { status: res.status, body: await res.text(), headers: out };
};

const ctx = (): CollectorContext => ({ fetchText: realFetchText, now: () => new Date() });

/** Real feeds. Several, because a smoke test that depends on one host is
 *  testing that host. */
const FEEDS = [
  'https://news.ycombinator.com/rss',
  'https://feeds.arstechnica.com/arstechnica/index',
  'https://www.theverge.com/rss/index.xml',
];

describe('the pipeline, against the real world', () => {
  it(
    'runs collector → gate → Groq → Finding → L0 → honesty, and the guards fire',
    { timeout: 120_000 },
    async () => {
      expect(GROQ_KEY.length).toBeGreaterThan(20);

      /* ── 1. legal guardrail: robots.txt is a hard gate ──────────────────── */
      const feedUrl = FEEDS[0]!;
      const origin = new URL(feedUrl).origin;
      const robotsRes = await realFetchText(`${origin}/robots.txt`);
      const rules = robotsRes.status === 200 ? parseRobots(robotsRes.body) : null;
      const verdict = rules ? robotsAllows(rules, feedUrl) : { allowed: true as const };
      console.log(
        `\n[1] robots.txt @ ${origin} → ${robotsRes.status}; allows feed: ${verdict.allowed}; ` +
          `honouring ${effectiveDelayMs(rules)}ms between requests`,
      );
      expect(verdict.allowed).toBe(true);

      /* ── 2. collect, for real ───────────────────────────────────────────── */
      let items: RawItem[] = [];
      let used = '';
      for (const url of FEEDS) {
        const result = await createRssCollector(url).collect(ctx());
        if (result.ok && result.items.length > 0) {
          items = result.items;
          used = url;
          break;
        }
        console.log(`[2] ${url} → ${result.ok ? 'ok but empty' : `fail(${result.reason})`}`);
      }
      console.log(`[2] collected ${items.length} items from ${used}`);
      expect(items.length).toBeGreaterThan(0);

      /* ── 3. T0 gate: canonical URL + SimHash near-duplicate ─────────────── */
      const seen = new Map<string, string>();
      const kept: RawItem[] = [];
      let dupes = 0;
      for (const item of items) {
        const canon = item.url ? canonicalizeUrl(item.url) : null;
        if (canon && seen.has(canon)) {
          dupes += 1;
          continue;
        }
        const sig = simhash(`${item.title ?? ''} ${item.body}`);
        const near = [...seen.values()].some((s) => isNearDuplicate(s, sig));
        if (near) {
          dupes += 1;
          continue;
        }
        if (canon) seen.set(canon, sig);
        kept.push(item);
      }
      console.log(`[3] gate: ${items.length} in → ${kept.length} out (${dupes} deduped)`);
      expect(kept.length).toBeGreaterThan(0);

      // PII stripping actually ran at ingest.
      const joined = kept.map((k) => `${k.title ?? ''} ${k.body}`).join(' ');
      expect(stripPii(joined)).toBe(joined);

      /* ── 4. T1 skim — a real model call, through the budget chokepoint ──── */
      const state = createBudgetState();
      const candidates = kept.slice(0, 8);
      const listing = candidates
        .map((c, i) => `${i}. ${c.title ?? '(untitled)'} — ${c.body.slice(0, 200)}`)
        .join('\n');

      const skim = await callGroq(
        {
          model: GROQ_MODEL,
          json: true,
          maxTokens: 700,
          messages: [
            {
              role: 'system',
              content:
                'You score market signals for Taskly, a home-services task marketplace in the Greater Toronto Area. ' +
                'Materiality means "would this change what Taskly does?", NOT "is this interesting?". ' +
                'Most technology news is materiality 0.0-0.2 for a local services marketplace; say so. ' +
                'Return JSON: {"items":[{"i":<index>,"materiality":<0..1>,"why":"<12 words max>"}]}',
            },
            { role: 'user', content: listing },
          ],
        },
        { apiKey: GROQ_KEY, state, limits: LIMITS, runId: RUN },
      );

      expect(skim.ok, skim.ok ? '' : JSON.stringify(skim)).toBe(true);
      if (!skim.ok) return;
      console.log(
        `[4] Groq ${skim.model}: ${skim.usage.promptTokens}+${skim.usage.completionTokens} tok, ` +
          `${skim.usage.costCents.toFixed(4)}¢, ${skim.latencyMs}ms`,
      );

      const parsed = JSON.parse(skim.text) as {
        items?: Array<{ i?: number; materiality?: number; why?: string }>;
      };
      const scored = (parsed.items ?? []).filter(
        (r) => typeof r.i === 'number' && typeof r.materiality === 'number',
      );
      expect(scored.length).toBeGreaterThan(0);
      const ranked = [...scored].sort((a, b) => b.materiality! - a.materiality!);
      console.log(
        `[4] top: ${ranked
          .slice(0, 3)
          .map((r) => `#${r.i}=${r.materiality!.toFixed(2)} (${r.why})`)
          .join(' · ')}`,
      );

      // The budget chokepoint actually accounted for it.
      expect(state.dailyCostCents).toBeGreaterThan(0);
      console.log(`[4] budget: ${state.dailyCostCents.toFixed(4)}¢ of ${LIMITS.maxDailyCostCents}¢`);

      /* ── 5. L0 on a REAL claim built from a REAL span ───────────────────── */
      const top = candidates[ranked[0]!.i!]!;
      const span = `${top.title ?? ''} ${top.body}`.trim().slice(0, 600);
      const url = top.url ?? used;
      const retrieved = [url];

      const honest = assertL0({
        claim: `${top.title ?? 'Untitled'}`,
        evidence: [
          { signal_id: null, fact_id: null, source_url: url, span, observed_at: new Date().toISOString() },
        ],
        retrievedUrls: retrieved,
      });
      console.log(
        `[5] L0 on the real headline: ${honest.ok ? 'PASS' : 'FAIL'} ` +
          `(numbers in claim: ${JSON.stringify(extractNumbers(top.title ?? ''))})`,
      );
      expect(honest.ok).toBe(true);

      // Now the part that matters: fabricate a number that is NOT in the span
      // and confirm L0 catches it on data nobody wrote for the test.
      const fabricated = assertL0({
        claim: `${top.title ?? 'Untitled'} — prices rose 37.4% and $12,999 was spent`,
        evidence: [
          { signal_id: null, fact_id: null, source_url: url, span, observed_at: new Date().toISOString() },
        ],
        retrievedUrls: retrieved,
      });
      console.log(
        `[5] L0 on a fabricated number: ${fabricated.ok ? 'PASS (BAD)' : 'CAUGHT'} → ` +
          fabricated.violations.map((v) => `${v.code}:${v.token}`).join(', '),
      );
      expect(fabricated.ok).toBe(false);
      expect(fabricated.violations.some((v) => v.code === 'number_not_in_span')).toBe(true);

      // And a citation to a URL we never retrieved.
      const uncited = assertL0({
        claim: 'Something happened',
        evidence: [
          {
            signal_id: null,
            fact_id: null,
            source_url: 'https://invented.example/report',
            span: 'x',
            observed_at: new Date().toISOString(),
          },
        ],
        retrievedUrls: retrieved,
      });
      expect(uncited.violations.some((v) => v.code === 'url_not_retrieved')).toBe(true);
      console.log('[5] L0 caught an uncited source too');

      /* ── 6. honesty gate on generated prose ─────────────────────────────── */
      const clean = checkHonesty(
        'Jiffy expanded into snow removal. Taskly holds the money until the poster confirms.',
        'poster_facing',
      );
      const dirty = checkHonesty(
        'Every Tasker is background-checked and covered by $2M liability insurance.',
        'poster_facing',
      );
      console.log(
        `[6] honesty: clean=${clean.ok}, dirty=${dirty.ok} → ` +
          dirty.violations.map((v) => `"${v.match}"`).join(', '),
      );
      expect(clean.ok).toBe(true);
      expect(dirty.ok).toBe(false);

      /* ── 7. surface: basis, never a confidence number ───────────────────── */
      const rendered = renderBasis('inferred_from_sources', 1);
      console.log(`[7] basis rendered: "${rendered}"`);
      expect(() => assertNoConfidenceNumber(rendered)).not.toThrow();
      expect(() => assertNoConfidenceNumber('87% confident this matters')).toThrow();

      console.log(
        `\n✅ end-to-end: ${items.length} real items → ${kept.length} through the gate → ` +
          `1 Groq call (${state.dailyCostCents.toFixed(4)}¢) → L0 caught a fabrication → ` +
          `honesty gate caught a false trust claim.\n`,
      );
    },
  );

  it('the budget chokepoint refuses when the daily ceiling is exhausted', { timeout: 30_000 }, async () => {
    const state = createBudgetState();
    state.dailyCostCents = 999;
    const r = await callGroq(
      { model: GROQ_MODEL, messages: [{ role: 'user', content: 'hi' }] },
      { apiKey: GROQ_KEY, state, limits: LIMITS, runId: RUN },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'blocked') {
      console.log(`[budget] refused before the request: ${r.outcome}`);
      expect(r.outcome).toBe('blocked_daily_cost');
    }
  });

  it('a bad key fails loudly rather than returning empty', { timeout: 30_000 }, async () => {
    const state = createBudgetState();
    const r = await callGroq(
      { model: GROQ_MODEL, messages: [{ role: 'user', content: 'hi' }], maxTokens: 5 },
      { apiKey: 'gsk_invalid_key_for_testing', state, limits: LIMITS, runId: RUN },
    );
    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'http') {
      console.log(`[auth] bad key → HTTP ${r.status}, spend still accounted: ${r.usage.costCents > 0}`);
      expect(r.status).toBe(401);
    }
  });
});
