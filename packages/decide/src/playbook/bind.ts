/**
 * Parameter binding — the INC-001 defence, applied to playbooks.
 *
 * INC-001: an agent read a decision record, concluded Taskly charged no
 * customer-facing fee, and propagated a wrong number to five live surfaces
 * including a transactional email. A number quoted from memory drifts from the
 * number in code, and the drift is invisible until it is expensive.
 *
 * So a playbook parameter never carries a constant. It carries a POINTER —
 * `derive_from: 'facts.COMMISSION_RATE'` — and binding resolves that pointer
 * against a fact sheet that is INJECTED by the caller (generated from code by
 * `brain:facts`). This module deliberately contains no copy of any constant;
 * hardcoding one here would be the exact bug it exists to prevent.
 *
 * Three properties make a binding auditable after the fact:
 *   - an unresolvable pointer is a HARD refusal — a playbook that runs with a
 *     missing fee is worse than one that does not run at all;
 *   - every bound value records its provenance and the sheet's own source
 *     string, so "why did it use 20%?" has an answer months later;
 *   - `bindingDrift` diffs two bindings, so a re-run after a fee change shows
 *     the change instead of hiding it.
 */
import type { Playbook } from '@tmos/contracts';

export type ParamSpec = NonNullable<Playbook['params'][string]>;
export type ParamType = ParamSpec['type'];

/** One row of the generated fact sheet. `source` is the file that defines it. */
export interface FactValue {
  value: number | string;
  source: string;
}
export type FactSheet = Readonly<Record<string, FactValue>>;

export type Provenance = 'literal' | 'derived' | 'default';

export interface BoundParam {
  name: string;
  type: ParamType;
  value: number | string;
  provenance: Provenance;
  /** Derived only — the pointer that was resolved. */
  derived_from?: string;
  /** Derived only — where the fact sheet says the value comes from. */
  source?: string;
}

export type BindFailureCode =
  | 'unresolvable_derive_from'
  | 'literal_shadows_derived'
  | 'required_param_missing'
  | 'type_mismatch'
  | 'not_an_integer'
  | 'not_positive'
  | 'enum_out_of_range'
  | 'empty_ref';

export interface BindFailure {
  param: string;
  code: BindFailureCode;
  detail: string;
}

export type BindResult =
  | { ok: true; bound: Record<string, BoundParam>; absent: string[] }
  | { ok: false; failures: BindFailure[] };

export interface BindOptions {
  /** Caller-supplied fallbacks — bound with provenance `default`, so a run
   *  record can tell a policy default apart from a considered value. */
  defaults?: Readonly<Record<string, number | string>>;
  /** Allowed members per `enum` param. Absent = the enum is open. */
  enums?: Readonly<Record<string, readonly string[]>>;
}

/** The only namespace that exists. Anything else is unresolvable, loudly. */
const FACTS = 'facts.';

const describeType = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number' && !Number.isFinite(v)) return 'non-finite number';
  return typeof v;
};

type Validated = { ok: true; value: number | string } | { ok: false; failure: BindFailure };

const fail = (param: string, code: BindFailureCode, detail: string): Validated => ({
  ok: false,
  failure: { param, code, detail },
});

/**
 * Type-check a value against its declared param type. No coercion anywhere:
 * a silent coercion is how a rate becomes a price.
 */
function validate(name: string, spec: ParamSpec, raw: unknown, opts: BindOptions): Validated {
  const type = spec.type;
  const wrongType = (want: string): Validated =>
    fail(
      name,
      'type_mismatch',
      `${name} is declared ${type} and needs ${want}; got ${describeType(raw)}` +
        (raw === null
          ? ' — null is a value, not an absence; omit the key to leave it unbound'
          : ''),
    );

  switch (type) {
    case 'money_cents':
    case 'int':
    case 'duration_days': {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) return wrongType('a finite number');
      if (!Number.isInteger(raw)) {
        return fail(
          name,
          'not_an_integer',
          type === 'money_cents'
            ? `money is integer cents everywhere in this codebase; ${raw} is not a whole number of cents`
            : `${name} is declared ${type}; ${raw} is not a whole number. The params contract has ` +
                `no rate/float type — carry a rate as an integer percent or basis points, in a named unit`,
        );
      }
      if (type === 'duration_days' && raw <= 0) {
        return fail(name, 'not_positive', `${name} is a duration in days; ${raw} is not positive`);
      }
      return { ok: true, value: raw };
    }
    case 'enum': {
      if (typeof raw !== 'string') return wrongType('a string');
      const allowed = opts.enums?.[name];
      if (allowed && !allowed.includes(raw)) {
        return fail(
          name,
          'enum_out_of_range',
          `"${raw}" is not one of ${allowed.map((a) => `"${a}"`).join(', ')}`,
        );
      }
      return { ok: true, value: raw };
    }
    case 'ref': {
      if (typeof raw !== 'string') return wrongType('a string');
      if (raw.trim().length === 0) {
        return fail(name, 'empty_ref', `${name} is a ref and must point at something`);
      }
      return { ok: true, value: raw };
    }
    case 'text': {
      if (typeof raw !== 'string') return wrongType('a string');
      return { ok: true, value: raw };
    }
    default: {
      const unsupported: never = type;
      return fail(name, 'type_mismatch', `unsupported param type ${String(unsupported)}`);
    }
  }
}

type Resolved = { ok: true; fact: FactValue } | { ok: false; detail: string };

