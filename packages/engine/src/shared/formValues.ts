/**
 * How a form reads a record's own values, in the browser as someone types and on the server after: a condition in
 * the query language compiled to comparisons and judged against a row, a scalar a declaration may hold, the words a
 * default fills in (`today`, `now`, `me`), the starting values a schema's DEFAULTs already say, a stored value as an
 * expression reads it, and a multi-step form's step. The engine's, because the kit's New form draws a table's form
 * with them in both shells; the App framework's form declarations — their parsing, validation, child groups and
 * rules — are formRules.ts and formLines.ts, which re-export what they always named.
 */
import { columnKind, isFlagColumn, type ColumnMeta, type DatabaseSchema, type TableMeta } from './schema.js';
import type { ComputedValue } from './computed.js';
import { NO_ONE_HERE, parseQuery } from './query.js';
import type { Condition } from './filter.js';

/** Data only: local columns, no paths, expressions, clock or executable hooks. */
export type FormScalar = string | number | boolean | null;
/** The comparisons a compiled condition holds: the query language's own, named for the evaluator. */
export type FormOperator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
/**
 * A condition in the query language — the one a page section's `when` and an
 * action's `when` speak — read against a record's own values rather than run
 * as SQL: "completed = false", "stage = closed_won and probability < 100".
 * One language for every condition an App writes; what a form or a rule can
 * evaluate in memory is its comparisons of local columns (`=`, `!=`, `<`,
 * `<=`, `>`, `>=`, `in`, `is (not) empty`) under `and`, `or` and brackets.
 */
export type FormCondition = string;
/** One compiled comparison: true when the field compares with any of the values (one, or an `in` list), or with
 *  the record's own `other` column. */
interface Comparison {
  field: string;
  operator: FormOperator;
  values: readonly FormScalar[];
  other?: string;
}
/** A compiled condition: OR of ANDs, the query language's own filter shape. */
export type CompiledCondition = readonly (readonly Comparison[])[];

/** A finite, data-only step in a multi-step form. Fields belong to one step. The
 * parser gives a step without an id its label's slug, as `step()` does. */
export interface FormStep<Field extends string = string> {
  id: string;
  /** The short name: the review's section, the stepper's entry and the progress bar's "Step 2 of 5: Income". */
  label: string;
  /** Every field the step asks, in order, rows read through. */
  fields: Field[];
  /** The fields as rows, where any row holds more than one (at most three side by side, stacking on a narrow
      screen); absent, one field to a row. Authored as an inner list: `[['first_name', 'last_name'], 'dob']`. */
  rows?: Field[][];
  /** The step's heading in the intake style (the room's h1); absent, its label. */
  title?: string;
  /** One sentence under the title. */
  lead?: string;
  /** The primary button's words on this step; absent, "Continue". */
  next?: string;
  /** The primary's words while every field of the step is empty (each optional): "Skip". */
  skip?: string;
}

/** How a multi-step form is drawn, both under one progress bar: `stepper` (the step's name over its fields) or `intake`
    (the step's title large, one question at a time, a sticky bar of actions and an editable review). */
export type FormStyle = 'stepper' | 'intake';

/** Comparisons in one condition, counted after `or` is multiplied out. */
export const MAX_FORM_PREDICATES = 16;
/** The longest condition text. */
export const MAX_FORM_CONDITION = 2000;
const MAX_FORM_TEXT = 4096;
// eslint-disable-next-line no-control-regex -- Declaration names must exclude ASCII control characters.
export const LOCAL_FIELD = /^[^\s.\x00-\x1f\x7f]{1,256}$/u;
export const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);

function fail(where: string): never {
  // Never stringify rejected data: it may contain row values or executable hooks.
  throw new Error(`${where}: invalid form declaration.`);
}

export function scalar(raw: unknown, where: string): FormScalar {
  if (raw === null) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string' && raw.length <= MAX_FORM_TEXT) return raw;
  if (typeof raw === 'number' && Number.isFinite(raw) && Math.abs(raw) <= Number.MAX_SAFE_INTEGER) return raw;
  return fail(where);
}

