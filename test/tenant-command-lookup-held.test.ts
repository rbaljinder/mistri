/**
 * A command its record refuses makes no outside call (a field report: a lookup asked a vendor about an order the
 * command was then refused for, as it stood in a state its verb does not leave). The record is read before the
 * lookup, and a machine verb's state or a `when` that plainly fails of it holds the lookup back; the transaction then
 * refuses the command in its usual words. A record its command admits still has its lookup run once.
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

const DATABASE = `lookup_held_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'orders', source: { id: 'business', connection: 'orders-db' }, storeId: 'lookup-held-store' };
const SCHEMA = {
  tables: ['purchase'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout = 0;
    CREATE TABLE purchase (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, status TEXT NOT NULL, rush INTEGER NOT NULL,
      quoted TEXT, version INTEGER NOT NULL DEFAULT 0);`,
  postgres: `
    CREATE TABLE public.purchase (id text PRIMARY KEY, tenant_id text NOT NULL, status text NOT NULL, rush integer NOT NULL,
      quoted text, version integer NOT NULL DEFAULT 0);`,
};
const ROWS = `
    INSERT INTO purchase (id, tenant_id, status, rush) VALUES
      ('p1', 'north', 'draft', 1), ('p2', 'north', 'sent', 1), ('p3', 'north', 'draft', 0);`;

/* Each lookup is an outside call: counted, by the record it asked about. */
const calls: string[] = [];
const asking = () => ({
  async lookup({ record }: { record?: Readonly<Record<string, unknown>> }) {
    calls.push(String(record?.id));
    return { price: '12.00' };
  },
});
const registry = defineCommands({
  // A verb of the purchase's machine: it leaves only a draft.
  send: defineCommand({
    source: 'business',
    target: 'purchase',
    write: ['purchase'],
    input: {},
    ...asking(),
    async handle({ db, lookup, record }) {
      await (db as never as { purchase: { update: (row: unknown, changes: unknown) => Promise<unknown> } }).purchase.update(record, {
        status: 'sent',
        quoted: (lookup as { price: string }).price,
      });
    },
  }),
  // Asked only of a rush order.
  expedite: defineCommand({
    source: 'business',
    target: 'purchase',
    input: {},
    when: 'rush = 1',
    ...asking(),
    async handle() {},
  }),
});

const ROWS_ALL: RowScope = { purchase: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: { purchase: { kind: 'tenant', column: 'tenant_id' } },
  resolveMembershipRows: () => ROWS_ALL,
  resolveRows: () => ROWS_ALL,
  resultReferences: { send: () => [], expedite: () => [] },
});
const manifest = () => ({
  id: binding.appId,
  name: 'Orders',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    purchase: {
      owner: 'tenant',
      access: 'write',
      machine: { column: 'status', states: { draft: { on: { send: 'sent' } }, sent: { final: true } } },
    },
  },
  auth: { rows: 'tenant', roles: { clerk: { read: ['purchase'], commands: ['send', 'expedite'] } } },
  views: { purchases: { kind: 'list', from: 'purchase' } },
  nav: ['purchases'],
  home: 'purchases',
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
    app: parseTestApp(manifest(), 'orders.ts', { send: { target: 'purchase' }, expedite: { target: 'purchase' } }),
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
  calls.length = 0;
  return {
    run: (command: string, id: string) =>
      deployment.execute(alice, ['north'], {
        command,
        commandVersion: 1,
        key: { id },
        expectedVersion: 0,
        idempotencyKey: `${command}-${id}-attempt-0001`,
        input: {},
      }),
    quoted: async (id: string) =>
      ((await engine.all(`SELECT quoted FROM purchase WHERE id = '${id}'`)) as { quoted: unknown }[])[0]?.quoted,
  };
}

const refusal = (run: Promise<unknown>) =>
  run.then(
    (done) => ({ done }),
    (error: { code?: string }) => ({ code: error.code }),
  );

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a refused command makes no lookup call on ${dialect}`, { skip }, () => {
    test('a machine verb from a state that does not list it', async (t) => {
      const f = await enrolled(t, dialect);
      assert.deepEqual(await refusal(f.run('send', 'p2')), { code: 'ineligible_state' });
      assert.deepEqual(calls, [], 'no outside call for a record already sent');
      const sent = await f.run('send', 'p1');
      assert.equal(sent.status, 'applied', JSON.stringify(sent));
      assert.deepEqual(calls, ['p1'], 'a draft is asked about once');
      assert.equal(await f.quoted('p1'), '12.00');
    });

    test('a when the record does not meet', async (t) => {
      const f = await enrolled(t, dialect);
      assert.deepEqual(await refusal(f.run('expedite', 'p3')), { code: 'ineligible_state' });
      assert.deepEqual(calls, [], 'no outside call for an order that is not a rush');
      const done = await f.run('expedite', 'p1');
      assert.equal(done.status, 'applied', JSON.stringify(done));
      assert.deepEqual(calls, ['p1']);
    });
  });
