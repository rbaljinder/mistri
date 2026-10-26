/**
 * The functions a computed column may call (computed.ts, DM2): `coalesce`, `round`, `min`, `max` and `abs`. Each is
 * parsed and typed in the author's words, written into the statement on SQLite and PostgreSQL, and worked out in
 * JavaScript (computedValue.ts) — and the three must say the same thing of the same rows, nulls, negatives and halves
 * included, which is what the live blocks below hold them to. The PostgreSQL block works in a temporary table, so it
 * owns what it touches.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { compileComputed, computedKind, type ComputedNode, type ValueKind } from '../packages/engine/src/shared/computed.js';
import { parseComputed } from '../packages/engine/src/shared/computedParse.js';
import { evaluateComputed } from '../packages/engine/src/shared/computedValue.js';
import { ANSI_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { liveSkip } from './live.js';

const KINDS: Record<string, ValueKind> = { a: 'number', b: 'number', d1: 'date', d2: 'date', name: 'text', nick: 'text', done: 'boolean' };
const isColumn = (path: string) => Object.hasOwn(KINDS, path);
const parse = (text: string) => parseComputed(text, isColumn);
const kind = (text: string) => computedKind(parse(text), (path) => KINDS[path]);

describe('the words', () => {
  test('each function parses to a call over its arguments, and reads what they read', () => {
    assert.deepEqual(parse('max(a - b, 0)'), {
      k: 'call',
      fn: 'max',
      args: [
        { k: 'op', op: '-', left: { k: 'path', path: 'a' }, right: { k: 'path', path: 'b' } },
        { k: 'number', value: 0 },
      ],
    });
    assert.deepEqual(parse('round(a * b, 2) > 1').k, 'op');
    assert.equal(kind('coalesce(b, a, 0)'), 'number');
    assert.equal(kind('coalesce(d1, d2 + 3 days)'), 'date');
    assert.equal(kind("coalesce(nick, name) = 'Ada'"), 'boolean');
    assert.equal(kind('abs(b) + round(a)'), 'number');
    assert.equal(kind('min(d1, d2)'), 'date');
  });

  test('a mistake says which function and what it takes', () => {
    const refused: Array<[string, RegExp]> = [
      ['floor(a)', /"floor" is not a function; an expression calls coalesce, round, min, max, abs/],
      ['coalesce(a)', /coalesce\(…\) takes two values or more/],
      ['max(a)', /max\(…\) takes two values or more/],
      ['abs(a, b)', /abs\(…\) takes one number/],
      ['round(a, b)', /round\(…\)'s places are a whole number from 0 to 10/],
      ['round(a, 2.5)', /round\(…\)'s places are a whole number/],
      ['round(a, 2', /expected "\)"/],
    ];
    for (const [text, message] of refused) assert.throws(() => parse(text), message, text);
    const mistyped: Array<[string, RegExp]> = [
      ['abs(name)', /abs\(…\) reads numbers/],
      ['round(d1)', /round\(…\) reads numbers/],
      ['coalesce(a, d1)', /coalesce\(…\) takes values of one kind, and has a number and a date/],
      ['max(name, nick)', /max\(…\) takes numbers or dates/],
      ['coalesce(done, done)', /not yes-or-no conditions/],
    ];
    for (const [text, message] of mistyped) assert.throws(() => kind(text), message, text);
  });
});

/* The rows every engine is asked about: halves, negatives, a figure the double nearest it would round down, and nulls. */
const ROWS = [
  { id: 1, a: 2.5, b: -3.456, d1: '2026-01-05', d2: '2026-02-01', name: 'Ada', nick: null },
  { id: 2, a: -2.5, b: null, d1: null, d2: '2026-01-01', name: 'Bo', nick: 'B' },
  { id: 3, a: 1.005, b: 2.675, d1: '2026-03-01', d2: null, name: 'Cy', nick: null },
  { id: 4, a: -0.4, b: -1.25, d1: '2026-01-31', d2: '2026-01-30', name: 'Di', nick: 'D' },
];
const EXPRESSIONS: Array<[string, 'number' | 'date' | 'boolean']> = [
  ['coalesce(b, a, 0)', 'number'],
  ['round(a)', 'number'],
  ['round(b, 2)', 'number'],
  ['round(a, 2)', 'number'],
  ['round(b, 1)', 'number'],
  ['abs(b)', 'number'],
  ['min(a, b)', 'number'],
  ['max(a - b, 0)', 'number'],
  ['coalesce(d1, d2)', 'date'],
  ['max(d1, d2)', 'date'],
  ['min(d1, d2 + 3 days)', 'date'],
  ["coalesce(nick, name) = 'Ada'", 'boolean'],
];
const kindOf = (path: string) => (Object.hasOwn(KINDS, path) ? { kind: KINDS[path] } : undefined);
const said = (value: unknown, type: 'number' | 'date' | 'boolean'): unknown => {
  if (value === null || value === undefined) return null;
  if (type === 'number') return Number(value);
  if (type === 'boolean') return value === true || value === 1 || value === '1' || value === 't';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
};
const worked = (text: string, type: 'number' | 'date' | 'boolean') =>
  ROWS.map((row) => {
    const value = evaluateComputed(parse(text) as ComputedNode, { today: '2026-10-13', now: new Date(), me: null }, (path) => {
      const raw = row[path as keyof typeof row];
      if (raw === null) return null;
      return KINDS[path] === 'date' ? { day: raw as string } : (raw as number | string);
    });
    return said(value !== null && typeof value === 'object' && 'day' in value ? value.day : value, type);
  });

