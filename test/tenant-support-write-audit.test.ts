/**
 * The support write sink: every row a support session inserts, updates or
 * removes is recorded in the business write's own transaction, under the
 * redaction its resource declares — or nothing is applied at all. SQLite
 * always; live PostgreSQL when TABLEWALK_TEST_PG names a server, in a
 * database of this suite's own.
 *
 * Support is still refused everywhere a request can reach (tenantContexts.ts),
 * so the writer is driven directly with issued support evidence, exactly as
 * the member kind is driven in test/tenant-write-source.test.ts. That is the
 * point of this slice: the sink exists and is proven before any door opens.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { after, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import {
  createSqliteSupportAudit,
  provisionSqliteSupportAudit,
  verifySqliteSupportAudit,
} from '../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import {
  SUPPORT_AUDIT_TABLES,
  supportAuditKey,
  type SupportEntry,
  type SupportSession,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import {
  createPostgresSupportAudit,
  migratePostgresSupportAudit,
  verifyPostgresSupportAudit,
} from '../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import { issueSupportEvidence, type SupportMembershipEvidence } from '../packages/mistri/src/server/tenant/tenantSupportLease.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import type { TenantWriteAudit } from '../packages/mistri/src/server/tenant/tenantWriteKindContract.js';
import {
  openPostgresTenantWriteSource,
  openSqliteTenantWriteSource,
  TenantWriteFailure,
  type TenantWriteSource,
} from '../packages/mistri/src/server/tenant/tenantWriteSource.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';
import {
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  pgClient,
  TENANT_DIALECTS,
  type TenantDialect,
} from './support/tenantDialects.js';

const SECRET = 'synthetic-support-write-audit-key-at-least-thirty-two-bytes';
const owner = { appId: 'support-write', source: { id: 'business', connection: 'owned-business' }, storeId: 'support-write-store' };
const allow: RowScope = { lead: true, dealer: true };
const HOUR = 3_600_000;

const SCHEMA = {
  tables: ['db_lead', 'db_dealer'],
  sqlite: `PRAGMA foreign_keys = ON;
    CREATE TABLE db_dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
    CREATE TABLE db_lead (id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL,
      secret TEXT NOT NULL DEFAULT 'unset');`,
  postgres: `
    CREATE TABLE public.db_dealer (id text PRIMARY KEY, name text NOT NULL);
    CREATE TABLE public.db_lead (id text PRIMARY KEY, tenant_id text NOT NULL, name text NOT NULL,
      secret text NOT NULL DEFAULT 'unset');`,
};
const ROWS = `
    INSERT INTO db_dealer VALUES ('north', 'North Motors');
    INSERT INTO db_lead (id, tenant_id, name, secret) VALUES ('n1', 'north', 'North lead', 'private-one'),
      ('s1', 'south', 'South lead', 'private-two');`;

/* This suite's own PostgreSQL database: the per-run helpers refuse a name they
   do not own, so two runs on one server never share fixture tables. */
