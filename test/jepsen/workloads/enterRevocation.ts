/**
 * Jepsen Tenant Enter, Discovery-Admitted Leases & LastWave Pipelining Revocation workload.
 *
 * Topology:
 *  - Isolated PostgreSQL database provisioned with Mistri's tenant store and
 *    command journal.
 *  - Real authenticated Mistri tenant HTTP server (`createTenantAuthenticatedHttpServer`
 *    + Better Auth SQLite auth store) routed to PostgreSQL through `FaultProxy`.
 *  - Two tenants (`north`, `south`), two accounts (`alice` in both tenants,
 *    `bob` in `south` only), and a tenant command (`qualifyLead`) on `lead`.
 *
 * Behaviour under test:
 *  - Hammers Wave 5 + Wave 6 read/enter paths concurrently:
 *      * `POST /api/tenant/enter` (F2 `readDiscoveryWithMarks` + `admitFromDiscovery`
 *        4-flight enter + 1-flight pipelined boot)
 *      * `POST /api/boot` (1-flight `lastWave()` pipelining on boot & batch reads)
 *      * `POST /api/commands/availability` (1-flight `lastWave()` pipelined availability)
 *      * `POST /api/pages/compose` (2-RTT parallel `withVerbs` + `lastWave()` compose)
 *      * `POST /api/run` & `POST /api/references` (1- and 2-flight pipelined reads)
 *  - Nemesis cycles `alice`'s `north` membership through revoke -> reinstate and
 *    suspends -> reactivates tenant `north`, while injecting `FaultProxy` TCP
 *    resets and latency spikes mid-flight.
 *  - Verifies:
 *      1. Zero cross-tenant row/data leaks (`north` vs `south`).
 *      2. Zero post-revocation / post-suspension leaks: no request started
 *         strictly inside a committed revocation or suspension window returns
 *         200 with `north` data, availability, or an entered `north` lease.
 *      3. Zero stale-evidence leases surviving revocation.
 *      4. Liveness: `alice` re-enters and reads `north` after reinstatement.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionOperations } from '../../../packages/engine/src/adapters/adapter.js';
import { migratePostgresCommandJournal } from '../../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { LoadedApp } from '../../../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../../../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../../../packages/mistri/src/server/commands.js';
import { appCommandCatalog } from '../../../packages/mistri/src/server/commands/commandContracts.js';
import { defineAppTenantPolicy } from '../../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { createTenantAuthenticatedHttpServer } from '../../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../../../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { TENANT_HTTP_HEADERS as headers } from '../../../packages/mistri/src/shared/tenantContext.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface EnterRevocationWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface EnterRevocationViolation {
  readonly code: string;
  readonly detail: string;
}

export interface EnterRevocationCheckResult {
  readonly valid: boolean;
  readonly violations: readonly EnterRevocationViolation[];
  readonly summary: {
    readonly enterOk: number;
    readonly bootOk: number;
    readonly availabilityOk: number;
    readonly composeOk: number;
    readonly runOk: number;
    readonly revokedRefusals: number;
    readonly crossTenantLeaks: number;
    readonly postRevocationLeaks: number;
    readonly revocationCycles: number;
  };
}

export interface EnterRevocationWorkloadReport {
  readonly workload: 'enter-revocation';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: EnterRevocationCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const APP_ID = 'jepsen-enter';
const BINDING = { appId: APP_ID, source: { id: 'business', connection: 'enter-business' }, storeId: 'enter-store' };
const ROLES = ['dealer_admin', 'dealer_staff'];

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

interface Lease {
  readonly tabId: string;
  readonly context: string;
  readonly revision: number;
  readonly tenantId: string;
}

interface ClosedWindow {
  readonly kind: 'membership-revoked' | 'tenant-suspended';
  readonly startMs: number;
  endMs: number;
}

function collectTenantRows(value: unknown, out: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectTenantRows(item, out);
    return out;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.tenant_id === 'string' && typeof obj.id === 'string') out.push(obj);
  for (const child of Object.values(obj)) {
    if (child && typeof child === 'object') collectTenantRows(child, out);
  }
  return out;
}

export async function runEnterRevocationWorkload(options: EnterRevocationWorkloadOptions): Promise<EnterRevocationWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);
  const workDir = mkdtempSync(join(tmpdir(), 'mistri-jepsen-enter-'));
  const authPath = join(workDir, 'auth.db');
  const prevSecret = process.env.BETTER_AUTH_SECRET;
  const prevLimits = process.env.MISTRI_TEST_AUTH_LIMITS;
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'test';
  process.env.BETTER_AUTH_SECRET = 'jepsen-enter-auth-secret-at-least-thirty-two-bytes';
  process.env.MISTRI_TEST_AUTH_LIMITS = 'off';

  try {
    return await withIsolatedPostgresDb(options.pgUrl, 'enter', async ({ dbUrl, control }) => {
      await control.query(`
        CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
        CREATE TABLE public.lead (
          id text PRIMARY KEY,
          tenant_id text NOT NULL REFERENCES public.dealer(id),
          name text NOT NULL,
          status text NOT NULL DEFAULT 'new',
          version integer NOT NULL DEFAULT 1
        );
        CREATE TABLE public.note (
          id text PRIMARY KEY,
          tenant_id text NOT NULL REFERENCES public.dealer(id),
          lead_id text NOT NULL REFERENCES public.lead(id),
          body text NOT NULL
        );
        INSERT INTO public.dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
        INSERT INTO public.lead (id, tenant_id, name, status) VALUES
          ('north-1', 'north', 'North Lead 1', 'new'),
          ('north-2', 'north', 'North Lead 2', 'new'),
          ('south-1', 'south', 'South Lead 1', 'new'),
          ('south-2', 'south', 'South Lead 2', 'new');
        INSERT INTO public.note (id, tenant_id, lead_id, body) VALUES
          ('n-note-1', 'north', 'north-1', 'North secret note'),
          ('s-note-1', 'south', 'south-1', 'South secret note');
      `);

      await migratePostgresTenantStore(dbUrl, BINDING);
      await migratePostgresCommandJournal(dbUrl);

      const maintenance = async (run: (admin: ReturnType<typeof createPostgresTenantAdministration>) => Promise<void>) => {
        const operations = new TransactionOperations();
        await control.query('BEGIN');
        try {
          await run(createPostgresTenantAdministration(control, operations, BINDING));
          await operations.finish();
          await control.query('COMMIT');
        } catch (error) {
          await operations.finish().catch(() => {});
          await control.query('ROLLBACK').catch(() => {});
          throw error;
        }
      };

      let northTenantVersion = 1;
      await maintenance(async (admin) => {
        await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
        await admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: null });
      });

      const parsed = new URL(dbUrl);
      const proxy = new FaultProxy(parsed.hostname || '127.0.0.1', Number(parsed.port || 5432));
      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const commands = defineCommands({
        qualifyLead: defineCommand({
          source: 'business',
          target: 'lead',
          when: "status = 'new'",
          async handle({ db, record }) {
            await db.lead.update(record, { status: 'qualified' });
            return { ok: true };
          },
        }),
      });
      const rawManifest = {
        id: APP_ID,
        name: 'Jepsen Enter',
        sources: { business: { connection: BINDING.source.connection } },
        resources: {
          dealer: { owner: 'platform' as const },
          lead: {
            access: 'write' as const,
            owner: 'tenant' as const,
            actions: { qualifyLead: { label: 'Qualify', command: 'qualifyLead' } },
          },
          note: { access: 'write' as const, owner: 'tenant' as const },
        },
        auth: {
          store: authPath,
          signUp: 'open' as const,
          rows: 'tenant' as const,
          tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Platform' } },
          roles: {
            dealer_admin: { realm: 'tenant' as const, read: true as const, write: ['note'], commands: ['qualifyLead'] },
            dealer_staff: { realm: 'tenant' as const, read: true as const },
          },
        },
        views: { leads: { kind: 'list' as const, from: 'lead' } },
        nav: [{ id: 'desk', label: 'Desk', realm: 'tenant' as const, children: ['leads'] }],
        home: 'leads',
      };
      const manifest = parseAppConfig(rawManifest, 'jepsen enter manifest', {
        commands: appCommandCatalog(commands, { sources: { business: { connection: BINDING.source.connection, default: true } } }),
      });
      const loaded: LoadedApp = { path: join(workDir, 'app.ts'), dir: workDir, pages: [], sources: {}, app: manifest };

      let auth: AppAuthRuntime | undefined;
      let host: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
      const history = new HistoryRecorder<unknown>();
      let nemesisEvents = 0;

      await proxy.start();
      try {
        auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
        const policy = defineAppTenantPolicy({
          kind: 'tenant',
          appId: APP_ID,
          storeId: BINDING.storeId,
          ownership: {
            dealer: { kind: 'platform' },
            lead: { kind: 'tenant', column: 'tenant_id' },
            note: { kind: 'tenant', column: 'tenant_id' },
          },
          resolveMembershipRows: () => ({ lead: true, note: true }),
          resolveRows: () => ({ lead: true, note: true }),
          resolvePlatformRows: () => ({ dealer: true }),
          resultReferences: { qualifyLead: () => [] },
        });

        host = await createTenantAuthenticatedHttpServer({
          loaded,
          auth,
          bound: { host: '127.0.0.1', port },
          enrollment: {
            policy,
            source: { ...BINDING.source, url: proxy.proxiedUrl(dbUrl) },
            deployment: 'jepsen-enter-gen-1',
            roles: ROLES,
            maxLifetimeMs: 300_000,
            commands: Object.freeze({ registry: commands }),
          },
        });
        await new Promise<void>((resolve, reject) => {
          host!.server.once('error', reject);
          host!.server.listen(port, '127.0.0.1', () => {
            host!.server.off('error', reject);
            resolve();
          });
        });

        const signUpAndIn = async (name: string, email: string, password: string) => {
          const up = await fetch(`${origin}/api/auth/sign-up/email`, {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({ name, email, password }),
          });
          const upJson = (await up.json()) as { user: { id: string } };
          const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          const cookie = signIn.headers
            .getSetCookie()
            .map((v) => v.split(';')[0])
            .join('; ');
          return { accountId: upJson.user.id, cookie };
        };

        const alice = await signUpAndIn('Alice North', 'alice@jepsen.test', 'jepsen-alice-password-123');
        const bob = await signUpAndIn('Bob South', 'bob@jepsen.test', 'jepsen-bob-password-123');
        const validUntil = Date.now() + 3_600_000;
        let aliceNorthMembershipId = 'm-alice-north-0';
        let aliceNorthVersion = 1;

        await maintenance(async (admin) => {
          await admin.putMembership({
            tenantId: 'north',
            accountId: alice.accountId,
            membershipId: aliceNorthMembershipId,
            roles: ['dealer_admin'],
            status: 'active',
            validUntil,
            expectedVersion: null,
          });
          await admin.putMembership({
            tenantId: 'south',
            accountId: alice.accountId,
            membershipId: 'm-alice-south',
            roles: ['dealer_staff'],
            status: 'active',
            validUntil,
            expectedVersion: null,
          });
          await admin.putMembership({
            tenantId: 'south',
            accountId: bob.accountId,
            membershipId: 'm-bob-south',
            roles: ['dealer_admin'],
            status: 'active',
            validUntil,
            expectedVersion: null,
          });
        });

        const violations: EnterRevocationViolation[] = [];
        const closedWindows: ClosedWindow[] = [];
        let enterOk = 0;
        let bootOk = 0;
        let availabilityOk = 0;
        let composeOk = 0;
        let runOk = 0;
        let revokedRefusals = 0;
        let crossTenantLeaks = 0;
        let postRevocationLeaks = 0;
        let revocationCycles = 0;

        const callJson = async (
          cookie: string,
          accountId: string,
          path: string,
          body: unknown,
          lease?: Lease,
        ): Promise<{ status: number; body: Record<string, unknown> }> => {
          const urlPath = lease ? `${path}${path.includes('?') ? '&' : '?'}tenant=${encodeURIComponent(lease.tenantId)}` : path;
          const res = await fetch(`${origin}${urlPath}`, {
            method: 'POST',
            headers: {
              origin,
              cookie,
              'content-type': 'application/json',
              [headers.account]: accountId,
              [headers.app]: APP_ID,
              ...(lease
                ? {
                    [headers.tab]: lease.tabId,
                    [headers.context]: lease.context,
                    [headers.revision]: String(lease.revision),
                  }
                : {}),
            },
            body: JSON.stringify(body),
          });
          const text = await res.text();
          let parsedBody: Record<string, unknown> = {};
          try {
            if (text.startsWith('{')) parsedBody = JSON.parse(text) as Record<string, unknown>;
          } catch {
            /* non-JSON body */
          }
          return { status: res.status, body: parsedBody };
        };

        const checkNoCrossTenant = (expectedTenant: string, op: string, payload: unknown) => {
          for (const row of collectTenantRows(payload)) {
            if (row.tenant_id !== expectedTenant) {
              crossTenantLeaks++;
              violations.push({
                code: 'CROSS_TENANT_LEAK',
                detail: `${op} for tenant=${expectedTenant} returned row id=${String(row.id)} belonging to tenant=${String(row.tenant_id)}`,
              });
            }
          }
        };

        // Pre-seed one active north lease for Alice before chaos begins so workers exercise both cached-lease and fresh-enter races.
        let sharedAliceNorthLease: Lease | undefined;
        const releaseLease = async (cookie: string, accountId: string, lease: Lease) => {
          await callJson(cookie, accountId, `/api/tenant/context/release?app=${APP_ID}`, {
            tabId: lease.tabId,
            expectedContext: lease.context,
            expectedRevision: lease.revision,
          }).catch(() => {});
        };
        const enterAliceNorth = async (): Promise<{ status: number; body: Record<string, unknown>; lease?: Lease }> => {
          const prev = sharedAliceNorthLease;
          const res = await callJson(alice.cookie, alice.accountId, `/api/tenant/enter?app=${APP_ID}`, {
            path: `/${APP_ID}/leads`,
            search: '',
            kept: { tenantId: 'north', tabId: prev?.tabId ?? 'tab-alice-north' },
          });
          const entered = res.body.entered as { context?: Lease } | undefined;
          const lease = entered?.context?.tenantId === 'north' ? entered.context : undefined;
          if (res.status === 200 && lease) {
            sharedAliceNorthLease = lease;
            if (prev && prev.tabId !== lease.tabId) void releaseLease(alice.cookie, alice.accountId, prev);
          } else if (res.status === 200 && entered?.context) {
            // Entered fallback tenant (south) during north revocation: release the fallback tab immediately so tab cap is never exhausted.
            void releaseLease(alice.cookie, alice.accountId, entered.context);
          }
          return { ...res, lease };
        };

        const initial = await enterAliceNorth();
        if (initial.status !== 200 || !initial.lease) {
          violations.push({ code: 'INITIAL_ENTER_FAILED', detail: `Initial north enter returned ${initial.status}` });
        } else {
          enterOk++;
          checkNoCrossTenant('north', 'initial-enter', initial.body);
        }

        const bobInitial = await callJson(bob.cookie, bob.accountId, `/api/tenant/enter?app=${APP_ID}`, {
          path: `/${APP_ID}/leads`,
          search: '',
          kept: { tenantId: 'south', tabId: 'tab-bob-south' },
        });
        const bobEntered = bobInitial.body.entered as { context?: Lease } | undefined;
        const bobSouthLease: Lease | undefined = bobEntered?.context?.tenantId === 'south' ? bobEntered.context : undefined;
        if (!bobSouthLease) {
          violations.push({ code: 'BOB_ENTER_FAILED', detail: `Bob south enter returned ${bobInitial.status}` });
        }

        // Record every Alice-on-North response with [reqStart, reqEnd] for strict window checking after the run.
        const aliceNorthEvents: Array<{ op: string; reqStart: number; reqEnd: number; status: number; admittedNorth: boolean }> = [];
        const stopAt = Date.now() + options.durationSec * 1_000;

        const nemesisLoop = async () => {
          let round = 0;
          while (Date.now() < stopAt) {
            await sleep(450);
            if (Date.now() >= stopAt) break;
            const kind = round % 2 === 0 ? 'membership-revoked' : 'tenant-suspended';
            round++;
            revocationCycles++;
            nemesisEvents++;
            if (kind === 'membership-revoked') {
              await maintenance(async (admin) => {
                await admin.putMembership({
                  tenantId: 'north',
                  accountId: alice.accountId,
                  membershipId: aliceNorthMembershipId,
                  roles: ['dealer_admin'],
                  status: 'revoked',
                  validUntil,
                  expectedVersion: String(aliceNorthVersion),
                });
                aliceNorthVersion++;
              });
              const win: ClosedWindow = { kind, startMs: Date.now(), endMs: Number.POSITIVE_INFINITY };
              closedWindows.push(win);
              history.info('nemesis', 'revoke-membership', { tenant: 'north', membershipId: aliceNorthMembershipId });
              await sleep(650);
              win.endMs = Date.now();
              const nextMembershipId = `m-alice-north-${round}`;
              await maintenance(async (admin) => {
                await admin.putMembership({
                  tenantId: 'north',
                  accountId: alice.accountId,
                  membershipId: nextMembershipId,
                  roles: ['dealer_admin'],
                  status: 'active',
                  validUntil,
                  expectedVersion: null,
                });
              });
              aliceNorthMembershipId = nextMembershipId;
              aliceNorthVersion = 1;
              history.info('nemesis', 'reinstate-membership', { tenant: 'north', membershipId: aliceNorthMembershipId });
            } else {
              await maintenance(async (admin) => {
                await admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: String(northTenantVersion) });
                northTenantVersion++;
              });
              const win: ClosedWindow = { kind, startMs: Date.now(), endMs: Number.POSITIVE_INFINITY };
              closedWindows.push(win);
              history.info('nemesis', 'suspend-tenant', { tenant: 'north', version: northTenantVersion });
              await sleep(650);
              win.endMs = Date.now();
              await maintenance(async (admin) => {
                await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: String(northTenantVersion) });
                northTenantVersion++;
              });
              history.info('nemesis', 'reactivate-tenant', { tenant: 'north', version: northTenantVersion });
            }
            if (options.nemesis && Date.now() < stopAt) {
              nemesisEvents++;
              if (round % 2 === 0) {
                const count = proxy.resetConnections();
                history.info('nemesis', 'tcp-reset', { sockets: count });
              } else {
                proxy.setLatency(20, 10);
                await sleep(150);
                proxy.setLatency(0, 0);
              }
            }
          }
        };

        const worker = async (workerId: number) => {
          const isBob = workerId === options.concurrency - 1;
          while (Date.now() < stopAt) {
            if (isBob && bobSouthLease) {
              try {
                const op = rng.int(0, 3);
                if (op === 0) {
                  const res = await callJson(
                    bob.cookie,
                    bob.accountId,
                    `/api/run?app=${APP_ID}`,
                    { q: 'lead', limit: 20, offset: 0, exactCount: false },
                    bobSouthLease,
                  );
                  if (res.status === 200) {
                    runOk++;
                    checkNoCrossTenant('south', 'bob-run', res.body);
                  }
                } else if (op === 1) {
                  const res = await callJson(
                    bob.cookie,
                    bob.accountId,
                    `/api/boot?app=${APP_ID}`,
                    { reads: [{ method: 'POST', path: '/api/run', body: { q: 'lead', limit: 20, offset: 0, exactCount: false } }] },
                    bobSouthLease,
                  );
                  if (res.status === 200) {
                    bootOk++;
                    checkNoCrossTenant('south', 'bob-batch-boot', res.body);
                  }
                } else {
                  const res = await callJson(
                    bob.cookie,
                    bob.accountId,
                    `/api/commands/availability?app=${APP_ID}`,
                    { checks: [{ command: 'qualifyLead', commandVersion: 1, keys: [{ id: 'south-1' }] }] },
                    bobSouthLease,
                  );
                  if (res.status === 200) availabilityOk++;
                }
              } catch {
                /* transient fault proxy reset */
              }
              await sleep(rng.int(10, 30));
              continue;
            }

            const choice = rng.int(0, 5);
            const lease = sharedAliceNorthLease;
            const reqStart = Date.now();
            try {
              if (choice === 0 || !lease) {
                const res = await enterAliceNorth();
                const reqEnd = Date.now();
                const entered = res.body.entered as { context?: { tenantId?: string }; boot?: unknown } | undefined;
                const enteredTenant = entered?.context?.tenantId;
                const admittedNorth = res.status === 200 && enteredTenant === 'north';
                if (admittedNorth) {
                  enterOk++;
                  checkNoCrossTenant('north', 'alice-enter', res.body);
                } else if (res.status === 200 && enteredTenant === 'south') {
                  revokedRefusals++;
                  checkNoCrossTenant('south', 'alice-enter-fallback', res.body);
                } else if (res.status === 403 || (res.status === 200 && !entered?.context)) {
                  revokedRefusals++;
                }
                aliceNorthEvents.push({ op: 'enter', reqStart, reqEnd, status: res.status, admittedNorth });
              } else if (choice === 1) {
                const res = await callJson(
                  alice.cookie,
                  alice.accountId,
                  `/api/boot?app=${APP_ID}`,
                  { reads: [{ method: 'POST', path: '/api/run', body: { q: 'lead', limit: 20, offset: 0, exactCount: false } }] },
                  lease,
                );
                const reqEnd = Date.now();
                const admittedNorth = res.status === 200;
                if (admittedNorth) {
                  bootOk++;
                  checkNoCrossTenant('north', 'alice-boot', res.body);
                } else if (res.status === 403 || res.status === 409) revokedRefusals++;
                aliceNorthEvents.push({ op: 'boot', reqStart, reqEnd, status: res.status, admittedNorth });
              } else if (choice === 2) {
                const res = await callJson(
                  alice.cookie,
                  alice.accountId,
                  `/api/commands/availability?app=${APP_ID}`,
                  { checks: [{ command: 'qualifyLead', commandVersion: 1, keys: [{ id: 'north-1' }] }] },
                  lease,
                );
                const reqEnd = Date.now();
                const admittedNorth = res.status === 200;
                if (admittedNorth) availabilityOk++;
                else if (res.status === 403 || res.status === 409) revokedRefusals++;
                aliceNorthEvents.push({ op: 'availability', reqStart, reqEnd, status: res.status, admittedNorth });
              } else if (choice === 3) {
                const res = await callJson(
                  alice.cookie,
                  alice.accountId,
                  `/api/pages/compose?app=${APP_ID}`,
                  { page: 'suggested:lead', key: { id: 'north-1' } },
                  lease,
                );
                const reqEnd = Date.now();
                const admittedNorth = res.status === 200;
                if (admittedNorth) {
                  composeOk++;
                  checkNoCrossTenant('north', 'alice-compose', res.body);
                } else if (res.status === 403 || res.status === 409) revokedRefusals++;
                aliceNorthEvents.push({ op: 'compose', reqStart, reqEnd, status: res.status, admittedNorth });
              } else {
                const res = await callJson(
                  alice.cookie,
                  alice.accountId,
                  `/api/references?app=${APP_ID}`,
                  { table: 'lead', key: { id: 'north-1' } },
                  lease,
                );
                const reqEnd = Date.now();
                const admittedNorth = res.status === 200;
                if (admittedNorth) {
                  runOk++;
                  checkNoCrossTenant('north', 'alice-references', res.body);
                } else if (res.status === 403 || res.status === 409) revokedRefusals++;
                aliceNorthEvents.push({ op: 'references', reqStart, reqEnd, status: res.status, admittedNorth });
              }
            } catch {
              /* transient fault proxy reset */
            }
            await sleep(rng.int(10, 35));
          }
        };

        const workers = Array.from({ length: Math.max(2, options.concurrency) }, (_, i) => worker(i));
        await Promise.all([...workers, nemesisLoop()]);

        // Verify post-chaos liveness (Alice re-enters and reads north after nemesis completes all reinstatement cycles).
        proxy.setLatency(0, 0);
        const recovery = await enterAliceNorth();
        if (recovery.status !== 200 || !recovery.lease) {
          violations.push({
            code: 'POST_CHAOS_RECOVERY_FAILED',
            detail: `Alice failed to re-enter north after chaos (${recovery.status})`,
          });
        } else {
          enterOk++;
          checkNoCrossTenant('north', 'recovery-enter', recovery.body);
        }

        // Strict linearizability check: any Alice-on-North request started strictly AFTER revocation/suspension committed
        // and completed strictly BEFORE reinstatement began MUST NOT have been admitted for north!
        for (const ev of aliceNorthEvents) {
          if (!ev.admittedNorth) continue;
          for (const win of closedWindows) {
            if (ev.reqStart >= win.startMs && ev.reqEnd <= win.endMs) {
              postRevocationLeaks++;
              violations.push({
                code: 'POST_REVOCATION_LEAK',
                detail: `${ev.op} admitted north during ${win.kind} window [${win.startMs}..${win.endMs}] (req=[${ev.reqStart}..${ev.reqEnd}])`,
              });
            }
          }
        }
        if (revocationCycles === 0) {
          violations.push({ code: 'NO_REVOCATION_CYCLES', detail: 'Workload completed without executing any revocation cycle.' });
        }
        if (revokedRefusals === 0) {
          violations.push({ code: 'NO_REVOKED_REFUSALS', detail: 'No requests were refused during revocation/suspension windows.' });
        }

        const check: EnterRevocationCheckResult = {
          valid: violations.length === 0,
          violations,
          summary: {
            enterOk,
            bootOk,
            availabilityOk,
            composeOk,
            runOk,
            revokedRefusals,
            crossTenantLeaks,
            postRevocationLeaks,
            revocationCycles,
          },
        };

        const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'enter-revocation-history')) : undefined;

        return {
          workload: 'enter-revocation',
          valid: check.valid,
          durationMs: Date.now() - startedAt,
          nemesisEvents,
          proxyStats: [{ node: 'enter-host', stats: proxy.stats() }],
          check,
          ...(historyFiles ? { historyFiles } : {}),
        };
      } finally {
        if (host) {
          host.server.closeAllConnections();
          await new Promise<void>((resolve) => host!.server.close(() => resolve()));
          await Promise.resolve(host.retire()).catch(() => {});
        }
        if (auth) {
          try {
            auth.close();
          } catch {
            // ignore teardown error
          }
        }
        await proxy.close().catch(() => {});
      }
    });
  } finally {
    if (prevSecret === undefined) delete process.env.BETTER_AUTH_SECRET;
    else process.env.BETTER_AUTH_SECRET = prevSecret;
    if (prevLimits === undefined) delete process.env.MISTRI_TEST_AUTH_LIMITS;
    else process.env.MISTRI_TEST_AUTH_LIMITS = prevLimits;
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    rmSync(workDir, { recursive: true, force: true });
  }
}
