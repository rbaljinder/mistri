/**
 * How a JSON value is laid out, before it is drawn.
 *
 * A json or jsonb column holds a document, and a document said as
 * `[object Object]` — or as one unbroken line of braces — is a value
 * nobody can read. This decides, from the value's own shape, what it is
 * best shown as: an object as labelled fields, an array of like records as
 * a table, an array of words as chips, a scalar as what it is. Every
 * decision is pure, so the view only draws, and the grid's one-line
 * preview and the full view cannot disagree about what a value is.
 */
import { isJsonType } from '@mistriwork/engine/shared/schema.js';
import { say } from '../copy/record/components/jsonModel.js';

/** Containers this deep or deeper start folded: two levels read, the rest is a click away. */
export const OPEN_DEPTH = 2;
/** Array items and table rows drawn before "Show N more". */
export const ITEM_PAGE = 20;
/** Object keys drawn before "Show N more": a settings blob can carry hundreds. */
export const KEY_PAGE = 50;
/** The most one "Show N more" adds: ten thousand rows at once is the page freezing, not a view. */
export const MORE_STEP = 200;
/** Table columns drawn before the rest fold into one column per row. */
export const TABLE_COLUMNS = 8;
/** An array of objects is a table when its rows hold at least this share of the union of keys. */
const TABLE_COVERAGE = 0.6;
/** A scalar array whose items all fit this is a row of chips; longer items get a line each. */
const CHIP_TEXT = 32;
/** Text past this, or with a line break, wraps as a block rather than running on. */
const LONG_TEXT = 90;
/** How much of a grid cell the preview may fill with a scalar array's own items. */
const PREVIEW_TEXT = 40;

/** A whole number past 2^53 read from JSON text, kept as the digits it was written with. */
export class JsonBig {
  constructor(readonly text: string) {}
}

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;
/* JSON.parse hands a reviver each primitive's source text (where the engine
   supports it), which is the one moment a big integer's digits still exist:
   `Number("9007199254740993")` is already the wrong id. */
const keepBig: Reviver = (_key, value, context) =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  !Number.isSafeInteger(value) &&
  context?.source !== undefined &&
  /^-?\d+$/.test(context.source)
    ? new JsonBig(context.source)
    : value;

/* A grid redraws its cells on every sort and refetch; a document is parsed
   once per text, not once per paint. Bounded, and dropped whole when full,
   because the texts on screen are the only ones worth keeping. */
const parsed = new Map<string, unknown>();
const PARSED_KEEP = 500;

/** JSON text read as a value, or null when it is not JSON. */
export function parseJsonText(text: string): { value: unknown } | null {
  if (parsed.has(text)) return { value: parsed.get(text) };
  let value: unknown;
  try {
    value = JSON.parse(text, keepBig as Parameters<typeof JSON.parse>[1]);
  } catch {
    return null;
  }
  if (parsed.size >= PARSED_KEEP) parsed.clear();
  parsed.set(text, value);
  return { value };
}

export function isContainer(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !(value instanceof JsonBig);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isContainer(value) && !Array.isArray(value);
}

/** How many keys an object has, or items an array. */
export function sizeOf(value: object): number {
  return Array.isArray(value) ? value.length : Object.keys(value).length;
}

/**
 * The document a value holds, when it holds one. Postgres json/jsonb and
 * MySQL JSON arrive already parsed (and a Postgres array arrives as an
 * array); a column declared JSON that keeps text — SQLite's — arrives as the
 * text, and is read here. A string that does not open like a document stays
 * a string: in a jsonb column it *is* the JSON string, already decoded, and
 * `"42"` is text there, not a number.
 */
export function jsonValueOf(col: { type?: string } | undefined, value: unknown): { value: object } | null {
  if (isContainer(value)) return { value };
  if (typeof value !== 'string' || !isJsonType(col?.type) || !/^\s*[[{]/.test(value)) return null;
  const read = parseJsonText(value);
  return read && isContainer(read.value) ? { value: read.value } : null;
}

/** What a container is best shown as. */
export type Layout =
  | { kind: 'scalar' }
  | { kind: 'empty'; text: '{}' | '[]' }
  /** An object's keys, or a mixed array's positions, each a quiet label beside its value. */
  | { kind: 'fields'; entries: Array<[string, unknown]>; indexed: boolean }
  | { kind: 'table'; columns: string[]; folded: string[]; rows: Array<Record<string, unknown>> }
  | { kind: 'chips'; items: unknown[] }
  | { kind: 'lines'; items: unknown[] };

export function layoutOf(value: unknown): Layout {
  if (!isContainer(value)) return { kind: 'scalar' };
  if (!Array.isArray(value)) {
    const entries = Object.entries(value);
    return entries.length ? { kind: 'fields', entries, indexed: false } : { kind: 'empty', text: '{}' };
  }
  if (!value.length) return { kind: 'empty', text: '[]' };
  const union = tableColumns(value);
  if (union) {
    return {
      kind: 'table',
      columns: union.slice(0, TABLE_COLUMNS),
      folded: union.slice(TABLE_COLUMNS),
      rows: value as Array<Record<string, unknown>>,
    };
  }
  if (value.every((item) => typeof item === 'string' || typeof item === 'number' || item instanceof JsonBig)) {
    return value.every((item) => rawText(item).length <= CHIP_TEXT) ? { kind: 'chips', items: value } : { kind: 'lines', items: value };
  }
  if (value.every((item) => !isContainer(item))) return { kind: 'lines', items: value };
  return { kind: 'fields', entries: value.map((item, i): [string, unknown] => [String(i), item]), indexed: true };
}

/**
 * The columns of an array of like records, first seen first — or null when
 * the records are not alike enough to line up. One record is not a table:
 * it reads better as its fields.
 */
function tableColumns(items: unknown[]): string[] | null {
  if (items.length < 2 || !items.every(isRecord)) return null;
  const union: string[] = [];
  const seen = new Set<string>();
  let held = 0;
  for (const item of items as Array<Record<string, unknown>>) {
    const keys = Object.keys(item);
    held += keys.length;
    for (const key of keys)
      if (!seen.has(key)) {
        seen.add(key);
        union.push(key);
      }
  }
  if (!union.length) return null;
  return held / (items.length * union.length) >= TABLE_COVERAGE ? union : null;
}

/** A table row's keys past the drawn columns, for the row's own fold. */
export function restOf(row: Record<string, unknown>, columns: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !columns.includes(key)));
}

