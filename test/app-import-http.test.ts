import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { checkImports } from '../packages/mistri/src/shared/appImport.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';

/* A small catalog: products from suppliers, a status vocabulary, a unique
   SKU and a rule of the App's own. Imports run as the signed-in account the
   cookie names, through the same writer every New form uses. */
const connection = 'import-db';
const appId = 'stock';
const identity = (role: string, id = `account-${role}`): Identity => ({ id, who: `${role}@example.test`, role });
const sessions: Record<string, Identity> = {
  buyer: identity('buyer'),
  viewer: identity('viewer'),
  narrow: identity('narrow'),
  other: identity('buyer', 'account-other'),
};

const APP = {
  id: appId,
  name: 'Stock',
  connection,
  resources: {
    product: {
      access: 'write',
      import: true,
      recordLabel: 'name',
      labels: {
        sku: 'SKU',
        name: 'Product',
        supplier_id: 'Supplier',
        unit_cost: 'Unit cost',
        list_price: 'List price',
        status: 'Status',
        received_on: 'Received',
      },
      validation: [{ must: 'list_price >= unit_cost', message: 'A product sells for at least what it costs.' }],
    },
    supplier: { access: 'write', recordLabel: 'name' },
    note: { access: 'write' },
  },
  auth: {
    providers: ['email'],
    defaultRole: 'viewer',
    roles: {
      buyer: { read: true, write: ['product', 'supplier'] },
      viewer: { read: true },
      narrow: {
        read: true,
        write: ['product'],
        fields: {
          product: {
            read: ['id', 'sku', 'name', 'supplier_id', 'unit_cost', 'list_price', 'status', 'received_on', 'secret'],
            write: ['sku', 'name', 'supplier_id', 'unit_cost', 'list_price', 'status', 'received_on'],
          },
        },
      },
    },
  },
  views: {
    products: { kind: 'list', from: 'product', label: 'Products' },
    'products-closed': { kind: 'list', from: 'product', label: 'Products (no import)', import: false },
    notes: { kind: 'list', from: 'note', label: 'Notes' },
  },
  home: 'products',
  nav: ['products', 'products-closed', 'notes'],
};
const SQL = `CREATE TABLE supplier (id INTEGER PRIMARY KEY, name TEXT NOT NULL, code TEXT UNIQUE);
  CREATE TABLE product (id INTEGER PRIMARY KEY, sku TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    supplier_id INTEGER NOT NULL REFERENCES supplier(id), unit_cost NUMERIC NOT NULL, list_price NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'discontinued', 'on_hold')), received_on TEXT, secret TEXT);
  CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);
  INSERT INTO supplier VALUES (1, 'Summit Gear', 'SUM'), (2, 'Trailhead', 'TRL'), (3, 'Trailhead', 'TR2');
  INSERT INTO product (sku, name, supplier_id, unit_cost, list_price) VALUES ('KEEP-1', 'Kept', 1, 5, 9);`;

