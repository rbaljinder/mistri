/**
 * A platform command that acts in one named tenant (G1), as a dialect matrix
 * (support/tenantDialects.ts): SQLite always, PostgreSQL live-gated, on a
 * database of this suite's own.
 *
 * `defineCommand({ realm: 'platform', tenant: 'dealer', ... })` names the
 * input field that says which tenant. What is proved:
 * - The command inserts that tenant's rows with the owner placed for it,
 *   beside a platform row, in one transaction; the receipt is the platform
 *   member's and every audit row names the tenant.
 * - Nothing of another tenant is in its scope: updating, removing or
 *   reassigning another tenant's row, or placing a row with another owner,
 *   is refused and nothing it tried stays.
 * - The tenant is read, active, before the transaction and fenced there: a
 *   suspended or unknown tenant is refused, `@platform` is not a tenant, and
 *   the writer refuses a tenant version that moved and a revoked membership.
 * - A tenant's member never runs it, and the declaration says what it needs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, test, type TestContext } from 'node:test';
import { COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { BusinessCommandDefinitionError, defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { composePlatformTenantScope, type PlatformTenantEvidence } from '../packages/mistri/src/server/tenant/tenantPlatformTenant.js';
import { TenantWriteFailure } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { parseTestApp } from './support/commandCatalog.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const DATABASE = `platform_tenant_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'lending', source: { id: 'business', connection: 'lending-db' }, storeId: 'platform-tenant-store' };
const SCHEMA = {
  tables: ['review_file', 'lead', 'dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL);
    CREATE TABLE review_file (id TEXT PRIMARY KEY NOT NULL, lead_id TEXT NOT NULL REFERENCES lead(id), note TEXT);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL);
    CREATE TABLE public.review_file (id text PRIMARY KEY, lead_id text NOT NULL REFERENCES public.lead(id), note text);`,
};
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO lead VALUES ('n1', 'north', 'North lead'), ('n2', 'north', 'Spare lead'), ('s1', 'south', 'South lead');
    INSERT INTO review_file VALUES ('r1', 'n1', 'Lender only');`;
const OWNERSHIP = {
  dealer: { kind: 'platform' },
  lead: { kind: 'tenant', column: 'tenant_id' },
  review_file: { kind: 'platform' },
} as const;

const seedInput = { dealer: { label: 'Dealer', type: 'text' }, id: { label: 'Lead', type: 'text' } } as const;
const reachInput = { dealer: { label: 'Dealer', type: 'text' }, mode: { label: 'Mode', type: 'text' } } as const;
const output = shape({ id: text() });
const registry = defineCommands({
  seed: defineCommand({
    realm: 'platform',
    tenant: 'dealer',
    source: 'business',
    target: 'lead',
    targets: 'none',
    read: ['dealer'],
    write: ['review_file'],
    input: seedInput,
    output,
    async handle({ db }, input) {
      // No owner: the tenant is the request's, placed by the writer.
      await db.lead.insert({ id: input.id, name: `Seeded ${input.id}` });
      await db.review_file.insert({ id: `review-${input.id}`, lead_id: input.id, note: 'Boarded' });
      return { id: input.id };
    },
  }),
  reach: defineCommand({
    realm: 'platform',
    tenant: 'dealer',
    source: 'business',
    target: 'lead',
    targets: 'none',
    // A lead's removal reads what references it.
    read: ['dealer', 'review_file'],
    input: reachInput,
    output,
    // The raw transaction, on purpose: what the scope refuses whatever a handler asks of it.
    async handle({ tx }, input) {
      if (input.mode === 'rename-own') await tx.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'Renamed' } });
      else if (input.mode === 'remove-own') await tx.remove({ table: 'lead', key: { id: 'n2' } });
      else if (input.mode === 'rename-other') await tx.update({ table: 'lead', key: { id: 's1' }, values: { name: 'Renamed' } });
      else if (input.mode === 'remove-other') await tx.remove({ table: 'lead', key: { id: 's1' } });
      else if (input.mode === 'place-other') await tx.insert({ table: 'lead', values: { id: 'x1', tenant_id: 'south', name: 'Planted' } });
      else if (input.mode === 'move') await tx.update({ table: 'lead', key: { id: 'n1' }, values: { tenant_id: 'south' } });
      return { id: input.mode };
    },
  }),
});
const manifest = () => ({
  id: binding.appId,
  name: 'Lending',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    lead: { access: 'write', owner: 'tenant' },
    review_file: { access: 'write', owner: 'platform' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: {
      staff: { realm: 'tenant', read: true },
      manager: { realm: 'platform', read: true, commands: ['seed', 'reach'] },
    },
  },
  views: {
    leads: { kind: 'list', from: 'lead' },
    dealers: { kind: 'list', from: 'dealer' },
    board: { kind: 'form', label: 'Seed a lead', realm: 'platform', command: { id: 'seed', version: 1, input: seedInput } },
    reach: { kind: 'form', label: 'Reach', realm: 'platform', command: { id: 'reach', version: 1, input: reachInput } },
  },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers', 'board', 'reach'] },
  ],
  home: 'leads',
});
const everything = { dealer: true, lead: true, review_file: true };
const policy = defineAppTenantPolicy({
  kind: 'tenant',
  appId: binding.appId,
  storeId: binding.storeId,
  ownership: OWNERSHIP,
  resolveMembershipRows: () => everything,
  resolveRows: () => everything,
  resolvePlatformRows: () => everything,
  resultReferences: { seed: () => [], reach: () => [] },
});

type Request = { readonly cookie?: string };
const lee: Request = { cookie: 'lee' },
  alice: Request = { cookie: 'alice' };
const identities: Record<string, { id: string; who: string }> = { lee: { id: 'lee', who: 'Lee' }, alice: { id: 'alice', who: 'Alice' } };
/* By code alone: a scoped refusal before its receipt was looked up says `unknown`, since a retry's earlier
   attempt may have committed (businessCommandExecution.ts); what stays is read off the rows. */
