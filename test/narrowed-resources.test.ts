/**
 * Narrowed resources (Preview, appNarrowed.ts): one table bound as several resources, each standing on fixed
 * conditions — audit events of kind order and of kind conversation, each with its own `correlation_id` reference,
 * where the database holds no key for a column that points at one of two tables.
 *
 * Every read through a narrowed resource stands on its conditions: a row outside them is absent from its list,
 * count, search, record page, related and reverse lists, timeline, breakdown, figure, rollup and export, and from a
 * command's reads. The correlation ids collide on purpose (order 1 and conversation 1), so a read that dropped the
 * conditions would show the other kind's rows. A write through one is kept inside its conditions
 * (narrowed-writes.test.ts); here, one without access: 'write' is read-only as any resource is.
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
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { appResourceCatalog, createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { narrowedOverlaps } from '../packages/mistri/src/shared/appNarrowed.js';
import { appAdvisories, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { apiOwnerFixture, readOwner, type Said } from './support/apiOwnerFixture.js';
import { liveSkip } from './live.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { withTableChoices } from '../packages/mistri/src/server/forms/formChoices.js';

const SCHEMA = `CREATE TABLE orders (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE conversations (id INTEGER PRIMARY KEY, subject TEXT NOT NULL);
  CREATE TABLE audit_event (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, correlation_id INTEGER, note TEXT NOT NULL, at DATE NOT NULL);
  INSERT INTO orders VALUES (1, 'Order one'), (2, 'Order two');
  INSERT INTO conversations VALUES (1, 'Chat one'), (2, 'Chat two');
  INSERT INTO audit_event VALUES
    (1, 'order', 1, 'placed', '2026-01-01'),
    (2, 'order', 1, 'paid', '2026-01-02'),
    (3, 'conversation', 1, 'hello', '2026-01-03'),
    (4, 'conversation', 2, 'goodbye', '2026-01-04'),
    (5, 'order', 2, 'placed', '2026-01-05');`;

/* The rows of kind order, and the one row of order 1's correlation id that is a conversation's. */
const ORDER_EVENTS = [1, 2, 5];
const OUTSIDE = 3;

/* A resource binds its table by the id its catalog gives it: bare on SQLite, schema-qualified on Postgres. */
const definition = (more: Record<string, unknown> = {}, table = 'audit_event') => ({
  id: 'narrowed',
  name: 'Narrowed',
  connection: 'narrowed',
  resources: {
    orders: { rollups: { events: { fn: 'count', from: 'orderEvents' }, last_note: { fn: 'latest', from: 'orderEvents', column: 'note' } } },
    conversations: {},
    audit_event: { access: 'write' },
    orderEvents: { physical: table, query: 'kind = order', references: { correlation_id: { to: 'orders' } } },
    chatEvents: { physical: table, query: 'kind = conversation', references: { correlation_id: { to: 'conversations' } } },
  },
  views: {
    'order-events': { kind: 'list', from: 'orderEvents', label: 'Order events' },
    'chat-events': { kind: 'list', from: 'chatEvents', label: 'Chat events' },
    orders: { kind: 'list', from: 'orders', label: 'Orders' },
  },
  home: 'order-events',
  nav: ['order-events', 'chat-events', 'orders'],
  ...more,
});

type Answer = { status: number; text: string; body: any };
type Call = (path: string, body?: object) => Promise<Answer>;

async function serve(app: Record<string, unknown>, run: (call: Call) => Promise<void>, signIn = false) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-narrowed-'));
  const file = join(directory, 'narrowed.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.close();
  provisionSqliteRecordHistory(file);
  const registry = new Registry();
  registry.add({ id: 'narrowed', name: 'Narrowed', url: file, source: 'config', writable: true });
  const parsed = parseAppConfig(app, 'narrowed fixture');
  const pages = parsePagesConfig({ pages: [{ label: 'Order', base: 'orders', sections: [{ kind: 'fields', show: ['title'] }] }] }, 'pages');
  const host: AppHost = { app: { path: 'narrowed.ts', app: parsed, pages, sources: {} }, pages };
  if (signIn)
    host.auth = { spec: parsed.auth!, store: 'not-used', handler: async () => {}, close: async () => {}, session: async () => null };
  const hosts: AppHost[] = [host];
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
        ...(body ? { method: 'POST', body: JSON.stringify({ app: parsed.id, ...body }) } : {}),
      });
      const text = await response.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, text, body: json };
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('narrowed');
    rmSync(directory, { recursive: true, force: true });
  }
}

