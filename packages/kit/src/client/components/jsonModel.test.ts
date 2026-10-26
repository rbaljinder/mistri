/**
 * What a JSON value is laid out as: the pure decisions JsonView draws and
 * the grid's preview says in one line.
 */
import { describe, expect, test } from 'vitest';
import {
  countLabel,
  jsonValueOf,
  JsonBig,
  layoutOf,
  parseJsonText,
  prettyJson,
  previewOf,
  restOf,
  scalarOf,
  TABLE_COLUMNS,
} from './jsonModel.js';

/* Intl puts a narrow no-break space before AM/PM; the reading is the same. */
const said = (value: unknown) => {
  const scalar = scalarOf(value, 'en-US');
  return 'text' in scalar ? { ...scalar, text: scalar.text.replace(/\s/g, ' ') } : scalar;
};

describe('which values are documents', () => {
  test('a parsed object or array is one, whatever the column says', () => {
    expect(jsonValueOf({ type: 'jsonb' }, { a: 1 })).toEqual({ value: { a: 1 } });
    expect(jsonValueOf(undefined, [1, 2])).toEqual({ value: [1, 2] });
    expect(jsonValueOf({ type: 'integer[]' }, [1, 2])).toEqual({ value: [1, 2] });
  });

  test('JSON text is read only in a column declared JSON, and only when it opens like a document', () => {
    expect(jsonValueOf({ type: 'JSON' }, ' {"a":1}')).toEqual({ value: { a: 1 } });
    expect(jsonValueOf({ type: 'TEXT' }, '{"a":1}')).toBeNull();
    /* A string in a jsonb column is the JSON string, already decoded. */
    expect(jsonValueOf({ type: 'jsonb' }, '42')).toBeNull();
    expect(jsonValueOf({ type: 'jsonb' }, 'hello')).toBeNull();
    expect(jsonValueOf({ type: 'json' }, '{not json')).toBeNull();
    expect(jsonValueOf({ type: 'jsonb' }, null)).toBeNull();
    expect(jsonValueOf({ type: 'jsonb' }, 7)).toBeNull();
  });

  test('a whole number past 2^53 in JSON text keeps its digits, and Raw writes them back', () => {
    const doc = parseJsonText('{"id": 9007199254740993, "n": 1.5, "small": 12}')!.value as { id: JsonBig; n: number; small: number };
    expect(doc.id).toBeInstanceOf(JsonBig);
    expect(doc.id.text).toBe('9007199254740993');
    expect(doc.n).toBe(1.5);
    expect(doc.small).toBe(12);
    expect(prettyJson(doc)).toBe('{\n  "id": 9007199254740993,\n  "n": 1.5,\n  "small": 12\n}');
    expect(said(doc.id)).toMatchObject({ kind: 'number', text: '9007199254740993' });
  });
});

describe('layout by shape', () => {
  test('an object is labelled fields; an empty container says what it is', () => {
    expect(layoutOf({ a: 1, b: 'x' })).toEqual({
      kind: 'fields',
      entries: [
        ['a', 1],
        ['b', 'x'],
      ],
      indexed: false,
    });
    expect(layoutOf({})).toEqual({ kind: 'empty', text: '{}' });
    expect(layoutOf([])).toEqual({ kind: 'empty', text: '[]' });
    expect(layoutOf('text')).toEqual({ kind: 'scalar' });
  });

  test('like records are a table, columns in first-seen order', () => {
    const rows = [
      { sku: 'A', qty: 1 },
      { sku: 'B', qty: 2, note: 'rush' },
      { qty: 3, sku: 'C' },
    ];
    expect(layoutOf(rows)).toEqual({ kind: 'table', columns: ['sku', 'qty', 'note'], folded: [], rows });
  });

  test('records that share few keys, and a lone record, are fields by position', () => {
    expect(layoutOf([{ a: 1 }, { b: 2 }, { c: 3 }])).toMatchObject({ kind: 'fields', indexed: true });
    expect(layoutOf([{ a: 1, b: 2 }])).toEqual({ kind: 'fields', entries: [['0', { a: 1, b: 2 }]], indexed: true });
  });

  test("columns past the cap fold into each row's rest", () => {
    const wide = Object.fromEntries(Array.from({ length: TABLE_COLUMNS + 3 }, (_, i) => [`k${i}`, i]));
    const layout = layoutOf([wide, wide]);
    if (layout.kind !== 'table') throw new Error(`expected a table, got ${layout.kind}`);
    expect(layout.columns).toHaveLength(TABLE_COLUMNS);
    expect(layout.folded).toEqual(['k8', 'k9', 'k10']);
    expect(restOf(wide, layout.columns)).toEqual({ k8: 8, k9: 9, k10: 10 });
  });

  test('short words and numbers are chips; long text, flags and nulls a line each; mixed arrays by position', () => {
    expect(layoutOf(['red', 'green', 3])).toEqual({ kind: 'chips', items: ['red', 'green', 3] });
    expect(layoutOf(['x'.repeat(40)]).kind).toBe('lines');
    expect(layoutOf([true, null]).kind).toBe('lines');
    expect(layoutOf([1, { a: 1 }])).toEqual({
      kind: 'fields',
      entries: [
        ['0', 1],
        ['1', { a: 1 }],
      ],
      indexed: true,
    });
  });
});

