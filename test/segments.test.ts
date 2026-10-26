/**
 * Segments (appSegments.ts): a resource's named conditions, a word in the
 * query language spelled out where it stands. What a block may say, what
 * loading refuses by name, the statement a segment compiles to (the same as
 * its conditions written inline), the sugar that names one (a tab, a source,
 * a rollup), and the served App — row policy still narrows, and a reader who
 * may not read a column a segment names is served no segment, no tab.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { appCatalog, parseAppConfig, resolveViews, segmentProblems, withRollups } from '../packages/mistri/src/shared/app.js';
import { segmentCost } from '../packages/mistri/src/shared/appSegments.js';
import { appRollupRules } from '../packages/mistri/src/shared/appRollups.js';
import { POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView, compileViewCount, parseViewQuery, withViewComputed } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';
import { expandSegments, parseQuery } from '../packages/engine/src/shared/query.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const schema: DatabaseSchema = {
  label: 'Works',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    { id: 'site', name: 'site', schema: '', isView: false, columns: [key('id'), column('name', 'TEXT'), column('region', 'TEXT')] },
    {
      id: 'work_order',
      name: 'work_order',
      schema: '',
      isView: false,
      columns: [
        key('id'),
        column('site_id', 'INTEGER'),
        column('title', 'TEXT'),
        column('status', 'TEXT'),
        column('owner', 'TEXT'),
        column('due_on', 'DATE'),
        column('cost', 'NUMERIC'),
      ],
    },
  ],
  foreignKeys: [{ name: 'order_site', from: { table: 'work_order', columns: ['site_id'] }, to: { table: 'site', columns: ['id'] } }],
} as DatabaseSchema;

const SEGMENTS = {
  open: 'status = open',
  overdue: { query: "open and due_on < '2026-01-01'", label: 'Late' },
  north: 'site_id.region = north',
};

const app = (resources: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Works',
      resources: { site: {}, work_order: { segments: SEGMENTS }, ...resources },
      views: { orders: { kind: 'list', from: 'work_order', tabs: [{ label: 'All' }, 'open', { segment: 'overdue', sort: 'due_on' }] } },
      home: 'orders',
      nav: ['orders'],
      ...extra,
    },
    'segments fixture',
  );

const sqlOf = (catalog: DatabaseSchema, text: string) => {
  const read = textToView(catalog, text);
  assert.deepEqual(read.errors ?? [], [], text);
  const view = withViewComputed(catalog, read.view!);
  return compileView(schema, view, POSTGRES_STYLE);
};

test('a segment block is refused by name when its shape is wrong', () => {
  assert.throws(() => app({ work_order: { segments: { 'two words': 'status = open' } } }), /segment/i);
  assert.throws(() => app({ work_order: { segments: { open: 42 } } }), /segment/i);
  assert.throws(() => app({ work_order: { segments: { open: 'status = open sort due_on' } } }), /sort/);
  assert.throws(() => app({ work_order: { segments: { open: { query: 'status = open', when: 'x' } } } }), /when/);
});

test('a tab that writes its own query is refused with the segment that says it', () => {
  assert.throws(
    () => app({}, { views: { orders: { kind: 'list', from: 'work_order', tabs: [{ label: 'Done lately', query: 'status = done' }] } } }),
    /declare it on the resource \(resources\.work_order\.segments: \{ done_lately: \{ query: "status = done", label: "Done lately" \} \}\) and name it here \('done_lately'\)/,
  );
  assert.throws(
    () => app({}, { views: { orders: { kind: 'list', from: 'work_order', tabs: ['opne'] } } }),
    /names the segment "opne" of "work_order", which it does not declare\. Its segments: open, overdue, north\. Did you mean "open"\?/,
  );
  assert.throws(
    () => app({}, { views: { orders: { kind: 'list', from: 'work_order', tabs: [{ segment: 'open', label: 'Mine' }] } } }),
    /names a segment and has "label"/,
  );
});

test('a tab names its segment: its label and its address are the segment’s', () => {
  const tabs = (app().views.orders as { tabs: unknown[] }).tabs;
  assert.deepEqual(tabs, [
    { label: 'All', query: undefined },
    { label: 'Open', query: 'open', segment: 'open', slug: 'open' },
    { label: 'Late', query: 'overdue sort due_on', segment: 'overdue', slug: 'overdue' },
  ]);
});

test('a source and a rollup name a segment as its word in their query', () => {
  const parsed = app(
    { site: { rollups: { open_orders: { fn: 'count', from: 'work_order', segment: 'open' } } } },
    {
      views: {
        orders: { kind: 'list', from: 'work_order' },
        home: {
          kind: 'dashboard',
          label: 'Home',
          sections: [
            { kind: 'metric', title: 'Late', from: 'work_order.overdue' },
            { kind: 'metric', title: 'Late up north', from: 'work_order.overdue', query: 'north' },
            { kind: 'rows', title: 'Open', from: 'work_order', segment: 'open' },
          ],
        },
      },
      home: 'home',
      nav: ['home', 'orders'],
    },
  );
  const sections = (parsed.views.home as { sections: Array<{ table: string; query: string }> }).sections;
  assert.deepEqual(
    sections.map((section) => [section.table, section.query]),
    [
      ['work_order', 'overdue'],
      ['work_order', 'overdue and north'],
      ['work_order', 'open'],
    ],
  );
  assert.equal(parsed.resources!.site.rollups!.open_orders.query, 'open');
  assert.throws(
    () =>
      app(
        {},
        {
          views: { home: { kind: 'dashboard', label: 'Home', sections: [{ kind: 'metric', title: 'x', from: 'work_order.overdu' }] } },
          home: 'home',
          nav: ['home'],
        },
      ),
    /Did you mean "overdue"\?/,
  );
});

test('loading names a segment that collides, loops or does not read', () => {
  const problems = (segments: Record<string, unknown>, block: Record<string, unknown> = {}) => {
    const parsed = parseAppConfig(
      {
        name: 'Works',
        resources: { site: {}, work_order: { segments, ...block } },
        views: { orders: { kind: 'list', from: 'work_order' } },
        home: 'orders',
        nav: ['orders'],
      },
      'x',
    );
    return segmentProblems(parsed, appCatalog(parsed, schema));
  };
  assert.deepEqual(problems(SEGMENTS), []);
  assert.match(problems({ status: 'status = open' })[0], /the column "status" of work_order/);
  assert.match(problems({ and: 'status = open' })[0], /a word of the query language/);
  assert.match(problems({ hot: 'status = open' }, { rollups: { hot: { fn: 'count', from: 'work_order' } } })[0], /also a rollup/);
  assert.match(problems({ a: 'b', b: 'a' })[0], /segments "a": The segment "a" names itself through/);
  assert.match(problems({ late: 'due_by < today' })[0], /segments "late" query: .*due_by/);
});

test('a segment compiles to the statement its conditions inline would', () => {
  const catalog = withRollups(app(), schema);
  for (const [named, inline] of [
    ['work_order overdue', "work_order status = open and due_on < '2026-01-01'"],
    ['work_order overdue and owner = sam', "work_order (status = open and due_on < '2026-01-01') and owner = sam"],
    ['work_order open or north', 'work_order (status = open) or (site_id.region = north)'],
  ]) {
    const a = sqlOf(catalog, named);
    const b = sqlOf(catalog, inline);
    assert.equal(a.text, b.text, named);
    assert.deepEqual(a.params, b.params, named);
  }
  // A count over a segment is the count over its conditions.
  const count = (text: string) => compileViewCount(schema, withViewComputed(catalog, textToView(catalog, text).view!), POSTGRES_STYLE).text;
  assert.equal(count('work_order overdue'), count("work_order status = open and due_on < '2026-01-01'"));
  // A rollup over a segment reads as the rollup over its conditions.
  const rolled = (query: string) =>
    sqlOf(withRollups(app({ site: { rollups: { n: { fn: 'count', from: 'work_order', query } } } }), schema), 'site show name, n').text;
  assert.equal(rolled('open'), rolled('status = open'));
});

test('a rollup names a segment whichever catalog its reader is handed, the plain one included', () => {
  /* check's schema-types step and mistri check read rollups over the catalog as introspected, with no segments on it. */
  const rolled = app({ site: { rollups: { n: { fn: 'count', from: 'work_order', query: 'overdue' } } } });
  const { rules, problems } = appRollupRules(rolled, schema);
  assert.deepEqual(problems, []);
  assert.ok(rules.get('site')?.n);
});

