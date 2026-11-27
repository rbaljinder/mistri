/**
 * Jepsen Multi-Tenant Row Isolation & Connection-Pool Churn workload.
 *
 * Topology:
 *  - Three tenants (`alpha`, `beta`, `gamma`) sharing ONE isolated PostgreSQL
 *    database through a deliberately tight Mistri `PostgresAdapter` write pool
 *    (`writePool: 2`) routed behind a `FaultProxy`.
 *
 * Behaviour under test:
 *  - Concurrent workers run `PostgresAdapter.scopeTransaction` with per-tenant
 *    `RowScope` filters (`tenant = '<id>'`) and `WriteAhead` hints, inserting
 *    and reading tenant-owned records under heavy connection reuse.
 *  - Nemesis injects post-COMMIT TCP cuts, active-socket resets, and latency
 *    spikes to test connection destruction, fail-closed transaction cleanup,
 *    and `scopedTransact` outcome classification (`TransactionOutcomeUnknown`
 *    vs `not_applied`).
 *  - Verifies zero cross-tenant reads, zero cross-tenant writes, zero lost
 *    acknowledged writes, and zero false-negative rollbacks.
 */
import { join } from 'node:path';
import { TransactionOutcomeUnknown, type Filter } from '../../../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../../../packages/engine/src/adapters/postgres.js';
import { withWriteAhead } from '../../../packages/engine/src/adapters/writeAhead.js';
import type { RowScope } from '../../../packages/engine/src/shared/rowScope.js';
import { checkTenantIsolation, type TenantIsolationCheckResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface TenantWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface TenantWorkloadReport {
  readonly workload: 'tenant';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: TenantIsolationCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const TENANTS = ['alpha', 'beta', 'gamma'] as const;
const TABLE = 'public.tenant_record';

const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const scopeFor = (tenant: string): RowScope => ({ [TABLE]: eq('tenant', tenant) });

export async function runTenantIsolationWorkload(options: TenantWorkloadOptions): Promise<TenantWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);

  return withIsolatedPostgresDb(options.pgUrl, 'tenant', async ({ dbUrl, control }) => {
    await control.query(`
      CREATE TABLE public.tenant_record (
        id integer PRIMARY KEY,
        tenant text NOT NULL,
        writer_tenant text NOT NULL,
        seq integer NOT NULL,
        note text NOT NULL
      );
    `);

    // Seed one baseline record per tenant so reads & WriteAhead locks always have targets immediately.
    let nextId = 1;
    for (const tenant of TENANTS) {
      await control.query(`INSERT INTO public.tenant_record (id, tenant, writer_tenant, seq, note) VALUES ($1, $2, $3, 0, $4)`, [
        nextId++,
        tenant,
        tenant,
        `seed-${tenant}`,
      ]);
    }

    const parsed = new URL(dbUrl);
    const proxy = new FaultProxy(parsed.hostname || '127.0.0.1', Number(parsed.port || 5432));
    await proxy.start();

    // Constrained write pool (max 2 connections) forces heavy cross-tenant connection reuse.
    const adapter = new PostgresAdapter(proxy.proxiedUrl(dbUrl), 'jepsen-tenant', ['public'], undefined, {
      writers: 2,
      readers: 2,
    });

    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;

    try {
      await adapter.introspect();
      const seqByTenant: Record<string, number> = { alpha: 0, beta: 0, gamma: 0 };
      const stopAt = Date.now() + options.durationSec * 1_000;

      const nemesisLoop = async () => {
        if (!options.nemesis) return;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(350);
          if (Date.now() >= stopAt) break;
          const action = round % 3;
          round++;
          nemesisEvents++;
          if (action === 0) {
            proxy.armCommitCut(2);
            history.info('nemesis', 'arm-commit-cut', { count: 2 });
          } else if (action === 1) {
            proxy.setLatency(35, 20);
            history.info('nemesis', 'latency', { ms: 35 });
            await sleep(250);
            proxy.setLatency(0, 0);
          } else {
            const count = proxy.resetConnections();
            history.info('nemesis', 'tcp-reset', { sockets: count });
          }
        }
        proxy.heal();
        history.info('nemesis', 'heal', { all: true });
      };

      const workerLoop = async (workerId: number) => {
        while (Date.now() < stopAt) {
          const tenant = TENANTS[rng.int(0, TENANTS.length)];
          const scope = scopeFor(tenant);

          if (rng.next() < 0.4) {
            // Scoped read inside a tenant transaction (with WriteAhead hint on that tenant's seed row).
            const seedId = TENANTS.indexOf(tenant) + 1;
            history.invoke(workerId, 'scoped-read', { tenant });
            try {
              const observedTenants: string[] = [];
              await withWriteAhead({ targets: [{ table: TABLE, key: { id: seedId } }], writes: false }, () =>
                adapter.scopeTransaction(scope, async (tx) => {
                  const res = await tx.query({ table: TABLE, limit: 200, offset: 0 });
                  for (const row of res.rows) observedTenants.push(String(row.tenant));
                }),
              );
              history.ok(workerId, 'scoped-read', { tenant, observedTenants, rowCount: observedTenants.length });
            } catch (error) {
              history.info(workerId, 'scoped-read', { tenant }, error instanceof Error ? error.message : String(error));
            }
          } else {
            // Scoped write: insert a new record for `tenant` and read back inside the same scoped transaction.
            const id = nextId++;
            const seq = ++seqByTenant[tenant];
            history.invoke(workerId, 'scoped-write', { tenant, id, seq });
            try {
              await adapter.scopeTransaction(scope, async (tx) => {
                await tx.insert({
                  table: TABLE,
                  values: {
                    id,
                    tenant,
                    writer_tenant: tenant,
                    seq,
                    note: `${tenant}-seq-${seq}`,
                  },
                });
              });
              history.ok(workerId, 'scoped-write', { tenant, id, seq, outcome: 'applied' });
            } catch (error) {
              if (error instanceof TransactionOutcomeUnknown) {
                history.info(workerId, 'scoped-write', { tenant, id, seq, outcome: 'unknown' }, error.message);
              } else {
                // Any non-unknown error from scopeTransaction could still be connection drop before COMMIT;
                // only treat explicit PG refusal/validation errors as definitive not_applied.
                const pgCode = (error as { code?: unknown } | null)?.code;
                const definitive = typeof pgCode === 'string' && /^[24]/.test(pgCode);
                if (definitive) {
                  history.fail(workerId, 'scoped-write', { tenant, id, seq, outcome: 'not_applied' }, pgCode);
                } else {
                  history.info(
                    workerId,
                    'scoped-write',
                    { tenant, id, seq, outcome: 'unknown' },
                    error instanceof Error ? error.message : String(error),
                  );
                }
              }
            }
          }
        }
      };

      await Promise.all([nemesisLoop(), ...Array.from({ length: options.concurrency }, (_, i) => workerLoop(i))]);

      // Heal proxy and run a final scoped read audit for every tenant.
      proxy.heal();
      await sleep(100);
      for (const tenant of TENANTS) {
        history.invoke(0, 'scoped-read', { tenant });
        const observedTenants: string[] = [];
        await adapter.scopeTransaction(scopeFor(tenant), async (tx) => {
          const res = await tx.query({ table: TABLE, limit: 1000, offset: 0 });
          for (const row of res.rows) observedTenants.push(String(row.tenant));
        });
        history.ok(0, 'scoped-read', { tenant, observedTenants, rowCount: observedTenants.length });
      }

      // Ground-truth DB audit across all tenants.
      const rows = await control.query('SELECT id, tenant, writer_tenant, seq FROM public.tenant_record ORDER BY id');
      const finalRows = rows.rows.map((r) => ({
        id: Number(r.id),
        tenant: String(r.tenant),
        writerTenant: String(r.writer_tenant),
        seq: Number(r.seq),
      }));

      const check = checkTenantIsolation({
        tenants: TENANTS,
        history: history.entries(),
        finalRows,
      });
      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'tenant-history')) : undefined;
      return {
        workload: 'tenant',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        proxyStats: [{ node: 'shared-pool', stats: proxy.stats() }],
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      await adapter.close().catch(() => {});
      await proxy.close().catch(() => {});
    }
  });
}
