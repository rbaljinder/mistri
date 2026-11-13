/**
 * A tenant command's lookup reads its resource's hidden columns (a field report: a vendor's reference kept from every
 * reader, handed to the vendor in the outside call). `hidden` keeps a column from people — every read, form and
 * catalog they are served — not from the server code an App's author wrote: the handler's `db` has always read it,
 * and so does the lookup now, on the record it acts on and through `sources`. A role's own column rule still narrows
 * the lookup, as it narrows a generic read: hidden is lifted, nothing the role was not granted is. The person still
 * reads no hidden column.
 * SQLite always, PostgreSQL live-gated (support/tenantDialects.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const DATABASE = `lookup_hidden_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'stock', source: { id: 'business', connection: 'stock-db' }, storeId: 'lookup-hidden-store' };
const SCHEMA = {
  tables: ['item', 'note'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout = 0;
    CREATE TABLE item (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL, vendor_ref TEXT,
      version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE note (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, body TEXT NOT NULL, secret TEXT, memo TEXT);`,
  postgres: `
    CREATE TABLE public.item (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL, vendor_ref text,
      version integer NOT NULL DEFAULT 0);
    CREATE TABLE public.note (id text PRIMARY KEY, tenant_id text NOT NULL, body text NOT NULL, secret text, memo text);`,
};
const ROWS = `
    INSERT INTO item (id, tenant_id, name, vendor_ref) VALUES ('i1', 'north', 'Drum', 'V-100'), ('i2', 'north', 'Toner', 'V-200');
    INSERT INTO note VALUES ('n1', 'north', 'Reorder', 'S-1', 'M-1');`;

type Seen = { own?: unknown; through?: unknown; other?: unknown; note: Record<string, unknown> };
const registry = defineCommands({
  sync: defineCommand({
    source: 'business',
    target: 'item',
    input: {},
    sources: { business: ['item', 'note'] },
    output: { parse: (value: unknown) => value as Seen },
    async lookup({ sources, record }) {
      const note = (await sources.business.note.get('n1')) as Record<string, unknown>;
      return {
        own: record?.vendor_ref ?? null,
        through: (await sources.business.item.get(String(record!.id))).vendor_ref ?? null,
        other: (await sources.business.item.where({ name: 'Toner' }).limit(1))[0]?.vendor_ref ?? null,
        note: Object.fromEntries(Object.entries(note).sort(([a], [b]) => a.localeCompare(b))),
      };
    },
    async handle({ lookup }) {
      return lookup as Seen;
    },
  }),
});

const ROWS_ALL: RowScope = { item: true, note: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: { item: { kind: 'tenant', column: 'tenant_id' }, note: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ROWS_ALL,
  resolveRows: () => ROWS_ALL,
  resultReferences: { sync: () => [] },
});
const manifest = () => ({
  id: binding.appId,
  name: 'Stock',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    item: { owner: 'tenant', access: 'write', hidden: ['vendor_ref'] },
    note: { owner: 'tenant', hidden: ['secret'] },
  },
  auth: {
    rows: 'tenant',
    roles: {
      // Reads every item column a person may; of a note, never the memo.
      clerk: { read: ['item', 'note'], fields: { note: { read: ['id', 'body', 'secret'] } }, commands: ['sync'] },
    },
  },
  views: { items: { kind: 'list', from: 'item' } },
  nav: ['items'],
  home: 'items',
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
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
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
    app: parseTestApp(manifest(), 'stock.ts'),
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
    sync: () =>
      deployment.execute(alice, ['north'], {
        command: 'sync',
        commandVersion: 1,
        key: { id: 'i1' },
        expectedVersion: 0,
        idempotencyKey: 'sync-attempt-0001',
        input: {},
      }),
  };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a tenant command's lookup reads hidden columns on ${dialect}`, { skip }, () => {
    test('on its own record and through sources, while the role’s column rule still narrows it', async (t) => {
      const f = await enrolled(t, dialect);
      const done = await f.sync();
      assert.equal(done.status, 'applied', JSON.stringify(done));
      assert.deepEqual(JSON.parse(JSON.stringify(done.result)), {
        own: 'V-100',
        through: 'V-100',
        other: 'V-200',
        // The hidden secret is there; the memo, outside the role's column rule, is not.
        note: { body: 'Reorder', id: 'n1', secret: 'S-1' },
      });
    });
  });
