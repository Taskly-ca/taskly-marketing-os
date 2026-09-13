'use client';

import { useEffect, useState } from 'react';
import { KIND_INFO, KIND_ORDER, MODES, phaseLabel, safeUrl, type ActivityItem, type DeepStep, type Source, type Turn } from '@/lib/answer';
import { ModeIcon } from './composer';
import { kindSummary } from './turn-view';

type Props = { turn: Turn | null; onStop: () => void; onToast: (m: string) => void; onClose?: () => void };

const clock = (ms: number) => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/**
 * THE ACTIVITY PANEL — what the agent is doing, while it does it.
 *
 * Every frame the run sends lands here in order: the phases it moves through
 * with their detail, the research plan and each step's result for deep runs
 * (revisions shown as changes, never replacements), the sources as they are
 * read, grouped by what kind of evidence they are, and what was refused. It
 * follows the selected question, so an old answer's trail is one click away.
 */
export function Activity({ turn, onStop, onToast, onClose }: Props) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!turn?.live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [turn?.live]);

  if (!turn) {
    return (
      <div className="activity-empty">
        <div className="eyebrow">Activity</div>
        <h3>Watch it work.</h3>
        <p>When you ask, every step shows up here as it happens.</p>
        <ol className="how">
          <li><b>Plans</b><span>the searches, or the research steps for a deep run</span></li>
          <li><b>Reads</b><span>each source, grouped: open web, competitor pages, our documents, our forecasts</span></li>
          <li><b>Quotes</b><span>the exact spans it is allowed to cite</span></li>
          <li><b>Writes and checks</b><span>every figure against its quote, and lists what it refused</span></li>
        </ol>
      </div>
    );
  }

  const elapsed = (turn.doneAt ?? now) - turn.startedAt;
  const proved = turn.plan?.reduce((a, s) => a + (s.found ?? 0), 0) ?? 0;
  const settled = turn.plan?.filter(s => !s.dropped && (s.state === 'done' || s.state === 'skipped')).length ?? 0;
  const live = turn.plan?.filter(s => !s.dropped) ?? [];

  return (
    <div className="activity">
      <div className="act-head">
        <div className="act-title">
          <span className="mode-tag"><ModeIcon mode={turn.mode} />{MODES[turn.mode].name}</span>
          <span className={`act-state ${turn.live ? 'on' : turn.error ? 'bad' : ''}`}>
            {turn.live ? <><span className="pulse" />{turn.phase ? phaseLabel(turn, turn.phase) : 'Starting'}</>
              : turn.clarify ? 'Waiting for your answers'
              : turn.error ? 'Stopped with an error' : turn.stopped ? 'You stopped it' : turn.stored ? 'Saved answer' : 'Finished'}
          </span>
          {onClose && <button className="icon-btn only-phone-flex" onClick={onClose} aria-label="Close activity"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 6l12 12M18 6 6 18" /></svg></button>}
        </div>
        <p className="act-q">{turn.question}</p>
        {!turn.stored && (
          <div className="act-meter num">
            <span>{clock(elapsed)}</span>
            <span>{turn.sources.length} source{turn.sources.length === 1 ? '' : 's'}</span>
            <span>{turn.spans.length} quote{turn.spans.length === 1 ? '' : 's'}</span>
            {turn.plan && <span>{settled}/{live.length} steps · {proved} proved</span>}
          </div>
        )}
        {turn.live && (
          <div className="act-stop">
            <button className="btn sm ghost" onClick={onStop}>Stop this run</button>
            <span className="fine">Stops what you see. The server has no cancel channel yet.</span>
          </div>
        )}
      </div>

      <div className="act-body">
        {turn.mode === 'deep' && <DeepPlan turn={turn} settled={settled} proved={proved} />}
        {!turn.stored && <Timeline turn={turn} />}
        <Sources turn={turn} onToast={onToast} />
        {turn.unused && (turn.unused.dropped.length > 0 || turn.unused.expectations.length > 0) && (
          <section className="act-sec">
            <div className="act-sec-head"><span className="lab">Refused before writing</span></div>
            {turn.unused.dropped.map((d, i) => <div key={i} className="refused"><q>{d.span}</q><span>{d.why}</span></div>)}
            {turn.unused.expectations.length > 0 && <p className="fine">Also on record, never cited: {turn.unused.expectations.length} open forecast{turn.unused.expectations.length === 1 ? '' : 's'} — what we expect, not evidence.</p>}
          </section>
        )}
      </div>
    </div>
  );
}