test('a segment word reads like the conditions it names, and an unknown word says the segments there are', () => {
  const catalog = withRollups(app(), schema);
  assert.equal(
    expandSegments('overdue and owner = me', catalog.tables[1].segments!).text,
    "((status = open) and due_on < '2026-01-01') and owner = me",
  );
  const unknown = parseQuery('work_order opne', { schema: catalog });
  assert.match(
    unknown.errors[0].message,
    /"opne" is not a segment of work_order\. Its segments: open, overdue, north\. Did you mean "open"\?/,
  );
  // A condition's error in a segment is said where the segment is named.
  const said = parseViewQuery(catalog, 'work_order', 'overdue and nope = 1');
  assert.equal(said.errors.length, 1);
  assert.equal(segmentCost(catalog, 'work_order', 'open'), 'columns');
  assert.equal(segmentCost(catalog, 'work_order', 'north'), 'joins');
});

test('the views resolve over the segments, and the whole catalog keeps one that a reader does not', () => {
  const parsed = app();
  assert.deepEqual(
    Object.values(resolveViews(parsed, withRollups(parsed, schema))).flatMap((view) => ('error' in view && view.error ? [view.error] : [])),
    [],
  );
  const narrow: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      table.id === 'site' ? { ...table, columns: table.columns.filter((c) => c.name !== 'region') } : table,
    ),
  };
  assert.deepEqual(Object.keys(appCatalog(parsed, narrow).tables[1].segments!), ['open', 'overdue', 'north']);
  assert.deepEqual(Object.keys(withRollups(parsed, narrow).tables[1].segments!), ['open', 'overdue']);
});

