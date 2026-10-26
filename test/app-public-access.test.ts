import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig, resolveAppAccess } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';

/* A lot anyone may browse: vehicles and dealers read signed out (a dealer's
   email is not), inquiries only by staff, and nothing written by a visitor. */
const appId = 'lot';
const owner = 'lot-db';
const APP = {
  id: appId,
  name: 'Lot',
  connection: owner,
  resources: { vehicle: { access: 'write' }, dealer: {}, inquiry: {} },
  auth: {
    roles: { staff: { read: true, write: ['vehicle'] } },
    public: { read: ['vehicle', 'dealer'], fields: { dealer: { read: ['id', 'name'] } } },
  },
  views: {
    vehicles: { kind: 'list', from: 'vehicle', label: 'Vehicles' },
    inquiries: { kind: 'list', from: 'inquiry', label: 'Inquiries' },
  },
  home: [{ view: 'vehicles', signedOut: true }, { view: 'inquiries' }],
  nav: ['vehicles', 'inquiries'],
};
const SQL = `CREATE TABLE dealer (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
  CREATE TABLE vehicle (id INTEGER PRIMARY KEY, make TEXT NOT NULL, price INTEGER, dealer_id INTEGER REFERENCES dealer(id));
  CREATE TABLE inquiry (id INTEGER PRIMARY KEY, vehicle_id INTEGER REFERENCES vehicle(id), email TEXT NOT NULL);
  INSERT INTO dealer VALUES (1, 'North Motors', 'sales@north.test'); INSERT INTO vehicle VALUES (1, 'Toyota', 14500, 1);
  INSERT INTO inquiry VALUES (1, 1, 'buyer@example.test');`;
const withAuth = (auth: unknown) => ({ ...APP, auth });

test('a public grant names every resource it opens, within the ceiling, and writes nothing', () => {
  const refused = (auth: unknown, pattern: RegExp) => assert.throws(() => parseAppConfig(withAuth(auth), 'lot'), pattern);
  const roles = APP.auth.roles;
  refused({ roles, public: { read: true } }, /"read" is true; name each resource/);
  refused({ roles, public: { read: ['vehicle', 'garage'] } }, /"read" names "garage", which is outside the read ceiling/);
  refused(
    { roles, public: { read: ['vehicle'], fields: { vehicle: { read: ['id', 'make'], write: ['make'] } } } },
    /a signed-out visitor writes nothing/,
  );
  refused({ roles, public: { read: ['vehicle'], fields: { dealer: { read: ['id'] } } } }, /"fields" names "dealer", which "read" does not/);
  refused({ roles, public: { read: ['vehicle'], see: true } }, /see/);
  refused({ public: { read: ['vehicle'] } }, /needs "auth.roles"/);
  const open = parseAppConfig(APP, 'lot').auth?.public;
  assert.deepEqual(open?.read, ['vehicle', 'dealer']);
  assert.deepEqual(open?.fields?.dealer.read, ['id', 'name']);
});

test("a signed-out visitor's access is the public grant: its reads, its columns, no writes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-public-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'lot.db'));
  db.exec(SQL);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'lot.db'), 'lot');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const app = parseAppConfig(APP, 'lot');
  const visitor = resolveAppAccess(app, schema, [], 'public');
  assert.deepEqual([...visitor.readable].sort(), ['dealer', 'vehicle']);
  assert.equal(visitor.writable.size, 0);
  assert.deepEqual([...visitor.fields!.get('dealer')!.read].sort(), ['id', 'name']);
  // A staff member signed in is untouched by it.
  assert.deepEqual([...resolveAppAccess(app, schema, ['staff']).readable].sort(), ['dealer', 'inquiry', 'vehicle']);
  // Without a public grant, a visitor reads nothing.
  const closed = parseAppConfig({ ...withAuth({ roles: APP.auth.roles }), home: 'vehicles' }, 'lot');
  assert.equal(resolveAppAccess(closed, schema, [], 'public').readable.size, 0);
});

test('the authority lock names what anyone reads', () => {
  const report = authorityReport(parseAppConfig(APP, 'lot'));
  for (const line of ['public read dealer', 'public read vehicle', 'public fields dealer read id', 'public fields dealer read name']) {
    assert.match(report, new RegExp(`^${line}`, 'm'));
  }
});

test('a signed-out home may be a view the public reads all of, and no other', () => {
  assert.throws(
    () => parseAppConfig({ ...APP, home: [{ view: 'inquiries', signedOut: true }, { view: 'vehicles' }] }, 'lot'),
    /sends signed-out visitors to "inquiries".*or a view whose every table "auth.public" reads\)\./,
  );
  assert.throws(
    () =>
      parseAppConfig(
        { ...withAuth({ roles: APP.auth.roles }), home: [{ view: 'vehicles', signedOut: true }, { view: 'inquiries' }] },
        'lot',
      ),
    /a signed-out visitor can open only a public view/,
  );
});

