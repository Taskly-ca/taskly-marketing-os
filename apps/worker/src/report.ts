/**
 * The briefing — everything TMOS currently knows, as one page.
 *
 * Until now the only way to see any of this was terminal scrollback, which is
 * not a surface: Part 6 built feed, entity-page and grid VIEW MODELS and noted
 * that "no app renders them". This renders. It reads the database and writes a
 * self-contained HTML file, so it can be regenerated after any run and opened
 * without a server.
 *
 * It shows what is KNOWN, not what is guessed: every fact carries the sentence
 * it came from and the page that sentence is on, and a claim with no evidence
 * does not appear. The basis rule from Part 6 governs the whole page — show what
 * an answer rests on, never how confident a model feels — so there is no
 * confidence score anywhere on it.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { db, sql, closePool } from '@tmos/db';

type FactRow = {
  company: string; predicate: string; value: string; url: string | null;
  span: string | null; since: string; method: string;
};
type PredRow = { claim: string; p: string; resolves: string; resolver: string };
type FindingRow = {
  claim: string; so_what: string; subject: string; basis: string; score: string;
  created: string; by: string; url: string | null; span: string | null;
  /** Non-null ⇒ withdrawn. The reason is required by the store, and it is the
   *  half of a correction that repairs trust — so it is what gets shown. */
  supersede_reason: string | null;
};
type SourceRow = { name: string; tier: string; last_ok: string | null; fails: number };

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const label = (p: string): string => p.replace(/_/g, ' ');