/* ---------- served ---------- */

const identity = (role: string): Identity => ({ id: `account-${role}`, who: `${role}@example.test`, role });
const sessions: Record<string, Identity> = { manager: identity('manager'), clerk: identity('clerk'), crew: identity('crew') };

test('a served App: tabs and counts read segments, row policy narrows them, and a reader who may not read a column is served none', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-segments-'));
  const path = join(directory, 'works.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL);
    CREATE TABLE work_order (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), title TEXT, status TEXT, owner TEXT, due_on DATE, cost NUMERIC);
    INSERT INTO site VALUES (1, 'Dock', 'north'), (2, 'Yard', 'south');
    INSERT INTO work_order VALUES
      (1, 1, 'Pump', 'open', 'crew@example.test', '2025-06-01', 10),
      (2, 2, 'Gate', 'open', 'manager@example.test', '2027-01-01', 20),
      (3, 1, 'Roof', 'done', 'crew@example.test', '2025-01-01', 30),
      (4, 2, 'Fence', 'open', 'crew@example.test', '2025-02-01', 40);`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'works', name: 'Works', url: path, source: 'config', writable: false });
  const manifest = parseAppConfig(
    {
      id: 'works-app',
      name: 'Works',
      connection: 'works',
      resources: { site: {}, work_order: { segments: SEGMENTS } },
      auth: {
        providers: ['email'],
        defaultRole: 'clerk',
        roles: {
          manager: { read: true },
          // The clerk reads orders but not a site's region: no segment that reads it.
          clerk: { read: ['work_order', 'site'], fields: { site: { read: ['id', 'name'] } } },
          crew: { read: true },
        },
      },
      views: {
        orders: { kind: 'list', from: 'work_order', tabs: [{ label: 'All' }, 'open', 'overdue', 'north'] },
      },
      home: 'orders',
      nav: ['orders'],
    },
    'served',
  );
  const host: AppHost = {
    app: { path: '/works/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const post = async (who: string, route: string, body: unknown) => {
      const res = await fetch(`http://${bound.host}:${bound.port}${route}?app=works-app`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `session=${who}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const totals = async (who: string, items: string[]) => {
      const counted = await post(who, '/api/counts', { items });
      assert.equal(counted.status, 200, JSON.stringify(counted.body));
      return (counted.body.results as Array<{ total?: number; error?: unknown }>).map((result) => result.total ?? 'refused');
    };
    assert.deepEqual(
      await totals('manager', ['work_order', 'work_order open', 'work_order overdue', 'work_order north', 'work_order overdue and north']),
      [4, 3, 2, 2, 1],
    );
    // The clerk may not read a site's region, so "north" is no word of theirs.
    assert.deepEqual(await totals('clerk', ['work_order open', 'work_order north']), [3, 'refused']);

    const listed = await post('manager', '/api/run', { q: 'work_order overdue show title sort due_on', limit: 10 });
    assert.deepEqual(listed.body.rows, [{ title: 'Fence' }, { title: 'Pump' }]);

    const catalog = async (who: string) => {
      const res = await fetch(`http://${bound.host}:${bound.port}/api/schema?app=works-app`, { headers: { cookie: `session=${who}` } });
      return ((await res.json()) as DatabaseSchema).tables.find((table) => table.id === 'work_order')?.segments;
    };
    assert.deepEqual(Object.keys((await catalog('manager')) ?? {}), ['open', 'overdue', 'north']);
    assert.deepEqual(Object.keys((await catalog('clerk')) ?? {}), ['open', 'overdue']);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a row policy narrows a segment as it narrows any condition: the person’s own rows, and no more', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-segments-policy-'));
  const path = join(directory, 'works.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL, region TEXT NOT NULL);
    CREATE TABLE work_order (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), title TEXT, status TEXT, owner TEXT, due_on DATE, cost NUMERIC);
    INSERT INTO site VALUES (1, 'Dock', 'north'), (2, 'Yard', 'south');
    INSERT INTO work_order VALUES (1, 1, 'Pump', 'open', 'crew', '2025-06-01', 10), (2, 2, 'Gate', 'open', 'boss', '2025-01-01', 20),
      (3, 1, 'Roof', 'done', 'crew', '2025-01-01', 30);`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'works', name: 'Works', url: path, source: 'config', writable: false });
  const manifest = parseAppConfig(
    {
      id: 'works-policy',
      name: 'Works',
      connection: 'works',
      resources: { site: {}, work_order: { segments: SEGMENTS } },
      auth: { rows: 'policy', roles: { crew: { read: true } } },
      views: { orders: { kind: 'list', from: 'work_order', tabs: ['open', 'overdue'] } },
      home: 'orders',
      nav: ['orders'],
    },
    'policy',
  );
  const file = join(directory, 'policy.mjs');
  writeFileSync(
    file,
    `export default { appId: 'works-policy', resolveRows(principal) {
      return { site: true, work_order: { groups: [[{ column: 'owner', op: '=', value: principal.id }]] } };
    } };`,
  );
  const crew: Identity = { id: 'crew', who: 'crew@example.test', role: 'crew' };
  const policy = await loadHttpAppPolicy({ app: manifest, registry, file, verifySession: async () => crew });
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async () => crew,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [], policy });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const res = await fetch(`http://${bound.host}:${bound.port}/api/counts?app=works-policy`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app: 'works-policy',
        items: ['work_order open', 'work_order overdue', 'work_order open or due_on > 2000-01-01'],
      }),
    });
    const body = (await res.json()) as { results: Array<{ total: number }> };
    assert.equal(res.status, 200, JSON.stringify(body));
    // The boss's open, overdue order is no row of the crew's, through a segment or around one.
    assert.deepEqual(
      body.results.map((result) => result.total),
      [1, 1, 2],
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await policy.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
});