function frozen<T extends object>(value: T): T {
  return Object.freeze(value);
}

const QUERY_OPERATORS: Readonly<Record<string, FormOperator>> = { '=': 'eq', '!=': 'ne', '<': 'lt', '<=': 'lte', '>': 'gt', '>=': 'gte' };

/* The one table a condition is read against, for the parser: with the
   record's columns it types each literal by its column ("02134" stays text
   beside a zip code) and names a mistyped column; without, it judges the
   words alone, which is what an App's parse can know before a catalog. */
function conditionSchema(name: string, columns: readonly ColumnMeta[]): DatabaseSchema {
  return {
    label: '',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [{ name, schema: '', id: name, isView: false, columns: [...columns] }],
  };
}

/* A validation reads its own columns and, through one reference, the record that reference names
   (`order_id.status`): the rule a child keeps about its parent ("parts only while the order is on the bench"),
   judged on the server with the parent read in the write's own transaction. One hop: a longer path is a rule
   about a record two tables away, which a command reading it states more plainly. */
function readsThroughReference(column: string): boolean {
  const [via, name, ...more] = column.split('.');
  return !more.length && name !== undefined && [via, name].every((part) => LOCAL_FIELD.test(part) && !RESERVED.has(part));
}

function comparison(condition: Condition, where: string, paths: boolean): Comparison {
  if (!LOCAL_FIELD.test(condition.column) || RESERVED.has(condition.column)) {
    if (!paths || !readsThroughReference(condition.column))
      throw new Error(
        paths
          ? `${where}: "${condition.column}" goes past one reference; a validation reads the record's own columns and, through one reference, that record's (order_id.status).`
          : `${where}: "${condition.column}" is a path; a condition here reads the record's own columns.`,
      );
  }
  const values = (v: unknown): FormScalar[] => (Array.isArray(v) ? v : [v]).map((item) => scalar(item, where));
  if (condition.other !== undefined) {
    const op = QUERY_OPERATORS[condition.op];
    if (!op || !LOCAL_FIELD.test(condition.other) || RESERVED.has(condition.other)) fail(where);
    return { field: condition.column, operator: op, values: [], other: condition.other };
  }
  if (condition.op === 'isNull') return { field: condition.column, operator: 'eq', values: [null] };
  if (condition.op === 'isNotNull') return { field: condition.column, operator: 'ne', values: [null] };
  if (condition.op === 'in') return { field: condition.column, operator: 'eq', values: values(condition.value) };
  const op = QUERY_OPERATORS[condition.op];
  if (!op) {
    throw new Error(
      `${where}: "${condition.op}" matches text, which a condition here cannot; compare with =, !=, <, <=, >, >=, in or is empty.`,
    );
  }
  return { field: condition.column, operator: op, values: values(condition.value) };
}

/** A condition's text, compiled through the query language's own parser. `columns`, when known, type its literals. */
export function compileCondition(
  raw: unknown,
  where: string,
  columns?: readonly ColumnMeta[],
  table = 'record',
  paths = false,
): CompiledCondition {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_FORM_CONDITION) {
    throw new Error(`${where}: a condition is query-language text, like "status = shipped".`);
  }
  // Against the record's columns a bare word beside a number, date or flag may name another column.
  const parsed = parseQuery(`${table} ${raw}`, columns ? { schema: conditionSchema(table, columns), columnValues: true } : {});
  /* A form's condition and a validation are judged against the record's own values, in the browser as someone
     types and on the server after: no session is either place, so `me` is nobody's here (appMe.ts checkMe). */
  if (parsed.errors[0]?.message === NO_ONE_HERE)
    throw new Error(
      `${where} compares with me. A form's conditions and a validation read the record's own values, where the session is not; ` +
        'show the field always, or narrow who may write it with roles.',
    );
  if (parsed.errors.length) throw new Error(`${where}: ${parsed.errors[0].message}`);
  const query = parsed.query!;
  if (query.orderBy.length || query.columns.length || query.limit !== undefined) {
    throw new Error(`${where}: a condition is only a condition — no sort, show or limit.`);
  }
  if (!query.filter.groups.length) throw new Error(`${where}: a condition is query-language text, like "status = shipped".`);
  const groups = query.filter.groups.map((group) => frozen(group.map((c) => frozen(comparison(c, where, paths)))));
  if (groups.flat().length > MAX_FORM_PREDICATES) throw new Error(`${where}: a condition compares at most ${MAX_FORM_PREDICATES} times.`);
  return frozen(groups);
}

