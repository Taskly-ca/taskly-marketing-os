/**
 * `fact` row ↔ `FactRow`. Pure, and tested without a database.
 *
 * Three mapping decisions live here, and each one is a place the two sides
 * could quietly disagree forever:
 *
 * 1. THE VALUE COLUMN IS THE DATATYPE. `FactValue` is a four-variant tagged
 *    union over four nullable columns, and the obvious implementation reads
 *    `predicate_def.datatype` to decide which column to look at. This does not:
 *    it decodes whichever column is populated. Two reasons. The join disappears
 *    from every read, and — the real one — a fact whose value contradicts its
 *    predicate's declared datatype still round-trips instead of becoming
 *    unreadable. That contradiction is a real possibility (nothing in the schema
 *    forbids it; `validateValue` in `@tmos/world` is where it is caught, in the
 *    domain, before the write), and the memory store round-trips it happily. An
 *    adapter that threw on read would be strictly less substitutable.
 *
 * 2. EVIDENCE IS SNAKE_CASE ON DISK, camelCase in TypeScript. `Evidence` in
 *    `packages/world` says `extractorVersion`; 002's column comment says
 *    `{url, snippet, hash, extractor_version, prompt_version}`. Both files are
 *    outside this lane and neither can be edited to agree with the other, so
 *    ONE of them has to be honoured on disk and the other translated. Disk wins:
 *    every other identifier in this database is snake_case, and a human or an
 *    analyst role following the column comment into `evidence->>'extractor_version'`
 *    must not get NULL back. A silent wrong answer to a plausible query is a
 *    worse failure than a ten-line mapper. Unknown keys pass through verbatim in
 *    both directions — evidence is the audit trail and dropping part of it is
 *    not a thing this package is allowed to do.
 *
 * 3. RANGES ARE READ AS BOUNDS, NEVER AS RANGES. Queries select
 *    `lower(valid)`/`upper(valid)`, not `valid`, because node-postgres has no
 *    parser for `tstzrange` and would hand back the literal text
 *    `["2026-07-01 00:00:00+00",)`. Bounds also map exactly onto `Range`:
 *    `upper()` is NULL precisely when the range is open, which is `to: null`.
 */
import type { Evidence, FactMethod, FactRow, FactStatus, FactValue } from '@tmos/world';
import type { QueryRow } from '@tmos/db';

import { DecodeError } from '../errors.js';
import {
  asIso,
  asIsoOrNull,
  asJsonObject,
  asNumber,
  asText,
  asTextOrNull,
  asUnion,
} from './values.js';

const METHODS: readonly FactMethod[] = ['llm_extract', 'scrape', 'api', 'human'];
const STATUSES: readonly FactStatus[] = ['active', 'retracted', 'disputed'];

/* ── value ↔ object_* columns ───────────────────────────────────────────── */

export interface FactValueColumns {
  /** `object_text` */
  readonly text: string | null;
  /** `object_num` */
  readonly num: number | null;
  /** `object_entity` */
  readonly entity: string | null;
  /** `object_json`, already serialised for a `::jsonb` parameter. */
  readonly json: string | null;
}

export function factValueToColumns(value: FactValue): FactValueColumns {
  const empty = { text: null, num: null, entity: null, json: null };
  switch (value.datatype) {
    case 'text':
      return { ...empty, text: value.text };
    case 'num':
      return { ...empty, num: value.num };
    case 'entity':
      return { ...empty, entity: value.entityId };
    case 'json':
      return { ...empty, json: JSON.stringify(value.json) };
  }
}

/**
 * Which column is populated decides the variant. `hasJson` is passed separately
 * because SQL NULL and the jsonb document `null` both arrive as JS `null` and
 * only the first means "this column is empty" — the query asks Postgres with
 * `object_json is not null` rather than guessing on this side.
 */
