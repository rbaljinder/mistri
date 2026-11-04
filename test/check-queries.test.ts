/**
 * `query-invalid` (checkQueries.ts): the database's verdict on the reads an App's pages would make. Validation judges
 * the definition against the catalog it read; the database alone knows whether the SQL written from it is accepted,
 * so a catalog that lists a column the database lacks is the deterministic way to make a statement the compiler
 * writes and the engine refuses. One block runs the same on a disposable PostgreSQL
 * when TABLEWALK_TEST_PG names a server.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { PageDef } from '../packages/engine/src/shared/pageModel.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { pageQueryFailures } from '../packages/mistri/src/server/build/checkQueries.js';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const work = mkdtempSync(join(tmpdir(), 'mistri-check-queries-'));
after(() => rmSync(work, { recursive: true, force: true }));

const DDL = `
CREATE TABLE holds (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE items (id INTEGER PRIMARY KEY, hold_id INTEGER REFERENCES holds(id), label TEXT);
CREATE TABLE moves (id INTEGER PRIMARY KEY, item_id INTEGER REFERENCES items(id), at DATE, what TEXT);`;

const definition = {
  id: 'stock',
  name: 'Stock',
  connection: 'data',
  resources: { holds: {}, items: {}, moves: {} },
  views: { holds: { kind: 'list', from: 'holds' } },
  home: 'holds',
};
const page = {
  id: 'hold',
  name: 'Hold',
  base: 'holds',
  sections: [
    { kind: 'fields', paths: ['name'] },
    { kind: 'list', title: 'Items', from: 'items', path: 'hold_id', columns: ['label'] },
    { kind: 'list', title: 'By item', from: 'moves', path: 'item_id.hold_id', columns: ['what'], group: { by: 'item_id' } },
    { kind: 'timeline', title: 'Activity', streams: [{ from: 'moves', path: 'item_id.hold_id', at: 'at', show: 'what' }] },
    { kind: 'metric', title: 'Items', fn: 'count', from: 'items', path: 'hold_id' },
  ],
} as unknown as PageDef;

/** The catalog the connection was opened with is the one statements are written from; a column it lists that the
 * database lacks (a migration run under a long-lived catalog, a view changed) is a statement only the database refuses. */
const ghost = (schema: DatabaseSchema) => {
  schema.tables.find((table) => table.name === 'items')!.columns.push({ name: 'ghost', type: 'TEXT', nullable: true, primaryKey: false });
};

/** The same page with the Items list reading the column the catalog invents. */
const ghostPage = {
  ...page,
  sections: page.sections.map((section, i) => (i === 1 ? { ...section, columns: ['label', 'ghost'] } : section)),
} as PageDef;

async function failures(open: (registry: Registry) => void, mutate?: (schema: DatabaseSchema) => void) {
  const registry = new Registry();
  try {
    open(registry);
    const { schema } = await registry.open('data');
    mutate?.(schema);
    const app = parseAppConfig(definition, 'fixture');
    return await pageQueryFailures(registry, app, [mutate ? ghostPage : page], 'data');
  } finally {
    await registry.closeAll();
  }
}

describe('the database plans the reads of a page', () => {
  test('SQLite: a healthy page has none refused, and each distinct statement is explained once', async () => {
    const path = join(work, 'ok.db');
    const db = new DatabaseSync(path);
    db.exec(DDL);
    db.close();
    const ran = await failures((registry) => registry.add({ id: 'data', name: 'Data', url: path, source: 'config' }));
    assert.deepEqual(ran.failures, []);
    assert.equal(ran.skipped, 0);
    assert.equal(ran.sections, 4, 'the fields section reads nothing');
    assert.ok(ran.statements >= 4, `${ran.statements} statements`);
  });

  test('SQLite: a statement the engine refuses is named by page:section with the engine’s message', async () => {
    const path = join(work, 'stale.db');
    const db = new DatabaseSync(path);
    db.exec(DDL);
    db.close();
    const ran = await failures((registry) => registry.add({ id: 'data', name: 'Data', url: path, source: 'config' }), ghost);
    assert.deepEqual(
      ran.failures.map((failure) => failure.at),
      ['hold:Items'],
    );
    assert.match(ran.failures[0].message, /no such column: .*ghost/i);
    assert.equal(ran.failures[0].path, 'pages.hold.sections[1]');
  });
});