const refused = (code?: string) => (error: unknown) =>
  error instanceof BusinessCommandExecutionError && (code === undefined || error.code === code);
/** A count both engines answer as a number: PostgreSQL's own count is a bigint, which arrives as text. */
const counted = (table: string) => `SELECT CAST(count(*) AS INTEGER) AS n FROM "${table}"`;

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
  const grant = { status: 'active' as const, validUntil: 1_000_000, expectedVersion: null };
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({ ...grant, tenantId: 'north', accountId: 'alice', membershipId: 'north-alice', roles: ['staff'] });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({ ...grant, accountId: 'lee', membershipId: 'platform-lee', roles: ['manager'] });
  });
  service = await createTenantEnrollment<Request>({
    app: parseTestApp(manifest(), 'lending.ts'),
    policy,
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['staff', 'manager'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: (request) => identities[request.cookie ?? ''] ?? null,
  });
  const deployment = service.deployment;
  let attempt = 0;
  const body = (command: 'seed' | 'reach', input: Record<string, string>) => ({
    command,
    commandVersion: 1,
    key: {},
    expectedVersion: 0,
    idempotencyKey: `${command}-attempt-${String(++attempt).padStart(4, '0')}`,
    input,
  });
  const run = (command: 'seed' | 'reach', input: Record<string, string>) => deployment.executePlatform(lee, body(command, input));
  const rows = async (sql: string) => (await engine.all(sql)).map((row) => ({ ...row }));
  const leads = () => rows('SELECT id, tenant_id, name FROM lead ORDER BY id');
  return { engine, deployment, body, run, rows, leads };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a platform command in one named tenant on ${dialect}`, { skip }, () => {
    test("it places that tenant's row beside a platform row; the receipt is the member's and the audit names the tenant", async (t) => {
      const f = await enrolled(t, dialect);
      const done = await f.run('seed', { dealer: 'north', id: 'n9' });
      assert.equal(done.status, 'applied');
      assert.deepEqual(await f.rows("SELECT id, tenant_id, name FROM lead WHERE id = 'n9'"), [
        { id: 'n9', tenant_id: 'north', name: 'Seeded n9' },
      ]);
      assert.deepEqual(await f.rows("SELECT id, lead_id FROM review_file WHERE id = 'review-n9'"), [{ id: 'review-n9', lead_id: 'n9' }]);
      assert.deepEqual(await f.rows(`SELECT realm, tenant_id, actor_id FROM "${journal.receipt}"`), [
        { realm: 'platform', tenant_id: '', actor_id: 'lee' },
      ]);
      assert.deepEqual(await f.rows(`SELECT realm, tenant_id, owner_tenant_id, membership_id FROM ${auditRows(f.engine.dialect)} a`), [
        { realm: 'platform', tenant_id: '', owner_tenant_id: 'north', membership_id: 'platform-lee' },
      ]);
      // The other tenant is untouched, and the tenant's own member reads the new lead as theirs.
      const seen = await f.deployment.withContext(alice, ['north'], async (context) =>
        (await context.data.query({ table: 'lead', limit: 10, offset: 0, orderBy: [{ column: 'id', direction: 'asc' }] })).rows.map(
          (row) => row.id,
        ),
      );
      assert.deepEqual(seen, ['n1', 'n2', 'n9']);
    });

    test("it updates and removes that tenant's rows", async (t) => {
      const f = await enrolled(t, dialect);
      assert.equal((await f.run('reach', { dealer: 'north', mode: 'rename-own' })).status, 'applied');
      assert.equal((await f.run('reach', { dealer: 'north', mode: 'remove-own' })).status, 'applied');
      assert.deepEqual(await f.leads(), [
        { id: 'n1', tenant_id: 'north', name: 'Renamed' },
        { id: 's1', tenant_id: 'south', name: 'South lead' },
      ]);
    });

    for (const mode of ['rename-other', 'remove-other', 'place-other', 'move'])
      test(`no other tenant's row is in its scope: ${mode} is refused and nothing stays`, async (t) => {
        const f = await enrolled(t, dialect);
        await assert.rejects(f.run('reach', { dealer: 'north', mode }), refused());
        assert.deepEqual(await f.leads(), [
          { id: 'n1', tenant_id: 'north', name: 'North lead' },
          { id: 'n2', tenant_id: 'north', name: 'Spare lead' },
          { id: 's1', tenant_id: 'south', name: 'South lead' },
        ]);
        assert.deepEqual(await f.rows(counted(journal.receipt)), [{ n: 0 }]);
      });

    test('a suspended or unknown tenant is refused, and the platform is not a tenant', async (t) => {
      const f = await enrolled(t, dialect);
      await f.engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
      await assert.rejects(f.run('seed', { dealer: 'north', id: 'n9' }), refused());
      await assert.rejects(f.run('seed', { dealer: 'west', id: 'w1' }), refused());
      await assert.rejects(f.run('seed', { dealer: '@platform', id: 'p1' }), refused('invalid_input'));
      assert.deepEqual(await f.rows("SELECT id FROM lead WHERE id IN ('n9', 'w1', 'p1')"), []);
      assert.deepEqual(await f.rows(counted(journal.receipt)), [{ n: 0 }]);
      // Another tenant, still active, is acted in as before.
      assert.equal((await f.run('seed', { dealer: 'south', id: 's9' })).status, 'applied');
    });

    /* The runtime reads the tenant's row before the transaction; the writer
       fences it at that version inside it. A suspension between the two, or
       a revoked membership, refuses the write before anything lands. */
    test("the writer fences the tenant's row at the version read, and the platform membership", async (t) => {
      const f = await enrolled(t, dialect);
      const physicalSchema = await f.engine.physicalSchema();
      const resources = Object.fromEntries(['dealer', 'lead', 'review_file'].map((name) => [name, f.engine.id(name)]));
      const ownership = captureTenantOwnership({
        appId: binding.appId,
        source: binding.source,
        schema: appResourceCatalog(physicalSchema, resources).schema,
        physicalSchema,
        resources,
        ownership: OWNERSHIP,
        profile: 'dealer',
      });
      const reader = await f.engine.openRead(ownership, binding, () => 1000);
      const writer = await f.engine.openWrite(ownership, binding, () => 1000);
      t.after(() => Promise.all([reader.close(), writer.close()]));
      const lookup = {
        realm: 'platform' as const,
        appId: binding.appId,
        accountId: 'lee',
        source: binding.source,
        deployment: 'deployment-1',
      };
      const member = await reader.readPlatformMembership(lookup);
      assert.ok(member);
      const evidence: PlatformTenantEvidence = {
        ...lookup,
        realm: 'platform-tenant',
        membershipId: member.membershipId,
        membershipVersion: member.membershipVersion,
        platformVersion: member.platformVersion,
        roles: [...member.roles],
        verifiedAt: 1000,
        validUntil: 6000,
        tenantId: 'north',
        tenantVersion: (await reader.readServiceAnchors('north')).tenantVersion!,
      };
      const place = (id: string, given = evidence) =>
        writer.platformTenantCommandTransaction(given, everything, (records) =>
          records.insert({ table: 'lead', values: { id, name: id } }),
        );
      const notApplied = (error: unknown) => error instanceof TenantWriteFailure && error.outcome === 'not_applied';
      await place('n7');
      // Its own realm's evidence only: a platform member's is refused before the writer's queue.
      await assert.rejects(place('n8', { ...evidence, realm: 'platform' } as never), notApplied);
      await f.engine.maintenance(binding, (admin) =>
        admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: evidence.tenantVersion }),
      );
      await assert.rejects(place('n8'), notApplied);
      await f.engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: '2' }));
      // Active again, at a later version: the version read before is stale.
      await assert.rejects(place('n8'), notApplied);
      const fresh = { ...evidence, tenantVersion: (await reader.readServiceAnchors('north')).tenantVersion! };
      await place('n8', fresh);
      await f.engine.maintenance(binding, (admin) =>
        admin.putPlatformMembership({
          status: 'revoked',
          validUntil: 1_000_000,
          accountId: 'lee',
          membershipId: 'platform-lee',
          roles: ['manager'],
          expectedVersion: member.membershipVersion,
        }),
      );
      await assert.rejects(place('n6', fresh), notApplied);
      assert.deepEqual(await f.rows("SELECT id, tenant_id FROM lead WHERE id IN ('n6', 'n7', 'n8') ORDER BY id"), [
        { id: 'n7', tenant_id: 'north' },
        { id: 'n8', tenant_id: 'north' },
      ]);
    });

    test("a tenant's member never runs it, in their own tenant or as the platform", async (t) => {
      const f = await enrolled(t, dialect);
      await assert.rejects(f.deployment.execute(alice, ['north'], f.body('seed', { dealer: 'north', id: 'n9' })), refused());
      await assert.rejects(f.deployment.executePlatform(alice, f.body('seed', { dealer: 'north', id: 'n9' })));
      assert.deepEqual(await f.rows("SELECT id FROM lead WHERE id = 'n9'"), []);
    });
  });