function page(d: {
  facts: FactRow[]; preds: PredRow[]; sources: SourceRow[]; findingRows: FindingRow[];
  signals: number; events: number; entities: number; findings: number;
  spendCents: number; llmCalls: number; generated: string;
}): string {
  const companies = [...new Set(d.facts.map((f) => f.company))].sort();

  const factRows = companies.map((c) => {
    const rows = d.facts.filter((f) => f.company === c);
    return `
      <section class="entity">
        <header class="entity__head">
          <h3>${esc(c)}</h3>
          <span class="count">${rows.length} measure${rows.length === 1 ? '' : 's'} on record</span>
        </header>
        <div class="scroll">
        <table class="ledger">
          <thead><tr><th>measure</th><th>value</th><th>observed</th><th>evidence</th></tr></thead>
          <tbody>
            ${rows.map((f) => `
              <tr>
                <td class="k">${esc(label(f.predicate))}</td>
                <td class="v">${esc(f.value.length > 90 ? f.value.slice(0, 90) + '…' : f.value)}</td>
                <td class="t">${esc(f.since)}</td>
                <td class="e">${f.span ? `<q>${esc(f.span.slice(0, 110))}</q>` : '<span class="none">—</span>'}
                  ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">source</a>` : ''}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        </div>
      </section>`;
  }).join('');

  const predRows = d.preds.map((p) => {
    const pct = Math.round(Number(p.p) * 100);
    return `
      <li class="pred">
        <div class="pred__rail" aria-hidden="true"><span style="left:${pct}%"></span></div>
        <div class="pred__p"><strong>${pct}</strong><em>%</em></div>
        <div class="pred__body">
          <p class="pred__claim">${esc(p.claim)}</p>
          <p class="pred__meta">resolves ${esc(p.resolves)} · ${esc(p.resolver)}</p>
        </div>
      </li>`;
  }).join('');

  const srcRows = d.sources.map((s) => `
    <tr>
      <td class="k">${esc(s.name)}</td>
      <td>${esc(s.tier)}</td>
      <td class="t">${s.last_ok ? esc(s.last_ok) : '<span class="none">never</span>'}</td>
      <td class="${s.fails > 0 ? 'bad' : ''}">${s.fails}</td>
    </tr>`).join('');

  return `<title>Competitor Ledger</title>
<style>
  :root{
    --ground:#f5f7f8; --surface:#ffffff; --line:#dfe4e7;
    --ink:#14181b; --muted:#69737b; --faint:#98a2a9;
    --brass:#8d6a12; --hold:#2c6b50; --moved:#a04d1a;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --ground:#0e1114; --surface:#161a1e; --line:#272d33;
      --ink:#e7ebee; --muted:#939da5; --faint:#6c767e;
      --brass:#cba347; --hold:#5aa886; --moved:#d17b45;
    }
  }
  :root[data-theme="dark"]{
    --ground:#0e1114; --surface:#161a1e; --line:#272d33;
    --ink:#e7ebee; --muted:#939da5; --faint:#6c767e;
    --brass:#cba347; --hold:#5aa886; --moved:#d17b45;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);
       font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1060px;margin:0 auto;padding:56px 24px 96px}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;
           color:var(--brass);margin:0 0 10px}
  h1{font-size:34px;line-height:1.15;margin:0 0 8px;letter-spacing:-.02em;text-wrap:balance}
  h2{font-size:13px;font-family:var(--mono);letter-spacing:.12em;text-transform:uppercase;
     color:var(--muted);margin:0;font-weight:600}
  h3{font-size:17px;margin:0;letter-spacing:-.01em}
  .lede{color:var(--muted);max-width:64ch;margin:0}
  header.top{border-bottom:1px solid var(--line);padding-bottom:28px;margin-bottom:36px}
  .stamp{font-family:var(--mono);font-size:12px;color:var(--faint);margin-top:14px}

  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;
         background:var(--line);border:1px solid var(--line);margin:0 0 44px}
  .stat{background:var(--surface);padding:16px 18px}
  .stat b{display:block;font-size:26px;font-family:var(--mono);font-variant-numeric:tabular-nums;
          letter-spacing:-.03em;line-height:1.1}
  .stat span{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;
             color:var(--faint)}

  .band{margin:0 0 44px}
  .band__head{display:flex;align-items:baseline;gap:14px;margin-bottom:6px}
  .band__note{color:var(--muted);font-size:13.5px;max-width:66ch;margin:0 0 20px}

  .entity{background:var(--surface);border:1px solid var(--line);margin-bottom:14px}
  .entity__head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;
                padding:14px 18px;border-bottom:1px solid var(--line)}
  .count{font-family:var(--mono);font-size:11px;color:var(--faint)}
  .scroll{overflow-x:auto}
  table{border-collapse:collapse;width:100%;font-size:13.5px}
  th{text-align:left;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;
     text-transform:uppercase;color:var(--faint);font-weight:600;padding:10px 18px;
     border-bottom:1px solid var(--line);white-space:nowrap}
  td{padding:11px 18px;border-bottom:1px solid var(--line);vertical-align:top}
  tr:last-child td{border-bottom:none}
  .k{font-family:var(--mono);font-size:12.5px;color:var(--muted);white-space:nowrap}
  .v{font-weight:600}
  .t{font-family:var(--mono);font-size:12px;color:var(--faint);white-space:nowrap;
     font-variant-numeric:tabular-nums}
  .e{color:var(--muted);font-size:12.5px;max-width:420px}
  .e q{quotes:"“" "”";font-style:normal}
  .e a{font-family:var(--mono);font-size:11px;color:var(--brass);margin-left:8px;
       text-decoration:none;border-bottom:1px solid currentColor;white-space:nowrap}
  .e a:hover,.e a:focus-visible{color:var(--ink)}
  .none{color:var(--faint)}
  .bad{color:var(--moved);font-variant-numeric:tabular-nums}

  ul.preds{list-style:none;margin:0;padding:0;background:var(--surface);border:1px solid var(--line)}
  .pred{display:grid;grid-template-columns:120px 62px 1fr;align-items:center;gap:16px;
        padding:13px 18px;border-bottom:1px solid var(--line)}
  .pred:last-child{border-bottom:none}
  .pred__rail{position:relative;height:3px;background:var(--line)}
  .pred__rail span{position:absolute;top:-3px;width:3px;height:9px;background:var(--brass);
                   transform:translateX(-1px)}
  .pred__p{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right}
  .pred__p strong{font-size:17px;letter-spacing:-.02em}
  .pred__p em{font-style:normal;font-size:11px;color:var(--faint);margin-left:1px}
  .pred__claim{margin:0;font-size:13.5px;line-height:1.45}
  .pred__meta{margin:2px 0 0;font-family:var(--mono);font-size:11px;color:var(--faint)}

  .callout{border:1px solid var(--line);border-left:2px solid var(--brass);
           background:var(--surface);padding:16px 20px;font-size:13.5px;color:var(--muted)}
  .callout strong{color:var(--ink)}
  .finding{border:1px solid var(--line);border-left:2px solid var(--brass);
    padding:14px 16px;margin:0 0 12px}
  .finding--withdrawn{border-left-color:var(--line);opacity:.72}
  .finding--withdrawn h3{text-decoration:line-through}
  .finding h3{margin:0;font-size:15px;font-weight:600}
  .finding .tag{display:inline-block;margin:0 0 6px;padding:1px 7px;border:1px solid var(--line);
    font-size:10px;letter-spacing:.09em;text-transform:uppercase}
  .finding .sowhat{margin:6px 0 0}
  .finding .why{margin:8px 0 0;padding:8px 10px;border:1px dashed var(--line);font-size:12px}
  .finding .meta{margin:8px 0 0;font-size:11px;letter-spacing:.04em;text-transform:uppercase;
    color:var(--faint)}
  .finding .e{margin:8px 0 0;font-size:12px}
  footer{margin-top:56px;padding-top:22px;border-top:1px solid var(--line);
         font-family:var(--mono);font-size:11.5px;color:var(--faint)}
  @media (max-width:640px){
    .pred{grid-template-columns:52px 1fr;gap:12px}
    .pred__rail{display:none}
    .wrap{padding:36px 16px 64px}
    h1{font-size:27px}
  }
