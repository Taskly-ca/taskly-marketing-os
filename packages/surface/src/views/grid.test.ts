import { describe, it, expect } from 'vitest';
import type { EvidenceRef } from '@tmos/contracts';
import { findConfidenceNumbers } from '../basis.js';
import { buildGrid, cellAt, filterRowsByQuestion, sortRowsByQuestion, toCsv } from './grid.js';
import type { GridAnswer } from './grid.js';

const ev = (url: string, span: string, at: string): EvidenceRef => ({
  signal_id: null,
  fact_id: null,
  source_url: url,
  span,
  observed_at: at,
});

const subjects = [
  { ref: 'company:jiffy', label: 'Jiffy' },
  { ref: 'company:taskrabbit', label: 'TaskRabbit' },
  { ref: 'company:handy', label: 'Handy' },
];

const questions = [
  { id: 'take_rate', label: 'What do they keep per job?', freshnessDays: 30 },
  { id: 'sla_hours', label: 'How fast do they promise?' },
];

const answers: GridAnswer[] = [
  {
    subjectRef: 'company:jiffy',
    questionId: 'take_rate',
    value: '20%',
    basis: 'inferred_from_sources',
    asOf: '2026-08-01T00:00:00.000Z',
    evidence: [
      ev('https://jiffy.example/terms', 'we keep 20% of every job', '2026-08-01T00:00:00.000Z'),
    ],
  },
  {
    // Same question, three months old. The comparison across this row is
    // exactly what a reader will do, so the age has to be visible.
    subjectRef: 'company:taskrabbit',
    questionId: 'take_rate',
    value: '15%',
    basis: 'inferred_from_sources',
    asOf: '2026-05-02T00:00:00.000Z',
    evidence: [
      ev('https://taskrabbit.example/help', 'service fee of 15%', '2026-05-02T00:00:00.000Z'),
    ],
  },
  {
    // We asked and found nothing — different from never asking.
    subjectRef: 'company:handy',
    questionId: 'take_rate',
    value: null,
    basis: 'governed_query',
    asOf: '2026-08-04T00:00:00.000Z',
    evidence: [],
  },
  {
    subjectRef: 'company:jiffy',
    questionId: 'sla_hours',
    value: '4',
    basis: 'governed_query',
    asOf: '2026-08-04T00:00:00.000Z',
    evidence: [ev('https://jiffy.example/sla', 'within four hours', '2026-08-04T00:00:00.000Z')],
  },
];

const grid = () =>
  buildGrid({
    subjects,
    questions,
    answers,
    asOf: '2026-08-05T00:00:00.000Z',
    defaultFreshnessDays: 30,
  });

describe('an empty cell is not one thing', () => {
  it('distinguishes "we asked and found nothing" from "we never asked"', () => {
    const g = grid();
    const notFound = cellAt(g, 'company:handy', 'take_rate');
    const notAsked = cellAt(g, 'company:taskrabbit', 'sla_hours');

    expect(notFound?.state).toBe('not_found');
    expect(notAsked?.state).toBe('not_asked');
    expect(notFound?.state).not.toBe(notAsked?.state);

    // Both are blank; only one of them is evidence.
    expect(notFound?.value).toBeNull();
    expect(notAsked?.value).toBeNull();
    expect(notFound?.isEvidenceOfAbsence).toBe(true);
    expect(notAsked?.isEvidenceOfAbsence).toBe(false);
    expect(notAsked?.note).toMatch(/never asked|not asked/i);
    expect(notFound?.asOf).toBe('2026-08-04T00:00:00.000Z');
    expect(notAsked?.asOf).toBeNull();
  });

  it('counts every state so a grid can report its own coverage', () => {
    expect(grid().counts).toEqual({ answered: 2, not_found: 1, not_asked: 2, stale: 1 });
  });
});

describe('cells are independently stamped', () => {
  it('makes a stale cell visibly stale next to a fresh one in the same column', () => {
    const g = grid();
    const fresh = cellAt(g, 'company:jiffy', 'take_rate');
    const stale = cellAt(g, 'company:taskrabbit', 'take_rate');

    expect(fresh?.state).toBe('answered');
    expect(stale?.state).toBe('stale');
    expect(fresh?.value).toBe('20%');
    expect(stale?.value).toBe('15%');
    // Still an answer — staleness is about trust in the comparison, not absence.
    expect(stale?.hasValue).toBe(true);
    expect(stale?.ageDays).toBeGreaterThan(fresh?.ageDays ?? 0);
    expect(stale?.note).toMatch(/95 days/);
    expect(stale?.asOf).not.toBe(fresh?.asOf);
  });

  it('renders each cell basis without a confidence number', () => {
    const g = grid();
    expect(cellAt(g, 'company:jiffy', 'sla_hours')?.basis?.label).toBe('Governed query');
    const json = JSON.stringify(g);
    expect(json).not.toMatch(/domain_?score/i);
    expect(findConfidenceNumbers(json)).toEqual([]);
  });
});

describe('sorting and filtering a column', () => {
  it('sorts by a column deterministically, with absent cells last either way', () => {
    const asc = sortRowsByQuestion(grid(), 'take_rate', 'asc').rows.map((r) => r.subject.ref);
    const desc = sortRowsByQuestion(grid(), 'take_rate', 'desc').rows.map((r) => r.subject.ref);

    expect(asc).toEqual(['company:taskrabbit', 'company:jiffy', 'company:handy']);
    expect(desc).toEqual(['company:jiffy', 'company:taskrabbit', 'company:handy']);
    // Absence never wins a "highest first" sort.
    expect(asc[2]).toBe('company:handy');
    expect(sortRowsByQuestion(grid(), 'take_rate', 'asc').rows.map((r) => r.subject.ref)).toEqual(
      asc,
    );
  });

  it('filters rows by cell state', () => {
    const g = filterRowsByQuestion(grid(), 'take_rate', ['answered']);
    expect(g.rows.map((r) => r.subject.ref)).toEqual(['company:jiffy']);
    expect(g.counts.answered).toBe(2);
  });
});

describe('export', () => {
  const csv = () => toCsv(grid());

  it('preserves the citation, not just the value', () => {
    const out = csv();
    expect(out).toMatch(/https:\/\/jiffy\.example\/terms/);
    expect(out).toMatch(/we keep 20% of every job/);
    expect(out).toMatch(/Inferred from 1 independent source/);
  });

  it('keeps the cell state and the as-of stamp on every row, including empty ones', () => {
    const lines = csv().split('\n');
    expect(lines[0]).toBe(
      'subject,subject_ref,question,question_id,state,answer,as_of,age_days,basis,sources,evidence_spans',
    );
    // one header + subjects × questions
    expect(lines).toHaveLength(1 + subjects.length * questions.length);
    expect(lines.some((l) => l.includes('not_asked'))).toBe(true);
    expect(lines.some((l) => l.includes('not_found'))).toBe(true);
    expect(lines.some((l) => l.includes('stale'))).toBe(true);
  });

  it('escapes a value containing a comma or a quote', () => {
    const g = buildGrid({
      subjects: [{ ref: 'company:jiffy', label: 'Jiffy' }],
      questions: [{ id: 'note', label: 'Note' }],
      answers: [
        {
          subjectRef: 'company:jiffy',
          questionId: 'note',
          value: 'Toronto, ON — "list price"',
          basis: 'governed_query',
          asOf: '2026-08-05T00:00:00.000Z',
          evidence: [],
        },
      ],
      asOf: '2026-08-05T00:00:00.000Z',
    });
    expect(toCsv(g)).toContain('"Toronto, ON — ""list price"""');
  });
});
