import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { createTenantWriteRuntime } from '../packages/mistri/src/server/tenant/tenantWriteRuntime.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

/* A machine's column moves only through its actions. A role that writes the
   column must not be able to skip the graph by writing the value through a
   tenant's ordinary record write, as it cannot in a single-database App. */

const binding = { appId: 'm-app', source: { id: 'business', connection: 'business-db' }, storeId: 'fixture' };
const resources = { ticket: 'db_ticket' };

async function fixture(t: TestContext, agent: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'tenant-machine-'));
  const path = join(dir, 'b.db'),
    db = new DatabaseSync(path);
  db.exec(`CREATE TABLE db_ticket (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    INSERT INTO db_ticket VALUES ('t1','north','One','open');`);
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
    roles: ['agent'],
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
  const reader = openSqliteTenantReadSource(path, ownership, binding, () => time);
  const writer = await openSqliteTenantWriteSource(path, ownership, binding, () => time);
  const app = parseAppConfig(
    {
      id: binding.appId,
      name: 'M',
      sources: { business: { connection: 'business-db' } },
      resources: {
        ticket: {
          physical: 'db_ticket',
          access: 'write',
          machine: {
            column: 'status',
            states: { open: { on: { approve: { to: 'approved', when: "name = 'never-true'" } } }, approved: { final: true } },
          },
        },
      },
      auth: { roles: { agent } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'fixture',
  );
  const rows = { ticket: true } as const;
  const runtime = createTenantWriteRuntime({
    app,
    reader,
    writer,
    deployment: 'd1',
    roles: ['agent'],
    maxLifetimeMs: 5000,
    verifySession: () => ({ id: 'alice', who: 'Alice', role: 'agent' }),
    resolveMembershipRows: () => rows,
    resolveRows: () => rows,
    now: () => time,
  } as never);
  t.after(async () => {
    await runtime.retire();
    await reader.close();
    await writer.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const stored = () => db.prepare("SELECT name, status FROM db_ticket WHERE id='t1'").get() as { name: string; status: string };

  const update = (values: Record<string, string>) =>
    runtime.transaction({ cookie: 'alice' } as never, ['north'], ({ data }) => data.update({ table: 'ticket', key: { id: 't1' }, values }));
  return { stored, update };
}

const agent = { read: ['ticket'], write: ['ticket'], fields: { ticket: { read: ['id', 'name', 'status'], write: ['name'] } } };

test('a tenant record write cannot move a machine column off its graph', async (t) => {
  const { stored, update } = await fixture(t, agent);
  await assert.rejects(update({ status: 'approved' }));
  assert.equal(stored().status, 'open');
  // An ordinary field still writes.
  await update({ name: 'Renamed' });
  assert.deepEqual({ ...stored() }, { name: 'Renamed', status: 'open' });
});

test('a tenant role that declares what it creates still updates a record', async (t) => {
  const { stored, update } = await fixture(t, { ...agent, create: [] });
  await update({ name: 'Renamed' });
  assert.equal(stored().name, 'Renamed');
});
