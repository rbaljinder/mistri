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
 * CAPACITY_USERS, CAPACITY_OUT (where profiles are written), CAPACITY_LIVE
 * (`0`: live sync off, as `--live 0` asks), CAPACITY_EDIT_LEADS (qualified
 * leads seeded in each dealership for `--edit convertLead`, and put back
 * after each conversion, so a save is a save and not a refusal).
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
const LIVE = process.env.CAPACITY_LIVE !== '0';
const EDIT_LEADS = Number(process.env.CAPACITY_EDIT_LEADS ?? 0);
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
/* Writes in the order the CLI serves an App in (mistriMain.ts): keyed, on a pool of writers. The default, serial,
   is the database browser's, and put every save of the run behind one connection. */
const { configureWriteOrder } = await import('../../packages/engine/src/adapters/writeLanes.js');
configureWriteOrder('keyed');

const started = performance.now();
const lending = await openIgnitionLending(context, 'postgres', { events: true });
const loaded = await loadApp(IGNITION_DIR);
/* Live sync on, as a field deployment runs it: its change store in the App's database, a change row in every
   write's transaction, and the hub reading them for the streams the harness holds open. */
if (LIVE) {
  const { provisionPostgresLiveChange } = await import('../../packages/mistri/src/adapters/live/postgresLiveChange.js');
  await provisionPostgresLiveChange(lending.source.url!);
}
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
/* An insert of a child and an update of its parent, repeatable: convertLead on leads of their own, each with a
   vehicle of its own (a vehicle is converted once), put back to qualified once converted, outside the App. */
let resetting: ReturnType<typeof setInterval> | undefined;
if (EDIT_LEADS > 0) {
  const columns = async (table: string, except: string[]) =>
    String(
      (
        await lending.rows(
          `SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) AS c FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = ? AND NOT (column_name = ANY (?))`,
          [table, except],
        )
      )[0]!.c,
    );
  const leadColumns = await columns('lead', ['id', 'reference', 'vehicle_stock', 'status', 'qualified_by', 'qualified_on', 'employer']);
  const vehicleColumns = await columns('vehicle', ['id', 'stock_reference', 'status']);
  for (const tenant of tenants) {
    const [lead] = await lending.rows(`SELECT id FROM lead WHERE tenant_id = ? AND status IN ('new', 'qualified') LIMIT 1`, [tenant]);
    const [vehicle] = await lending.rows(`SELECT id FROM vehicle WHERE tenant_id = ? LIMIT 1`, [tenant]);
    for (let n = 0; n < EDIT_LEADS; n += 1) {
      const tag = String(n).padStart(3, '0');
      await lending.exec(
        `INSERT INTO vehicle (id, stock_reference, status, ${vehicleColumns}) SELECT ?, ?, 'available', ${vehicleColumns} FROM vehicle WHERE id = ?`,
        [`${tenant}:vehicle:load-${tag}`, `LOAD-${tag}`, vehicle!.id],
      );
      await lending.exec(
        `INSERT INTO lead (id, reference, vehicle_stock, status, qualified_by, qualified_on, employer, ${leadColumns})
         SELECT ?, ?, ?, 'qualified', 'capacity', '2026-10-01', 'Capacity load', ${leadColumns} FROM lead WHERE id = ?`,
        [`${tenant}:lead:load-${tag}`, `L-9${tag}`, `LOAD-${tag}`, lead!.id],
      );
    }
  }
  resetting = setInterval(() => {
    void lending
      .exec(
        `WITH converted AS (
           DELETE FROM loan_application a USING lead l
           WHERE a.lead_id = l.id AND l.employer = 'Capacity load' AND l.status = 'converted' RETURNING l.id)
         UPDATE lead SET status = 'qualified' WHERE id IN (SELECT id FROM converted)`,
      )
      .catch(() => {});
  }, 1000);
  resetting.unref();
}
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
const served = {
  ...loaded,
  app: { ...loaded.app, ...(LIVE ? { live: true as const } : {}), auth: { ...loaded.app.auth!, store: routed(authStore.url) } },
};
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
  clearInterval(resetting);
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
