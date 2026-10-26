/**
 * A tenant's sandbox: a clone of one tenant's configuration, and
 * its samples when asked, into a new tenant marked as a sandbox; its changes
 * imported back, all at once or not at all, on the live tenant owner's own
 * approval; and its dev clock, which only a sandbox has.
 *
 * What must never happen is tested as directly as what must: a clone reads
 * and writes only its source and its sandbox, an import writes only the
 * sandbox's own source, a third tenant is the same row for row afterwards,
 * and neither an operator, a member of another tenant nor a live tenant's
 * clock reaches what is not theirs. SQLite always; PostgreSQL when
 * TABLEWALK_TEST_PG names a server, on a database of each test's own.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import * as maintenance from '../packages/mistri/src/server/maintenance.js';
import {
  openSqliteTenantAdministration,
  openTenantAdministration,
  TenantAdministrationFailure,
  type TenantAdministration,
} from '../packages/mistri/src/server/tenant/tenantAdministration.js';
import type { AdministrationPolicy } from '../packages/mistri/src/server/tenant/tenantAdministrationModel.js';
import { migratePostgresTenantAdministrationJournal } from '../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import {
  cloneKey,
  tenantClonePlan,
  TenantCloneRefusal,
  type TenantClonePlan,
} from '../packages/mistri/src/server/tenant/tenantClonePlan.js';
import { cloneTenantSandbox, setSandboxClock, TenantMaintenanceRefusal } from '../packages/mistri/src/server/tenant/tenantMaintenance.js';
import { captureTenantOwnership, type ResourceOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { SANDBOX_TABLES } from '../packages/mistri/src/server/tenant/tenantSandboxStore.js';
import { TENANT_TABLES as tables } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { migratePostgresTenantStore } from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import type { AdministrationIntent } from '../packages/mistri/src/shared/tenantAdministration.js';
import { tenantAdministrationFixture } from './support/tenantAdministrationFixture.js';
import { pgClient, TENANT_DIALECTS, uuidPostgresDatabase, type TenantDialect } from './support/tenantDialects.js';
import { postgresRuntimeSql } from './support/runtimeSql.js';

type Row = Record<string, unknown>;
const HOUR = 3_600_000;
/* A pipeline's stages and rules are its configuration; its tickets are
   samples; its notes are neither, and never leave it. A stage's and a rule's
   shout are the database's own: a copy never names it, and it follows. */
const SCHEMA = `
  CREATE TABLE stage (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
    shout TEXT GENERATED ALWAYS AS (upper(name)) STORED);
  CREATE TABLE rule (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, stage_id TEXT REFERENCES stage(id), label TEXT NOT NULL,
    shout TEXT GENERATED ALWAYS AS (upper(label)) STORED);
  CREATE TABLE ticket (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, stage_id TEXT NOT NULL REFERENCES stage(id), title TEXT NOT NULL);
  CREATE TABLE note (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, body TEXT NOT NULL);`;
const SEED = `
  INSERT INTO stage (id, tenant_id, name) VALUES ('s1', 'north', 'New'), ('s2', 'north', 'Won'), ('s3', 'south', 'South new'), ('w1', 'west', 'West new');
  INSERT INTO rule (id, tenant_id, stage_id, label) VALUES ('r1', 'north', 's1', 'first'), ('r2', 'north', 's2', 'second'), ('w2', 'west', 'w1', 'west rule');
  INSERT INTO ticket VALUES ('t1', 'north', 's1', 'A sample'), ('w3', 'west', 'w1', 'West ticket');
  INSERT INTO note VALUES ('n1', 'north', 'private'), ('w4', 'west', 'west private');`;
const RESOURCES = ['stage', 'rule', 'ticket', 'note'] as const;
const tenantOwned: Record<string, ResourceOwnership> = Object.fromEntries(
  RESOURCES.map((name) => [name, { kind: 'tenant', column: 'tenant_id' }]),
);
const marks = { stage: { clone: 'config' }, rule: { clone: 'config' }, ticket: { clone: 'sample' }, note: {} };
// The plan reads only the resources' marks; the App's own validation of them is tested apart, below.
const appOf = (resources: Record<string, object>, id = 'admin-app') => ({ id, resources }) as unknown as AppDef;

/** On PostgreSQL, the snapshot from the server's own catalog, as startup reads it: each table schema-qualified
    (`public.ticket`) underneath, and named by itself above. */