function resolveDerived(ref: string, sheet: FactSheet): Resolved {
  if (!ref.startsWith(FACTS)) {
    return {
      ok: false,
      detail: `"${ref}" names no known source — the only namespace is "${FACTS}", generated from code`,
    };
  }
  const key = ref.slice(FACTS.length);
  const fact = Object.prototype.hasOwnProperty.call(sheet, key) ? sheet[key] : undefined;
  if (!fact) {
    const known = Object.keys(sheet).sort().join(', ');
    return {
      ok: false,
      detail: `"${ref}" is not in the injected fact sheet (has: ${known || 'nothing'}) — refusing to run rather than guess`,
    };
  }
  return { ok: true, fact };
}

/**
 * Bind a playbook's params for one run.
 *
 * Precedence is deliberate: a param that declares `derive_from` binds from the
 * fact sheet ONLY. A caller literal for such a param is refused rather than
 * honoured — letting a hand-typed number shadow a generated constant reopens
 * exactly the hole this defends.
 *
 * Every failure is collected, so one run surfaces the whole repair list.
 */
export function bindParams(
  playbook: Playbook,
  ctx: Readonly<Record<string, unknown>>,
  factSheet: FactSheet,
  opts: BindOptions = {},
): BindResult {
  const bound: Record<string, BoundParam> = {};
  const failures: BindFailure[] = [];
  const absent: string[] = [];

  const entries = Object.entries(playbook.params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  for (const [name, spec] of entries) {
    if (!spec) continue;
    // `undefined` reads as absent, exactly as in selection. An explicit `null`
    // does NOT: it is a supplied value, and a wrong one for every param type.
    const supplied = Object.prototype.hasOwnProperty.call(ctx, name) ? ctx[name] : undefined;
    const hasLiteral = supplied !== undefined;

    if (spec.derive_from !== undefined) {
      if (hasLiteral) {
        failures.push({
          param: name,
          code: 'literal_shadows_derived',
          detail: `${name} derives from ${spec.derive_from}; a caller-supplied value would shadow the generated constant`,
        });
        continue;
      }
      const resolved = resolveDerived(spec.derive_from, factSheet);
      if (!resolved.ok) {
        failures.push({ param: name, code: 'unresolvable_derive_from', detail: resolved.detail });
        continue;
      }
      const checked = validate(name, spec, resolved.fact.value, opts);
      if (!checked.ok) {
        failures.push(checked.failure);
        continue;
      }
      bound[name] = {
        name,
        type: spec.type,
        value: checked.value,
        provenance: 'derived',
        derived_from: spec.derive_from,
        source: resolved.fact.source,
      };
      continue;
    }

    const fallback = opts.defaults?.[name];
    const provenance: Provenance = hasLiteral ? 'literal' : 'default';
    const raw = hasLiteral ? supplied : fallback;

    if (raw === undefined) {
      if (spec.required) {
        failures.push({
          param: name,
          code: 'required_param_missing',
          detail: `${name} is required, has no value in the situation and declares no derive_from`,
        });
      } else {
        // Absent — NOT null. An optional param nobody supplied simply is not there.
        absent.push(name);
      }
      continue;
    }

    const checked = validate(name, spec, raw, opts);
    if (!checked.ok) {
      failures.push(checked.failure);
      continue;
    }
    bound[name] = { name, type: spec.type, value: checked.value, provenance };
  }

  return failures.length > 0 ? { ok: false, failures } : { ok: true, bound, absent };
}

export interface ParamDrift {
  param: string;
  change: 'changed' | 'added' | 'removed' | 'provenance_changed';
  from: BoundParam | null;
  to: BoundParam | null;
  detail: string;
}

const origin = (p: BoundParam): string =>
  p.provenance === 'derived' ? `${p.derived_from} · ${p.source}` : p.provenance;

/**
 * What moved between two runs of the same playbook.
 *
 * The point is the re-run after a fee change: the binding is where a changed
 * constant becomes visible, and a diff nobody prints is a diff nobody sees.
 * Sorted by param name, so two runs of this produce identical output.
 */
export function bindingDrift(
  previous: Readonly<Record<string, BoundParam>>,
  next: Readonly<Record<string, BoundParam>>,
): ParamDrift[] {
  const names = [...new Set([...Object.keys(previous), ...Object.keys(next)])].sort();
  const drifts: ParamDrift[] = [];
  const push = (d: ParamDrift): number => drifts.push(d);

  for (const param of names) {
    const from = previous[param] ?? null;
    const to = next[param] ?? null;

    if (!from && to) {
      push({
        param,
        change: 'added',
        from: null,
        to,
        detail: `${param}: added as ${to.value} (${origin(to)})`,
      });
    } else if (from && !to) {
      push({
        param,
        change: 'removed',
        from,
        to: null,
        detail: `${param}: removed (was ${from.value} from ${origin(from)})`,
      });
    } else if (from && to && !Object.is(from.value, to.value)) {
      const detail = `${param}: ${from.value} → ${to.value} (${origin(from)} → ${origin(to)})`;
      push({ param, change: 'changed', from, to, detail });
    } else if (from && to && from.provenance !== to.provenance) {
      // Same number, different authority — a generated constant replaced by a
      // hand-typed one is the first step of INC-001, even at an equal value.
      const detail = `${param}: value unchanged at ${to.value}, but now ${to.provenance} (was ${from.provenance})`;
      push({ param, change: 'provenance_changed', from, to, detail });
    }
  }

  return drifts;
}