function DeepPlan({ turn, settled, proved }: { turn: Turn; settled: number; proved: number }) {
  const plan = turn.plan ?? [];
  const barren = settled >= 2 && proved === 0;
  return (
    <section className="act-sec">
      <div className="act-sec-head"><span className="lab">Research plan</span>{turn.planRevisions > 0 && <span className="tag">revised {turn.planRevisions}×</span>}</div>
      {plan.length === 0 ? (
        <p className="muted">{turn.live ? 'Working out the sub-questions. Nothing has been searched yet.' : turn.stored ? 'Plans aren’t saved with an answer. Ask again to watch the plan live.' : 'This run published no plan.'}</p>
      ) : (
        <ol className="plan">
          {plan.map(s => <PlanRow key={s.n} s={s} />)}
        </ol>
      )}
      {barren && (
        <div className="warn">
          {turn.live
            ? `${settled} steps done and nothing proved yet. If the next step looks the same, this is the moment to stop.`
            : `All ${settled} steps finished and nothing was proved. That is a result about these sources, not about the question.`}
        </div>
      )}
    </section>
  );
}

function PlanRow({ s }: { s: DeepStep }) {
  const status = s.dropped ? 'dropped by a revision' : s.state === 'running' ? 'running' : s.state === 'skipped' ? 'skipped'
    : s.state === 'done' ? (s.found === undefined ? 'found not reported' : s.found === 0 ? 'nothing proved' : `+${s.found} proved`) : 'not started';
  const mark = s.dropped ? '–' : s.state === 'running' ? '' : s.state === 'done' ? (s.found === 0 ? '0' : '✓') : s.state === 'skipped' ? '–' : String(s.n);
  return (
    <li className={`plan-step s-${s.state}${s.dropped ? ' dropped' : ''}${s.state === 'done' && s.found === 0 ? ' barren' : ''}`}>
      <span className="plan-mark">{s.state === 'running' && !s.dropped ? <span className="spin" /> : mark}</span>
      <div>
        <b>{s.question}{s.added && <span className="tag">added</span>}</b>
        <small>{status}{s.detail ? ` · ${s.detail}` : ''}</small>
        {s.was?.map((w, i) => <small key={i} className="was"><s>{w.question}</s> — {w.outcome}</small>)}
      </div>
    </li>
  );
}

function Timeline({ turn }: { turn: Turn }) {
  const [all, setAll] = useState(false);
  const items = turn.activity;
  const shown = all ? items : items.slice(-12);
  return (
    <section className="act-sec">
      <div className="act-sec-head">
        <span className="lab">Steps</span>
        {items.length > 12 && <button className="link" onClick={() => setAll(a => !a)}>{all ? 'Show recent' : `Show all ${items.length}`}</button>}
      </div>
      {items.length === 0 ? <p className="muted">{turn.live ? 'Connecting…' : 'No steps were recorded.'}</p> : (
        <ol className="timeline">
          {shown.map((a, i) => <TimelineRow key={i} a={a} turn={turn} last={i === shown.length - 1 && turn.live} />)}
        </ol>
      )}
    </section>
  );
}