type Family = 'number' | 'boolean' | 'text' | 'date' | 'datetime' | 'instant';
export function family(column: ColumnMeta): Family | undefined {
  const type = column.type.trim().toLowerCase();
  if (/^(?:bool|boolean)$/.test(type)) return 'boolean';
  if (
    /^(?:(?:tiny|small|medium|big)?int(?:eger)?|int[248]|(?:small|big)?serial|numeric|decimal|real|double(?: precision)?|float[48]?)(?:\s*\(\s*\d+(?:\s*,\s*\d+)?\s*\))?(?: unsigned)?$/.test(
      type,
    )
  )
    return 'number';
  if (/^(?:date)$/.test(type)) return 'date';
  if (/^(?:timestamptz(?:\(\d+\))?|timestamp(?:\(\d+\))? with time zone)$/.test(type)) return 'instant';
  if (/^(?:datetime|timestamp)(?:\(\d+\))?(?: without time zone)?$/.test(type)) return 'datetime';
  if (
    column.allowed ||
    /^(?:text|(?:tiny|medium|long)text|n?varchar|(?:character varying)|n?char|character|uuid|clob)(?:\(\d+\))?$/.test(type) ||
    type.startsWith('enum(')
  )
    return 'text';
  return undefined;
}

interface Decimal {
  coefficient: bigint;
  scale: number;
}
type Normalized =
  | { kind: 'null' }
  | { kind: 'number'; value: Decimal }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'text' | 'date' | 'datetime' | 'instant'; value: string };

function decimal(raw: unknown): Decimal | undefined {
  if (typeof raw === 'bigint') raw = raw.toString();
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || Math.abs(raw) > Number.MAX_SAFE_INTEGER) return undefined;
    raw = String(raw);
  }
  if (typeof raw !== 'string' || raw.length > MAX_FORM_TEXT) return undefined;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d{1,4}))?$/.exec(raw.trim());
  if (!match) return undefined;
  const exponent = Number(match[5] ?? 0);
  if (Math.abs(exponent) > MAX_FORM_TEXT) return undefined;
  const fraction = match[3] ?? match[4] ?? '';
  let digits = ((match[2] ?? '0') + fraction).replace(/^0+/, '') || '0';
  let scale = fraction.length - exponent;
  while (digits.endsWith('0') && digits !== '0') {
    digits = digits.slice(0, -1);
    scale--;
  }
  return { coefficient: BigInt((match[1] === '-' ? '-' : '') + digits), scale: digits === '0' ? 0 : scale };
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const year = Number(y),
    month = Number(m),
    day = Number(d);
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1];
}