/* ---------- the App API and its MCP tools ---------- */

test('the App API offers a list the segments that read its exposed fields, by name, ANDed with every filter', async () => {
  const { planApiReadRequest } = await import('../packages/mistri/src/server/api/apiReadRequest.js');
  const { renderApiReadOpenApi } = await import('../packages/mistri/src/server/api/apiReadOpenApi.js');
  const exposed = parseAppConfig(
    {
      id: 'works-api',
      name: 'Works',
      resources: { site: {}, work_order: { segments: SEGMENTS } },
      auth: { roles: { reader: { read: true } } },
      home: 'orders',
      views: { orders: { kind: 'list', from: 'work_order', tabs: ['open'] } },
      api: {
        version: 1,
        roles: ['reader'],
        views: ['orders'],
        resources: { work_order: { fields: ['id', 'title', 'status', 'due_on'], filters: ['status'], sorts: ['id'] } },
      },
    },
    'api',
  );
  const options = { integers: 'decimal-string' as const };
  const plan = planApiReadRequest(
    exposed,
    schema,
    'list:work_order',
    'segment=overdue&status=open',
    options,
    undefined,
    new Date('2026-06-01'),
  );
  assert.equal(plan.segment, 'overdue');
  assert.deepEqual(JSON.parse(JSON.stringify(plan.standingFilter)), {
    groups: [
      [
        { path: 'status', op: '=', value: 'open' },
        { path: 'due_on', op: '<', value: '2026-01-01' },
      ],
    ],
  });
  assert.equal(plan.filters.length, 1);
  // "north" reads a site's region, through a reference the list does not expose: no segment of the API's.
  assert.throws(
    () => planApiReadRequest(exposed, schema, 'list:work_order', 'segment=north', options),
    /segment is not one this list offers/,
  );
  assert.throws(
    () => planApiReadRequest(exposed, schema, 'list:work_order', 'segment=nope', options),
    /segment is not one this list offers/,
  );
  const document = renderApiReadOpenApi(exposed, schema, options).document as unknown as {
    paths: Record<string, { get: { parameters: Array<{ name: string; schema: { enum?: string[] } }> } }>;
  };
  const segment = document.paths['/work_order'].get.parameters.find((parameter) => parameter.name === 'segment');
  assert.deepEqual(segment?.schema.enum, ['open', 'overdue']);
});