</style>

<div class="wrap">
  <header class="top">
    <p class="eyebrow">Taskly Marketing OS</p>
    <h1>What we know about the competition</h1>
    <p class="lede">Every measure below was read off a competitor's own page and is stored with the
      sentence it came from. Nothing here is inferred, and nothing is a guess — a value with no
      evidence is not recorded at all.</p>
    <p class="stamp">Generated ${esc(d.generated)}</p>
  </header>

  <div class="stats">
    <div class="stat"><b>${d.facts.length}</b><span>facts held</span></div>
    <div class="stat"><b>${d.entities}</b><span>entities</span></div>
    <div class="stat"><b>${d.preds.length}</b><span>open forecasts</span></div>
    <div class="stat"><b>${d.signals}</b><span>signals</span></div>
    <div class="stat"><b>${d.events}</b><span>events</span></div>
    <div class="stat"><b>${d.spendCents.toFixed(2)}¢</b><span>spent to date</span></div>
  </div>

  <div class="band">
    <div class="band__head"><h2>The record</h2></div>
    <p class="band__note">One row per measure, per company. The same questions are asked of the same
      pages on every run, so a value that moves is a change and not a re-reading. Today every value
      is a first observation.</p>
    ${factRows || '<p class="callout">Nothing observed yet. Run the watch to write a baseline.</p>'}
  </div>

  <div class="band">
    <div class="band__head"><h2>Open forecasts</h2></div>
    <p class="band__note">Each is a falsifiable claim about the outside world with a date and a way to
      settle it, recorded before the outcome is known. The spread across the rail is the point: a
      column of confident bets cannot tell a good forecaster from a lucky one.</p>
    <ul class="preds">${predRows}</ul>
  </div>

  <div class="band">
    <div class="band__head"><h2>Where it looks</h2></div>
    <div class="scroll">
      <table class="ledger" style="background:var(--surface);border:1px solid var(--line)">
        <thead><tr><th>source</th><th>tier</th><th>last good read</th><th>fails</th></tr></thead>
        <tbody>${srcRows}</tbody>
      </table>
    </div>
  </div>

  <div class="band">
    <div class="band__head"><h2>Findings</h2></div>
    <p class="band__note">A Finding is raised when a measure changes, and carries both values, both
      dates and both sources. Since 2026-08-23 one is only stored after a second model of a
      different family has been asked to refute it and could not — the two below predate that,
      which is how the first of them came to be withdrawn. A withdrawn Finding stays on the page,
      with the reason: a system that quietly stops showing what it got wrong has no track record
      anyone can read.</p>
    ${d.findingRows.length === 0
      ? `<p class="callout"><strong>None yet, and that is correct.</strong>
          A change detector needs a before and an after. The baseline above is the before.
          From the next run onward, every difference is a Finding.</p>`
      : d.findingRows.map((f) => `
      <article class="finding${f.supersede_reason === null ? '' : ' finding--withdrawn'}">
        <header>
          ${f.supersede_reason === null ? '' : '<span class="tag">withdrawn</span>'}
          <h3>${esc(f.claim)}</h3>
        </header>
        <p class="sowhat">${esc(f.so_what)}</p>
        ${f.supersede_reason === null
          ? ''
          : `<p class="why"><strong>Why it was withdrawn.</strong> ${esc(f.supersede_reason)}</p>`}
        <p class="meta">${esc(f.subject)} · ${esc(f.basis)} · relevance ${esc(f.score)} ·
          ${esc(f.created)} · ${esc(f.by)}</p>
        ${f.span ? `<p class="e"><q>${esc(f.span.slice(0, 220))}</q>
          ${f.url ? `<a href="${esc(f.url)}" target="_blank" rel="noopener">source</a>` : ''}</p>` : ''}
      </article>`).join('')}
  </div>

  <footer>${d.llmCalls} model calls · ${d.spendCents.toFixed(4)}¢ · separate database from the marketplace</footer>
