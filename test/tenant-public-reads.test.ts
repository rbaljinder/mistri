/**
 * Public reads in a tenant App (`auth.public` with `rows: 'tenant'`), over the
 * dedicated tenant host with genuine native auth. A visitor carries a tenant's
 * public address (`?via=`) or arrives on that tenant's mapped host, and reads
 * that one tenant's rows of the resources the grant names, narrowed by the
 * policy's `resolvePublicRows`, and nothing else: another tenant's row, a
 * platform row, a column the grant leaves out and a resource it does not name
 * each answer as a row that is not there. Every address that places nobody
 * answers one identical 404, and an address refuses every route but a read.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { CompiledComponents } from '../packages/mistri/src/server/app/appComponents.js';
import { loadApp, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { createTenantHostRouter } from '../packages/mistri/src/server/http/tenantHosts.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'lot';
const binding = { appId, source: { id: 'business', connection: 'business-db' }, storeId: 'public-reads-store' };
const NORTH = 'north-public-AAAAAAAAAAAAAAAA',
  WEST = 'west-public-CCCCCCCCCCCCCCCCCC',
  UNKNOWN = 'unknown-public-FFFFFFFFFFFFFF',
  ROTATED = 'north-rotated-BBBBBBBBBBBBBBBB';
const everything = { dealer: true, make: true, listing: true, photo: true, note: true };
const published = (): RowScope => ({
  listing: { groups: [[{ column: 'published', op: '=', value: 1 }]] },
  photo: true,
  make: { groups: [[{ column: 'shown', op: '=', value: 1 }]] },
});

async function portFor() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}
async function maintain(file: string, run: (admin: TenantStoreAdministration) => Promise<void>) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE');
    const operations = new TransactionOperations();
    await run(createSqliteTenantAdministration(db, operations, binding));
    await operations.finish();
    db.exec('COMMIT');
  } finally {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.close();
  }
}

/* Custom components: a section on the listing's page and a free-form
   showroom, which a visitor reads; a section on the note's page and a desk page,
   which only a member does. Served as files, as a compile would make them. */
const COMPONENT = (id: string, kind: string) => ({ id, module: `./widgets/${id}.tsx`, kind });
const COMPONENT_FILES: CompiledComponents = {
  entries: Object.fromEntries(
    (
      [
        ['sticker', 'section'],
        ['showroom', 'page'],
        ['memo', 'section'],
        ['desk', 'page'],
      ] as const
    ).map(([id, kind]) => [id, { kind, js: `${id}-0123456789ab.js`, sources: [`widgets/${id}.tsx`] }]),
  ),
  files: Object.fromEntries(
    ['sticker', 'showroom', 'memo', 'desk'].flatMap((id) => [
      [`${id}-0123456789ab.js`, `export default function C() { return ${JSON.stringify(id)}; }\n`],
      [`${id}-0123456789ab.js.map`, '{}'],
    ]),
  ),
};
const COMPONENT_VIEWS = {
  showroom: { kind: 'page', label: 'Showroom', component: COMPONENT('showroom', 'page'), reads: ['listing'], public: true },
  desk: { kind: 'page', label: 'Desk', component: COMPONENT('desk', 'page'), reads: ['note'] },
};

const appConfig = (directory: string, overrides: Record<string, unknown> = {}, views: Record<string, unknown> = {}) => ({
  id: appId,
  name: 'Lot',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    make: { owner: 'global' },
    listing: { owner: 'tenant' },
    photo: { owner: 'tenant' },
    note: { owner: 'tenant' },
  },
  auth: {
    store: join(directory, 'auth.db'),
    signUp: 'open',
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
    public: {
      read: ['listing', 'photo', 'make'],
      // `cost` is the dealer's own: never a visitor's.
      fields: { listing: { read: ['id', 'make_id', 'title', 'price', 'published'] } },
    },
    ...overrides,
  },
  views: {
    listings: { kind: 'list', from: 'listing' },
    notes: { kind: 'list', from: 'note' },
    ...views,
  },
  home: [{ view: 'listings', signedOut: true }, { view: 'notes' }],
  ...(Object.keys(views).length
    ? { nav: [{ id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['listings', 'notes', ...Object.keys(views)] }] }
    : {}),
});
const app = (directory: string, overrides: Record<string, unknown> = {}, views: Record<string, unknown> = {}) =>
  parseTestApp(appConfig(directory, overrides, views), 'public reads fixture');