test('the App API never offers or reads a segment about `me`: it reads no person, and `owner != me` unread is every row', async () => {
  const { planApiReadRequest } = await import('../packages/mistri/src/server/api/apiReadRequest.js');
  const { renderApiReadOpenApi } = await import('../packages/mistri/src/server/api/apiReadOpenApi.js');
  const { checkApiReadCatalog } = await import('../packages/mistri/src/server/api/apiReadCatalog.js');
  const exposed = parseAppConfig(
    {
      id: 'works-api',
      name: 'Works',
      resources: {
        site: {},
        work_order: { segments: { ...SEGMENTS, mine: 'owner = me', not_mine: 'owner != me', my_open: 'open and mine' } },
      },
      auth: { roles: { reader: { read: true } } },
      home: 'orders',
      views: { orders: { kind: 'list', from: 'work_order', tabs: ['open'] } },
      api: {
        version: 1,
        roles: ['reader'],
        views: ['orders'],
        resources: { work_order: { fields: ['id', 'title', 'status', 'owner', 'due_on'], filters: ['status'], sorts: ['id'] } },
      },
    },
    'api',
  );
  const options = { integers: 'decimal-string' as const };
  const document = renderApiReadOpenApi(exposed, schema, options).document as unknown as {
    paths: Record<string, { get: { parameters: Array<{ name: string; schema: { enum?: string[] } }> } }>;
  };
  const segment = document.paths['/work_order'].get.parameters.find((parameter) => parameter.name === 'segment');
  assert.deepEqual(segment?.schema.enum, ['open', 'overdue']);
  for (const name of ['mine', 'not_mine', 'my_open'])
    assert.throws(
      () => planApiReadRequest(exposed, schema, 'list:work_order', `segment=${name}`, options),
      /segment is not one this list offers/,
    );
  /* Even where a catalog handed in offers one, the read refuses it rather than compare with the text "me". */
  const catalog = checkApiReadCatalog(exposed.api!, exposed, schema);
  const widened = {
    ...catalog,
    operations: catalog.operations.map((operation) =>
      operation.kind === 'list' ? { ...operation, segments: [...(operation.segments ?? []), 'not_mine'] } : operation,
    ),
  } as typeof catalog;
  assert.throws(
    () => planApiReadRequest(exposed, schema, 'list:work_order', 'segment=not_mine', options, widened),
    /segment is not one this list offers/,
  );
});

