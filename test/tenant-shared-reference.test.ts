/**
 * A shared profile column that is a reference (a field report: a tenant's plan kept as a pointer to a vocabulary table
 * could not be shared, so it was rebuilt as text under a CHECK list of the vocabulary's ids). `auth.tenancy.shared`
 * shares a reference's stored value: the row scope and a command's handler read the plan's id, and a member's rows are
 * compared with it like any other shared column. A reference to the profile itself is another tenant's key, and check
 * still refuses it, as it refuses the key.
 * SQLite always, PostgreSQL live-gated (support/tenantDialects.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { sharedProfileProblems } from '../packages/mistri/src/server/app/appTenantProfile.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const DATABASE = `shared_ref_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'desk', source: { id: 'business', connection: 'desk-db' }, storeId: 'shared-ref-store' };
const SCHEMA = {
  tables: ['plan', 'customer', 'feature'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA busy_timeout = 0;
    CREATE TABLE plan (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE customer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, plan_id TEXT REFERENCES plan(id));
    CREATE TABLE feature (id TEXT PRIMARY KEY NOT NULL, plan_id TEXT NOT NULL REFERENCES plan(id), name TEXT NOT NULL);
    CREATE TABLE ticket (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);`,
  postgres: `
    CREATE TABLE public.plan (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.customer (id text PRIMARY KEY, name text NOT NULL, plan_id text REFERENCES public.plan(id));
    CREATE TABLE public.feature (id text PRIMARY KEY, plan_id text NOT NULL REFERENCES public.plan(id), name text NOT NULL);
    CREATE TABLE public.ticket (id text PRIMARY KEY, tenant_id text NOT NULL, version integer NOT NULL DEFAULT 0);`,
};
const ROWS = `
    INSERT INTO plan VALUES ('free', 'Free'), ('pro', 'Pro');
    INSERT INTO customer VALUES ('north', 'North', 'pro'), ('south', 'South', 'free');
    INSERT INTO feature VALUES ('f1', 'free', 'Email'), ('f2', 'pro', 'Phone'), ('f3', 'pro', 'Chat');
    INSERT INTO ticket (id, tenant_id) VALUES ('t1', 'north'), ('t2', 'south');`;

type Offered = { plan: unknown; features: string[] };
const registry = defineCommands({
  offered: defineCommand({
    source: 'business',
    target: 'ticket',
    read: ['feature'],
    input: {},
    output: { parse: (value: unknown) => value as Offered },
    async handle({ db, tenant }) {
      const plan = (tenant as Record<string, unknown>).plan_id;
      const rows =
        (await (db as never as { feature: { where: (filter: object) => Promise<{ name: string }[]> } }).feature.where({ plan_id: plan })) ??
        [];
      return { plan, features: rows.map((row) => row.name).sort() };
    },
  }),
});

const SCOPE: RowScope = { feature: true, ticket: true };
const profilesSeen: Array<Record<string, unknown>> = [];
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: {
    plan: { kind: 'global', access: 'read-only' },
    customer: { kind: 'platform' },
    feature: { kind: 'global', access: 'read-only' },
    ticket: { kind: 'tenant', column: 'tenant_id' },
  },
  resolveMembershipRows: () => SCOPE,
  resolveRows: (_member, { tenant }) => {
    profilesSeen.push({ ...tenant });
    return SCOPE;
  },
  resultReferences: { offered: () => [] },
  resolvePlatformRows: () => ({ ...SCOPE, plan: true, customer: true }),
});
const manifest = () => ({
  id: binding.appId,
  name: 'Desk',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    plan: { owner: 'global' },
    customer: { owner: 'platform' },
    feature: { owner: 'global' },
    ticket: { owner: 'tenant', access: 'write' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Customer', profile: 'customer', shared: ['plan_id'], platform: { label: 'Operator' } },
    roles: { agent: { realm: 'tenant', read: ['feature', 'ticket'], commands: ['offered'] }, operator: { realm: 'platform', read: true } },
  },
  views: { tickets: { kind: 'list', from: 'ticket', realm: 'tenant' } },
  nav: [{ id: 'desk', label: 'Desk', realm: 'tenant', children: ['tickets'] }],
  home: 'tickets',
});

type Request = { readonly cookie?: string };
const eve: Request = { cookie: 'eve' };

async function enrolled(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: [...SCHEMA.tables, 'ticket'],
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
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({
        tenantId,
        accountId: 'eve',
        membershipId: `${tenantId}-eve`,
        status: 'active',
        validUntil: 1_000_000,
        expectedVersion: null,
        roles: ['agent'],
      });
    }
  });
  service = await createTenantEnrollment<Request>({
    app: parseTestApp(manifest(), 'desk.ts'),
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['agent'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: (request) => (request.cookie === 'eve' ? { id: 'eve', who: 'Eve' } : null),
  });
  const deployment = service.deployment;
  profilesSeen.length = 0;
  return {
    offered: (tenant: string, id: string) =>
      deployment.execute(eve, [tenant], {
        command: 'offered',
        commandVersion: 1,
        key: { id },
        expectedVersion: 0,
        idempotencyKey: `offered-${id}-attempt-0001`,
        input: {},
      }),
  };
}

test('check shares a reference to a vocabulary and refuses one to the profile itself', () => {
  const column = (name: string, extra: object = {}) => ({ name, type: 'TEXT', nullable: true, primaryKey: false, ...extra });
  const catalog: DatabaseSchema = {
    dialect: 'sqlite',
    foreignKeys: [],
    tables: [
      {
        id: 'customer',
        name: 'customer',
        schema: '',
        isView: false,
        columns: [
          column('id', { primaryKey: true, nullable: false }),
          column('plan_id', { references: { table: 'plan', column: 'id' } }),
          column('parent_id', { references: { table: 'customer', column: 'id' } }),
        ],
      },
      { id: 'plan', name: 'plan', schema: '', isView: false, columns: [column('id', { primaryKey: true })] },
    ],
  } as unknown as DatabaseSchema;
  const app = parseTestApp(manifest(), 'desk.ts');
  const sharing = (shared: string[]) => ({ ...app, auth: { ...app.auth!, tenancy: { ...app.auth!.tenancy!, shared } } }) as typeof app;
  assert.deepEqual(sharedProfileProblems(sharing(['plan_id']), catalog), []);
  const problems = sharedProfileProblems(sharing(['parent_id']), catalog);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /"parent_id", which points at another tenant's profile.*\[tenant-shared-column\]/);
});

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a shared profile reference on ${dialect}`, { skip }, () => {
    test('the row scope and the handler read the stored value', async (t) => {
      const f = await enrolled(t, dialect);
      const north = await f.offered('north', 't1');
      assert.equal(north.status, 'applied', JSON.stringify(north));
      assert.deepEqual(JSON.parse(JSON.stringify(north.result)), { plan: 'pro', features: ['Chat', 'Phone'] });
      const south = await f.offered('south', 't2');
      assert.equal(south.status, 'applied', JSON.stringify(south));
      assert.deepEqual(JSON.parse(JSON.stringify(south.result)), { plan: 'free', features: ['Email'] });
      assert.ok(
        profilesSeen.some((tenant) => tenant.plan_id === 'pro'),
        JSON.stringify(profilesSeen),
      );
    });
  });
