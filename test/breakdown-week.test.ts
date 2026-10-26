/**
 * The `week` bucket: a date cut down to the week it falls in, said by that
 * week's first day (`2026-10-05`), so a week label is a day label that sorts,
 * survives JSON and reads alike on every engine. Weeks start on Monday (ISO)
 * unless the App's `ui.locale` keeps another first day, which the server sets
 * on every breakdown in place of the request's. Run on SQLite and, opt-in, on
 * a live PostgreSQL over the same rows, which must agree to the day.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { compileBreakdown, type BreakdownDef } from '../packages/engine/src/shared/breakdown.js';
import { textToBreakdown } from '../packages/engine/src/shared/breakdowntext.js';
import { ANSI_STYLE, MYSQL_STYLE, POSTGRES_STYLE, weekStartDay } from '../packages/engine/src/shared/filter.js';
import { chartKeys } from '../packages/engine/src/shared/page.js';
import { localeWeekStart } from '../packages/engine/src/shared/weekStart.js';
import { dispatchResourceReadHttp } from '../packages/engine/src/server/resourceReadHttp.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';

/* A Sunday, a Monday, a Thursday, a Saturday night, a Sunday and a Monday: the edges of three Monday weeks. */
const DAYS = [
  '2026-10-04 09:00:00',
  '2026-10-05 08:00:00',
  '2026-10-08 12:00:00',
  '2026-10-10 23:30:00',
  '2026-10-11 10:00:00',
  '2026-10-12 07:15:00',
];
const SEED = (table: string) =>
  `INSERT INTO ${table} (id, at, on_day) VALUES ${DAYS.map((day, i) => `(${i + 1}, '${day}', '${day.slice(0, 10)}')`).join(', ')}`;
const MONDAY = { '2026-09-28': 1, '2026-10-05': 4, '2026-10-12': 1 };
const SUNDAY = { '2026-10-04': 4, '2026-10-11': 2 };

const schemaOf = (dialect: string): DatabaseSchema =>
  ({
    dialect,
    tables: [
      {
        id: 'visit',
        name: 'visit',
        columns: [
          { name: 'id', type: 'integer', pk: true },
          { name: 'at', type: 'timestamp' },
          { name: 'on_day', type: 'date' },
        ],
      },
    ],
    foreignKeys: [],
  }) as unknown as DatabaseSchema;

test('week is a period of the grammar, a chart key, and compiles in each dialect’s words', () => {
  const schema = schemaOf('sqlite');
  const parsed = textToBreakdown(schema, 'visit count by week at');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(
    parsed.breakdown!.by.map(({ path, bucket }) => ({ path, bucket })),
    [{ path: 'at', bucket: 'week' }],
  );
  assert.deepEqual(chartKeys('week received_at, channel'), {
    keys: [{ path: 'received_at', bucket: 'week' }, { path: 'channel' }],
  });
  const def: BreakdownDef = { base: 'visit', by: [{ path: 'at', bucket: 'week' }], measures: [{ fn: 'count' }] };
  assert.match(compileBreakdown(schema, def, ANSI_STYLE).text, /strftime\('%Y-%m-%d', "visit_0"\."at", 'weekday 0', '-6 days'\)/);
  assert.match(compileBreakdown(schema, { ...def, weekStart: 7 }, ANSI_STYLE).text, /'weekday 6', '-6 days'/);
  assert.match(
    compileBreakdown(schemaOf('postgres'), def, POSTGRES_STYLE).text,
    /to_char\(CAST\("visit_0"\."at" AS date\) - CAST\(\(CAST\(EXTRACT\(ISODOW FROM "visit_0"\."at"\) AS integer\) \+ 6\) % 7 AS integer\), 'YYYY-MM-DD'\)/,
  );
  assert.match(
    compileBreakdown(schemaOf('mysql'), { ...def, weekStart: 7 }, MYSQL_STYLE).text,
    /INTERVAL \(\(WEEKDAY\(`visit_0`\.`at`\) \+ 1\) \+ 0\) % 7 DAY/,
  );
  // A week start is an ISO weekday and nothing else: it is written into the SQL, so it is checked first.
  for (const bad of [0, 8, 1.5, Number.NaN]) assert.throws(() => weekStartDay(bad), /ISO weekday/);
  assert.throws(() => compileBreakdown(schema, { ...def, weekStart: '1; DROP' as unknown as number }, ANSI_STYLE), /ISO weekday/);
});