interface FixtureOptions {
  readonly suspend?: 'west' | 'north' | '@platform';
  /** Run inside the policy's callback, after the address placed the visitor and before any SQL. */
  readonly during?: (business: string) => Promise<void> | void;
  /** The App places custom components (COMPONENT_FILES). */
  readonly components?: true;
  /** The App is loaded from a directory with English and Spanish catalogs, its list's label a message. */
  readonly words?: true;
}
/* The fixture's App as an App directory loads it: a manifest whose list says a message, and its catalogs. */
async function wordsApp(directory: string) {
  const config = appConfig(directory);
  const manifest = { ...config, views: { ...config.views, listings: { ...config.views.listings, label: { message: 'lot.listings' } } } };
  const dir = join(directory, 'words-app');
  mkdirSync(join(dir, 'messages'), { recursive: true });
  writeFileSync(join(dir, 'app.json'), JSON.stringify(manifest));
  const catalog = (locale: string, entries: Record<string, string>) =>
    `export default ${JSON.stringify({ kind: 'messages', locale, entries })};\n`;
  writeFileSync(join(dir, 'messages', 'en.mjs'), catalog('en', { 'lot.listings': 'Listings' }));
  writeFileSync(join(dir, 'messages', 'es.mjs'), catalog('es', { 'lot.listings': 'Anuncios' }));
  return (await loadApp(dir, { lock: 'report' })).app;
}