function dateValue(raw: unknown, kind: 'date' | 'datetime' | 'instant'): string | undefined {
  // Date instances are accepted only for instants; interpreting local dates using
  // the machine's timezone would make validation depend on deployment settings.
  if (raw instanceof Date && kind === 'instant') {
    const time = Date.prototype.getTime.call(raw);
    if (!Number.isFinite(time)) return undefined;
    raw = new Date(time).toISOString();
  }
  if (typeof raw !== 'string' || raw.length > 64) return undefined;
  if (kind === 'date') return validDate(raw) ? raw : undefined;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(raw);
  if (!match || !validDate(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] ?? 0) > 59) return undefined;
  const [, date, hour, minute, seconds = '00', fraction = '', zone] = match;
  if (kind === 'datetime') return zone ? undefined : `${date}T${hour}:${minute}:${seconds}.${fraction.padEnd(9, '0')}`;
  if (!zone) return undefined;
  let offset = 0;
  if (zone !== 'Z') {
    const parts = /^([+-])(\d{2})(?::?(\d{2}))?$/.exec(zone)!;
    const hours = Number(parts[2]),
      minutes = Number(parts[3] ?? 0);
    if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return undefined;
    offset = (hours * 60 + minutes) * (parts[1] === '-' ? -1 : 1);
  }
  const time = Date.parse(`${date}T${hour}:${minute}:${seconds}Z`) - offset * 60_000;
  // Store epoch nanoseconds as decimal text; comparison converts only this exact
  // internally produced integer, never the original DB identifier or timestamp.
  return String(BigInt(time) * 1_000_000n + BigInt(fraction.padEnd(9, '0')));
}

export function normalize(column: ColumnMeta, raw: unknown): Normalized | undefined {
  const kind = family(column);
  if (!kind) return undefined;
  if (raw === null) return { kind: 'null' };
  if (kind === 'number') {
    const value = decimal(raw);
    if (!value || (/int|serial/i.test(column.type) && value.scale > 0)) return undefined;
    return { kind, value };
  }
  if (kind === 'boolean') {
    if (raw === true || raw === 1 || raw === 1n || (typeof raw === 'string' && /^(true|yes|1|t)$/i.test(raw.trim())))
      return { kind, value: true };
    if (raw === false || raw === 0 || raw === 0n || (typeof raw === 'string' && /^(false|no|0|f)$/i.test(raw.trim())))
      return { kind, value: false };
    return undefined;
  }
  if (kind === 'text') return typeof raw === 'string' && raw.length <= MAX_FORM_TEXT ? { kind, value: raw } : undefined;
  const value = dateValue(raw, kind);
  return value === undefined ? undefined : { kind, value };
}

function compare(left: Normalized | undefined, op: FormOperator, right: Normalized | undefined): boolean | 'unknown' {
  if (!left || !right) return 'unknown';
  if (left.kind === 'null' || right.kind === 'null') {
    if (op !== 'eq' && op !== 'ne') return 'unknown';
    const equal = left.kind === right.kind;
    return op === 'eq' ? equal : !equal;
  }
  if (left.kind !== right.kind) return 'unknown';
  let order: number;
  if (left.kind === 'number' && right.kind === 'number') {
    const scale = Math.max(left.value.scale, right.value.scale);
    const a = left.value.coefficient * 10n ** BigInt(scale - left.value.scale);
    const b = right.value.coefficient * 10n ** BigInt(scale - right.value.scale);
    order = a < b ? -1 : a > b ? 1 : 0;
  } else if (left.kind === 'instant' && right.kind === 'instant') {
    const a = BigInt(left.value),
      b = BigInt(right.value);
    order = a < b ? -1 : a > b ? 1 : 0;
  } else if (left.kind === 'boolean' && right.kind === 'boolean') {
    if (op !== 'eq' && op !== 'ne') return 'unknown';
    order = left.value === right.value ? 0 : 1;
  } else if (typeof left.value === 'string' && typeof right.value === 'string') {
    // Text ordering is deliberately unavailable: DB collations are not portable.
    if (left.kind === 'text' && op !== 'eq' && op !== 'ne') return 'unknown';
    order = left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
  } else return 'unknown';
  switch (op) {
    case 'eq':
      return order === 0;
    case 'ne':
      return order !== 0;
    case 'lt':
      return order < 0;
    case 'lte':
      return order <= 0;
    case 'gt':
      return order > 0;
    case 'gte':
      return order >= 0;
  }
}

