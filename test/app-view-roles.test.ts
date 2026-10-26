/**
 * `roles` on a view or a page: who may open it, beside the table grants.
 * A service desk's employee reads their own tickets, so by table alone they
 * "could read" the agents' queue over the same table, and met it in the
 * menu with nothing in it. Here the queue names its roles, and the server
 * takes it out of everything an employee is served — the views, the menu,
 * the address book, the pages, a dashboard's feed, the API's operations —
 * the way a view that does not exist is absent; an agent keeps it all.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { appAddressBook, readAppSegments } from '../packages/mistri/src/shared/appAddress.js';
import { viewOrder } from '../packages/mistri/src/shared/appModel.js';
import { appForRoles } from '../packages/mistri/src/shared/appViewRoles.js';
import type { PageDef } from '../packages/engine/src/shared/page.js';
import type { ColumnMeta, DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { projectTenantMetadata } from '../packages/mistri/src/server/tenant/tenantMetadata.js';
import { readRecordActivityFor } from '../packages/mistri/src/server/recordActivity.js';
import { AppAccessDenied } from '../packages/mistri/src/server/app/appAccess.js';
import type { Adapter } from '../packages/engine/src/adapters/adapter.js';
import { parseTestApp } from './support/commandCatalog.js';

const manifest = {
  id: 'desk',
  name: 'Desk',
  connection: 'desk-db',
  resources: { ticket: {} },
  auth: { roles: { agent: { read: true }, employee: { read: true }, lead: { read: true } } },
  views: {
    mine: { kind: 'list', label: 'My tickets', from: 'ticket' },
    queue: { kind: 'list', label: 'Agent queue', from: 'ticket', roles: ['agent', 'lead'] },
    floor: { kind: 'dashboard', label: 'Floor', roles: ['agent'], sections: [{ kind: 'metric', title: 'Open', from: 'ticket' }] },
  },
  pages: {
    ticket: { base: 'ticket', sections: [{ kind: 'fields', show: ['name'] }] },
    triage: { base: 'ticket', path: 'triage', roles: ['agent'], sections: [{ kind: 'fields', show: ['name', 'status'] }] },
  },
  home: [{ view: 'queue', roles: ['agent'] }, { view: 'mine' }],
  nav: ['mine', { id: 'work', label: 'Work', children: ['queue', 'floor'] }],
};
/* The App as the server loads it, pages and all, from an app.json in its own directory. */
async function load(extra: Record<string, unknown> = {}, directory?: string) {
  const own = directory ?? mkdtempSync(join(tmpdir(), 'tablewalk-view-roles-'));
  try {
    writeFileSync(join(own, 'app.json'), JSON.stringify({ ...manifest, ...extra }));
    return await loadApp(own);
  } finally {
    if (!directory) rmSync(own, { recursive: true, force: true });
  }
}

