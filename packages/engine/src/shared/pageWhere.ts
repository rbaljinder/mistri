/**
 * A free-form page's object condition (`where={{ status: 'booked', party_size: { gt: 1 } }}`), written out as the
 * query language's own text. One compiler for both ends: the browser compiles a block's `where` into the query it
 * already sends, and the server compiles the `where` a read sends beside its `query` (resourceReadHttp.ts). Either
 * way the result is parsed by the one parser under the reader's grants, so an object condition is held to exactly
 * what the same condition typed as text would be — there is no second path to the database.
 *
 * The server never trusts the browser's types: a key that is not one of the resource's columns, an operator the
 * object form does not have, or a value of the wrong kind for its column is refused with a sentence, not dropped.
 * Dropping it would widen the read silently, and a page that asked for one class's bookings would draw everyone's.
 *
 * Values are written so the parser reads them as what they are: a string is quoted (a quoted value is always
 * text, so `'me'` or `'today'` in a text column is those letters), except digits on a number column, which stay
 * bare so they compare as numbers, ids past 2^53 included, and an ISO day on a date column, bare so it reads as
 * that day (on a timestamp, all of it). A list is a chain of `=` joined by `or`, never `in (…)`: the language
 * splits an `in` list at every comma, quoted or not.
 */
import { columnKind, isFlagColumn, type ColumnMeta, type TableMeta } from './schema.js';

/** The operators of the object form, and the language's word for each. */
const RANGE: Readonly<Record<string, string>> = { gt: '>', gte: '>=', lt: '<', lte: '<=' };
const MATCH: Readonly<Record<string, string>> = { contains: 'contains', startsWith: 'startswith', endsWith: 'endswith' };
const WHERE_OPERATORS: readonly string[] = ['not', ...Object.keys(RANGE), ...Object.keys(MATCH)];

type Kind = 'number' | 'boolean' | 'date' | 'text' | 'other';
const NUMERAL = /^-?\d+(?:\.\d+)?$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
/* The language's column token: a name outside it could not be read back as a column. */
const COLUMN_NAME = /^[\w$]+$/;

/* By shape, not by identity: an object made in another realm (a worker, a bundle's own copy of Object, a test
   sandbox) has a different Object.prototype, and one from Object.create(null) has none; both are plain data. A Date,
   a Map or a class instance says its own tag. */
const plain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype || Object.prototype.toString.call(value) === '[object Object]';
};

/* What a refused value actually was, so the sentence names it instead of saying "object" of an object. */
const described = (value: unknown): string => {
  if (Array.isArray(value)) return 'an array';
  if (typeof value !== 'object' || value === null) return `a ${typeof value}`;
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  return /^[AEIOU]/.test(tag) ? `an ${tag}` : `a ${tag}`;
};

const kindOf = (column: ColumnMeta): Kind => (isFlagColumn(column) ? 'boolean' : columnKind(column.type));

/* One value in the language, or the sentence that says why it cannot stand for this column. */
function written(name: string, kind: Kind, value: unknown): { text: string } | { error: string } {
  if (typeof value === 'number') {
    const text = String(value);
    if ((kind === 'number' || kind === 'other') && Number.isFinite(value) && NUMERAL.test(text)) return { text };
    return { error: `${name} cannot be compared with the number ${text}.` };
  }
  if (typeof value === 'boolean') {
    if (kind === 'boolean' || kind === 'other') return { text: String(value) };
    return { error: `${name} holds no yes or no, so it cannot be compared with ${value}.` };
  }
  if (typeof value === 'string') {
    if (kind === 'number') {
      if (NUMERAL.test(value)) return { text: value };
      return { error: `${name} holds numbers, so it cannot be compared with "${value}".` };
    }
    if (kind === 'boolean') return { error: `${name} holds yes or no: compare it with true or false, not "${value}".` };
    if (kind === 'date' && ISO_DAY.test(value)) return { text: value };
    return { text: `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` };
  }
  return { error: `${name} cannot be compared with ${value === undefined ? 'undefined' : (JSON.stringify(value) ?? typeof value)}.` };
}