export function columnNamed(columns: readonly ColumnMeta[], name: string): ColumnMeta | undefined {
  const matches = columns.filter((c) => c.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

export function rowValue(row: Readonly<Record<string, unknown>>, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(row, name);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

export function comparisonResult(
  p: Comparison,
  row: Readonly<Record<string, unknown>>,
  columns: readonly ColumnMeta[],
): boolean | 'unknown' {
  const column = columnNamed(columns, p.field);
  if (!column) return 'unknown';
  if (p.other !== undefined) {
    const other = columnNamed(columns, p.other);
    return !other || family(column) !== family(other)
      ? 'unknown'
      : compare(normalize(column, rowValue(row, p.field)), p.operator, normalize(other, rowValue(row, p.other)));
  }
  const results = p.values.map((value) => compare(normalize(column, rowValue(row, p.field)), p.operator, normalize(column, value)));
  return results.includes('unknown') ? 'unknown' : results.some((r) => r === true);
}

export function conditionResult(
  condition: CompiledCondition,
  row: Readonly<Record<string, unknown>>,
  columns: readonly ColumnMeta[],
): boolean | 'unknown' {
  const results = condition.map((group) => group.map((p) => comparisonResult(p, row, columns)));
  // Unknown dependencies never disappear behind a short-circuiting branch.
  if (results.flat().includes('unknown')) return 'unknown';
  return results.some((group) => group.every((r) => r === true));
}

/** Whether a record's values meet a condition: 'unknown' where a value cannot be compared, or the condition cannot be read against these columns. */
export function evaluateFormCondition(
  condition: FormCondition,
  row: Readonly<Record<string, unknown>>,
  columns: readonly ColumnMeta[],
  paths = false,
): boolean | 'unknown' {
  let compiled: CompiledCondition;
  try {
    compiled = compileCondition(condition, 'Condition', columns, 'record', paths);
  } catch {
    return 'unknown';
  }
  return conditionResult(compiled, row, columns);
}

/** The word a form default fills in for its column — the constants `today`, `now`, `me` — or undefined for a literal. */
export function formDefaultWord(column: ColumnMeta, value: unknown): 'today' | 'now' | 'me' | undefined {
  // columnKind, not family: a SQLite TEXT declared a date (`TEXT as date`) is a date here.
  if (value === 'today' || value === 'now') return columnKind(column.type) === 'date' ? value : undefined;
  return value === 'me' && (column.references || columnKind(column.type) === 'text') ? 'me' : undefined;
}

/**
 * A New form's starting values the schema already says: a vocabulary column's
 * literal DEFAULT (`status … default 'booked'`) is the choice the form opens
 * on, so the person sees what the database would write. A clock or a sequence
 * stays the database's to fill. The form's own `defaults` win.
 */
export function inferredFormDefaults(table: { columns: readonly ColumnMeta[] }): Record<string, string> {
  const out: Record<string, string> = {};
  for (const column of table.columns) {
    if (!column.allowed?.length || column.flag || column.default === undefined) continue;
    const literal = /^'((?:[^']|'')*)'(?:::[\w\s."]+)?$/.exec(column.default.trim())?.[1]?.replace(/''/g, "'") ?? column.default.trim();
    if (column.allowed.includes(literal)) out[column.name] = literal;
  }
  return out;
}

/** A stored value as the evaluator reads it, by its column's kind: a number, a yes-or-no, a day, text; null for none. */
export function typedValue(table: TableMeta, column: string, value: unknown): ComputedValue {
  if (value === null || value === undefined || value === '') return null;
  const meta = table.columns.find((c) => c.name === column);
  if (!meta) return null;
  if (isFlagColumn(meta)) return value === true || value === 1 || /^(1|true|t|yes|y)$/i.test(String(value));
  const kind = columnKind(meta.type);
  if (kind === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === 'date') {
    const text = String(value);
    return /^\d{4}-\d{2}-\d{2}$/.test(text) ? { day: text } : Number.isNaN(Date.parse(text)) ? null : { instant: new Date(text) };
  }
  return String(value);
}