type Reply = { status: number; text: string; body: Record<string, any> };
async function serve(
  run: (call: (path: string, body?: unknown) => Promise<Reply>, as: (role: string) => void, origin: string) => Promise<void>,
  extra: Record<string, unknown> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-view-roles-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT);
    INSERT INTO ticket VALUES (1, 'Printer jam', 'open');`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'desk-db', url: file, source: 'config', writable: false });
  const loaded = await load(extra, directory);
  let role = 'employee';
  const host: AppHost = {
    app: loaded,
    pages: loaded.pages,
    auth: {
      spec: loaded.app.auth!,
      store: 'not-used',
      close() {},
      handler: async () => {},
      session: async () => ({ id: 'person-1', who: 'person@example.test', role }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: loaded.pages });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run(
      async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          signal: AbortSignal.timeout(5000),
          ...(body === undefined
            ? {}
            : {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: `http://${bound.host}:${bound.port}` },
                body: JSON.stringify(body),
              }),
        });
        const text = await response.text();
        return { status: response.status, text, body: text ? JSON.parse(text) : {} };
      },
      (next) => {
        role = next;
      },
      `http://${bound.host}:${bound.port}`,
    );
  } finally {
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

/* Every view key the served nav names, groups opened. */
const navViews = (nodes: readonly any[]): string[] =>
  nodes.flatMap((node) => (node.children ? navViews(node.children) : node.view ? [node.view] : []));
/* Where an address lands in the address book built from what this principal was served, as the browser and publicHead read it. */
const lands = (app: Record<string, any>, schema: DatabaseSchema, segments: string[]) =>
  readAppSegments(
    appAddressBook({
      views: app.views,
      order: viewOrder(app as never),
      resources: app.resources,
      pages: app.pages ?? [],
      tables: schema.tables,
      inbox: app.inbox === true,
    }),
    segments,
  );

test('a signed-in person opening a record at an address they are not served is sent to the same record at theirs', async () => {
  /* Each role is served its own list over tickets: the employee's first, so the whole App's book says /mine/1. */
  const views = { ...manifest.views, mine: { ...manifest.views.mine, roles: ['employee'] } };
  await serve(
    async (_call, as, origin) => {
      /* A page is what a browser navigates to, asking for HTML; anything else — a module, a file — is not moved. */
      const open = async (path: string, accept = 'text/html') => {
        const response = await fetch(`${origin}${path}`, { headers: { accept }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
        await response.arrayBuffer();
        return { status: response.status, location: response.headers.get('location') };
      };
      // The one App is served at the root (mount.ts): its addresses are the browser's without its id.
      as('agent');
      assert.deepEqual(await open('/mine/1?tab=x'), { status: 302, location: '/queue/1?tab=x' });
      assert.equal((await open('/queue/1')).status, 200, 'their own address is the page');
      as('employee');
      assert.deepEqual(await open('/queue/1'), { status: 302, location: '/mine/1' });
      assert.equal((await open('/mine/1')).status, 200);
      // Only a record moves: a list they are not served is no address of theirs, and the shell says so as ever.
      assert.equal((await open('/queue')).status, 200);
      assert.equal((await open('/queue/1', '*/*')).status, 200, 'a fetch that is not a page is not moved');
      as('lead');
      assert.deepEqual(await open('/mine/1'), { status: 302, location: '/queue/1' });
    },
    { views },
  );
});

describe('served', () => {
  test('a role the view does not name is not served it: not in the views, the menu, the address book or the pages', async () => {
    await serve(async (call, as) => {
      const schema = (await call('/api/schema')).body as DatabaseSchema;
      as('employee');
      const employee = await call('/api/app');
      assert.equal(employee.status, 200, employee.text);
      const app = employee.body.app;
      assert.deepEqual(Object.keys(app.views).sort(), ['mine']);
      assert.deepEqual(navViews(app.nav), ['mine'], 'the Work group, left empty, goes with its views');
      assert.equal(app.home, 'mine');
      assert.doesNotMatch(employee.text, /Agent queue|"floor"|triage/, "nothing says the agents' rooms are there");
      assert.equal(lands(app, schema, ['queue']), undefined, 'its address opens nothing, as a view that does not exist');
      assert.equal(lands(app, schema, ['no-such-view']), undefined);
      assert.equal(lands(app, schema, ['triage', '1']), undefined, "nor does the page's own address");
      const pages = (await call('/api/pages')).body.pages as PageDef[];
      assert.deepEqual(
        pages.map((page) => page.id),
        ['ticket'],
      );
      /* Table grants still apply on their own: the rows the queue would show are the employee's to read. */
      assert.equal(
        (await call('/api/view/run', { view: { id: 'x', name: 'x', base: 'ticket', columns: [{ path: 'name' }] } })).status,
        200,
      );
    });
  });

  test('a role the view names is served it whole', async () => {
    await serve(async (call, as) => {
      const schema = (await call('/api/schema')).body as DatabaseSchema;
      as('agent');
      const app = (await call('/api/app')).body.app;
      assert.deepEqual(Object.keys(app.views).sort(), ['floor', 'mine', 'queue']);
      assert.deepEqual(navViews(app.nav), ['mine', 'queue', 'floor']);
      assert.equal(app.home, 'queue');
      assert.equal(lands(app, schema, ['queue'])?.target.kind, 'list');
      assert.ok(lands(app, schema, ['triage', '1']), "the page's own address opens");
      assert.deepEqual(((await call('/api/pages')).body.pages as PageDef[]).map((page) => page.id).sort(), ['ticket', 'triage']);
      /* A lead holds the queue and not the floor; one person holding both roles has both. */
      as('lead');
      assert.deepEqual(Object.keys((await call('/api/app')).body.app.views).sort(), ['mine', 'queue']);
      as('employee,agent');
      assert.deepEqual(Object.keys((await call('/api/app')).body.app.views).sort(), ['floor', 'mine', 'queue']);
    });
  });
});

test("a dashboard's feed, read by naming the dashboard, is refused to a role it does not name, as one that does not exist", async () => {
  /* A feed needs a provisioned history store to serve; the dashboard it names is judged before any store is opened. */
  const app = parseTestApp(
    {
      ...manifest,
      pages: undefined,
      views: {
        ...manifest.views,
        floor: { ...manifest.views.floor, sections: [{ kind: 'activity', title: 'Latest', resources: { ticket: {} } }] },
      },
    },
    'desk',
  );
  const schema: DatabaseSchema = { label: 'Desk', dialect: 'sqlite', readAt: '', foreignKeys: [], tables: [] };
  const read = (view: string, roles: string[]) =>
    readRecordActivityFor({
      app,
      pages: [],
      reader: {} as Adapter,
      schema,
      mapping: { connectionFor: () => 'desk-db', toPhysical: (table) => table },
      open: async () => ({}) as Adapter,
      view,
      section: 0,
      period: 'today',
      now: new Date('2026-10-05T12:00:00Z'),
      roles,
    });
  assert.deepEqual(await read('floor', ['agent']), { entries: [] });
  await assert.rejects(read('floor', ['employee']), AppAccessDenied);
  await assert.rejects(read('no-such-view', ['agent']), AppAccessDenied);
});

test("the API serves a view's operation to the roles it names alone", () => {
  const col = (name: string): ColumnMeta => ({
    name,
    type: name === 'id' ? 'INTEGER' : 'TEXT',
    nullable: name !== 'id',
    primaryKey: name === 'id',
  });
  const schema: DatabaseSchema = {
    label: 'Desk',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [{ id: 'ticket', name: 'ticket', schema: '', isView: false, columns: [col('id'), col('name')] }],
  };
  const withApi = (roles: string[]) =>
    parseAppConfig(
      {
        ...manifest,
        connection: undefined,
        pages: undefined,
        api: { version: 1, roles, resources: { ticket: { fields: ['id', 'name'] } }, views: ['queue'] },
      },
      'desk',
    );
  const app = withApi(['agent', 'employee']);
  const operation = checkApiReadCatalog(app.api!, app, schema).operations.find((item) => item.id === 'view:queue')!;
  assert.deepEqual(operation.eligibleRoles, ['agent']);
  /* The plain resource stays every API role's: `roles` narrows the view, never the table. */
  assert.deepEqual(checkApiReadCatalog(app.api!, app, schema).operations.find((item) => item.id === 'list:ticket')!.eligibleRoles, [
    'agent',
    'employee',
  ]);
  const none = withApi(['employee']);
  assert.throws(
    () => checkApiReadCatalog(none.api!, none, schema),
    /api\.views\.queue: the view names roles \(agent, lead\) none of which api\.roles lists/,
  );
});

test('a tenant member is judged on the roles of their membership in that tenant', () => {
  const col = (name: string): ColumnMeta => ({ name, type: 'TEXT', nullable: name !== 'id', primaryKey: name === 'id', writable: false });
  const schema: DatabaseSchema = {
    label: 'Tenant desk',
    dialect: 'sqlite',
    readAt: '2026-10-05T00:00:00.000Z',
    foreignKeys: [],
    tables: [
      { id: 'ticket', name: 'ticket', schema: '', isView: false, insertable: false, deletable: false, columns: [col('id'), col('name')] },
    ],
  };
  const app = parseTestApp(
    {
      id: 'tenant-desk',
      name: 'Tenant desk',
      sources: { business: { connection: 'PRIVATE_CONNECTION' } },
      resources: { ticket: { physical: 'physical_ticket', owner: 'tenant' } },
      auth: { rows: 'tenant', roles: { agent: { read: true }, employee: { read: true } } },
      views: { mine: { kind: 'list', from: 'ticket' }, queue: { kind: 'list', from: 'ticket', roles: ['agent'] } },
      home: 'mine',
      nav: ['mine', 'queue'],
    },
    'tenant desk',
  );
  const pages: PageDef[] = [{ id: 'triage', name: 'Triage', base: 'ticket', path: 'triage', roles: ['agent'], sections: [] }];
  /* One account: an agent in north, an employee in south. */
  const north = projectTenantMetadata(app, pages, schema, undefined, ['agent']);
  const south = projectTenantMetadata(app, pages, schema, undefined, ['employee']);
  assert.deepEqual([Object.keys(north.app.views).sort(), north.pages.map((page) => page.id)], [['mine', 'queue'], ['triage']]);
  assert.deepEqual([Object.keys(south.app.views), south.pages.map((page) => page.id)], [['mine'], []]);
  assert.deepEqual(JSON.parse(JSON.stringify(south.app.nav)), [{ view: 'mine', label: 'Ticket' }]);
});

test('the projection is one object per role set, so the payload caches keep one entry per principal shape', () => {
  const app: AppDef = parseTestApp(manifest, 'desk');
  assert.equal(appForRoles(app, ['employee']), appForRoles(app, ['employee']));
  assert.equal(appForRoles(app, ['agent', 'lead']), appForRoles(app, ['lead', 'agent']));
  const plain = parseTestApp({ ...manifest, views: { mine: manifest.views.mine }, home: 'mine', nav: ['mine'], pages: undefined }, 'plain');
  assert.equal(appForRoles(plain, []), plain, 'an App whose views name no roles is itself');
});

describe('refused at load', () => {
  test('a role auth.roles does not declare, or an empty list', async () => {
    await assert.rejects(
      load({ views: { ...manifest.views, queue: { ...manifest.views.queue, roles: ['agnet'] } } }),
      /views "queue" has "roles" naming "agnet", which auth.roles does not declare\. It declares: agent, employee, lead\./,
    );
    await assert.rejects(
      load({ views: { ...manifest.views, queue: { ...manifest.views.queue, roles: [] } } }),
      /views "queue" has an empty "roles", so nobody could open it/,
    );
    await assert.rejects(
      load({ pages: { triage: { ...manifest.pages.triage, roles: ['ghost'] } } }),
      /pages "triage" has "roles" naming "ghost"/,
    );
    assert.throws(
      () =>
        parseTestApp(
          {
            name: 'No sign-in',
            resources: { ticket: {} },
            views: { queue: { kind: 'list', from: 'ticket', roles: ['agent'] } },
            home: 'queue',
          },
          'no auth',
        ),
      /The App declares no roles\./,
    );
  });

  test("roles on what a signed-out visitor opens: a public form, a landing's view, a signed-out home", async () => {
    const FORM = {
      kind: 'form',
      label: 'Report',
      public: true,
      roles: ['agent'],
      command: { id: 'report', version: 1, input: { summary: { label: 'Summary', type: 'text' } } },
    };
    await assert.rejects(
      load({ views: { ...manifest.views, report: FORM } }),
      /views "report" has "roles", which is not taken: a public form is open to everyone, signed out too, and a visitor holds no role/,
    );
    const LANDING = {
      kind: 'landing',
      label: 'Welcome',
      hero: { heading: 'Welcome', actions: [{ label: 'Sign in', signIn: true }] },
      sections: [{ kind: 'view', view: 'queue' }],
    };
    await assert.rejects(
      load({
        auth: { ...manifest.auth, public: { read: ['ticket'] } },
        views: {
          ...manifest.views,
          queue: { ...manifest.views.queue, presentation: { kind: 'cards', primary: 'name' } },
          welcome: LANDING,
        },
        home: [{ view: 'welcome', signedOut: true }, ...manifest.home],
      }),
      /views "queue" names "roles", and the landing opens it to signed-out visitors, who hold none/,
    );
    await assert.rejects(
      load({ auth: { ...manifest.auth, public: { read: ['ticket'] } }, home: [{ view: 'queue', signedOut: true }, { view: 'mine' }] }),
      /rule 1 sends signed-out visitors to "queue", which names "roles"; a signed-out visitor holds none/,
    );
  });

  test('a per-role home rule that lands a role on a view that role cannot open', async () => {
    await assert.rejects(
      load({ home: [{ view: 'queue', roles: ['agent', 'employee'] }, { view: 'mine' }] }),
      /rule 1: the role "employee" is not among the roles "queue" names \(agent, lead\)\. A home must be a view its visitors can open\./,
    );
    await assert.rejects(
      load({ home: [{ view: 'floor', roles: ['lead'] }, { view: 'mine' }] }),
      /the role "lead" is not among the roles "floor" names \(agent\)/,
    );
  });
});
