import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../packages/engine/src/server/cli/args.js';
import { assertApiReadStartupComposition } from '../packages/mistri/src/server/cli/api-read-startup-options.js';
import { apiReadStartupOptions, exposureLines } from '../packages/engine/src/server/cli/startupOptions.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const flags = ['--api-reads', '--api-integers', 'decimal-string', '--api-requests-per-minute', '60'];
test('explicit read options preserve defaults/export and require both choices without coercion', () => {
  assert.equal(apiReadStartupOptions(parseArgs([])), undefined);
  assert.equal(apiReadStartupOptions(parseArgs(['--export', 'openapi', '--api-integers', 'number'])), undefined);
  assert.deepEqual(apiReadStartupOptions(parseArgs(flags)), { integers: 'decimal-string', requestsPerMinute: 60 });
  for (const args of [
    ['--api-reads'],
    ['--api-integers', 'number'],
    ['--api-requests-per-minute', '60'],
    ['--export', 'openapi'],
    ...['0', '-1', '1e2', '1.5', '01', '1000001', 'Infinity'].map((rate) => flags.slice(0, -1).concat(rate)),
  ]) {
    assert.throws(() => apiReadStartupOptions(parseArgs(args)), args.join(' '));
  }
  for (const duplicate of [['--api-reads'], ['--api-integers', 'number'], ['--api-requests-per-minute', '50']]) {
    assert.ok(parseArgs([...flags, ...duplicate]).unknown);
  }
});

test('read startup rejects one-shot modes and a proxy identity header early', () => {
  for (const extra of [
    ['--mcp'],
    ['--export', 'openapi'],
    ['--demo'],
    ['--lint'],
    ['--from-openapi', 'spec.json'],
    ['--openapi', 'spec.json'],
    ['--auth-proxy-header', 'X-User'],
  ])
    assert.throws(() => apiReadStartupOptions(parseArgs([...flags, ...extra])), extra.join(' '));
  // Listening beyond loopback is the operator's half of the network opt-in: said, never refused here.
  for (const extra of [
    ['--host', '0.0.0.0'],
    ['--allowed-host', 'example.test'],
  ])
    assert.deepEqual(apiReadStartupOptions(parseArgs([...flags, ...extra])), {
      integers: 'decimal-string',
      requestsPerMinute: 60,
      network: true,
    });
  // --trust-proxy is resolved to ranges by main; the flag alone already means a proxy in front.
  assert.equal(apiReadStartupOptions(parseArgs([...flags, '--trust-proxy', '127.0.0.1']))?.network, true);
  assert.equal(apiReadStartupOptions(parseArgs([...flags, '--host', '::1']))?.network, undefined);
  // --policy is the App's to decide (a tenant App's host), not the flags'.
  assert.deepEqual(apiReadStartupOptions(parseArgs([...flags, '--policy', 'policy.mjs'])), {
    integers: 'decimal-string',
    requestsPerMinute: 60,
  });
});

test('a tenant or row-policy App is served under --policy only; an ordinary App takes no --policy', () => {
  const tenant = parseAppConfig(
    {
      id: 'depot',
      name: 'Depot',
      auth: { providers: ['email'], store: '/missing/auth.db', rows: 'tenant', roles: { member: { read: true } } },
      sources: { business: { connection: 'data' } },
      resources: { item: { physical: 'item', owner: 'tenant', fields: { read: ['id', 'name'] } } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      api: { version: 1, roles: ['member'], resources: { item: { fields: ['id', 'name'], sorts: ['id'] } } },
    },
    'test',
  );
  const ordinary = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      connection: 'data',
      resources: { item: {} },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      auth: { store: '/missing/auth.db', roles: { reader: { read: true } } },
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
    },
    'test',
  );
  const connection = { id: 'data', name: 'data', url: '/missing/data.db', source: 'config' as const };
  const loaded = (app: typeof tenant) => ({ app, path: '/missing/app.json', pages: [], sources: {} });
  assert.equal(assertApiReadStartupComposition([loaded(tenant)], [connection], false, true), 'sqlite');
  assert.throws(() => assertApiReadStartupComposition([loaded(tenant)], [connection]), /under its --policy/);
  assert.throws(
    () => assertApiReadStartupComposition([loaded(ordinary)], [connection], false, true),
    /only for a tenant or row-policy App/,
  );
  // A row-policy App's API runs under its policy, and only under it.
  const rowPolicy = { ...ordinary, auth: { ...ordinary.auth!, rows: 'policy' as const } };
  assert.equal(assertApiReadStartupComposition([loaded(rowPolicy)], [connection], false, true), 'sqlite');
  assert.throws(() => assertApiReadStartupComposition([loaded(rowPolicy)], [connection]), /row-policy App under its --policy/);
});

