/**
 * A support session's reads at the source: the dealer's own rows, fenced on the
 * support row. SQLite always; live PostgreSQL when TABLEWALK_TEST_PG names a
 * server, in a database of this suite's own.
 *
 * Reads are still refused for a support lease at the request path
 * (tenantContexts.ts), so this drives the source directly, as the write sink and
 * the read ledger were driven before their own paths opened.
 *
 * What matters here is that the scope comes from the *same* policy rule a
 * member's does, through a member view of the support evidence. A second rule
 * for support rows could disagree with the first, and the disagreement would
 * show up as a session reading rows the policy meant to withhold rather than as
 * a failing test — so the test that a dealer's rows and only a dealer's rows are
 * visible is the one that matters most below.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { after, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import type { TenantMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantMembership.js';
import type { TenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { createSqliteSupportAudit, provisionSqliteSupportAudit } from '../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import {
  supportAuditKey,
  type SupportEntry,
  type SupportSession,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import {
  createPostgresSupportAudit,
  migratePostgresSupportAudit,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import { issueSupportEvidence, type SupportMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantSupportLease.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import {
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  pgClient,
  TENANT_DIALECTS,
  type TenantDialect,
} from './support/tenantDialects.js';

const SECRET = 'synthetic-support-read-source-key-at-least-thirty-two-bytes';
const owner = { appId: 'support-read', source: { id: 'business', connection: 'owned-business' }, storeId: 'support-read-store' };
const HOUR = 3_600_000;

const SCHEMA = {
  tables: ['db_lead', 'db_dealer'],
  sqlite: `CREATE TABLE db_dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_lead (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);`,
  postgres: `CREATE TABLE public.db_dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.db_lead (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL);`,
};
const ROWS = `
    INSERT INTO db_dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
    INSERT INTO db_lead (id, tenant_id, name) VALUES ('n1', 'north', 'North one'), ('n2', 'north', 'North two'),
      ('s1', 'south', 'South one');`;

const DATABASE = `support_read_${randomUUID().replaceAll('-', '')}`;
after(async () => {
  if (process.env.TABLEWALK_TEST_PG) await dropDedicatedPostgresDatabase(DATABASE);
});

async function fixture(t: TestContext, dialect: TenantDialect) {
  const engine = await openTenantEngine(dialect, {
    ...SCHEMA,
    sqlite: SCHEMA.sqlite + ROWS,
    postgres: SCHEMA.postgres + ROWS,
    database: DATABASE,
  });
  const sources: TenantReadSource[] = [];
  t.after(async () => {
    try {
      await Promise.allSettled(sources.map((source) => source.close()));
    } finally {
      await engine.close();
    }
  });
  await engine.provisionStore(owner);
  const key = supportAuditKey(SECRET);
  if (dialect === 'sqlite') provisionSqliteSupportAudit(engine.path, owner, key);
  else await migratePostgresSupportAudit(engine.url, owner, key);

  const validUntil = Date.now() + HOUR;
  await engine.maintenance(owner, async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({
      accountId: 'olivia',
      membershipId: 'platform-olivia',
      status: 'active',
      roles: ['reviewer'],
      validUntil,
      expectedVersion: null,
    });
    // A member of north, so a member's own read can be compared with a session's.
    await admin.putMembership({
      tenantId: 'north',
      accountId: 'sam',
      membershipId: 'north-sam',
      status: 'active',
      roles: ['dealer_staff'],
      validUntil,
      expectedVersion: null,
    });
  });
  const supportId = randomUUID();
  await engine.exec(
    `INSERT INTO "${TENANT_TABLES.membership}" (id, tenant_id, account_id, status, version, roles_json,
    valid_until, kind, parent_id, parent_version, platform_version)
    VALUES (?, 'north', 'olivia', 'active', '1', ?, ?, 'support', 'platform-olivia', '1', '1')`,
    [supportId, JSON.stringify(['dealer_staff']), validUntil],
  );

  const openedAt = new Date().toISOString();
  const session: SupportSession = {
    id: supportId,
    tenantId: 'north',
    accountId: 'olivia',
    operatorName: 'Olivia Operator',
    dealerRole: 'dealer_staff',
    parentMembershipId: 'platform-olivia',
    parentMembershipVersion: '1',
    platformVersion: '1',
    reason: 'Checking a stuck lead',
    openedAt,
    validUntil,
    nativeSessionId: 'native-1',
    deployment: 'support-read-1',
    policyId: 'lender-support',
    policyVersion: '1',
    openReceiptId: randomUUID(),
  };
  const opening: SupportEntry = {
    kind: 'open',
    at: openedAt,
    requestId: randomUUID(),
    actorId: 'olivia',
    tenantVersion: '1',
    supportMembershipVersion: '1',
    parentMembershipVersion: '1',
    platformVersion: '1',
    resource: null,
    operation: null,
    keyJson: null,
    detailJson: '{}',
    commandReceiptId: null,
  };
  if (dialect === 'sqlite') {
    const db = new DatabaseSync(engine.path);
    try {
      db.exec('BEGIN IMMEDIATE');
      const operations = new TransactionOperations();
      await createSqliteSupportAudit(db, operations, owner, key).open(session, opening);
      await operations.finish();
      db.exec('COMMIT');
    } finally {
      db.close();
    }
  } else {
    const client = await pgClient(engine.url);
    try {
      await client.query('BEGIN');
      const operations = new TransactionOperations();
      await createPostgresSupportAudit(client, operations, owner, key).open(session, opening);
      await operations.finish();
      await client.query('COMMIT');
    } finally {
      await client.end();
    }
  }

  const physicalSchema = await engine.physicalSchema();
  const resources = { lead: engine.id('db_lead'), dealer: engine.id('db_dealer') };
  const catalog = appResourceCatalog(physicalSchema, resources);
  const ownership = captureTenantOwnership({
    appId: owner.appId,
    source: owner.source,
    schema: catalog.schema,
    physicalSchema,
    resources,
    ownership: { lead: { kind: 'tenant', column: 'tenant_id' }, dealer: { kind: 'global', access: 'read-only' } },
  });
  const source = await engine.openRead(ownership, owner, Date.now);
  sources.push(source);

  const evidence: SupportMembershipEvidence = issueSupportEvidence({
    realm: 'support',
    appId: owner.appId,
    accountId: 'olivia',
    source: owner.source,
    deployment: 'support-read-1',
    tenantId: 'north',
    supportId,
    membershipId: supportId,
    membershipVersion: '1',
    tenantVersion: '1',
    parentId: 'platform-olivia',
    parentVersion: '1',
    platformVersion: '1',
    roles: ['dealer_staff'],
    verifiedAt: Date.now() - 1,
    validUntil,
  });
  const member: TenantMembershipEvidence = {
    appId: owner.appId,
    accountId: 'sam',
    tenantId: 'north',
    source: owner.source,
    deployment: 'support-read-1',
    membershipId: 'north-sam',
    membershipVersion: '1',
    tenantVersion: '1',
    roles: ['dealer_staff'],
    verifiedAt: Date.now() - 1,
    validUntil,
  };
  const all = { lead: true, dealer: true };
  const names = async (reads: Awaited<ReturnType<TenantReadSource['scopeSupportReads']>>) =>
    (await reads.query({ table: 'lead', limit: 30, offset: 0 })).rows.map((row) => row.id).sort();
  return { engine, dialect, source, evidence, member, all, names, supportId };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: a session reads its dealer's rows, by the same rule its own members read them`, { skip }, async (t) => {
    const f = await fixture(t, dialect);
    const reads = await f.source.scopeSupportReads(f.evidence, f.all);
    assert.deepEqual(await f.names(reads), ['n1', 'n2']);
    // The dealer's rows and no others: south is another tenant's, whatever the
    // caller passed as its scope.
    const member = await f.source.scopeReads(f.member, f.all);
    assert.deepEqual(await f.names(member), await f.names(reads));
    // A global stays readable; the scope is the dealer's, not everything.
    assert.equal((await reads.query({ table: 'dealer', limit: 30, offset: 0 })).rows.length, 2);
    await f.source.assertSupportCurrent(f.evidence);
  });

  test(`${dialect}: the fence is the support row, so a revoked session stops reading mid-read`, { skip }, async (t) => {
    const f = await fixture(t, dialect);
    const reads = await f.source.scopeSupportReads(f.evidence, f.all);
    assert.deepEqual(await f.names(reads), ['n1', 'n2']);
    // Revoked after the reader was bound: the next operation is refused, because
    // the compiled reader revalidates the support row before each one.
    await f.engine.exec(`UPDATE "${TENANT_TABLES.membership}" SET status = 'revoked', version = '2' WHERE id = ?`, [f.supportId]);
    await assert.rejects(reads.query({ table: 'lead', limit: 30, offset: 0 }));
    await assert.rejects(f.source.assertSupportCurrent(f.evidence));
    await assert.rejects(f.source.scopeSupportReads(f.evidence, f.all));
  });

  test(`${dialect}: a session whose dealer, parent or platform moved reads nothing`, { skip }, async (t) => {
    const f = await fixture(t, dialect);
    // Establish the read first: otherwise a blanket refusal would satisfy the
    // assertions below and this would pass while proving nothing.
    assert.deepEqual(await f.names(await f.source.scopeSupportReads(f.evidence, f.all)), ['n1', 'n2']);
    await f.engine.exec(`UPDATE "${TENANT_TABLES.tenant}" SET status = 'suspended', version = '2' WHERE id = 'north'`);
    await assert.rejects(f.source.scopeSupportReads(f.evidence, f.all));
    await assert.rejects(f.source.assertSupportCurrent(f.evidence));
  });

  test(`${dialect}: neither kind of evidence is admitted through the other's door`, { skip }, async (t) => {
    const f = await fixture(t, dialect);
    // Both doors work for their own principal, so the refusals below are about
    // the evidence and not about everything refusing.
    assert.deepEqual(await f.names(await f.source.scopeSupportReads(f.evidence, f.all)), ['n1', 'n2']);
    assert.deepEqual(await f.names(await f.source.scopeReads(f.member, f.all)), ['n1', 'n2']);
    // A support session holds no member membership in the dealer, so the member
    // path refuses it; and a member's evidence is not a session.
    await assert.rejects(f.source.scopeReads(f.evidence as unknown as TenantMembershipEvidence, f.all));
    await assert.rejects(f.source.assertCurrent(f.evidence as unknown as TenantMembershipEvidence));
    await assert.rejects(f.source.scopeSupportReads(f.member as unknown as SupportMembershipEvidence, f.all));
    await assert.rejects(f.source.assertSupportCurrent(f.member as unknown as SupportMembershipEvidence));
  });
}