async function fixture(
  run: (f: {
    post: (body: object, who?: string) => Promise<{ status: number; body: any }>;
    db: DatabaseSync;
    base: string;
  }) => Promise<void>,
  app: object = APP,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-import-http-'));
  const file = join(directory, 'stock.db');
  const db = new DatabaseSync(file);
  db.exec(SQL);
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Stock', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(app, 'import fixture');
  const pages = parsePagesConfig({ pages: [] }, 'import pages');
  const host: AppHost = {
    app: { path: '/private/stock/app.ts', app: definition, pages, sources: {} },
    pages,
    auth: {
      spec: definition.auth!,
      store: '/private/stock/sessions.db',
      handler: async () => {},
      close: async () => {},
      session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  try {
    await run({
      db,
      base,
      post: async (body, who = 'buyer') => {
        const response = await fetch(`${base}/api/import?app=${appId}`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: { 'content-type': 'application/json', cookie: `session=${who}` },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    server.close();
    server.closeAllConnections();
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
}

const HEADER = 'SKU,Product,Supplier,Unit cost,List price,Status,Received';
const MAPPING = ['sku', 'name', 'supplier_id', 'unit_cost', 'list_price', 'status', 'received_on'];
const count = (db: DatabaseSync) => Number((db.prepare('SELECT count(*) AS n FROM product').get() as { n: number }).n);
const importing = (lines: string[], extra: object = {}) => ({
  table: 'product',
  csv: [HEADER, ...lines].join('\r\n'),
  mapping: MAPPING,
  mode: 'check',
  ...extra,
});

test('a check reads every row, says what is wrong with each by field, and writes nothing', async () => {
  await fixture(async ({ post, db }) => {
    const checked = await post(
      importing([
        'TNT-1,Dome tent,Summit Gear,"1,200.50","1,499.00",Active,3/14/2026',
        'TNT-2,Tarp,SUM,12,20,on hold,2026-03-15',
        'TNT-3,Bad cost,Summit Gear,twelve,20,active,',
        'TNT-4,Ambiguous,Trailhead,5,9,active,',
        'TNT-5,Nobody,Nowhere Ltd,5,9,active,',
        'TNT-6,Cheap,Summit Gear,10,5,active,',
        'TNT-7,Odd status,Summit Gear,5,9,retired,',
        'TNT-1,Twice,Summit Gear,5,9,active,',
        'KEEP-1,Already there,Summit Gear,5,9,active,',
        ',No SKU,Summit Gear,5,9,active,',
        'TNT-8,Bad date,Summit Gear,5,9,active,13/45/2026',
      ]),
    );
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    const report = checked.body;
    assert.equal(report.outcome, 'checked');
    assert.equal(report.rows, 11);
    assert.equal(report.ready, 2);
    const byRow = new Map(
      report.refused.map((r: any) => [r.row, r.problems.map((p: any) => `${p.field ?? ''}: ${p.message}`).join(' | ')]),
    );
    assert.match(byRow.get(3) as string, /^Unit cost: "twelve" is not a number\.$/);
    assert.match(byRow.get(4) as string, /^Supplier: "Trailhead" could name 2 records of supplier/);
    assert.match(byRow.get(5) as string, /^Supplier: No supplier is named "Nowhere Ltd"\.$/);
    assert.match(byRow.get(6) as string, /^List price: A product sells for at least what it costs\.$/);
    assert.match(byRow.get(7) as string, /^Status: "retired" is not one of "Active", "Discontinued", "On hold"\.$/);
    assert.match(byRow.get(8) as string, /^SKU: "TNT-1" is also on row 1; it must be unique\.$/);
    assert.match(byRow.get(9) as string, /^SKU: Another record already has this value\.$/);
    assert.match(byRow.get(10) as string, /^SKU: A value is required\.$/);
    assert.match(byRow.get(11) as string, /^Received: "13\/45\/2026" is not a date/);
    assert.equal(report.refused[0].line, 4, 'the line in the file, the header being line 1');
    assert.equal(count(db), 1, 'a check writes nothing');
  });
});

test('a commit writes every good row in one transaction, or none while any is refused', async () => {
  await fixture(async ({ post, db }) => {
    const lines = [
      'TNT-1,Dome tent,Summit Gear,"1,200.50","1,499.00",Active,3/14/2026',
      'TNT-2,Tarp,TRL,12,20,on hold,2026-03-15',
      'TNT-3,Bad,Nowhere,5,9,active,',
    ];
    const refused = await post(importing(lines, { mode: 'commit' }));
    assert.equal(refused.body.outcome, 'not_applied');
    assert.equal(count(db), 1, 'a refused row keeps the whole file out');

    const applied = await post(importing(lines, { mode: 'commit', skipRefused: true }));
    assert.equal(applied.body.outcome, 'applied', JSON.stringify(applied.body));
    assert.equal(applied.body.applied, 2);
    assert.equal(applied.body.undoId, undefined);
    const stored = db
      .prepare("SELECT sku, name, supplier_id, unit_cost, list_price, status, received_on FROM product WHERE sku LIKE 'TNT-%' ORDER BY sku")
      .all()
      .map((row) => ({ ...row }));
    assert.deepEqual(stored, [
      { sku: 'TNT-1', name: 'Dome tent', supplier_id: 1, unit_cost: 1200.5, list_price: 1499, status: 'active', received_on: '2026-03-14' },
      { sku: 'TNT-2', name: 'Tarp', supplier_id: 2, unit_cost: 12, list_price: 20, status: 'on_hold', received_on: '2026-03-15' },
    ]);
  });
});

test("numbers and dates are read in the App's locale", async () => {
  await fixture(
    async ({ post, db }) => {
      const report = await post({
        table: 'product',
        mode: 'commit',
        mapping: MAPPING,
        csv: 'SKU;Product;Supplier;Unit cost;List price;Status;Received\nDE-1;Zelt;SUM;"1.200,50";1.499;active;14.03.2026\nDE-2;Plane;SUM;1.5;2;active;',
      });
      assert.equal(report.body.outcome, 'not_applied');
      assert.match(
        report.body.refused[0].problems[0].message,
        /"1\.5" is not a number/,
        'a grouping mark out of place is refused, not read as fifteen',
      );
      const good = await post({
        table: 'product',
        mode: 'commit',
        mapping: MAPPING,
        csv: 'SKU;Product;Supplier;Unit cost;List price;Status;Received\nDE-1;Zelt;SUM;"1.200,50";1.499;active;14.03.2026',
      });
      assert.equal(good.body.outcome, 'applied', JSON.stringify(good.body));
      assert.deepEqual(
        { ...db.prepare("SELECT unit_cost, list_price, received_on FROM product WHERE sku = 'DE-1'").get() },
        { unit_cost: 1200.5, list_price: 1499, received_on: '2026-03-14' },
      );
    },
    { ...APP, ui: { locale: 'de-DE' } },
  );
});

test("an import is the reader's own insert: grants, field grants, sign-in and the opt-in are all the server's", async () => {
  await fixture(async ({ post, db }) => {
    const line = ['NEW-1,New,SUM,5,9,active,'];
    // Signed out, and a reader without the write.
    assert.equal((await post(importing(line), 'nobody')).status, 401);
    assert.equal((await post(importing(line, { mode: 'commit' }), 'viewer')).status, 403);
    // A column the reader may read but not write is not a field the import fills.
    const narrow = await post(
      { ...importing(line), csv: `${HEADER},Secret\nNEW-1,New,SUM,5,9,active,,psst`, mapping: [...MAPPING, 'secret'], mode: 'commit' },
      'narrow',
    );
    assert.equal(narrow.status, 200);
    assert.equal(narrow.body.outcome, 'not_applied');
    assert.match(narrow.body.error, /"secret" is not a field this import fills/);
    // A resource that does not opt in, a list that turns it off, a table the App does not declare.
    assert.equal((await post({ table: 'note', csv: 'Body\nhi', mapping: ['body'], mode: 'commit' })).status, 404);
    assert.equal((await post({ ...importing(line, { mode: 'commit' }), view: 'products-closed' })).status, 404);
    assert.equal((await post({ ...importing(line, { mode: 'commit' }), table: 'sqlite_master' })).status, 403);
    // The request's own shape: an unknown key, a mode, the other App.
    assert.equal((await post({ ...importing(line), path: '../../etc/passwd' })).status, 400);
    assert.equal((await post({ ...importing(line), mode: 'force' })).status, 400);
    assert.equal((await post({ ...importing(line), app: 'elsewhere' })).status, 400);
    assert.equal(count(db), 1);
  });
});

test('a file past the limits, or not CSV at all, is refused with the line it stopped on', async () => {
  await fixture(async ({ post }) => {
    const unclosed = await post({ ...importing(['"TNT-1,Dome']), mode: 'check' });
    assert.equal(unclosed.body.outcome, 'not_applied');
    assert.match(unclosed.body.error, /^Line 2: A quoted field is never closed\./);
    const trailing = await post({ ...importing(['"TNT-1"x,Dome,SUM,5,9,active,']), mode: 'check' });
    assert.match(trailing.body.error, /^Line 2: A quoted field is followed by more text/);
    const many = await post({ ...importing(Array.from({ length: 5001 }, (_, i) => `M-${i},M,SUM,1,2,active,`)), mode: 'check' });
    assert.match(many.body.error, /more than 5,000 rows/);
    const huge = await post({ ...importing([]), csv: `${HEADER}\n${'x'.repeat(5 * 1024 * 1024)}` });
    assert.equal(huge.status, 400);
    assert.match(huge.body.error, /larger than 5 MB/);
  });
});

test('an import is checked at load: a tenant App serves one, a read-only resource and a match alone do not', () => {
  assert.doesNotThrow(() => checkImports({ auth: { rows: 'tenant' }, resources: { product: { import: {} } }, views: {} }, 'tenant import'));
  assert.throws(
    () => parseAppConfig({ ...APP, resources: { ...APP.resources, supplier: { import: true } } }, 'read import'),
    /importing creates records, which needs the resource's access 'write'/,
  );
  assert.throws(
    () =>
      parseAppConfig({ ...APP, resources: { ...APP.resources, product: { access: 'write', import: { match: ['sku'] } } } }, 'match only'),
    /has "match" and no "command"/,
  );
});
