import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { appResourceCatalog, createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createTenantMembershipIssuer, type TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { composeTenantReadScope } from '../packages/mistri/src/server/tenant/tenantReadScope.js';
import {
  createSqliteTenantAdministration,
  createSqliteTenantMembershipGuard,
  provisionSqliteTenantStore,
  readSqliteTenantMembership,
  TENANT_TABLES,
} from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import { commandsOf } from '../packages/mistri/src/server/stores/commandStores.js';

const owner = { appId: 'app', source: { id: 'business', connection: 'owned-business' }, storeId: 'stable-business-data' };
const grant = {
  tenantId: 'north',
  accountId: 'alice',
  membershipId: 'grant-1',
  status: 'active' as const,
  roles: ['reviewer'],
  validUntil: 10_000,
  expectedVersion: null,
};
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-integration-'));
  const path = join(directory, 'business.db');
  const writer = new DatabaseSync(path),
    reader = new DatabaseSync(path);
  writer.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, tenant_id TEXT COLLATE NOCASE NOT NULL, name TEXT);
    INSERT INTO item VALUES (1, 'north', 'North'), (2, 'south', 'South'), (3, 'North', 'Case alias');`);
  provisionSqliteTenantStore(path, owner);
  const adapter = new SqliteAdapter(path, 'Tenant integration');
  t.after(async () => {
    await adapter.close();
    reader.close();
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const transaction = async <T>(run: (operations: TransactionOperations) => Promise<T>) => {
    const operations = new TransactionOperations();
    writer.exec('BEGIN');
    try {
      const out = await run(operations);
      await operations.finish();
      writer.exec('COMMIT');
      return out;
    } catch (error) {
      await operations.finish().catch(() => {});
      writer.exec('ROLLBACK');
      throw error;
    }
  };
  await transaction(async (operations) => {
    const administration = createSqliteTenantAdministration(writer, operations, owner);
    await administration.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await administration.putMembership(grant);
  });
  const physicalSchema = await adapter.introspect();
  const app = createAppResources(adapter, physicalSchema);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    physicalSchema,
    schema: app.schema,
    resources: { item: 'item' },
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  const issuer = createTenantMembershipIssuer({
    ownership,
    deployment: 'generation-1',
    roles: ['reviewer'],
    maxLifetimeMs: 5000,
    now: () => 1000,
    verifySession: () => ({ id: 'alice', who: 'Alice', role: 'administrator' }),
    membership: { source: owner.source, read: (query) => readSqliteTenantMembership(reader, owner, query) },
  });
  return { path, writer, reader, adapter, app, ownership, issuer, transaction };
}

test('real membership admission composes an exact tenant ceiling through the App read adapter', async (t) => {
  const { issuer, ownership, app } = await fixture(t);
  await issuer.withMembership({}, ['north'], async (evidence) => {
    const scope = composeTenantReadScope(ownership, evidence, { item: true }, { item: true });
    const reads = await app.adapter.scopeReads!(scope);
    assert.deepEqual(
      (await reads.query({ table: 'item', limit: 20, offset: 0 })).rows.map((row) => row.id),
      [1],
    );
    assert.equal(await reads.count('item'), 1);
  });
  await issuer.retire();
});

test('reserved tenant tables are not enrollable App resources or scoped-command records', async (t) => {
  const { path, adapter, app } = await fixture(t);
  const physical = await adapter.introspect();
  assert.deepEqual(
    app.schema.tables.map((table) => table.id),
    ['item'],
  );
  for (const name of [...Object.values(TENANT_TABLES), '__MISTRI_TENANT_future']) {
    if (name.includes('future')) physical.tables.push({ ...physical.tables[0], id: name, name });
    assert.throws(() => appResourceCatalog(physical, { private_data: name }), /unknown table/);
    assert.throws(() => app.toPhysical(name), /Unknown app resource/);
    await assert.rejects(
      commandsOf(adapter).scopeCommandTransaction({ [name]: true }, async () => {}),
      /runtime-only/,
    );
  }
  migrateSqliteCommandJournal(path);
  await commandsOf(adapter).scopeCommandTransaction({ item: true }, async (_records, _journal, catalog) => {
    assert.deepEqual(
      catalog.tables.map((table) => table.id),
      ['item'],
    );
  });
  await assert.rejects(
    commandsOf(adapter).scopeCommandTransaction({ item: true }, async (records) => {
      await records.update({ table: 'item', key: { id: 1 }, values: { name: 'Must roll back' } });
      await assert.rejects(records.count(TENANT_TABLES.membership));
    }),
  );
  assert.equal((await adapter.query({ table: 'item', limit: 1, offset: 0 })).rows[0].name, 'North');
});

test('same-writer guard fences concurrent revocation and rejected stale evidence poisons earlier work', async (t) => {
  const { writer, reader, issuer, transaction } = await fixture(t);
  reader.exec('PRAGMA busy_timeout = 0');
  let evidence!: TenantMembershipEvidence;
  // This test retains data to exercise the private guard only. Retention does
  // not confer a live issuer/request capability on application code.
  await issuer.withMembership({}, ['north'], (value) => {
    evidence = value;
  });
  await transaction(async (operations) => {
    await createSqliteTenantMembershipGuard(writer, operations, owner, () => 1001).assertCurrent(evidence);
    assert.throws(() => reader.prepare(`UPDATE "${TENANT_TABLES.membership}" SET status = 'revoked' WHERE id = 'grant-1'`).run(), /locked/);
    writer.exec("UPDATE item SET name = 'Authorized' WHERE id = 1");
  });
  await transaction(async (operations) => {
    await createSqliteTenantAdministration(writer, operations, owner).putMembership({ ...grant, status: 'revoked', expectedVersion: '1' });
  });
  await assert.rejects(
    transaction(async (operations) => {
      writer.exec("UPDATE item SET name = 'Must roll back' WHERE id = 1");
      await assert.rejects(
        createSqliteTenantMembershipGuard(writer, operations, owner, () => 1002).assertCurrent(evidence),
        TenantContextError,
      );
    }),
    TenantContextError,
  );
  assert.equal(writer.prepare('SELECT name FROM item WHERE id = 1').get()!.name, 'Authorized');
  await assert.rejects(
    issuer.withMembership({}, ['north'], () => {}),
    TenantContextError,
  );
  await issuer.retire();
});
