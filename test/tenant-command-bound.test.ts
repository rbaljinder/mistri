/**
 * A tenant command's bound (scopedTransaction.ts ScopeBound): the member's
 * tenant within the command's footprint, the row policy left out. A command
 * may insert a row its principal will not read once it lands (a lead routed
 * to someone else), and delete a row others referenced once no reference is
 * left — but only where every referencing table is one the principal reads
 * whole, so no hidden row can be the one a cascade reaches. Nothing widens
 * past the tenant: another dealer's rows are outside the bound, and a
 * reference from one of them refuses the delete. SQLite always, PostgreSQL
 * live-gated (support/tenantDialects.ts).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { refusalReasons } from '../packages/engine/src/server/evidence.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { TenantWriteFailure, type TenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { dropDedicatedPostgresDatabase, openTenantEngine, TENANT_DIALECTS, type TenantDialect } from './support/tenantDialects.js';

const owner = { appId: 'service', source: { id: 'business', connection: 'owned-business' }, storeId: 'bound-fixture' };
const SCHEMA = {
  tables: ['cb_note', 'cb_tag', 'cb_lead', 'cb_dealer'],
  sqlite: `PRAGMA foreign_keys = ON;
    CREATE TABLE cb_dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE cb_lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES cb_dealer(id), owner_id TEXT NOT NULL,
      name TEXT NOT NULL);
    CREATE TABLE cb_note (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES cb_dealer(id), author TEXT NOT NULL,
      lead_id TEXT NOT NULL REFERENCES cb_lead(id), body TEXT NOT NULL);
    CREATE TABLE cb_tag (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES cb_dealer(id), name TEXT NOT NULL);`,
  postgres: `
    CREATE TABLE public.cb_dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.cb_lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.cb_dealer(id), owner_id text NOT NULL,
      name text NOT NULL);
    CREATE TABLE public.cb_note (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.cb_dealer(id), author text NOT NULL,
      lead_id text NOT NULL REFERENCES public.cb_lead(id), body text NOT NULL);
    CREATE TABLE public.cb_tag (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.cb_dealer(id), name text NOT NULL);`,
};
const ROWS = `
    INSERT INTO cb_dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO cb_lead VALUES ('n1', 'north', 'alice', 'Kept'), ('n2', 'north', 'alice', 'Noted'), ('n3', 'north', 'alice', 'Crossed'),
      ('s1', 'south', 'sam', 'South lead');
    INSERT INTO cb_note VALUES ('nn1', 'north', 'bob', 'n2', 'Bob noted it'), ('sn1', 'south', 'sam', 'n3', 'A south note on a north lead');
    INSERT INTO cb_tag VALUES ('t1', 'north', 'hot'), ('t2', 'south', 'cold');`;
const DATABASE = `command_bound_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

/* Alice's row policy: her own leads only, every note and tag of her dealer. */
const mine = { groups: [[{ column: 'owner_id', op: '=' as const, value: 'alice' }]] };
const ALICE: RowScope = { dealer: true, lead: mine, note: true, tag: true };
/* The same, with notes narrowed to her own: a note she cannot read may point anywhere. */
const NARROW: RowScope = { ...ALICE, note: { groups: [[{ column: 'author', op: '=' as const, value: 'alice' }]] } };
const FOOTPRINT = ['lead', 'note', 'tag'];
const refused = (error: unknown) => error instanceof TenantWriteFailure && error.outcome === 'not_applied';
const because = (pattern: RegExp) => (error: unknown) => refused(error) && pattern.test(refusalReasons(error).join(' | '));

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    ...SCHEMA,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const sources: Array<TenantReadSource | TenantWriteSource> = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  await engine.migrateCommandJournal();
  await engine.maintenance(owner, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'alice',
      membershipId: 'north-alice',
      status: 'active',
      roles: ['staff'],
      validUntil: 10_000,
      expectedVersion: null,
    });
  });
  const physicalSchema = await engine.physicalSchema();
  const resources = Object.fromEntries(['dealer', 'lead', 'note', 'tag'].map((logical) => [logical, engine.id(`cb_${logical}`)]));
  const catalog = appResourceCatalog(physicalSchema, resources);
  const tenant = { kind: 'tenant' as const, column: 'tenant_id' };
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: { dealer: { kind: 'platform' }, lead: tenant, note: tenant, tag: tenant },
    profile: 'dealer',
  });
  const writer = await engine.openWrite(ownership, owner, () => 1000);
  sources.push(writer);
  const lookup = { appId: owner.appId, source: owner.source, accountId: 'alice', tenantId: 'north', deployment: 'deployment-1' };
  const record = await engine.readMembership(owner, lookup);
  assert.ok(record);
  const alice: TenantMembershipEvidence = {
    ...lookup,
    membershipId: record.membershipId,
    membershipVersion: record.membershipVersion,
    tenantVersion: record.tenantVersion,
    roles: [...record.roles],
    verifiedAt: 1000,
    validUntil: 6000,
  };
  type Work = Parameters<TenantWriteSource['commandTransaction']>[2];
  const command = (work: Work, rows: RowScope = ALICE, footprint: readonly string[] | 'none' = FOOTPRINT) =>
    writer.commandTransaction(alice, rows, work, undefined, undefined, footprint === 'none' ? undefined : footprint);
  const ids = async (table: string) =>
    (await engine.all(`SELECT id FROM cb_${table} ORDER BY id`)).map((row) => (row as { id: string }).id);
  return { engine, writer, alice, command, ids };
}

