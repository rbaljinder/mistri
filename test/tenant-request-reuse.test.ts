/**
 * G118: a tenant App's server rebuilt its read scope and capabilities from
 * scratch on every request — the ownership snapshot re-copied and re-checked,
 * the catalog pruned and captured again, the capabilities projected again —
 * until a page's refresh of forty reads held the event loop for seconds and a
 * command's prepare queued behind it. These cases count the builders, not the
 * clock: a burst of reads for one member runs each of them at most once, and
 * what is kept is never handed to another tenant, role or App.
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
import { pruneCounters } from '../packages/mistri/src/server/app/appAccess.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { captureCounters } from '../packages/engine/src/server/evidence.js';
import { capabilityCounters } from '../packages/mistri/src/server/tenant/tenantCapabilities.js';
import { createTenantDeployment, type TenantDeploymentOptions } from '../packages/mistri/src/server/tenant/tenantDeployment.js';
import { captureTenantOwnership, ownershipCounters } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantReadContext } from '../packages/mistri/src/server/tenant/tenantReadRuntime.js';
import { openSqliteTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { openSqliteTenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { scopeCatalogCounters } from '../packages/engine/src/shared/scopeCatalog.js';
import { accessCounters } from '../packages/mistri/src/server/tenant/tenantAccess.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import { parseTestApp } from './support/commandCatalog.js';

type Request = { cookie: string };
type Options = TenantDeploymentOptions<Request>;
type Deployment = ReturnType<typeof createTenantDeployment<Request>>;
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const view: ViewDef = {
  id: 'items',
  name: 'Items',
  base: 'item',
  columns: [{ path: 'id' }, { path: 'name' }],
};
const counters = () => ({
  ownership: ownershipCounters.validated,
  attested: ownershipCounters.attested,
  capabilities: capabilityCounters.projected,
  pruned: pruneCounters.pruned,
  catalogs: scopeCatalogCounters.captured,
  copied: captureCounters.copied,
  access: accessCounters.resolved,
  accessAsked: accessCounters.asked,
});
const since = (before: ReturnType<typeof counters>) => {
  const after = counters();
  return Object.fromEntries(Object.entries(after).map(([key, value]) => [key, value - before[key as keyof typeof before]]));
};

/* Two tenants; alice operates in north and only views in south, bob views in
   north. A viewer reads no `secret` column, and its rows leave out the hidden
   item: what each one gets back says whose scope served it. */
