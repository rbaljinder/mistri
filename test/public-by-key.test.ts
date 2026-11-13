/**
 * `auth.public.byKey` in an ordinary App (server/app/publicByKey.ts): of what the public grant reads, a table a
 * signed-out visitor opens one record at a time by its key and never lists. The tenant lane has the same table of
 * cases (tenant-public-reads.test.ts); this one walks the ordinary gate's routes (http/gate.ts), and a route added
 * there without a case here fails the test.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { byKeyAdapter } from '../packages/mistri/src/server/app/publicByKey.js';
import { publicFormProblems } from '../packages/mistri/src/server/forms/savedFormChecks.js';
import { defineCommand, defineCommands, type BusinessCommandRegistry } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { PUBLIC_GETS, PUBLIC_POSTS } from '../packages/mistri/src/server/http/gate.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

/* Vehicles a visitor opens by the link a dealer sends, one at a time; dealers anyone may browse. */
const appId = 'lot';
const owner = 'lot-db';
const APP = {
  id: appId,
  name: 'Lot',
  connection: owner,
  resources: {
    vehicle: { access: 'write', file: { content: 'data', name: 'file_name', type: 'content_type' } },
    dealer: {},
    /* A row named by two columns: a visitor holds a bay's key only as the pair, never as a dealer alone. */
    bay: {},
  },
  auth: {
    roles: { staff: { read: true, write: ['vehicle'] } },
    public: { read: ['vehicle', 'dealer', 'bay'], byKey: ['vehicle', 'bay'] },
  },
  views: {
    dealers: { kind: 'list', from: 'dealer', label: 'Dealers' },
    vehicles: { kind: 'list', from: 'vehicle', label: 'Vehicles', roles: ['staff'] },
  },
  home: [{ view: 'dealers', signedOut: true }, { view: 'vehicles' }],
  nav: ['dealers', 'vehicles'],
};
/* A vehicle's parent is another vehicle (a self reference): a key to one is no key to the other. */
const SQL = `CREATE TABLE dealer (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE vehicle (id INTEGER PRIMARY KEY, make TEXT NOT NULL, dealer_id INTEGER REFERENCES dealer(id),
    file_name TEXT, content_type TEXT, data BLOB, parent_id INTEGER REFERENCES vehicle(id));
  CREATE TABLE bay (dealer_id INTEGER NOT NULL REFERENCES dealer(id), slot TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY (dealer_id, slot));
  CREATE TABLE inquiry (id INTEGER PRIMARY KEY, vehicle_id INTEGER NOT NULL);
  INSERT INTO dealer VALUES (1, 'North Motors');
  INSERT INTO vehicle VALUES (1, 'Toyota', 1, 'toyota.txt', 'text/plain', CAST('Toyota bytes' AS BLOB), 2),
    (2, 'Honda', 1, 'honda.txt', 'text/plain', CAST('Honda bytes' AS BLOB), NULL),
    (3, 'Subaru', 1, 'subaru.txt', 'text/plain', CAST('Subaru bytes' AS BLOB), NULL);
  INSERT INTO bay VALUES (1, 'A', 'Bay Alpha'), (1, 'B', 'Bay Bravo');`;

type Answer = { status: number; text: string; body: any };

async function serve(t: TestContext, options: { definition?: AppDef; commands?: BusinessCommandRegistry } = {}) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'mistri-public-by-key-'));
  const file = join(directory, 'lot.db');
  const db = new DatabaseSync(file);
  db.exec(SQL);
  db.close();
  if (options.commands) migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Lot', url: file, source: 'config', writable: true });
  const definition = options.definition ?? parseAppConfig(APP, 'lot fixture');
  const pages = parsePagesConfig({ pages: [] }, 'lot pages');
  const host: AppHost = {
    app: { path: 'lot-fixture.ts', app: definition, pages, sources: {} },
    pages,
    auth: { spec: definition.auth!, store: 'not-used', handler: async () => {}, close: async () => {}, session: async () => null },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    pages,
    ...(options.commands ? { commands: { appId, registry: options.commands } } : {}),
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  t.after(async () => {
    server.close();
    server.closeAllConnections();
    await registry.closeAll?.();
    rmSync(directory, { recursive: true, force: true });
    resetPublicFormLimits();
  });
  const origin = `http://${bound.host}:${bound.port}`;
  const call = async (path: string, body?: object): Promise<Answer> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    const response = await fetch(`${origin}${path}`, {
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify({ app: appId, ...body }) } : {}),
    });
    let text = '';
    if (response.headers.get('content-type')?.startsWith('text/event-stream')) {
      /* The live stream stays open: what it says before the first wait is what it says to a visitor at once. */
      const reader = response.body!.getReader();
      const first = await reader.read();
      text = new TextDecoder().decode(first.value);
      controller.abort();
    } else text = await response.text();
    clearTimeout(timer);
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: response.status, text, body: parsed };
  };
  return Object.assign(call, { registry });
}

