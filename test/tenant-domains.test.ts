/**
 * Tenant domains, phase D1 (docs/tenant-domains.md): the host table in the tenant store, the suite's `tenantDomain`
 * wildcard parent read through a cache, a subdomain claimed when a tenant is made, and `mistri tenant host`. SQLite
 * always; the PostgreSQL store's layout is held by test/store-upgrades.test.ts where TABLEWALK_TEST_PG names a server.
 * Sign-in on a tenant's host is D2's, so here it is still refused exactly as on a mapped host.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import * as maintenance from '@mistriwork/mistri/maintenance';
import { hostRefusal } from '../packages/engine/src/server/http/trust.js';
import { openMigrationDb } from '../packages/engine/src/server/migrate/database.js';
import { createSuite } from '../packages/mistri/src/server/http/suite.js';
import {
  createTenantHostRouter,
  getTenantHostIntent,
  slugLabel,
  tenantDomainAdvisory,
  validateTenantDomain,
} from '../packages/mistri/src/server/http/tenantHosts.js';
import { readSuiteTenantDomain } from '../packages/mistri/src/server/cli/suiteConfig.js';
import { STORES, upgradeStores } from '../packages/mistri/src/server/storeLayouts.js';
import {
  listTenantHosts,
  putTenant,
  putTenantHost,
  removeTenantHost,
  seedTenantHosts,
  setPrimaryTenantHost,
  TenantMaintenanceRefusal,
} from '../packages/mistri/src/server/tenant/tenantMaintenance.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { assertSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { ADMINISTRATION_JOURNAL_TABLES as journal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { liveSkip } from './live.js';
import { applyFixture, describeUrl, ENGINES, fixturePath, LIVE, PROVISION, scratch } from './support/storeLayouts.js';

const binding = { appId: 'store', source: { id: 'business', connection: 'db' }, storeId: 'store-tenants' };
const DOMAIN = validateTenantDomain('yourapp.test', 'https://staff.yourapp.test')!;
const operator = 'ops';

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}
function raw(port: number, host: string, path = '/') {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let answer = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('HTTP test timed out.')));
    socket.on('error', reject);
    socket.on('data', (data) => (answer += data));
    socket.on('end', () =>
      resolve({ status: Number(/^HTTP\/1.1 (\d+)/.exec(answer)?.[1] ?? 0), body: answer.slice(answer.indexOf('\r\n\r\n') + 4) }),
    );
    socket.on('connect', () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
  });
}

async function store(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-domains-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'business.db');
  new DatabaseSync(path).close();
  await maintenance.provisionStores({ sqlite: path }, { app: { tenant: binding }, only: ['tenant-store', 'tenant-administration'] });
  const db = new DatabaseSync(path);
  t.after(() => db.close());
  const where = { sqlite: path };
  const tenants = () => (db.prepare(`SELECT id FROM __mistri_tenant_tenant ORDER BY id`).all() as { id: string }[]).map((row) => row.id);
  const receipts = () =>
    (
      db.prepare(`SELECT operation, tenant_id AS tenant FROM "${journal.receipt}" ORDER BY completed_at, rowid`).all() as {
        operation: string;
        tenant: string;
      }[]
    ).map((row) => `${row.operation}:${row.tenant}`);
  return { path, where, db, tenants, receipts };
}

test('tenantDomain validation: a registrable name, no IP, wildcard or URL, with the platform labels reserved', () => {
  assert.equal(validateTenantDomain(undefined), undefined);
  const plain = validateTenantDomain('YourApp.com', 'https://crm.yourapp.com')!;
  assert.equal(plain.domain, 'yourapp.com');
  for (const label of ['www', 'api', 'app', 'admin', 'mail', 'auth', 'static', 'assets', 'status', 'docs', 'crm'])
    assert.ok(plain.reserved.includes(label), label);
  const extra = validateTenantDomain({ domain: 'yourapp.com', reserved: ['billing'] })!;
  assert.ok(extra.reserved.includes('billing') && extra.reserved.includes('www'));
  for (const bad of [
    '*.yourapp.com',
    '10.0.0.1',
    'localhost',
    'yourapp',
    'https://yourapp.com',
    'yourapp.com:8080',
    '',
    42,
    null,
    [],
    { domain: 'a.com', x: 1 },
  ])
    assert.throws(() => validateTenantDomain(bad), /tenantDomain|hostname/, String(JSON.stringify(bad)));
  assert.throws(() => validateTenantDomain({ domain: 'yourapp.com', reserved: ['Bad Label'] }), /reserved/);
  assert.match(tenantDomainAdvisory(plain), /^Advisory: .*Public Suffix List/);
  assert.equal(slugLabel('Acme Dental_Group'), 'acme-dental-group');
  assert.equal(slugLabel('___'), undefined);
});

test('a suite file names its tenantDomain, and the staff host is never claimable under it', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-domains-config-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'suite.json');
  writeFileSync(
    file,
    JSON.stringify({ publicOrigin: 'https://crm.yourapp.test', tenantDomain: { domain: 'yourapp.test', reserved: ['billing'] }, apps: [] }),
  );
  const domain = (await readSuiteTenantDomain(file))!;
  assert.equal(domain.domain, 'yourapp.test');
  assert.ok(domain.reserved.includes('crm') && domain.reserved.includes('billing'));
  writeFileSync(file, JSON.stringify({ apps: [] }));
  assert.equal(await readSuiteTenantDomain(file), undefined);
  writeFileSync(file, JSON.stringify({ tenantDomain: '10.1.1.1' }));
  await assert.rejects(readSuiteTenantDomain(file), /registrable domain/);
});

test('the store holds hosts: a tenant claims its subdomain as it is made, and every change leaves a receipt', async (t) => {
  const s = await store(t);
  // No tenantDomain: no row, nothing claimed.
  assert.equal(
    (await putTenant(s.where, binding, { tenantId: 'plain', status: 'active', expectedVersion: null, operator })).host,
    undefined,
  );
  assert.deepEqual(await listTenantHosts(s.where, binding), []);

  const made = await putTenant(s.where, binding, {
    tenantId: 'acme',
    status: 'active',
    expectedVersion: null,
    operator,
    tenantDomain: DOMAIN,
  });
  assert.equal(made.host, 'acme.yourapp.test');
  const [row] = await listTenantHosts(s.where, binding);
  assert.ok(row!.createdAt > 0 && row!.createdAt <= Date.now());
  assert.deepEqual(
    { ...row },
    {
      host: 'acme.yourapp.test',
      tenantId: 'acme',
      app: 'store',
      kind: 'subdomain',
      status: 'live',
      primary: true,
      source: 'claimed',
      verifyToken: null,
      checkedAt: null,
      failures: 0,
      createdAt: row!.createdAt,
      unavailableSince: null,
    },
  );
  assert.deepEqual(s.receipts(), ['putTenant:plain', 'putTenant:acme', 'putTenantHost:acme']);

  // A chosen label; ids that are not DNS labels become one.
  assert.equal(
    (
      await putTenant(s.where, binding, {
        tenantId: 'north_dental',
        status: 'active',
        expectedVersion: null,
        operator,
        tenantDomain: DOMAIN,
      })
    ).host,
    'north-dental.yourapp.test',
  );
  assert.equal(
    (
      await putTenant(s.where, binding, {
        tenantId: 'south',
        status: 'active',
        expectedVersion: null,
        operator,
        tenantDomain: DOMAIN,
        subdomain: 'Sunny',
      })
    ).host,
    'sunny.yourapp.test',
  );

  // Reserved and taken labels refuse the whole step: the tenant is not made without its address.
  const before = s.tenants();
  for (const [tenantId, subdomain, why] of [
    ['wwwtenant', 'www', /reserved/],
    ['stafftenant', 'staff', /reserved/],
    ['dupe', 'acme', /taken/],
    ['badlabel', 'not a label', /not a usable subdomain/],
  ] as const)
    await assert.rejects(
      putTenant(s.where, binding, { tenantId, status: 'active', expectedVersion: null, operator, tenantDomain: DOMAIN, subdomain }),
      (error: Error) => error instanceof TenantMaintenanceRefusal && why.test(error.message),
      tenantId,
    );
  assert.deepEqual(s.tenants(), before);
  await assert.rejects(
    putTenant(s.where, binding, { tenantId: 'orphan', status: 'active', expectedVersion: null, operator, subdomain: 'orphan' }),
    /tenantDomain/,
  );

  // add, primary, remove.
  const added = await putTenantHost(s.where, binding, { tenantId: 'acme', operator, host: 'www.acme-dental.test' });
  assert.equal(added.host, 'www.acme-dental.test');
  await assert.rejects(setPrimaryTenantHost(s.where, binding, { tenantId: 'acme', host: 'acme.yourapp.test', operator }), /already/);
  await setPrimaryTenantHost(s.where, binding, { tenantId: 'acme', host: 'www.acme-dental.test', operator });
  assert.deepEqual(
    (await listTenantHosts(s.where, binding)).filter((each) => each.tenantId === 'acme').map((each) => [each.host, each.primary]),
    [
      ['acme.yourapp.test', false],
      ['www.acme-dental.test', true],
    ],
  );
  await assert.rejects(putTenantHost(s.where, binding, { tenantId: 'south', operator, host: 'www.acme-dental.test' }), /taken/);
  await assert.rejects(putTenantHost(s.where, binding, { tenantId: 'ghost', operator, host: 'ghost.example.test' }), /not an open tenant/);
  await removeTenantHost(s.where, binding, { host: 'www.acme-dental.test', operator });
  await assert.rejects(removeTenantHost(s.where, binding, { host: 'www.acme-dental.test', operator }), /not a host/);
  assert.ok(s.receipts().includes('removeTenantHost:acme') && s.receipts().includes('setPrimaryTenantHost:acme'));

  // Configured hosts are seeded once, as operator rows, and left as they are.
  assert.equal(
    await seedTenantHosts(s.where, binding, { hosts: [{ host: 'static.example.test', tenantId: 'plain' }], operator: 'config' }),
    1,
  );
  assert.equal(
    await seedTenantHosts(s.where, binding, { hosts: [{ host: 'static.example.test', tenantId: 'plain' }], operator: 'config' }),
    0,
  );
  const seeded = (await listTenantHosts(s.where, binding)).find((each) => each.host === 'static.example.test')!;
  assert.deepEqual([seeded.kind, seeded.source, seeded.status, seeded.primary], ['custom', 'operator', 'live', true]);
});

for (const engine of ENGINES)
  test(
    `a version 1 tenant store upgrades in place to the current layout and reads as a fresh one does, on ${engine}`,
    { skip: engine === 'postgres' ? liveSkip('postgres', LIVE) : false },
    async () => {
      const where = await scratch(engine, 'tenant_up'),
        fresh = await scratch(engine, 'tenant_fresh');
      try {
        await applyFixture(engine, where.url, readFileSync(fixturePath('tenant-store', engine, 1), 'utf8'));
        const db = await openMigrationDb(where.url, [], false);
        try {
          const done = await upgradeStores(
            db,
            where.url,
            STORES.filter((layout) => layout.id === 'tenant-store'),
          );
          assert.deepEqual(done.failed, []);
          assert.deepEqual(
            done.applied.map((each) => [each.id, each.from, each.to]),
            [
              ['tenant-store', 1, 2],
              ['tenant-store', 2, 3],
            ],
          );
        } finally {
          await db.close();
        }
        await PROVISION['tenant-store'][engine]!(fresh.url);
        assert.deepEqual(await describeUrl(where.url), await describeUrl(fresh.url));
        if (engine === 'sqlite') {
          const opened = new DatabaseSync(where.url);
          try {
            assertSqliteTenantStore(opened, { appId: 'layout', source: { id: 'business', connection: 'main' }, storeId: 'layout-tenants' });
          } finally {
            opened.close();
          }
        }
      } finally {
        await where.drop();
        await fresh.drop();
      }
    },
  );

test('the router asks a cached snapshot, and a change by another process shows within the refresh interval', async () => {
  const rows: Array<{ host: string; tenantId: string; status: 'live' | 'suspended'; kind: 'subdomain' | 'custom'; primary: boolean }> = [];
  let reads = 0;
  const router = createTenantHostRouter([], 'https://staff.yourapp.test', { tenantDomain: DOMAIN, refreshMs: 25, warn: () => {} });
  await router.register('store', {
    list: async () => {
      reads++;
      return rows.map((row) => ({
        ...row,
        app: 'store',
        source: 'claimed' as const,
        verifyToken: null,
        checkedAt: null,
        failures: 0,
        createdAt: 1,
        unavailableSince: null,
      }));
    },
  });
  router.start();
  try {
    assert.equal(router.allows('store', 'acme.yourapp.test'), false);
    const afterRegister = reads;
    // A flood of unknown hosts is a flood of map misses, not reads.
    for (let i = 0; i < 200; i++) router.allows('store', `unknown${i}.yourapp.test`);
    assert.equal(reads, afterRegister);
    rows.push({ host: 'acme.yourapp.test', tenantId: 'acme', status: 'live', kind: 'subdomain', primary: true });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(router.allows('store', 'ACME.yourapp.test:443'), true);
    assert.equal(router.allows('other', 'acme.yourapp.test'), false, 'another App does not answer it');
    assert.equal(router.primaryHost('store', 'acme'), 'acme.yourapp.test');
    rows[0].status = 'suspended';
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(router.allows('store', 'acme.yourapp.test'), false);
  } finally {
    router.close();
  }
});

test('a tenant subdomain serves with no restart, anything else is refused, and sign-in stays off the host', async (t) => {
  const s = await store(t);
  let listed = 0;
  const opened: Array<{ allowsHost?: (host: string) => boolean; primaryHost?: (tenant: string) => string | undefined }> = [];
  const open =
    (tenantHosts: boolean) =>
    async (
      _base: string,
      options: {
        allowedHosts: readonly string[];
        allowsHost?: (host: string) => boolean;
        primaryHost?: (tenant: string) => string | undefined;
      },
    ) => {
      opened.push(options);
      return {
        server: createServer((req, res) => {
          if (
            hostRefusal(req, {
              host: '127.0.0.1',
              port: 4111,
              allowedHosts: options.allowedHosts,
              ...(options.allowsHost ? { allowsHost: options.allowsHost } : {}),
            })
          ) {
            res.writeHead(403).end();
            return;
          }
          res.writeHead(200).end(JSON.stringify({ intent: getTenantHostIntent(req) }));
        }),
        ...(tenantHosts
          ? {
              tenantHosts: {
                list: async () => {
                  listed++;
                  return listTenantHosts(s.where, binding);
                },
                seed: async (hosts: readonly { host: string; tenantId: string }[]) => {
                  await seedTenantHosts(s.where, binding, { hosts, operator: 'config' });
                },
              },
            }
          : {}),
        stop: async () => {},
        close: async () => {},
      };
    };
  const identity = { route: () => undefined, close: () => {} };

  // Neither tenantDomain nor hosts: the table is never read and no host beyond staff is answered.
  const plain = await createSuite(
    [{ id: 'store', public: true, open: open(true) }],
    { publicOrigin: 'https://staff.yourapp.test' },
    identity,
  );
  t.after(() => plain.close());
  await maintenance.provisionStores({ sqlite: s.path }, { app: { tenant: binding }, only: ['tenant-store'] }).catch(() => {});
  await putTenant(s.where, binding, { tenantId: 'acme', status: 'active', expectedVersion: null, operator, tenantDomain: DOMAIN });
  const plainPort = await listen(plain.server);
  await plain.refreshHosts();
  assert.equal(listed, 0);
  assert.equal(opened[0].allowsHost, undefined);
  assert.equal((await raw(plainPort, 'acme.yourapp.test')).status, 403);
  await plain.close();

  // With one, a row that is live is a host and nothing else is.
  const suite = await createSuite(
    [{ id: 'store', public: true, open: open(true) }],
    { publicOrigin: 'https://staff.yourapp.test', tenantDomain: DOMAIN },
    identity,
  );
  t.after(() => suite.close());
  const port = await listen(suite.server);
  assert.ok(listed > 0);
  const options = opened[1];
  assert.equal(options.primaryHost?.('acme'), 'acme.yourapp.test');
  assert.equal((await raw(port, 'acme.yourapp.test')).status, 200, 'a tenant made before the suite started');

  await putTenant(s.where, binding, { tenantId: 'bright', status: 'active', expectedVersion: null, operator, tenantDomain: DOMAIN });
  await suite.refreshHosts();
  const served = await raw(port, 'bright.yourapp.test');
  assert.equal(served.status, 200);
  assert.deepEqual(JSON.parse(served.body.slice(served.body.indexOf('{'), served.body.lastIndexOf('}') + 1)).intent, {
    host: 'bright.yourapp.test',
    app: 'store',
    tenant: 'bright',
  });
  assert.equal(options.allowsHost?.('bright.yourapp.test'), true, "the App's own door is told, for its writes");
  assert.equal(options.primaryHost?.('bright'), 'bright.yourapp.test');

  for (const host of ['nobody.yourapp.test', 'a.b.yourapp.test', 'yourapp.test', 'acme.yourapp.test.evil', 'acme.other.test'])
    assert.equal((await raw(port, host)).status, 403, host);
  // A tenant's host signs in through its own `/_mistri/sign-in` (hostHandoff.ts), never the deployment's identity routes:
  // these are the same 404 as a mapped host's.
  for (const path of ['/api/auth', '/api/auth/session', '/api/suite/apps', '/_mistri/apps'])
    assert.equal((await raw(port, 'bright.yourapp.test', path)).status, 404, path);

  // A reserved label that somehow has a row is still refused; and a removed row is refused after the change is read.
  s.db.exec(
    `INSERT INTO __mistri_tenant_host (host, tenant_id, app, kind, status, source, created_at) VALUES ('www.yourapp.test', 'acme', 'store', 'subdomain', 'live', 'claimed', 1)`,
  );
  await suite.refreshHosts();
  assert.equal((await raw(port, 'www.yourapp.test')).status, 403);
  await removeTenantHost(s.where, binding, { host: 'bright.yourapp.test', operator });
  await suite.refreshHosts();
  assert.equal((await raw(port, 'bright.yourapp.test')).status, 403);
  assert.equal(options.allowsHost?.('bright.yourapp.test'), false);
  assert.equal((await raw(port, 'acme.yourapp.test')).status, 200);
});

test("the running reader's readHosts returns what maintenance wrote, in byte order", async (t) => {
  const s = await store(t);
  s.db.exec(`CREATE TABLE db_item (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT)`);
  const resources = { item: 'db_item' };
  s.db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(s.db).schema;
  s.db.exec('COMMIT');
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: appResourceCatalog(physicalSchema, resources).schema,
    resources,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  const reader = openSqliteTenantReadSource(s.path, ownership, binding);
  t.after(() => reader.close());
  assert.deepEqual(await reader.readHosts(), []);
  await putTenant(s.where, binding, { tenantId: 'acme', status: 'active', expectedVersion: null, operator });
  await putTenantHost(s.where, binding, { tenantId: 'acme', operator, host: 'b.acme.test' });
  await putTenantHost(s.where, binding, { tenantId: 'acme', operator, host: 'a.acme.test' });
  const written = await listTenantHosts(s.where, binding);
  assert.deepEqual(
    written.map((row) => row.host),
    ['a.acme.test', 'b.acme.test'],
  );
  assert.deepEqual(await reader.readHosts(), written);
});