const ids = (answer: Answer): number[] => {
  assert.equal(answer.status, 200, answer.text);
  assert.ok(Array.isArray(answer.body?.rows), answer.text);
  return answer.body.rows.map((row: { id: number }) => row.id).sort((a: number, b: number) => a - b);
};

/* The App's own address for a record, as a browser asks it: the status it answers with. */
const fetchPage = async (call: Call, path: string): Promise<number> => (await call(path)).status;

const page = (sections: unknown[], base = 'orders') => parsePagesConfig({ pages: [{ label: 'P', base, sections }] }, 'page')[0];

test('the served catalog carries each narrowed resource as a table of its own, with its own reference', async () => {
  await serve(definition(), async (call) => {
    const schema = await call('/api/schema');
    assert.equal(schema.status, 200, schema.text);
    const table = (id: string) => schema.body.tables.find((each: { id: string }) => each.id === id);
    const reference = (id: string) => table(id).columns.find((column: { name: string }) => column.name === 'correlation_id').references;
    assert.deepEqual(reference('orderEvents'), { table: 'orders', column: 'id' });
    assert.deepEqual(reference('chatEvents'), { table: 'conversations', column: 'id' });
    assert.equal(reference('audit_event'), undefined, "the table's own resource says nothing it does not");
  });
});

test('list, query, count, counts and search read only the rows the conditions admit', async () => {
  await serve(definition(), async (call) => {
    // The list a view runs, as the client asks it.
    assert.deepEqual(
      ids(await call('/api/view/run', { view: { id: 'v', name: 'V', base: 'orderEvents', columns: [{ path: 'id' }] } })),
      ORDER_EVENTS,
    );
    assert.deepEqual(ids(await call('/api/run', { q: 'orderEvents show id' })), ORDER_EVENTS);
    assert.deepEqual(ids(await call('/api/run', { q: 'chatEvents show id' })), [3, 4]);
    assert.deepEqual(
      ids(await call('/api/run', { q: 'audit_event show id' })),
      [1, 2, 3, 4, 5],
      "the table's own resource reads every row",
    );
    assert.deepEqual(ids(await call('/api/query', { table: 'orderEvents' })), ORDER_EVENTS);
    const counted = await call('/api/count', { table: 'orderEvents', exactCount: true });
    assert.equal(counted.status, 200, counted.text);
    assert.equal(counted.body.count, 3, counted.text);
    const counts = await call('/api/counts', { items: ['orderEvents', 'chatEvents'] });
    assert.equal(counts.status, 200, counts.text);
    assert.match(counts.text, /3/);
    // The list's search box is a condition on its text (appListModel.ts searchColumn): `hello` is a conversation's.
    assert.deepEqual(ids(await call('/api/run', { q: 'orderEvents note contains hel show id' })), []);
    assert.deepEqual(ids(await call('/api/run', { q: 'chatEvents note contains hel show id' })), [OUTSIDE]);
    // An OR in the request cannot step outside: the conditions are ANDed into each of its groups.
    assert.deepEqual(ids(await call('/api/run', { q: 'orderEvents id = 3 or id = 1 show id' })), [1]);
  });
});

test("a record page of a row outside the conditions finds no record; the reference walks to the narrowed resource's own target", async () => {
  await serve(definition(), async (call) => {
    const record = page([{ kind: 'fields', show: ['note', 'correlation_id.title'] }], 'orderEvents');
    // The record page in one request, as the client asks it: a row outside the conditions is no record.
    const row = (answer: Answer) => {
      assert.equal(answer.status, 200, answer.text);
      const read = answer.body.reads.find((each: { body: { view?: { id: string } } }) => each.body.view?.id.endsWith(':row'));
      assert.ok(read, answer.text);
      return read.reply.rows as Array<Record<string, unknown>>;
    };
    assert.deepEqual(row(await call('/api/pages/compose', { key: { id: OUTSIDE }, page: record })), []);
    assert.deepEqual(row(await call('/api/pages/compose', { key: { id: 999 }, page: record })), [], 'as a key nothing holds');
    const [inside] = row(await call('/api/pages/compose', { key: { id: 1 }, page: record }));
    assert.equal(inside?.['correlation_id.title'], 'Order one');
    // Its address answers as one nothing holds does.
    const outsidePage = await fetchPage(call, '/order-events/3');
    assert.equal(outsidePage, await fetchPage(call, '/order-events/999'));
    const walked = await call('/api/run', { q: 'chatEvents show id, correlation_id.subject sort id' });
    assert.deepEqual(
      walked.body.rows.map((row: Record<string, unknown>) => row['correlation_id.subject']),
      ['Chat one', 'Chat two'],
      walked.text,
    );
    // The record's own reads by key (a record's references, its row) stand on the conditions too.
    assert.deepEqual(
      ids(await call('/api/query', { table: 'orderEvents', filter: { groups: [[{ column: 'id', op: '=', value: OUTSIDE }]] } })),
      [],
    );
  });
});

