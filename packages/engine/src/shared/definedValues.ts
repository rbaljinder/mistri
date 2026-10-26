/**
 * Definition rows read, and values judged by them (definedFields.ts says what
 * a definition is). Pure, and shared: the server judges a stored row with
 * `definedBreaks` (server/app/appValidation.ts) and the record page and New
 * form, loaded on demand, draw and convert with the same words, so the two
 * cannot disagree about what "a number" or "one of the choices" is.
 *
 * Apart from definedFields.ts because a module a first-page file imports is
 * in the first page whole: the query language and the App's declaration read
 * that one, and none of this is needed before a defined field is drawn.
 */
import type { TableMeta } from './schema.js';
import { DEFINED_KEY, DEFINED_TYPES, NEEDED, OPTIONAL, type DefinedField, type DefinedType } from './definedFields.js';

/** The definitions table's columns to read: the needed, the optional it has, and `per`. */
export function definitionColumns(from: Pick<TableMeta, 'columns'>, per?: string): string[] {
  const has = (name: string) => from.columns.some((column) => column.name === name);
  return [...NEEDED, ...OPTIONAL.filter(has), ...(per && has(per) ? [per] : [])];
}

/**
 * The condition that picks a record's definitions, as the structured filter
 * every read takes: those whose `per` is the record's, and those with none.
 * Without `per`, every row.
 */
export function definitionFilter(
  per: string | undefined,
  value: unknown,
): { groups: ({ column: string; op: '='; value: string | number | boolean } | { column: string; op: 'isNull' })[][] } | undefined {
  if (!per) return undefined;
  const scoped = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
  return {
    groups: [...(scoped && value !== '' ? [[{ column: per, op: '=' as const, value }]] : []), [{ column: per, op: 'isNull' as const }]],
  };
}

const yes = (value: unknown) => value === true || value === 1 || value === '1' || value === 'true' || value === 't';

/**
 * Definition rows as fields, in their order: by `position`, then key. A row
 * that cannot be read is left out. Where a scoped row and an unscoped one
 * share a key, the scoped one (it says more about this record) wins.
 */
export function readDefinitions(rows: readonly Readonly<Record<string, unknown>>[], per?: string): DefinedField[] {
  const read = rows.flatMap((row) => {
    const key = typeof row.key === 'string' ? row.key.trim() : '';
    const type = typeof row.type === 'string' ? (row.type.trim() as DefinedType) : undefined;
    if (!DEFINED_KEY.test(key) || !type || !(DEFINED_TYPES as readonly string[]).includes(type)) return [];
    const label = typeof row.label === 'string' && row.label.trim() ? row.label.trim() : key;
    const options =
      typeof row.options === 'string'
        ? [
            ...new Set(
              row.options
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean),
            ),
          ]
        : [];
    const position = typeof row.position === 'number' ? row.position : Number(row.position);
    const field: DefinedField & { position: number; scoped: boolean } = {
      key,
      label,
      type,
      options,
      required: yes(row.required),
      position: Number.isFinite(position) && row.position !== null && row.position !== '' ? position : Number.MAX_SAFE_INTEGER,
      scoped: Boolean(per) && row[per!] !== null && row[per!] !== undefined && row[per!] !== '',
    };
    if (typeof row.help === 'string' && row.help.trim()) field.help = row.help.trim();
    return [field];
  });
  const byKey = new Map<string, (typeof read)[number]>();
  for (const field of read) {
    const kept = byKey.get(field.key);
    if (!kept || (field.scoped && !kept.scoped)) byKey.set(field.key, field);
  }
  return [...byKey.values()]
    .sort((a, b) => a.position - b.position || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map(({ position: _position, scoped: _scoped, ...field }) => field);
}

/** The column's object: as PostgreSQL returns it, or JSON text as SQLite holds it. Undefined where it is not an object. */
export function definedObject(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || raw === undefined || raw === '') return {};
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/** What a value fails: a required one missing, a value of the wrong kind, a choice outside the list, or a key no definition names. */
type DefinedBreak = 'required' | 'number' | 'date' | 'datetime' | 'bool' | 'choice' | 'text' | 'unknown';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:?\d{2})?$/;
/** The most characters one text value holds: a field, not a document. */
const TEXT_MOST = 10000;

