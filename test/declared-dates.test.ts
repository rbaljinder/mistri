/**
 * A TEXT column an App declares a date (`types: { due_on: 'date' }`): SQLite
 * has no date type, so the declared type is all a catalog reads, and a column
 * of ISO strings was refused by every date rule. Declared, the App's catalog
 * types it a date — windows, date filters, a dashboard's `over`, a period
 * bucket — and the comparisons run on real rows are the ones a DATE column's are.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig, resolveResources } from '../packages/mistri/src/shared/app.js';
import { withDeclaredDates } from '../packages/mistri/src/shared/declaredDates.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

/* Local days, as the query language reads `today` (query.ts, bindDate). */
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const definition = (types: Record<string, unknown> = { due_on: 'date', done_at: 'datetime' }) => ({
  id: 'tick-dates',
  name: 'Tick dates',
  connection: 'dates',
  resources: { task: { types } },
  views: {
    tasks: { kind: 'list', from: 'task', label: 'Tasks' },
    board: {
      kind: 'dashboard',
      label: 'Board',
      windows: ['last 7 days', 'last 30 days'],
      sections: [
        { kind: 'metric', title: 'Due', from: 'task', over: 'due_on', compare: 'previous period', spark: true },
        { kind: 'chart', title: 'By month', from: 'task', by: 'month due_on' },
      ],
    },
  },
  home: 'tasks',
  nav: ['tasks', 'board'],
});

type Call = (path: string, body?: object) => Promise<{ status: number; text: string; body: any }>;

async function serve(run: (call: Call) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-dates-'));
  const file = join(directory, 'tick.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_on TEXT, done_at TEXT);
    INSERT INTO task VALUES (1, 'Soon', '${day(-3)}', '${day(-3)} 09:15:00'), (2, 'Old', '${day(-40)}', NULL),
      (3, 'Ahead', '${day(5)}', NULL), (4, 'Today', '${day(0)}', '${day(0)} 23:59:00'), (5, 'Undated', NULL, NULL);`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'dates', name: 'Dates', url: file, source: 'config' });
  const app = parseAppConfig(definition(), 'dates fixture');
  const pages = parsePagesConfig({ pages: [] }, 'dates pages');
  const hosts: AppHost[] = [{ app: { path: 'dates.ts', app, pages, sources: {} }, pages }];
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: hosts, pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(async (path, body) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        ...(body ? { method: 'POST', body: JSON.stringify({ app: app.id, ...body }) } : {}),
      });
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return { status: response.status, text, body: parsed };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('dates');
    rmSync(directory, { recursive: true, force: true });
  }
}

const ids = (answer: { body: any; text: string }) => {
  assert.ok(answer.body?.rows, answer.text);
  return answer.body.rows.map((row: { id: number }) => row.id);
};

test('a declared date is a date to the App: windows, comparisons and a period bucket on real rows', async () => {
  await serve(async (call) => {
    const schema = await call('/api/schema');
    const task = schema.body.tables.find((table: { id: string }) => table.id === 'task');
    assert.deepEqual(
      task.columns
        .filter((column: { name: string }) => ['title', 'due_on', 'done_at'].includes(column.name))
        .map((column: { type: string }) => column.type),
      ['TEXT', 'TEXT as date', 'TEXT as datetime'],
    );

    assert.deepEqual(ids(await call('/api/run', { q: 'task due_on = last 30 days show id sort id' })), [1, 4]);
    assert.deepEqual(ids(await call('/api/run', { q: 'task due_on = previous 30 days show id sort id' })), [2]);
    // `< today` is overdue, not due today: the bound is the bare day, which sorts before the day's own text.
    assert.deepEqual(ids(await call('/api/run', { q: 'task due_on < today show id sort id' })), [1, 2]);
    assert.deepEqual(ids(await call('/api/run', { q: 'task due_on <= today show id sort id' })), [1, 2, 4]);
    assert.deepEqual(ids(await call('/api/run', { q: 'task due_on > today show id sort id' })), [3]);
    // A date-time's evening is still its day.
    assert.deepEqual(ids(await call('/api/run', { q: 'task done_at = today show id' })), [4]);

    const bucketed = await call('/api/breakdown', { text: 'task count by month due_on' });
    assert.equal(bucketed.status, 200, bucketed.text);
    const months = bucketed.body.rows.map((row: Record<string, unknown>) => Object.values(row)[0]);
    assert.ok(months.includes(day(-40).slice(0, 7)) && months.includes(null), bucketed.text);

    // The dashboard's `over` and its chart's month take it; nothing is refused.
    const served = await call('/api/app');
    assert.equal(served.body.app.views.board.error, undefined, JSON.stringify(served.body.app.views.board));
  });
});

test('a declaration names a TEXT column on SQLite, and says so where it cannot hold', () => {
  const sqlite = {
    label: 'x',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'task',
        name: 'task',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'due_on', type: 'TEXT', nullable: true, primaryKey: false },
          { name: 'raw', type: '', nullable: true, primaryKey: false },
          { name: 'blob', type: 'BLOB', nullable: true, primaryKey: false },
        ],
      },
    ],
  } as DatabaseSchema;
  const problems = (types: Record<string, unknown>, schema: DatabaseSchema = sqlite) => {
    const app = parseAppConfig(definition(types), 'dates fixture');
    const dates = Object.entries(types).map(([column, as]) => ({ table: 'task', column, as: as as 'date' }));
    return resolveResources(app, withDeclaredDates(schema, dates)).problems.join('\n');
  };
  assert.equal(problems({ due_on: 'date', raw: 'datetime' }), '');
  assert.match(problems({ id: 'date' }), /types "id" is INTEGER; only a TEXT column is declared a date/);
  assert.match(problems({ blob: 'date' }), /types "blob" is BLOB/);
  assert.match(problems({ due: 'date' }), /has no column "due"/);
  assert.match(problems({ due_on: 'date' }, { ...sqlite, dialect: 'postgres' }), /SQLite only; on postgres its type says it/);
  assert.throws(
    () => parseAppConfig(definition({ due_on: 'day' }), 'dates fixture'),
    /"types" that is not an object of the resource's own TEXT column → 'date' or 'datetime'/,
  );
});