/** "5 keys", "1 item". */
export function countLabel(value: object, locale?: string): string {
  const n = sizeOf(value);
  const noun = Array.isArray(value) ? 'item' : 'key';
  return `${n.toLocaleString(locale)} ${noun}${n === 1 ? '' : 's'}`;
}

function rawText(value: unknown): string {
  if (value instanceof JsonBig) return value.text;
  if (value === null) return 'null';
  return String(value);
}

/**
 * A document in one line, for a grid cell: `{ id, name, +3 }`, `[red,
 * green]`, `[12 items]`. Keys rather than values, because a key says what
 * the document is and a value out of context says nothing.
 */
export function previewOf(value: object): string {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    if (value.every((item) => !isContainer(item))) {
      const said = `[${value.map(rawText).join(', ')}]`;
      if (said.length <= PREVIEW_TEXT) return said;
    }
    return `[${countLabel(value)}]`;
  }
  const keys = Object.keys(value);
  if (!keys.length) return '{}';
  const shown: string[] = [];
  let length = 0;
  for (const key of keys) {
    if (shown.length === 3 || (shown.length && length + key.length > PREVIEW_TEXT - 12)) break;
    shown.push(key);
    length += key.length + 2;
  }
  const more = keys.length - shown.length;
  return `{ ${shown.join(', ')}${more ? `, +${more}` : ''} }`;
}

/** What a scalar is best shown as. */
export type Scalar =
  | { kind: 'null' }
  | { kind: 'boolean'; on: boolean }
  | { kind: 'number'; text: string; title?: string }
  | { kind: 'link'; text: string; href: string }
  | { kind: 'date'; text: string; title: string }
  | { kind: 'empty' }
  | { kind: 'text'; text: string; long: boolean };

export function scalarOf(value: unknown, locale: string | undefined): Scalar {
  if (value === null || value === undefined) return { kind: 'null' };
  if (typeof value === 'boolean') return { kind: 'boolean', on: value };
  if (value instanceof JsonBig) return { kind: 'number', text: value.text, title: say('aWholeNumberPast') };
  if (typeof value === 'number') return numberOf(value, locale);
  if (typeof value !== 'string') return { kind: 'text', text: String(value), long: false };
  if (value === '') return { kind: 'empty' };
  if (/^https?:\/\/\S+$/i.test(value)) {
    try {
      return { kind: 'link', text: value, href: new URL(value).href };
    } catch {
      /* Looked like a link and is not one: it is text. */
    }
  }
  const date = dateText(value, locale);
  if (date) return { kind: 'date', text: date, title: value };
  return { kind: 'text', text: value, long: value.length > LONG_TEXT || value.includes('\n') };
}

/**
 * A number in the reader's locale, with exactly the decimals it was written
 * with: Intl's default of three would turn a stored 0.12345 into 0.123.
 * What JavaScript can only say in exponent form, and an integer already past
 * 2^53, keep JavaScript's own text — grouping a rounded id would dress an
 * approximation as exact.
 */
function numberOf(value: number, locale: string | undefined): Scalar {
  const plain = String(value);
  if (!Number.isFinite(value) || /e/i.test(plain) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    return { kind: 'number', text: plain };
  const decimals = Math.min(20, plain.includes('.') ? plain.length - plain.indexOf('.') - 1 : 0);
  const text = value.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return { kind: 'number', text, title: text === plain ? undefined : plain };
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/**
 * An ISO date or timestamp said in the reader's locale. A date, and a
 * wall-clock time without a zone, are said as written; a timestamp that
 * names its zone is an instant, said in the reader's own zone.
 */
function dateText(text: string, locale: string | undefined): string | null {
  const m = ISO.exec(text);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, zone] = m;
  const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0), Number(s ?? 0));
  const check = new Date(wall);
  /* 2024-02-31 rolls over into March: it is not a date, so it is not said as one. */
  if (check.getUTCMonth() !== Number(mo) - 1 || check.getUTCDate() !== Number(d) || Number(h ?? 0) > 23 || Number(mi ?? 0) > 59)
    return null;
  if (h === undefined) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(wall);
  if (!zone) return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(wall);
  const offset = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
  const minutes = offset ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) : 0;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(wall - minutes * 60_000);
}

/* A marker no document can hold (JSON text cannot carry a raw NUL, and
   Postgres refuses `\u0000` in jsonb), swapped for the digits after
   stringify has quoted it. */
const BIG = '\u0000big:';

/** The document pretty-printed, big integers written as their digits. */
export function prettyJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item instanceof JsonBig ? `${BIG}${item.text}` : item), 2).replace(
    /"\\u0000big:(-?\d+)"/g,
    '$1',
  );
}
