/**
 * A command's conditions over its draft: a field's `when` and the command's `rules`, judged by one evaluator in the
 * browser as someone types and on the server as the command runs (and at each step's check). The language is the
 * form conditions' (formValues.ts), read against the input's own fields as columns: a bare name is another field of
 * the input, and on a command over one record `record.<column>` is the target's own value — bound where the record
 * is read (prepare in the browser's case, the run's transaction on the server), so the browser is told only whether
 * each record part holds, never a value it was not shown.
 *
 * A condition is kept as its text and compiled where it is judged, so `today` is the day it is judged on. Date
 * arithmetic the query language does not say — `today - 18 years` — is worked out to a day first (`dateWords`).
 */
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { compileCondition, conditionResult, type CompiledCondition } from '@mistriwork/engine/shared/formValues.js';
import { quoteValue } from '@mistriwork/engine/shared/query.js';
import type { AppCommandField } from './command.js';

type Field = AppCommandField;
type Comparison = CompiledCondition[number][number];

/** The record's own value in a condition: `record.<column>`. */
const RECORD_PREFIX = 'record.';

const UNITS: Record<string, 'day' | 'month' | 'year'> = {
  day: 'day',
  days: 'day',
  week: 'day',
  weeks: 'day',
  month: 'month',
  months: 'month',
  year: 'year',
  years: 'year',
};
const ARITHMETIC = /\btoday\s*([+-])\s*(\d{1,4})\s*(days?|weeks?|months?|years?)\b/gi;

/** The day `today ± N units` names, from `today` (YYYY-MM-DD); a month or a year past the month's end lands on its last day. */
function shifted(today: string, sign: string, count: number, unit: string): string {
  const [y, m, d] = today.split('-').map(Number);
  const by = (sign === '-' ? -1 : 1) * count * (unit.startsWith('week') ? 7 : 1);
  const kind = UNITS[unit.toLowerCase()];
  if (kind === 'day') return new Date(Date.UTC(y, m - 1, d + by)).toISOString().slice(0, 10);
  const months = kind === 'year' ? by * 12 : by;
  const first = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(d, last))).toISOString().slice(0, 10);
}

/** A condition with each `today - 18 years` (days, weeks, months, years) said as the day it names. */
function dateWords(text: string, today: string): string {
  return text.replace(ARITHMETIC, (_, sign: string, count: string, unit: string) => shifted(today, sign, Number(count), unit));
}

/* The column a field reads as, so a literal compares as its kind does: an amount as a number, a day as a day. */
function columnType(field: Field): string | undefined {
  switch (field.type) {
    case 'number':
    case 'money':
      return 'NUMERIC';
    case 'boolean':
      return 'BOOLEAN';
    case 'date':
      return 'DATE';
    case 'datetime':
      return 'TIMESTAMPTZ';
    case 'choice':
      return field.options.length && field.options.every((option) => typeof option.value === 'number') ? 'NUMERIC' : 'TEXT';
    case 'text':
    case 'textarea':
    case 'month':
    case 'reference':
      return 'TEXT';
    default:
      return undefined;
  }
}

/** The input's fields a condition may name, as the columns it is judged against: never a group, lines, rich text,
    several choices, questions in rows, or a sensitive value. */
function draftColumns(fields: readonly Field[]): ColumnMeta[] {
  return fields.flatMap((field) => {
    const type = columnType(field);
    if (!type || (field.type === 'text' && field.sensitive)) return [];
    return [{ name: field.name, type, nullable: true, primaryKey: false }];
  });
}

const today = (now: Date) => now.toISOString().slice(0, 10);

/**
 * A condition read as its words alone, for the parser: each comparison's name, and the fault in it. A bare word
 * equal to a field's name, on the right, is that field (`confirm_email = email`): quote a literal that would read
 * as one.
 */