/* A board and a menu row read a segment exactly as the same conditions written inline: `--fix` and the
   repeated-query lint steer an App from one to the other, so nothing the App draws may change on the way. */
test('a list over a segment draws the lanes and the menu count the same conditions inline draw', async () => {
  const { roomReads } = await import('../packages/mistri/src/server/http/firstPaintRooms.js');
  const { servedApp } = await import('../packages/mistri/src/shared/appPayload.js');
  const { menuCount } = await import('../packages/engine/src/shared/menuCounts.js');
  const machine = {
    column: 'status',
    states: {
      received: { on: { start: 'on_bench' } },
      on_bench: { on: { finish: 'ready' } },
      ready: { on: { collect: 'collected' } },
      collected: { final: true },
    },
  };
  const shop = (query: string, sectionQuery: Record<string, string>) =>
    parseAppConfig(
      {
        id: 'shop',
        name: 'Shop',
        resources: {
          site: {},
          work_order: { access: 'write', machine, segments: { open: 'status is open', mine: 'owner = me', due: 'due_on <= today' } },
        },
        views: {
          orders: { kind: 'list', from: 'work_order', query, board: { by: 'status' } },
          bench: { kind: 'dashboard', label: 'Bench', sections: [{ kind: 'board', from: 'work_order', by: 'status', ...sectionQuery }] },
          mine: { kind: 'list', from: 'work_order', query: query === 'open' ? 'mine' : 'owner = me' },
          late: { kind: 'list', from: 'work_order', query: query === 'open' ? 'due' : 'due_on <= today' },
        },
        home: 'orders',
        nav: ['orders', 'bench', 'mine', 'late'],
        ui: { shell: { counts: true } },
        auth: { providers: ['email'], roles: { crew: { read: true } }, defaultRole: 'crew' },
      },
      'shop',
    );
  const read = (app: ReturnType<typeof parseAppConfig>) => {
    const catalog = appCatalog(app, schema);
    const payload = servedApp(app, catalog);
    const views = payload.views as unknown as Record<
      string,
      { presentation?: { lanes?: string[] }; sections?: Array<{ lanes?: string[] }> }
    >;
    const table = catalog.tables.find((each) => each.id === 'work_order')!;
    const machineOf = (payload as unknown as { resources: Record<string, { machine?: Parameters<typeof menuCount>[1] }> }).resources
      .work_order.machine;
    const plan = roomReads({ app: 'shop', path: '/shop', search: '', payload, schema: catalog, pages: {}, me: {}, visitor: false });
    const counted = plan.batches.find((batch) => batch.kind === 'count')?.items.length ?? 0;
    return {
      lanes: views.orders.presentation?.lanes,
      sectionLanes: views.bench.sections?.[0]?.lanes,
      menu: ['orders', 'mine', 'late'].map((key) => {
        const query = (payload.views as unknown as Record<string, { query?: string }>)[key].query ?? '';
        return menuCount(query, machineOf, undefined, table.segments);
      }),
      counted,
    };
  };
  const inline = read(shop('status is open', { query: 'status is open' }));
  const named = read(shop('open', { segment: 'open' }));
  assert.deepEqual(inline.lanes, ['received', 'on_bench', 'ready'], 'a final state the query excludes is no lane');
  assert.deepEqual(inline.sectionLanes, ['received', 'on_bench', 'ready']);
  assert.deepEqual(
    inline.menu.map((row) => row.counted),
    [true, true, true],
  );
  assert.equal(inline.counted, 3);
  assert.deepEqual(named, inline);
});