test("related and reverse lists, timelines, breakdowns, figures, rollups, any-conditions and exports leave the other kind's rows out", async () => {
  await serve(definition(), async (call) => {
    const order = page([
      { kind: 'list', from: 'orderEvents', whose: 'correlation_id', show: ['id', 'note'] },
      { kind: 'timeline', streams: [{ from: 'orderEvents', whose: 'correlation_id', at: 'at', text: 'note' }] },
      { kind: 'metric', from: 'orderEvents', whose: 'correlation_id', measure: 'count' },
      { kind: 'breakdown', from: 'orderEvents', whose: 'correlation_id', by: 'note' },
    ]);
    const plan = await call('/api/pages/plan', { key: { id: 1 }, page: order });
    assert.equal(plan.status, 200, plan.text);
    const [related, timeline] = plan.body.plans;
    // Related list: order 1's events are 1 and 2; event 3 shares its correlation id and is a conversation's.
    assert.deepEqual(ids(await call('/api/view/run', { view: related.view })), [1, 2]);
    // Timeline: each stream is a view of its rows.
    assert.deepEqual(ids(await call('/api/view/run', { view: { ...timeline.streams[0].view, columns: [{ path: 'id' }] } })), [1, 2]);
    // Figure and breakdown on the record page, run as the composed page sends them.
    const composed = await call('/api/pages/compose', { key: { id: 1 }, page: order });
    assert.equal(composed.status, 200, composed.text);
    const breakdowns = composed.body.reads.filter((read: { path: string }) => read.path === '/api/breakdown');
    assert.equal(breakdowns.length, 2, composed.text);
    const [figure, grouped] = await Promise.all(breakdowns.map((read: { body: object }) => call('/api/breakdown', read.body)));
    assert.equal(figure!.status, 200, figure!.text);
    assert.deepEqual(
      figure!.body.rows,
      [{ value: 2 }],
      "the figure counts order 1's two events, not the conversation event that shares its id",
    );
    assert.equal(grouped!.status, 200, grouped!.text);
    assert.deepEqual(grouped!.body.rows.map((row: { note: string }) => row.note).sort(), ['paid', 'placed']);

    // Reverse list: what points at order 1, counted by the record's references.
    const references = await call('/api/references', { table: 'orders', key: { id: 1 } });
    assert.equal(references.status, 200, references.text);
    const reverse = references.body.references.find((each: { table: string }) => each.table === 'orderEvents');
    assert.ok(reverse, references.text);
    assert.equal(reverse.count, 2, references.text);
    assert.ok(
      !references.body.references.some((each: { table: string }) => each.table === 'chatEvents'),
      'a conversation event does not point at an order',
    );

    // A dashboard's breakdown over the whole resource.
    const whole = await call('/api/breakdown', { text: 'orderEvents count by note' });
    assert.equal(whole.status, 200, whole.text);
    assert.doesNotMatch(whole.text, /hello|goodbye/, whole.text);
    const total = await call('/api/breakdown', { text: 'orderEvents count' });
    assert.match(JSON.stringify(total.body.rows), /\b3\b/, total.text);

    // Rollups over a narrowed child, and an `any` condition asking of its rows.
    const rolled = await call('/api/run', { q: 'orders show id, events, last_note sort id' });
    assert.equal(rolled.status, 200, rolled.text);
    assert.deepEqual(
      rolled.body.rows.map((row: Record<string, unknown>) => [row.id, row.events, row.last_note]),
      [
        [1, 2, 'paid'],
        [2, 1, 'placed'],
      ],
    );
    assert.deepEqual(ids(await call('/api/run', { q: 'orders any orderEvents where note = hello show id' })), []);
    assert.deepEqual(ids(await call('/api/run', { q: 'conversations any chatEvents where note = hello show id' })), [1]);

    // Export, as a file of every matching row.
    const exported = await call('/api/export', { q: 'orderEvents', format: 'json' });
    assert.equal(exported.status, 200, exported.text);
    const rows = JSON.parse(exported.text) as Array<{ id: number }>;
    assert.deepEqual(rows.map((row) => row.id).sort(), ORDER_EVENTS);
  });
});

