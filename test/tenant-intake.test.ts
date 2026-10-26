/**
 * Public intake on a tenant App, as a dialect matrix (support/tenantDialects.ts):
 * SQLite always, PostgreSQL live-gated, on a database of this suite's own. A
 * lender (the platform realm) above its dealers (tenants); a dealer publishes
 * its public form with its intake address, `?via=…`, which the lender keeps on
 * the dealer's profile row.
 *
 * What is proved: the server alone resolves an address, to the one active
 * dealer whose row holds it; every other submission — no address, an unknown,
 * malformed, shared or ghost one, a suspended dealer's — lands with the lender
 * for triage, and answers exactly as a placed one does. Nothing the visitor
 * types chooses a dealer. The handler is told where it lands and may insert
 * only there, the owner injected; the receipt names the public principal and
 * no membership, in the dealer's namespace or the lender's; the submission key
 * replays. The writer checks everything resolution read — the dealer's row,
 * the lender's row, and the address still on the dealer's profile — so a
 * suspension or rotation that commits first sends the submission back to be
 * resolved again, and one in flight waits for it.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { captureCommandJournalTenant, COMMAND_JOURNAL_TABLES as journal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { auditRows } from './support/commandTargets.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { AUDIT_REDACTED, defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { AppTenantPolicyDefinitionError, defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { refusalReasons, TenantContextError } from '../packages/engine/src/server/evidence.js';
import { createTenantEnrollment, type TenantEnrollment } from '../packages/mistri/src/server/tenant/tenantEnrollment.js';
import type { TenantIntakeEvidence } from '../packages/mistri/src/server/tenant/tenantIntakeModel.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { TenantIntakeMoved, TenantWriteFailure, type TenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { parseTestApp } from './support/commandCatalog.js';

/* This suite's own PostgreSQL database, beside the server's, so it never
   resets another run's tables; dropped when the suite ends. */
