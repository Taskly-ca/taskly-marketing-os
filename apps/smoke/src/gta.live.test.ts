/**
 * The GTA watchlist run — the engine pointed at its actual market.
 *
 * The HN smoke test proved the wiring. This proves the JUDGEMENT: given real
 * signals about the market Taskly operates in, does the pipeline surface the
 * few that matter and suppress the rest?
 *
 * The interesting number here is not how much it finds. It is how much it
 * throws away — cross-query duplicates at the gate, then immaterial items at
 * T1. A system that forwards everything it collects has not helped anyone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

import { createRssCollector, USER_AGENT } from '@tmos/collectors';
import type { CollectorContext, FetchTextResult, RawItem } from '@tmos/collectors';
import { canonicalizeUrl, simhash, isNearDuplicate, registrableDomain } from '@tmos/gate';
import { callGroq, createBudgetState } from '@tmos/shared';
import type { BudgetLimits } from '@tmos/shared';
import { assertL0 } from '@tmos/reason';
import { checkHonesty } from '@tmos/guardrails';
import { renderBasis, assertNoConfidenceNumber } from '@tmos/surface';
import { GTA_WATCHLIST, splitGoogleNewsTitle, sameEvent } from './watchlist.js';

const env = (name: string, fallback = ''): string => {
  const raw = readFileSync('/Users/nishant/Documents/Taskly/.env.local', 'utf8');
  const line = raw.split('\n').find((l) => l.startsWith(`${name}=`));
  return (
    (line ?? '')
      .slice(name.length + 1)
      .replace(/^["']|["']$/g, '')
      .trim() || fallback
  );
};

const GROQ_KEY = env('GROQ_API_KEY');
const GROQ_MODEL = env('GROQ_MODEL', 'llama-3.3-70b-versatile');
const RUN = 'gta-watchlist-1';

const LIMITS: BudgetLimits = { maxRunTokens: 200_000, maxDailyCostCents: 200, maxToolDepth: 8 };

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

interface Signal {
  query: string;
  title: string;
  publisher: string | null;
  url: string;
  body: string;
  sig: string;
  publishedAt: string | null;
  ageDays: number | null;
}

/**
 * How old a signal may be and still be worth an interruption.
 *
 * Google News answers a QUERY, not a feed — it happily returns the best match
 * from two years ago. The first run of this watchlist surfaced the Intact/Jiffy
 * acquisition as a live finding; it happened in November 2024. True, material,
 * and 21 months late. `stale` is already a dismissal reason in the taxonomy;
 * this is the filter that stops a human having to apply it by hand.
 */
const MAX_AGE_DAYS = 45;