/** An App whose rooms read `items`; the catalog invents `ghost` on it, as a stale catalog would. */
async function roomFailures(views: Record<string, unknown>) {
  const path = join(work, `rooms-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseSync(path);
  db.exec(DDL);
  db.close();
  const registry = new Registry();
  try {
    registry.add({ id: 'data', name: 'Data', url: path, source: 'config' });
    const { schema } = await registry.open('data');
    ghost(schema);
    const app = parseAppConfig(
      {
        ...definition,
        resources: { ...definition.resources, items: { segments: { labeled: { label: 'Labeled', query: 'label is not empty' } } } },
        views: { holds: { kind: 'list', from: 'holds' }, ...views },
        nav: ['holds', ...Object.keys(views)],
      },
      'fixture',
    );
    return await pageQueryFailures(registry, app, [], 'data');
  } finally {
    await registry.closeAll();
  }
}

describe('the database plans the reads of the rooms', () => {
  test('a list that sorts on a column the database lacks is refused, on the tab that reads it', async () => {
    const ran = await roomFailures({
      stock: { kind: 'list', from: 'items', show: ['label'], tabs: [{ label: 'All' }, { segment: 'labeled', sort: 'ghost' }] },
      sorted: { kind: 'list', from: 'items', show: ['label'], sort: 'ghost' },
    });
    assert.deepEqual(ran.failures.map((failure) => failure.at).sort(), ['list:sorted', 'list:stock[Labeled]']);
    assert.match(ran.failures[0].message, /ghost/i);
    assert.deepEqual(ran.failures.map((failure) => failure.path).sort(), ['views.sorted', 'views.stock.tabs[1]']);
  });

  test('a dashboard figure over a column the database lacks is refused', async () => {
    const ran = await roomFailures({
      board: {
        kind: 'dashboard',
        label: 'Board',
        sections: [
          { kind: 'metric', title: 'Count', from: 'items' },
          { kind: 'metric', title: 'Total', from: 'items', measure: 'sum ghost as total' },
        ],
      },
    });
    assert.deepEqual(
      ran.failures.map((failure) => failure.at),
      ['dashboard:board'],
    );
    assert.match(ran.failures[0].message, /ghost/i);
  });

  test('healthy rooms are planned and none refused', async () => {
    const ran = await roomFailures({ stock: { kind: 'list', from: 'items', show: ['label'], sort: 'label' } });
    assert.deepEqual(ran.failures, []);
    assert.ok(ran.statements >= 2);
  });
});

describe('mistri check runs the queries step', () => {
  const dir = join(work, 'app');
  mkdirSync(dir);
  const db = join(work, 'cli.db');
  const sqlite = new DatabaseSync(db);
  sqlite.exec(DDL);
  sqlite.close();
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(dir, 'app.json'), JSON.stringify(definition));
  mkdirSync(join(dir, 'pages'));
  writeFileSync(
    join(dir, 'pages', 'hold.json'),
    JSON.stringify({
      base: 'holds',
      sections: [
        { kind: 'fields', show: ['name'] },
        { kind: 'list', title: 'Items', from: 'items', whose: 'hold_id', show: ['label'] },
      ],
    }),
  );
  const config = join(work, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'data', name: 'Data', url: db }] }));
  const run = (...args: string[]) =>
    new Promise<{ code: number; out: string }>((done) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), 'check', '--app', dir, '--config', config, ...args],
        { env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg') }, timeout: 180_000, killSignal: 'SIGKILL' },
        (error, out) => done({ code: (error as { code?: number } | null)?.code ?? 0, out }),
      );
    });

  test('the step is on by default, and --no-query-check leaves it out', async () => {
    const on = JSON.parse((await run('--json')).out) as {
      steps: Array<{ step: string; status: string }>;
      problems: Array<{ code: string }>;
    };
    assert.equal(on.steps.find((step) => step.step === 'queries')?.status, 'passed', JSON.stringify(on.steps));
    assert.ok(!on.problems.some((problem) => problem.code === 'query-invalid'));
    const off = JSON.parse((await run('--no-query-check', '--json')).out) as { steps: Array<{ step: string }> };
    assert.ok(!off.steps.some((step) => step.step === 'queries'));
  });
});

describe('PostgreSQL', { skip: liveSkip('postgres', process.env.TABLEWALK_TEST_PG) }, () => {
  test('a statement the server refuses is query-invalid, planned in a READ ONLY transaction', async () => {
    const database = await uuidPostgresDatabase('qinv');
    const control = await pgClient(database.url);
    try {
      await control.query(DDL.replaceAll('INTEGER PRIMARY KEY', 'integer PRIMARY KEY'));
      const ran = await failures((registry) => registry.add({ id: 'data', name: 'Data', url: database.url, source: 'config' }), ghost);
      assert.deepEqual(
        ran.failures.map((failure) => failure.at),
        ['hold:Items'],
      );
      assert.match(ran.failures[0].message, /column .*ghost.* does not exist/i);
    } finally {
      await control.end();
      await database.drop();
    }
  });
});
