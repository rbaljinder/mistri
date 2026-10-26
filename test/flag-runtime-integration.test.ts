import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { bindTenantReadRuntime } from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import { bindPlatformReadRuntime } from '../packages/mistri/src/server/tenant/tenantPlatformReadRuntime.js';
import { bindTenantRequestRuntime } from '../packages/mistri/src/server/tenant/tenantRequestRuntime.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { createFlagRequestRuntime, type FlagRuntimeCapture } from '../packages/mistri/src/server/flags/requestRuntime.js';
import { captureTenantFlagOwner } from '../packages/mistri/src/server/tenant/tenantFlagRuntime.js';
import { createTenantHostRouter } from '../packages/mistri/src/server/http/tenantHosts.js';
import { normalizeFlagCatalog, normalizeFlagSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { parseTestApp } from './support/commandCatalog.js';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const request = () =>
  ({
    method: 'GET',
    url: '/api/flags/evaluate?app=desk&tenant=north',
    aborted: false,
    rawHeaders: ['Host', 'localhost:4111'],
    headers: { host: 'localhost:4111', cookie: 'native-admin' },
  }) as IncomingMessage;

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-flag-runtime-')),
    path = join(dir, 'business.db'),
    db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT); INSERT INTO item VALUES('one','north','One');",
  );
  const binding = { appId: 'desk', source: { id: 'data', connection: 'business' }, storeId: 'flag-fixture' };
  provisionSqliteTenantStore(path, binding);
  const maintenance = async (work: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await work(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      db.exec('ROLLBACK');
      throw error;
    }
  };
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['member'],
    validUntil: 10000,
    expectedVersion: null,
  };
  await maintenance(async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putMembership(grant);
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({
      accountId: 'alice',
      membershipId: 'platform-alice',
      status: 'active',
      roles: ['operator'],
      validUntil: 10000,
      expectedVersion: null,
    });
  });
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const resourceCatalog = appResourceCatalog(physicalSchema, { item: 'item' });
  const ownership = captureTenantOwnership({
    appId: 'desk',
    source: binding.source,
    resources: { item: 'item' },
    physicalSchema,
    schema: resourceCatalog.schema,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  const reader = openSqliteTenantReadSource(path, ownership, binding, () => 1000);
  const writer = await openSqliteTenantWriteSource(path, ownership, binding, () => 1000);
  const app = parseTestApp(
    {
      id: 'desk',
      name: 'Desk',
      sources: { data: { connection: 'business' } },
      resources: { item: { access: 'write', owner: 'tenant' } },
      views: {
        items: { kind: 'list', from: 'item' },
        apply: { kind: 'form', label: 'Apply', public: true, command: { id: 'apply', input: { name: { type: 'text', max: 80 } } } },
      },
      home: 'items',
      flags: {
        enabled: { type: 'boolean', default: false, owner: 'team', tenantManaged: true },
        intake: { type: 'boolean', default: false, owner: 'team', tenantManaged: true },
        membersOnly: { type: 'boolean', default: false, owner: 'team', tenantManaged: true },
      },
      audiences: {
        northIntake: { tenants: ['north'] },
        members: { roles: ['member'] },
        admins: { roles: ['admin'] },
        operators: { roles: ['operator'] },
      },
      auth: {
        rows: 'tenant',
        tenancy: { platform: { label: 'Platform' } },
        roles: {
          member: { realm: 'tenant', read: true },
          operator: { realm: 'platform', read: true },
          admin: { realm: 'platform', read: true },
        },
      },
    },
    'tenant-flags',
  );
  // The native role is deliberately stronger and must never enter evaluation.
  const common = {
    app,
    deployment: 'deployment',
    maxLifetimeMs: 5000,
    verifySession: () => ({ id: 'alice', who: 'Alice', role: 'admin' }),
    now: () => 1000,
  };
  const reads = bindTenantReadRuntime<IncomingMessage>({
    ...common,
    source: reader,
    roles: ['member'],
    resolveMembershipRows: () => ({ item: true }),
    resolveRows: () => ({ item: true }),
  });
  const platform = bindPlatformReadRuntime<IncomingMessage>({
    ...common,
    source: reader,
    roles: ['operator', 'admin'],
    resolvePlatformRows: () => ({ item: true }),
  });
  const requests = bindTenantRequestRuntime<IncomingMessage>({
    ...common,
    reader,
    writer,
    roles: ['member'],
    resolveMembershipRows: () => ({ item: true }),
    resolveRows: () => ({ item: true }),
  });
  const catalog = normalizeFlagCatalog({ flags: app.flags, roles: Object.keys(app.auth!.roles!), audiences: app.audiences });
  let count = 0,
    hold: ReturnType<typeof gate> | undefined,
    entered = gate();
  const runtime = createFlagRequestRuntime({
    app,
    environment: 'production',
    observeMembership: captureTenantFlagOwner,
    assertCurrent() {},
    readPort: {
      appId: 'desk',
      environment: 'production',
      catalog,
      async readRequestScopes(scope) {
        count++;
        const global = normalizeFlagSnapshot(
          {
            ...scope,
            tenantId: null,
            revision: 1,
            overrides: {
              enabled: {
                rules: [
                  { audiences: ['admins'], value: true },
                  { audiences: ['operators'], value: true },
                ],
              },
              intake: { rules: [{ audiences: ['northIntake'], value: true }] },
              membersOnly: { rules: [{ audiences: ['members'], value: true }] },
            },
          },
          catalog,
        );
        const tenant = scope.tenantId === null ? null : normalizeFlagSnapshot({ ...scope, revision: 2, overrides: {} }, catalog);
        entered.release();
        if (hold) await hold.promise;
        return { global, tenant };
      },
    },
  });
  t.after(async () => {
    await Promise.all([reads.retire(), platform.retire(), requests.retire()]);
    await reader.close();
    await writer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    runtime,
    reads,
    platform,
    requests,
    count: () => count,
    hold() {
      hold = gate();
      entered = gate();
      return { release: hold.release, entered: entered.promise };
    },
    revoke: () => maintenance((admin) => admin.putMembership({ ...grant, status: 'revoked', expectedVersion: '1' })),
  };
}

test('genuine tenant read/request owners expose only active membership roles and retire captures at callback release', async (t) => {
  const f = await fixture(t),
    req = request();
  let kept!: FlagRuntimeCapture,
    copiedRefused = false,
    otherRequestRefused = false;
  let retained!: FlagRuntimeCapture['commandFlags'];
  const result = await f.reads.withContext(req, ['north'], async ({ principal }) => {
    try {
      f.runtime.tenant(req, { ...principal });
    } catch {
      copiedRefused = true;
    }
    try {
      f.runtime.tenant(request(), principal);
    } catch {
      otherRequestRefused = true;
    }
    const first = f.runtime.tenant(req, principal),
      second = f.runtime.tenant(req, principal);
    assert.equal(first, second);
    kept = await first;
    retained = kept.commandFlags;
    const captureFlags = f.runtime.captureTenantFlags;
    return { value: (await captureFlags(principal, req)).get('enabled'), version: kept.evaluation.version };
  });
  assert.equal(copiedRefused, true);
  assert.equal(otherRequestRefused, true);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { value: false, version: { global: 1, tenant: 2 } });
  assert.equal(f.count(), 1);
  assert.throws(() => kept.evaluation.evaluate('enabled'));
  assert.throws(() => retained.get('enabled'));
  const command = await f.requests.run(req, ['north'], async (scope) => {
    const capture = await f.runtime.tenant(req, scope.principal);
    return capture.commandFlags.get('enabled');
  });
  assert.equal(command, false);
  assert.equal(f.count(), 2);
});

test('the platform read owner uses only platform membership and global controls', async (t) => {
  const f = await fixture(t),
    req = request();
  req.url = '/api/flags/evaluate?app=desk&realm=platform';
  const result = await f.platform.withContext(req, async ({ principal }) => {
    const capture = await f.runtime.tenant(req, principal);
    return {
      value: capture.commandFlags.get('enabled'),
      realm: capture.realm,
      tenantId: capture.tenantId,
      version: capture.evaluation.version,
    };
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    value: true,
    realm: 'platform',
    tenantId: null,
    version: { global: 1, tenant: null },
  });
  assert.equal(f.count(), 1);
});

test('values HTTP is buffered through the true tenant/platform read owner and shares its command reader pair', async (t) => {
  const f = await fixture(t);
  for (const platform of [false, true]) {
    const req = request();
    if (platform) req.url = '/api/flags/evaluate?app=desk&realm=platform';
    let released = false,
      commandValue: unknown;
    const handler = f.runtime.valuesHttp({
      bound: { host: '127.0.0.1', port: 4111 },
      async withRequest(request, _res, guard, use) {
        guard();
        const run = async ({ principal }: { principal: Parameters<typeof f.runtime.tenant>[1] }) => {
          const capture = await f.runtime.tenant(request, principal);
          commandValue = capture.commandFlags.get('enabled');
          await use(capture);
        };
        if (platform) await f.platform.withContext(request, run);
        else await f.reads.withContext(request, ['north'], run);
        released = true;
      },
    });
    const res = {
      status: 0,
      body: '',
      destroyed: false,
      writableEnded: false,
      setHeader() {},
      writeHead(status: number) {
        assert.equal(released, true);
        this.status = status;
      },
      end(body: string) {
        this.body = body;
        this.writableEnded = true;
      },
    };
    await handler(req, res as unknown as ServerResponse);
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).values.enabled, commandValue);
  }
  assert.equal(f.count(), 2);
});

