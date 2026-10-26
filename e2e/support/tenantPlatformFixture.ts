import { once } from 'node:events';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { createAppAuth } from '../../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { defineAppTenantPolicy } from '../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { createSqliteTenantAdministration, provisionSqliteTenantStore } from '../../packages/mistri/src/server/tenant/tenantStore.js';
import { parseTestApp as parseAppConfig } from '../../test/support/commandCatalog.js';
import type { TenantAccount } from './tenantServer.js';

/**
 * The platform realm's browser fixture, run in tenantServer.ts's child process
 * like the other tenant proofs: a lender (the platform realm) above two
 * dealers (tenants), over genuine native auth. Alice is north's staff, Bob is
 * a platform manager, the visitor holds nothing. Each realm has one command:
 * `flag` is a dealer's, `escalate` the platform's, and each role grants only
 * its own. Nothing here grants a generic edit, so a button on either lease can
 * only be a command's.
 */
export async function servePlatformFixture({ directory, appId, port }: { directory: string; appId: string; port: number }) {
  const database = join(directory, 'business.db'),
    origin = `http://127.0.0.1:${port}`;
  const source = { id: 'business', connection: 'tenant-platform-business' };
  const binding = { appId, source, storeId: 'tenant-platform-store' };
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
        status TEXT NOT NULL DEFAULT 'open', version INTEGER NOT NULL DEFAULT 0);
      INSERT INTO dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
      INSERT INTO lead (id, tenant_id, name) VALUES ('north-1', 'north', 'North lead'), ('south-1', 'south', 'South lead');`);
    provisionSqliteTenantStore(database, binding);
    // Explicit fresh-fixture provisioning, never enrollment-time migration.
    migrateSqliteCommandJournal(database);
    const reference = (id: string, realm?: 'platform') => ({ id, version: 1, target: 'lead', input: {}, ...(realm ? { realm } : {}) });
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
            roles: {
              staff: { realm: 'tenant', read: true, commands: ['flag'] },
              manager: { realm: 'platform', read: true, commands: ['escalate'] },
            },
          },
          sources: { business: { connection: source.connection } },
          resources: {
            dealer: { owner: 'platform' },
            lead: {
              access: 'write',
              owner: 'tenant',
              actions: {
                escalateLead: { label: 'Escalate lead', command: reference('escalate', 'platform') },
                flagLead: { label: 'Flag lead', command: reference('flag') },
              },
            },
          },
          views: {
            leads: { kind: 'list', from: 'lead', label: 'Leads', show: ['id', 'name', 'status', 'version'] },
            pipeline: { kind: 'list', from: 'lead', label: 'Pipeline', show: ['id', 'name', 'status', 'version'] },
          },
          home: 'leads',
          // Not "Lender": the chooser's platform choice already carries that name.
          nav: [
            { id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] },
            { id: 'underwriting', label: 'Underwriting', realm: 'platform', children: ['pipeline'] },
          ],
          ui: { shell: { placement: 'top' } },
        },
        'disposable platform realm fixture',
      ),
    };
    const result = (value: unknown): { leadId: string; version: number } => {
      if (!value || typeof value !== 'object') throw new Error('Invalid fixture command result');
      const data = value as Record<string, unknown>;
      if (typeof data.leadId !== 'string' || !Number.isSafeInteger(data.version) || Object.keys(data).length !== 2)
        throw new Error('Invalid fixture command result');
      return { leadId: data.leadId, version: data.version as number };
    };
    const registry = defineCommands({
      // A platform command's read footprint includes the parent of the row it writes.
      escalate: defineCommand({
        realm: 'platform',
        target: 'lead',
        input: {},
        source: source.id,
        read: ['dealer'],
        when: 'status = open',
        output: { parse: result },
        async handle({ db, record: lead }) {
          // Guarded on the status and revision the lead was read at.
          const { version } = await db.lead.update(lead, { status: 'escalated' });
          return { leadId: String(lead.id), version: Number(version) };
        },
      }),
      flag: defineCommand({
        target: 'lead',
        input: {},
        source: source.id,
        when: 'status = open',
        output: { parse: result },
        async handle({ db, record: lead }) {
          const { version } = await db.lead.update(lead, { status: 'flagged' });
          return { leadId: String(lead.id), version: Number(version) };
        },
      }),
    });
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
          resultReferences: Object.fromEntries(
            ['escalate', 'flag'].map((id) => [id, (value: unknown) => [{ table: 'lead', key: { id: result(value).leadId } }]]),
          ),
        }),
        source: { ...source, existingPath: database },
        deployment: 'platform-generation',
        roles: ['staff', 'manager'],
        maxLifetimeMs: 300000,
        commands: { registry },
      },
    });
    owner.server.listen(port, '127.0.0.1');
    await once(owner.server, 'listening');
    const signup = async (name: string): Promise<TenantAccount> => {
      const credentials = { name, email: `${name}@example.test`, password: `tenant-platform-${name}-password` };
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10000),
      });
      const body = await response.json();
      if (!response.ok || typeof body.user?.id !== 'string') throw new Error('Platform fixture native signup failed');
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
        roles: ['staff'],
      });
      await admin.putPlatform({ status: 'active', expectedVersion: null });
      await admin.putPlatformMembership({ ...grant, accountId: accounts.bob.id, membershipId: 'bob-platform', roles: ['manager'] });
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