test("a narrowed resource without access: 'write' is read-only on every door; its table writes as before", async () => {
  await serve(definition(), async (call) => {
    const refused = (answer: Answer, what: string) => {
      assert.ok(answer.status >= 400, `${what}: ${answer.status} ${answer.text}`);
      assert.doesNotMatch(answer.text, /"ok":true/);
    };
    refused(
      await call('/api/insert', { table: 'orderEvents', values: { kind: 'conversation', correlation_id: 1, note: 'x', at: '2026-02-01' } }),
      'insert',
    );
    refused(await call('/api/update', { table: 'orderEvents', key: { id: 1 }, values: { kind: 'conversation' } }), 'update');
    refused(await call('/api/delete', { table: 'orderEvents', key: { id: 1 }, confirm: true }), 'delete');
    assert.deepEqual(ids(await call('/api/run', { q: 'orderEvents show id' })), ORDER_EVENTS, 'nothing moved');
    const own = await call('/api/update', { table: 'audit_event', key: { id: 1 }, values: { note: 'placed again' } });
    assert.equal(own.status, 200, own.text);
  });
});

test('the loader refuses what a narrowed resource cannot be yet, and a table bound twice without a query', () => {
  const base = definition();
  const withResource = (patch: Record<string, unknown>) => ({
    ...base,
    resources: { ...base.resources, orderEvents: { ...base.resources.orderEvents, ...patch } },
  });
  // What writes through its query is a narrowed resource's as it is any resource's (narrowed-writes.test.ts).
  for (const patch of [
    { access: 'write' },
    { access: 'write', delete: true },
    { access: 'write', actions: { flip: { label: 'Flip', set: { note: 'flipped' } } } },
    { access: 'write', import: true },
    { access: 'write', notify: [{ on: 'insert', to: 'note', title: 'New event' }] },
  ])
    assert.doesNotThrow(() => parseAppConfig(withResource(patch), 'x'), JSON.stringify(patch));
  // What writes a row some other way is not yet.
  assert.throws(() => parseAppConfig(withResource({ access: 'write', settings: 'Preferences' }), 'x'), /does not take it yet \(Preview\)/);
  const twice = { ...base, resources: { ...base.resources, allEvents: { physical: 'audit_event' } } };
  assert.throws(() => parseAppConfig(twice, 'x'), /bound again only with a "query"/);
  const pointing = {
    ...base,
    resources: { ...base.resources, notes: { physical: 'conversations', references: { id: { to: 'orderEvents' } } } },
  };
  assert.throws(() => parseAppConfig(pointing, 'x'), /has a "query"/);
  // A tenant App reads its rows through tenant membership alone, and its catalogs (tenant/*) take no query yet.
  const tenant = {
    ...base,
    auth: { store: './auth.db', rows: 'tenant', roles: { reader: { read: true } } },
    resources: Object.fromEntries(
      Object.entries(base.resources).map(([name, resource]) => [name, { ...resource, access: undefined, owner: 'global' }]),
    ),
  };
  assert.throws(() => parseAppConfig(tenant, 'x'), /a tenant App does not take yet/);
  // What follows every write to the table, whatever the conditions say: declared on the table's own resource.
  for (const [key, value] of [
    ['flows', { from: 'flow', steps: 'step' }],
    ['triggers', ['audit_stamp']],
    ['search', { connection: 'search', fields: ['note'] }],
  ] as const)
    assert.throws(() => parseAppConfig(withResource({ [key]: value }), 'x'), /follow every write to its table/, key);
});

const physical = (): DatabaseSchema => {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  db.close();
  const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  return {
    label: 'narrowed',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      { id: 'orders', name: 'orders', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('title', 'TEXT')] },
      {
        id: 'audit_event',
        name: 'audit_event',
        schema: '',
        isView: false,
        columns: [column('id', 'INTEGER', true), column('kind', 'TEXT'), column('correlation_id', 'INTEGER'), column('note', 'TEXT')],
      },
    ],
  };
};