function TimelineRow({ a, turn, last }: { a: ActivityItem; turn: Turn; last: boolean }) {
  const t = <span className="tl-time num">{clock(a.at - turn.startedAt)}</span>;
  if (a.kind === 'status') return <li className={`tl ${last ? 'now' : ''}`}><span className="tl-dot" /><div><b>{phaseLabel(turn, a.phase)}</b>{a.detail && <small>{a.detail}</small>}</div>{t}</li>;
  if (a.kind === 'plan') return <li className="tl gold"><span className="tl-dot" /><div><b>{a.revised ? 'Changed the plan' : 'Published the plan'}</b>{a.because && <small>{a.because}</small>}{a.changes && <small>{a.changes}</small>}</div>{t}</li>;
  if (a.kind === 'step') return <li className="tl"><span className="tl-dot" /><div><b>Step {a.n} {a.state === 'running' ? 'started' : a.state}</b>{(a.detail || a.found !== undefined) && <small>{[a.found !== undefined ? `${a.found} proved` : null, a.detail].filter(Boolean).join(' · ')}</small>}</div>{t}</li>;
  if (a.kind === 'reflect') return (
    <li className="tl gold"><span className="tl-dot" /><div>
      <b>{a.r.stop ? 'Decided to stop' : `Thought after step ${a.r.after}`}</b>
      {a.r.note && <small>{a.r.note}</small>}
      {a.r.stillOpen.length > 0 ? <small>Still open: {a.r.stillOpen.join(' · ')}</small> : <small>Listed nothing as still open.</small>}
      {a.r.stop && <small>{a.r.stop}</small>}
    </div>{t}</li>
  );
  if (a.kind === 'clarify') return <li className="tl gold"><span className="tl-dot" /><div><b>Asked you to clarify first</b><small>Nothing spent yet</small></div>{t}</li>;
  return <li className="tl bad"><span className="tl-dot" /><div><b>Stopped</b><small>{a.message}</small></div>{t}</li>;
}

function Sources({ turn, onToast }: { turn: Turn; onToast: (m: string) => void }) {
  if (turn.sources.length === 0) {
    return (
      <section className="act-sec">
        <div className="act-sec-head"><span className="lab">Sources</span></div>
        <p className="muted">{turn.live ? 'None read yet.' : 'No sources on this answer.'}</p>
      </section>
    );
  }
  const kinds = KIND_ORDER.filter(k => turn.sources.some(s => s.kind === k));
  const quotes = (s: Source) => turn.spans.filter(sp => sp.sourceIndex === s.i);
  return (
    <section className="act-sec">
      <div className="act-sec-head"><span className="lab">Sources</span><span className="num muted">{kinds.length > 1 ? kindSummary(turn) : turn.sources.length}</span></div>
      {kinds.map(k => (
        <div key={k} className="src-group">
          {(kinds.length > 1 || k !== 'web') && <div className="src-group-head"><b>{KIND_INFO[k].group}</b>{KIND_INFO[k].hint && <small>{KIND_INFO[k].hint}</small>}</div>}
          {turn.sources.filter(s => s.kind === k).map(s => <SourceCard key={s.i} s={s} quotes={quotes(s).map(q => q.quote)} onToast={onToast} />)}
        </div>
      ))}
    </section>
  );
}

function SourceCard({ s, quotes, onToast }: { s: Source; quotes: string[]; onToast: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const url = KIND_INFO[s.kind].linkable ? safeUrl(s.url) : null;
  const copy = async () => { try { await navigator.clipboard.writeText(s.url); onToast('Copied'); } catch { onToast('Could not copy'); } };
  return (
    <div className="src">
      <div className="src-top">
        <span className={`kind-dot k-${s.kind}`}>{s.kind === 'web' ? (s.domain[0] ?? '·').toUpperCase() : KIND_INFO[s.kind].glyph}</span>
        <div className="src-main">
          {url ? <a href={url} target="_blank" rel="noreferrer noopener" className="src-title">{s.title || s.domain}</a> : <span className="src-title">{s.title || s.url}</span>}
          <small className="num">
            {s.i} · {s.kind === 'brain' ? s.url.split(' § ')[0] : s.kind === 'ledger' ? 'prediction ledger' : s.domain}
            {s.observedAt ? ` · ${s.kind === 'ledger' ? 'recorded' : 'read'} ${s.observedAt.slice(0, 10)}` : s.kind === 'world' ? ' · no read date recorded' : ''}
          </small>
        </div>
        {!url && <button className="icon-btn sm" onClick={copy} aria-label="Copy where it lives" title="Copy where it lives"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg></button>}
      </div>
      {quotes.length > 0 && (
        <>
          <button className="src-quotes-toggle" onClick={() => setOpen(o => !o)} aria-expanded={open}>{quotes.length} quote{quotes.length === 1 ? '' : 's'} used {open ? '▴' : '▾'}</button>
          {open && quotes.map((q, i) => <blockquote key={i} className="src-quote">“{q}”</blockquote>)}
        </>
      )}
    </div>
  );
}