const DATABASE = `support_write_${randomUUID().replaceAll('-', '')}`;
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
  const sources: TenantWriteSource[] = [];
  t.after(async () => {
    try {
      await Promise.all(sources.map((source) => source.close()));
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
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    await admin.putPlatformMembership({
      accountId: 'olivia',
      membershipId: 'platform-olivia',
      status: 'active',
      roles: ['reviewer'],
      validUntil,
      expectedVersion: null,
    });
  });
  // The support row as opening one writes it; opening itself is the support
  // owner's, and this suite is about what a session may then do.
  const supportId = randomUUID();
  await engine.exec(
    `INSERT INTO "${TENANT_TABLES.membership}" (id, tenant_id, account_id, status, version, roles_json,
    valid_until, kind, parent_id, parent_version, platform_version)
    VALUES (?, 'north', 'olivia', 'active', '1', ?, ?, 'support', 'platform-olivia', '1', '1')`,
    [supportId, JSON.stringify(['dealer_staff']), validUntil],
  );

  // Its audit chain, opened as the support owner opens one, so the sink
  // extends a genuine verifying chain rather than a hand-built row.
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
    deployment: 'support-write-1',
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

  const audit: TenantWriteAudit = { key, redact: { lead: ['secret'] } };
  /* `null` is how this suite says "opened with no audit config at all":
     passing undefined would take the default instead, which is the very case
     that must be constructible here. */
  const open = async (config: TenantWriteAudit | null = audit) => {
    const given = config ?? undefined;
    const source =
      dialect === 'sqlite'
        ? await openSqliteTenantWriteSource(engine.path, ownership, owner, Date.now, given)
        : await openPostgresTenantWriteSource(engine.url, ownership, owner, Date.now, given);
    sources.push(source);
    return source;
  };
  const evidence: SupportMembershipEvidence = issueSupportEvidence({
    realm: 'support',
    appId: owner.appId,
    accountId: 'olivia',
    source: owner.source,
    deployment: 'support-write-1',
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

  const entries = async () =>
    (
      await engine.all(
        `SELECT seq, kind, resource, operation, key_json, detail_json
    FROM "${SUPPORT_AUDIT_TABLES.entry}" WHERE session_id = ? ORDER BY seq`,
        [supportId],
      )
    ).map((row) => ({
      seq: Number(row.seq),
      kind: row.kind as string,
      resource: row.resource as string | null,
      operation: row.operation as string | null,
      key: JSON.parse((row.key_json ?? 'null') as string) as unknown,
      detail: JSON.parse(row.detail_json as string) as Record<string, Record<string, unknown>>,
    }));
  const leads = () => engine.all('SELECT id, name, secret FROM db_lead ORDER BY id');
  const verify = () =>
    dialect === 'sqlite'
      ? Promise.resolve(verifySqliteSupportAudit(engine.path, owner, key))
      : verifyPostgresSupportAudit(engine.url, owner, key);
  return { engine, dialect, open, evidence, entries, leads, verify, supportId };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: every row a support session changes is recorded beside it, redacted where the resource says`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      source = await f.open();
    await source.supportTransaction(f.evidence, allow, async (records) => {
      await records.insert({ table: 'lead', values: { id: 'n2', name: 'Added under support', secret: 'private-new' } });
      await records.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'Changed under support' } });
      await records.remove({ table: 'lead', key: { id: 'n2' } });
    });
    // The business rows are what the operator did.
    assert.deepEqual(
      (await f.leads()).map((row) => [row.id, row.name]),
      [
        ['n1', 'Changed under support'],
        ['s1', 'South lead'],
      ],
    );
    // And the chain says so, in order, one entry per row operation.
    const written = (await f.entries()).filter((entry) => entry.kind === 'write');
    assert.deepEqual(
      written.map((entry) => [entry.resource, entry.operation]),
      [
        ['lead', 'insert'],
        ['lead', 'update'],
        ['lead', 'delete'],
      ],
    );
    assert.deepEqual(
      written.map((entry) => entry.key),
      [{ id: 'n2' }, { id: 'n1' }, { id: 'n2' }],
    );
    // An unredacted column keeps its value; a marked one is a keyed hash, and
    // the value never appears anywhere in the record.
    assert.equal(written[0].detail.after.name, 'Added under support');
    assert.match(String(written[0].detail.after.secret), /^redacted:[0-9a-f]{32}$/);
    assert.equal(written[1].detail.before.name, 'North lead');
    assert.equal(written[1].detail.after.name, 'Changed under support');
    // A delete keeps its whole before image, under the same rule.
    assert.equal(written[2].detail.before.name, 'Added under support');
    assert.match(String(written[2].detail.before.secret), /^redacted:[0-9a-f]{32}$/);
    const recorded = JSON.stringify(await f.entries());
    for (const value of ['private-new', 'private-one']) assert.equal(recorded.includes(value), false);
    assert.deepEqual(await f.verify(), { version: 1, sessions: 1, entries: 4, failed: [] });
  });

  /* What the person did and what the database did are two facts. The entry's
     kind carries the first, so an Undo reads as an Undo while its row
     operation still says which statement ran. The label is the host's own —
     Undo passes it because `undo()` is what called — so nothing a request
     carries can dress an ordinary write as an Undo. */
  test(`${dialect}: an Undo is recorded as an Undo, and still says what the database did`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      source = await f.open();
    await source.supportTransaction(
      f.evidence,
      allow,
      async (records) => {
        await records.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'Put back' } });
      },
      undefined,
      'undo',
    );
    const [entry] = (await f.entries()).filter((item) => item.kind !== 'open');
    assert.equal(entry.kind, 'undo');
    assert.equal(entry.operation, 'update');
    assert.deepEqual(entry.key, { id: 'n1' });
    assert.equal(entry.detail.after.name, 'Put back');
    // An unlabelled write is still a write, so the default cannot drift.
    await source.supportTransaction(f.evidence, allow, (records) =>
      records.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'Ordinary' } }),
    );
    assert.deepEqual(
      (await f.entries()).map((item) => item.kind),
      ['open', 'undo', 'write'],
    );
    assert.deepEqual((await f.verify()).failed, []);
  });

  test(`${dialect}: a failed support write applies nothing and records nothing`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      source = await f.open();
    const sentinel = new Error('PRIVATE_SENTINEL: the handler refused');
    await assert.rejects(
      source.supportTransaction(f.evidence, allow, async (records) => {
        await records.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'Never committed' } });
        throw sentinel;
      }),
      (error: unknown) => error instanceof TenantWriteFailure && error.outcome === 'not_applied',
    );
    assert.equal((await f.leads())[0].name, 'North lead');
    assert.deepEqual(
      (await f.entries()).map((entry) => entry.kind),
      ['open'],
    );
    assert.deepEqual((await f.verify()).failed, []);
  });

  /* The other half of append-or-rollback: not only does a failed write leave no
     record, a change whose record cannot be written leaves no change. An entry
     is refused past the store's non-read size, never trimmed to fit. */
  test(`${dialect}: a change whose record will not fit is refused, not applied with a truncated record`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      source = await f.open();
    const huge = 'x'.repeat(70_000);
    await assert.rejects(
      source.supportTransaction(f.evidence, allow, (records) =>
        records.update({ table: 'lead', key: { id: 'n1' }, values: { name: huge } }),
      ),
      (error: unknown) => error instanceof TenantWriteFailure,
    );
    assert.equal((await f.leads())[0].name, 'North lead');
    assert.deepEqual(
      (await f.entries()).map((entry) => entry.kind),
      ['open'],
    );
    assert.deepEqual((await f.verify()).failed, []);
  });

  test(`${dialect}: a writer opened without the audit key cannot write under support at all`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      source = await f.open(null);
    await assert.rejects(
      source.supportTransaction(f.evidence, allow, (records) =>
        records.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'Unrecorded' } }),
      ),
      (error: unknown) => error instanceof TenantWriteFailure,
    );
    assert.equal((await f.leads())[0].name, 'North lead');
    assert.deepEqual(
      (await f.entries()).map((entry) => entry.kind),
      ['open'],
    );
  });

  test(`${dialect}: a revoked support row stops the writer, and a member's evidence never reaches it`, { skip }, async (t) => {
    const f = await fixture(t, dialect),
      source = await f.open();
    await f.engine.exec(`UPDATE "${TENANT_TABLES.membership}" SET status = 'revoked', version = '2' WHERE id = ?`, [f.supportId]);
    await assert.rejects(
      source.supportTransaction(f.evidence, allow, (records) =>
        records.update({ table: 'lead', key: { id: 'n1' }, values: { name: 'After revocation' } }),
      ),
      (error: unknown) => error instanceof TenantWriteFailure,
    );
    assert.equal((await f.leads())[0].name, 'North lead');
    assert.deepEqual(
      (await f.entries()).map((entry) => entry.kind),
      ['open'],
    );
  });
}