async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-reuse-')),
    path = join(directory, 'business.db');
  const db = new DatabaseSync(path),
    deployments: Deployment[] = [];
  t.after(async () => {
    try {
      await Promise.allSettled(deployments.map((value) => value.retire()));
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE db_item (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, owner TEXT NOT NULL, secret TEXT NOT NULL);
    CREATE TABLE db_task (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, name TEXT NOT NULL);
    INSERT INTO db_item VALUES ('north-1','north','North one','bob','NORTH_SECRET'),('north-2','north','Hidden','bob','NORTH_HIDDEN'),
      ('north-3','north','Carol one','carol','CAROL_SECRET'),
      ('south-1','south','South one','alice','SOUTH_SECRET'),('south-2','south','Hidden','alice','SOUTH_HIDDEN');
    INSERT INTO db_task VALUES ('north-task','north',0,'North task'),('south-task','south',0,'South task');`);
  const owner = {
    appId: 'tenant-reuse',
    source: { id: 'business', connection: 'business-db' },
    storeId: 'reuse-fixture',
  };
  provisionSqliteTenantStore(path, owner);
  migrateSqliteCommandJournal(path);
  const maintenance = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<unknown>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, owner));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  const member = (tenantId: string, accountId: string, roles: string[]) => ({
    tenantId,
    accountId,
    membershipId: `${tenantId}-${accountId}`,
    status: 'active' as const,
    roles,
    validUntil: 100000,
    expectedVersion: null,
  });
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south'])
      await admin.putTenant({
        tenantId,
        status: 'active',
        expectedVersion: null,
      });
    await admin.putMembership(member('north', 'alice', ['operator']));
    await admin.putMembership(member('south', 'alice', ['viewer']));
    await admin.putMembership(member('north', 'bob', ['viewer']));
    await admin.putMembership(member('north', 'carol', ['viewer']));
  });
  db.exec('BEGIN');
  const physicalSchema = readSqliteReadCatalog(db).schema;
  db.exec('COMMIT');
  const resources = { item: 'db_item', task: 'db_task' },
    catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    physicalSchema,
    schema: catalog.schema,
    resources,
    ownership: {
      item: { kind: 'tenant', column: 'tenant_id' },
      task: { kind: 'tenant', column: 'tenant_id' },
    },
  });
  const input = {} as const;
  const advance = {
    label: 'Advance',
    command: { id: 'advance', version: 1, target: 'task', input },
  };
  const appWith = (viewerSecret: boolean) =>
    parseTestApp(
      {
        id: owner.appId,
        name: 'Tenant reuse fixture',
        sources: { business: { connection: owner.source.connection } },
        resources: {
          item: {
            physical: 'db_item',
            access: 'write',
            fields: {
              read: ['id', 'name', 'owner', 'secret'],
              write: ['id', 'name', 'owner', 'secret'],
            },
          },
          task: {
            physical: 'db_task',
            access: 'write',
            fields: { read: ['id', 'version', 'name'], write: ['name'] },
            actions: { advance },
          },
        },
        auth: {
          roles: {
            operator: { read: true, write: ['item'], commands: ['advance'] },
            viewer: {
              read: true,
              fields: {
                item: {
                  read: viewerSecret ? ['id', 'name', 'owner', 'secret'] : ['id', 'name', 'owner'],
                  write: [],
                },
              },
            },
          },
        },
        views: { tasks: { kind: 'list', from: 'task' } },
        home: 'tasks',
        nav: ['tasks'],
      },
      'tenant reuse fixture',
    );
  /* A viewer reads only its own items (`me`: the member's account), and never
     the hidden one; an operator reads them all. Two viewers share a role and
     must still each see their own rows. */
  const rows = (principal: { accountId: string; roles: readonly string[] }): RowScope =>
    principal.roles.includes('operator')
      ? { item: true, task: true }
      : {
          item: {
            groups: [
              [
                { column: 'name', op: '!=', value: 'Hidden' },
                { column: 'owner', op: '=', value: principal.accountId },
              ],
            ],
          },
          task: true,
        };
  const registry = defineCommands({
    advance: defineCommand({
      target: 'task',
      input,
      source: 'business',
      read: ['task'],
      write: ['task'],
      output: { parse: (value: unknown) => value as { version: number } },
      async handle(context) {
        const { version } = await context.db.task.update(context.record!, {
          version: Number(context.record.version) + 1,
        });
        return { version: Number(version) };
      },
    }),
  });
  const create = async (viewerSecret = false) => {
    const reader = openSqliteTenantReadSource(path, ownership, owner, () => 1000);
    const writer = await openSqliteTenantWriteSource(path, ownership, owner, () => 1000);
    const options: Options = {
      app: appWith(viewerSecret),
      reader,
      writer,
      commands: {
        registry,
        resultReferences: {
          advance: () => [{ table: 'task', key: { id: 'north-task' } }],
        },
      },
      deployment: 'deployment-1',
      roles: ['operator', 'viewer'],
      maxLifetimeMs: 5000,
      now: () => 1000,
      verifySession: (request) => ({ id: request.cookie, who: request.cookie }),
      resolveMembershipRows: () => ({ item: true, task: true }),
      resolveRows: rows,
    };
    const deployment = createTenantDeployment<Request>(options);
    deployments.push(deployment);
    return deployment;
  };
  return { create, maintenance, member };
}

/** What one member's request sees: the item rows, the item columns its schema
 * offers, and what its capabilities say it may write. */
async function seen(deployment: Deployment, account: string, tenant: string) {
  return plain(
    await deployment.withContext({ cookie: account }, [tenant], async (context: TenantReadContext) => {
      const result = await context.data.query({
        table: 'item',
        limit: 20,
        offset: 0,
      });
      return {
        rows: plain(result.rows).sort((a, b) => String(a.id).localeCompare(String(b.id))),
        columns: context.schema.tables.find((table) => table.id === 'item')!.columns.map((column) => column.name),
        writable: plain(context.capabilities!.writable),
      };
    }),
  );
}
const operatorNorth = {
  rows: [
    { id: 'north-1', name: 'North one', owner: 'bob', secret: 'NORTH_SECRET' },
    { id: 'north-2', name: 'Hidden', owner: 'bob', secret: 'NORTH_HIDDEN' },
    {
      id: 'north-3',
      name: 'Carol one',
      owner: 'carol',
      secret: 'CAROL_SECRET',
    },
  ],
  columns: ['id', 'name', 'owner', 'secret'],
  writable: ['item'],
};
const viewerNorth = {
  rows: [{ id: 'north-1', name: 'North one', owner: 'bob' }],
  columns: ['id', 'name', 'owner'],
  writable: [],
};
const carolNorth = {
  ...viewerNorth,
  rows: [{ id: 'north-3', name: 'Carol one', owner: 'carol' }],
};
const viewerSouth = {
  rows: [{ id: 'south-1', name: 'South one', owner: 'alice' }],
  columns: ['id', 'name', 'owner'],
  writable: [],
};

test('a burst of forty reads, an availability check and a prepare for one member build its scope and capabilities once', async (t) => {
  const f = await fixture(t),
    deployment = await f.create();
  const request = { cookie: 'alice' },
    north = ['north'];
  const page = async () => {
    await deployment.withContext(request, north, async (context) => context.data.runView!(view, 0));
    await deployment.availability(request, north, {
      checks: [{ command: 'advance', commandVersion: 1, keys: [{ id: 'north-task' }] }],
    });
  };
  // The first request of a member builds what its role needs.
  await page();
  const first = counters();
  const reads = [];
  for (let index = 0; index < 40; index++)
    reads.push(deployment.withContext(request, north, async (context) => context.data.runView!(view, 0)));
  const results = await Promise.all(reads);
  assert.deepEqual(plain(results[39].rows), [
    { id: 'north-1', name: 'North one' },
    { id: 'north-2', name: 'Hidden' },
    { id: 'north-3', name: 'Carol one' },
  ]);
  await deployment.availability(request, north, {
    checks: [{ command: 'advance', commandVersion: 1, keys: [{ id: 'north-task' }] }],
  });
  assert.deepEqual(
    plain(
      await deployment.prepare(request, north, {
        command: 'advance',
        commandVersion: 1,
        key: { id: 'north-task' },
      }),
    ),
    {
      expectedVersion: 0,
    },
  );
  const burst = since(first);
  // None of the derived structures is rebuilt for a member it was built for.
  assert.deepEqual(
    {
      ownership: burst.ownership,
      capabilities: burst.capabilities,
      pruned: burst.pruned,
      access: burst.access,
    },
    { ownership: 0, capabilities: 0, pruned: 0, access: 0 },
  );
  // The availability check and the prepare each asked what their roles may do, and were answered from what was kept.
  assert.ok(burst.accessAsked >= 2, `${burst.accessAsked} access answers asked for`);
  /* What is still captured is the database's own catalog, read back in each
     snapshot and judged against the deployed one (three captures each), and
     once in the prepare's write transaction: never a catalog derived again. */
  assert.ok(burst.catalogs <= 3 * burst.attested + 2, `${burst.catalogs} catalogs for ${burst.attested} read-backs`);
  /* What is still copied per request is the request's own evidence and
     answers — a few dozen objects — never the App or the catalog again
     (before this, each read copied the whole catalog several times over). */
  assert.ok(burst.copied / 42 < 120, `copied ${burst.copied} objects over 42 requests`);
});

test('a kept scope is never served across tenants, roles or people', async (t) => {
  const f = await fixture(t),
    deployment = await f.create();
  for (let round = 0; round < 3; round++) {
    assert.deepEqual(await seen(deployment, 'alice', 'north'), operatorNorth);
    assert.deepEqual(await seen(deployment, 'bob', 'north'), viewerNorth);
    // Same tenant, same role, another person: the role's grant is shared, the `me` rows are not.
    assert.deepEqual(await seen(deployment, 'carol', 'north'), carolNorth);
    // Same role in another tenant.
    assert.deepEqual(await seen(deployment, 'alice', 'south'), viewerSouth);
  }
  // Bob has no membership in south: nothing kept for north lets him in.
  await assert.rejects(seen(deployment, 'bob', 'south'));
});

test('a membership role change, a tenant change and an App reload are each seen on the next request', async (t) => {
  const f = await fixture(t),
    deployment = await f.create();
  assert.deepEqual(await seen(deployment, 'bob', 'north'), viewerNorth);
  // Bob is made an operator: the next request reads under that role.
  await f.maintenance((admin) =>
    admin.putMembership({
      ...f.member('north', 'bob', ['operator']),
      expectedVersion: '1',
    }),
  );
  assert.deepEqual(await seen(deployment, 'bob', 'north'), operatorNorth);
  // And back again: nothing of the operator's scope is left with him.
  await f.maintenance((admin) =>
    admin.putMembership({
      ...f.member('north', 'bob', ['viewer']),
      expectedVersion: '2',
    }),
  );
  assert.deepEqual(await seen(deployment, 'bob', 'north'), viewerNorth);
  // A tenant change moves its version; a suspended tenant reads nothing.
  await f.maintenance((admin) =>
    admin.putTenant({
      tenantId: 'north',
      status: 'suspended',
      expectedVersion: '1',
    }),
  );
  await assert.rejects(seen(deployment, 'alice', 'north'));
  assert.deepEqual(await seen(deployment, 'alice', 'south'), viewerSouth);
  await f.maintenance((admin) =>
    admin.putTenant({
      tenantId: 'north',
      status: 'active',
      expectedVersion: '2',
    }),
  );
  assert.deepEqual(await seen(deployment, 'alice', 'north'), operatorNorth);
  // A reloaded App whose viewer may read `secret`: its deployment says so, and the old one still does not.
  const reloaded = await f.create(true);
  assert.deepEqual(await seen(reloaded, 'bob', 'north'), {
    ...viewerNorth,
    rows: [
      {
        id: 'north-1',
        name: 'North one',
        owner: 'bob',
        secret: 'NORTH_SECRET',
      },
    ],
    columns: ['id', 'name', 'owner', 'secret'],
  });
  assert.deepEqual(await seen(deployment, 'bob', 'north'), viewerNorth);
});