test('the scope is the platform policy with every tenant table narrowed to the named tenant, never widened', (t) => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(SCHEMA.sqlite.replace(/PRAGMA[^;]*;/g, ''));
  db.exec('BEGIN IMMEDIATE');
  const schema = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  const owned = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    schema,
    physicalSchema: structuredClone(schema),
    resources: Object.fromEntries(schema.tables.map((table) => [table.id, table.id])),
    ownership: OWNERSHIP,
    profile: 'dealer',
  });
  const evidence: PlatformTenantEvidence = {
    realm: 'platform-tenant',
    appId: binding.appId,
    accountId: 'lee',
    source: binding.source,
    deployment: 'generation-1',
    membershipId: 'platform-lee',
    membershipVersion: '1',
    platformVersion: '1',
    roles: ['manager'],
    verifiedAt: 1000,
    validUntil: 6000,
    tenantId: 'north',
    tenantVersion: '1',
  };
  const policy = {
    dealer: true,
    lead: { groups: [[{ column: 'name', op: '=' as const, value: 'a' }], [{ column: 'name', op: '=' as const, value: 'b' }]] },
    review_file: true,
  };
  const scope = JSON.parse(JSON.stringify(composePlatformTenantScope(owned, evidence, policy))) as Record<string, unknown>;
  assert.deepEqual(scope, {
    dealer: true,
    lead: {
      groups: [
        [
          { column: 'name', op: '=', value: 'a' },
          { column: 'tenant_id', op: '=', value: 'north' },
        ],
        [
          { column: 'name', op: '=', value: 'b' },
          { column: 'tenant_id', op: '=', value: 'north' },
        ],
      ],
      binary: ['tenant_id'],
    },
    review_file: true,
  });
  // A tenant table the policy denies stays denied, and evidence that is not this kind's is refused.
  assert.equal(composePlatformTenantScope(owned, evidence, { ...policy, lead: false }).lead, false);
  assert.throws(() => composePlatformTenantScope(owned, { ...evidence, realm: 'platform' } as never, policy));
  assert.throws(() => composePlatformTenantScope(owned, { ...evidence, tenantId: '@platform' }, policy));
});

