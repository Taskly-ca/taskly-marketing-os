/**
 * Decisions and playbooks — where the system becomes accountable to itself.
 *
 * Everything here exists to make one failure mode impossible: deciding, being
 * wrong, and learning nothing because the record was written after the fact.
 *
 *   decision    — ≥2 real alternatives, ≥1 still-open prediction, or no write
 *   blast-radius— if this is wrong, what did we already build on it?
 *   premortem   — what will have killed this, asked BEFORE committing
 *   playbook    — selection is data, not a model; params bind to the FACT-SHEET
 *   ledger      — the prediction is recorded before the outcome exists
 *   graduate    — status is earned from the ledger, never declared
 *   replay      — does memory actually help, scored blind?
 *
 * The through-line is that every mechanism resists the same temptation: to
 * decide what a thing means after you already know how it turned out.
 */
export * from './decision/store.js';
export * from './blast-radius.js';
export * from './premortem.js';
export * from './replay.js';

export * from './playbook/select.js';
export * from './playbook/bind.js';
export * from './playbook/ledger.js';
export * from './playbook/graduate.js';