test('a window inside a segment is the section’s own window, as it is written inline', () => {
  const shop = (section: Record<string, string>) =>
    parseAppConfig(
      {
        name: 'Shop',
        resources: { site: {}, work_order: { segments: { recent: 'status = open and due_on = last 90 days', open: 'status = open' } } },
        views: {
          board: {
            kind: 'dashboard',
            label: 'Board',
            sections: [{ kind: 'metric', title: 'Due', from: 'work_order', over: 'due_on', compare: 'previous period', ...section }],
          },
        },
        home: 'board',
        nav: ['board'],
      },
      'shop',
    );
  const served = (section: Record<string, string>) => {
    const app = shop(section);
    const catalog = appCatalog(app, schema);
    const board = resolveViews(app, catalog).board as unknown as { error?: string; sections: Array<Record<string, unknown>> };
    const base = parseViewQuery(catalog, 'work_order', String(board.sections[0].windowBase));
    assert.deepEqual(base.errors, []);
    return { windowBase: base.filter, comparePeriod: board.sections[0].comparePeriod, error: board.error };
  };
  const inline = served({ query: 'status = open and due_on = last 90 days' });
  assert.equal(inline.comparePeriod, true);
  assert.deepEqual(served({ segment: 'recent' }), inline);
  assert.deepEqual(served({ query: 'open and due_on = last 90 days' }), inline);
});

/* ---------- check --design ---------- */