describe('the GTA watchlist, live', () => {
  it(
    'collects the real market, collapses duplicates, and forwards only what matters',
    { timeout: 180_000 },
    async () => {
      /* ── collect every query ────────────────────────────────────────────── */
      const raw: Array<{ query: string; item: RawItem }> = [];
      for (const q of GTA_WATCHLIST) {
        const r = await createRssCollector(q.url, q.id).collect(ctx());
        if (!r.ok) {
          console.log(`  ✗ ${q.id}: fail(${r.reason}) — ${r.detail.slice(0, 80)}`);
          continue;
        }
        console.log(
          `  ${q.id.padEnd(24)} ${String(r.items.length).padStart(3)} items — ${q.question}`,
        );
        for (const item of r.items) raw.push({ query: q.id, item });
      }
      expect(raw.length).toBeGreaterThan(0);

      /* ── T0 gate: canonical URL, then SimHash across ALL queries ────────── */
      const kept: Signal[] = [];
      const byUrl = new Set<string>();
      let urlDupes = 0;
      let nearDupes = 0;
      let eventDupes = 0;
      let stale = 0;

      for (const { query, item } of raw) {
        const canon = item.url ? canonicalizeUrl(item.url) : null;
        if (canon && byUrl.has(canon)) {
          urlDupes += 1;
          continue;
        }
        const { title, publisher } = splitGoogleNewsTitle(item.title ?? '');
        const sig = simhash(title);
        if (kept.some((k) => isNearDuplicate(k.sig, sig))) {
          nearDupes += 1;
          continue;
        }
        if (kept.some((k) => sameEvent(k.title, title))) {
          eventDupes += 1;
          continue;
        }
        const publishedAt = item.publishedAt;
        const ageDays = publishedAt
          ? Math.floor((Date.now() - new Date(publishedAt).getTime()) / 86_400_000)
          : null;
        if (ageDays !== null && ageDays > MAX_AGE_DAYS) {
          stale += 1;
          continue;
        }
        if (canon) byUrl.add(canon);
        kept.push({
          query,
          title,
          publisher,
          url: item.url ?? '',
          body: item.body,
          sig,
          publishedAt,
          ageDays,
        });
      }

      const pct = ((1 - kept.length / raw.length) * 100).toFixed(0);
      console.log(
        `\n[gate] ${raw.length} collected → ${kept.length} kept — ${pct}% dropped\n` +
          `       ${urlDupes} same-URL · ${nearDupes} near-duplicate text · ` +
          `${eventDupes} same EVENT (different publisher) · ${stale} older than ${MAX_AGE_DAYS}d`,
      );
      expect(kept.length).toBeLessThan(raw.length);

      const publishers = new Set(kept.map((k) => k.publisher).filter(Boolean));
      console.log(`[gate] ${publishers.size} distinct publishers across the surviving set`);

      /* ── T1 skim: is any of this material to Taskly? ────────────────────── */
      const state = createBudgetState();
      const batch = kept.slice(0, 40);
      const listing = batch.map((s, i) => `${i}. [${s.query}] ${s.title}`).join('\n');

      const skim = await callGroq(
        {
          model: GROQ_MODEL,
          json: true,
          maxTokens: 2000,
          messages: [
            {
              role: 'system',
              content: [
                'You triage market signals for Taskly: a home-services task marketplace in the Greater Toronto Area.',
                'Customers post tasks; vetted Taskers make offers; Taskly holds the money until the customer confirms.',
                'Taskly takes 20% from the Tasker and a small platform fee from the poster.',
                '',
                'Score MATERIALITY 0..1 = "would this change what Taskly does in the next 90 days?"',
                'NOT "is this interesting". Be harsh. Most news is 0.0-0.2 and you should say so.',
                '  0.8-1.0 a direct competitor changed price/coverage/model in the GTA, or a regulation lands on gig labour in Ontario',
                '  0.4-0.7 adjacent market shift, supply-side labour change in Ontario, a competitor raised money',
                '  0.0-0.3 general business news, other geographies, listicles, SEO filler',
                'Also tag stakes: low | medium | high (high = legal/regulatory exposure).',
                'Return JSON: {"items":[{"i":<index>,"materiality":<0..1>,"stakes":"low|medium|high","so_what":"<15 words: what Taskly would DO>"}]}',
              ].join('\n'),
            },
            { role: 'user', content: listing },
          ],
        },
        { apiKey: GROQ_KEY, state, limits: LIMITS, runId: RUN },
      );

      expect(skim.ok, skim.ok ? '' : JSON.stringify(skim).slice(0, 300)).toBe(true);
      if (!skim.ok) return;

      console.log(
        `\n[T1] ${skim.model}: ${skim.usage.promptTokens}+${skim.usage.completionTokens} tok, ` +
          `${skim.usage.costCents.toFixed(4)}¢, ${skim.latencyMs}ms for ${batch.length} signals`,
      );

      const parsed = JSON.parse(skim.text) as {
        items?: Array<{ i?: number; materiality?: number; stakes?: string; so_what?: string }>;
      };
      const scored = (parsed.items ?? []).filter(
        (r): r is { i: number; materiality: number; stakes?: string; so_what?: string } =>
          typeof r.i === 'number' && typeof r.materiality === 'number' && !!batch[r.i],
      );
      expect(scored.length).toBeGreaterThan(0);

      const GATE = 0.4;
      const above = scored
        .filter((s) => s.materiality >= GATE)
        .sort((a, b) => b.materiality - a.materiality);
      const dist = [0, 0, 0, 0, 0];
      for (const s of scored) dist[Math.min(4, Math.floor(s.materiality * 5))]! += 1;
      console.log(
        `[T1] materiality spread: ` +
          `0-.2:${dist[0]} .2-.4:${dist[1]} .4-.6:${dist[2]} .6-.8:${dist[3]} .8-1:${dist[4]}  ` +
          `→ ${above.length} of ${scored.length} clear the ${GATE} gate`,
      );

      /* ── what a human would actually see ────────────────────────────────── */
      if (above.length === 0) {
        // The quiet-week state from Part 6: silence is a claim, not an absence.
        console.log(
          `\n📭 QUIET: nothing cleared the bar. ${raw.length} signals examined, ` +
            `${kept.length} distinct, 0 material. This is a legible result, not a broken run.`,
        );
      } else {
        console.log(
          `\n📬 DIGEST — top ${Math.min(3, above.length)} of ${scored.length} signals:\n`,
        );
        for (const s of above.slice(0, 3)) {
          const sig = batch[s.i]!;
          const span = `${sig.title}. ${sig.body}`.trim().slice(0, 500);
          const l0 = assertL0({
            claim: sig.title,
            evidence: [
              {
                signal_id: null,
                fact_id: null,
                source_url: sig.url,
                span,
                observed_at: new Date().toISOString(),
              },
            ],
            retrievedUrls: [sig.url],
          });
          // The headline is QUOTED, not asserted. The gate exists to stop US
          // claiming things; a competitor headline saying "Insurance giant
          // Intact..." is reporting. The first run blocked exactly that, which
          // was my misuse of the gate, not a gate defect — it already exempts
          // quoted ranges, and a collected headline is quoted by definition.
          const honesty = checkHonesty(`"${sig.title}" ${s.so_what ?? ''}`, 'internal');
          const basis = renderBasis('inferred_from_sources', 1);

          console.log(`  • ${sig.title}`);
          console.log(`    so what: ${s.so_what ?? '—'}`);
          console.log(
            `    ${basis} · ${sig.publisher ?? registrableDomain(sig.url) ?? 'unknown'} · ` +
              `materiality ${s.materiality.toFixed(2)} · stakes ${s.stakes ?? '?'} · ` +
              `${sig.ageDays === null ? 'undated' : `${sig.ageDays}d old`} · ` +
              `L0 ${l0.ok ? 'pass' : `FAIL(${l0.violations.map((v) => v.code).join(',')})`} · ` +
              `honesty ${honesty.ok ? 'pass' : 'BLOCKED'}`,
          );
          console.log(`    ${sig.url.slice(0, 100)}\n`);

          // Nothing rendered to a human may present confidence as a number.
          expect(() => assertNoConfidenceNumber(`${sig.title} ${basis}`)).not.toThrow();
        }
      }

      console.log(
        `[cost] whole run: ${state.dailyCostCents.toFixed(4)}¢ ` +
          `(ceiling ${LIMITS.maxDailyCostCents}¢/day)\n`,
      );
      expect(state.dailyCostCents).toBeLessThan(LIMITS.maxDailyCostCents);
    },
  );
});