test('a membership revoked during the control read discards every value before publication', async (t) => {
  const f = await fixture(t),
    req = request(),
    held = f.hold();
  let published = false;
  const pending = f.reads.withContext(req, ['north'], async ({ principal }) => {
    await f.runtime.tenant(req, principal);
    published = true;
    return 'private';
  });
  await held.entered;
  await f.revoke();
  held.release();
  await assert.rejects(pending);
  assert.equal(published, false);
});

test('mapped public policy context ignores staff cookies and cannot borrow native membership or raw tenant intent', async (t) => {
  const f = await fixture(t),
    req = request();
  req.headers.host = 'store.example.test';
  req.rawHeaders = ['Host', 'store.example.test'];
  req.url = '/api/flags/evaluate?app=desk';
  assert.equal(createTenantHostRouter([{ host: 'store.example.test', app: 'desk', tenant: 'north' }]).accept(req), true);
  const admission = { generation: {}, form: 'apply', tenantId: 'north', assertCurrent() {}, async current() {} };
  const capture = await f.runtime.public(req, admission);
  assert.equal(capture.commandFlags.get('enabled'), false);
  assert.equal(capture.tenantId, 'north');
  // An anonymous visitor on the tenant's intake is inside that tenant's audience, and in no role's.
  assert.equal(capture.commandFlags.get('intake'), true);
  assert.equal(capture.commandFlags.get('membersOnly'), false);
  assert.throws(() => f.runtime.public(req, { ...admission, tenantId: 'south' }));
  assert.throws(() => f.runtime.public(req, { ...admission, tenantId: undefined }));
  assert.equal(f.count(), 1);
});