async function fixture(t: TestContext, options: FixtureOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-public-reads-'));
  const business = join(directory, 'business.db');
  const db = new DatabaseSync(business);
  try {
    db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;
      CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, public_address TEXT);
      CREATE TABLE make (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, shown INTEGER NOT NULL);
      CREATE TABLE listing (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), make_id TEXT REFERENCES make(id),
        title TEXT NOT NULL, price INTEGER NOT NULL, cost INTEGER NOT NULL, published INTEGER NOT NULL);
      CREATE TABLE photo (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id),
        listing_id TEXT NOT NULL REFERENCES listing(id), caption TEXT NOT NULL);
      CREATE TABLE note (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), body TEXT NOT NULL);
      INSERT INTO dealer VALUES ('north', 'North Motors', '${NORTH}'), ('west', 'West Wheels', '${WEST}');
      INSERT INTO make VALUES ('toyota', 'Toyota', 1), ('prototype', 'Prototype', 0);
      INSERT INTO listing VALUES
        ('n-1', 'north', 'toyota', 'North Corolla', 15000, 11111, 1),
        ('n-2', 'north', 'toyota', 'North Draft', 9000, 22222, 0),
        ('n-3', 'north', 'prototype', 'North Secret Make', 30000, 33333, 1),
        ('w-1', 'west', 'toyota', 'West Camry', 21000, 44444, 1);
      INSERT INTO photo VALUES ('p-n1', 'north', 'n-1', 'North front'), ('p-n2', 'north', 'n-2', 'North draft photo'),
        ('p-w1', 'west', 'w-1', 'West front');
      INSERT INTO note VALUES ('note-n', 'north', 'North private note');`);
  } finally {
    db.close();
  }
  provisionSqliteTenantStore(business, binding);
  migrateSqliteCommandJournal(business);
  await maintain(business, async (admin) => {
    for (const tenantId of ['north', 'west']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  if (options.suspend === '@platform')
    await maintain(business, (admin) => admin.putPlatform({ status: 'suspended', expectedVersion: '1' }));
  else if (options.suspend)
    await maintain(business, (admin) => admin.putTenant({ tenantId: options.suspend!, status: 'suspended', expectedVersion: '1' }));
  const port = await portFor(),
    origin = `http://127.0.0.1:${port}`;
  let auth: AppAuthRuntime | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  const front = createServer();
  t.after(async () => {
    try {
      front.closeAllConnections();
      await new Promise<void>((resolve) => front.close(() => resolve()));
      owner?.server.closeAllConnections();
      await owner?.retire();
    } finally {
      auth?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const loaded: LoadedApp = {
    path: join(directory, 'app.ts'),
    pages: parsePagesConfig(
      {
        pages: [
          {
            id: 'listing',
            label: 'Listing',
            base: 'listing',
            sections: [
              { kind: 'fields', show: ['title', 'price'] },
              { kind: 'list', from: 'photo', whose: 'listing_id', show: ['caption'] },
              ...(options.components ? [{ kind: 'custom', component: COMPONENT('sticker', 'section'), record: ['title'] }] : []),
            ],
          },
          {
            id: 'note',
            label: 'Note',
            base: 'note',
            sections: [
              { kind: 'fields', show: ['body'] },
              ...(options.components ? [{ kind: 'custom', component: COMPONENT('memo', 'section') }] : []),
            ],
          },
        ],
      },
      'public reads pages',
    ),
    sources: {},
    app: options.words ? await wordsApp(directory) : app(directory, {}, options.components ? COMPONENT_VIEWS : {}),
    ...(options.components ? { components: COMPONENT_FILES } : {}),
  };
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const saved = names.map((name) => process.env[name]);
  process.env.BETTER_AUTH_SECRET = 'synthetic-public-reads-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
  } finally {
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
  const asked: string[] = [];
  owner = await createTenantAuthenticatedHttpServer({
    loaded,
    auth,
    browser: true,
    bound: { host: '127.0.0.1', port, allowedHosts: ['north.example.test'] },
    enrollment: {
      policy: defineAppTenantPolicy({
        kind: 'tenant',
        appId,
        storeId: binding.storeId,
        ownership: {
          dealer: { kind: 'platform' },
          make: { kind: 'global', access: 'read-only' },
          listing: { kind: 'tenant', column: 'tenant_id' },
          photo: { kind: 'tenant', column: 'tenant_id' },
          note: { kind: 'tenant', column: 'tenant_id' },
        },
        resolveMembershipRows: () => everything,
        resolveRows: () => everything,
        resolvePlatformRows: () => everything,
        public: { address: 'public_address' },
        async resolvePublicRows(visitor) {
          asked.push(visitor.tenantId);
          await options.during?.(business);
          // A callback that asks for everything still reads one tenant's rows: the runtime adds the tenant.
          return published();
        },
      }),
      source: { ...binding.source, existingPath: business },
      deployment: 'public-reads-generation',
      roles: ['staff', 'manager'],
      maxLifetimeMs: 60000,
    },
  });
  // The operator's mapped hosts, as the suite listener routes them (tenantHosts.ts).
  const router = createTenantHostRouter([{ host: 'north.example.test', app: appId, tenant: 'north' }]);
  front.on('request', (req, res) => {
    if (!router.accept(req)) {
      res.writeHead(403).end();
      return;
    }
    owner!.server.emit('request', req, res);
  });
  front.listen(port, '127.0.0.1');
  await once(front, 'listening');
  const call = (
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    host = `127.0.0.1:${port}`,
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string; body: any }> =>
    new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path,
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            host,
            origin: `http://${host}`,
            ...(payload ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = undefined;
            }
            resolve({ status: res.statusCode!, headers: res.headers, text, body: parsed });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  return { call, origin, business, asked };
}
const via = (address: string, path: string) => `${path}${path.includes('?') ? '&' : '?'}via=${encodeURIComponent(address)}`;
const tenantHeaders = (response: { headers: Record<string, unknown> }) =>
  Object.keys(response.headers).filter((name) => name.startsWith('x-tablewalk'));
const rows = (response: { body: any }) => (response.body?.rows ?? []) as Array<Record<string, unknown>>;
const filterId = (id: string) => ({ groups: [[{ column: 'id', op: '=', value: id }]] });

/* Each door a visitor reads by, asked about one listing by its key. */
const doors = (id: string): Array<[string, unknown]> => [
  ['/api/query', { table: 'listing', filter: filterId(id) }],
  ['/api/count', { table: 'listing', filter: filterId(id) }],
  ['/api/counts', { items: [`listing id = ${id}`] }],
  ['/api/run', { q: `listing id = ${id}` }],
  ['/api/view/run', { text: `listing id = ${id} show id, title` }],
  ['/api/breakdown', { text: `listing id = ${id} count by title` }],
  ['/api/breakdowns', { items: [{ text: `listing id = ${id} count by title` }] }],
  ['/api/references', { table: 'listing', key: { id } }],
  ['/api/pages/plan', { page: 'listing', key: { id } }],
  ['/api/pages/compose', { page: 'listing', key: { id } }],
  ['/api/pages/load', { page: 'listing', params: { id } }],
  ['/api/file/read', { table: 'listing', key: { id }, variant: 'original', inline: true }],
];

test('a visitor reads one tenant’s published rows by its address, and no column the grant leaves out', async (t) => {
  const f = await fixture(t);
  const me = await f.call(via(NORTH, `/api/whoami?app=${appId}`));
  assert.equal(me.status, 200);
  assert.equal(me.body.signedIn, false);
  assert.equal(me.body.public, true);
  assert.equal(me.body.tenantPublic, true);
  assert.equal(me.body.tenant, undefined, 'the visitor is not offered a tenant chooser');
  assert.doesNotMatch(me.text, /north|North/);

  const list = await f.call(via(NORTH, '/api/query'), { table: 'listing' });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(
    rows(list)
      .map((row) => row.id)
      .sort(),
    ['n-1', 'n-3'],
  );
  for (const row of rows(list)) {
    assert.equal(Object.hasOwn(row, 'cost'), false, 'an undeclared column is never read');
    assert.equal(Object.hasOwn(row, 'tenant_id'), false, 'the ownership column is never read');
  }
  assert.doesNotMatch(list.text, /West|Draft|11111|33333/);
  assert.deepEqual(tenantHeaders(list), []);
  assert.equal(list.headers['cache-control'], 'no-store');
  assert.equal(list.headers['referrer-policy'], 'no-referrer');
  assert.equal(list.headers['x-robots-tag'], 'noindex');

  // Asking for the undeclared column by name, filtering or sorting on it: refused, never answered.
  for (const [path, body] of [
    ['/api/query', { table: 'listing', columns: ['id', 'cost'] }],
    ['/api/query', { table: 'listing', filter: { groups: [[{ column: 'cost', op: '>', value: 0 }]] } }],
    ['/api/query', { table: 'listing', orderBy: [{ column: 'cost', dir: 'desc' }] }],
    ['/api/query', { table: 'listing', filter: { groups: [[{ column: 'tenant_id', op: '=', value: 'west' }]] } }],
    ['/api/run', { q: 'listing cost > 0' }],
    ['/api/breakdown', { text: 'listing count by cost' }],
  ] as const) {
    const answer = await f.call(via(NORTH, path), body);
    // Refused, or (the query language) answered with an error and no rows.
    assert.ok(answer.status !== 200 || (answer.body.errors?.length > 0 && !answer.body.rows?.length), `${path} ${JSON.stringify(body)}`);
    assert.doesNotMatch(answer.text, /11111|22222|33333|44444|West/);
  }

  // Global rows the callback allows, and none it hides.
  const makes = await f.call(via(NORTH, '/api/query'), { table: 'make' });
  assert.deepEqual(
    rows(makes).map((row) => row.id),
    ['toyota'],
  );
  // The same address on the second tenant's row: its own rows only.
  const west = await f.call(via(WEST, '/api/query'), { table: 'listing' });
  assert.deepEqual(
    rows(west).map((row) => row.id),
    ['w-1'],
  );

  // An unlisted resource and the platform's are neither listed nor read.
  const schema = await f.call(via(NORTH, '/api/schema'));
  assert.equal(schema.status, 200);
  const tables = (schema.body.tables as Array<{ id: string; columns: Array<{ name: string }> }>).map((table) => table.id).sort();
  assert.deepEqual(tables, ['listing', 'make', 'photo']);
  const listing = (schema.body.tables as Array<{ id: string; columns: Array<{ name: string }> }>).find((table) => table.id === 'listing')!;
  assert.deepEqual(
    listing.columns.map((column) => column.name).filter((name) => name === 'cost' || name === 'tenant_id'),
    [],
  );
  for (const table of ['note', 'dealer']) {
    const answer = await f.call(via(NORTH, '/api/query'), { table });
    assert.equal(answer.status, 404, `${table}: ${answer.text}`);
    assert.deepEqual(answer.body, { error: 'Not found.', code: 'not_found' });
  }
  const metadata = await f.call(via(NORTH, `/api/app?app=${appId}`));
  assert.equal(metadata.status, 200, metadata.text);
  assert.doesNotMatch(metadata.text, /"notes"|North private|public_address|north-public/);
  const pages = await f.call(via(NORTH, '/api/pages'));
  assert.deepEqual(
    (pages.body.pages as Array<{ id: string }>).map((page) => page.id),
    ['listing'],
  );
});

test('with one tenant’s address, another tenant’s row by key answers on every door exactly as a missing row', async (t) => {
  const f = await fixture(t);
  // A read's own timing ("ms") is no part of what it answers; under load the two reads differ by a millisecond.
  const normalize = (text: string, id: string) =>
    text
      .split(id)
      .join('<id>')
      .replace(/"ms":\d+/g, '"ms":<ms>');
  for (const hidden of ['w-1', 'n-2', 'n-3']) {
    const doorsFor = doors(hidden),
      missing = doors('missing-1');
    for (let i = 0; i < doorsFor.length; i++) {
      const [path, body] = doorsFor[i]!;
      const asked = await f.call(via(NORTH, path), body);
      const absent = await f.call(via(NORTH, path), missing[i]![1]);
      // n-3 is published but its make is hidden: the row itself is the visitor's, so only its make's label is absent.
      if (hidden === 'n-3' && asked.status === 200) continue;
      assert.equal(asked.status, absent.status, `${hidden} ${path}: ${asked.text} / ${absent.text}`);
      assert.equal(normalize(asked.text, hidden), normalize(absent.text, 'missing-1'), `${hidden} ${path}`);
      assert.doesNotMatch(asked.text, /West|Draft|44444|22222/);
      assert.deepEqual(tenantHeaders(asked), []);
    }
  }
});

test('hidden rows are absent from lists, counts, breakdowns, references and record pages', async (t) => {
  const f = await fixture(t);
  const count = await f.call(via(NORTH, '/api/count'), { table: 'listing' });
  assert.equal(count.status, 200, count.text);
  assert.equal(count.body.count, 2);
  const counts = await f.call(via(NORTH, '/api/counts'), { items: ['listing', 'photo', 'make'] });
  assert.deepEqual(
    (counts.body.results as Array<{ total: number }>).map((result) => result.total),
    [2, 2, 1],
  );
  const breakdown = await f.call(via(NORTH, '/api/breakdown'), { text: 'listing count by make_id' });
  assert.equal(breakdown.status, 200, breakdown.text);
  // The listing's own key value is the visitor's; the hidden make's label is not.
  assert.doesNotMatch(breakdown.text, /Prototype/, 'a hidden global row gives no label');
  assert.deepEqual(breakdown.body.names, { make_id: { toyota: 'Toyota' } });
  const total = (breakdown.body.rows as Array<Record<string, unknown>>).reduce((sum, row) => sum + Number(Object.values(row).at(-1)), 0);
  assert.equal(total, 2);
  // Toyota's listings, as a visitor of north sees them: n-1 only — not north's draft, not west's.
  const references = await f.call(via(NORTH, '/api/references'), { table: 'make', key: { id: 'toyota' } });
  assert.equal(references.status, 200, references.text);
  const listingRefs = (references.body.references as Array<{ table: string; count: number }>).find((ref) => ref.table === 'listing');
  assert.equal(listingRefs?.count, 1);
  const photos = await f.call(via(NORTH, '/api/references'), { table: 'listing', key: { id: 'n-1' } });
  assert.equal((photos.body.references as Array<{ table: string; count: number }>).find((ref) => ref.table === 'photo')?.count, 1);
  const plan = await f.call(via(NORTH, '/api/pages/plan'), { page: 'listing', key: { id: 'n-1' } });
  assert.equal(plan.status, 200, plan.text);
  const compose = await f.call(via(NORTH, '/api/pages/compose'), { page: 'listing', key: { id: 'n-1' } });
  assert.equal(compose.status, 200, compose.text);
  assert.match(compose.text, /North Corolla/);
  assert.doesNotMatch(compose.text, /West|11111|North draft photo/);
  // A page of an unlisted resource is not the visitor's to plan.
  const note = await f.call(via(NORTH, '/api/pages/plan'), { page: 'note', key: { id: 'note-n' } });
  assert.equal(note.status, 404);
});

test('an unknown, malformed or doubled address, a suspended tenant and a suspended platform all answer one identical 404', async (t) => {
  const answers: string[] = [];
  const shape = (answer: { status: number; headers: Record<string, unknown>; text: string }) =>
    JSON.stringify([
      answer.status,
      Object.keys(answer.headers)
        .filter((name) => name !== 'date' && name !== 'connection' && name !== 'keep-alive')
        .sort(),
      answer.text,
    ]);
  const f = await fixture(t, { suspend: 'west' });
  for (const path of [
    via(UNKNOWN, '/api/query'),
    via('north', '/api/query'),
    via('bad address with spaces and more!!', '/api/query'),
    `${via(NORTH, '/api/query')}&via=${NORTH}`,
    via(WEST, '/api/query'),
  ])
    answers.push(shape(await f.call(path, { table: 'listing' })));
  const g = await fixture(t, { suspend: '@platform' });
  answers.push(shape(await g.call(via(NORTH, '/api/query'), { table: 'listing' })));
  assert.equal(new Set(answers).size, 1, answers.join('\n'));
  assert.match(answers[0]!, /^\[404,/);
  // Who-am-I names no tenant either way: a placement is the reads' to judge.
  const me = await f.call(via(UNKNOWN, `/api/whoami?app=${appId}`));
  assert.deepEqual(me.body, (await f.call(via(NORTH, `/api/whoami?app=${appId}`))).body);
});

test('an address rotated, or a tenant suspended, while a read is in flight yields no rows', async (t) => {
  let rotate = false;
  const f = await fixture(t, {
    during(business) {
      if (!rotate) return;
      const db = new DatabaseSync(business);
      try {
        db.prepare('UPDATE dealer SET public_address = ? WHERE id = ?').run(ROTATED, 'north');
      } finally {
        db.close();
      }
    },
  });
  assert.equal((await f.call(via(NORTH, '/api/query'), { table: 'listing' })).status, 200);
  rotate = true;
  const rotated = await f.call(via(NORTH, '/api/query'), { table: 'listing' });
  assert.equal(rotated.status, 404, rotated.text);
  assert.doesNotMatch(rotated.text, /North/);
  rotate = false;
  assert.equal((await f.call(via(NORTH, '/api/query'), { table: 'listing' })).status, 404, 'the old address is gone');
  assert.equal((await f.call(via(ROTATED, '/api/query'), { table: 'listing' })).status, 200);

  let suspend = false;
  const g = await fixture(t, {
    async during(business) {
      if (!suspend) return;
      await maintain(business, (admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
    },
  });
  suspend = true;
  const suspended = await g.call(via(NORTH, '/api/query'), { table: 'listing' });
  assert.equal(suspended.status, 404, suspended.text);
  assert.doesNotMatch(suspended.text, /North/);
});

test('an address beside a lease, a tenant, a realm or a bearer is refused, and opens no write or command', async (t) => {
  const f = await fixture(t);
  const query = { table: 'listing' };
  assert.equal((await f.call(`${via(NORTH, '/api/query')}&tenant=north`, query)).status, 400);
  assert.equal((await f.call(`${via(NORTH, '/api/query')}&realm=platform`, query)).status, 400);
  for (const header of ['x-mistri-tenant', 'x-mistri-tab', 'x-mistri-context', 'x-mistri-lease-revision', 'x-mistri-realm']) {
    const answer = await f.call(via(NORTH, '/api/query'), query, { [header]: 'north' });
    assert.equal(answer.status, 400, header);
    assert.doesNotMatch(answer.text, /North/);
  }
  assert.equal((await f.call(via(NORTH, '/api/query'), query, { authorization: 'Bearer abc' })).status, 403);
  for (const path of [
    '/api/insert',
    '/api/update',
    '/api/delete',
    '/api/commands/execute',
    '/api/commands/plan',
    '/api/export',
    '/api/history',
  ]) {
    const answer = await f.call(via(NORTH, path), { table: 'listing', values: { title: 'x' } });
    assert.equal(answer.status, 403, `${path}: ${answer.text}`);
  }
  const db = new DatabaseSync(f.business, { readOnly: true });
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM listing').get() as { n: number }).n, 4);
  } finally {
    db.close();
  }
  // Without an address or a mapped host, a read is a member's, and a visitor holds no lease.
  assert.notEqual((await f.call('/api/query', query)).status, 200);
});

test('on a mapped host the host places the visitor, and an address there is refused', async (t) => {
  const f = await fixture(t);
  const host = 'north.example.test';
  const list = await f.call('/api/query', { table: 'listing' }, {}, host);
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(
    rows(list)
      .map((row) => row.id)
      .sort(),
    ['n-1', 'n-3'],
  );
  assert.equal((await f.call(via(NORTH, '/api/query'), { table: 'listing' }, {}, host)).status, 400);
  assert.equal((await f.call(via(WEST, '/api/query'), { table: 'listing' }, {}, host)).status, 400);
  const me = await f.call(`/api/whoami?app=${appId}`, undefined, {}, host);
  assert.equal(me.body.tenantPublic, true);
  // A write on a mapped host is not a visitor's.
  assert.equal((await f.call('/api/insert', { table: 'listing', values: {} }, {}, host)).status, 403);
});

test('startup refuses a platform-owned resource in auth.public, and public reads without their policy half', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-public-reads-startup-'));
  try {
    assert.throws(() => app(directory, { public: { read: ['listing', 'dealer'] } }), /"dealer", a platform-owned resource/);
    assert.throws(
      () =>
        defineAppTenantPolicy({
          kind: 'tenant',
          appId,
          storeId: binding.storeId,
          ownership: { dealer: { kind: 'platform' }, listing: { kind: 'tenant', column: 'tenant_id' } },
          resolveMembershipRows: () => everything,
          resolveRows: () => everything,
          resolvePlatformRows: () => everything,
          public: { address: 'public_address' },
        } as never),
      /could not be loaded or is invalid/,
    );
    assert.throws(
      () =>
        defineAppTenantPolicy({
          kind: 'tenant',
          appId,
          storeId: binding.storeId,
          ownership: { dealer: { kind: 'platform' }, listing: { kind: 'tenant', column: 'tenant_id' } },
          resolveMembershipRows: () => everything,
          resolveRows: () => everything,
          resolvePlatformRows: () => everything,
          resolvePublicRows: () => ({}),
        } as never),
      /could not be loaded or is invalid/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a visitor is served the components its public pages draw, and no other', async (t) => {
  const f = await fixture(t, { components: true });
  const served = await f.call(via(NORTH, `/api/app?app=${appId}`));
  assert.equal(served.status, 200, served.text);
  // The listing's section and the public showroom: the note's section and the desk are a member's.
  assert.deepEqual(Object.keys(served.body.app.components ?? {}).sort(), ['showroom', 'sticker']);
  assert.equal(served.body.app.components.showroom.href, `/${appId}/_components/showroom-0123456789ab.js`);
  assert.ok(served.body.app.views.showroom, 'the public page is the visitor’s');
  assert.equal(served.body.app.views.desk, undefined);
  // The code is served signed out, as the page loads it (no address rides on a module's import).
  const code = await f.call(`/${appId}/_components/showroom-0123456789ab.js`);
  assert.equal(code.status, 200);
  assert.match(code.text, /return "showroom"/);
  assert.equal((await f.call(`/${appId}/_components/sticker-0123456789ab.js`)).status, 200);
  // Never a member's component, and never a source map, which carries the App's own source.
  for (const file of ['memo-0123456789ab.js', 'desk-0123456789ab.js', 'showroom-0123456789ab.js.map'])
    assert.equal((await f.call(`/${appId}/_components/${file}`)).status, 404, file);
});

test("a visitor with a Spanish browser is said the App's Spanish words, by its address too", async (t) => {
  const f = await fixture(t, { words: true });
  const es = await f.call(via(NORTH, `/api/app?app=${appId}`), undefined, { 'accept-language': 'es-ES,es;q=0.9' });
  assert.equal(es.status, 200, es.text);
  assert.equal(es.body.app.views.listings.label, 'Anuncios');
  assert.equal(es.body.app.ui.locale, 'es-ES', 'the resolved tag is served, so the shell and figures follow');
  assert.match(String(es.headers.vary), /Accept-Language/);
  const de = await f.call(via(NORTH, `/api/app?app=${appId}`), undefined, { 'accept-language': 'de' });
  assert.equal(de.body.app.views.listings.label, 'Listings', "a language with no catalog is said in the App's own");
  // A pick kept in this browser outweighs the header, as it does for a single App's visitor.
  const picked = await f.call(via(NORTH, `/api/app?app=${appId}`), undefined, {
    'accept-language': 'en',
    cookie: `mistri-locale-${appId}=es`,
  });
  assert.equal(picked.body.app.views.listings.label, 'Anuncios');
});

/* A visitor's list pages by key as a member's does (shared/keysetPage.ts): `after` and `before` were not fields
   the public lane's /api/run took, so every Next page on a published list was refused. */
test('a visitor’s list pages by key, within the placed tenant’s published rows', async (t) => {
  const f = await fixture(t);
  const q = 'listing sort title show title';
  const first = await f.call(via(NORTH, '/api/run'), { q, limit: 1, offset: 0, count: 'none' });
  assert.equal(first.status, 200, first.text);
  assert.deepEqual(
    rows(first).map((row) => row.title),
    ['North Corolla'],
  );
  const next = await f.call(via(NORTH, '/api/run'), { q, limit: 5, offset: 1, count: 'none', after: first.body.bounds.last });
  assert.equal(next.status, 200, next.text);
  assert.equal(next.body.keyset, true);
  // The draft between them is unpublished and West's sorts last: neither is past the boundary for this visitor.
  assert.deepEqual(
    rows(next).map((row) => row.title),
    ['North Secret Make'],
  );
  assert.doesNotMatch(next.text, /West|Draft|11111|33333/);
  const back = await f.call(via(NORTH, '/api/run'), { q, limit: 5, offset: 0, count: 'none', before: next.body.bounds.first });
  assert.equal(back.status, 200, back.text);
  assert.deepEqual(
    rows(back).map((row) => row.title),
    ['North Corolla'],
  );
});
