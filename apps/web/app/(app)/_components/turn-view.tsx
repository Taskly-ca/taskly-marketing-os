'use client';

import { useState } from 'react';
import { KIND_INFO, MODES, phaseLabel, pieces, plainAnswer, stripMarkers, type Turn } from '@/lib/answer';
import { Cite } from './cite';
import { ModeIcon } from './composer';

type Props = {
  turn: Turn;
  selected: boolean;
  canFork: boolean;
  onSelect: () => void;
  onAsk: (q: string) => void;
  onFork: () => void;
  onClarify: (answers: string[]) => void;
  onFocusComposer: () => void;
  onToast: (m: string) => void;
};

const money = (c: number) => (c >= 100 ? `$${(c / 100).toFixed(2)}` : `${c.toFixed(2)}¢`);

export function TurnView({ turn, selected, canFork, onSelect, onAsk, onFork, onClarify, onFocusComposer, onToast }: Props) {
  const hasProse = turn.sentences.some(s => s.text.trim());
  const writing = turn.live && turn.phase !== undefined;

  const copy = async (withSources: boolean) => {
    try { await navigator.clipboard.writeText(plainAnswer(turn, withSources)); onToast(withSources ? 'Copied with sources' : 'Answer copied'); } catch { onToast('Could not copy'); }
  };

  return (
    <article className="turn" data-selected={selected} onClick={e => { if (!(e.target as HTMLElement).closest('button, a, input, sup, textarea')) onSelect(); }}>
      <header className="turn-head">
        <h2 className="q">{turn.question}</h2>
        <span className="mode-tag" title={MODES[turn.mode].about}><ModeIcon mode={turn.mode} />{MODES[turn.mode].name}</span>
      </header>

      {turn.asked && turn.answers && <ClarifyRecord questions={turn.asked} answers={turn.answers} />}
      {turn.clarify && <ClarifyCard turn={turn} onStart={onClarify} onAskElse={onFocusComposer} />}

      {turn.live && !turn.clarify && (
        <button className="live-line" onClick={onSelect} title="See every step in the activity panel">
          <span className="pulse" />
          <b>{turn.phase ? phaseLabel(turn, turn.phase) : 'Starting'}…</b>
          {turn.phaseDetail && <span className="live-detail">{turn.phaseDetail}</span>}
          <span className="live-more">{turn.sources.length ? `${turn.sources.length} sources · ` : ''}View activity →</span>
        </button>
      )}

      {hasProse && (
        <div className="prose">
          {turn.sentences.map(s => (
            <span key={s.n} className={`sent v-${s.verdict}`} title={s.verdict === 'flagged' ? s.why ?? 'Could not be confirmed against its quote' : undefined}>
              {pieces(s.text, turn.live).map((p, i) => p.t === 'text' ? <span key={i}>{p.text}</span> : <Cite key={i} turn={turn} n={p.n} verdict={s.verdict} onToast={onToast} />)}
            </span>
          ))}
          {writing && <span className="cursor" aria-hidden="true" />}
        </div>
      )}

      {!turn.live && !hasProse && !turn.clarify && (
        turn.error ? (
          <div className="err"><span className="lab">Stopped</span><p>{turn.error}</p></div>
        ) : turn.stopped ? (
          <div className="blank"><b>You stopped this run</b><p>Nothing more will be shown. The plan and the steps it finished stay in the activity panel. The server may still finish the run in the background — there is no cancel channel yet.</p></div>
        ) : (
          <div className="blank"><b>{turn.stored && turn.note ? 'Saved note' : 'No answer written'}</b><p>{turn.note ?? turn.phaseDetail ?? 'The run finished without writing prose it could cite.'}</p></div>
        )
      )}

      {!turn.live && hasProse && turn.error && <div className="err"><span className="lab">Stopped</span><p>{turn.error}</p></div>}

      <ModeNote turn={turn} />
      {!turn.live && !turn.clarify && (hasProse || turn.unanswered?.length || turn.dropped?.length) ? <Refusals turn={turn} /> : null}

      {!turn.live && turn.related && turn.related.length > 0 && (
        <div className="related">
          <div className="eyebrow">Ask next</div>
          <div className="related-list">
            {turn.related.map(r => <button key={r} className="chip-q" onClick={() => onAsk(r)}><span>+</span>{r}</button>)}
          </div>
          <p className="fine">Suggestions, not findings — written from this answer’s spans and not checked. Each one continues this thread.</p>
        </div>
      )}

      {!turn.live && !turn.clarify && (
        <footer className="actions">
          {hasProse && <button className="btn sm ghost" onClick={() => copy(false)}>Copy answer</button>}
          {hasProse && <button className="btn sm ghost" onClick={() => copy(true)}>Copy with sources</button>}
          <button className="btn sm ghost" onClick={() => onAsk(turn.question)}>Ask again</button>
          {canFork && <button className="btn sm ghost" onClick={onFork} title="Copy this thread up to and including this answer into a new one, and continue there.">Fork from here</button>}
          <span className="cost num">
            {[
              turn.costCents !== undefined && turn.costCents > 0 ? money(turn.costCents) : null,
              turn.flagged ? `${turn.flagged} flagged` : null,
              turn.sources.length ? `${turn.sources.length} source${turn.sources.length === 1 ? '' : 's'}` : null,
              turn.plan?.length ? `${turn.plan.reduce((a, s) => a + (s.found ?? 0), 0)} proved` : null,
              turn.doneAt && !turn.stored ? `${Math.max(1, Math.round((turn.doneAt - turn.startedAt) / 1000))}s` : null,
            ].filter(Boolean).join(' · ')}
          </span>
        </footer>
      )}
    </article>
  );
}