function draftCondition(text: string, where: string, now = new Date(), fields?: readonly Field[]): CompiledCondition {
  const said = dateWords(text, today(now));
  const untyped = compileCondition(said, where, undefined, 'record', true);
  if (!fields) return untyped;
  /* Read again against the fields' own kinds, so a bare word is the kind its field holds: `battery != no` over a
     choice of words compares the word "no", and only a yes-or-no field reads yes and no as true and false. Untyped,
     every bare yes or no was a boolean, which a text choice never equals, so the condition never held. A name that is
     no judgeable field (a record's column) stays untyped, read as it was. */
  const columns = draftColumns(fields);
  const known = new Set(columns.map((column) => column.name));
  for (const c of untyped.flat())
    for (const name of [c.field, ...(c.other === undefined ? [] : [c.other])])
      if (!known.has(name)) {
        known.add(name);
        columns.push({ name, type: '', nullable: true, primaryKey: false });
      }
  try {
    return compileCondition(said, where, columns, 'record', true);
  } catch {
    return untyped;
  }
}

/** The names a condition reads: the input's fields, and the record's columns (`record.<column>`). */
export function draftNames(text: string, where: string): { fields: string[]; record: string[] } {
  const fields = new Set<string>();
  const record = new Set<string>();
  for (const c of draftCondition(text, where).flat()) {
    for (const name of [c.field, ...(c.other === undefined ? [] : [c.other])]) {
      if (name.startsWith(RECORD_PREFIX)) record.add(name.slice(RECORD_PREFIX.length));
      else if (name.includes('.'))
        throw new Error(
          `${where}: "${name}" is a path; a condition here names a field of the input, or record.<column> for the record's own.`,
        );
      else fields.add(name);
    }
  }
  return { fields: [...fields], record: [...record] };
}

/* A comparison whose one value is a bare word naming another field compares the two fields. */
function withFields(condition: CompiledCondition, names: ReadonlySet<string>): CompiledCondition {
  return condition.map((group) =>
    group.map((c) =>
      c.other === undefined && c.values.length === 1 && typeof c.values[0] === 'string' && names.has(c.values[0]) && c.values[0] !== c.field
        ? ({ field: c.field, operator: c.operator, values: [], other: c.values[0] } as Comparison)
        : c,
    ),
  );
}