test('composition checks select exact literal SQLite inputs without opening or defaulting to active', () => {
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      connection: 'data',
      resources: { item: {} },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      auth: { store: '/missing/auth.db', roles: { reader: { read: true } } },
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
    },
    'test',
  );
  const loaded = { app, path: '/missing/app.json', pages: [], sources: {} };
  const connection = { id: 'data', name: 'data', url: '/missing/data.db', source: 'config' as const };
  assert.doesNotThrow(() => assertApiReadStartupComposition([loaded], [connection]));
  assert.throws(() => assertApiReadStartupComposition([], [connection]));
  assert.throws(() => assertApiReadStartupComposition([loaded, loaded], [connection]));
  assert.throws(() => assertApiReadStartupComposition([loaded], [{ ...connection, id: 'other', name: 'other' }]));
  assert.throws(() => assertApiReadStartupComposition([loaded], [connection, { ...connection, id: 'other' }]));
  for (const url of ['postgres://host/db', 'mysql://host/db', '${DB}', '$DB', 'sqlite:/data.db']) {
    assert.throws(() => assertApiReadStartupComposition([loaded], [{ ...connection, url }]));
  }
  assert.throws(() => assertApiReadStartupComposition([{ ...loaded, app: { ...app, auth: undefined } }], [connection]));
  assert.equal(assertApiReadStartupComposition([loaded], [connection]), 'sqlite');
  // Beyond loopback needs both halves: the operator's listener and the App's own declaration.
  assert.throws(
    () => assertApiReadStartupComposition([loaded], [connection], false, false, true),
    /beyond loopback .* only for an App whose api declares network: true/,
  );
  const networked = { ...loaded, app: { ...app, api: { ...app.api!, network: true as const } } };
  assert.equal(assertApiReadStartupComposition([networked], [connection], false, false, true), 'sqlite');
});

test('PostgreSQL composition needs explicit URLs for both the business source and the native auth store', () => {
  const app = parseAppConfig(
    {
      id: 'app',
      name: 'App',
      connection: 'data',
      resources: { item: {} },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      auth: { store: 'postgres://auth@db.internal:5432/auth', roles: { reader: { read: true } } },
      api: { version: 1, roles: ['reader'], resources: { item: { fields: ['id'] } } },
    },
    'test',
  );
  const loaded = { app, path: '/missing/app.json', pages: [], sources: {} };
  const connection = { id: 'data', name: 'data', url: 'postgres://app@db.internal:5432/data?sslmode=require', source: 'config' as const };
  assert.equal(assertApiReadStartupComposition([loaded], [connection]), 'postgres');
  // Implicit user/port, identity-overriding parameters, unresolved references
  // and a SQLite business file beside a PostgreSQL store all refuse.
  for (const url of ['postgres://db.internal/data', 'postgres://app@db.internal:5432/data?host=elsewhere', '${DATABASE_URL}', '/data.db']) {
    assert.throws(() => assertApiReadStartupComposition([loaded], [{ ...connection, url }]), url);
  }
  const implicitStore = { ...loaded, app: { ...app, auth: { ...app.auth!, store: 'postgres://db.internal/auth' } } };
  assert.throws(() => assertApiReadStartupComposition([implicitStore], [connection]));
});