const makes = /Toyota|Honda|Subaru/g;
/* Every row's words, of every byKey table: what a listing would say. */
const rowWords = /Toyota|Honda|Subaru|Bay Alpha|Bay Bravo/g;
const rows = (answer: Answer): Array<Record<string, unknown>> => answer.body?.rows ?? [];
/* Exactly the record asked for by its key, and nothing of another. */
const one = (answer: Answer) => {
  assert.equal(answer.status, 200, answer.text);
  assert.deepEqual(
    rows(answer).map((row) => row.id),
    [1],
  );
  assert.deepEqual([...new Set(answer.text.match(makes))], ['Toyota']);
};
/* What a visitor is told of a read it may not make: the gate's one refusal, a 403 with this body, and no row beside
   it. A 200 that carries errors, or any other status, is not this refusal and fails here. */
const refused = (answer: Answer) => {
  assert.equal(answer.status, 403, answer.text);
  assert.deepEqual(answer.body, { error: 'Access to this resource is denied.', code: 'forbidden' });
  assert.doesNotMatch(answer.text, rowWords);
};
/* A file read that does not name a record by its whole key is a bad request before it is a grant's to judge. */
const unkeyed = (answer: Answer) => {
  assert.equal(answer.status, 400, answer.text);
  assert.deepEqual(answer.body, { error: 'A file is named by its record key.' });
};
/* What lists no vehicle or bay: the App, its catalog and pages say tables and columns, never a make or a note. */
const unlisted = (answer: Answer) => assert.doesNotMatch(answer.text, rowWords);
/* A record page's own plan reads the record by its key; whatever it lists beside it must not be another vehicle. */
const onlyItsOwn = (answer: Answer) => assert.doesNotMatch(answer.text, /Honda|Subaru/);