function oneOf(name: string, kind: Kind, values: readonly unknown[], op: '=' | '!='): { text: string } | { error: string } {
  if (!values.length) return { error: `${name} is asked for one of no values: leave it out, or name at least one.` };
  const parts: string[] = [];
  for (const value of values) {
    const got = written(name, kind, value);
    if ('error' in got) return got;
    parts.push(`${name} ${op} ${got.text}`);
  }
  if (op === '!=') return { text: parts.join(' and ') };
  return { text: parts.length === 1 ? parts[0] : `(${parts.join(' or ')})` };
}

function condition(name: string, kind: Kind, value: unknown): { text: string } | { error: string } {
  if (value === null) return { text: `${name} is empty` };
  if (Array.isArray(value)) return oneOf(name, kind, value, '=');
  if (!plain(value)) return equal(name, kind, value);
  const parts: string[] = [];
  for (const [op, operand] of Object.entries(value)) {
    if (operand === undefined) continue;
    if (op === 'not') {
      const got =
        operand === null
          ? { text: `${name} is not empty` }
          : Array.isArray(operand)
            ? oneOf(name, kind, operand, '!=')
            : notEqual(name, kind, operand);
      if ('error' in got) return got;
      parts.push(got.text);
    } else if (Object.hasOwn(RANGE, op)) {
      if (kind === 'boolean') return { error: `${name} holds yes or no, which has no ${op}.` };
      const got = written(name, kind, operand);
      if ('error' in got) return got;
      parts.push(`${name} ${RANGE[op]} ${got.text}`);
    } else if (Object.hasOwn(MATCH, op)) {
      if (kind !== 'text' && kind !== 'other') return { error: `${name} does not hold text, so it has no ${op}.` };
      if (typeof operand !== 'string') return { error: `${name} ${op} takes text, not ${JSON.stringify(operand) ?? typeof operand}.` };
      parts.push(`${name} ${MATCH[op]} ${(written(name, 'text', operand) as { text: string }).text}`);
    } else {
      return { error: `${name} has no operator "${op}": the object form has ${WHERE_OPERATORS.join(', ')}.` };
    }
  }
  if (!parts.length)
    return { error: `${name} is given an object with no operator in it: the object form has ${WHERE_OPERATORS.join(', ')}.` };
  return { text: parts.join(' and ') };
}

function equal(name: string, kind: Kind, value: unknown): { text: string } | { error: string } {
  const got = written(name, kind, value);
  return 'error' in got ? got : { text: `${name} = ${got.text}` };
}

function notEqual(name: string, kind: Kind, value: unknown): { text: string } | { error: string } {
  const got = written(name, kind, value);
  return 'error' in got ? got : { text: `${name} != ${got.text}` };
}

/**
 * The query text an object condition means on this table, or the sentence that refuses it. A key whose value is
 * `undefined` asks nothing (JSON drops it on the way to the server, so the browser must too); every other key is
 * one condition, and the conditions are joined by `and`. A list of objects is each of them, joined by `and`: a
 * `<Scope>`'s condition and the one a block inside it adds, sent as they were written.
 */
export function compileWhere(where: unknown, table: Pick<TableMeta, 'name' | 'columns'>): { text: string } | { error: string } {
  if (where === undefined || where === null) return { text: '' };
  if (Array.isArray(where)) {
    const parts: string[] = [];
    for (const each of where) {
      if (!plain(each)) return { error: 'A where list holds objects of column names and values, one for each condition joined.' };
      const got = compileWhere(each, table);
      if ('error' in got) return got;
      // Every join inside one is an `and` too, and its `or` chains are already in brackets: no brackets needed here.
      if (got.text) parts.push(got.text);
    }
    return { text: parts.join(' and ') };
  }
  if (!plain(where)) return { error: `A where is an object of column names and values, not ${described(where)}.` };
  const parts: string[] = [];
  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;
    const column = table.columns.find((one) => one.name === key);
    if (!column || !COLUMN_NAME.test(key)) return { error: `${table.name} has no column "${key}".` };
    const got = condition(key, kindOf(column), value);
    if ('error' in got) return got;
    parts.push(got.text);
  }
  return { text: parts.join(' and ') };
}
