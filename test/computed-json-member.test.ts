/**
 * A JSON column's member as text (Preview): `computed.text('filters_json.make')`. The catalog that knows the column is
 * json or jsonb makes the path a member read (appComputed.ts), written as PostgreSQL's `#>>` or SQLite's
 * `json_extract`, and worked out alike in JavaScript (computedValue.ts). `mistri check` proves the column is JSON; it
 * cannot know the member is there, and a row without it has no value. SQLite here, served; PostgreSQL under
 * TABLEWALK_TEST_PG, in a database of its own.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseAppConfig, withRollups } from '../packages/mistri/src/shared/app.js';
import { appComputedRules } from '../packages/mistri/src/shared/appComputed.js';
import { parseComputed } from '../packages/engine/src/shared/computedParse.js';
import { evaluateComputed } from '../packages/engine/src/shared/computedValue.js';
import { POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { compileView, type ViewDef } from '../packages/engine/src/shared/view.js';
import { withViewComputed } from '../packages/engine/src/shared/viewLabels.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { createApp } from './support/createApp.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;

/* A saved search: what the person filtered on, kept as a document. Row 3 has no make; row 4 has no filters at all. */
const ROWS: Array<[number, string, string | null]> = [
  [1, 'Compact under 20k', '{"make":"Toyota","price":{"max":20000},"used":true}'],
  [2, 'Family', '{"make":"Honda","price":{"max":35000},"used":false}'],
  [3, 'Anything cheap', '{"price":{"max":9000}}'],
  [4, 'Blank', null],
];
const SQLITE = `CREATE TABLE saved_search (id INTEGER PRIMARY KEY, title TEXT NOT NULL, filters_json JSON);
  ${ROWS.map(([id, title, json]) => `INSERT INTO saved_search VALUES (${id}, '${title}', ${json === null ? 'NULL' : `'${json}'`});`).join('\n')}`;
const POSTGRES = SQLITE.replace('INTEGER PRIMARY KEY', 'integer PRIMARY KEY').replace('filters_json JSON', 'filters_json jsonb');

const COMPUTED = {
  make: { type: 'text', value: 'filters_json.make' },
  max_price: { type: 'text', value: 'filters_json.price.max' },
  used: { type: 'text', value: 'filters_json.used' },
};

const definition = (computed: Record<string, unknown> = COMPUTED) => ({
  id: 'searches',
  name: 'Searches',
  connection: 'searches',
  resources: { saved_search: { computed } },
  views: { searches: { kind: 'list', from: 'saved_search', show: ['title', 'make', 'max_price'], label: 'Searches' } },
  home: 'searches',
});

const catalog = (dialect: 'sqlite' | 'postgres', type = dialect === 'postgres' ? 'jsonb' : 'JSON'): DatabaseSchema =>
  ({
    label: 'searches',
    dialect,
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'saved_search',
        name: 'saved_search',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'title', type: 'text', nullable: false, primaryKey: false },
          { name: 'filters_json', type, nullable: true, primaryKey: false },
        ],
      },
    ],
  }) as unknown as DatabaseSchema;

/* Each row's make, top price and used flag, as text: what every engine and JavaScript agree on. */
const EXPECTED = [
  { id: 1, make: 'Toyota', max_price: '20000', used: 'true' },
  { id: 2, make: 'Honda', max_price: '35000', used: 'false' },
  { id: 3, make: null, max_price: '9000', used: null },
  { id: 4, make: null, max_price: null, used: null },
];

test('a JSON member is a column of the table to the catalog, and only a JSON column has members', () => {
  const judged = (computed: Record<string, unknown>, type?: string) =>
    appComputedRules(parseAppConfig(definition(computed), 'searches.ts'), catalog('sqlite', type)).problems;
  assert.deepEqual(judged(COMPUTED), []);
  assert.deepEqual(judged(COMPUTED, 'jsonb'), []);
  assert.match(judged(COMPUTED, 'TEXT')[0]!, /"filters_json" is TEXT, not JSON, so "filters_json\.make" names nothing in it/);
  assert.match(judged({ x: { type: 'text', value: 'title.make' } })[0]!, /"title" is text, not JSON|"title" is TEXT, not JSON/i);
  // A member is text: it is no yes-or-no or number without saying so.
  assert.match(judged({ x: { type: 'boolean', value: 'filters_json.used' } })[0]!, /is text/);
  // Text is no value a `set` can write.
  assert.throws(
    () =>
      parseAppConfig(
        {
          ...definition(),
          resources: {
            saved_search: {
              access: 'write',
              computed: COMPUTED,
              actions: { mark: { label: 'Mark', set: { title: { type: 'text', value: 'x' } } } },
            },
          },
        },
        'searches.ts',
      ),
    /computed\.date/,
  );
});