function ModeNote({ turn }: { turn: Turn }) {
  if (turn.live || turn.stored || turn.error || turn.stopped || turn.clarify) return null;
  if (turn.mode === 'deep' && !turn.plan?.length && !turn.reflections.length) {
    return <div className="mode-note"><b>Asked in deep mode — answered in one pass.</b> No plan or steps arrived, so whatever ran, it was not a deep run.</div>;
  }
  if (turn.mode === 'grounded' && turn.sources.length > 0 && turn.sources.every(s => s.kind === 'web')) {
    return <div className="mode-note"><b>Asked in grounded mode — answered from the web.</b> Every source is a web page. Nothing below is from our own evidence.</div>;
  }
  return null;
}

/** "What this answer does not carry" — kept on screen on purpose. */
function Refusals({ turn }: { turn: Turn }) {
  const [open, setOpen] = useState(false);
  const flagged = turn.sentences.filter(s => s.verdict === 'flagged');
  const hasProse = turn.sentences.some(s => s.text.trim());
  const internal = [...new Set(turn.sources.map(s => s.kind).filter(k => k !== 'web'))];
  const dropped = turn.dropped ?? [];
  const unanswered = turn.unanswered ?? [];
  const spanRefusals = turn.unused?.dropped ?? [];
  const expectations = turn.unused?.expectations ?? [];
  const count = flagged.length + dropped.length + unanswered.length + spanRefusals.length;

  return (
    <section className="refusals" data-open={open}>
      <button className="refusals-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="eyebrow">What this answer does not carry</span>
        <span className="refusals-count num">{count === 0 ? 'nothing refused' : `${count} item${count === 1 ? '' : 's'}`}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      {open && (
        <div className="refusals-body">
          <p className="fine">Kept on screen on purpose. A short answer you can act on beats a fluent one you cannot check.</p>
          {turn.note && hasProse && <Group title="What the run said about itself"><p>{turn.note}</p></Group>}
          <Group title="Could not be confirmed">
            {flagged.length ? <ul>{flagged.map(s => <li key={s.n}>{stripMarkers(s.text)}{s.why && <em> — {s.why}</em>}</li>)}</ul>
              : <p className="muted">{turn.stored ? 'Per-sentence checks are not stored with a saved answer. Ask again to re-run them.' : 'None — every sentence matched the spans it cites.'}</p>}
          </Group>
          <Group title="Dropped">
            {dropped.length ? <ul>{dropped.map((d, i) => <li key={i}>{d.claim}<em> — {d.why}</em></li>)}</ul>
              : <p className="muted">{turn.mode === 'verified' ? 'Nothing was dropped on this run.' : 'The drop list belongs to Verified mode.'}</p>}
          </Group>
          {turn.mode === 'grounded' && (
            <Group title="Evidence refused before writing">
              {spanRefusals.length ? <ul>{spanRefusals.map((d, i) => <li key={i}>“{d.span}”<em> — {d.why}</em></li>)}</ul> : <p className="muted">No record was refused on this run.</p>}
            </Group>
          )}
          <Group title="Not answerable from these sources">
            {unanswered.length ? <ul>{unanswered.map((u, i) => <li key={i}>{u}</li>)}</ul>
              : <p className="muted">The run named no gap. That is silence, not a claim that the question was fully covered.</p>}
          </Group>
          {expectations.length > 0 && (
            <Group title="What we expect (not evidence)">
              <ul>{expectations.map(x => <li key={x.id}>{x.claim} <span className="num muted">— p {x.p.toFixed(2)}, resolves {x.resolveAt.slice(0, 10)}</span></li>)}</ul>
            </Group>
          )}
          {internal.length > 0 && (
            <Group title="What our own evidence does not prove">
              {internal.includes('world') && <p>A competitor page is what it said on the day we read it — not what it says today, and not what they actually charge.</p>}
              {internal.includes('brain') && <p>Our own documents are us citing ourselves. They show what we wrote down, not that it is true outside Taskly.</p>}
              {internal.includes('ledger') && <p>A forecast is what we expect at some probability. Nothing in it has been measured.</p>}
            </Group>
          )}
        </div>
      )}
    </section>
  );
}

