import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { createTenantApiRequest, withTenantApiRequests } from '../packages/mistri/src/server/tenant/tenantApiRequest.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createTenantReadRuntime } from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { createTenantWriteRuntime } from '../packages/mistri/src/server/tenant/tenantWriteRuntime.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* A tenant API token carries the roles it was issued with. Its reads and
   writes are granted from those alone — never from the wider roles its member
   holds — as an App API token's are outside a tenant (sqliteApiReadOwner). */

const binding = { appId: 'token-app', source: { id: 'business', connection: 'business-db' }, storeId: 'fixture' };
const resources = { ticket: 'db_ticket' };

async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-token-roles-'));
  const path = join(dir, 'b.db'),
    db = new DatabaseSync(path);
  db.exec(`CREATE TABLE db_ticket (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, secret TEXT NOT NULL);
    INSERT INTO db_ticket VALUES ('t1','north','One','s1');`);
  provisionSqliteTenantStore(path, binding);
  const ops = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  const admin = createSqliteTenantAdministration(db, ops, binding);
  await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
  await admin.putMembership({
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active',
    roles: ['agent', 'viewer'],
    validUntil: 10000,
    expectedVersion: null,
  });
  await ops.finish();
  db.exec('COMMIT');
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: { ticket: { kind: 'tenant', column: 'tenant_id' } },
  });
  const time = 1000;
  const app = parseAppConfig(
    {
      id: binding.appId,
      name: 'Tokens',
      sources: { business: { connection: 'business-db' } },
      resources: { ticket: { physical: 'db_ticket', access: 'write' } },
      auth: {
        roles: {
          agent: { read: ['ticket'], write: ['ticket'] },
          viewer: { read: ['ticket'], fields: { ticket: { read: ['id', 'name'] } } },
        },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'fixture',
  );
  const rows = { ticket: true } as const;
  const common = {
    app,
    deployment: 'd1',
    roles: ['agent', 'viewer'],
    maxLifetimeMs: 5000,
    // A browser session for alice; an API request answers for itself.
    verifySession: withTenantApiRequests<object>(async (request) =>
      (request as { cookie?: string }).cookie === 'alice' ? { id: 'alice', who: 'Alice' } : null,
    ),
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    now: () => time,
  };
  const source = openSqliteTenantReadSource(path, ownership, binding, () => time);
  const reads = createTenantReadRuntime({ ...common, source } as never);
  const reader = openSqliteTenantReadSource(path, ownership, binding, () => time);
  const writer = await openSqliteTenantWriteSource(path, ownership, binding, () => time);
  const writes = createTenantWriteRuntime({ ...common, reader, writer } as never);
  t.after(async () => {
    await reads.retire();
    await writes.retire();
    await reader.close();
    await writer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const token = (roles: string[]) => createTenantApiRequest(async () => ({ id: 'alice', who: 'alice' }), roles);
  const readSecret = (request: object) =>
    reads.withContext(request as never, ['north'], ({ data }) =>
      data.query({ table: 'ticket', columns: ['id', 'secret'], limit: 5, offset: 0 }),
    );
  const rename = (request: object) =>
    writes.transaction(request as never, ['north'], ({ data }) =>
      data.update({ table: 'ticket', key: { id: 't1' }, values: { name: 'Renamed' } }),
    );
  const stored = () => (db.prepare("SELECT name FROM db_ticket WHERE id='t1'").get() as { name: string }).name;
  return { token, readSecret, rename, stored };
}

test("a tenant API token reads under its own roles, not its member's", async (t) => {
  const { token, readSecret } = await fixture(t);
  // The member's session holds both roles and reads the column.
  const session = await readSecret({ cookie: 'alice' });
  assert.equal(session.rows[0].secret, 's1');
  // A token for both roles reads it too; a viewer's token does not.
  assert.equal((await readSecret(token(['agent', 'viewer']))).rows[0].secret, 's1');
  await assert.rejects(readSecret(token(['viewer'])));
});

test("a tenant API token writes under its own roles, not its member's", async (t) => {
  const { token, rename, stored } = await fixture(t);
  await assert.rejects(rename(token(['viewer'])));
  assert.equal(stored(), 'One');
  await rename(token(['agent']));
  assert.equal(stored(), 'Renamed');
});
