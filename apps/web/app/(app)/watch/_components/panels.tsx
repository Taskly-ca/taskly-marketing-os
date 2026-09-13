'use client';

import { useMemo, useState } from 'react';
import { HEALTH_LABEL, clamp, days, httpUrl, type Fact, type Finding, type Pred, type Question, type SourceRow } from '@/lib/watch';
import { PanelHead } from './watch';

const Loading = () => <div className="empty-card">Loading…</div>;
const ext = (url: string, label: string) => <a href={url} target="_blank" rel="noreferrer noopener" className="ext">{label} ↗</a>;

/* ── What changed ─────────────────────────────────────────────────────── */
export function ChangedPanel({ findings }: { findings: Finding[] | null }) {
  const [showWithdrawn, setShowWithdrawn] = useState(true);
  const withdrawn = findings?.filter(f => f.supersede_reason).length ?? 0;
  const rows = findings?.filter(f => showWithdrawn || !f.supersede_reason) ?? null;
  return (
    <>
      <PanelHead
        title="What changed"
        lead="A change on a competitor’s own page, checked by a second model before it was allowed to appear. Withdrawn findings stay here, struck through, with the reason — a record that hides its own mistakes is not a record."
        right={withdrawn > 0 && <label className="check-row"><input type="checkbox" checked={showWithdrawn} onChange={e => setShowWithdrawn(e.target.checked)} /> Show {withdrawn} withdrawn</label>}
      />
      {!rows ? <Loading /> : rows.length === 0 ? (
        <div className="empty-card"><b>No findings yet.</b><span>Run the competitor watch. The first pass writes a baseline, and every pass after it can detect a change.</span></div>
      ) : (
        <div className="cards">
          {rows.map((f, i) => (
            <article key={i} className={`card finding${f.supersede_reason ? ' withdrawn' : ''}`}>
              <div className="card-top">
                <span className="subject">{f.subject}</span>
                {f.supersede_reason && <span className="tag bad">withdrawn</span>}
                <span className="num muted card-date">{f.created}</span>
              </div>
              <h3>{f.claim}</h3>
              {f.supersede_reason && <p className="withdraw-why"><b>Why it was withdrawn:</b> {f.supersede_reason}</p>}
              <p className="sowhat">{f.so_what}</p>
              {f.span && <blockquote className="quote">“{f.span}”</blockquote>}
              <div className="card-meta num">
                <span>basis {f.basis}</span><span>score {f.score}</span>
                {httpUrl(f.url) && ext(f.url!, 'Source page')}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}

/* ── Competitors ──────────────────────────────────────────────────────── */
export function CompetitorsPanel({ facts }: { facts: Fact[] | null }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const by = new Map<string, Fact[]>();
    for (const f of facts ?? []) by.set(f.company, [...(by.get(f.company) ?? []), f]);
    const needle = q.trim().toLowerCase();
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, rows]) => [name, needle && !name.toLowerCase().includes(needle) ? rows.filter(r => `${r.predicate} ${r.value}`.toLowerCase().includes(needle)) : rows] as const)
      .filter(([, rows]) => rows.length > 0);
  }, [facts, q]);
  return (
    <>
      <PanelHead
        title="Competitors"
        lead="What each competitor’s own pages said, and since when. Every value carries the sentence it came from. This is the part that compounds: a day not run is a day of history that can’t be recovered."
        right={facts && facts.length > 0 && <div className="search panel-search"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg><input value={q} onChange={e => setQ(e.target.value)} placeholder="Filter companies or measures" aria-label="Filter" /></div>}
      />
      {!facts ? <Loading /> : groups.length === 0 ? (
        <div className="empty-card"><b>{q ? 'Nothing matches that.' : 'Nothing observed yet.'}</b>{!q && <span>Run the competitor watch to read their pages.</span>}</div>
      ) : (
        <div className="cards">
          {groups.map(([name, rows]) => <CompanyCard key={name} name={name} rows={rows} />)}
        </div>
      )}
    </>
  );
}

function CompanyCard({ name, rows }: { name: string; rows: Fact[] }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <article className="card">
      <div className="card-top"><h3 className="company">{name}</h3><span className="num muted">{rows.length} measure{rows.length === 1 ? '' : 's'} on record</span></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Measure</th><th>Value</th><th>Since</th><th>Evidence</th></tr></thead>
          <tbody>
            {rows.map((f, i) => (
              <tr key={i}>
                <td data-label="Measure">{f.predicate.replace(/_/g, ' ')}</td>
                <td data-label="Value" className="value">{f.value}</td>
                <td data-label="Since" className="num muted nowrap">{f.since}</td>
                <td data-label="Evidence" className="nowrap">
                  {f.span && <button className="link" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Hide quote' : 'Quote'}</button>}
                  {f.span && httpUrl(f.url) && <span className="muted"> · </span>}
                  {httpUrl(f.url) ? ext(f.url!, 'Page') : !f.span && <span className="muted">—</span>}
                  {open === i && f.span && <blockquote className="quote in-table">“{f.span}”</blockquote>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

/* ── Forecasts ────────────────────────────────────────────────────────── */
export function ForecastsPanel({ preds, questions, onSaved }: { preds: Pred[] | null; questions: Question[] | null; onSaved: () => Promise<void> }) {
  const open = questions?.filter(q => q.yours === null) ?? [];
  const [key, setKey] = useState('');
  const [p, setP] = useState('');
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const selected = open.find(q => q.key === key) ?? open[0];
  const human = preds?.filter(x => x.author.startsWith('human:')).length ?? 0;

  const save = async () => {
    if (!selected) return;
    setBusy(true); setMsg(null);
    const res = await fetch('/api/console/forecast', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: selected.key, p, because: why }) }).catch(() => null);
    const text = res ? await res.text() : 'Couldn’t reach the engine.';
    setMsg({ ok: !!res?.ok, text });
    if (res?.ok) { setP(''); setWhy(''); setKey(''); await onSaved(); }
    setBusy(false);
  };

  return (
    <>
      <PanelHead title="Forecasts" lead="Open forecasts about the observable world. They resolve against competitor pages and job posts, so the track record builds with zero users. Your probability and the agent’s are scored separately." />
      <section className="card forecast-form">
        <div className="card-top"><h3>Write your forecast</h3>{questions && <span className="num muted">{open.length} of {questions.length} unanswered</span>}</div>
        {!questions ? <p className="muted">Loading questions…</p> : open.length === 0 ? (
          <p className="muted">You have forecast every open question.</p>
        ) : (
          <>
            <p className="fine">The agent’s number stays hidden until yours is in. Reading it first makes your forecast a copy of it, and two correlated numbers can’t be scored against each other.</p>
            <div className="field">
              <label htmlFor="fc-q">Question</label>
              <select id="fc-q" className="input" value={selected?.key ?? ''} onChange={e => setKey(e.target.value)}>
                {open.map(q => <option key={q.key} value={q.key}>{q.claim}</option>)}
              </select>
              {selected && <span className="field-hint num">Resolves {selected.resolve_at.slice(0, 10)}</span>}
            </div>
            <div className="form-row">
              <div className="field p-field">
                <label htmlFor="fc-p">Your probability</label>
                <input id="fc-p" className="input num" inputMode="decimal" placeholder="0.60" value={p} onChange={e => setP(e.target.value)} autoComplete="off" />
                <span className="field-hint">Between 0.01 and 0.99 — not a percentage</span>
              </div>
              <div className="field grow">
                <label htmlFor="fc-why">Why</label>
                <textarea id="fc-why" className="input area" placeholder="What makes you think that?" value={why} onChange={e => setWhy(e.target.value)} />
                <span className="field-hint">Frozen when you save. It can’t be edited once you know the answer — that is the point.</span>
              </div>
            </div>
            <div className="form-actions">
              <button className="btn" onClick={save} disabled={busy || !p.trim() || !why.trim()}>{busy ? 'Recording…' : 'Record forecast'}</button>
              {msg && <div className={msg.ok ? 'notice' : 'alert'} role="status">{msg.text}</div>}
            </div>
          </>
        )}
      </section>

      {!preds ? <Loading /> : preds.length === 0 ? <div className="empty-card"><b>No open forecasts.</b></div> : (
        <article className="card">
          <div className="card-top"><h3>Open forecasts</h3><span className="num muted">{preds.length} open · {human} yours · {preds.length - human} the agent’s</span></div>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Claim</th><th>p</th><th>Author</th><th>Resolves</th></tr></thead>
              <tbody>
                {preds.map((x, i) => (
                  <tr key={i}>
                    <td data-label="Claim">{x.claim}</td>
                    <td data-label="p" className="num nowrap"><span className="prob"><span style={{ width: `${Number(x.p) * 100}%` }} /></span>{Number(x.p).toFixed(2)}</td>
                    <td data-label="Author"><span className={`tag ${x.author.startsWith('human:') ? '' : 'plain'}`}>{x.author.startsWith('human:') ? 'you' : 'agent'}</span></td>
                    <td data-label="Resolves" className="num muted nowrap">{x.resolves}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      )}
    </>
  );
}

/* ── Sources ──────────────────────────────────────────────────────────── */
export function SourcesPanel({ sources }: { sources: SourceRow[] | null }) {
  const attention = sources?.filter(s => s.health === 'needs_operator') ?? [];
  const refused = sources?.filter(s => s.health === 'refused') ?? [];
  return (
    <>
      <PanelHead
        title="Sources"
        lead={<>Where signals come from, and which of them is waiting on you. Only one kind of breakage fixes itself: <b>needs you</b> is a credential no retry can repair, <b>refused</b> is a site declining to be read (we don’t fetch what a host refuses), and <b>retrying</b> is an outage the backoff will clear.</>}
      />
      {!sources ? <Loading /> : (
        <>
          {attention.length > 0 && (
            <section className="card attention-card">
              <div className="eyebrow">Waiting on you</div>
              {attention.map(s => (
                <div key={s.name} className="attention-row">
                  <h3>{s.name} — {days(s.failing_days)}</h3>
                  <p>{s.fails} straight {s.fails === 1 ? 'failure' : 'failures'} since {s.failing_since ?? 'the first pass'}, and no retry will clear it.</p>
                  {s.detail && <blockquote className="quote">{clamp(s.detail)}</blockquote>}
                </div>
              ))}
            </section>
          )}
          {refused.length > 0 && (
            <section className="card">
              <div className="eyebrow muted-eyebrow">Refused — nothing to do</div>
              <p className="sowhat">These hosts decline to be read. That is their call and we honour it; there is no workaround and none is wanted. Each is re-asked about once a day in case the rule changes.</p>
              {refused.map(s => <div key={s.name} className="refused-row"><b>{s.name}</b><span className="num muted">{days(s.failing_days)}</span><span className="muted">{clamp(s.detail)}</span></div>)}
            </section>
          )}
          <article className="card">
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Source</th><th>Tier</th><th>State</th><th>Last OK</th><th>Failing for</th><th>Fails</th></tr></thead>
                <tbody>
                  {sources.map(s => (
                    <tr key={s.name}>
                      <td data-label="Source">{s.name}</td>
                      <td data-label="Tier" className="num muted">{s.tier}</td>
                      <td data-label="State"><span className={`health h-${s.health}`}><span className="dot" />{HEALTH_LABEL[s.health] ?? s.health}</span></td>
                      <td data-label="Last OK" className="num muted nowrap">{s.last_ok ?? 'never'}</td>
                      <td data-label="Failing for" className="num muted nowrap">{days(s.failing_days) || '—'}</td>
                      <td data-label="Fails" className="num">{s.fails}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </>
      )}
    </>
  );
}
