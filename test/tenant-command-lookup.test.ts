/**
 * Lookup in a tenant App. A tenant command looks up only what every tenant
 * reads (`owner: 'global'`, a global table in the ownership), through the
 * tenant's own row scope: it reads the global table and writes with what it
 * read; the target it reads first is scoped like every tenant read, so
 * another tenant's key is not found and the lookup never runs; and a lookup
 * of a tenant-owned table is refused when the commands are created. An HTTP
 * lookup is not a case here: tenant ownership takes SQLite and PostgreSQL
 * sources only.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { BusinessCommandDefinitionError, defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { createTenantCommands } from '../packages/mistri/src/server/tenant/tenantCommands.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';

type Request = { cookie: string };
type Service = ReturnType<typeof createTenantCommands<Request>>;
const request = { cookie: 'alice' },
  north = ['north'];

const stamp = { label: 'Stamp', command: { id: 'stamp', version: 1, target: 'item', input: {} } };

async function fixture(t: TestContext) {
  const owner = { appId: 'tenant-lookup', source: { id: 'business', connection: 'business-db' }, storeId: 'lookup-store' };
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-lookup-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path),
    services: Service[] = [],
    sources: Array<{ close(): Promise<void> }> = [];
  t.after(async () => {
    try {
      await Promise.all(services.map((service) => service.retire()));
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=0;
    CREATE TABLE db_item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
      country_code TEXT NOT NULL, country_name TEXT);
    CREATE TABLE db_country (code TEXT NOT NULL PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO db_item VALUES ('north-row','north',0,'NO',NULL),('south-row','south',0,'SE',NULL);
    INSERT INTO db_country VALUES ('NO','Norway'),('SE','Sweden');`);
  provisionSqliteTenantStore(path, owner);
  migrateSqliteCommandJournal(path);
  const operations = new TransactionOperations();
  db.exec('BEGIN IMMEDIATE');
  try {
    const admin = createSqliteTenantAdministration(db, operations, owner);
    const grant = { accountId: 'alice', status: 'active' as const, roles: ['manager'], validUntil: 10000, expectedVersion: null };
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({ ...grant, tenantId, membershipId: `${tenantId}-alice` });
    }
    await operations.finish();
    db.exec('COMMIT');
  } catch (error) {
    await operations.finish().catch(() => {});
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }

  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const resources = { item: 'db_item', country: 'db_country' };
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' }, country: { kind: 'global', access: 'read-only' } },
  });
  const app = parseTestApp(
    {
      id: owner.appId,
      name: 'Tenant lookup',
      sources: { business: { connection: owner.source.connection } },
      resources: {
        item: {
          physical: 'db_item',
          access: 'write',
          owner: 'tenant',
          actions: { stamp },
          // A command's target keeps every ordinary column readable and writable
          // in its field rule, or binding refuses it (command field authorization).
          fields: { read: ['id', 'version', 'country_code', 'country_name'], write: ['id', 'version', 'country_code', 'country_name'] },
        },
        country: { physical: 'db_country', owner: 'global', fields: { read: ['code', 'name'] } },
      },
      auth: { rows: 'tenant', roles: { manager: { read: true, commands: ['stamp'] } } },
      views: { records: { kind: 'list', from: 'item' } },
      home: 'records',
      nav: ['records'],
    },
    'tenant lookup fixture',
  );
  const identity: Identity = { id: 'alice', who: 'Alice', role: 'admin' };
  const rows: RowScope = { item: true, country: true };
  const calls = { lookup: 0 };
  const { id: _id, version: _version, ...stampDefinition } = stamp.command;
  const stampWith = (lookedUp: Record<string, string[]>) =>
    defineCommand({
      ...stampDefinition,
      source: 'business',
      read: ['item'],
      write: ['item'],
      sources: lookedUp,
      output: { parse: (value: unknown) => value as { name: string } },
      async lookup({ sources, record }) {
        calls.lookup++;
        const country = await sources.business.country.get(String(record!.country_code));
        return { name: String(country.name) };
      },
      async handle(context) {
        const { name } = context.lookup as { name: string };
        const version = Number(context.record.version) + 1;
        // A guarded update names every column it writes at its prior value.
        await context.tx.update({
          table: 'item',
          key: { id: String(context.record.id) },
          expected: { version: version - 1, country_name: context.record.country_name ?? null },
          values: { version, country_name: name },
        });
        return { name };
      },
    });
  const issue = (lookedUp: Record<string, string[]> = { business: ['country'] }) => {
    const reader = openSqliteTenantReadSource(path, ownership, owner, () => 1000);
    sources.push(reader);
    return openSqliteTenantWriteSource(path, ownership, owner, () => 1000).then((writer) => {
      sources.push(writer);
      const service = createTenantCommands<Request>({
        app,
        reader,
        writer,
        // Every tenant command says which records its result names; a stamp names none.
        commands: { registry: defineCommands({ stamp: stampWith(lookedUp) }), resultReferences: { stamp: () => [] } },
        deployment: 'deployment-1',
        roles: ['manager'],
        maxLifetimeMs: 5000,
        now: () => 1000,
        verifySession: (input) => (input.cookie === 'alice' ? identity : null),
        resolveMembershipRows: () => rows,
        resolveRows: () => rows,
      });
      services.push(service);
      return service;
    });
  };
  let n = 0;
  const body = (id: string) => ({
    command: 'stamp',
    commandVersion: 1,
    key: { id },
    expectedVersion: 0,
    idempotencyKey: `tenant-lookup-${String(++n).padStart(4, '0')}`,
    input: {},
  });
  return { db, issue, body, calls };
}

test('a tenant command looks up a global table through its own scope, and writes with what it read', async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  const result = await service.execute(request, north, f.body('north-row'), { requestId: 'request-001' });
  assert.equal(result.status, 'applied');
  assert.deepEqual(JSON.parse(JSON.stringify(result.result)), { name: 'Norway' });
  assert.equal(f.calls.lookup, 1);
  assert.deepEqual(
    { ...f.db.prepare("SELECT version, country_name FROM db_item WHERE id='north-row'").get() },
    { version: 1, country_name: 'Norway' },
  );
  assert.equal(f.db.prepare("SELECT country_name FROM db_item WHERE id='south-row'").get()!.country_name, null);
});

test("another tenant's key is refused before the lookup runs, and reveals nothing", async (t) => {
  const f = await fixture(t),
    service = await f.issue();
  // As every tenant command answers another tenant's key (tenant-commands.test.ts):
  // refused, never "not found", so whether the row exists stays private.
  await assert.rejects(service.execute(request, north, f.body('south-row'), { requestId: 'request-002' }), (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError, String(error));
    assert.notEqual(error.code, 'not_found');
    return true;
  });
  assert.equal(f.calls.lookup, 0);
  assert.equal(f.db.prepare("SELECT version FROM db_item WHERE id='south-row'").get()!.version, 0);
});

test('a lookup of a tenant-owned table is refused when the commands are created', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.issue({ business: ['item'] }), (error: unknown) => {
    assert.ok(error instanceof BusinessCommandDefinitionError, String(error));
    assert.match(error.message, /global/);
    return true;
  });
});