test('a locale’s first day: Sunday in the US, Monday in Britain, and Monday where the App names none', () => {
  assert.equal(localeWeekStart('en-US'), 7);
  assert.equal(localeWeekStart('en-GB'), 1);
  assert.equal(localeWeekStart(undefined), 1);
  assert.equal(localeWeekStart('not a locale'), 1);
});

const counts = (rows: Array<Record<string, unknown>>, key: string) =>
  Object.fromEntries(rows.map((row) => [String(row[key]), Number(row.count)]));

async function proves(adapter: Adapter, schema: DatabaseSchema, table: string): Promise<void> {
  for (const path of ['at', 'on_day']) {
    const def: BreakdownDef = {
      base: table,
      by: [{ path, bucket: 'week', alias: 'week' }],
      measures: [{ fn: 'count' }],
      orderBy: [{ name: 'week', direction: 'asc' }],
    };
    assert.deepEqual(counts((await adapter.runBreakdown!(def)).rows, 'week'), MONDAY, `${path}, Monday weeks`);
    assert.deepEqual(counts((await adapter.runBreakdown!({ ...def, weekStart: 7 })).rows, 'week'), SUNDAY, `${path}, Sunday weeks`);
  }
  /* Through the read route an App's server answers: its locale's week, whatever the request said. */
  const reply = await dispatchResourceReadHttp(
    '/api/breakdown',
    { def: { base: table, by: [{ path: 'at', bucket: 'week', alias: 'week' }], measures: [{ fn: 'count' }], weekStart: 1 } },
    adapter,
    schema,
    { app: undefined, now: () => new Date('2026-10-13T00:00:00Z'), weekStart: 7 },
  );
  assert.equal(reply?.status, 200);
  assert.deepEqual(counts((reply!.body as { rows: Array<Record<string, unknown>> }).rows, 'week'), SUNDAY);
  const text = await dispatchResourceReadHttp('/api/breakdown', { text: `${table} count by week at` }, adapter, schema, {
    app: undefined,
    now: () => new Date('2026-10-13T00:00:00Z'),
  });
  assert.deepEqual(counts((text!.body as { rows: Array<Record<string, unknown>> }).rows, 'week(at)'), MONDAY);
}

test('weeks on SQLite: Monday weeks by default, Sunday ones when asked, timestamps and dates alike', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-week-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'visit.db'));
  db.exec(`CREATE TABLE visit (id INTEGER PRIMARY KEY, at TIMESTAMP NOT NULL, on_day DATE NOT NULL); ${SEED('visit')};`);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'visit.db'), 'visit');
  t.after(() => adapter.close());
  await proves(adapter, await adapter.introspect(), 'visit');
});

const PG = process.env.TABLEWALK_TEST_PG;
describe('weeks on PostgreSQL', { skip: liveSkip('postgres', PG) }, () => {
  const name = `tw_week_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  let adapter: PostgresAdapter;
  type Client = { connect(): Promise<void>; query(text: string): Promise<unknown>; end(): Promise<void> };
  const client = async (): Promise<Client> => {
    const specifier = 'pg';
    const pg = (await import(specifier)) as {
      Client?: new (o: { connectionString: string }) => Client;
      default?: { Client: new (o: { connectionString: string }) => Client };
    };
    const Made = pg.Client ?? pg.default!.Client;
    const made = new Made({ connectionString: PG! });
    await made.connect();
    return made;
  };
  before(async () => {
    const db = await client();
    try {
      await db.query(`CREATE TABLE public.${name} (id integer PRIMARY KEY, at timestamp NOT NULL, on_day date NOT NULL)`);
      await db.query(SEED(`public.${name}`));
    } finally {
      await db.end();
    }
    adapter = new PostgresAdapter(PG!, 'week');
  });
  after(async () => {
    await adapter?.close();
    const db = await client();
    try {
      await db.query(`DROP TABLE IF EXISTS public.${name}`);
    } finally {
      await db.end();
    }
  });

  test('the same weeks, to the day', async () => {
    const schema = await adapter.introspect();
    await proves(adapter, schema, schema.tables.find((table) => table.name === name)!.id);
  });
});
