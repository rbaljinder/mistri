/**
 * Hour and minute spans: "due within 2 hours" and "updated in the last 30 minutes", said as a date
 * phrase in a condition (`due_at = next 2 hours`, `updated_at = last 30 minutes`) and as a span in a computed
 * column (`now - 30 minutes`, `due_at - 2 hours`), the same instant on every engine and in JavaScript.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseAppConfig, withRollups, type AppDef } from '../packages/mistri/src/shared/app.js';
import { appComputedRules } from '../packages/mistri/src/shared/appComputed.js';
import { parseComputed } from '../packages/engine/src/shared/computedParse.js';
import { evaluateComputed } from '../packages/engine/src/shared/computedValue.js';
import { ANSI_STYLE, MYSQL_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { dateWindow, parseQuery } from '../packages/engine/src/shared/query.js';
import { compileView, type ViewDef } from '../packages/engine/src/shared/view.js';
import { withViewComputed } from '../packages/engine/src/shared/viewLabels.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const NOW = new Date('2026-10-09T15:00:00Z');
const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const catalog = (dialect: DatabaseSchema['dialect']): DatabaseSchema =>
  ({
    label: 'desk',
    dialect,
    readAt: '2026-10-09T00:00:00Z',
    tables: [
      {
        id: 'ticket',
        name: 'ticket',
        schema: '',
        columns: [
          column('id', 'integer', { primaryKey: true, nullable: false }),
          column('due_at', 'timestamp'),
          column('updated_at', 'timestamp'),
          column('due_on', 'date'),
        ],
      },
    ],
    foreignKeys: [],
  }) as unknown as DatabaseSchema;

const app = (computed: Record<string, { type: string; value: string }>): AppDef =>
  parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      resources: { ticket: { computed } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'clock fixture',
  );

test('a minute or an hour phrase is a window from the instant, and is never kept past it', () => {
  const last = dateWindow('last 30 minutes', NOW)!;
  assert.equal(last.start.toISOString(), '2026-10-09T14:30:00.000Z');
  assert.equal(last.end.toISOString(), NOW.toISOString());
  const next = dateWindow('next 2 hours', NOW)!;
  assert.equal(next.start.toISOString(), NOW.toISOString());
  assert.equal(next.end.toISOString(), '2026-10-09T17:00:00.000Z');
  assert.equal(dateWindow('previous 1 minute', NOW)!.start.toISOString(), '2026-10-09T14:58:00.000Z');

  const schema = catalog('sqlite');
  const within = parseQuery('ticket due_at = next 2 hours', { schema, now: NOW });
  assert.deepEqual(within.errors ?? [], []);
  const [low, high] = within.query!.filter.groups[0];
  assert.equal(low.op, '>=');
  assert.equal(high.op, '<');
  const fresh = parseQuery('ticket updated_at = last 30 minutes', { schema, now: NOW });
  const later = parseQuery('ticket updated_at = last 30 minutes', { schema, now: new Date(NOW.getTime() + 60_000) });
  assert.notEqual(fresh, later, 'a minute window is resolved again, not kept');
  assert.notDeepEqual(fresh.query!.filter, later.query!.filter);
});

test('a computed column moves an instant by hours and minutes on each engine, and a day has none', () => {
  const computed = {
    warn_at: { type: 'date', value: 'due_at - 2 hours' },
    fresh: { type: 'boolean', value: 'updated_at > now - 30 minutes' },
  };
  assert.deepEqual(appComputedRules(app(computed), catalog('sqlite')).problems, []);
  assert.deepEqual(
    parseComputed('now - 30 minutes', () => true),
    {
      k: 'op',
      op: '-',
      left: { k: 'now' },
      right: { k: 'span', unit: 'minute', of: { k: 'number', value: 30 } },
    },
  );
  const view: ViewDef = { id: 'v', name: 'v', base: 'ticket', columns: [{ path: 'warn_at' }, { path: 'fresh' }] };
  const text = (dialect: 'sqlite' | 'postgres' | 'mysql') => {
    const served = withRollups(app(computed), catalog(dialect), NOW, null);
    const style = { sqlite: ANSI_STYLE, postgres: POSTGRES_STYLE, mysql: MYSQL_STYLE }[dialect];
    return compileView(served, withViewComputed(served, view), style).text;
  };
  assert.match(text('sqlite'), /datetime\("ticket_0"\."due_at", printf\('%\+d hours', CAST\(\(-\(2\)\) AS INTEGER\)\)\)/);
  assert.match(text('sqlite'), /datetime\('2026-10-09 15:00:00', printf\('%\+d minutes', CAST\(\(-\(30\)\) AS INTEGER\)\)\)/);
  assert.match(text('postgres'), /\("ticket_0"\."due_at" \+ \(-\(2\)\) \* INTERVAL '1 hour'\)/);
  assert.match(text('mysql'), /DATE_ADD\(`ticket_0`\.`due_at`, INTERVAL \(-\(2\)\) HOUR\)/);

  const refused = appComputedRules(app({ evening: { type: 'date', value: 'today + 18 hours' } }), catalog('sqlite')).problems;
  assert.match(refused[0], /today is a day, and hours and minutes move an instant/);

  // JavaScript says the same instant the statement does.
  const values = { today: '2026-10-09', now: NOW, me: null };
  const moved = evaluateComputed(
    parseComputed('now - 30 minutes', () => true),
    values,
  );
  assert.deepEqual(moved, { instant: new Date('2026-10-09T14:30:00Z') });
  const due = evaluateComputed(
    parseComputed('due_at + 2 hours', () => true),
    values,
    () => ({ instant: new Date('2026-10-09T16:00:00Z') }),
  );
  assert.deepEqual(due, { instant: new Date('2026-10-09T18:00:00Z') });
});

test('SQLite answers the window and the span over stored timestamps', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, due_at TEXT, updated_at TEXT, due_on TEXT);
    INSERT INTO ticket VALUES (1, '2026-10-09 16:00:00', '2026-10-09 14:50:00', NULL),
      (2, '2026-10-09 20:00:00', '2026-10-09 13:00:00', NULL);`);
  const computed = { fresh: { type: 'boolean', value: 'updated_at > now - 30 minutes' } };
  const served = withRollups(app(computed), catalog('sqlite'), NOW, null);
  const { text, params } = compileView(
    served,
    withViewComputed(served, {
      id: 'v',
      name: 'v',
      base: 'ticket',
      columns: [{ path: 'id' }, { path: 'fresh' }],
      orderBy: [{ path: 'id', direction: 'asc' }],
    }),
    ANSI_STYLE,
  );
  const rows = db.prepare(text).all(...(params as never[])) as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((row) => Object.values(row)),
    [
      [1, 1],
      [2, 0],
    ],
  );
});

test('`now` beside a date is the instant, read one way by a segment and by a query, and answered so by SQLite (G180)', () => {
  const at = new Date(2026, 9, 9, 15, 0, 0);
  const plain = catalog('sqlite');
  const schema = {
    ...plain,
    tables: plain.tables.map((table) => ({ ...table, segments: { late: 'due_at < now', lateDay: 'due_on < now' } })),
  } as DatabaseSchema;
  const conditions = (text: string, now = at) => {
    const parsed = parseQuery(text, { schema, now });
    assert.deepEqual(parsed.errors ?? [], [], text);
    return parsed.query!.filter.groups;
  };
  // On a timestamp and on a date alike: one condition, bound to the instant, as the segment says it.
  assert.deepEqual(conditions('ticket due_at < now'), [[{ column: 'due_at', op: '<', value: '2026-10-09 15:00:00' }]]);
  assert.deepEqual(conditions('ticket due_on < now'), [[{ column: 'due_on', op: '<', value: '2026-10-09 15:00:00' }]]);
  assert.deepEqual(conditions('ticket late'), conditions('ticket due_at < now'));
  assert.deepEqual(conditions('ticket lateDay'), conditions('ticket due_on < now'));
  // It is the clock's, so it is asked again a minute on rather than kept.
  assert.deepEqual(conditions('ticket due_at < now', new Date(2026, 9, 9, 15, 1, 0)), [
    [{ column: 'due_at', op: '<', value: '2026-10-09 15:01:00' }],
  ]);
  // Quoted, it is the word; beside text it stays one.
  assert.deepEqual(conditions("ticket due_at < 'now'"), [[{ column: 'due_at', op: '<', value: 'now' }]]);

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, due_at TEXT, updated_at TEXT, due_on TEXT);
    INSERT INTO ticket VALUES (1, '2026-10-09 14:00:00', NULL, '2026-10-08'), (2, '2026-10-09 16:00:00', NULL, '2026-10-10');`);
  const late = (text: string) =>
    (db.prepare(`SELECT id FROM ticket WHERE ${text} ORDER BY id`).all('2026-10-09 15:00:00') as Array<{ id: number }>).map(
      (row) => row.id,
    );
  // Bound as the word, SQLite compared the text, and every row was before `now`.
  assert.deepEqual(late('due_at < ?'), [1]);
  assert.deepEqual(late('due_on < ?'), [1]);
});