test('several sources: every connection the API reads is judged, and only those', () => {
  const app = parseAppConfig(
    {
      id: 'two',
      name: 'Two',
      sources: { sales: { connection: 'sales', default: true }, stock: { connection: 'stock' }, ledger: { connection: 'ledger' } },
      resources: { invoice: {}, 'stock.item': {}, 'ledger.entry': {} },
      views: { invoices: { kind: 'list', from: 'invoice' } },
      home: 'invoices',
      auth: { store: '/missing/auth.db', roles: { reader: { read: true } } },
      api: { version: 1, roles: ['reader'], resources: { invoice: { fields: ['id'] }, 'stock.item': { fields: ['id'] } } },
    },
    'test',
  );
  const loaded = { app, path: '/missing/app.json', pages: [], sources: {} };
  const at = (id: string, url: string) => ({ id, name: id, url, source: 'config' as const });
  const sqlite = [at('sales', '/missing/sales.db'), at('stock', '/missing/stock.db')];
  // The ledger is never read through the API: its engine is not the API's concern.
  assert.equal(assertApiReadStartupComposition([loaded], [...sqlite, at('ledger', 'mysql://host/ledger')]), 'sqlite');
  // An exposed source on another engine than the auth store's refuses, whichever it is.
  assert.throws(
    () =>
      assertApiReadStartupComposition([loaded], [sqlite[0], at('stock', 'postgres://u@host:5432/stock'), at('ledger', '/missing/l.db')]),
    /unambiguous literal SQLite business and native auth file paths/,
  );
  assert.throws(() => assertApiReadStartupComposition([loaded], [sqlite[0], at('ledger', '/missing/l.db')]));
});

test('beyond loopback, the warning says what is read without signing in: the database, an open App, or nothing an App does not open (OP8)', () => {
  const desk = { name: 'Desk', auth: {} };
  const shop = { name: 'Shop', auth: { public: { read: ['vehicle', 'dealer'] } } };
  const tick = { name: 'Tick' };
  for (const host of ['127.0.0.1', 'localhost', '::1']) assert.deepEqual(exposureLines(host, [tick]), [], host);
  const remedy = 'Bind --host 127.0.0.1, put it behind a proxy that signs people in (--auth-proxy-header), or give the App sign-in.';
  assert.deepEqual(exposureLines('0.0.0.0', []), [
    `Warning: bound to 0.0.0.0, beyond loopback, with no sign-in. Anyone who can reach this port can read the database. ${remedy}`,
  ]);
  assert.deepEqual(exposureLines('0.0.0.0', [desk]), [
    'mistri: bound beyond loopback; "Desk" signs people in, and a signed-out visitor reads nothing but what its public forms show.',
  ]);
  assert.deepEqual(exposureLines('0.0.0.0', [shop, tick]), [
    'mistri: bound beyond loopback; "Shop" signs people in, and a signed-out visitor reads only what auth.public opens (vehicle, dealer) and its public forms show.',
    `Warning: bound to 0.0.0.0, beyond loopback, and "Tick" signs no one in: anyone who can reach this port reads what it shows. ${remedy}`,
  ]);
  assert.ok(!exposureLines('0.0.0.0', [desk]).some((line) => /read the database/.test(line)));
});

test('behind an auth proxy nothing beyond loopback is read without its identity, so no warning says anyone can (SSRF-4)', () => {
  assert.deepEqual(exposureLines('0.0.0.0', [], 'X-Forwarded-User'), []);
  assert.deepEqual(exposureLines('0.0.0.0', [{ name: 'Tick' }], 'X-Forwarded-User'), []);
  assert.equal(exposureLines('0.0.0.0', [{ name: 'Tick' }]).length, 1);
});