async function serve(
  app: Record<string, unknown>,
  run: (call: (path: string, body?: object) => Promise<{ status: number; body: any }>) => Promise<void>,
  sql = SQL,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-public-http-'));
  const file = join(directory, 'lot.db');
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
  const registry = new Registry();
  registry.add({ id: owner, name: 'Lot', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(app, 'lot fixture');
  const pages = parsePagesConfig({ pages: [] }, 'lot pages');
  const host: AppHost = {
    app: { path: 'lot-fixture.ts', app: definition, pages, sources: {} },
    pages,
    auth: { spec: definition.auth!, store: 'not-used', handler: async () => {}, close: async () => {}, session: async () => null },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
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
        ...(body ? { method: 'POST', body: JSON.stringify({ app: appId, ...body }) } : {}),
      });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    server.close();
    server.closeAllConnections();
    registry.closeAll?.();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('signed out, the HTTP surface is the public grant: its App, its reads, and no writes', async () => {
  await serve(APP, async (call) => {
    const me = await call('/api/whoami');
    assert.equal(me.body.signedIn, false);
    assert.equal(me.body.public, true);
    assert.equal(me.body.home, 'vehicles');

    const served = await call(`/api/app?app=${appId}`);
    assert.equal(served.status, 200, JSON.stringify(served.body));
    assert.ok(served.body.app.views.vehicles);
    assert.equal(served.body.app.views.inquiries, undefined);
    assert.equal(served.body.app.home, 'vehicles');
    assert.deepEqual(served.body.app.writableTables, []);

    const cars = await call('/api/run', { q: 'vehicle show id, make, price', limit: 10, offset: 0 });
    assert.equal(cars.status, 200, JSON.stringify(cars.body));
    assert.deepEqual(cars.body.rows, [{ id: 1, make: 'Toyota', price: 14500 }]);

    for (const q of ['inquiry show id, email', 'dealer show id, email']) {
      const refused = await call('/api/run', { q, limit: 10, offset: 0 });
      assert.ok(refused.status >= 400 || refused.body.errors?.length, `${q} was answered: ${JSON.stringify(refused.body)}`);
      assert.doesNotMatch(JSON.stringify(refused.body), /buyer@example|sales@north/);
    }
    // A public list's tab badges: the public grant's tables are counted, nothing else is.
    const counts = await call('/api/counts', {
      items: ['vehicle', 'vehicle make = Toyota', 'dealer', 'inquiry', 'dealer email = "sales@north.test"'],
    });
    assert.equal(counts.status, 200, JSON.stringify(counts.body));
    const [all, toyota, dealers, inquiry, email] = counts.body.results;
    assert.deepEqual([all.total, toyota.total, dealers.total], [1, 1, 1]);
    for (const refused of [inquiry, email]) assert.ok(refused.total === undefined && refused.errors?.length, JSON.stringify(refused));
    // A file of rows is a signed-in reader's; the public is not offered one.
    const exported = await call('/api/export', { q: 'vehicle' });
    assert.equal(exported.status, 401);
    assert.equal((await call('/api/insert', { table: 'vehicle', values: { make: 'Ford' } })).status, 401);
    assert.equal((await call('/api/update', { table: 'vehicle', key: { id: 1 }, values: { price: 1 } })).status, 401);
  });
});

test('signed out, a similar list is one read under the public grant, built from the record’s own values', async () => {
  const sql = `${SQL}
    INSERT INTO vehicle VALUES (2, 'Toyota', 15000, 1), (3, 'Toyota', 30000, 1), (4, 'Honda', 14500, 1), (5, '', 14500, 1);`;
  const like = (base: string, similar: object) => ({
    page: { id: 'like', name: 'Like', base, sections: [{ kind: 'list', from: base, path: '', similar, columns: ['id'] }] },
  });
  await serve(
    APP,
    async (call) => {
      const plan = await call('/api/pages/plan', { ...like('vehicle', { same: ['make'], near: { price: 0.25 } }), key: { id: 1 } });
      assert.equal(plan.status, 200, JSON.stringify(plan.body));
      const view = plan.body.plans[0].view;
      // ±25% of 14,500, the make read from the row, and the record itself left out.
      assert.deepEqual(view.filter.groups, [
        [
          { path: 'make', op: '=', value: 'Toyota' },
          { path: 'price', op: '>=', value: 10875 },
          { path: 'price', op: '<=', value: 18125 },
          { path: 'id', op: '!=', value: 1 },
        ],
      ]);
      const rows = await call('/api/view/run', { view });
      assert.equal(rows.status, 200, JSON.stringify(rows.body));
      assert.deepEqual(rows.body.rows, [{ id: 2 }]);
      // A record with no make matches nothing, and there is nothing to read.
      const blank = await call('/api/pages/plan', { ...like('vehicle', { same: ['make'] }), key: { id: 5 } });
      assert.equal(blank.status, 200, JSON.stringify(blank.body));
      assert.equal(blank.body.plans[0].empty, true);
      assert.equal(blank.body.plans[0].view, undefined);
      // The ceiling: a dealer's email is not the visitor's to match on, and is never said.
      const email = await call('/api/pages/plan', { ...like('dealer', { same: ['email'] }), key: { id: 1 } });
      assert.ok(email.status >= 400, JSON.stringify(email.body));
      assert.doesNotMatch(JSON.stringify(email.body), /sales@north/);
      // Nor are inquiries, which a visitor does not read at all.
      const inquiry = await call('/api/pages/plan', { ...like('inquiry', { same: ['email'] }), key: { id: 1 } });
      assert.ok(inquiry.status >= 400, JSON.stringify(inquiry.body));
      assert.doesNotMatch(JSON.stringify(inquiry.body), /buyer@example/);
    },
    sql,
  );
});

test('without a public grant, a signed-out visitor still meets the sign-in wall', async () => {
  await serve({ ...withAuth({ roles: APP.auth.roles }), home: 'vehicles' }, async (call) => {
    const me = await call('/api/whoami');
    assert.equal(me.body.public, undefined);
    assert.equal((await call('/api/run', { q: 'vehicle', limit: 10, offset: 0 })).status, 401);
    assert.equal((await call('/api/counts', { items: ['vehicle'] })).status, 401);
    assert.equal((await call(`/api/app?app=${appId}`)).status, 401);
  });
});