export function factValueFromColumns(
  row: { text: unknown; num: unknown; entity: unknown; json: unknown; hasJson: boolean },
  ctx: string,
): FactValue {
  const populated: string[] = [];
  if (row.text !== null && row.text !== undefined) populated.push('object_text');
  if (row.num !== null && row.num !== undefined) populated.push('object_num');
  if (row.entity !== null && row.entity !== undefined) populated.push('object_entity');
  if (row.hasJson) populated.push('object_json');

  if (populated.length === 0) {
    throw new DecodeError(
      `${ctx}: no object_* column is populated — the row holds no value at all`,
    );
  }
  if (populated.length > 1) {
    throw new DecodeError(
      `${ctx}: ${populated.join(' and ')} are both populated; exactly one column is a value`,
    );
  }

  switch (populated[0]) {
    case 'object_text':
      return { datatype: 'text', text: asText(row.text, `${ctx}.object_text`) };
    case 'object_num':
      return { datatype: 'num', num: asNumber(row.num, `${ctx}.object_num`) };
    case 'object_entity':
      return { datatype: 'entity', entityId: asText(row.entity, `${ctx}.object_entity`) };
    default:
      return { datatype: 'json', json: asJsonObject(row.json, `${ctx}.object_json`) };
  }
}

/* ── evidence ↔ jsonb ───────────────────────────────────────────────────── */

/** The only two keys whose spelling differs between the type and the column. */
const EVIDENCE_KEYS: ReadonlyArray<readonly [camel: string, snake: string]> = [
  ['extractorVersion', 'extractor_version'],
  ['promptVersion', 'prompt_version'],
];

export function evidenceToColumn(evidence: Evidence): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(evidence as Record<string, unknown>) };
  for (const [camel, snake] of EVIDENCE_KEYS) {
    if (camel in out) {
      out[snake] = out[camel];
      delete out[camel];
    }
  }
  return out;
}

export function evidenceFromColumn(value: unknown, ctx: string): Evidence {
  const raw = asJsonObject(value ?? {}, ctx);
  for (const [camel, snake] of EVIDENCE_KEYS) {
    if (snake in raw) {
      raw[camel] = raw[snake];
      delete raw[snake];
    }
  }
  return raw as Evidence;
}

/* ── row → FactRow ──────────────────────────────────────────────────────── */

/**
 * Decodes the projection built by `FACT_COLUMNS`. Every field is coerced and
 * named, so a shape the port cannot represent fails here — pointing at the
 * column — instead of three layers later pointing at nothing.
 */
export function rowToFact(row: QueryRow): FactRow {
  const factId = asText(row.fact_id, 'fact.fact_id');
  const at = (column: string): string => `fact[${factId}].${column}`;

  return {
    factId,
    entityId: asText(row.entity_id, at('entity_id')),
    predicate: asText(row.predicate, at('predicate')),
    value: factValueFromColumns(
      {
        text: row.object_text,
        num: row.object_num,
        entity: row.object_entity,
        json: row.object_json,
        hasJson: row.has_json === true,
      },
      `fact[${factId}]`,
    ),
    valid: {
      from: asIso(row.valid_from, at('valid.from')),
      to: asIsoOrNull(row.valid_to, at('valid.to')),
    },
    asserted: {
      from: asIso(row.asserted_from, at('asserted.from')),
      to: asIsoOrNull(row.asserted_to, at('asserted.to')),
    },
    sourceId: asText(row.source_id, at('source_id')),
    observedAt: asIso(row.observed_at, at('observed_at')),
    confidence: asNumber(row.confidence, at('confidence')),
    method: asUnion(row.method, METHODS, at('method')),
    evidence: evidenceFromColumn(row.evidence, at('evidence')),
    supersedes: asTextOrNull(row.supersedes, at('supersedes')),
    status: asUnion(row.status, STATUSES, at('status')),
  };
}

/** Only used by the diagnostic reads, which select bounds and nothing else. */
export function boundsOf(row: QueryRow, axis: 'valid' | 'asserted'): {
  from: string;
  to: string | null;
} {
  return {
    from: asIso(row[`${axis}_from`], `fact.${axis}.from`),
    to: asIsoOrNull(row[`${axis}_to`], `fact.${axis}.to`),
  };
}