test('a byKey table answers every visitor door of the ordinary gate with a refusal or one row by its key', async (t) => {
  const call = await serve(t);
  const vehicleKey = { groups: [[{ column: 'id', op: '=', value: 1 }]] };
  const noCard = (answer: Answer) => {
    assert.equal(answer.status, 404, answer.text);
    assert.equal(answer.text, 'No card here.\n');
  };
  const bayKey = {
    groups: [
      [
        { column: 'dealer_id', op: '=', value: 1 },
        { column: 'slot', op: '=', value: 'A' },
      ],
    ],
  };
  const oneBay = (answer: Answer) => {
    assert.equal(answer.status, 200, answer.text);
    assert.equal(rows(answer).length, 1, answer.text);
    assert.deepEqual([...new Set(answer.text.match(rowWords))], ['Bay Alpha']);
  };
  const similar = {
    page: {
      id: 'like',
      name: 'Like',
      base: 'vehicle',
      sections: [{ kind: 'list', from: 'vehicle', path: '', similar: { same: ['dealer_id'] }, columns: ['id', 'make'] }],
    },
    key: { id: 1 },
  };
  const file = (key: object) => `?${new URLSearchParams({ app: appId, table: 'vehicle', key: JSON.stringify(key), inline: '1' })}`;
  const cases: Array<[string, string | object | undefined, (answer: Answer) => void]> = [
    ['/api/app', `?app=${appId}`, unlisted],
    ['/api/schema', `?app=${appId}`, unlisted],
    ['/api/pages', `?app=${appId}`, unlisted],
    ['/api/pages/suggested', `?app=${appId}&table=vehicle`, unlisted],
    ['/api/runtime', `?app=${appId}`, unlisted],
    ['/api/live', `?app=${appId}`, unlisted],
    ['/api/file', file({ id: 1 }), (answer) => assert.equal(answer.text, 'Toyota bytes', `${answer.status} ${answer.text}`)],
    ['/api/file', file({ make: 'Honda' }), unkeyed],
    ['/api/query', { table: 'vehicle', filter: vehicleKey, limit: 1 }, one],
    ['/api/query', { table: 'vehicle' }, refused],
    ['/api/query', { table: 'vehicle', filter: vehicleKey }, refused],
    ['/api/query', { table: 'vehicle', filter: { groups: [[{ column: 'dealer_id', op: '=', value: 1 }]] }, limit: 1 }, refused],
    /* The key is one group of `=`: an OR of two keys, several values for the key, a later page and a longer page each name
       more than the record asked for, even where the first row alone would be the right one. */
    [
      '/api/query',
      { table: 'vehicle', filter: { groups: [[{ column: 'id', op: '=', value: 1 }], [{ column: 'id', op: '=', value: 2 }]] }, limit: 1 },
      refused,
    ],
    ['/api/query', { table: 'vehicle', filter: { groups: [[{ column: 'id', op: 'in', value: [1, 2, 3] }]] }, limit: 1 }, refused],
    ['/api/query', { table: 'vehicle', filter: vehicleKey, limit: 1, offset: 1 }, refused],
    ['/api/query', { table: 'vehicle', filter: vehicleKey, limit: 2 }, refused],
    /* A bay's key is the pair: the pair opens one bay, and a part of it (the dealer's, or the slot's) lists several. */
    ['/api/query', { table: 'bay', filter: bayKey, limit: 1 }, oneBay],
    ['/api/query', { table: 'bay', filter: { groups: [[{ column: 'dealer_id', op: '=', value: 1 }]] }, limit: 1 }, refused],
    ['/api/query', { table: 'bay', filter: { groups: [[{ column: 'slot', op: '=', value: 'A' }]] }, limit: 1 }, refused],
    /* A dealer is a listing table: its rows read, and a hop to its vehicles is refused. */
    ['/api/query', { table: 'dealer' }, (answer) => assert.equal(answer.status, 200, answer.text)],
    ['/api/count', { table: 'vehicle', filter: vehicleKey }, refused],
    ['/api/counts', { items: ['vehicle id = 1'] }, refused],
    ['/api/run', { q: 'vehicle id = 1', limit: 1, offset: 0 }, refused],
    ['/api/view/run', { text: 'vehicle id = 1 show id, make' }, refused],
    [
      '/api/view/run',
      {
        count: 'none',
        view: {
          base: 'vehicle',
          columns: [{ path: 'id' }, { path: 'make' }],
          filter: { groups: [[{ path: 'id', op: '=', value: 1 }]] },
          limit: 1,
        },
      },
      one,
    ],
    ['/api/view/run', { count: 'none', view: { base: 'vehicle', columns: [{ path: 'id' }, { path: 'make' }], limit: 50 } }, refused],
    /* A vehicle's own reference to a dealer reads as it would; its reference to another vehicle (a self hop, the parent's
       make) reaches a row the visitor holds no key to. */
    [
      '/api/view/run',
      {
        count: 'none',
        view: {
          base: 'vehicle',
          columns: [{ path: 'id' }, { path: 'dealer_id.name' }],
          filter: { groups: [[{ path: 'id', op: '=', value: 1 }]] },
          limit: 1,
        },
      },
      (answer) => {
        assert.equal(answer.status, 200, answer.text);
        assert.match(answer.text, /North Motors/);
        assert.doesNotMatch(answer.text, /Honda/);
      },
    ],
    [
      '/api/view/run',
      {
        count: 'none',
        view: {
          base: 'vehicle',
          columns: [{ path: 'id' }, { path: 'parent_id.make' }],
          filter: { groups: [[{ path: 'id', op: '=', value: 1 }]] },
          limit: 1,
        },
      },
      refused,
    ],
    [
      '/api/view/run',
      {
        count: 'none',
        view: {
          base: 'vehicle',
          columns: [{ path: 'id' }],
          filter: { groups: [[{ path: 'id', op: '=', value: 1 }]] },
          orderBy: [{ path: 'parent_id.make', direction: 'asc' }],
          limit: 1,
        },
      },
      refused,
    ],
    ['/api/breakdown', { text: 'vehicle count by make' }, refused],
    ['/api/breakdowns', { items: [{ text: 'vehicle count by make' }] }, refused],
    /* A dealer's references count its vehicles and bays: that count says something of rows the visitor holds no key to. */
    [
      '/api/references',
      { table: 'dealer', key: { id: 1 } },
      (answer) => {
        unlisted(answer);
        const toKeyed = (answer.body?.references ?? []).filter((reference: { table: string }) =>
          ['vehicle', 'bay'].includes(reference.table),
        );
        assert.ok(toKeyed.length > 0 || answer.status !== 200, answer.text);
        for (const reference of toKeyed) assert.ok(reference.error && !(reference.count >= 0), answer.text);
      },
    ],
    ['/api/pages/plan', similar, onlyItsOwn],
    ['/api/pages/compose', similar, onlyItsOwn],
    ['/api/pages/load', { page: 'nothing', params: {} }, unlisted],
    /* The routes a visitor reads that are not the API's own. The sitemap lists what a visitor may list, so no byKey row is
       in it, and it is still served; a share card and a page's server-rendered head are drawn from the head the page
       would have, which reads a record only through this same adapter. */
    [
      '/sitemap.xml',
      '',
      (answer) => {
        assert.equal(answer.status, 200, answer.text);
        assert.match(answer.text, /<loc>[^<]*\/dealers\/1<\/loc>/);
        assert.doesNotMatch(answer.text, /\/vehicles|\/bays/);
      },
    ],
    ['/api/og', '?path=%2Fvehicles%2F1', noCard],
    ['/api/og', '?path=%2Fvehicles', noCard],
    ['/api/og', '?path=%2Fbays%2F1%2FA', noCard],
    ['/vehicles/1', '', onlyItsOwn],
    ['/vehicles', '', unlisted],
    ['/bays/1/A', '', unlisted],
    /* Not in this list, and why: a public form's choices (`GET /api/forms/<key>`) need a command host, so a test below
       serves one; a capability link (`/l/<id>`) is its own grant on the one row it was minted on, read by that
       row's whole key and never through `auth.public` (links/linkRoutes.ts), which row-policy-links.test.ts holds to. */
  ];
  const routes = new Set(cases.map(([path]) => path));
  assert.deepEqual(
    [...PUBLIC_GETS, ...PUBLIC_POSTS].filter((path) => !routes.has(path)),
    [],
    'every route a visitor reads by has a case here',
  );
  for (const [path, request, expect] of cases) {
    const answer = typeof request === 'string' || request === undefined ? await call(`${path}${request ?? ''}`) : await call(path, request);
    await t.test(`${path} ${typeof request === 'string' ? request : JSON.stringify(request)}`, () => expect(answer));
  }
});

