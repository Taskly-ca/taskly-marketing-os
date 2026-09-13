'use client';

import { useEffect, useRef, useState } from 'react';
import { BASIS, httpUrl, type Draft, type ResearchAnswer } from '@/lib/watch';
import { decode } from '@/lib/answer';
import { PanelHead } from './watch';

type Phase = 'idle' | 'running' | 'done' | 'error';

/** One server-sent run: `step` lines while it works, one result frame, or an `error_msg`. */
function useStreamRun<T>(resultEvent: string) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [steps, setSteps] = useState<string[]>([]);
  const [result, setResult] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const es = useRef<EventSource | null>(null);
  useEffect(() => () => es.current?.close(), []);

  const start = (url: string) => {
    es.current?.close();
    setPhase('running'); setSteps([]); setResult(null); setError(null);
    const source = new EventSource(url);
    es.current = source;
    const parse = (d: string): unknown => { try { return JSON.parse(d); } catch { return d; } };
    source.addEventListener('step', (e: MessageEvent<string>) => setSteps(s => [...s, decode(String(parse(e.data)))]));
    source.addEventListener(resultEvent, (e: MessageEvent<string>) => { setResult(parse(e.data) as T); setPhase('done'); source.close(); es.current = null; });
    source.addEventListener('error_msg', (e: MessageEvent<string>) => { setError(String(parse(e.data))); setPhase('error'); source.close(); es.current = null; });
    source.onerror = () => { source.close(); es.current = null; setPhase(p => { if (p === 'running') { setError('The connection dropped before the run finished.'); return 'error'; } return p; }); };
  };
  return { phase, steps, result, error, start };
}

function Steps({ steps, running }: { steps: string[]; running: boolean }) {
  const ref = useRef<HTMLOListElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight; }, [steps]);
  if (!steps.length && !running) return null;
  return (
    <section className="card steps-card">
      <div className="card-top"><span className="eyebrow">{running ? 'Working' : 'What it did'}</span>{running && <span className="spin" />}</div>
      <ol className="step-list" ref={ref}>
        {steps.map((s, i) => <li key={i} className={i === steps.length - 1 && running ? 'now' : ''}>{s}</li>)}
        {running && steps.length === 0 && <li className="now">Starting…</li>}
      </ol>
    </section>
  );
}

const cents = (c?: number) => (c ? `${c.toFixed(3)}¢` : '');

/* ── This week ────────────────────────────────────────────────────────── */
export function WeekPanel({ hidden }: { hidden: boolean }) {
  const run = useStreamRun<Draft>('draft');
  const d = run.result;
  const byId = Object.fromEntries((d?.evidence ?? []).map(e => [e.id, e]));
  return (
    <div hidden={hidden}>
      <PanelHead
        title="This week"
        lead="What to work on, drawn from what has actually been observed — competitor changes, their pages, the season and our own documents. Every recommendation names the evidence it rests on and what would show it was the wrong call. Ones that couldn’t carry either are listed as dropped."
        right={<>
          {d && <span className="num muted">{cents(d.costCents)}</span>}
          <button className="btn" onClick={() => run.start('/api/console/draft')} disabled={run.phase === 'running'}>{run.phase === 'running' ? 'Drafting…' : d ? 'Draft again' : 'Draft this week'}</button>
        </>}
      />
      {run.error && <div className="alert" role="alert">{run.error}</div>}
      <Steps steps={run.steps} running={run.phase === 'running'} />
      {run.phase === 'idle' && <div className="empty-card"><b>Nothing drafted yet.</b><span>Press Draft this week. It reads what’s on record and takes about a minute.</span></div>}
      {d && (
        <div className="cards">
          {d.note && <article className="card"><h3>{d.note}</h3></article>}
          {d.recommendations.length === 0 && !d.note && <div className="empty-card"><b>Nothing survived the gate this week.</b></div>}
          {d.recommendations.map((r, i) => (
            <article key={i} className={`card rec${r.basis === 'inferred_from_sources' ? '' : ' thin'}`}>
              <div className="card-top"><span className={`tag ${r.basis === 'inferred_from_sources' ? '' : 'plain'}`}>{BASIS[r.basis] ?? r.basis}</span><span className="muted">Horizon: {r.horizon}</span></div>
              <h3>{r.action}</h3>
              <p className="sowhat">{r.reasoning}</p>
              <p className="falsifier"><b>Wrong if:</b> {r.falsifier}</p>
              {r.evidence.length > 0 && (
                <ul className="evidence">
                  {r.evidence.map(id => {
                    const e = byId[id];
                    if (!e) return null;
                    const url = httpUrl(e.source);
                    return <li key={id}><span className="ev-kind">{e.kind}</span><span>{e.text.slice(0, 210)}</span>{url ? <a href={url} target="_blank" rel="noreferrer noopener" className="ext">↗</a> : <span className="muted"> — {e.source}</span>}</li>;
                  })}
                </ul>
              )}
            </article>
          ))}
          {d.dropped.length > 0 && (
            <article className="card">
              <h3>Dropped — proposed, but couldn’t carry its own evidence</h3>
              <p className="fine">Shown rather than removed. These are what a system without a gate would have handed you as if they were the same as the others.</p>
              <ul className="drops">{d.dropped.map((x, i) => <li key={i}><b>{x.action}</b><span>{x.why}</span></li>)}</ul>
            </article>
          )}
          <details className="card">
            <summary><h3>Evidence file <span className="tag plain">{d.evidence.length}</span></h3><span className="fine">Everything the reasoner was given. It knows nothing else.</span></summary>
            <ul className="evidence">{d.evidence.map(e => <li key={e.id}><span className="ev-kind">{e.kind}</span><span>{e.text.slice(0, 190)}</span></li>)}</ul>
          </details>
        </div>
      )}
    </div>
  );
}

