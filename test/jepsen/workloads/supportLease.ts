/**
 * Jepsen Tenant Support-Lease Revocation Races & Fail-Closed Audit Ledger workload.
 *
 * Topology:
 *  - One isolated PostgreSQL database provisioned with Mistri's tenant store,
 *    tenant administration journal, and cryptographic support audit ledger.
 *  - Real authenticated Mistri tenant HTTP server (`createTenantAuthenticatedHttpServer`
 *    + real Better Auth native SQLite auth store) routed to PostgreSQL via `FaultProxy`.
 *
 * Behaviour under test:
 *  - Concurrent `POST /api/tenant/support/open` and `/exit` requests for the
 *    same platform operator across multiple tenants (`north`, `south`) under
 *    `FaultProxy` post-COMMIT TCP cuts and socket resets.
 *  - Mid-chaos parent platform membership revocation (`putPlatformMembership(..., status: 'revoked')`)
 *    racing against live support session openings.
 *  - Verifies:
 *    1. At most 1 active support session exists for the operator at any snapshot.
 *    2. Zero active support sessions survive parent revocation (and subsequent opens are refused).
 *    3. `verifyPostgresSupportAudit()` cryptographic hash-chain has 0 failed sessions.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TransactionOperations } from '../../../packages/engine/src/adapters/adapter.js';
import { runtimeTable } from '../../../packages/engine/src/shared/runtimeTables.js';
import type { LoadedApp } from '../../../packages/mistri/src/server/app/apps.js';
import { createAppAuth, type AppAuthRuntime } from '../../../packages/mistri/src/server/auth/auth.js';
import { defineAppTenantPolicy } from '../../../packages/mistri/src/server/policy/appTenantPolicy.js';
import { migratePostgresTenantAdministrationJournal } from '../../../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { createTenantAuthenticatedHttpServer } from '../../../packages/mistri/src/server/tenant/tenantAuthenticatedHttp.js';
import { revokePlatformMembership } from '../../../packages/mistri/src/server/tenant/tenantMaintenance.js';
import { TENANT_TABLES } from '../../../packages/mistri/src/server/tenant/tenantStoreContract.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../../../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import {
  SUPPORT_AUDIT_KEY_VARIABLE,
  SUPPORT_AUDIT_TABLES,
  supportAuditKey,
} from '../../../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import {
  migratePostgresSupportAudit,
  verifyPostgresSupportAudit,
} from '../../../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { TENANT_HTTP_HEADERS as headers } from '../../../packages/mistri/src/shared/tenantContext.js';
import { checkSupportLeases, type SupportLeaseCheckResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface SupportLeaseWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface SupportLeaseWorkloadReport {
  readonly workload: 'support-lease';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: SupportLeaseCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const APP_ID = 'jepsen-support';
const BINDING = { appId: APP_ID, source: { id: 'business', connection: 'support-business' }, storeId: 'support-store' };
const AUDIT_SECRET = 'jepsen-support-audit-secret-at-least-thirty-two-bytes';
const ROLES = ['lender_admin', 'dealer_admin', 'dealer_staff'];

async function freePort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const port = (srv.address() as { port: number }).port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

export async function runSupportLeaseWorkload(options: SupportLeaseWorkloadOptions): Promise<SupportLeaseWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);
  const workDir = mkdtempSync(join(tmpdir(), 'mistri-jepsen-support-'));
  const authPath = join(workDir, 'auth.db');
  const key = supportAuditKey(AUDIT_SECRET);

  const prevEnv = [
    ['BETTER_AUTH_SECRET', process.env.BETTER_AUTH_SECRET],
    [SUPPORT_AUDIT_KEY_VARIABLE, process.env[SUPPORT_AUDIT_KEY_VARIABLE]],
  ] as const;
  process.env.BETTER_AUTH_SECRET = 'jepsen-support-auth-secret-at-least-thirty-two-bytes';
  process.env[SUPPORT_AUDIT_KEY_VARIABLE] = AUDIT_SECRET;

  try {
    return await withIsolatedPostgresDb(options.pgUrl, 'support', async ({ dbUrl, control }) => {
      await control.query(`
        CREATE TABLE public.dealer (id text PRIMARY KEY, name text NOT NULL);
        CREATE TABLE public.lead (id text PRIMARY KEY, tenant_id text NOT NULL REFERENCES public.dealer(id), name text NOT NULL, version integer NOT NULL DEFAULT 0);
        INSERT INTO public.dealer VALUES ('north', 'North Motors'), ('south', 'South Auto');
        INSERT INTO public.lead (id, tenant_id, name) VALUES ('n1', 'north', 'North lead'), ('s1', 'south', 'South lead');
      `);

      await migratePostgresTenantStore(dbUrl, BINDING);
      await migratePostgresTenantAdministrationJournal(dbUrl, BINDING);
      await migratePostgresSupportAudit(dbUrl, BINDING, key);

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

      await maintenance(async (admin) => {
        await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
        await admin.putTenant({ tenantId: 'south', status: 'active', expectedVersion: null });
        await admin.putPlatform({ status: 'active', expectedVersion: null });
      });

      const parsed = new URL(dbUrl);
      const proxy = new FaultProxy(parsed.hostname || '127.0.0.1', Number(parsed.port || 5432));
      await proxy.start();

      const port = await freePort();
      const origin = `http://127.0.0.1:${port}`;
      const manifest = parseAppConfig(
        {
          id: APP_ID,
          name: 'Jepsen Support',
          sources: { business: { connection: BINDING.source.connection } },
          resources: { dealer: { owner: 'platform' }, lead: { access: 'write', owner: 'tenant' } },
          auth: {
            store: authPath,
            signUp: 'open',
            rows: 'tenant',
            tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
            roles: {
              lender_admin: { realm: 'platform', read: true },
              dealer_admin: { realm: 'tenant', read: true, write: ['lead'] },
              dealer_staff: { realm: 'tenant', read: true },
            },
          },
          views: { leads: { kind: 'list', from: 'lead' }, dealers: { kind: 'list', from: 'dealer' } },
          nav: [
            { id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] },
            { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
          ],
          home: 'leads',
        },
        'jepsen support manifest',
      );
      const loaded: LoadedApp = { path: join(workDir, 'app.ts'), dir: workDir, pages: [], sources: {}, app: manifest };

      let auth: AppAuthRuntime | undefined;
      let host: Awaited<ReturnType<typeof createTenantAuthenticatedHttpServer>> | undefined;
      const history = new HistoryRecorder<unknown>();
      let nemesisEvents = 0;

      try {
        auth = await createAppAuth(loaded, { baseURL: origin, trustedOrigins: [origin] });
        const policy = defineAppTenantPolicy({
          kind: 'tenant',
          appId: APP_ID,
          storeId: BINDING.storeId,
          ownership: { dealer: { kind: 'platform' }, lead: { kind: 'tenant', column: 'tenant_id' } },
          resolveMembershipRows: () => ({ lead: true }),
          resolveRows: () => ({ lead: true }),
          resolvePlatformRows: () => ({ dealer: true, lead: true }),
          support: {
            id: 'lender-support',
            version: '1',
            grants: [{ platformRole: 'lender_admin', tenants: 'all', dealerRoles: ['dealer_admin', 'dealer_staff'] }],
          } as never,
        });

        host = await createTenantAuthenticatedHttpServer({
          loaded,
          auth,
          bound: { host: '127.0.0.1', port },
          enrollment: {
            policy,
            source: { ...BINDING.source, url: proxy.proxiedUrl(dbUrl) },
            deployment: 'jepsen-support-gen-1',
            roles: ROLES,
            maxLifetimeMs: 300_000,
          },
        });
        await new Promise<void>((resolve, reject) => {
          host!.server.once('error', reject);
          host!.server.listen(port, '127.0.0.1', () => {
            host!.server.off('error', reject);
            resolve();
          });
        });

        // Sign up Avery and grant active platform membership.
        const email = 'avery@jepsen.test';
        const password = 'jepsen-avery-password-123';
        const signupRes = await fetch(`${origin}/api/auth/sign-up/email`, {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Avery Admin', email, password }),
        });
        const signupJson = (await signupRes.json()) as { user: { id: string } };
        const accountId = signupJson.user.id;

        const signIn = async () => {
          const res = await fetch(`${origin}/api/auth/sign-in/email`, {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          return res.headers
            .getSetCookie()
            .map((v) => v.split(';')[0])
            .join('; ');
        };
        const cookies = [await signIn(), await signIn()];

        const validUntil = Date.now() + 3_600_000;
        await maintenance(async (admin) => {
          await admin.putPlatformMembership({
            accountId,
            membershipId: 'platform-avery',
            status: 'active',
            roles: ['lender_admin'],
            validUntil,
            expectedVersion: null,
          });
        });

        const membershipTable = runtimeTable('postgres', TENANT_TABLES.membership);
        const auditSessionTable = runtimeTable('postgres', SUPPORT_AUDIT_TABLES.session);

        const countActiveLeases = async (): Promise<number> => {
          const res = await control.query(
            `SELECT COUNT(*) AS c FROM ${membershipTable} WHERE account_id = $1 AND kind = 'support' AND status = 'active'`,
            [accountId],
          );
          return Number((res.rows[0] as { c: string | number }).c);
        };

        let openSucceeded = 0;
        let exitSucceeded = 0;
        let maxActiveObserved = 0;
        let postRevokeOpenSucceeded = 0;
        let lastSession: { tenantId: string; supportId: string; version: string } | undefined;
        let opSeq = 0;
        let revoked = false;

        const callSupport = async (cookie: string, operation: 'open' | 'exit', body: object) => {
          const res = await fetch(`${origin}/api/tenant/support/${operation}?app=${APP_ID}`, {
            method: 'POST',
            signal: AbortSignal.timeout(5_000),
            headers: {
              origin,
              'content-type': 'application/json',
              cookie,
              [headers.account]: accountId,
            },
            body: JSON.stringify(body),
          });
          const text = await res.text();
          let json: Record<string, unknown> = {};
          try {
            json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
          } catch {
            json = { raw: text };
          }
          return { status: res.status, body: json };
        };

        const totalMs = Math.max(3_000, options.durationSec * 1_000);
        const revokeAt = Date.now() + Math.floor(totalMs * 0.65);
        const stopAt = Date.now() + totalMs;

        const worker = async (proc: number) => {
          const cookie = cookies[proc % cookies.length];
          while (Date.now() < stopAt) {
            const wasRevoked = revoked;
            const doExit = !wasRevoked && lastSession !== undefined && rng.next() < 0.3;
            if (doExit && lastSession) {
              const sess = lastSession;
              const idempotencyKey = `sup-exit-${options.seed}-${++opSeq}`;
              history.invoke(proc, 'support-exit', { idempotencyKey, supportId: sess.supportId });
              try {
                const reply = await callSupport(cookie, 'exit', {
                  idempotencyKey,
                  intent: {
                    operation: 'exitSupport',
                    tenantId: sess.tenantId,
                    supportId: sess.supportId,
                    expectedSupportVersion: sess.version,
                  },
                });
                if (reply.status === 200) {
                  exitSucceeded++;
                  history.ok(proc, 'support-exit', { idempotencyKey, supportId: sess.supportId });
                } else {
                  history.fail(proc, 'support-exit', { idempotencyKey, status: reply.status });
                }
              } catch (error) {
                history.info(proc, 'support-exit', {
                  idempotencyKey,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            } else {
              const tenantId = rng.pick(['north', 'south']);
              const dealerRole = rng.pick(['dealer_admin', 'dealer_staff']);
              const idempotencyKey = `sup-open-${options.seed}-${++opSeq}`;
              history.invoke(proc, 'support-open', { idempotencyKey, tenantId, dealerRole, afterRevoke: wasRevoked });
              try {
                const reply = await callSupport(cookie, 'open', {
                  idempotencyKey,
                  intent: { operation: 'openSupport', tenantId, dealerRole, reason: 'Jepsen support lease probe' },
                });
                if (reply.status === 200) {
                  openSucceeded++;
                  if (wasRevoked && revoked) postRevokeOpenSucceeded++;
                  const session = (reply.body.receipt as { session?: { tenantId: string; supportId: string; version: string } })?.session;
                  if (session) lastSession = session;
                  history.ok(proc, 'support-open', { idempotencyKey, supportId: session?.supportId, tenantId });
                } else {
                  history.fail(proc, 'support-open', { idempotencyKey, status: reply.status });
                }
              } catch (error) {
                history.info(proc, 'support-open', {
                  idempotencyKey,
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }

            const active = await countActiveLeases();
            if (active > maxActiveObserved) maxActiveObserved = active;
            await sleep(rng.int(15, 45));
          }
        };

        const nemesis = async () => {
          while (Date.now() < revokeAt) {
            await sleep(rng.int(350, 650));
            if (!options.nemesis || Date.now() >= revokeAt) break;
            nemesisEvents++;
            if (rng.next() < 0.5) {
              history.info('nemesis', 'commit-cut', {});
              proxy.armCommitCut(1);
            } else {
              history.info('nemesis', 'reset-pg-sockets', {});
              proxy.resetConnections();
            }
          }

          // Revoke Avery's parent platform membership via Mistri's public maintenance API
          // (which atomically cascades closure to active support leases and appends to the audit chain)
          // while workers are actively racing to open support sessions!
          nemesisEvents++;
          history.info('nemesis', 'revoke-platform-membership', { accountId });
          await revokePlatformMembership({ postgres: dbUrl }, BINDING, {
            membershipId: 'platform-avery',
            expectedVersion: '1',
            operator: 'jepsen-nemesis',
          });
          revoked = true;
        };

        const workerCount = Math.max(2, Math.min(options.concurrency, 4));
        await Promise.all([nemesis(), ...Array.from({ length: workerCount }, (_, i) => worker(i))]);

        proxy.heal();
        // Verify Mistri's lease fence refuses resumption on EVERY session cookie after parent revocation.
        let leakedContextAfterRevoke = 0;
        for (const cookie of cookies) {
          const statusRes = await fetch(`${origin}/api/tenant/support/status?app=${APP_ID}`, {
            method: 'POST',
            signal: AbortSignal.timeout(5_000),
            headers: {
              origin,
              'content-type': 'application/json',
              cookie,
              [headers.account]: accountId,
            },
            body: JSON.stringify({ resume: true }),
          });
          const statusJson = (await statusRes.json().catch(() => ({}))) as { context?: unknown };
          if (statusJson.context !== undefined) leakedContextAfterRevoke++;
        }
        const finalActiveAfterRevoke = (await countActiveLeases()) + leakedContextAfterRevoke;
        const auditResult = await verifyPostgresSupportAudit(dbUrl, BINDING, key);
        const sessionRows = (await control.query(`SELECT COUNT(*) AS c FROM ${auditSessionTable}`)).rows as { c: string | number }[];
        const auditSessionsCount = Number(sessionRows[0]?.c ?? 0);

        const check = checkSupportLeases({
          openSucceeded,
          exitSucceeded,
          maxActiveObserved,
          finalActiveAfterRevoke,
          postRevokeOpenSucceeded,
          auditChainFailedCount: auditResult.failed.length,
          auditSessionsCount,
        });

        const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'support-lease-history')) : undefined;

        return {
          workload: 'support-lease',
          valid: check.valid,
          durationMs: Date.now() - startedAt,
          nemesisEvents,
          proxyStats: [{ node: 'support-pg-proxy', stats: proxy.stats() }],
          check,
          ...(historyFiles ? { historyFiles } : {}),
        };
      } finally {
        if (host) {
          host.server.closeAllConnections();
          await host.retire().catch(() => {});
        } else {
          auth?.close();
        }
        await proxy.close().catch(() => {});
      }
    });
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    for (const [k, v] of prevEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