test('check refuses a byKey table outside "read", a roles-less list of one, and a public page that reads one', () => {
  const auth = (pub: unknown) => ({ ...APP, auth: { ...APP.auth, public: pub } });
  assert.throws(() => parseAppConfig(auth({ read: ['dealer'], byKey: ['vehicle'] }), 'lot'), /byKey/);
  assert.throws(
    () => parseAppConfig({ ...APP, views: { ...APP.views, vehicles: { kind: 'list', from: 'vehicle', label: 'Vehicles' } } }, 'lot'),
    /lists "vehicle", which auth\.public opens to signed-out visitors only by a record's key \("byKey"\), and names no "roles"/,
  );
  const page = (reads: string[]) => ({
    kind: 'page',
    label: 'Lobby',
    component: { id: 'page-lobby', module: './pages/lobby.page.tsx', kind: 'page' },
    reads,
    public: true,
  });
  assert.doesNotThrow(() => parseAppConfig({ ...APP, views: { ...APP.views, lobby: page(['dealer']) } }, 'lot'));
  assert.throws(
    () => parseAppConfig({ ...APP, views: { ...APP.views, lobby: page(['dealer', 'vehicle']) } }, 'lot'),
    /\[page-public\] .* is public and reads "vehicle", which "auth\.public" opens only by a record's key/,
  );
  const report = authorityReport(parseAppConfig(APP, 'lot'));
  assert.match(report, /^public byKey vehicle /m);
  assert.match(report, /^public read vehicle /m);
});