describe('the one-line preview', () => {
  test('an object says its first keys and how many more', () => {
    expect(previewOf({ id: 1, name: 'x', email: 'y', phone: 1, city: 2 })).toBe('{ id, name, email, +2 }');
    expect(previewOf({ a: 1 })).toBe('{ a }');
    expect(previewOf({ a_rather_long_key_name: 1, another_long_key_name: 2 })).toBe('{ a_rather_long_key_name, +1 }');
    expect(previewOf({})).toBe('{}');
  });

  test('a short scalar array says its items; anything else says its count', () => {
    expect(previewOf(['red', 'green'])).toBe('[red, green]');
    expect(previewOf([1, null, true])).toBe('[1, null, true]');
    expect(previewOf([{ a: 1 }, { a: 2 }, { a: 3 }])).toBe('[3 items]');
    expect(previewOf(Array.from({ length: 30 }, (_, i) => i))).toBe('[30 items]');
    expect(previewOf([{ a: 1 }])).toBe('[1 item]');
    expect(previewOf([])).toBe('[]');
  });

  test('counts are singular when they are one', () => {
    expect(countLabel({ a: 1 })).toBe('1 key');
    expect(countLabel({ a: 1, b: 2 })).toBe('2 keys');
    expect(countLabel([1, 2], 'en-US')).toBe('2 items');
  });
});

describe('scalars', () => {
  test("numbers keep the decimals they were written with, in the reader's locale", () => {
    expect(said(1234567.125)).toEqual({ kind: 'number', text: '1,234,567.125', title: '1234567.125' });
    expect(said(0.12345)).toEqual({ kind: 'number', text: '0.12345', title: undefined });
    expect(scalarOf(1234.5, 'de-DE')).toMatchObject({ text: '1.234,5' });
  });

  test("an integer already past 2^53, and exponent forms, keep JavaScript's own text", () => {
    expect(said(2 ** 60)).toEqual({ kind: 'number', text: '1152921504606847000' });
    expect(said(1e-7)).toEqual({ kind: 'number', text: '1e-7' });
  });

  test('links are http and https only', () => {
    expect(said('https://example.com/a?b=1')).toEqual({
      kind: 'link',
      text: 'https://example.com/a?b=1',
      href: 'https://example.com/a?b=1',
    });
    expect(said('javascript:alert(1)').kind).toBe('text');
    expect(said('ftp://example.com').kind).toBe('text');
  });

  test('ISO dates and wall-clock timestamps are said in the locale as written; the original stays in the title', () => {
    expect(said('2024-03-14')).toEqual({ kind: 'date', text: 'Mar 14, 2024', title: '2024-03-14' });
    expect(said('2024-03-14T09:30:00')).toEqual({ kind: 'date', text: 'Mar 14, 2024, 9:30 AM', title: '2024-03-14T09:30:00' });
    expect(said('2024-03-14 09:30:00.123456')).toMatchObject({ kind: 'date', text: 'Mar 14, 2024, 9:30 AM' });
    /* An instant is said in the reader's zone, so only its kind is certain here. */
    expect(said('2024-03-14T09:30:00+05:30')).toMatchObject({ kind: 'date', title: '2024-03-14T09:30:00+05:30' });
    expect(said('2024-02-31').kind).toBe('text');
    expect(said('2024-03-14T25:00').kind).toBe('text');
  });

  test('flags, null, the empty string and long text', () => {
    expect(said(true)).toEqual({ kind: 'boolean', on: true });
    expect(said(false)).toEqual({ kind: 'boolean', on: false });
    expect(said(null)).toEqual({ kind: 'null' });
    expect(said('')).toEqual({ kind: 'empty' });
    expect(said('a\nb')).toEqual({ kind: 'text', text: 'a b', long: true });
    expect(said('short')).toEqual({ kind: 'text', text: 'short', long: false });
    expect(said('word '.repeat(20))).toMatchObject({ kind: 'text', long: true });
  });
});
