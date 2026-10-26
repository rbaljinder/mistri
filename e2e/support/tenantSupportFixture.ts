import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { createAppAuth } from '../../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { provisionSqliteTenantAdministrationJournal } from '../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { createTenantAuthenticatedHttpServer } from '../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../../packages/mistri/src/server/tenant/tenantStore.js';
import { provisionSqliteSupportAudit } from '../../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import { SUPPORT_AUDIT_KEY_VARIABLE, supportAuditKey } from '../../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { parseAppConfig } from '../../packages/mistri/src/shared/app.js';
import type { TenantAccount } from './tenantServer.js';

/**
 * Audited support's browser fixture ("enter as dealer"), run in
 * tenantServer.ts's child process like the other tenant proofs: a lender
 * (the platform realm) above two dealers, over genuine native auth. Bob is a
 * platform lender_admin who may enter any active dealer as dealer_staff;
 * Alice is north's own staff; the visitor holds nothing. The audit key is a
 * synthetic one for this child only.
 */
export async function serveSupportFixture({ directory, appId, port }: { directory: string; appId: string; port: number }) {
  const database = join(directory, 'business.db'),
    origin = `http://127.0.0.1:${port}`;
  const source = { id: 'business', connection: 'tenant-support-business' };
  const binding = { appId, source, storeId: 'tenant-support-store' };
  process.env[SUPPORT_AUDIT_KEY_VARIABLE] = 'synthetic-browser-support-audit-key-at-least-32-bytes';
  const writer = new DatabaseSync(database);
  let auth: Awaited<ReturnType<typeof createAppAuth>> | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  let retiring: Promise<void> | undefined;
  const stop = () =>
    (retiring ??= (async () => {
      try {
        owner?.server.closeAllConnections();
        await owner?.retire();
      } finally {
        auth?.close();
        writer.close();
        process.disconnect?.();
      }
    })());
  try {
    writer.exec(`CREATE TABLE dealer (id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL);
      CREATE TABLE lead (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), name TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
      INSERT INTO lead (id, tenant_id, name) VALUES ('north-1', 'north', 'North lead'), ('south-1', 'south', 'South lead');`);
    // Explicit fresh-fixture provisioning, never enrollment-time migration.
    provisionSqliteTenantStore(database, binding);
    provisionSqliteTenantAdministrationJournal(database, binding);
    provisionSqliteSupportAudit(database, binding, supportAuditKey());
    const loaded = {
      path: join(directory, 'app.ts'),
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: appId,
          name: 'Lender desk',
          auth: {
            store: join(directory, 'auth.db'),
            signUp: 'open',
            rows: 'tenant',
            tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
            roles: { dealer_staff: { realm: 'tenant', read: true }, lender_admin: { realm: 'platform', read: true } },
          },
          sources: { business: { connection: source.connection } },
          resources: { dealer: { owner: 'platform' }, lead: { owner: 'tenant' } },
          views: {
            leads: { kind: 'list', from: 'lead', label: 'Leads', show: ['id', 'name'] },
            dealers: { kind: 'list', from: 'dealer', label: 'Dealers', show: ['id', 'name'] },
          },
          home: 'leads',
          nav: [
            { id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] },
            { id: 'underwriting', label: 'Underwriting', realm: 'platform', children: ['dealers'] },
          ],
          ui: { shell: { placement: 'top' } },
        },
        'disposable audited support fixture',
      ),
    };
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    owner = await createTenantAuthenticatedHttpServer({
      loaded,
      auth,
      browser: true,
      bound: { host: '127.0.0.1', port },
      enrollment: {
        policy: defineAppTenantPolicy({
          kind: 'tenant',
          appId,
          storeId: binding.storeId,
          ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
          resolveMembershipRows: () => ({ lead: true }),
          resolveRows: () => ({ lead: true }),
          resolvePlatformRows: () => ({ dealer: true, lead: true }),
          support: {
            id: 'lender-support',
            version: '1',
            grants: [{ platformRole: 'lender_admin', tenants: 'all', dealerRoles: ['dealer_staff'] }],
          },
        }),
        source: { ...source, existingPath: database },
        deployment: 'support-generation',
        roles: ['dealer_staff', 'lender_admin'],
        maxLifetimeMs: 300000,
      },
    });
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');
    const signup = async (name: string): Promise<TenantAccount> => {
      const credentials = { name, email: `${name}@example.test`, password: `tenant-support-${name}-password` };
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.json();
      if (!response.ok || typeof body.user?.id !== 'string') throw new Error('Support fixture native signup failed');
      return { ...credentials, id: body.user.id };
    };
    const accounts = { alice: await signup('alice'), bob: await signup('bob'), visitor: await signup('visitor') };
    const operations = new TransactionOperations();
    writer.exec('BEGIN IMMEDIATE');
    try {
      const admin = createSqliteTenantAdministration(writer, operations, binding);
      const grant = { status: 'active' as const, validUntil: Date.now() + 3600000, expectedVersion: null };
      for (const tenantId of ['north', 'south']) await admin.putTenant({ tenantId, status: 'active', expectedVersion: null });
      await admin.putMembership({
        ...grant,
        tenantId: 'north',
        accountId: accounts.alice.id,
        membershipId: 'alice-north',
        roles: ['dealer_staff'],
      });
      await admin.putPlatform({ status: 'active', expectedVersion: null });
      await admin.putPlatformMembership({ ...grant, accountId: accounts.bob.id, membershipId: 'bob-platform', roles: ['lender_admin'] });
      await operations.finish();
      writer.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      writer.exec('ROLLBACK');
      throw error;
    }
    // Keep the handler registered during async cleanup: signal-exit would
    // otherwise re-raise the signal after a once-handler removes itself.
    process.on('SIGTERM', () => {
      void stop().catch((error) => {
        console.error(error);
        process.exitCode = 1;
      });
    });
    process.send?.({ type: 'ready', value: { origin, accounts } });
  } catch (error) {
    await stop();
    throw error;
  }
}