test('JavaScript reads a member as the databases say it', () => {
  const tree = (path: string) => parseComputed(path, (read) => read === 'filters_json' || read.startsWith('filters_json.'));
  for (const row of EXPECTED) {
    const json = ROWS.find(([id]) => id === row.id)![2];
    const read = (path: string) => (path === 'filters_json' ? json : null);
    const worked = (path: string) => {
      const node = tree(path);
      /* The catalog makes the path a member read; here the same node, as it would. */
      const member = node.k === 'path' ? { k: 'json' as const, column: 'filters_json', keys: node.path.split('.').slice(1) } : node;
      return evaluateComputed(member, { today: '2026-11-04', now: new Date(0), me: null }, read);
    };
    assert.deepEqual(
      { id: row.id, make: worked('filters_json.make'), max_price: worked('filters_json.price.max'), used: worked('filters_json.used') },
      row,
    );
  }
});

test('PostgreSQL reads a member with #>>, by its path of keys', () => {
  const served = withRollups(parseAppConfig(definition(), 'searches.ts'), catalog('postgres'), new Date(0), null);
  const view: ViewDef = { id: 'v', name: 'v', base: 'saved_search', columns: [{ path: 'make' }, { path: 'max_price' }] };
  const text = compileView(served, withViewComputed(served, view), POSTGRES_STYLE).text;
  assert.match(text, /#>> '\{make\}'/);
  assert.match(text, /#>> '\{price,max\}'/);
});

type Answer = { status: number; text: string; body: any };

async function serve(url: string, run: (call: (path: string, body: object) => Promise<Answer>) => Promise<void>) {
  const registry = new Registry();
  registry.add({ id: 'searches', name: 'Searches', url, source: 'config' });
  const parsed = parseAppConfig(definition(), 'searches.ts');
  const hosts: AppHost[] = [{ app: { path: 'searches.ts', app: parsed, pages: [], sources: {} }, pages: [] }];
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: hosts, pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run(async (path, body) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
        signal: AbortSignal.timeout(10000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: parsed.id, ...body }),
      });
      const text = await response.text();
      return { status: response.status, text, body: JSON.parse(text) };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('searches');
  }
}

/* The list, a sort and a condition on a member, and a record's row: the reads a page sends. */
async function reads(call: (path: string, body: object) => Promise<Answer>) {
  const rows = async (q: string) => {
    const answer = await call('/api/run', { q });
    assert.equal(answer.status, 200, answer.text);
    return answer.body.rows as Array<Record<string, unknown>>;
  };
  assert.deepEqual(await rows('saved_search show id, make, max_price, used sort id'), EXPECTED);
  assert.deepEqual(
    (await rows('saved_search make is not empty show id sort make')).map((row) => row.id),
    [2, 1],
    'a member sorts and filters as the text it is',
  );
  assert.deepEqual(
    (await rows('saved_search make = Toyota show id')).map((row) => row.id),
    [1],
  );
  const record = await call('/api/view/run', {
    view: {
      id: 'record:row',
      name: 'saved_search',
      base: 'saved_search',
      columns: [{ path: 'title' }, { path: 'make' }],
      filter: { groups: [[{ path: 'id', op: '=', value: 2 }]] },
      limit: 1,
    },
  });
  assert.equal(record.status, 200, record.text);
  assert.deepEqual(record.body.rows, [{ title: 'Family', make: 'Honda' }]);
}

test('SQLite serves a member in a list, a sort, a condition and a record', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-json-member-'));
  const file = join(directory, 'searches.db');
  const db = new DatabaseSync(file);
  db.exec(SQLITE);
  db.close();
  try {
    await serve(file, reads);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  'PostgreSQL serves a member in a list, a sort, a condition and a record',
  { skip: liveSkip('postgres', LIVE), timeout: 120000 },
  async () => {
    const owned = await uuidPostgresDatabase('tw_json_member');
    try {
      const client = await pgClient(owned.url);
      try {
        await client.query(POSTGRES);
      } finally {
        await client.end();
      }
      await serve(owned.url, reads);
    } finally {
      await owned.drop();
    }
  },
);