/** One comparison as the query language says it: a record's over the target (its `record.` dropped), a draft's as written. */
function recordComparisonText(c: Comparison): string {
  const column = c.field.startsWith(RECORD_PREFIX) ? c.field.slice(RECORD_PREFIX.length) : c.field;
  if (c.other !== undefined) return `${column} ${{ eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[c.operator]} ${c.other}`;
  if (c.values.length === 1 && c.values[0] === null) return `${column} ${c.operator === 'ne' ? 'is not empty' : 'is empty'}`;
  if (c.values.length > 1) return `${column} in (${c.values.map((v) => quoteValue(v)).join(', ')})`;
  const op = { eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' }[c.operator];
  return `${column} ${op} ${quoteValue(c.values[0])}`;
}

/** Each `record.<column>` comparison a condition makes, as the query language says it over the target. */
export const recordComparisons = (text: string): string[] =>
  draftCondition(text, 'Condition')
    .flat()
    .filter((c) => c.field.startsWith(RECORD_PREFIX))
    .map(recordComparisonText);

/** A condition bound to a record: each `record.<column>` comparison replaced by whether it holds, so what is left
    reads the draft alone. `[]` holds never; a group of no comparisons always. */
export type BoundCondition = CompiledCondition;

/** Bind a condition's record parts by `holds` (the server's judgement of each one over the target). */
export async function bindRecord(
  text: string,
  where: string,
  holds: (comparison: string) => Promise<boolean>,
  now = new Date(),
  fields?: readonly Field[],
): Promise<BoundCondition> {
  const groups: Comparison[][] = [];
  for (const group of draftCondition(text, where, now, fields)) {
    const kept: Comparison[] = [];
    let alive = true;
    for (const c of group) {
      if (!c.field.startsWith(RECORD_PREFIX)) kept.push(c);
      else if (!(await holds(recordComparisonText(c)))) {
        alive = false;
        break;
      }
    }
    if (alive) groups.push(kept);
  }
  return groups;
}

/** A bound condition said again as text over the draft alone, as prepare serves it: `true` where it always holds,
    `false` where it never does. */
export function boundText(bound: BoundCondition): string | boolean {
  if (!bound.length) return false;
  if (bound.some((group) => !group.length)) return true;
  return bound.map((group) => group.map(recordComparisonText).join(' and ')).join(' or ');
}

/** Whether a condition that names the record has been bound: one with no record part needs no binding. */
export const readsRecord = (text: string): boolean =>
  draftCondition(text, 'Condition')
    .flat()
    .some((c) => c.field.startsWith(RECORD_PREFIX));

/* An answer not given: absent, null, or an empty box. */
const unanswered = (value: unknown): boolean => value === undefined || value === null || value === '';

/* A comparison that asks whether a field is empty (`is empty`, `is not empty`): the one kind an unanswered field answers. */
const asksEmpty = (c: Comparison): boolean => c.other === undefined && c.values.length === 1 && c.values[0] === null;

/**
 * Whether a condition holds of a draft: its text (compiled now) or a bound condition. Three-valued, as SQL is: a field
 * not yet answered is null, and a comparison with null is unknown — `entry_ok = false` and `entry_ok != true` alike —
 * so it does not hold until someone answers. Only `is empty` and `is not empty` read the null itself. A comparison
 * that cannot be judged otherwise (an order over text) is unknown too. A group holds where every comparison in it
 * holds; the condition holds where one group does, so an `or` whose other side is unanswered still holds.
 */
export function draftHolds(
  condition: string | BoundCondition,
  values: Readonly<Record<string, unknown>>,
  fields: readonly Field[],
  now = new Date(),
): boolean {
  const columns = draftColumns(fields);
  const names = new Set(columns.map((column) => column.name));
  const compiled = withFields(typeof condition === 'string' ? draftCondition(condition, 'Condition', now, fields) : condition, names);
  if (!compiled.length) return false;
  // A group bound to nothing but record parts that held: it holds.
  if (compiled.some((group) => !group.length)) return true;
  const row = Object.fromEntries(columns.map((column) => [column.name, unanswered(values[column.name]) ? null : values[column.name]]));
  const holds = (c: Comparison): boolean => {
    if (!asksEmpty(c) && [c.field, ...(c.other === undefined ? [] : [c.other])].some((name) => row[name] === null)) return false;
    return conditionResult([[c]], row, columns) === true;
  };
  return compiled.some((group) => group.every(holds));
}

/** The rule as the command declares it (CommandRule) and serves it. */
export interface DraftRule {
  must: string;
  when?: string;
  message: string;
}

/** The field a rule's message is said at: the first one its `must` names. */
const ruleField = (rule: DraftRule): string => draftNames(rule.must, 'Rule').fields[0];

/** The rules a draft breaks, each at its field: those whose `when` holds (or that have none) and whose `must` does not. */
export function brokenRules(
  rules: readonly DraftRule[],
  values: Readonly<Record<string, unknown>>,
  fields: readonly Field[],
  now = new Date(),
): Array<{ field: string; message: string }> {
  const broken: Array<{ field: string; message: string }> = [];
  for (const rule of rules) {
    const names = draftNames(rule.must, 'Rule').fields;
    // A rule is judged once every field it names is answered: an empty field is its own field's to say (required).
    if (names.some((name) => values[name] === undefined || values[name] === null || values[name] === '')) continue;
    if (rule.when !== undefined && !draftHolds(rule.when, values, fields, now)) continue;
    if (!draftHolds(rule.must, values, fields, now)) broken.push({ field: ruleField(rule), message: rule.message });
  }
  return broken;
}
