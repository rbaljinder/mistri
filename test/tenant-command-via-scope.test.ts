/**
 * A command reads a table scoped through another (`via`) without declaring that other table (a field report: a global
 * catalog a tenant sees only where it stocks the item, read by a command whose read named the catalog alone, answered
 * empty, and check said nothing). The row policy's `via` reads its target under the policy's own scope, whatever the
 * command declares; it is not a read of the target the command makes, so its rows are not handed to the handler.
 * SQLite always, PostgreSQL live-gated (support/tenantDialects.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { via, type RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const DATABASE = `via_scope_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'shop', source: { id: 'business', connection: 'shop-db' }, storeId: 'via-scope-store' };
const SCHEMA = {
  tables: ['product', 'stock', 'basket'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout = 0;
    CREATE TABLE product (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE stock (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES product(id));
    CREATE INDEX stock_product ON stock (product_id);
    CREATE TABLE basket (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);`,
  postgres: `
    CREATE TABLE public.product (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.stock (id text PRIMARY KEY, tenant_id text NOT NULL, product_id text NOT NULL REFERENCES public.product(id));
    CREATE INDEX stock_product ON public.stock (product_id);
    CREATE TABLE public.basket (id text PRIMARY KEY, tenant_id text NOT NULL, version integer NOT NULL DEFAULT 0);`,
};
/* North stocks the drum, south the toner; nobody stocks the fuser. */
const ROWS = `
    INSERT INTO product VALUES ('drum', 'Drum'), ('toner', 'Toner'), ('fuser', 'Fuser');
    INSERT INTO stock VALUES ('s1', 'north', 'drum'), ('s2', 'south', 'toner');
    INSERT INTO basket (id, tenant_id) VALUES ('b1', 'north');`;

// The escape hatch hands a table's name straight to the scoped store, so it is held to the footprint as `db` is.
const viaTx = (table: string) =>
  defineCommand({
    source: 'business',
    target: 'basket',
    read: ['product'],
    input: {},
    output: { parse: (value: unknown) => value as { rows: unknown } },
    async handle({ tx }) {
      try {
        return { rows: (await tx.query({ table, limit: 10, offset: 0 })).rows.length };
      } catch {
        return { rows: 'refused' };
      }
    },
  });
const registry = defineCommands({
  peekTx: viaTx('stock'),
  offerTx: viaTx('product'),
  // Reads the catalog and nothing else: `stock` is the policy's business, not the command's.
  offer: defineCommand({
    source: 'business',
    target: 'basket',
    read: ['product'],
    input: {},
    output: { parse: (value: unknown) => value as { names: string[] } },
    async handle({ db }) {
      const rows = (await (db as never as { product: { where: (filter: object) => Promise<{ name: string }[]> } }).product.where({})) ?? [];
      return { names: rows.map((row) => row.name).sort() };
    },
  }),
  // Asks for the table the policy reads through: the command did not declare it, so it is not the handler's to read.
  peek: defineCommand({
    source: 'business',
    target: 'basket',
    read: ['product'],
    input: {},
    output: { parse: (value: unknown) => value as { stock: unknown } },
    async handle({ db }) {
      try {
        const rows = await (db as never as { stock: { where: (filter: object) => Promise<unknown[]> } }).stock.where({});
        return { stock: rows.length };
      } catch {
        return { stock: 'refused' };
      }
    },
  }),
});

const SCOPE: RowScope = { product: { groups: [[via('id', 'stock', 'product_id')]] }, stock: true, basket: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: {
    product: { kind: 'global', access: 'read-only' },
    stock: { kind: 'tenant', column: 'tenant_id' },
    basket: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => SCOPE,
  resolveRows: () => SCOPE,
  resultReferences: { offer: () => [], peek: () => [], peekTx: () => [], offerTx: () => [] },
});
const manifest = () => ({
  id: binding.appId,
  name: 'Shop',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    product: { owner: 'global' },
    stock: { owner: 'tenant' },
    basket: { owner: 'tenant', access: 'write' },
  },
  auth: { rows: 'tenant', roles: { clerk: { read: ['product', 'stock', 'basket'], commands: ['offer', 'peek', 'peekTx', 'offerTx'] } } },
  views: { baskets: { kind: 'list', from: 'basket' } },
  nav: ['baskets'],
  home: 'baskets',
});

type Request = { readonly cookie?: string };
const alice: Request = { cookie: 'alice' };

async function enrolled(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  let service: TenantEnrollment<Request> | undefined;
  t.after(async () => {
    try {
      await service?.retire();
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'north-alice',
      status: 'active',
      validUntil: 1_000_000,
      expectedVersion: null,
      roles: ['clerk'],
    });
  });
  service = await createTenantEnrollment<Request>({
    app: parseTestApp(manifest(), 'shop.ts'),
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['clerk'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: (request) => (request.cookie === 'alice' ? { id: 'alice', who: 'Alice' } : null),
  });
  const deployment = service.deployment;
  return {
    run: (command: string) =>
      deployment.execute(alice, ['north'], {
        command,
        commandVersion: 1,
        key: { id: 'b1' },
        expectedVersion: 0,
        idempotencyKey: `${command}-attempt-0001`,
        input: {},
      }),
  };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a command reads a table scoped through one it does not declare on ${dialect}`, { skip }, () => {
    test('the rows the policy admits, through the undeclared table', async (t) => {
      const f = await enrolled(t, dialect);
      const done = await f.run('offer');
      assert.equal(done.status, 'applied', JSON.stringify(done));
      assert.deepEqual(JSON.parse(JSON.stringify(done.result)), { names: ['Drum'] });
    });

    test('the table read through is still not the handler’s', async (t) => {
      const f = await enrolled(t, dialect);
      const done = await f.run('peek');
      assert.equal(done.status, 'applied', JSON.stringify(done));
      assert.deepEqual(JSON.parse(JSON.stringify(done.result)), { stock: 'refused' });
    });
  });

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`the raw transaction of a command reads what its footprint names, on ${dialect}`, { skip }, () => {
    test('a table reached only through a via is refused, and the refusal ends the command', async (t) => {
      const f = await enrolled(t, dialect);
      // The facade holds the raw transaction to the declared read (authorizeTransaction), so a handler that catches the
      // refusal still does not get the rows, and the run is not applied.
      await assert.rejects(f.run('peekTx'), (error: Error & { code?: string }) => error.code === 'forbidden');
    });

    test('the declared table still reads through the via', async (t) => {
      const f = await enrolled(t, dialect);
      const done = await f.run('offerTx');
      assert.equal(done.status, 'applied', JSON.stringify(done));
      assert.deepEqual(JSON.parse(JSON.stringify(done.result)), { rows: 1 });
    });
  });
