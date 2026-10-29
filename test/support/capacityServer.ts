/**
 * The served side of `scripts/capacity-harness.mjs`: Ignition as a tenant App
 * on PostgreSQL, deployed the way `postgres-tenant-statements.test.ts` deploys
 * it (`prepareTenantStartup`, native auth, the authenticated tenant host), with
 * people spread over the four dealerships and a second port the harness
 * measures this process through.
 *
 * The control port and what it measures are `capacityProbe.ts`'s, shared with
 * an App served by the CLI.
 *
 * Not a test: nothing here asserts. Run by the harness, as a child process or
 * in a container capped to a fraction of a CPU.
 *
 * Environment: TABLEWALK_TEST_PG (an administrative URL the fixture creates
 * and drops its databases through), CAPACITY_ROUTE (host:port the served pools
 * reach that server through — a delay proxy; absent, directly), CAPACITY_PORT,
 * CAPACITY_CONTROL_PORT, CAPACITY_ORIGIN (the origin a client uses),
 * CAPACITY_USERS, CAPACITY_OUT (where profiles are written).
 */
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { TestContext } from 'node:test';
import { openCapacityControl } from './capacityProbe.js';

const env = (name: string, fallback?: string) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
};
const PORT = Number(env('CAPACITY_PORT', '4600'));
const CONTROL_PORT = Number(env('CAPACITY_CONTROL_PORT', String(PORT + 1)));
const ORIGIN = env('CAPACITY_ORIGIN', `http://127.0.0.1:${PORT}`);
const USERS = Number(env('CAPACITY_USERS', '25'));
const OUT = env('CAPACITY_OUT', join(tmpdir(), 'capacity'));
const ROUTE = process.env.CAPACITY_ROUTE;
const password = 'Capacity-harness-password-123!';

const directory = mkdtempSync(join(tmpdir(), 'mistri-capacity-'));
process.env.XDG_CONFIG_HOME = directory;
process.env.BETTER_AUTH_SECRET ??= 'disposable-capacity-harness-secret-at-least-thirty-two';
/* Every person signs in at once before a run; the sign-in limit is for a
   password oracle, not for this. It applies only to a loopback listener. */
process.env.MISTRI_TEST_AUTH_LIMITS = 'off';

/* The fixture takes a test's context only to register its cleanup. */
const cleanups: Array<() => unknown> = [];
const context = { after: (run: () => unknown) => void cleanups.push(run) } as unknown as TestContext;

const { openIgnitionLending, IGNITION_DIR } = await import('./ignitionLendingFixture.js');
const { loadApp } = await import('../../packages/mistri/src/server/app/apps.js');
const { createAppAuth } = await import('../../packages/mistri/src/server/auth/auth.js');
const { createNativeAccount } = await import('../../packages/mistri/src/server/auth/authAccounts.js');
const { createTenantAuthenticatedHttpServer } = await import('../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js');
const { prepareTenantStartup } = await import('../../packages/mistri/src/server/tenant/tenantStartup.js');

const started = performance.now();
const lending = await openIgnitionLending(context, 'postgres', { events: true });
const loaded = await loadApp(IGNITION_DIR);
/* Sessions in a PostgreSQL store of their own, as a deployment keeps them (`auth.store`), not the
   SQLite file a checkout defaults to: every request resolves its session there, so its cost is part
   of what a request costs. */
const { uuidPostgresDatabase } = await import('./tenantDialects.js');
const authStore = await uuidPostgresDatabase('cap_auth');
cleanups.push(() => authStore.drop());
const { migratePostgresAuthStore } = await import('../../packages/mistri/src/adapters/auth/postgresAuthStore.js');
await migratePostgresAuthStore(authStore.url);

/* The dealerships a person can enter: the sample keeps one suspended. */
const { DEALERS } = await import('../../examples/databases/ignition/schema.mjs');
const tenants = (DEALERS as ReadonlyArray<{ id: string; status: string }>)
  .filter((dealer) => dealer.status === 'active')
  .map((dealer) => dealer.id);
const accounts: Array<{ email: string; password: string; accountId: string; tenant: string; role: string }> = [];
for (let i = 0; i < USERS; i += 1) {
  const tenant = tenants[i % tenants.length];
  /* Mostly staff, as a dealership is; an admin in five sees the admin's extra reads. */
  const role = i % 5 === 0 ? 'dealer_admin' : 'dealer_staff';
  const email = `capacity.${i}@${tenant}.example.invalid`;
  accounts.push({ email, password, accountId: '', tenant, role });
}

const routed = (url: string) => {
  if (!ROUTE) return url;
  const parsed = new URL(url);
  parsed.host = ROUTE;
  return parsed.href;
};
const served = { ...loaded, app: { ...loaded.app, auth: { ...loaded.app.auth!, store: routed(authStore.url) } } };
const auth = await createAppAuth(served, {
  baseURL: ORIGIN,
  trustedOrigins: [ORIGIN],
  listenHost: '127.0.0.1',
});
cleanups.push(() => auth.close());
for (const [i, account] of accounts.entries()) {
  account.accountId = await createNativeAccount(auth, { email: account.email, name: `Capacity ${i}`, password }, { by: 'maintenance' });
  await lending.maintenance((admin) =>
    admin.putMembership({
      tenantId: account.tenant,
      accountId: account.accountId,
      membershipId: `${account.tenant}:capacity-${i}`,
      roles: [account.role],
      status: 'active',
      validUntil: lending.validUntil,
      expectedVersion: null,
    }),
  );
}

const prepared = await prepareTenantStartup({
  loaded: served,
  connections: [
    { id: 'loans', name: 'loans', url: routed(lending.source.url!), source: 'config', writable: true },
    { id: 'applicants', name: 'applicants', url: routed(lending.platformSources[0].url!), source: 'config' },
  ],
  policyFile: join(IGNITION_DIR, 'tenant-policy.ts'),
  commandsFile: join(IGNITION_DIR, 'commands.ts'),
});
const { refusalCause, startupReport } = await import('../../packages/engine/src/shared/refusal.js');
const owner = await createTenantAuthenticatedHttpServer({
  loaded: served,
  auth,
  enrollment: prepared.enrollment,
  bound: { host: '127.0.0.1', port: PORT },
}).catch((error: unknown) => {
  /* A tenant refusal says nothing on its face; the operator's reading of it says why. */
  console.error(startupReport(error), (refusalCause(error) as Error | undefined)?.stack);
  throw error;
});

owner.server.listen(PORT, '0.0.0.0');
await once(owner.server, 'listening');
const control = await openCapacityControl({
  port: CONTROL_PORT,
  out: OUT,
  ready: () => ({ appId: loaded.app.id, accounts, bootMs: performance.now() - started }),
});
console.log(
  `capacity: serving ${loaded.app.id} on ${PORT}, control on ${CONTROL_PORT}, ${USERS} people, ready in ${Math.round(performance.now() - started)} ms`,
);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  control.close();
  owner.server.closeAllConnections();
  await owner.retire().catch(() => {});
  for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch((error) => console.error(error));
  rmSync(directory, { recursive: true, force: true });
  /* Through exit, not a signal's default, so a --cpu-prof the harness asked for is written. */
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
