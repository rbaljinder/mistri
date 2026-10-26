/**
 * The support read runtime: a session's reads of its dealer's rows, on evidence
 * the support owner minted, fenced on the support row. SQLite always; live
 * PostgreSQL when TABLEWALK_TEST_PG names a server, in a database of its own.
 *
 * Reads are still refused for a support lease at the request path
 * (tenantContexts.ts), so this drives the runtime directly, as every support
 * layer before it was driven before its own path opened.
 *
 * The runtime creates no membership issuer: a support session is admitted by the
 * support owner's fence, so evidence arrives already minted and is recognised
 * here by identity. A copy of it, however faithful, must read nothing.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { after, test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { appResourceCatalog } from '../packages/mistri/src/server/app/appResources.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
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
import {
  bindSupportReadRuntime,
  type SupportReadContext,
  type SupportReadRuntimeOptions,
} from '../packages/mistri/src/server/tenant/tenantSupportReadRuntime.js';
import { TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStoreContract.js';
import {
  dropDedicatedPostgresDatabase,
  openTenantEngine,
  pgClient,
  TENANT_DIALECTS,
  type TenantDialect,
} from './support/tenantDialects.js';

const SECRET = 'synthetic-support-read-runtime-key-at-least-thirty-two-bytes';
const owner = { appId: 'support-runtime', source: { id: 'business', connection: 'owned-business' }, storeId: 'support-runtime-store' };
const DEPLOYMENT = 'support-runtime-1';
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

const DATABASE = `support_runtime_${randomUUID().replaceAll('-', '')}`;
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
    deployment: DEPLOYMENT,
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

  /* The runtime rebuilds a catalog from the App and compares it with the
     ownership snapshot, so each resource must name the physical table this
     engine actually has, and the one business source must say it is the
     default — `tenantAppShape` refuses an App whose single non-platform source
     does not. No `tenancy.profile`: a profile names a platform-owned resource,
     and `dealer` here is global. */
  const app = parseAppConfig(
    {
      id: owner.appId,
      name: 'Support runtime',
      sources: { business: { connection: owner.source.connection, default: true } },
      resources: {
        dealer: { owner: 'global', physical: engine.id('db_dealer') },
        lead: { access: 'write', owner: 'tenant', physical: engine.id('db_lead') },
      },
      auth: {
        store: 'auth.db',
        rows: 'tenant',
        tenancy: { label: 'Dealer', platform: { label: 'Lender' } },
        roles: { dealer_staff: { realm: 'tenant', read: true, write: ['lead'] }, reviewer: { realm: 'platform', read: true } },
      },
      views: { leads: { kind: 'list', from: 'lead' } },
      nav: [{ id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] }],
      home: 'leads',
    },
    'support runtime fixture',
  );

  const options: SupportReadRuntimeOptions<{ cookie: string }> = {
    app,
    source,
    deployment: DEPLOYMENT,
    verifySession: () => ({ id: 'olivia', who: 'Olivia Operator' }),
    resolveMembershipRows: () => ({ lead: true, dealer: true }),
    resolveRows: () => ({ lead: true, dealer: true }),
  };
  const runtime = bindSupportReadRuntime(options);
  t.after(() => runtime.retire());

  const evidence: SupportMembershipEvidence = issueSupportEvidence({
    realm: 'support',
    appId: owner.appId,
    accountId: 'olivia',
    source: owner.source,
    deployment: DEPLOYMENT,
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
  const request = { cookie: 'olivia' };
  const leads = (context: SupportReadContext) => context.data.query({ table: 'lead', limit: 30, offset: 0 });
  return { engine, dialect, runtime, evidence, request, leads, supportId };
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  test(`${dialect}: a session reads its dealer's rows through the runtime, and nothing else`, { skip }, async (t) => {
    const f = await fixture(t, dialect);
    const ids = await f.runtime.withContext(f.request, f.evidence, async (context) => {
      // The principal the context carries is the session's own evidence.
      assert.equal(context.principal.supportId, f.supportId);
      assert.equal(context.principal.tenantId, 'north');
      return (await f.leads(context)).rows.map((row) => row.id).sort();
    });
    assert.deepEqual(ids, ['n1', 'n2']);
  });

  test(`${dialect}: a read is never writable, whatever the dealer role allows a member`, { skip }, async (t) => {
    const f = await fixture(t, dialect);
    await f.runtime.withContext(f.request, f.evidence, (context) => {
      // The role grants write on lead, yet the context offers only reads.
      assert.deepEqual(Object.keys(context.data).sort(), ['count', 'countBreakdown', 'countView', 'query', 'runBreakdown', 'runView']);
      assert.equal(
        context.schema.tables.every((table) => table.deletable !== true),
        true,
      );
      return undefined;
    });
  });

  test(`${dialect}: only evidence the support owner minted reads anything`, { skip }, async (t) => {
    const f = await fixture(t, dialect);
    // A faithful copy is not the issued object, and identity is what admits.
    const copy = { ...f.evidence } as SupportMembershipEvidence;
    await assert.rejects(f.runtime.withContext(f.request, copy, () => undefined));
    // Nor is a spread with the same values under another deployment.
    await assert.rejects(
      f.runtime.withContext(f.request, { ...f.evidence, deployment: 'elsewhere' } as SupportMembershipEvidence, () => undefined),
    );
  });

  test(`${dialect}: a revoked session stops reading, in the middle of its own request`, { skip }, async (t) => {
    const f = await fixture(t, dialect);
    await assert.rejects(
      f.runtime.withContext(f.request, f.evidence, async (context) => {
        assert.deepEqual((await f.leads(context)).rows.map((row) => row.id).sort(), ['n1', 'n2']);
        // Revoked while the request is still open: the next read revalidates the
        // support row and refuses, so a session cannot outlive its revocation.
        await f.engine.exec(`UPDATE "${TENANT_TABLES.membership}" SET status = 'revoked', version = '2' WHERE id = ?`, [f.supportId]);
        await f.leads(context);
        return undefined;
      }),
    );
  });
}
