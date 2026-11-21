/**
 * A tenant command's batch writes on PostgreSQL — `insertMany` and the `updateMany` beneath `updateWhere` — kept in
 * the tenant as a row at a time is: a batch row that names another tenant's parent, clashes on a unique key, or
 * keys another tenant's row refuses the whole batch as that row alone refuses, and nothing of the batch lands. The
 * batch is one statement (counted below), so these are the batch path's refusals and not a row-at-a-time fallback's.
 *
 * Live and opt-in: TABLEWALK_TEST_PG names a disposable server, and the suite works in a database of its own.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test, type TestContext } from 'node:test';
import type { InsertRequest, UpdateRequest, WriteTransaction } from '../packages/engine/src/adapters/adapter.js';
import type { StoredCommandReceipt } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantWriteSource } from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import { liveSkip } from './live.js';
import { dropDedicatedPostgresDatabase, openTenantEngine } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const owner = { appId: 'batch-app', source: { id: 'business', connection: 'business-db' }, storeId: 'batch-fixture' };
const rows: RowScope = { parent: true, child: true, item: true };

const SCHEMA = {
  tables: ['db_child', 'db_parent', 'db_item'],
  sqlite: '',
  postgres: `
    CREATE TABLE public.db_parent (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);
    CREATE TABLE public.db_child (id text PRIMARY KEY, tenant_id text NOT NULL,
      parent_id text NOT NULL REFERENCES public.db_parent(id), name text NOT NULL);
    CREATE TABLE public.db_item (id text PRIMARY KEY, tenant_id text NOT NULL, business_id text NOT NULL,
      name text NOT NULL, UNIQUE (tenant_id, business_id));
    INSERT INTO db_parent VALUES ('north-parent','north','North parent'),('south-parent','south','South parent');
    INSERT INTO db_item VALUES ('north-row','north','same-business','North'),('north-two','north','other','North two'),
      ('south-row','south','same-business','South');`,
};

const DATABASE = `batch_writes_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (LIVE) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(t: TestContext) {
  const engine = await openTenantEngine('postgres', { ...SCHEMA, database: DATABASE });
  const sources: TenantWriteSource[] = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  await engine.migrateCommandJournal();
  const grant = {
    tenantId: 'north',
    accountId: 'alice',
    membershipId: 'north-alice',
    status: 'active' as const,
    roles: ['editor'],
    validUntil: 10000,
    expectedVersion: null,
  };
  await engine.maintenance(owner, async (admin) => {
    for (const tenantId of ['north', 'south']) {
      await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({ ...grant, tenantId, membershipId: `${tenantId}-alice` });
    }
  });
  const physicalSchema = await engine.physicalSchema();
  const resources = { parent: engine.id('db_parent'), child: engine.id('db_child'), item: engine.id('db_item') },
    catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: {
      parent: { kind: 'tenant', column: 'tenant_id' },
      child: { kind: 'tenant', column: 'tenant_id' },
      item: { kind: 'tenant', column: 'tenant_id' },
    },
  });
  const evidence = async (tenantId = 'north'): Promise<TenantMembershipEvidence> => {
    const lookup = { appId: owner.appId, source: owner.source, accountId: 'alice', tenantId, deployment: 'deployment-1' };
    const record = await engine.readMembership(owner, lookup);
    assert.ok(record);
    return {
      ...lookup,
      membershipId: record.membershipId,
      membershipVersion: record.membershipVersion,
      tenantVersion: record.tenantVersion,
      roles: [...record.roles],
      verifiedAt: 1000,
      validUntil: Math.min(6000, record.validUntil),
    };
  };
  const source = await engine.openWrite(ownership, owner, () => 1000);
  sources.push(source);
  let attempts = 0;
  /** One command's writes, its receipt committed behind them; what it throws, as the caller sees it. */
  const command = async (work: (records: WriteTransaction) => Promise<unknown>): Promise<unknown> => {
    attempts += 1;
    const receipt: StoredCommandReceipt = {
      appId: owner.appId,
      actorId: 'alice',
      commandId: 'batch',
      commandVersion: 1,
      idempotencyKey: `attempt-${attempts}`,
      id: `receipt-${attempts}`,
      fingerprint: 'captured-fingerprint',
      resultJson: '{}',
      requestId: `request-${attempts}`,
      completedAt: '2026-11-20T12:00:00.000Z',
    };
    try {
      await source.commandTransaction(await evidence(), rows, async (records, journal) => {
        await work(records);
        await journal.commit(receipt, { target: 'item', keyJson: '{"id":"north-row"}', changesJson: '[]' });
      });
      return undefined;
    } catch (error) {
      return error;
    }
  };
  /** Statements the sources send that `pattern` matches, counted while `work` runs. */
  const statements = async (t: TestContext, pattern: RegExp, work: () => Promise<unknown>) => {
    const seen = engine.intercept(t, { match: (statement) => pattern.test(statement.sql) });
    try {
      return { result: await work(), calls: seen.calls };
    } finally {
      seen.restore();
    }
  };
  const ids = async (table: string) => (await engine.all(`SELECT id FROM ${table} ORDER BY id`)).map((row) => String(row.id));
  return { engine, command, statements, ids };
}

