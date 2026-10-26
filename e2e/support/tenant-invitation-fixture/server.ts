import { once } from 'node:events';
import { createServer } from 'node:http';
import { isAbsolute, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureAppAuthRuntime, createAppAuth, type AppAuthRuntime } from '../../../packages/mistri/src/server/auth/auth.js';
import type { LoadedApp } from '../../../packages/mistri/src/server/app/apps.js';
import { createTenantAuthenticatedHttpServer } from '../../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../../../packages/mistri/src/server/tenant/tenantStore.js';
import { provisionSqliteTenantAdministrationJournal } from '../../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { provisionSqliteTenantInvitations } from '../../../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { INVITATION_ISSUER_OPERATIONS } from '../../../packages/mistri/src/shared/tenantInvitations.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { invitationBinding as binding, invitationAppName } from '../tenantInvitationServer.js';
import type { TenantAccount } from '../tenantServer.js';

async function serve() {
  if (!process.send) throw new Error('The invitation fixture requires owned IPC');
  const input: { directory: string; administration: boolean } = JSON.parse(process.argv[2]);
  if (!isAbsolute(input.directory) || !['true', 'false'].includes(String(input.administration))) throw new Error('Invalid fixture options');
  const database = join(input.directory, 'business.db'),
    authDatabase = join(input.directory, 'auth.db');
  const db = new DatabaseSync(database);
  try {
    db.exec(`CREATE TABLE private_item(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
      INSERT INTO private_item VALUES ('north-item','north','Private north business row'),
        ('south-item','south','Private south business row')`);
  } finally {
    db.close();
  }
  provisionSqliteTenantStore(database, binding);
  provisionSqliteTenantAdministrationJournal(database, binding);
  provisionSqliteTenantInvitations(database, binding);
  const seed = new DatabaseSync(database);
  try {
    seed.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES ('north', 'active', '1', 'tenant'), ('south', 'active', '1', 'tenant')`);
  } finally {
    seed.close();
  }
  const loaded: LoadedApp = {
    path: join(input.directory, 'app.ts'),
    dir: input.directory,
    pages: [],
    sources: {},
    app: parseAppConfig(
      {
        id: binding.appId,
        name: invitationAppName,
        auth: { store: authDatabase, signUp: 'open', rows: 'tenant', roles: { reader: { read: true }, manager: { read: true } } },
        sources: { business: { connection: binding.source.connection } },
        resources: { item: { physical: 'private_item', owner: 'tenant', fields: { read: ['id', 'name'] } } },
        views: { items: { kind: 'list', from: 'item', label: 'Items', show: ['name'] } },
        home: 'items',
        nav: ['items'],
      },
      'private invitation browser fixture',
    ),
  };
  let auth: AppAuthRuntime | undefined;
  let owner: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
  const nativePending = new Set<Promise<void>>();
  const native = createServer((req, res) => {
    if (!auth) {
      res.writeHead(503);
      res.end();
      return;
    }
    const work = captureAppAuthRuntime(auth)
      .handler(req, res)
      .catch(() => {
        res.destroy();
      });
    nativePending.add(work);
    void work.finally(() => nativePending.delete(work));
  });
  const closeNative = async () => {
    if (native.listening) {
      const closed = once(native, 'close');
      native.close();
      native.closeAllConnections();
      await closed;
    }
    await Promise.allSettled([...nativePending]);
  };
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        await closeNative();
        if (owner) await owner.retire();
        else auth?.close();
      } finally {
        if (process.connected) process.disconnect();
      }
    })());
  // Keep the handler registered during async cleanup: signal-exit would
  // otherwise re-raise the signal after a once-handler removes itself.
  process.on('SIGTERM', () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
  process.once('disconnect', () => {
    void stop().catch(() => {
      process.exitCode = 1;
    });
  });
  try {
    native.listen(0, '127.0.0.1');
    await once(native, 'listening');
    const address = native.address();
    if (!address || typeof address === 'string') throw new Error('No fixture address');
    const origin = `http://127.0.0.1:${address.port}`;
    auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
    const signup = async (name: string): Promise<TenantAccount> => {
      const credentials = { name, email: `${name}@example.test`, password: `disposable-invitation-${name}-password` };
      const response = await fetch(`${origin}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(10_000),
      });
      const value = await response.json();
      if (!response.ok || typeof value.user?.id !== 'string') throw new Error('Fixture native account creation failed');
      return { ...credentials, id: value.user.id };
    };
    const accounts = { operator: await signup('operator'), target: await signup('target'), outsider: await signup('outsider') };
    await closeNative();
    owner = await createTenantAuthenticatedHttpServer({
      loaded,
      auth,
      browser: true,
      bound: { host: '127.0.0.1', port: address.port },
      enrollment: {
        policy: {
          kind: 'tenant',
          appId: binding.appId,
          storeId: binding.storeId,
          ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
          resolveMembershipRows: () => ({ item: true }),
          resolveRows: () => ({ item: true }),
          invitations: {
            id: 'browser-inviters',
            version: 'v1',
            maxMembershipLifetimeMs: 3_600_000,
            maxRedemptionLifetimeMs: 1_800_000,
            maxPendingPerTenant: 10,
            operators: [
              {
                accountId: accounts.operator.id,
                tenants: ['north', 'south'],
                operations: INVITATION_ISSUER_OPERATIONS,
                roles: ['reader', 'manager'],
              },
            ],
          },
          ...(input.administration
            ? {
                administration: {
                  id: 'browser-administrators',
                  version: 'v1',
                  maxMembershipLifetimeMs: 3_600_000,
                  operators: [
                    {
                      accountId: accounts.operator.id,
                      tenants: ['north', 'south'],
                      operations: ['revokeMembership' as const],
                      roles: ['reader', 'manager'],
                    },
                  ],
                },
              }
            : {}),
        },
        source: { ...binding.source, existingPath: database },
        deployment: 'private-invitation-browser',
        roles: ['reader', 'manager'],
        maxLifetimeMs: 300_000,
      },
    });
    owner.server.listen(address.port, '127.0.0.1');
    await once(owner.server, 'listening');
    process.send({ type: 'ready', value: { origin, accounts } });
  } catch (error) {
    await stop();
    throw error;
  }
}
void serve().catch(() => {
  if (process.connected) process.send?.({ type: 'failed' });
  process.exitCode = 1;
});