test('the adapter a visitor reads through carries no transaction and no write, and reads a byKey table only by its key', async (t) => {
  const call = await serve(t);
  const { adapter } = await call.registry.open(owner);
  assert.equal(typeof adapter.transaction, 'function', 'the database offers a transaction, so its absence below is the fence');
  const schema = await adapter.introspect();
  const visitor = byKeyAdapter(
    adapter,
    schema,
    { readable: new Set(['vehicle', 'dealer', 'bay']), writable: new Set() },
    new Set(['vehicle', 'bay']),
  );
  for (const method of ['transaction', 'insert', 'update', 'remove'] as const) assert.equal(visitor[method], undefined, method);
  const key = { groups: [[{ column: 'id', op: '=' as const, value: 1 }]] };
  assert.deepEqual((await visitor.query({ table: 'vehicle', columns: ['id', 'make'], filter: key, limit: 1, offset: 0 })).rows, [
    { id: 1, make: 'Toyota' },
  ]);
  await assert.rejects(async () => visitor.query({ table: 'vehicle', columns: ['id'], limit: 1, offset: 0 }), /denied/);
});

test('a public form offers no choices from a byKey table', async (t) => {
  const input = { vehicle: { label: 'Vehicle', type: 'choice', from: 'vehicle', labelColumn: 'make' } };
  const { connection: _connection, ...rest } = APP;
  const definition = parseTestApp(
    {
      ...rest,
      sources: { main: { connection: owner } },
      resources: { ...APP.resources, inquiry: { access: 'write' } },
      views: { ...APP.views, ask: { kind: 'form', label: 'Ask', public: true, done: { title: 'Thanks' }, command: 'ask' } },
    },
    'lot form fixture',
    { ask: { public: true, input } },
  );
  const commands = defineCommands({
    ask: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'inquiry',
      read: ['vehicle', 'inquiry'],
      write: ['inquiry'],
      public: true,
      input: input as never,
      output: shape({ reference: text() }),
      async handle() {
        return { reference: 'ASK-1' };
      },
    }),
  });
  const call = await serve(t, { definition, commands });
  const form = await call('/api/forms/ask');
  assert.equal(form.status, 200, form.text);
  assert.deepEqual(form.body.form.input[0].options ?? [], [], 'no row of the table is served with the form');
  assert.doesNotMatch(form.text, rowWords);
  /* The page's own read of the choices is the fenced one, and it is refused. */
  refused(
    await call('/api/query', {
      table: 'vehicle',
      columns: ['id', 'make'],
      orderBy: [{ column: 'make', direction: 'asc' }],
      limit: 101,
      offset: 0,
    }),
  );
});

test('check refuses a public form whose picker or choice lists a byKey table, by name; a table the public lists is served', async (t) => {
  const call = await serve(t);
  const { adapter } = await call.registry.open(owner);
  const schema = await adapter.introspect();
  const form = (input: Record<string, unknown>) => {
    const { connection: _connection, ...rest } = APP;
    const definition = parseTestApp(
      {
        ...rest,
        sources: { main: { connection: owner } },
        resources: { ...APP.resources, inquiry: { access: 'write' } },
        views: { ...APP.views, ask: { kind: 'form', label: 'Ask', public: true, done: { title: 'Thanks' }, command: 'ask' } },
      },
      'lot picker fixture',
      { ask: { public: true, input } },
    );
    const commands = defineCommands({
      ask: defineCommand({
        targets: 'none',
        source: 'main',
        target: 'inquiry',
        read: ['vehicle', 'dealer', 'inquiry'],
        write: ['inquiry'],
        public: true,
        input: input as never,
        output: shape({ reference: text() }),
        async handle() {
          return { reference: 'ASK-1' };
        },
      }),
    });
    return publicFormProblems(definition, commands, schema);
  };
  assert.match(
    form({ vehicle: { label: 'Vehicle', type: 'reference', from: 'vehicle', by: 'id', labelColumn: 'make' } }) ?? '',
    /Form "ask": Command "ask" input "vehicle" \[public-form-picker\] is a picker over "vehicle" on a public form, and "auth.public.byKey" opens "vehicle" only one record at a time by its key, never as a list/,
  );
  assert.match(
    form({ vehicle: { label: 'Vehicle', type: 'choice', from: 'vehicle', labelColumn: 'make' } }) ?? '',
    /\[public-form-picker\] offers the rows over "vehicle" on a public form, and "auth.public.byKey" opens "vehicle" only one record at a time/,
  );
  assert.equal(form({ dealer: { label: 'Dealer', type: 'reference', from: 'dealer', by: 'id', labelColumn: 'name' } }), undefined);
});