/* ── Research ─────────────────────────────────────────────────────────── */
export function ResearchPanel({ hidden }: { hidden: boolean }) {
  const run = useStreamRun<ResearchAnswer>('answer');
  const [q, setQ] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const a = run.result;
  const go = () => {
    if (q.trim().length < 8) { setLocal('Ask a fuller question — a few words can’t be turned into a search.'); return; }
    setLocal(null);
    run.start(`/api/console/research?q=${encodeURIComponent(q.trim())}`);
  };
  return (
    <div hidden={hidden}>
      <PanelHead
        title="Research"
        lead={<>Ask a marketing or market question. It plans searches, reads the pages it’s allowed to read, and answers <em>only</em> from what it retrieved — every point quoted from a page you can open. Points it couldn’t source are listed as dropped. Nothing here is saved; the <a href="/" className="inline-link">Ask</a> tab keeps threads and shows each step live.</>}
      />
      <section className="card">
        <div className="field">
          <label htmlFor="rq">Your question</label>
          <textarea id="rq" className="input area" value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. Which task categories are growing fastest in the GTA, and who already serves them?"
            onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) go(); }} />
        </div>
        <div className="form-actions">
          <button className="btn" onClick={go} disabled={run.phase === 'running'}>{run.phase === 'running' ? 'Researching…' : 'Research this'}</button>
          <span className="fine">⌘ Enter</span>
          {a && <span className="num muted">{cents(a.costCents)}</span>}
        </div>
        {(local || run.error) && <div className="alert" role="alert">{local ?? run.error}</div>}
      </section>
      <Steps steps={run.steps} running={run.phase === 'running'} />
      {a && (
        <div className="cards">
          <article className="card">
            <h3>{a.summary || 'No answer could be sourced.'}</h3>
            {a.points.length === 0
              ? <p className="fine">No point survived verification. That usually means the pages retrieved didn’t address the question — try naming a company, a city or a period.</p>
              : <ul className="points">{a.points.map((p, i) => (
                  <li key={i}><p>{p.claim}</p>{p.citations.map((c, j) => <blockquote key={j} className="quote">“{c.span}” {httpUrl(c.url) && <a href={c.url} target="_blank" rel="noreferrer noopener" className="ext">{new URL(c.url).hostname.replace(/^www\./, '')} ↗</a>}</blockquote>)}</li>
                ))}</ul>}
          </article>
          {a.dropped.length > 0 && (
            <article className="card">
              <h3>Dropped — asserted, but not supported by what was retrieved</h3>
              <p className="fine">Shown rather than removed. A gate whose refusals are invisible looks the same as a model that had nothing to say.</p>
              <ul className="drops">{a.dropped.map((d, i) => <li key={i}><b>{d.claim}</b><span>{d.why}</span></li>)}</ul>
            </article>
          )}
          {a.unanswered.length > 0 && <article className="card"><h3>Not answerable from the open web</h3><ul className="drops">{a.unanswered.map((u, i) => <li key={i}><b>{u}</b></li>)}</ul></article>}
          {a.sources.length > 0 && (
            <details className="card">
              <summary><h3>Read this run <span className="tag plain">{a.sources.length}</span></h3><span className="fine">{a.queries.join(' · ')}</span></summary>
              <ul className="drops">{a.sources.map((s, i) => <li key={i}>{httpUrl(s.url) ? <a href={s.url} target="_blank" rel="noreferrer noopener" className="ext">{decode(s.title || s.url)} ↗</a> : <b>{s.title || s.url}</b>}</li>)}</ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