test('the catalog proves each query against its table, and refuses conditions that are not fixed ones on its own row', () => {
  const bind = (query: string) => appResourceCatalog(physical(), { orderEvents: 'audit_event' }, [], [], { orderEvents: query });
  assert.equal(bind('kind = order').narrowed?.get('orderEvents')?.groups.length, 1);
  assert.throws(() => bind('flavor = order'), /orderEvents.*flavor/s);
  assert.throws(() => bind('kind = order show id'), /conditions only/);
  assert.throws(
    () => appResourceCatalog(physical(), { a: 'audit_event', b: 'audit_event' }),
    /multiple app resource names. Bind it again only with a "query"/,
  );
  const catalog = appResourceCatalog(physical(), { orderEvents: 'audit_event', chatEvents: 'audit_event' }, [], [], {
    orderEvents: 'kind = order',
    chatEvents: 'kind = conversation',
  });
  assert.deepEqual(
    catalog.schema.tables.map((table) => table.id).sort(),
    ['audit_event', 'chatEvents', 'orderEvents', 'orders'],
    "the table keeps its own name beside its narrowed resources'",
  );
  assert.equal(catalog.toLogical('audit_event'), 'audit_event');
});

test('two narrowed resources whose conditions may both hold of a row are an overlap; disjoint equalities are not', () => {
  const on = (name: string, groups: Array<Array<{ column: string; op: string; value: unknown }>>) => ({
    name,
    table: 'audit_event',
    filter: { groups } as never,
  });
  assert.deepEqual(
    narrowedOverlaps([
      on('a', [[{ column: 'kind', op: '=', value: 'order' }]]),
      on('b', [[{ column: 'kind', op: '=', value: 'conversation' }]]),
    ]),
    [],
  );
  assert.deepEqual(
    narrowedOverlaps([
      on('a', [[{ column: 'kind', op: 'in', value: ['order', 'refund'] }]]),
      on('b', [[{ column: 'kind', op: '=', value: 'refund' }]]),
    ]),
    [['a', 'b']],
  );
  assert.deepEqual(
    narrowedOverlaps([on('a', [[{ column: 'kind', op: '=', value: 'order' }]]), on('b', [[{ column: 'note', op: '=', value: 'x' }]])]),
    [['a', 'b']],
  );
  // `mistri check` says it beside its verdict, over the App's own catalog; the fixture's two kinds are apart.
  const advice = (app: Record<string, unknown>) => {
    const parsed = parseAppConfig(app, 'n.ts');
    const { schema } = appResourceCatalog(physical(), { orderEvents: 'audit_event', chatEvents: 'audit_event' }, [], [], {
      orderEvents: String(parsed.resources?.orderEvents?.query),
      chatEvents: String(parsed.resources?.chatEvents?.query),
    });
    return appAdvisories({ path: 'n.ts', app: parsed, pages: [], sources: {} } as unknown as LoadedApp, schema).filter((line) =>
      line.includes('[narrowed-overlap]'),
    );
  };
  assert.deepEqual(advice(definition()), []);
  const base = definition();
  const overlapping = { ...base, resources: { ...base.resources, chatEvents: { ...base.resources.chatEvents, query: 'note = hello' } } };
  const [warning, ...more] = advice(overlapping);
  assert.match(String(warning), /resources "chatEvents" \[narrowed-overlap\]: its query and "orderEvents"'s may both hold/);
  assert.equal(more.length, 0);
});

test("a row policy is the table's: one that gives a narrowed resource another rule than its table's is refused", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-narrowed-scope-'));
  const file = join(directory, 'n.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'n', name: 'N', url: file, source: 'config', writable: false });
  try {
    const opened = await registry.open('n');
    const resources = createAppResources(opened.adapter, opened.schema, { orderEvents: 'audit_event' }, [], [], {
      orderEvents: 'kind = order',
    });
    assert.ok(resources.adapter.scopeReads, 'the SQLite adapter scopes reads');
    const all = Object.fromEntries(resources.schema.tables.map((table) => [table.id, true]));
    const reads = await resources.adapter.scopeReads!(all);
    assert.deepEqual(
      (await reads.query({ table: 'orderEvents', limit: 10, offset: 0 })).rows.map((row) => row.id).sort(),
      ORDER_EVENTS,
      'under a scope, the conditions still stand',
    );
    await assert.rejects(
      resources.adapter.scopeReads!({ ...all, orderEvents: { groups: [[{ column: 'note', op: '=', value: 'paid' }]] } }),
      /row policy gives "orderEvents" a rule of its own/,
    );
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

/* ---------- the App's own API and its MCP tools ---------- */

const apiApp = (store: string, table?: string) =>
  definition(
    {
      auth: { store, roles: { reader: { read: true } } },
      api: {
        version: 1,
        roles: ['reader'],
        resources: { orderEvents: { fields: ['id', 'note', 'correlation_id', 'correlation_id.title'], filters: ['note'], sorts: ['id'] } },
        views: ['order-events'],
      },
    },
    table,
  );

for (const engine of ['sqlite', 'postgres'] as const) {
  const skip = engine === 'postgres' ? liveSkip('postgres', process.env.TABLEWALK_TEST_PG) : false;
  test(`the App API and its MCP tools read a narrowed resource on its conditions (${engine})`, { skip, timeout: 180000 }, async (t) => {
    const f = await apiOwnerFixture(t, {
      engine,
      app: (store) => apiApp(store, engine === 'postgres' ? 'public.audit_event' : 'audit_event'),
      connections: { narrowed: { sql: SCHEMA } },
      accounts: { reader: 'reader' },
    });
    const reader = await f.issue('reader', ['reader']);
    const reads = await readOwner(f, engine, 'number');
    const body = (said: Said) => {
      assert.ok(!('refused' in said), JSON.stringify(said));
      assert.equal(said.status, 200, said.body);
      return JSON.parse(said.body);
    };
    const listed = body(await reads.list(reader, 'list:orderEvents', 'sort=id&count=true'));
    assert.deepEqual(
      listed.items.map((row: { id: number }) => row.id),
      ORDER_EVENTS,
    );
    assert.equal(listed.count.value, ORDER_EVENTS.length);
    assert.deepEqual(
      body(await reads.list(reader, 'list:orderEvents', 'note=hello')).items,
      [],
      'a filter cannot reach past the conditions',
    );
    assert.deepEqual(
      body(await reads.list(reader, 'view:order-events', 'count=true'))
        .items.map((row: { id: number }) => row.id)
        .sort(),
      ORDER_EVENTS,
    );
    assert.equal(body(await reads.item(reader, 'item:orderEvents', '1'))['correlation_id.title'], 'Order one');
    // The outside row answers exactly as a key nothing holds does.
    const outside = await reads.item(reader, 'item:orderEvents', String(OUTSIDE));
    const missing = await reads.item(reader, 'item:orderEvents', '999');
    assert.deepEqual(outside, missing);
    assert.ok('refused' in outside || outside.status === 404, JSON.stringify(outside));
    // The MCP tools are the same operations, so they read through the same owner.
    const tools = body(await reads.tools(reader));
    assert.match(JSON.stringify(tools), /orderEvents|order_?events/i);
  });
}

/* ---------- the paths that read the table by its physical name ---------- */

const withActivity = () => {
  const base = definition();
  return {
    ...base,
    resources: { ...base.resources, audit_event: { ...base.resources.audit_event, audit: { redact: ['note'] } } },
    nav: [...base.nav, 'recent'],
    views: {
      ...base.views,
      recent: {
        kind: 'dashboard',
        label: 'Recent',
        // The table's own resource first, so that a later one's weaker rule would win if the log took the last.
        sections: [
          {
            kind: 'activity',
            title: 'Latest',
            resources: { audit_event: { icon: 'list' }, orderEvents: { icon: 'check-circle' }, chatEvents: { icon: 'user' } },
          },
        ],
      },
    },
  };
};

test("an activity feed and a record's history read the table's one log on each resource's conditions", async () => {
  await serve(withActivity(), async (call) => {
    // Written through the table's own resource, as a narrowed one is read-only: an order's event and a conversation's.
    for (const [id, note] of [
      [1, 'placed again'],
      [OUTSIDE, 'hello again'],
    ] as const) {
      const wrote = await call('/api/update', { table: 'audit_event', key: { id }, values: { note } });
      assert.equal(wrote.status, 200, wrote.text);
    }
    const feed = await call('/api/record-activity', { view: 'recent', section: 0, period: 'today' });
    assert.equal(feed.status, 200, feed.text);
    const said = (feed.body.entries as Array<{ table: string; key: { id: number } }>).map((entry) => [entry.table, entry.key.id]).sort();
    // Each change is a record of the one resource whose conditions hold of it: never the conversation's under orders.
    assert.deepEqual(said, [
      ['audit_event', 1],
      ['audit_event', OUTSIDE],
      ['chatEvents', OUTSIDE],
      ['orderEvents', 1],
    ]);
    // One log for the table keeps what the strictest of its resources keeps: the table's `audit.redact` holds for all.
    assert.doesNotMatch(feed.text, /placed again|hello again/);
    // A record's history is asked after the record is read on its conditions: the outside row has none here.
    const history = (table: string, id: number) => call('/api/record-history', { table, key: { id } });
    const inside = await history('orderEvents', 1);
    assert.equal(inside.status, 200, inside.text);
    assert.equal(inside.body.entries.length, 1);
    assert.equal((await history('chatEvents', OUTSIDE)).status, 200);
    const outside = await history('orderEvents', OUTSIDE);
    assert.ok(outside.status === 403 || outside.status === 404, outside.text);
    assert.doesNotMatch(outside.text, /hello/);
    assert.equal(outside.status, (await history('orderEvents', 999)).status, 'as a key nothing holds');
  });
});

test('a command input whose choices come from a narrowed resource offers only its rows', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-narrowed-choices-'));
  const file = join(directory, 'narrowed.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'narrowed', name: 'Narrowed', url: file, source: 'config', writable: true });
  try {
    const [field] = await withTableChoices({
      registry,
      app: parseAppConfig(definition(), 'choices'),
      connection: 'narrowed',
      commands: undefined,
      owners: [],
      input: [{ name: 'event', label: 'Event', type: 'choice', source: { from: 'orderEvents', by: 'id', labelColumn: 'note' } } as never],
    });
    const offered = (field as unknown as { options?: Array<{ value: unknown }> }).options;
    assert.ok(offered, 'the choices are served with the form');
    assert.deepEqual(offered.map((option) => Number(option.value)).sort(), ORDER_EVENTS);
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a command's transaction reads a narrowed resource on its conditions and writes inside them", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-narrowed-tx-'));
  const file = join(directory, 'n.db');
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'n', name: 'N', url: file, source: 'config', writable: true });
  try {
    const opened = await registry.open('n');
    const resources = createAppResources(opened.adapter, opened.schema, { orderEvents: 'audit_event' }, [], [], {
      orderEvents: 'kind = order',
    });
    assert.ok(resources.adapter.transaction, 'the SQLite adapter runs transactions');
    await resources.adapter.transaction!(async (tx) => {
      const rows = await tx.query({ table: 'orderEvents', limit: 10, offset: 0 });
      assert.deepEqual(rows.rows.map((row) => row.id).sort(), ORDER_EVENTS);
      const outside = await tx.query({
        table: 'orderEvents',
        filter: { groups: [[{ column: 'id', op: '=', value: OUTSIDE }]] },
        limit: 1,
        offset: 0,
      });
      assert.deepEqual(outside.rows, []);
      assert.equal(await tx.count('orderEvents'), ORDER_EVENTS.length);
      await assert.rejects(
        async () => tx.update({ table: 'orderEvents', key: { id: 1 }, values: { kind: 'conversation' } }),
        /would move the row out/,
      );
    });
  } finally {
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a signed-out read of a narrowed resource under auth.public returns only rows inside its conditions', async () => {
  const open = definition({
    auth: { roles: { reader: { read: true } }, public: { read: ['orderEvents'] } },
    home: [{ view: 'order-events', signedOut: true }, { view: 'order-events' }],
  });
  await serve(
    open,
    async (call) => {
      assert.deepEqual(ids(await call('/api/run', { q: 'orderEvents show id', limit: 10, offset: 0 })), ORDER_EVENTS);
      // The conditions are ANDed into whatever the visitor asks; the grant does not name the table or the other kind.
      assert.deepEqual(ids(await call('/api/run', { q: 'orderEvents id = 3 or id = 1 show id', limit: 10, offset: 0 })), [1]);
      for (const q of ['audit_event show id', 'chatEvents show id']) {
        const refused = await call('/api/run', { q, limit: 10, offset: 0 });
        assert.ok(refused.status >= 400 || refused.body.errors?.length, `${q} was answered: ${refused.text}`);
      }
    },
    true,
  );
});