async function ownedOnPostgres(url: string, appId: string, source: { id: string; connection: string }) {
  const adapter = new PostgresAdapter(url, 'Clone fixture');
  let physicalSchema: DatabaseSchema;
  try {
    physicalSchema = await adapter.introspect();
  } finally {
    await adapter.close();
  }
  const ours = physicalSchema.tables.filter((table) => table.schema === 'public' && !table.name.startsWith('__mistri'));
  physicalSchema = {
    ...physicalSchema,
    tables: ours,
    foreignKeys: physicalSchema.foreignKeys.filter((fk) => ours.some((t) => t.id === fk.from.table)),
  };
  const logical = mapScopeCatalog(physicalSchema, new Map(ours.map((table) => [table.id, table.name])));
  return captureTenantOwnership({
    appId,
    source,
    physicalSchema,
    schema: { ...logical, tables: logical.tables.map((table) => ({ ...table, name: table.id, schema: '' })) },
    resources: Object.fromEntries(ours.map((table) => [table.name, table.id])),
    ownership: Object.fromEntries(ours.map((table) => [table.name, tenantOwned[table.name] ?? { kind: 'tenant', column: 'tenant_id' }])),
  });
}

/** The ownership snapshot startup would hold for this schema. */
function ownedOf(
  ddl: string,
  appId: string,
  dialect: TenantDialect,
  ownership: Record<string, ResourceOwnership> = tenantOwned,
  source = { id: 'business', connection: 'business' },
) {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(ddl);
    db.exec('BEGIN');
    const schema = readSqliteScopeCatalog(db).schema;
    db.exec('COMMIT');
    const names = schema.tables.map((table) => table.id);
    // The same tables in PostgreSQL's public schema: the plan addresses each by the physical name startup bound.
    return captureTenantOwnership({
      appId,
      source,
      schema: dialect === 'postgres' ? { ...schema, dialect: 'postgres' } : schema,
      physicalSchema: structuredClone(schema),
      resources: Object.fromEntries(names.map((name) => [name, dialect === 'postgres' ? `public.${name}` : name])),
      ownership: Object.fromEntries(names.map((name) => [name, ownership[name] ?? { kind: 'tenant', column: 'tenant_id' }])),
    });
  } finally {
    db.close();
  }
}

const delegates = (
  operations: AdministrationPolicy['delegates'] extends readonly (infer D)[] | undefined
    ? D extends { operations: infer O }
      ? O
      : never
    : never = ['cloneTenant', 'importTenant'],
): AdministrationPolicy => ({
  id: 'sandboxes',
  version: 'v1',
  maxMembershipLifetimeMs: HOUR,
  operators: [],
  delegates: [{ role: 'owner', operations, roles: ['owner'] }],
});
const refused = (error: unknown) => error instanceof TenantAdministrationFailure && error.outcome === 'not_applied';

