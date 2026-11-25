/**
 * `auth.tenancy.readAudit`: names the tenant roles whose signed-in members open Settings -> Reads and call
 * `useReadAudit()`, so a tenant App without custom domains or branding (or one that separates compliance from
 * branding editors) serves its read audit to those roles.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { provisionSqliteBranding } from '../packages/mistri/src/adapters/branding/sqliteBranding.js';
import { provisionSqliteReadAudit } from '../packages/mistri/src/adapters/readAudit/sqliteReadAudit.js';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../packages/mistri/src/server/policy/appTenantPolicy.js';
import { forgetReadAuditCoalescing } from '../packages/mistri/src/server/readAudit.js';
import { createTenantAuthenticatedHttpServer } from '../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { holdPort } from './support/heldPort.js';

const appWith = (
  tenancy: Record<string, unknown>,
  roles: Record<string, unknown> = { clinician: { read: true }, compliance: { read: true } },
) =>
  parseAppConfig(
    {
      id: 'clinic',
      name: 'Clinic',
      auth: { rows: 'tenant', tenancy, roles },
      sources: { business: { connection: 'business-db' } },
      resources: {
        ...(tenancy.platform ? { org: { owner: 'platform' } } : {}),
        patient: { owner: 'tenant', audit: { reads: true } },
      },
      views: { patients: { kind: 'list', from: 'patient' } },
      home: 'patients',
      nav: ['patients'],
    },
    'clinic',
  );

test('auth.tenancy.readAudit names signed-in tenant roles and records them in authority.lock only when declared', () => {
  assert.equal(appWith({ label: 'Practice' }).auth?.tenancy?.readAudit, undefined);
  assert.deepEqual(appWith({ label: 'Practice', readAudit: ['compliance', 'clinician'] }).auth?.tenancy?.readAudit, [
    'compliance',
    'clinician',
  ]);
  assert.doesNotMatch(authorityReport(appWith({ label: 'Practice' })), /tenant read-audit/, 'omitted leaves authority.lock unchanged');
  assert.match(
    authorityReport(appWith({ label: 'Practice', readAudit: ['compliance', 'clinician'] })),
    /auth tenant read-audit clinician — the App\nauth tenant read-audit compliance — the App/,
  );

  assert.throws(() => appWith({ readAudit: [] }), /"readAudit" that is not a list of 1 to 16/);
  assert.throws(() => appWith({ readAudit: [''] }), /"readAudit" that is not a list of 1 to 16/);
  assert.throws(() => appWith({ readAudit: ['compliance', 'compliance'] }), /names a role twice in "readAudit"/);
  assert.throws(() => appWith({ readAudit: ['missing'] }), /"readAudit" names "missing", which "auth\.roles" does not declare/);
  assert.throws(
    () => appWith({ readAudit: ['bot'] }, { clinician: { read: true }, bot: { service: true, read: true } }),
    /"readAudit" names "bot", a service role/,
  );
  assert.throws(
    () =>
      appWith(
        { platform: { label: 'Network' }, readAudit: ['staff'] },
        { clinician: { realm: 'tenant', read: true }, staff: { realm: 'platform', read: ['org'] } },
      ),
    /"readAudit" names "staff", which has realm "platform"/,
  );
});

test('a tenant App without domains or branding serves /api/reads to auth.tenancy.readAudit roles alone, and overrides branding editors when both are declared', async (t: TestContext) => {
  forgetReadAuditCoalescing();
  const directory = mkdtempSync(join(tmpdir(), 'mistri-tenant-read-audit-'));
  const business = join(directory, 'business.db');
  const authStore = join(directory, 'auth.db');
  const db = new DatabaseSync(business);
  let held = await holdPort();
  let origin = `http://127.0.0.1:${held.port}`;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  let auth: AppAuthRuntime | undefined;
  t.after(async () => {
    try {
      if (owner) {
        owner.server.closeAllConnections();
        await owner.retire();
      }
    } finally {
      auth?.close();
      await held.release();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE patient(id TEXT NOT NULL PRIMARY KEY, tenant_id TEXT NOT NULL COLLATE NOCASE, name TEXT NOT NULL);
    INSERT INTO patient VALUES ('p-north','north','Ada North'),('p-south','south','Bob South');`);
  const appId = 'clinic-reads';
  const binding = { appId, source: { id: 'business', connection: 'clinic-db' }, storeId: 'clinic-store' };
  provisionSqliteTenantStore(business, binding);
  provisionSqliteReadAudit(business);

  const maintenance = async (run: (admin: ReturnType<typeof createSqliteTenantAdministration>) => Promise<void>) => {
    const operations = new TransactionOperations();
    db.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db, operations, binding));
      await operations.finish();
      db.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
  };
  await maintenance(async (admin) => {
    for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
  });

  const makeLoaded = (withBranding: boolean): LoadedApp => ({
    path: join(directory, 'app.ts'),
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: appId,
        name: 'Clinic Reads',
        auth: {
          providers: ['email'],
          signUp: 'open',
          store: authStore,
          rows: 'tenant',
          tenancy: { label: 'Practice', readAudit: ['compliance'] },
          roles: {
            clinician: { read: true },
            compliance: { read: true },
            owner: { read: true },
          },
        },
        ...(withBranding ? { branding: { allow: ['name'], editors: ['owner'] } } : {}),
        sources: { business: { connection: binding.source.connection } },
        resources: {
          patient: { owner: 'tenant', audit: { reads: true }, fields: { read: ['id', 'name'] } },
        },
        views: { patients: { kind: 'list', from: 'patient' } },
        home: 'patients',
        nav: ['patients'],
      },
      'clinic-reads',
    ),
  });

  const createAuthFor = async (loaded: LoadedApp, baseURL: string) => {
    const previous = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = 'synthetic-tenant-read-audit-secret-thirty-two-chars';
    try {
      return await createAppAuth(loaded, { baseURL, trustedOrigins: [baseURL] });
    } finally {
      if (previous === undefined) delete process.env.BETTER_AUTH_SECRET;
      else process.env.BETTER_AUTH_SECRET = previous;
    }
  };

  const call = async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    return { status: response.status, text, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  };

  const startHost = async (withBranding: boolean) => {
    if (owner) {
      owner.server.closeAllConnections();
      await owner.retire();
      owner = undefined;
      auth?.close();
      auth = undefined;
      await held.release();
      held = await holdPort();
      origin = `http://127.0.0.1:${held.port}`;
    }
    if (withBranding) provisionSqliteBranding(business);
    const loaded = makeLoaded(withBranding);
    auth = await createAuthFor(loaded, origin);
    owner = await createTenantAuthenticatedHttpServer({
      loaded,
      auth,
      bound: { host: '127.0.0.1', port: held.port },
      enrollment: {
        policy: defineAppTenantPolicy({
          kind: 'tenant',
          appId,
          storeId: binding.storeId,
          ownership: { patient: { kind: 'tenant', column: 'tenant_id' } },
          resolveMembershipRows: () => ({ patient: true }),
          resolveRows: async () => ({ patient: true }),
        }),
        source: { ...binding.source, existingPath: business },
        deployment: 'read-audit-generation',
        roles: ['clinician', 'compliance', 'owner'],
        maxLifetimeMs: 60000,
      },
    });
    await held.adopt(owner.server);
  };

  await startHost(false);

  const enroll = async (name: string, role: string, tenantId = 'north') => {
    const email = `${name.toLowerCase()}@clinic.test`;
    const res = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ name, email, password: 'Disposable-local-password-123!' }),
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const accountId = String((JSON.parse(text).user as { id: string }).id);
    const cookie = res.headers
      .getSetCookie()
      .map((v) => v.split(';')[0])
      .join('; ');
    await maintenance(async (admin) => {
      await admin.putMembership({
        tenantId,
        accountId,
        membershipId: `${tenantId}-${accountId}`,
        status: 'active',
        roles: [role],
        validUntil: Date.now() + 120000,
        expectedVersion: null,
      });
    });
    const opened = await call(`/api/tenant/context/open?app=${appId}&tenant=${tenantId}`, {}, { cookie, 'x-mistri-account': accountId });
    assert.equal(opened.status, 200, opened.text);
    return {
      accountId,
      headers: {
        cookie,
        'x-mistri-account': accountId,
        'x-mistri-tab': String(opened.body.tabId),
        'x-mistri-context': String(opened.body.context),
        'x-mistri-lease-revision': String(opened.body.revision),
      },
    };
  };

  const clinician = await enroll('Cara', 'clinician', 'north');
  const compliance = await enroll('Cora', 'compliance', 'north');
  await maintenance(async (admin) => {
    await admin.putMembership({
      tenantId: 'south',
      accountId: clinician.accountId,
      membershipId: `south-${clinician.accountId}`,
      status: 'active',
      roles: ['clinician'],
      validUntil: Date.now() + 120000,
      expectedVersion: null,
    });
  });
  const southOpened = await call(
    `/api/tenant/context/open?app=${appId}&tenant=south`,
    {},
    { cookie: clinician.headers.cookie, 'x-mistri-account': clinician.accountId },
  );
  assert.equal(southOpened.status, 200, southOpened.text);
  const southHeaders = {
    cookie: clinician.headers.cookie,
    'x-mistri-account': clinician.accountId,
    'x-mistri-tab': String(southOpened.body.tabId),
    'x-mistri-context': String(southOpened.body.context),
    'x-mistri-lease-revision': String(southOpened.body.revision),
  };

  // Audited reads in both tenants.
  assert.equal((await call(`/api/query?app=${appId}&tenant=north`, { table: 'patient', limit: 10 }, clinician.headers)).status, 200);
  assert.equal((await call(`/api/query?app=${appId}&tenant=south`, { table: 'patient', limit: 10 }, southHeaders)).status, 200);

  // Clinician does not get Settings -> Reads or /api/reads.
  assert.equal(
    ((await call(`/api/app?app=${appId}&tenant=north`, undefined, clinician.headers)).body.app as Record<string, unknown>).reads,
    undefined,
  );
  assert.equal((await call(`/api/reads?app=${appId}&tenant=north`, {}, clinician.headers)).status, 403);

  // Compliance gets Settings -> Reads and north's read-audit rows, even with no domains or branding configured.
  assert.equal(
    ((await call(`/api/app?app=${appId}&tenant=north`, undefined, compliance.headers)).body.app as Record<string, unknown>).reads,
    true,
  );
  const auditPage = await call(`/api/reads?app=${appId}&tenant=north`, {}, compliance.headers);
  assert.equal(auditPage.status, 200, auditPage.text);
  const reads = auditPage.body.reads as Array<Record<string, unknown>>;
  assert.equal(reads.length, 1);
  assert.equal(reads[0].actor, clinician.accountId);
  assert.doesNotMatch(auditPage.text, /p-south|south-/);

  // When branding is also configured with its own editors ('owner'), auth.tenancy.readAudit ('compliance') wins for Settings -> Reads.
  await maintenance(async (admin) => {
    await admin.putMembership({
      tenantId: 'north',
      accountId: clinician.accountId,
      membershipId: `north-${clinician.accountId}`,
      status: 'active',
      roles: ['owner'],
      validUntil: Date.now() + 120000,
      expectedVersion: '1',
    });
  });
  await startHost(true);
  const reenteredOwner = await call(
    `/api/tenant/context/open?app=${appId}&tenant=north`,
    {},
    { cookie: clinician.headers.cookie, 'x-mistri-account': clinician.accountId },
  );
  assert.equal(reenteredOwner.status, 200, reenteredOwner.text);
  const ownerHeaders = {
    cookie: clinician.headers.cookie,
    'x-mistri-account': clinician.accountId,
    'x-mistri-tab': String(reenteredOwner.body.tabId),
    'x-mistri-context': String(reenteredOwner.body.context),
    'x-mistri-lease-revision': String(reenteredOwner.body.revision),
  };
  const reenteredCompliance = await call(
    `/api/tenant/context/open?app=${appId}&tenant=north`,
    {},
    { cookie: compliance.headers.cookie, 'x-mistri-account': compliance.accountId },
  );
  assert.equal(reenteredCompliance.status, 200, reenteredCompliance.text);
  const complianceHeaders = {
    cookie: compliance.headers.cookie,
    'x-mistri-account': compliance.accountId,
    'x-mistri-tab': String(reenteredCompliance.body.tabId),
    'x-mistri-context': String(reenteredCompliance.body.context),
    'x-mistri-lease-revision': String(reenteredCompliance.body.revision),
  };

  assert.equal((await call(`/api/reads?app=${appId}&tenant=north`, {}, ownerHeaders)).status, 403);
  assert.equal((await call(`/api/reads?app=${appId}&tenant=north`, {}, complianceHeaders)).status, 200);
});