const realDate = (text: string) => {
  const date = new Date(`${text.slice(0, 10)}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text.slice(0, 10);
};

/** Whether a value is empty: absent, null, an empty string or an empty list. */
const definedEmpty = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);

/** What one field's value breaks, or undefined. */
function definedBreak(field: DefinedField, value: unknown): DefinedBreak | undefined {
  if (definedEmpty(value)) return field.required ? 'required' : undefined;
  switch (field.type) {
    case 'number':
    case 'money':
      return typeof value === 'number' && Number.isFinite(value) ? undefined : 'number';
    case 'bool':
      return typeof value === 'boolean' ? undefined : 'bool';
    case 'date':
      return typeof value === 'string' && DATE.test(value) && realDate(value) ? undefined : 'date';
    case 'datetime':
      return typeof value === 'string' && DATETIME.test(value) && realDate(value) ? undefined : 'datetime';
    case 'choice':
      return typeof value === 'string' && field.options.includes(value) ? undefined : 'choice';
    case 'choices':
      return Array.isArray(value) &&
        value.every((item) => typeof item === 'string' && field.options.includes(item)) &&
        new Set(value).size === value.length
        ? undefined
        : 'choice';
    default:
      return typeof value === 'string' && value.length <= TEXT_MOST ? undefined : 'text';
  }
}

/**
 * Every break in an object against its fields, by key. `extras` also refuses
 * a key no field names — said when the column itself was written, so a key a
 * removed definition left behind never blocks an edit of something else.
 */
export function definedBreaks(
  fields: readonly DefinedField[],
  object: Readonly<Record<string, unknown>>,
  options: { extras: boolean },
): { key: string; reason: DefinedBreak }[] {
  const breaks = fields.flatMap((field) => {
    const reason = definedBreak(field, object[field.key]);
    return reason ? [{ key: field.key, reason }] : [];
  });
  if (options.extras) {
    const known = new Set(fields.map((field) => field.key));
    for (const key of Object.keys(object)) if (!known.has(key)) breaks.push({ key, reason: 'unknown' });
  }
  return breaks;
}

/** What the server says of a break: a fixed sentence, never a value, a label or rule text. */
export const DEFINED_REASONS: Readonly<Record<DefinedBreak, string>> = Object.freeze({
  required: 'This field is required.',
  number: 'Enter a number.',
  date: 'Enter a date.',
  datetime: 'Enter a date and time.',
  bool: 'Choose yes or no.',
  choice: 'Choose from the list.',
  text: 'Enter text, at most 10,000 characters.',
  unknown: 'This is not one of the fields this record has.',
});

/**
 * A field's value from what a form control holds — text for a box, true or
 * false for a switch, a list for a checklist. Undefined is empty: the key is
 * left out of the object. A box that does not read as its type is kept as
 * typed, for the server to refuse by name.
 */
export function definedFromInput(field: DefinedField, input: unknown): unknown {
  if (definedEmpty(input)) return undefined;
  // A list, or a box's text with one choice per comma.
  if (field.type === 'choices') {
    const chosen = (Array.isArray(input) ? input.map(String) : String(input).split(',')).map((item) => item.trim()).filter(Boolean);
    return chosen.length ? [...new Set(chosen)] : undefined;
  }
  // A switch, or a yes/no list's `1` and `0` (the platform's flag controls).
  if (field.type === 'bool')
    return typeof input === 'boolean'
      ? input
      : input === 'true' || input === '1'
        ? true
        : input === 'false' || input === '0'
          ? false
          : String(input);
  const text = String(input).trim();
  if (field.type === 'number' || field.type === 'money') {
    const n = Number(text.replace(/[,\s$]/g, ''));
    return Number.isFinite(n) ? n : text;
  }
  return field.type === 'textarea' ? String(input) : text;
}

/** The object with one field's value set from its control: an empty value removes the key. */
export function withDefined(object: Readonly<Record<string, unknown>>, field: DefinedField, input: unknown): Record<string, unknown> {
  const next = { ...object };
  const value = definedFromInput(field, input);
  if (value === undefined) delete next[field.key];
  else next[field.key] = value;
  return next;
}