test('a query written twice over one resource is a design warning, and --fix names it as a segment', async () => {
  const { designLint } = await import('../packages/mistri/src/server/app/designLint.js');
  const { fixRepeatedQueries } = await import('../packages/mistri/src/server/build/checkFix.js');
  const source = `export const resources = {
  site: {},
  work_order: { rollups: {} },
};
export const views = {
  waiting: { kind: 'list', from: 'work_order', query: 'status = waiting' },
  stuck: { kind: 'list', from: 'work_order', query:  'status = waiting',  show: ['title'] },
  mine: { kind: 'list', from: 'work_order', query: 'owner = ann' },
};
`;
  const authored = parseAppConfig(
    {
      name: 'Works',
      resources: { site: {}, work_order: { rollups: {} } },
      views: {
        waiting: { kind: 'list', from: 'work_order', query: 'status = waiting' },
        stuck: { kind: 'list', from: 'work_order', query: 'status = waiting', show: ['title'] },
        mine: { kind: 'list', from: 'work_order', query: 'owner = ann' },
      },
      home: 'waiting',
      nav: ['waiting'],
    },
    'repeated',
  );
  const findings = designLint(authored, [], schema).filter((finding) => finding.code === 'repeated-query');
  assert.equal(findings.length, 1);
  assert.equal(findings[0].at, 'resource "work_order"');
  assert.match(
    findings[0].text,
    /'status = waiting' is written in 2 places \(view "waiting"; view "stuck"\).*segments: \{ waiting: 'status = waiting' \}/,
  );
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-segments-fix-'));
  try {
    writeFileSync(join(directory, 'app.ts'), source);
    const { fixed, left } = fixRepeatedQueries(authored, schema, directory);
    assert.deepEqual(left, []);
    assert.deepEqual(fixed, [`app.ts: resources "work_order": the query 'status = waiting': named "waiting" in 2 places`]);
    const { readFileSync } = await import('node:fs');
    const after = readFileSync(join(directory, 'app.ts'), 'utf8');
    assert.match(after, /work_order: \{ segments: \{ waiting: 'status = waiting' \}, rollups: \{\} \}/);
    assert.equal(after.match(/query: 'waiting'/g)?.length, 2);
    assert.match(after, /query: 'owner = ann'/);
    // A resource written over lines takes the segment on a line of its own, at its properties' indent.
    writeFileSync(join(directory, 'app.ts'), source.replace('work_order: { rollups: {} },', 'work_order: {\n    rollups: {},\n  },'));
    fixRepeatedQueries(authored, schema, directory);
    assert.match(
      readFileSync(join(directory, 'app.ts'), 'utf8'),
      /work_order: \{\n {4}segments: \{ waiting: 'status = waiting' \},\n {4}rollups: \{\},\n {2}\},/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  /* The same words over another table are another query: a reference to a site, a count of sites, and a view
     of sites keep theirs, and the two over work orders are still found and named. */
  const elsewhere = mkdtempSync(join(tmpdir(), 'tablewalk-segments-fix-'));
  try {
    writeFileSync(
      join(elsewhere, 'app.ts'),
      source.replace('site: {},', "site: { rollups: { waiting: count('site', { query: 'status = waiting' }) } },"),
    );
    writeFileSync(
      join(elsewhere, 'commands.ts'),
      `export const input = { site: field.reference('site', { by: 'id', query: 'status = waiting' }) };
export const more = { sites: { kind: 'list', table: 'site', query: 'status = waiting' } };
`,
    );
    const { fixed, left } = fixRepeatedQueries(authored, schema, elsewhere);
    assert.deepEqual(left, []);
    assert.deepEqual(fixed, [`app.ts: resources "work_order": the query 'status = waiting': named "waiting" in 2 places`]);
    const { readFileSync } = await import('node:fs');
    const app = readFileSync(join(elsewhere, 'app.ts'), 'utf8');
    assert.equal(app.match(/query: 'waiting'/g)?.length, 2);
    assert.match(app, /count\('site', \{ query: 'status = waiting' \}\)/);
    assert.equal(readFileSync(join(elsewhere, 'commands.ts'), 'utf8').match(/query: 'status = waiting'/g)?.length, 2);
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
  // Declared already: the warning names the segment, and nothing is added.
  const declared = parseAppConfig(
    {
      name: 'Works',
      resources: { site: {}, work_order: { segments: { waiting: 'status = waiting' } } },
      views: {
        waiting: { kind: 'list', from: 'work_order', query: 'status = waiting' },
        stuck: { kind: 'list', from: 'work_order', query: 'status = waiting' },
      },
      home: 'waiting',
      nav: ['waiting'],
    },
    'repeated, declared',
  );
  const named = designLint(declared, [], schema).find((finding) => finding.code === 'repeated-query');
  assert.match(named!.text, /it is the segment 'waiting': say 'waiting' in each place/);
});

test('every colliding segment is told at once, with the words or the column that collide and a safe name', () => {
  const parsed = parseAppConfig(
    {
      name: 'Works',
      resources: { site: {}, work_order: { segments: { today: 'due_on = today', status: 'status = open', fine: 'status = done' } } },
      views: { orders: { kind: 'list', from: 'work_order' } },
      home: 'orders',
      nav: ['orders'],
    },
    'x',
  );
  const found = segmentProblems(parsed, appCatalog(parsed, schema));
  assert.equal(found.length, 2, found.join('\n'));
  assert.match(found[0], /today_only: \{ query: "due_on = today", label: "Today" \}/, 'the label form keeps the words people read');
  assert.match(found[0], /keep the words people read in its label/);
  assert.match(found[0], /Words the language reads, never a segment's name: and, or, not/);
  assert.match(found[1], /the column "status" of work_order.*status_only: \{ query: "status = open", label: "Status" \}/);
});

test('tabs that write their own query are all told at once, a language word renamed', () => {
  assert.throws(
    () =>
      app(
        {},
        {
          views: {
            orders: {
              kind: 'list',
              from: 'work_order',
              tabs: [
                { label: 'Today', query: 'due_on = today' },
                { label: 'Waiting on parts', query: 'status = waiting' },
              ],
            },
          },
        },
      ),
    (error: Error) =>
      /tab 1 writes its own "query"[^\n]*\{ today_only:[^\n]*label: "Today"[^\n]*"today" is a word of the query language[^\n]*\n[^\n]*tab 2 writes[^\n]*waiting_on_parts/.test(
        error.message,
      ),
  );
});