const DATABASE = `intake_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

const binding = { appId: 'lending', source: { id: 'business', connection: 'business-db' }, storeId: 'intake-store' };
// Unguessable in a deployment; fixed here so each test can name them.
const NORTH = 'north-intake-AAAAAAAAAAAAAAAA',
  SOUTH = 'south-intake-BBBBBBBBBBBBBBBB',
  WEST = 'west-intake-CCCCCCCCCCCCCCCCC';
const SHARED = 'shared-intake-DDDDDDDDDDDDDDD',
  GHOST = 'ghost-intake-EEEEEEEEEEEEEEEE',
  UNKNOWN = 'unknown-intake-FFFFFFFFFFFFFF';
const ROTATED = 'rotated-intake-GGGGGGGGGGGGGG';

const SCHEMA = {
  tables: ['intake_submission', 'lead', 'dealer'],
  sqlite: `PRAGMA journal_mode=WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 0;
    CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
    CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT NOT NULL,
      name TEXT NOT NULL, UNIQUE (tenant_id, reference));
    CREATE TABLE intake_submission (id TEXT PRIMARY KEY NOT NULL, reference TEXT NOT NULL, name TEXT NOT NULL, dealer_hint TEXT);`,
  postgres: `
    CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL, intake_address text);
    CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), reference text NOT NULL,
      name text NOT NULL, UNIQUE (tenant_id, reference));
    CREATE TABLE public.intake_submission (id text PRIMARY KEY, reference text NOT NULL, name text NOT NULL, dealer_hint text);`,
};
// `east` and `far` share one address, so it names nobody; `ghost` has a profile row and no tenant.
const ROWS = `
    INSERT INTO dealer VALUES ('north', 'North Motors', '${NORTH}'), ('south', 'South Auto', '${SOUTH}'), ('west', 'West Wheels', '${WEST}'),
      ('east', 'East Cars', '${SHARED}'), ('far', 'Far Cars', '${SHARED}'), ('ghost', 'Ghost Motors', '${GHOST}');
    INSERT INTO lead VALUES ('seeded', 'north', 'IGN-seeded', 'Seeded lead');`;
const OWNERSHIP = {
  dealer: { kind: 'platform' },
  lead: { kind: 'tenant', column: 'tenant_id' },
  intake_submission: { kind: 'platform' },
} as const;
const ROTATE = `UPDATE dealer SET intake_address = '${ROTATED}' WHERE id = 'north'`;
const SUSPEND_PLATFORM = `UPDATE "${TENANT_TABLES.tenant}" SET status = 'suspended', version = '2' WHERE id = '@platform'`;

const input = {
  name: { label: 'Name', type: 'text', max: 80 },
  dealer_hint: { label: 'Dealer code', type: 'text', max: 32, optional: true },
} as const;
const manifest = () => ({
  id: binding.appId,
  name: 'Lending',
  sources: { business: { connection: binding.source.connection } },
  resources: {
    dealer: { owner: 'platform' },
    lead: { access: 'write', owner: 'tenant' },
    intake_submission: { access: 'write', owner: 'platform' },
  },
  auth: {
    rows: 'tenant',
    tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
    roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
  },
  views: {
    leads: { kind: 'list', from: 'lead' },
    triage: { kind: 'list', from: 'intake_submission' },
    apply: { kind: 'form', label: 'Apply for financing', public: true, command: { id: 'apply', version: 1, input } },
  },
  nav: [
    { id: 'dealership', label: 'Dealership', realm: 'tenant', children: ['leads'] },
    { id: 'lender', label: 'Lender', realm: 'platform', children: ['triage'] },
  ],
  home: 'leads',
});

/* What the handler does, set per test: place the row where it is told, the
   other place, with an owner of its choosing, an update of its own dealer's
   lead or another dealer's, or a removal. */
let mode: 'place' | 'misplace' | 'owner' | 'update' | 'cross' | 'remove' = 'place';
const told: string[] = [];
const registry = defineCommands({
  apply: defineCommand({
    targets: 'none',
    source: 'business',
    target: 'lead',
    write: ['intake_submission'],
    public: true,
    input,
    output: shape({ reference: text(), message: literal('Application received.') }),
    async handle({ db, tx, intake }, value) {
      told.push(String(intake));
      // The same reference in every dealer, and with the lender: equal business ids, and equal answers.
      const reference = `IGN-${value.name}`;
      if (mode === 'owner')
        await tx.insert({ table: 'lead', values: { id: randomUUID(), reference, name: value.name, tenant_id: 'south' } });
      else if (mode === 'update') await tx.update({ table: 'lead', key: { id: 'seeded' }, values: { name: 'Renamed by the public' } });
      else if (mode === 'cross') await tx.update({ table: 'lead', key: { id: 'southern' }, values: { name: 'Renamed by the public' } });
      else if (mode === 'remove') await tx.remove({ table: 'lead', key: { id: 'seeded' } });
      else if ((intake === 'tenant') === (mode === 'place')) await db.lead.insert({ id: randomUUID(), reference, name: value.name });
      else await db.intake_submission.insert({ id: randomUUID(), reference, name: value.name, dealer_hint: value.dealer_hint ?? null });
      return { reference, message: 'Application received.' };
    },
  }),
});
const everything = { dealer: true, lead: true, intake_submission: true };
const policy = (patch: Record<string, unknown> = {}) =>
  defineAppTenantPolicy({
    kind: 'tenant',
    appId: binding.appId,
    storeId: binding.storeId,
    ownership: OWNERSHIP,
    resolveMembershipRows: () => everything,
    resolveRows: () => everything,
    resolvePlatformRows: () => everything,
    resultReferences: { apply: () => [] },
    intake: { address: 'intake_address' },
    ...patch,
  });

type Request = { readonly cookie?: string };
const counted = (table: string) => `SELECT CAST(count(*) AS INTEGER) AS n FROM "${table}"`;

async function engineFor(dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    tables: SCHEMA.tables,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  await engine.provisionStore(binding);
  await engine.migrateCommandJournal();
  await engine.maintenance(binding, async (admin) => {
    for (const tenantId of ['north', 'south', 'west', 'east', 'far'])
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'north-alice',
      roles: ['staff'],
      status: 'active',
      validUntil: 1_000_000,
      expectedVersion: null,
    });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  await engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'west', status: 'suspended', expectedVersion: '1' }));
  return engine;
}

async function enrolled(t: TestContext, dialect: TenantDialect, patch: Record<string, unknown> = {}) {
  const engine = await engineFor(dialect);
  let service: TenantEnrollment<Request> | undefined;
  t.after(async () => {
    try {
      await service?.retire();
    } finally {
      await engine.close();
    }
  });
  service = await createTenantEnrollment<Request>({
    app: parseTestApp(manifest(), 'lending.ts'),
    policy: policy(patch),
    source: { ...binding.source, ...(dialect === 'postgres' ? { url: engine.url } : { existingPath: engine.path }) },
    deployment: 'generation',
    roles: ['staff', 'manager'],
    maxLifetimeMs: 60_000,
    now: () => 100,
    commands: { registry },
    verifySession: (request) => (request.cookie === 'alice' ? { id: 'alice', who: 'Alice' } : null),
  });
  const submit = (address: unknown, name: string, submission = randomUUID()) =>
    service!.deployment.submitIntake({ form: 'apply', address, input: { name }, submission });
  const rows = (sql: string) => engine.all(sql);
  return { engine, service, submit, rows };
}

async function sources(t: TestContext, dialect: TenantDialect) {
  const engine = await engineFor(dialect);
  const opened: Array<TenantReadSource | TenantWriteSource> = [];
  t.after(async () => {
    try {
      await Promise.all(opened.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  const physicalSchema = await engine.physicalSchema();
  const resources = Object.fromEntries(SCHEMA.tables.map((name) => [name, engine.id(name)]));
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: OWNERSHIP,
    profile: 'dealer',
  });
  const reader = await engine.openRead(ownership, binding, () => 1000);
  opened.push(reader);
  const writer = await engine.openWrite(ownership, binding, () => 1000);
  opened.push(writer);
  const resolve = (address: string | null) =>
    reader.resolveIntake({ appId: binding.appId, source: binding.source, deployment: 'd1', column: 'intake_address', address });
  const evidence = async (address: string | null): Promise<TenantIntakeEvidence> => {
    const { tenantId, tenantVersion, platformVersion } = await resolve(address);
    return {
      realm: 'intake',
      appId: binding.appId,
      source: binding.source,
      deployment: 'd1',
      form: 'apply',
      tenantId,
      tenantVersion,
      platformVersion,
      column: 'intake_address',
      address: tenantId === '@platform' ? null : address,
      verifiedAt: 1000,
      validUntil: 6000,
      drafting: false,
    };
  };
  const footprint = { dealer: false, lead: true, intake_submission: true };
  return { engine, reader, writer, resolve, evidence, footprint };
}
const receipt = (id: string) => ({
  id,
  appId: binding.appId,
  actorId: 'public:apply',
  commandId: 'apply',
  commandVersion: 1,
  idempotencyKey: `${id}-key`,
  fingerprint: 'fingerprint',
  resultJson: '{}',
  requestId: 'request',
  completedAt: '2026-09-15T12:00:00.000Z',
});
const notApplied = (error: unknown) => error instanceof TenantWriteFailure && error.outcome === 'not_applied';
const moved = (error: unknown) => error instanceof TenantIntakeMoved && error.outcome === 'not_applied';
const refused = (code: string) => (error: unknown) =>
  error instanceof BusinessCommandExecutionError && error.code === code && error.outcome === 'not_applied';
async function settles(promise: Promise<unknown>, ms = 300): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(ms).then(() => false),
  ]);
}

/* ---------- declarations, no database ---------- */

test('policy: intake names a plain profile column and needs a platform-owned table', () => {
  const base = { kind: 'tenant' as const, appId: 'lending', storeId: 'store', resolveMembershipRows: () => ({}), resolveRows: () => ({}) };
  const lead = { kind: 'tenant' as const, column: 'tenant_id' };
  const withPlatform = { ...base, ownership: { lead, dealer: { kind: 'platform' as const } }, resolvePlatformRows: () => ({}) };
  assert.deepEqual(
    { ...defineAppTenantPolicy({ ...withPlatform, intake: { address: 'intake_address' } }).intake },
    { address: 'intake_address' },
  );
  for (const intake of [{ address: 'intake address' }, { address: '' }, { address: 'intake_address', tenant: 'north' }, 'intake_address']) {
    assert.throws(() => defineAppTenantPolicy({ ...withPlatform, intake: intake as never }), AppTenantPolicyDefinitionError);
  }
  // No platform-owned table, so no profile to hold an address and no lender for triage.
  assert.throws(
    () => defineAppTenantPolicy({ ...base, ownership: { lead }, intake: { address: 'intake_address' } }),
    AppTenantPolicyDefinitionError,
  );
});

test('journal: only the public principal, with no role, takes membership revision 0', () => {
  const owner = {
    appId: 'lending',
    storeId: 'store',
    sourceId: 'business',
    tenantId: 'north',
    actorId: 'public:apply',
    membershipId: 'public:apply',
    membershipVersion: '0',
    tenantVersion: '1',
    roles: [],
    deployment: 'd1',
  };
  assert.equal(captureCommandJournalTenant(owner).membershipVersion, '0');
  for (const patch of [
    { actorId: 'alice', membershipId: 'alice' },
    { membershipId: 'north-alice' },
    { roles: ['staff'] },
    { actorId: 'public:Apply', membershipId: 'public:Apply' },
    { tenantVersion: '0' },
  ]) {
    assert.throws(() => captureCommandJournalTenant({ ...owner, ...patch }), JSON.stringify(patch));
  }
});

/* ---------- the matrix ---------- */

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`public intake on ${dialect}`, { skip }, () => {
    const postgres = dialect === 'postgres';

    test('the reader resolves an address to the one active dealer whose row holds it, and anything else to the lender', async (t) => {
      const f = await sources(t, dialect);
      assert.deepEqual({ ...(await f.resolve(NORTH)) }, { tenantId: 'north', tenantVersion: '1', platformVersion: '1' });
      assert.deepEqual({ ...(await f.resolve(SOUTH)) }, { tenantId: 'south', tenantVersion: '1', platformVersion: '1' });
      // A suspended dealer, an address two rows share, a profile with no tenant, one nobody holds, and none.
      for (const address of [WEST, SHARED, GHOST, UNKNOWN, null]) {
        assert.deepEqual(
          { ...(await f.resolve(address)) },
          { tenantId: '@platform', tenantVersion: '1', platformVersion: '1' },
          String(address),
        );
      }
      // The lookup is the server's: a column that is the tenant key, not text, or absent, and a malformed address, refuse.
      for (const column of ['id', 'tenant_id', 'missing']) {
        await assert.rejects(
          f.reader.resolveIntake({ appId: binding.appId, source: binding.source, deployment: 'd1', column, address: NORTH }),
          TenantContextError,
          column,
        );
      }
      await assert.rejects(f.resolve('north'), TenantContextError);
      // A lender that is not active takes nothing, whatever the address.
      await f.engine.maintenance(binding, (admin) => admin.putPlatform({ status: 'suspended', expectedVersion: '1' }));
      for (const address of [NORTH, UNKNOWN]) await assert.rejects(f.resolve(address), TenantContextError);
    });

    test("the writer places a dealer's row with the owner injected, and the lender's row with no owner; each journaled in its own namespace", async (t) => {
      const f = await sources(t, dialect);
      await f.writer.intakeCommandTransaction(await f.evidence(NORTH), f.footprint, async (tx, receipts) => {
        await tx.insert({ table: 'lead', values: { id: 'n-public', reference: 'IGN-1', name: 'Ada' } });
        await receipts.commit(receipt('north-receipt'), { target: 'lead', keyJson: '{"id":"n-public"}', changesJson: '[]' });
      });
      await f.writer.intakeCommandTransaction(await f.evidence(UNKNOWN), f.footprint, async (tx, receipts) => {
        await tx.insert({ table: 'intake_submission', values: { id: 't-public', reference: 'IGN-1', name: 'Ada' } });
        await receipts.commit(receipt('triage-receipt'), { target: 'lead', keyJson: '{"id":"t-public"}', changesJson: '[]', owner: '' });
      });
      assert.deepEqual(await f.engine.all('SELECT id, tenant_id FROM lead ORDER BY id'), [
        { id: 'n-public', tenant_id: 'north' },
        { id: 'seeded', tenant_id: 'north' },
      ]);
      assert.deepEqual(await f.engine.all(`SELECT realm, tenant_id, actor_id FROM "${journal.receipt}" ORDER BY realm DESC`), [
        { realm: 'tenant', tenant_id: 'north', actor_id: 'public:apply' },
        { realm: 'platform', tenant_id: '', actor_id: 'public:apply' },
      ]);
      assert.deepEqual(
        await f.engine.all(`SELECT realm, owner_tenant_id, membership_id, membership_version, realm_version, roles_json
      FROM ${auditRows(f.engine.dialect)} a ORDER BY realm DESC`),
        [
          {
            realm: 'tenant',
            owner_tenant_id: 'north',
            membership_id: 'public:apply',
            membership_version: '0',
            realm_version: '1',
            roles_json: '[]',
          },
          {
            realm: 'platform',
            owner_tenant_id: '',
            membership_id: 'public:apply',
            membership_version: '0',
            realm_version: '1',
            roles_json: '[]',
          },
        ],
      );
    });

    test("the writer lets intake insert, and update its own tenant's rows, only in its place: never an owner, another place, another tenant's row, triage's update or a removal", async (t) => {
      const f = await sources(t, dialect);
      await f.engine.exec("INSERT INTO lead VALUES ('southern', 'south', 'IGN-southern', 'South lead')");
      const north = await f.evidence(NORTH),
        triage = await f.evidence(null);
      type Work = Parameters<TenantWriteSource['intakeCommandTransaction']>[2];
      const attempts: Array<[TenantIntakeEvidence, Work]> = [
        [north, (tx) => tx.insert({ table: 'lead', values: { id: 'x1', reference: 'IGN-x1', name: 'Planted', tenant_id: 'south' } })],
        [north, (tx) => tx.insert({ table: 'intake_submission', values: { id: 'x2', reference: 'IGN-x2', name: 'Wrong place' } })],
        [north, (tx) => tx.update({ table: 'lead', key: { id: 'southern' }, values: { name: 'Renamed' } })],
        [north, (tx) => tx.update({ table: 'lead', key: { id: 'seeded' }, values: { tenant_id: 'south' } })],
        [north, (tx) => tx.remove({ table: 'lead', key: { id: 'seeded' } })],
        [triage, (tx) => tx.insert({ table: 'lead', values: { id: 'x3', reference: 'IGN-x3', name: 'Placed by triage' } })],
        [triage, (tx) => tx.update({ table: 'lead', key: { id: 'seeded' }, values: { name: 'Renamed' } })],
      ];
      for (const [evidence, work] of attempts)
        await assert.rejects(f.writer.intakeCommandTransaction(evidence, f.footprint, work), notApplied);
      // The one change it may make: its own tenant's row, in place.
      await f.writer.intakeCommandTransaction(north, f.footprint, (tx) =>
        tx.update({ table: 'lead', key: { id: 'seeded' }, values: { name: 'Renamed' } }),
      );
      // Each realm's evidence only through its own method, and evidence that does not hang together not at all.
      await assert.rejects(
        f.writer.commandTransaction(north as never, f.footprint, () => undefined),
        notApplied,
      );
      await assert.rejects(
        f.writer.platformCommandTransaction(triage as never, f.footprint, () => undefined),
        notApplied,
      );
      for (const forged of [
        { ...north, realm: 'platform' },
        { ...north, address: null },
        { ...triage, platformVersion: '2' },
        { ...north, address: 'north' },
      ]) {
        await assert.rejects(
          f.writer.intakeCommandTransaction(forged as never, f.footprint, () => undefined),
          notApplied,
        );
      }
      assert.deepEqual(await f.engine.all('SELECT id, tenant_id, name FROM lead ORDER BY id'), [
        { id: 'seeded', tenant_id: 'north', name: 'Renamed' },
        { id: 'southern', tenant_id: 'south', name: 'South lead' },
      ]);
      assert.deepEqual(await f.engine.all(counted('intake_submission')), [{ n: 0 }]);
    });

    test('whatever moved after resolution — the dealer, the lender or the address — refuses on the writer before the handler, and says it moved', async (t) => {
      const f = await sources(t, dialect);
      let entered = false;
      const enter = () => {
        entered = true;
      };
      // The dealer suspended.
      const north = await f.evidence(NORTH);
      await f.engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
      await assert.rejects(f.writer.intakeCommandTransaction(north, f.footprint, enter), moved);
      assert.equal((await f.resolve(NORTH)).tenantId, '@platform', 'resolved now, the same address lands with the lender');
      // The address rotated: the old one never reaches the dealer.
      const south = await f.evidence(SOUTH);
      await f.engine.exec(`UPDATE dealer SET intake_address = '${ROTATED}' WHERE id = 'south'`);
      await assert.rejects(f.writer.intakeCommandTransaction(south, f.footprint, enter), moved);
      // The lender suspended: a dealer's submission and triage alike.
      const lender = await f.evidence(null),
        rotated = await f.evidence(ROTATED);
      assert.equal(rotated.tenantId, 'south');
      await f.engine.maintenance(binding, (admin) => admin.putPlatform({ status: 'suspended', expectedVersion: '1' }));
      for (const evidence of [lender, rotated])
        await assert.rejects(f.writer.intakeCommandTransaction(evidence, f.footprint, enter), moved);
      assert.equal(entered, false);
      assert.deepEqual(await f.engine.all(counted(journal.receipt)), [{ n: 0 }]);
    });

    test(
      postgres
        ? 'the intake fence holds a suspension of the dealer or the lender, and a rotation of the address, until the submission commits'
        : 'the BEGIN IMMEDIATE writer blocks a suspension of the dealer or the lender, and a rotation of the address, until the submission commits',
      async (t) => {
        const f = await sources(t, dialect);
        const suspend = `UPDATE "${TENANT_TABLES.tenant}" SET status = 'suspended', version = '2' WHERE id = 'north'`;
        for (const change of [suspend, SUSPEND_PLATFORM, ROTATE]) {
          const id = `n-held-${randomUUID().slice(0, 8)}`;
          if (postgres) {
            const session = await f.engine.session();
            let changing: Promise<unknown> | undefined;
            await f.writer.intakeCommandTransaction(await f.evidence(NORTH), f.footprint, async (tx) => {
              await tx.insert({ table: 'lead', values: { id, reference: id, name: 'Held' } });
              changing = session.query(`BEGIN; ${change}; ROLLBACK`);
              assert.equal(await settles(changing), false, `${change} waits for the submission`);
            });
            await changing;
          } else {
            let blocked: unknown;
            await f.writer.intakeCommandTransaction(await f.evidence(NORTH), f.footprint, async (tx) => {
              await tx.insert({ table: 'lead', values: { id, reference: id, name: 'Held' } });
              try {
                f.engine.sqlite().prepare(change).run();
              } catch (error) {
                blocked = error;
              }
            });
            assert.ok(blocked instanceof Error, change);
            assert.match(blocked.message, /locked/);
          }
          assert.deepEqual(await f.engine.all(`SELECT tenant_id FROM lead WHERE id = '${id}'`), [{ tenant_id: 'north' }]);
        }
      },
    );

    test('a public submission lands where its address says, and every placement answers alike', async (t) => {
      told.length = 0;
      mode = 'place';
      const f = await enrolled(t, dialect);
      const placed = await f.submit(NORTH, 'Ada');
      const others = [];
      for (const address of [WEST, SHARED, GHOST, UNKNOWN, undefined, 'north', 'north-intake-AAAAAAAAAAAAAAA!', 42])
        others.push(await f.submit(address, 'Ada'));
      assert.deepEqual(told, ['tenant', ...others.map(() => 'platform')]);
      // One shape, one reference, whatever the placement: nothing in the answer says where it went.
      for (const other of [placed, ...others]) {
        assert.deepEqual(Object.keys(other).sort(), [
          'command',
          'commandVersion',
          'key',
          'receiptId',
          'replayed',
          'resource',
          'result',
          'status',
        ]);
        assert.deepEqual({ ...(other.result as object) }, { reference: 'IGN-Ada', message: 'Application received.' });
        assert.equal(other.status, 'applied');
        assert.equal(other.replayed, false);
        assert.equal(other.resource, 'lead');
      }
      assert.deepEqual(await f.rows("SELECT tenant_id, reference FROM lead WHERE reference = 'IGN-Ada'"), [
        { tenant_id: 'north', reference: 'IGN-Ada' },
      ]);
      assert.deepEqual(await f.rows(counted('intake_submission')), [{ n: others.length }]);
      // The dealer's receipt in its namespace, the lender's in the platform's; the public principal in the membership's place.
      assert.deepEqual(
        await f
          .rows(`SELECT realm, tenant_id, count(*) AS n FROM "${journal.receipt}" GROUP BY realm, tenant_id ORDER BY realm DESC`)
          .then((rows) => rows.map((row) => ({ ...row, n: Number(row.n) }))),
        [
          { realm: 'tenant', tenant_id: 'north', n: 1 },
          { realm: 'platform', tenant_id: '', n: others.length },
        ],
      );
      const audits = await f.rows(
        `SELECT DISTINCT actor_id, membership_id, membership_version, roles_json FROM ${auditRows(f.engine.dialect)} a`,
      );
      assert.deepEqual(audits, [{ actor_id: 'public:apply', membership_id: 'public:apply', membership_version: '0', roles_json: '[]' }]);
      // A public command's audit keeps column names, never what the applicant typed.
      for (const row of await f.rows(`SELECT changes_json FROM ${auditRows(f.engine.dialect)} a`)) {
        assert.match(String(row.changes_json), new RegExp(AUDIT_REDACTED.replace(/[[\]]/g, '\\$&')));
        assert.doesNotMatch(String(row.changes_json), /Ada/);
      }
    });

    test('the submission key replays its receipt in its own place; equal references live in two dealers', async (t) => {
      told.length = 0;
      mode = 'place';
      const f = await enrolled(t, dialect);
      const key = randomUUID();
      const first = await f.submit(NORTH, 'Grace', key),
        again = await f.submit(NORTH, 'Grace', key);
      assert.equal(again.replayed, true);
      assert.equal(again.receiptId, first.receiptId);
      assert.deepEqual({ ...(again.result as object) }, { ...(first.result as object) });
      // The same key with different input is a conflict, not a second lead.
      await assert.rejects(
        f.submit(NORTH, 'Someone else', key),
        (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'idempotency_conflict',
      );
      const lender = randomUUID(),
        triaged = await f.submit(undefined, 'Grace', lender);
      assert.equal(
        (await f.submit(UNKNOWN, 'Grace', lender)).receiptId,
        triaged.receiptId,
        "an unknown address replays the lender's receipt",
      );
      // Another dealer's address is another place: the same business reference is that dealer's own.
      await f.submit(SOUTH, 'Grace', key);
      assert.deepEqual(await f.rows("SELECT tenant_id FROM lead WHERE reference = 'IGN-Grace' ORDER BY tenant_id"), [
        { tenant_id: 'north' },
        { tenant_id: 'south' },
      ]);
      assert.deepEqual(told, ['tenant', 'platform', 'tenant']);
    });

    test('the transaction refuses a handler that writes outside its place, and nothing it tried stays', async (t) => {
      told.length = 0;
      const f = await enrolled(t, dialect);
      await f.engine.exec("INSERT INTO lead VALUES ('southern', 'south', 'IGN-southern', 'South lead')");
      try {
        for (const [attempt, address] of [
          ['misplace', NORTH],
          ['misplace', UNKNOWN],
          ['owner', NORTH],
          ['cross', NORTH],
          ['update', UNKNOWN],
          ['remove', NORTH],
        ] as const) {
          mode = attempt;
          await assert.rejects(
            f.submit(address, 'Mallory'),
            // Another dealer's row is outside the scope, as a member's would be: refused unapplied.
            attempt === 'cross'
              ? (error: unknown) => error instanceof BusinessCommandExecutionError && error.outcome === 'not_applied'
              : refused('forbidden'),
            `${attempt} ${address}`,
          );
        }
        // A refused removal names the write it refused, for the operator's log, never the visitor's answer.
        mode = 'remove';
        const removal = await f.submit(NORTH, 'Mallory').then(
          () => assert.fail('a public removal applied'),
          (error: unknown) => error,
        );
        assert.match(refusalReasons(removal).join(' | '), /a public submission (removes no lead row|names no record)/);
        assert.doesNotMatch((removal as Error).message, /lead/);
      } finally {
        mode = 'place';
      }
      assert.deepEqual(await f.rows('SELECT id, tenant_id, name FROM lead ORDER BY id'), [
        { id: 'seeded', tenant_id: 'north', name: 'Seeded lead' },
        { id: 'southern', tenant_id: 'south', name: 'South lead' },
      ]);
      assert.deepEqual(await f.rows(counted('intake_submission')), [{ n: 0 }]);
      assert.deepEqual(await f.rows(counted(journal.receipt)), [{ n: 0 }]);
      // Refused alike: the shape of what was typed, whatever the address.
      for (const address of [NORTH, UNKNOWN]) {
        await assert.rejects(
          f.service.deployment.submitIntake({ form: 'apply', address, input: {}, submission: randomUUID() }),
          (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'invalid_input' && error.field === 'name',
        );
      }
    });

    test("a public submission placed with a dealer updates that dealer's row its command declares, and lands one receipt", async (t) => {
      const f = await enrolled(t, dialect);
      mode = 'update';
      try {
        assert.equal((await f.submit(NORTH, 'Rotor')).status, 'applied');
      } finally {
        mode = 'place';
      }
      assert.deepEqual(await f.rows('SELECT id, tenant_id, name FROM lead'), [
        { id: 'seeded', tenant_id: 'north', name: 'Renamed by the public' },
      ]);
      assert.deepEqual(await f.rows(counted(journal.receipt)), [{ n: 1 }]);
    });

    test("a member never runs the public command, and intake runs nothing but the App's public form", async (t) => {
      const f = await enrolled(t, dialect);
      await assert.rejects(
        f.service.deployment.execute({ cookie: 'alice' }, ['north'], {
          command: 'apply',
          commandVersion: 1,
          key: {},
          expectedVersion: 0,
          idempotencyKey: randomUUID(),
          input: { name: 'Alice' },
        }),
        BusinessCommandExecutionError,
      );
      await assert.rejects(
        f.service.deployment.submitIntake({ form: 'leads', address: NORTH, input: { name: 'Ada' }, submission: randomUUID() }),
        refused('forbidden'),
      );
      assert.deepEqual(await f.rows(counted(journal.receipt)), [{ n: 0 }]);
    });
  });

/* ---------- a change between resolution and the write, end to end (SQLite) ---------- */

/* The rotation or suspension commits on the file's own connection the moment
   the reader has prepared its address lookup, inside the reader's snapshot,
   which still shows the old state; the writer then sees the new one. */
describe('public intake between resolution and the write', () => {
  const between = async (t: TestContext, change: string) => {
    const f = await enrolled(t, 'sqlite');
    let done = false;
    f.engine.intercept(t, {
      match: (statement) => !statement.writer && statement.sql.includes('intake_address') && statement.sql.includes('LIMIT 2'),
      after: () => {
        if (!done) {
          done = true;
          f.engine.sqlite().prepare(change).run();
        }
      },
    });
    return f;
  };
  test('an address rotated after resolution never reaches the dealer: the submission is resolved again and lands with the lender', async (t) => {
    told.length = 0;
    mode = 'place';
    const f = await between(t, ROTATE);
    const result = await f.submit(NORTH, 'Hedy');
    assert.equal(result.status, 'applied');
    assert.deepEqual({ ...(result.result as object) }, { reference: 'IGN-Hedy', message: 'Application received.' });
    assert.deepEqual(told, ['platform'], 'the handler ran once, with the lender');
    assert.deepEqual(await f.rows("SELECT count(*) AS n FROM lead WHERE reference = 'IGN-Hedy'"), [{ n: 0 }]);
    assert.deepEqual(await f.rows('SELECT name FROM intake_submission'), [{ name: 'Hedy' }]);
    assert.deepEqual(await f.rows(`SELECT realm, tenant_id FROM "${journal.receipt}"`), [{ realm: 'platform', tenant_id: '' }]);
  });
  test('a lender suspended after resolution refuses the submission as it refuses every one, and nothing is written', async (t) => {
    told.length = 0;
    mode = 'place';
    const f = await between(t, SUSPEND_PLATFORM);
    await assert.rejects(
      f.submit(NORTH, 'Hedy'),
      (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'temporarily_unavailable',
    );
    await assert.rejects(
      f.submit(UNKNOWN, 'Hedy'),
      (error: unknown) => error instanceof BusinessCommandExecutionError && error.code === 'temporarily_unavailable',
    );
    assert.deepEqual(told, []);
    assert.deepEqual(await f.rows(counted(journal.receipt)), [{ n: 0 }]);
  });
});

/* ---------- enrollment refusals ---------- */

describe('public intake enrollment', () => {
  const refusedEnrollment = async (t: TestContext, patch: Record<string, unknown>, alter?: (raw: ReturnType<typeof manifest>) => void) => {
    const engine = await engineFor('sqlite');
    t.after(() => engine.close());
    const raw = manifest();
    alter?.(raw);
    await assert.rejects(
      createTenantEnrollment<Request>({
        app: parseTestApp(raw, 'lending.ts'),
        policy: policy(patch),
        source: { ...binding.source, existingPath: engine.path },
        deployment: 'generation',
        roles: ['staff', 'manager'],
        maxLifetimeMs: 60_000,
        commands: { registry },
        verifySession: () => null,
      }),
      TenantContextError,
    );
  };
  test("a public form without the policy's intake is refused, not served as a 503 later", async (t) => {
    const { intake: _intake, ...rest } = policy();
    const engine = await engineFor('sqlite');
    t.after(() => engine.close());
    await assert.rejects(
      createTenantEnrollment<Request>({
        app: parseTestApp(manifest(), 'lending.ts'),
        policy: defineAppTenantPolicy(rest),
        source: { ...binding.source, existingPath: engine.path },
        deployment: 'generation',
        roles: ['staff', 'manager'],
        maxLifetimeMs: 60_000,
        commands: { registry },
        verifySession: () => null,
      }),
      TenantContextError,
    );
  });
  test('an intake address that is the tenant key, not text, or not on the profile is refused', async (t) => {
    for (const address of ['id', 'missing']) await refusedEnrollment(t, { intake: { address } });
  });
  test('intake with no public form to serve is refused', async (t) => {
    await refusedEnrollment(t, {}, (raw) => {
      delete (raw.views as Record<string, unknown>).apply;
    });
  });
});

test('public experiment admission resolves native intake placement and rejects rotation before release', async (t) => {
  const f = await enrolled(t, 'sqlite');
  const admit = f.service!.deployment.withPublicFlagIntake!;
  let retained: (() => void) | undefined;
  await admit('apply', NORTH, async (owner) => {
    assert.equal(owner.tenantId, 'north');
    await owner.current();
    retained = owner.assertCurrent;
  });
  assert.throws(() => retained!());
  await admit('apply', UNKNOWN, async (owner) => {
    assert.equal(owner.tenantId, null);
    await owner.current();
  });
  await assert.rejects(admit('leads', NORTH, async () => {}));
  await assert.rejects(
    admit('apply', NORTH, async (owner) => {
      assert.equal(owner.tenantId, 'north');
      await f.engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
    }),
  );
});