/** What a caller can tell of a refusal: its kind and what it says. */
const said = (error: unknown) => {
  assert.ok(error instanceof Error, `expected a refusal, got ${String(error)}`);
  const { outcome, code } = error as { outcome?: unknown; code?: unknown };
  return { name: error.constructor.name, outcome, code, message: error.message };
};
const child = (id: string, parent: string): InsertRequest => ({ table: 'child', values: { id, parent_id: parent, name: id } });
const item = (id: string, business: string): InsertRequest => ({ table: 'item', values: { id, business_id: business, name: id } });
const rename = (id: string, name: string): UpdateRequest => ({ table: 'item', key: { id }, values: { name } });

describe('tenant batch writes on postgres', { skip: liveSkip('postgres', LIVE) }, () => {
  test('a batch writes its rows in one statement, each stamped with the tenant', async (t) => {
    const f = await fixture(t);
    const { result, calls } = await f.statements(t, /^\s*INSERT INTO "?public"?\."?db_child\b/, () =>
      f.command((records) => records.insertMany!([child('a', 'north-parent'), child('b', 'north-parent'), child('c', 'north-parent')])),
    );
    assert.equal(result, undefined);
    assert.equal(calls, 1);
    assert.deepEqual(await f.engine.all('SELECT id, tenant_id FROM db_child ORDER BY id'), [
      { id: 'a', tenant_id: 'north' },
      { id: 'b', tenant_id: 'north' },
      { id: 'c', tenant_id: 'north' },
    ]);
  });

  test("a batch row naming another tenant's parent refuses as that row alone does, and no row lands", async (t) => {
    const f = await fixture(t);
    const alone = await f.command((records) => records.insert(child('alone', 'south-parent')));
    const batch = await f.command((records) =>
      records.insertMany!([child('first', 'north-parent'), child('crossing', 'south-parent'), child('last', 'north-parent')]),
    );
    assert.deepEqual(said(batch), said(alone));
    assert.deepEqual(await f.ids('db_child'), []);
  });

  test('a unique clash inside a batch refuses as a single insert does, and no row lands', async (t) => {
    const f = await fixture(t);
    const alone = await f.command((records) => records.insert(item('alone', 'same-business')));
    // Two rows of the batch clash with each other, and one with a row already stored.
    const within = await f.command((records) => records.insertMany!([item('one', 'fresh'), item('two', 'fresh')]));
    const stored = await f.command((records) => records.insertMany!([item('one', 'fresh'), item('two', 'same-business')]));
    assert.deepEqual(said(within), said(alone));
    assert.deepEqual(said(stored), said(alone));
    assert.deepEqual(await f.ids('db_item'), ['north-row', 'north-two', 'south-row']);
    // The key is the tenant's: a business ID only another tenant holds is free here.
    assert.equal(await f.command((records) => records.insertMany!([item('free', 'south-only'), item('more', 'more')])), undefined);
  });

  test("a batch update reaches only the tenant's rows", async (t) => {
    const f = await fixture(t);
    const names = async () =>
      Object.fromEntries((await f.engine.all('SELECT id, name FROM db_item ORDER BY id')).map((row) => [row.id, row.name]));
    const alone = await f.command((records) => records.update(rename('south-row', 'Taken')));
    const batch = await f.command((records) => records.updateMany!([rename('north-row', 'Changed'), rename('south-row', 'Taken')]));
    assert.deepEqual(said(batch), said(alone));
    assert.deepEqual(await names(), { 'north-row': 'North', 'north-two': 'North two', 'south-row': 'South' });
    const { result, calls } = await f.statements(t, /^\s*UPDATE "?public"?\."?db_item\b/, () =>
      f.command((records) => records.updateMany!([rename('north-row', 'Changed'), rename('north-two', 'Changed two')])),
    );
    assert.equal(result, undefined);
    assert.equal(calls, 1);
    assert.deepEqual(await names(), { 'north-row': 'Changed', 'north-two': 'Changed two', 'south-row': 'South' });
  });
});