test('the declaration says what a command acting in one tenant needs', () => {
  const base = {
    source: 'business',
    target: 'lead',
    targets: 'none' as const,
    output,
    handle: () => ({ id: 'x' }),
  };
  const refusal = (definition: Record<string, unknown>, message: RegExp) =>
    assert.throws(
      () => defineCommand({ ...base, ...definition } as never),
      (error: unknown) => error instanceof BusinessCommandDefinitionError && message.test(error.message),
    );
  refusal({ tenant: 'dealer', input: seedInput }, /a tenant's own command acts in its own/);
  refusal({ realm: 'platform', tenant: 'nobody', input: seedInput }, /"nobody", which is not a field of its input/);
  refusal(
    { realm: 'platform', tenant: 'dealer', input: { dealer: { label: 'Dealer', type: 'text', optional: true } } },
    /which a run may leave empty/,
  );
  refusal({ realm: 'platform', tenant: 'dealer', input: { dealer: { label: 'Dealer', type: 'number' } } }, /a number field/);
  refusal(
    { realm: 'platform', tenant: 'dealer', input: { dealer: { label: 'Dealer', type: 'text', sensitive: { keep: 'hash' } } } },
    /a sensitive field/,
  );
  assert.equal(defineCommand({ ...base, realm: 'platform', tenant: 'dealer', input: seedInput }).tenant, 'dealer');
});