for (const { dialect, skip } of TENANT_DIALECTS)
  describe(`a tenant command's bound on ${dialect}`, { skip }, () => {
    test('a command inserts a row its principal will not read, inside its tenant, and is told only the key', async (t) => {
      const f = await fixture(t, dialect);
      const placed = await f.command((tx) => tx.insert({ table: 'lead', values: { id: 'n9', owner_id: 'bob', name: 'Routed to Bob' } }));
      assert.ok(placed && typeof placed === 'object');
      assert.deepEqual({ ...(placed as { key: object }).key }, { id: 'n9' });
      assert.equal((placed as { row?: unknown }).row, undefined, 'the row it cannot read is not handed back');
      assert.deepEqual(await f.engine.all("SELECT tenant_id, owner_id FROM cb_lead WHERE id = 'n9'"), [
        { tenant_id: 'north', owner_id: 'bob' },
      ]);
      // Never another dealer's row, never outside the footprint, never without one.
      for (const work of [
        (tx: Parameters<Parameters<typeof f.command>[0]>[0]) =>
          tx.insert({ table: 'lead', values: { id: 'x1', tenant_id: 'south', owner_id: 'bob', name: 'Planted' } }),
        (tx: Parameters<Parameters<typeof f.command>[0]>[0]) =>
          tx.insert({ table: 'note', values: { id: 'x2', author: 'alice', lead_id: 's1', body: 'Points across' } }),
      ])
        await assert.rejects(f.command(work), refused);
      await assert.rejects(
        f.command((tx) => tx.insert({ table: 'lead', values: { id: 'x3', owner_id: 'bob', name: 'Unbounded' } }), ALICE, ['note', 'tag']),
        refused,
      );
      await assert.rejects(
        f.command((tx) => tx.insert({ table: 'lead', values: { id: 'x4', owner_id: 'bob', name: 'No footprint' } }), ALICE, 'none'),
        refused,
      );
      assert.deepEqual(await f.ids('lead'), ['n1', 'n2', 'n3', 'n9', 's1']);
      assert.deepEqual(await f.ids('note'), ['nn1', 'sn1']);
    });

    test('a command deletes a row once nothing references it, where it reads every referencing row', async (t) => {
      const f = await fixture(t, dialect);
      // Unreferenced: gone. A row with a note: refused until the note is moved first, in the same command.
      await f.command((tx) => tx.remove({ table: 'lead', key: { id: 'n1' } }));
      await assert.rejects(
        f.command((tx) => tx.remove({ table: 'lead', key: { id: 'n2' } })),
        because(/still references it/),
      );
      await f.command(async (tx) => {
        await tx.remove({ table: 'note', key: { id: 'nn1' } });
        await tx.remove({ table: 'lead', key: { id: 'n2' } });
      });
      assert.deepEqual(await f.ids('lead'), ['n3', 's1']);
      assert.deepEqual(await f.ids('note'), ['sn1']);
    });

    test("a delete is refused where a hidden row might reference it: a narrower policy, a table outside the footprint, another dealer's row", async (t) => {
      const f = await fixture(t, dialect);
      // Notes Alice reads only in part: one she cannot see might point here.
      await assert.rejects(
        f.command((tx) => tx.remove({ table: 'lead', key: { id: 'n1' } }), NARROW),
        because(/a hidden row might/),
      );
      // Notes outside the command's footprint: the same.
      await assert.rejects(
        f.command((tx) => tx.remove({ table: 'lead', key: { id: 'n1' } }), ALICE, ['lead', 'tag']),
        because(/a hidden row might/),
      );
      // A south dealer's note points at a north lead: counted on the writer, across tenants, and refused.
      await assert.rejects(
        f.command((tx) => tx.remove({ table: 'lead', key: { id: 'n3' } })),
        because(/still references it/),
      );
      // Another dealer's row, and a row the policy hides, are never removed at all.
      await assert.rejects(
        f.command((tx) => tx.remove({ table: 'tag', key: { id: 't2' } })),
        refused,
      );
      await assert.rejects(
        f.command((tx) => tx.remove({ table: 'lead', key: { id: 's1' } })),
        refused,
      );
      await f.engine.exec("UPDATE cb_lead SET owner_id = 'bob' WHERE id = 'n1'");
      await assert.rejects(
        f.command((tx) => tx.remove({ table: 'lead', key: { id: 'n1' } })),
        refused,
      );
      assert.deepEqual(await f.ids('lead'), ['n1', 'n2', 'n3', 's1']);
      assert.deepEqual(await f.ids('tag'), ['t1', 't2']);
      // A plain (non-command) write keeps the old rule: an unreadable insert is refused.
      await assert.rejects(
        f.writer.transaction(f.alice, ALICE, (tx) => tx.insert({ table: 'lead', values: { id: 'x5', owner_id: 'bob', name: 'Plain' } })),
        refused,
      );
    });
  });
