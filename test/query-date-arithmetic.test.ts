/**
 * `today + 30 days` and `today - 7 days` in the query language: one day, not a span. `=` is that whole day (a
 * timestamp late in it included), the comparisons bind to its start and its end as every other window does, and
 * `next 30 days` stays the "within" form. SQLite and PostgreSQL must return the same rows; the PostgreSQL block works
 * in a temporary table, so it owns what it touches.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { ANSI_STYLE, buildWhere, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { dateWindow, parseQuery } from '../packages/engine/src/shared/query.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';

/* The 3rd of March: thirty days on is the 2nd of April and seven days back the 24th of February, so each answer
   crosses a month's edge. */
const NOW = new Date(2026, 2, 3, 10, 0, 0);
const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const schema = {
  label: 'jobs',
  dialect: 'sqlite',
  readAt: '2026-03-03T00:00:00Z',
  tables: [
    {
      id: 'job',
      name: 'job',
      schema: '',
      columns: [column('id', 'integer', { primaryKey: true, nullable: false }), column('due', 'date'), column('seen_at', 'timestamp')],
    },
  ],
  foreignKeys: [],
} as unknown as DatabaseSchema;

const ROWS: Array<[number, string | null, string | null]> = [
  [1, '2026-02-23', null],
  [2, '2026-02-24', null],
  [3, '2026-02-25', null],
  [4, '2026-03-03', null],
  [5, '2026-04-01', null],
  [6, '2026-04-02', null],
  [7, '2026-04-03', null],
  [8, null, null],
  [9, null, '2026-04-02 00:00:00'],
  [10, null, '2026-04-02 23:59:59'],
  [11, null, '2026-04-03 00:00:00'],
  [12, '2026-03-31', null],
];
/* Each ask, and the rows it is held to on every engine. */
const ASKS: Array<[string, number[]]> = [
  ['job due = today + 30 days', [6]],
  ['job due <= today - 7 days', [1, 2]],
  ['job due < today - 7 days', [1]],
  ['job due > today + 30 days', [7]],
  ['job due >= today + 30 days', [6, 7]],
  ['job due = today - 7 days', [2]],
  ['job due = today + 4 weeks', [12]],
  ['job seen_at = today + 30 days', [9, 10]],
  ['job due = next 30 days', [4, 5, 12]],
];

const where = (text: string, style: typeof ANSI_STYLE) => {
  const parsed = parseQuery(text, { schema, now: NOW });
  assert.deepEqual(parsed.errors ?? [], [], text);
  return buildWhere(parsed.query!.filter, style, 1);
};

describe('the words', () => {
  test('a day, a week, a month or a year, either way, is one day', () => {
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const span = (phrase: string, now = NOW) => {
      const window = dateWindow(phrase, now)!;
      return [day(window.start), day(window.end)];
    };
    assert.deepEqual(span('today + 30 days'), ['2026-04-02', '2026-04-03']);
    assert.deepEqual(span('today - 7 days'), ['2026-02-24', '2026-02-25']);
    assert.deepEqual(span('Today+2 Weeks'), ['2026-03-17', '2026-03-18']);
    assert.deepEqual(span('today - 1 year'), ['2025-03-03', '2025-03-04']);
    // A month past the month's end lands on its last day, as it does in a command's condition.
    assert.deepEqual(span('today + 1 month', new Date(2026, 0, 31, 9)), ['2026-02-28', '2026-03-01']);
    assert.deepEqual(span('today + 1 year', new Date(2028, 1, 29, 9)), ['2029-02-28', '2029-03-01']);
    // The span is unchanged, and a unit the language does not read is not a phrase.
    assert.deepEqual(span('next 30 days'), ['2026-03-03', '2026-04-02']);
    assert.equal(dateWindow('today + 2 fortnights', NOW), undefined);
    assert.equal(dateWindow('today + 2', NOW), undefined);
  });

  test('a condition binds the day as every window does, and a bare unit is a mistake that says so', () => {
    const groups = (text: string) => {
      const parsed = parseQuery(text, { schema, now: NOW });
      assert.deepEqual(parsed.errors ?? [], [], text);
      return parsed.query!.filter.groups;
    };
    assert.deepEqual(groups('job due = today + 30 days'), [
      [
        { column: 'due', op: '>=', value: '2026-04-02' },
        { column: 'due', op: '<', value: '2026-04-03' },
      ],
    ]);
    assert.deepEqual(groups('job due <= today - 7 days'), [[{ column: 'due', op: '<', value: '2026-02-25' }]]);
    assert.deepEqual(groups('job due > today + 2 weeks and id > 3'), [
      [
        { column: 'due', op: '>=', value: '2026-03-18' },
        { column: 'id', op: '>', value: 3 },
      ],
    ]);
    assert.match(parseQuery('job due = today + 2 fortnights', { schema, now: NOW }).errors?.[0].message ?? '', /has a space, so quote it/);
  });
});

describe('every engine returns the same rows', () => {
  test('SQLite', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE job (id INTEGER PRIMARY KEY, due DATE, seen_at TEXT)');
    const insert = db.prepare('INSERT INTO job VALUES (?, ?, ?)');
    for (const row of ROWS) insert.run(...row);
    for (const [text, ids] of ASKS) {
      const { text: sql, params } = where(text, ANSI_STYLE);
      const rows = db.prepare(`SELECT id FROM job ${sql} ORDER BY id`).all(...(params as never[])) as Array<{ id: number }>;
      assert.deepEqual(
        rows.map((row) => row.id),
        ids,
        text,
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
        query(sql: string, values?: readonly unknown[]): Promise<{ rows: Array<{ id: number }> }>;
      };
    };
    const client = new pg.Client({ connectionString: process.env.TABLEWALK_TEST_PG });
    await client.connect();
    try {
      await client.query('CREATE TEMP TABLE job (id INTEGER PRIMARY KEY, due DATE, seen_at TIMESTAMP)');
      for (const row of ROWS) await client.query('INSERT INTO job VALUES ($1, $2, $3)', row);
      for (const [text, ids] of ASKS) {
        const { text: sql, params } = where(text, POSTGRES_STYLE);
        const { rows } = await client.query(`SELECT id FROM job ${sql} ORDER BY id`, params as unknown[]);
        assert.deepEqual(
          rows.map((row) => Number(row.id)),
          ids,
          text,
        );
      }
    } finally {
      await client.end();
    }
  });
});
