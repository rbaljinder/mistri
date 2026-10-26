import { coerceForColumn, columnKind, isFlagColumn, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { autoKey, formShownFields, isRequired } from '@mistriwork/engine/shared/form.js';
import type { AppForm } from '@mistriwork/engine/shared/servedApp.js';
import { evaluateFormCondition, typedValue, type FormScalar } from '@mistriwork/engine/shared/formValues.js';
import { computedColumnMeta, type ComputedNode } from '@mistriwork/engine/shared/computed.js';
import { evaluateComputed } from '@mistriwork/engine/shared/computedValue.js';

/** The client-side presentation subset of an authored App form. */
export type FormCuration = Omit<AppForm<string>, 'defaults'> & { defaults?: Record<string, unknown> };

interface FormGroup {
  label: string;
  columns: ColumnMeta[];
}

/** Unknown draft dependencies stay visible so an incomplete form never hides
 * the control needed to resolve its own condition. */
export function isFormFieldVisible(
  form: FormCuration | undefined,
  column: ColumnMeta,
  values: Readonly<Record<string, FormScalar | string>>,
  table: TableMeta,
): boolean {
  const condition = form?.when?.[column.name];
  if (!condition) return true;
  try {
    /* A computed column the condition reads is worked out from the draft, as the record will compute it once
       stored: `when: { po_number: 'total > 1000' }`. One over a rollup reads no lines here, so it stays unknown. */
    const computed = Object.entries(table.computed ?? {});
    if (!computed.length) return evaluateFormCondition(condition, values, table.columns) !== false;
    const clock = { today: new Date().toISOString().slice(0, 10), now: new Date(), me: null };
    const worked = Object.fromEntries(
      computed.map(([name, value]) => {
        const result = evaluateComputed(value.expr as ComputedNode, clock, (path) => typedValue(table, path, values[path]));
        return [
          name,
          result !== null && typeof result === 'object' ? ('day' in result ? result.day : result.instant.toISOString()) : result,
        ];
      }),
    );
    const columns = [...table.columns, ...computed.map(([name, value]) => computedColumnMeta(name, value))];
    return evaluateFormCondition(condition, { ...values, ...worked }, columns) !== false;
  } catch {
    // A server-validated form should never reach this branch, but rendering
    // must fail open if a stale app response crosses a client reload.
    return true;
  }
}

function editableColumns(table: TableMeta, app: boolean): ColumnMeta[] {
  const assigned = app ? autoKey(table) : null;
  // A machine's column starts in its first state and then moves only by its verbs.
  return table.columns.filter(
    (c) => c.writable !== false && c.changesBy !== 'actions' && c.identity !== 'always' && !(app && c.identity) && c.name !== assigned,
  );
}

export function formColumns(table: TableMeta, form: FormCuration | undefined, app: boolean): ColumnMeta[] {
  const shown = formShownFields(form);
  const columns = shown ? [...new Set(shown)].flatMap((name) => table.columns.find((c) => c.name === name) ?? []) : table.columns;
  const editable = new Set(editableColumns(table, app));
  return columns.filter((c) => editable.has(c));
}

/** Grouped fields retain authored order; ungrouped fields follow in form order. */
export function formGroups(table: TableMeta, form: FormCuration | undefined, app: boolean): FormGroup[] {
  const columns = formColumns(table, form, app);
  if (!form?.groups?.length) return [{ label: '', columns }];
  const byName = new Map(columns.map((column) => [column.name, column]));
  const claimed = new Set<string>();
  const groups = form.groups.flatMap((group) => {
    const groupColumns = group.fields.flatMap((name) => {
      const column = byName.get(name);
      if (!column || claimed.has(name)) return [];
      claimed.add(name);
      return [column];
    });
    return groupColumns.length ? [{ label: group.label, columns: groupColumns }] : [];
  });
  const remainder = columns.filter((column) => !claimed.has(column.name));
  if (remainder.length) groups.push({ label: '', columns: remainder });
  return groups.length ? groups : [{ label: '', columns }];
}

export function presetValue(column: ColumnMeta, defaults: Record<string, unknown>): string {
  const value = Object.hasOwn(defaults, column.name) ? defaults[column.name] : undefined;
  if (value === null || value === undefined) return '';
  if (!column.allowed?.length && isFlagColumn(column)) {
    const flag = typeof value === 'string' ? coerceForColumn(column.type, value) : value;
    if (typeof flag === 'boolean') return flag ? '1' : '0';
  }
  return String(value);
}

/** Returning to a displayed preset is clean, except when clearing means omission. */
export function hasFormChanges(
  columns: ColumnMeta[],
  values: Record<string, string>,
  defaults: Record<string, unknown>,
  edited: ReadonlySet<string>,
): boolean {
  return columns.some((column) => {
    if (!edited.has(column.name)) return false;
    const value = values[column.name] ?? '';
    return (
      value !== presetValue(column, defaults) ||
      (value === '' && Object.hasOwn(defaults, column.name) && defaults[column.name] !== undefined)
    );
  });
}

/** Untouched DSL defaults retain their types; a cleared, edited control means omission. */
export function insertValues(
  values: Record<string, string>,
  defaults: Record<string, unknown>,
  edited: ReadonlySet<string>,
  columns: readonly ColumnMeta[],
): Record<string, unknown> {
  const entries = new Map(Object.entries(defaults).filter(([, value]) => value !== undefined));
  for (const [name, value] of Object.entries(values)) {
    if (!edited.has(name) && entries.has(name)) continue;
    entries.delete(name);
    if (value !== '') entries.set(name, value);
  }
  // Curation may hide allowed defaults, but cannot restore fields omitted or
  // made read-only by the server. Also removes stale values from an open form.
  const writable = new Set(columns.filter((column) => column.writable !== false).map((column) => column.name));
  return Object.fromEntries([...entries].filter(([name]) => writable.has(name)));
}

/**
 * The required columns a create leaves without a value. `derived` is the form's values taken from a referenced
 * record (`{ from: 'part_id.unit_price' }`), for columns the form does not show: the server fills one from the
 * record its reference names (server app/appValidation.ts fillDerived), so it is not missing while that
 * reference has a value. A shown one the person emptied is theirs to fill, and is not passed here.
 */
export function missingFields(
  columns: ColumnMeta[],
  values: Record<string, unknown>,
  assigned: string | null,
  derived?: Readonly<Record<string, string | undefined>>,
): ColumnMeta[] {
  return columns.filter((column) => {
    if (column.writable === false) return false;
    const present = Object.hasOwn(values, column.name) && values[column.name] !== undefined;
    if (present) return !column.nullable && values[column.name] === null;
    const via = derived?.[column.name]?.split('.')[0];
    if (via && values[via] !== undefined && values[via] !== null && values[via] !== '') return false;
    return isRequired(column, assigned);
  });
}

/* ---------- an App's New form: its frame, its inputs, its starting words ---------- */

/** A drawer holds a short form beside the list; past this many fields, or with steps, the form is a page of its own. */
const DRAWER_FIELDS = 8;

/** Where the New form is drawn: what it says, else a drawer for a short form and a page for a long or stepped one. */
export function formFrame(form: FormCuration | undefined, fieldCount: number): 'drawer' | 'page' {
  if (form?.open) return form.open;
  return form?.steps?.length || fieldCount > DRAWER_FIELDS ? 'page' : 'drawer';
}

export type FieldInput =
  | 'text'
  | 'textarea'
  | 'richText'
  | 'number'
  | 'money'
  | 'radios'
  | 'listbox'
  | 'switch'
  | 'flag'
  | 'date'
  | 'datetime'
  | 'reference';

/* A text column holding prose rather than a name or a code: said by its name,
   since a TEXT or `text` type says nothing of its length. */
const PROSE =
  /^(?:description|notes?|body|bio|biography|comments?|summary|details|message|instructions|remarks|content|about)$|_(?:notes?|description|details|comments?|summary)$/i;
/** Radios show every word at once; past this many the listbox is shorter. The command form's rule. */
const RADIO_WORDS = 4;

/** The declared length of a text column, when its type says one: `varchar(500)` → 500. */
function declaredLength(column: ColumnMeta): number | undefined {
  const match = /\(\s*(\d+)\s*\)/.exec(column.type);
  return match ? Number(match[1]) : undefined;
}

/** Whether a text column is drawn as a box of several lines. */
function isMultiline(column: ColumnMeta, multiline?: boolean): boolean {
  if (multiline !== undefined) return multiline;
  if (column.allowed?.length || columnKind(column.type) !== 'text') return false;
  const length = declaredLength(column);
  if (length !== undefined) return length > 255;
  return /^(?:mediumtext|longtext|clob|ntext)$/i.test(column.type.trim()) || PROSE.test(column.name);
}

/**
 * The input an App's New form draws a column as, from the column and how the
 * App dresses it. `hasStart` is whether the field starts with a value (a form
 * default, or the database's): a vocabulary or a flag that must be answered
 * and has none to start from stays a listbox, whose empty entry says so.
 */
export function fieldInput(
  column: ColumnMeta,
  options: { money?: boolean; multiline?: boolean; richText?: boolean; required: boolean; hasStart: boolean; reference: boolean },
): FieldInput {
  if (column.allowed?.length) return column.allowed.length <= RADIO_WORDS && (options.required || options.hasStart) ? 'radios' : 'listbox';
  const kind = columnKind(column.type);
  /* A declared boolean, or an integer a CHECK pins to 0 and 1: both are yes or no. */
  if (isFlagColumn(column)) return options.hasStart ? 'switch' : 'flag';
  if (options.reference) return 'reference';
  if (kind === 'date') return /time/i.test(column.type) ? 'datetime' : 'date';
  if (kind === 'number') return options.money ? 'money' : 'number';
  if (options.richText) return 'richText';
  return isMultiline(column, options.multiline) ? 'textarea' : 'text';
}

/** What a form default's word starts as, now: `today` a date, `now` a wall-clock time (or a date on a date column), said as the date field says one: `YYYY-MM-DD HH:MM`. */
export function clockDefault(word: 'today' | 'now', column: ColumnMeta, now: Date, timeZone?: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return word === 'now' && /time/i.test(column.type) ? `${date} ${parts.hour}:${parts.minute}` : date;
}

/** The choices a narrowed reference offers, in the query language: `project_id = 4`; undefined while a field it reads is empty. */
export function narrowingCondition(
  where: Readonly<Record<string, string>> | undefined,
  values: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!where) return '';
  const clauses: string[] = [];
  for (const [remote, local] of Object.entries(where)) {
    const value = values[local];
    if (value === undefined || value === null || value === '') return undefined;
    // A key typed as text ("4") is still a number to the column; a word is quoted, so `me` or `today` is never read as one.
    const text = String(value);
    clauses.push(`${remote} = ${typeof value !== 'string' || /^-?\d+(?:\.\d+)?$/.test(text) ? text : JSON.stringify(text)}`);
  }
  return clauses.join(' and ');
}

/**
 * Where a flag's switch starts: the form's default, else the database's when
 * it is a plain true or false, else off for a flag that must be answered. A
 * nullable flag with nothing to start from has none, and keeps the listbox
 * whose empty entry means "leave it".
 */
export function flagStart(column: ColumnMeta, defaults: Record<string, unknown>): boolean | undefined {
  if (Object.hasOwn(defaults, column.name)) {
    const value = defaults[column.name];
    const flag = typeof value === 'string' ? coerceForColumn(column.type, value) : value;
    if (typeof flag === 'boolean') return flag;
    /* An integer flag's default, said either way: 1, '1', true, 'true'. */
    const said = String(value).trim().toLowerCase();
    return /^(?:1|true|t)$/.test(said) ? true : /^(?:0|false|f)$/.test(said) ? false : undefined;
  }
  const stored = String(column.default ?? '')
    .replace(/^'(.*)'$/, '$1')
    .trim()
    .toLowerCase();
  if (/^(?:1|true|t)$/.test(stored)) return true;
  if (/^(?:0|false|f)$/.test(stored)) return false;
  return column.default === undefined && column.hasDefault !== true && !column.nullable ? false : undefined;
}