describe('every engine says what JavaScript says', () => {
  test('SQLite', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, a REAL, b REAL, d1 DATE, d2 DATE, name TEXT, nick TEXT)');
    const insert = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const row of ROWS) insert.run(row.id, row.a, row.b, row.d1, row.d2, row.name, row.nick);
    for (const [text, type] of EXPRESSIONS) {
      const sql = compileComputed({ type, expr: parse(text) }, ANSI_STYLE, (path) => `"${path}"`, kindOf);
      const rows = db.prepare(`SELECT ${sql} AS v FROM t ORDER BY id`).all() as Array<{ v: unknown }>;
      assert.deepEqual(
        rows.map((row) => said(row.v, type)),
        worked(text, type),
        `${text}: ${sql}`,
      );
    }
    db.close();
  });

  test('PostgreSQL', { skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG) }, async () => {
    const module = 'pg';
    const pg = (await import(module)) as {
      Client: new (options: unknown) => {
        connect(): Promise<void>;
        end(): Promise<void>;
        query(sql: string, values?: readonly unknown[]): Promise<{ rows: Array<{ v: unknown }> }>;
      };
    };
    const client = new pg.Client({ connectionString: process.env.TABLEWALK_TEST_PG });
    await client.connect();
    try {
      await client.query(
        'CREATE TEMP TABLE computed_functions (id INTEGER PRIMARY KEY, a NUMERIC, b DOUBLE PRECISION, d1 DATE, d2 DATE, name TEXT, nick TEXT)',
      );
      for (const row of ROWS)
        await client.query('INSERT INTO computed_functions VALUES ($1, $2, $3, $4, $5, $6, $7)', [
          row.id,
          row.a,
          row.b,
          row.d1,
          row.d2,
          row.name,
          row.nick,
        ]);
      for (const [text, type] of EXPRESSIONS) {
        const sql = compileComputed({ type, expr: parse(text) }, POSTGRES_STYLE, (path) => `"${path}"`, kindOf);
        const select = type === 'date' ? `CAST(${sql} AS TEXT)` : sql;
        const { rows } = await client.query(`SELECT ${select} AS v FROM computed_functions ORDER BY id`);
        assert.deepEqual(
          rows.map((row) => said(row.v, type)),
          worked(text, type),
          `${text}: ${sql}`,
        );
      }
    } finally {
      await client.end();
    }
  });
});