const Group = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="ref-group"><div className="lab">{title}</div>{children}</div>
);

function ClarifyCard({ turn, onStart, onAskElse }: { turn: Turn; onStart: (answers: string[]) => void; onAskElse: () => void }) {
  const questions = turn.clarify?.questions ?? [];
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''));
  return (
    <section className="clarify">
      <div className="eyebrow">Before it spends anything</div>
      <h3>It wants to know what you mean first</h3>
      <p className="lead">{turn.clarify?.because || 'The question could be read more than one way.'}</p>
      {turn.reAsked && <div className="warn">It asked the same questions again — your answers may not have reached the run.</div>}
      <p className="spend">Nothing has run yet. No search, no page fetched, nothing spent. Answering starts the run; leaving it costs nothing.</p>
      {questions.length === 0 ? <p className="muted">It asked to clarify but named no question. Start the run as is, or rephrase.</p> : (
        <ol className="clarify-qs">
          {questions.map((q, i) => (
            <li key={i}>
              <label htmlFor={`${turn.key}-a${i}`}>{q}</label>
              <input id={`${turn.key}-a${i}`} className="input" value={answers[i] ?? ''} maxLength={500} placeholder="Your answer — or leave it blank"
                onChange={e => setAnswers(a => a.map((x, j) => (j === i ? e.target.value : x)))}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); onStart(answers); } }} />
            </li>
          ))}
        </ol>
      )}
      <div className="clarify-actions">
        <button className="btn" onClick={() => onStart(answers)}>Start the deep run</button>
        <button className="btn ghost" onClick={onAskElse}>Ask something else</button>
      </div>
      <p className="fine">A blank answer means “no preference”, not “skipped”.</p>
    </section>
  );
}

function ClarifyRecord({ questions, answers }: { questions: string[]; answers: string[] }) {
  return (
    <div className="clarify-record">
      <div className="eyebrow">It asked first — you answered</div>
      <dl>{questions.map((q, i) => <div key={i}><dt>{q}</dt><dd>{answers[i]?.trim() || <em>left blank — no constraint</em>}</dd></div>)}</dl>
    </div>
  );
}

export const kindSummary = (turn: Turn) => {
  const counts = new Map<string, number>();
  for (const s of turn.sources) counts.set(s.kind, (counts.get(s.kind) ?? 0) + 1);
  return [...counts.entries()].map(([k, n]) => `${n} ${KIND_INFO[k as keyof typeof KIND_INFO].noun[n === 1 ? 0 : 1]}`).join(' · ');
};