async function fixture(t: TestContext, dialect: TenantDialect) {
  const f = await tenantAdministrationFixture(t);
  let exec: (sql: string, ...params: unknown[]) => Promise<void>, all: (sql: string, ...params: unknown[]) => Promise<Row[]>;
  let where: { path: string } | { url: string }, target: maintenance.MaintenanceTarget;
  if (dialect === 'sqlite') {
    f.db.exec(SCHEMA + SEED);
    await maintenance.provisionStores({ sqlite: f.path }, { only: ['tenant-sandboxes'] });
    where = { path: f.path };
    target = { sqlite: f.path };
    exec = async (sql, ...params) => {
      f.db.prepare(sql).run(...(params as never[]));
    };
    all = async (sql, ...params) =>
      f.db
        .prepare(sql)
        .all(...(params as never[]))
        .map((row) => ({ ...row }));
  } else {
    const { url, drop } = await uuidPostgresDatabase('tenant_clone');
    const control = await pgClient(url);
    t.after(async () => {
      await control.end().catch(() => {});
      await drop();
    });
    await control.query(SCHEMA.replaceAll('TEXT', 'text') + SEED);
    await migratePostgresTenantStore(url, f.binding);
    await migratePostgresTenantAdministrationJournal(url, f.binding);
    await maintenance.provisionStores({ postgres: url }, { only: ['tenant-sandboxes'] });
    where = { url };
    target = { postgres: url };
    const numbered = (sql: string) => {
      let n = 0;
      return sql.replace(/\?/g, () => `$${++n}`);
    };
    exec = async (sql, ...params) => {
      await control.query(postgresRuntimeSql(numbered(sql)), params);
    };
    all = async (sql, ...params) => (await control.query(postgresRuntimeSql(numbered(sql)), params)).rows;
  }
  const plan = tenantClonePlan(
    appOf(marks),
    'url' in where
      ? await ownedOnPostgres(where.url, f.binding.appId, f.binding.source)
      : ownedOf(SCHEMA, f.binding.appId, dialect, tenantOwned, f.binding.source),
  )!;
  assert.ok(plan);
  const { operator, target: member, outsider } = f.users;
  await exec(
    `INSERT INTO "${tables.tenant}" (id, status, version, kind) VALUES ('north', 'active', '1', 'tenant'), ('south', 'active', '1', 'tenant'), ('west', 'active', '1', 'tenant')`,
  );
  const until = Date.now() + HOUR;
  const grant = (id: string, tenant: string, account: string, roles: string[]) =>
    exec(
      `INSERT INTO "${tables.membership}" (id, tenant_id, account_id, status, version, roles_json, valid_until, kind)
       VALUES (?, ?, ?, 'active', '1', ?, ?, 'member')`,
      id,
      tenant,
      account,
      JSON.stringify(roles),
      until,
    );
  // The operator owns north; the outsider owns south; the third account is north's staff, and owns nothing.
  await grant('north-owner', 'north', operator.accountId, ['owner']);
  await grant('north-staff', 'north', member.accountId, ['staff']);
  await grant('south-owner', 'south', outsider.accountId, ['owner']);
  const open = async (policy: AdministrationPolicy = delegates(), clone: TenantClonePlan | null = plan) => {
    const common = { binding: f.binding, auth: f.auth, deployment: 'clone-tests', policy, ...(clone ? { clone } : {}) };
    const owner: TenantAdministration =
      'path' in where
        ? await openSqliteTenantAdministration({ ...common, path: where.path })
        : await openTenantAdministration({ ...common, url: where.url });
    f.addCleanup(owner.retire);
    return owner;
  };
  /** One account's administration, opened on its own session. */
  const as = async (owner: TenantAdministration, who: 'operator' | 'target' | 'outsider') => {
    const user = f.users[who];
    const session = await owner.open(user.request, { expectedAccount: user.accountId });
    assert.ok(session, `${who} is admitted`);
    const context = { expectedAccount: user.accountId, context: session.context };
    return {
      tenants: () => owner.tenants(user.request, context),
      run: (intent: AdministrationIntent) => owner.execute(user.request, { ...context, idempotencyKey: crypto.randomUUID(), intent }),
      plan: (tenantId: string, sandboxTenantId: string) => owner.importPlan(user.request, { ...context, tenantId, sandboxTenantId }),
    };
  };
  /** Every row a tenant has, table by table, in key order. */
  const rows = async (tenant: string) => {
    const found: Record<string, Row[]> = {};
    for (const name of RESOURCES)
      found[name] = (await all(`SELECT * FROM ${name} WHERE tenant_id = ? ORDER BY id`, tenant)).map((row) => ({ ...row }));
    return found;
  };
  const versionOf = async (tenant: string) =>
    String((await all(`SELECT version FROM "${tables.tenant}" WHERE id = ?`, tenant))[0]?.version ?? '');
  return { ...f, dialect, exec, all, open, as, rows, versionOf, plan, target };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const clone = (sourceTenantId: string, tenantId: string, samples: boolean, expectedSourceVersion = '1'): AdministrationIntent => ({
  operation: 'cloneTenant',
  tenantId,
  sourceTenantId,
  expectedSourceVersion,
  samples,
});
const importing = async (f: Fixture, tenantId: string, sandboxTenantId: string): Promise<AdministrationIntent> => ({
  operation: 'importTenant',
  tenantId,
  expectedTenantVersion: await f.versionOf(tenantId),
  sandboxTenantId,
  expectedSandboxVersion: await f.versionOf(sandboxTenantId),
});
/** A refusal that changes no tenant's rows. */
async function untouched(f: Fixture, attempt: () => Promise<unknown>, why: string, check: (error: unknown) => boolean = refused) {
  const before = JSON.stringify(await Promise.all(['north', 'south', 'west', 'north-sandbox'].map(f.rows)));
  await assert.rejects(attempt(), check, why);
  assert.equal(JSON.stringify(await Promise.all(['north', 'south', 'west', 'north-sandbox'].map(f.rows))), before);
}

describe('what a clone mark may name', () => {
  test('the plan refuses a mark it could not copy whole, and judges nothing where nothing is marked', () => {
    const owned = ownedOf(SCHEMA, 'clone-plan', 'sqlite');
    assert.equal(tenantClonePlan(appOf({ stage: {}, rule: {} }), owned), undefined);
    const plan = tenantClonePlan(appOf(marks), owned)!;
    // Parents first: a rule's stage is in the copy before the rule.
    assert.deepEqual(
      plan.tables.map((table) => [table.resource, table.copy]),
      [
        ['stage', 'config'],
        ['rule', 'config'],
        ['ticket', 'sample'],
      ],
    );
    const refusing = (pattern: RegExp) => (error: unknown) => error instanceof TenantCloneRefusal && pattern.test(error.message);
    // A mark on a table the tenant does not own.
    assert.throws(
      () =>
        tenantClonePlan(
          appOf(marks),
          ownedOf(SCHEMA, 'clone-plan', 'sqlite', { ...tenantOwned, stage: { kind: 'global', access: 'read-only' } }),
        ),
      refusing(/stage/),
      'a global table',
    );
    // A configuration row that must name a sample, which a clone without samples leaves behind.
    assert.throws(
      () => tenantClonePlan(appOf({ stage: { clone: 'sample' }, rule: {}, ticket: { clone: 'config' }, note: {} }), owned),
      refusing(/ticket/),
      'config naming a sample',
    );
    // A key the database counts out: a copy would take the next one, and every reference to it would be wrong.
    const counted = ownedOf(
      // A serial key beside the tenant column, as PostgreSQL's catalog says one: its default draws on a sequence.
      `CREATE TABLE step (tenant_id TEXT NOT NULL, id INTEGER NOT NULL DEFAULT (nextval('step_id_seq')), name TEXT NOT NULL,
        PRIMARY KEY (tenant_id, id));`,
      'clone-plan',
      'sqlite',
    );
    assert.throws(() => tenantClonePlan(appOf({ step: { clone: 'config' } }), counted), refusing(/step/), 'autoincrement');
  });

  test('an App marks clone only on a tenant App, and only where the tenant owns the rows', () => {
    const base = {
      id: 'plain',
      name: 'Plain',
      resources: { stage: { clone: 'config' } },
      views: { stages: { kind: 'list', from: 'stage' } },
      home: 'stages',
    };
    assert.throws(() => parseAppConfig(base, 'plain.ts'), /clone/);
    assert.throws(() => parseAppConfig({ ...base, resources: { stage: { clone: 'everything' } } }, 'plain.ts'), /clone/);
  });
});

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`tenant sandboxes on ${dialect}`, { skip }, () => {
    test('a tenant’s owner clones it into a sandbox: new ids, references kept, samples on request, nothing else read or written', async (t) => {
      const f = await fixture(t, dialect);
      const owner = await f.as(await f.open(), 'operator');
      const before = { south: await f.rows('south'), west: await f.rows('west'), north: await f.rows('north') };
      const made = await owner.run(clone('north', 'north-sandbox', true));
      assert.deepEqual(JSON.parse(JSON.stringify(made.change.clone)), { sourceTenantId: 'north', samples: true, rows: 5 });
      // Its owner is its member, with the roles it holds in north and no more.
      assert.deepEqual(made.change.after.membership?.roles, ['owner']);
      const copy = await f.rows('north-sandbox');
      const key = (resource: string, old: string) => cloneKey('north-sandbox', resource, old);
      assert.deepEqual(
        copy.stage.map((row) => [row.id, row.name]).sort(),
        [
          [key('stage', 's1'), 'New'],
          [key('stage', 's2'), 'Won'],
        ].sort(),
      );
      // A reference names the copy's own row, never north's.
      assert.deepEqual(
        copy.rule.map((row) => [row.id, row.stage_id, row.label, row.shout]).sort(),
        [
          [key('rule', 'r1'), key('stage', 's1'), 'first', 'FIRST'],
          [key('rule', 'r2'), key('stage', 's2'), 'second', 'SECOND'],
        ].sort(),
      );
      assert.deepEqual(
        copy.ticket.map((row) => [row.id, row.stage_id]),
        [[key('ticket', 't1'), key('stage', 's1')]],
      );
      assert.deepEqual(copy.note, [], 'an unmarked resource never leaves its tenant');
      // The source, and every other tenant, are what they were.
      assert.deepEqual({ south: await f.rows('south'), west: await f.rows('west'), north: await f.rows('north') }, before);
      // The sandbox says so, and its source lists it.
      const page = await owner.tenants();
      const north = page.items.find((item) => item.tenantId === 'north')!;
      assert.deepEqual(
        north.sandboxes?.map((image) => image.tenantId),
        ['north-sandbox'],
      );
      const sandbox = page.items.find((item) => item.tenantId === 'north-sandbox')!;
      assert.deepEqual({ ...sandbox.sandbox }, { sourceTenantId: 'north' });
      // Configuration only, when samples are not asked for.
      const bare = await owner.run(clone('north', 'north-sandbox-bare', false));
      assert.equal(bare.change.clone!.rows, 4);
      assert.deepEqual((await f.rows('north-sandbox-bare')).ticket, []);
    });

    test('a clone is refused across tenants, onto a tenant that exists, from a sandbox, or past its owner’s own prefix', async (t) => {
      const f = await fixture(t, dialect);
      const administration = await f.open();
      const owner = await f.as(administration, 'operator'),
        outsider = await f.as(administration, 'outsider');
      // North's staff holds no clone and no import: administration does not open for it at all.
      assert.equal(await administration.open(f.users.target.request, { expectedAccount: f.users.target.accountId }), null);
      await owner.run(clone('north', 'north-sandbox', true));
      // South's owner holds nothing in north.
      await untouched(f, () => outsider.run(clone('north', 'north-sandbox-2', true)), 'line 325');
      // Over a tenant that exists, whoever's it is.
      await untouched(f, () => owner.run(clone('north', 'south', true)), 'line 327');
      await untouched(f, () => owner.run(clone('north', 'north-sandbox', true)), 'line 328');
      // A delegate names its sandboxes after its own tenant; a sandbox is never cloned again.
      await untouched(f, () => owner.run(clone('north', 'elsewhere', true)), 'line 330');
      await untouched(f, () => owner.run(clone('north-sandbox', 'north-sandbox-again', true)), 'line 331');
      // At the version the request read, and no other.
      await untouched(f, () => owner.run(clone('north', 'north-sandbox-4', true, '9')), 'line 333');
      // Where the App marks nothing clone, there is no such operation at all.
      const unmarked = await f.open(delegates(), null);
      assert.equal(await unmarked.open(f.users.operator.request, { expectedAccount: f.users.operator.accountId }), null);
    });

    test('an import applies a sandbox’s changes to its own source, all at once, and touches no other tenant', async (t) => {
      const f = await fixture(t, dialect);
      const owner = await f.as(await f.open(), 'operator');
      await owner.run(clone('north', 'north-sandbox', true));
      const key = (resource: string, old: string) => cloneKey('north-sandbox', resource, old);
      // In the sandbox: a stage renamed, a rule added, a rule removed, and a sample ticket edited (never imported).
      await f.exec(`UPDATE stage SET name = 'Fresh' WHERE id = ?`, key('stage', 's1'));
      await f.exec(`INSERT INTO rule VALUES ('r9', 'north-sandbox', ?, 'added')`, key('stage', 's2'));
      await f.exec(`DELETE FROM rule WHERE id = ?`, key('rule', 'r2'));
      await f.exec(`UPDATE ticket SET title = 'Edited' WHERE id = ?`, key('ticket', 't1'));
      const read = await owner.plan('north', 'north-sandbox');
      assert.deepEqual(
        { inserted: read.inserted, updated: read.updated, deleted: read.deleted, conflicts: read.conflicts },
        { inserted: 1, updated: 1, deleted: 1, conflicts: [] },
      );
      const others = { south: await f.rows('south'), west: await f.rows('west'), sandbox: await f.rows('north-sandbox') };
      const applied = await owner.run(await importing(f, 'north', 'north-sandbox'));
      assert.deepEqual(JSON.parse(JSON.stringify(applied.change.import)), {
        sandboxTenantId: 'north-sandbox',
        inserted: 1,
        updated: 1,
        deleted: 1,
      });
      const north = await f.rows('north');
      // The update set the name and left the generated shout to the database, which followed.
      assert.deepEqual(
        north.stage.map((row) => [row.id, row.name, row.shout]),
        [
          ['s1', 'Fresh', 'FRESH'],
          ['s2', 'Won', 'WON'],
        ],
      );
      // The new rule names north's own stage, under an id of north's own: the sandbox's row keeps its id.
      assert.deepEqual(
        north.rule.map((row) => [row.id, row.stage_id, row.label]).sort(),
        [
          ['r1', 's1', 'first'],
          [cloneKey('north', 'rule', 'r9'), 's2', 'added'],
        ].sort(),
      );
      assert.deepEqual(
        north.ticket.map((row) => row.title),
        ['A sample'],
        'samples stay in the sandbox',
      );
      assert.deepEqual(north.note, [{ id: 'n1', tenant_id: 'north', body: 'private' }]);
      assert.deepEqual({ south: await f.rows('south'), west: await f.rows('west'), sandbox: await f.rows('north-sandbox') }, others);
      // Imported, the sandbox and north agree: nothing more to bring.
      const again = await owner.plan('north', 'north-sandbox');
      assert.deepEqual([again.inserted, again.updated, again.deleted, again.conflicts.length], [0, 0, 0, 0]);
    });

    test('a conflict refuses the whole import: changed on both sides, removed live, or a key the live tenant took', async (t) => {
      const f = await fixture(t, dialect);
      const owner = await f.as(await f.open(), 'operator');
      await owner.run(clone('north', 'north-sandbox', true));
      const key = (resource: string, old: string) => cloneKey('north-sandbox', resource, old);
      await f.exec(`UPDATE stage SET name = 'Sandbox' WHERE id = ?`, key('stage', 's1'));
      await f.exec(`UPDATE stage SET name = 'Live' WHERE id = 's1'`);
      await f.exec(`UPDATE rule SET label = 'gone live' WHERE id = ?`, key('rule', 'r2'));
      await f.exec(`DELETE FROM rule WHERE id = 'r2'`);
      // A clean change beside them, which must not land alone.
      await f.exec(`INSERT INTO rule VALUES ('r8', 'north-sandbox', ?, 'clean')`, key('stage', 's2'));
      const read = await owner.plan('north', 'north-sandbox');
      assert.deepEqual(read.conflicts.map((conflict) => [conflict.resource, conflict.reason]).sort(), [
        ['rule', 'removed'],
        ['stage', 'changed'],
      ]);
      const intent = await importing(f, 'north', 'north-sandbox');
      await untouched(f, () => owner.run(intent), 'line 407');
      assert.equal((await f.rows('north')).rule.length, 1, 'the clean rule did not land alone');
    });

    test('an import is refused into any tenant but the sandbox’s source, from a live tenant, to an operator, and to another tenant’s owner', async (t) => {
      const f = await fixture(t, dialect);
      const administration = await f.open();
      const owner = await f.as(administration, 'operator'),
        outsider = await f.as(administration, 'outsider');
      // North's staff holds no clone and no import: administration does not open for it at all.
      assert.equal(await administration.open(f.users.target.request, { expectedAccount: f.users.target.accountId }), null);
      await owner.run(clone('north', 'north-sandbox', true));
      await f.exec(`UPDATE stage SET name = 'Fresh' WHERE id = ?`, cloneKey('north-sandbox', 'stage', 's1'));
      // South's owner, into south, which the sandbox was not cloned from.
      await untouched(f, async () => outsider.run(await importing(f, 'south', 'north-sandbox')), 'line 421');
      await assert.rejects(outsider.plan('south', 'north-sandbox'), refused);
      // South's owner, into north, which it does not own.
      await untouched(f, async () => outsider.run(await importing(f, 'north', 'north-sandbox')), 'line 424');
      // A live tenant is never imported as a sandbox, and a sandbox never takes an import.
      await untouched(f, async () => owner.run(await importing(f, 'north', 'south')), 'line 426');
      await untouched(f, async () => owner.run(await importing(f, 'north-sandbox', 'north')), 'line 427');
      await assert.rejects(owner.plan('north', 'south'), refused);
      // An operator holding every operation over north is not its owner: the import is never theirs.
      const operators = await f.as(
        await f.open({
          id: 'operators',
          version: 'v1',
          maxMembershipLifetimeMs: HOUR,
          operators: [
            {
              accountId: f.users.operator.accountId,
              tenants: ['north', 'north-sandbox'],
              operations: ['cloneTenant', 'importTenant'],
              roles: [],
            },
          ],
        }),
        'operator',
      );
      const listed = (await operators.tenants()).items.find((item) => item.tenantId === 'north');
      assert.ok(!listed?.capabilities.some((capability) => capability.operation === 'importTenant'));
      await untouched(f, async () => operators.run(await importing(f, 'north', 'north-sandbox')), 'line 447');
      // The change is still there to import, by its owner.
      const applied = await owner.run(await importing(f, 'north', 'north-sandbox'));
      assert.equal(applied.change.import!.updated, 1);
    });

    test('the operator’s clone and dev clock: a sandbox runs ahead, a live tenant never has a clock', async (t) => {
      const f = await fixture(t, dialect);
      const made = await cloneTenantSandbox(f.target, f.binding, {
        plan: f.plan,
        sourceTenantId: 'north',
        tenantId: 'lab',
        samples: false,
        operator: 'ops',
      });
      assert.deepEqual(made.rows, { stage: 2, rule: 2 });
      assert.deepEqual((await f.rows('lab')).stage.map((row) => row.name).sort(), ['New', 'Won']);
      // A plan this module did not issue, or another App's, is no plan at all.
      await assert.rejects(
        cloneTenantSandbox(f.target, f.binding, {
          plan: structuredClone(f.plan),
          sourceTenantId: 'north',
          tenantId: 'lab-2',
          samples: false,
          operator: 'ops',
        }),
        TenantMaintenanceRefusal,
      );
      await assert.rejects(
        cloneTenantSandbox(f.target, f.binding, {
          plan: f.plan,
          sourceTenantId: 'north',
          tenantId: 'south',
          samples: false,
          operator: 'ops',
        }),
        TenantMaintenanceRefusal,
      );
      // A statement the database refuses is refused in the database's own words.
      if (dialect === 'sqlite') {
        await f.exec(
          `CREATE TRIGGER stage_closed BEFORE INSERT ON stage WHEN NEW.tenant_id = 'lab-closed' BEGIN SELECT RAISE(ABORT, 'stages are closed'); END`,
        );
        await assert.rejects(
          cloneTenantSandbox(f.target, f.binding, {
            plan: f.plan,
            sourceTenantId: 'north',
            tenantId: 'lab-closed',
            samples: false,
            operator: 'ops',
          }),
          (error: unknown) =>
            error instanceof TenantMaintenanceRefusal &&
            /The database said: stages are closed/.test(error.message) &&
            !/no longer current/.test(error.message),
        );
        assert.deepEqual(await f.all(`SELECT id FROM "${tables.tenant}" WHERE id = 'lab-closed'`), [], 'nothing was written');
      }
      const clocks = () => f.all(`SELECT tenant_id, clock_skew_ms, clock_rate FROM "${SANDBOX_TABLES.tenant}" ORDER BY tenant_id`);
      const before = await clocks();
      for (const tenantId of ['north', 'south', 'nowhere'])
        await assert.rejects(
          setSandboxClock(f.target, f.binding, { tenantId, skewMs: 86_400_000, rate: 1, operator: 'ops' }),
          (error: unknown) => error instanceof TenantMaintenanceRefusal && /only a sandbox/.test(error.message),
        );
      // Never behind, and never past its bounds.
      await assert.rejects(
        setSandboxClock(f.target, f.binding, { tenantId: 'lab', skewMs: -1, rate: 1, operator: 'ops' }),
        TenantMaintenanceRefusal,
      );
      assert.deepEqual(await clocks(), before);
      const set = await setSandboxClock(f.target, f.binding, { tenantId: 'lab', skewMs: 86_400_000, rate: 60, operator: 'ops' });
      assert.equal(set.clock.skewMs, 86_400_000);
      assert.deepEqual(
        (await clocks()).map((row) => [row.tenant_id, Number(row.clock_skew_ms), Number(row.clock_rate)]),
        [['lab', 86_400_000, 60]],
      );
    });
  });
}