</div>`;
}

async function main(): Promise<void> {
  const facts = await db().query<FactRow>(sql`
    select e.name as company, f.predicate,
           coalesce(f.object_text, f.object_num::text) as value,
           f.evidence->>'url' as url, f.evidence->>'snippet' as span,
           to_char(lower(f.valid), 'YYYY-MM-DD HH24:MI') as since, f.method
      from fact f join entity e on e.id = f.entity_id
     where upper_inf(f.asserted) and f.status = 'active'
     order by e.name, f.predicate`);

  const preds = await db().query<PredRow>(sql`
    select claim, p::text as p, to_char(resolve_at,'YYYY-MM-DD') as resolves,
           resolver->>'kind' as resolver
      from prediction where outcome is null order by p desc`);

  /**
   * Superseded rows are INCLUDED, newest first. The live-only index exists for
   * the feed, not for this page: a system that quietly stops showing what it
   * got wrong is a system whose track record cannot be read, and the ledger's
   * whole argument is that the record is the asset.
   */
  const findingRows = await db().query<FindingRow>(sql`
    select f.claim, f.so_what, array_to_string(f.subject_refs, ', ') as subject,
           f.basis, to_char(f.domain_score, 'FM0.00') as score,
           to_char(f.created_at, 'YYYY-MM-DD HH24:MI') as created,
           f.generated_by as by,
           f.evidence->0->>'source_url' as url,
           f.evidence->0->>'span' as span,
           f.supersede_reason
      from finding f
     order by f.created_at desc`);

  const sources = await db().query<SourceRow>(sql`
    select name, tier, to_char(last_ok_at,'YYYY-MM-DD HH24:MI') as last_ok,
           consecutive_failures as fails
      from source order by name`);

  const [counts] = await db().query<{
    signals: number; events: number; entities: number; findings: number;
    cents: string | null; calls: number;
  }>(sql`
    select (select count(*) from signal)::int  as signals,
           (select count(*) from events)::int  as events,
           (select count(*) from entity)::int  as entities,
           (select count(*) from finding)::int as findings,
           (select coalesce(sum(cost_cents),0)::text from ai_usage_log) as cents,
           (select count(*) from ai_usage_log)::int as calls`);

  const html = page({
    facts, preds, sources, findingRows,
    signals: counts?.signals ?? 0,
    events: counts?.events ?? 0,
    entities: counts?.entities ?? 0,
    findings: counts?.findings ?? 0,
    spendCents: Number(counts?.cents ?? 0),
    llmCalls: counts?.calls ?? 0,
    generated: new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
  });

  const out = resolve(process.cwd(), 'briefing.html');
  writeFileSync(out, html, 'utf8');
  console.log(`wrote ${out}`);
  const withdrawn = findingRows.filter((f) => f.supersede_reason !== null).length;
  console.log(
    `  ${facts.length} facts · ${preds.length} forecasts · ${sources.length} sources · ` +
      `${findingRows.length} findings (${withdrawn} withdrawn)`,
  );
  await closePool();
}

main().catch(async (err) => {
  console.error('report failed:', err);
  await closePool();
  process.exit(1);
});
