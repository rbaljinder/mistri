/**
 * Jepsen PgBouncer Transaction-Mode Pooling Chaos workload.
 *
 * Topology:
 *  - Creates an isolated PostgreSQL database on `pgUrl`, then routes two
 *    independent Mistri `PostgresAdapter` pools configured with
 *    `pooler: 'transaction'` (`postgresPooler.ts`) through `FaultProxy` →
 *    live PgBouncer (`pool_mode = transaction`, `DEFAULT_POOL_SIZE = 6`).
 *
 * Behaviour under test:
 *  - Three tenants (`alpha`, `beta`, `gamma`) heavily multiplex over shared
 *    PgBouncer server connections using `scopeTransaction`, `WriteAhead`, and
 *    read-only queries (`SET LOCAL` / `SET TRANSACTION READ ONLY` per txn).
 *  - Nemesis injects post-COMMIT TCP cuts, TCP resets, and latency spikes on
 *    the PgBouncer links to catch session-state leakage, open-transaction
 *    poisoning, prepared-statement clashes, or false-negative rollbacks.
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

export interface PgBouncerWorkloadOptions {
  readonly pgUrl: string;
  readonly pgbouncerUrl?: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface PgBouncerWorkloadReport {
  readonly workload: 'pgbouncer';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly usedPgBouncer: boolean;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: TenantIsolationCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const TENANTS = ['alpha', 'beta', 'gamma'] as const;
const TABLE = 'public.pooled_record';

const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const scopeFor = (tenant: string): RowScope => ({ [TABLE]: eq('tenant', tenant) });

export async function runPgBouncerWorkload(options: PgBouncerWorkloadOptions): Promise<PgBouncerWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);

  return withIsolatedPostgresDb(options.pgUrl, 'pgbouncer', async ({ dbUrl, dbName, control }) => {
    await control.query(`
      CREATE TABLE public.pooled_record (
        id integer PRIMARY KEY,
        tenant text NOT NULL,
        writer_tenant text NOT NULL,
        seq integer NOT NULL,
        note text NOT NULL
      );
    `);

    let nextId = 1;
    for (const tenant of TENANTS) {
      await control.query(`INSERT INTO public.pooled_record (id, tenant, writer_tenant, seq, note) VALUES ($1, $2, $3, 0, $4)`, [
        nextId++,
        tenant,
        tenant,
        `seed-${tenant}`,
      ]);
    }

    // Route through live PgBouncer if configured; otherwise exercise Mistri's `pooler: 'transaction'` path directly.
    let targetUrl = dbUrl;
    let usedPgBouncer = false;
    if (options.pgbouncerUrl) {
      const bouncer = new URL(options.pgbouncerUrl);
      bouncer.pathname = `/${dbName}`;
      targetUrl = bouncer.href;
      usedPgBouncer = true;
    }

    const parsed = new URL(targetUrl);
    const host = parsed.hostname || '127.0.0.1';
    const port = Number(parsed.port || 5432);

    const proxies = [
      { name: 'pooler-a', proxy: new FaultProxy(host, port) },
      { name: 'pooler-b', proxy: new FaultProxy(host, port) },
    ];
    for (const item of proxies) await item.proxy.start();

    const adapters = proxies.map(
      ({ name, proxy }) =>
        new PostgresAdapter(proxy.proxiedUrl(targetUrl), `jepsen-${name}`, ['public'], undefined, {
          pooler: 'transaction',
          writers: 4,
          readers: 4,
        }),
    );

    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;

    try {
      for (const adapter of adapters) await adapter.introspect();
      const seqByTenant: Record<string, number> = { alpha: 0, beta: 0, gamma: 0 };
      const stopAt = Date.now() + options.durationSec * 1_000;

      const nemesisLoop = async () => {
        if (!options.nemesis) return;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(350);
          if (Date.now() >= stopAt) break;
          const target = proxies[round % proxies.length];
          const action = round % 3;
          round++;
          nemesisEvents++;
          if (action === 0) {
            target.proxy.armCommitCut(2);
            history.info('nemesis', 'arm-commit-cut', { node: target.name, count: 2 });
          } else if (action === 1) {
            target.proxy.setLatency(30, 15);
            history.info('nemesis', 'latency', { node: target.name, ms: 30 });
            await sleep(250);
            target.proxy.setLatency(0, 0);
          } else {
            const count = target.proxy.resetConnections();
            history.info('nemesis', 'tcp-reset', { node: target.name, sockets: count });
          }
        }
        for (const p of proxies) p.proxy.heal();
        history.info('nemesis', 'heal', { all: true });
      };

      const workerLoop = async (workerId: number) => {
        while (Date.now() < stopAt) {
          const adapter = adapters[rng.int(0, adapters.length)];
          const tenant = TENANTS[rng.int(0, TENANTS.length)];
          const scope = scopeFor(tenant);

          if (rng.next() < 0.45) {
            const seedId = TENANTS.indexOf(tenant) + 1;
            history.invoke(workerId, 'scoped-read', { tenant });
            try {
              const observedTenants: string[] = [];
              await withWriteAhead({ targets: [{ table: TABLE, key: { id: seedId } }], writes: false }, () =>
                adapter.scopeTransaction(scope, async (tx) => {
                  const res = await tx.query({ table: TABLE, limit: 250, offset: 0 });
                  for (const row of res.rows) observedTenants.push(String(row.tenant));
                }),
              );
              history.ok(workerId, 'scoped-read', { tenant, observedTenants, rowCount: observedTenants.length });
            } catch (error) {
              history.info(workerId, 'scoped-read', { tenant }, error instanceof Error ? error.message : String(error));
            }
          } else {
            const id = nextId++;
            const seq = ++seqByTenant[tenant];
            history.invoke(workerId, 'scoped-write', { tenant, id, seq });
            try {
              await adapter.scopeTransaction(scope, async (tx) => {
                await tx.insert({
                  table: TABLE,
                  values: { id, tenant, writer_tenant: tenant, seq, note: `pooled-${tenant}-${seq}` },
                });
              });
              history.ok(workerId, 'scoped-write', { tenant, id, seq, outcome: 'applied' });
            } catch (error) {
              if (error instanceof TransactionOutcomeUnknown) {
                history.info(workerId, 'scoped-write', { tenant, id, seq, outcome: 'unknown' }, error.message);
              } else {
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

      for (const p of proxies) p.proxy.heal();
      await sleep(100);
      for (const tenant of TENANTS) {
        history.invoke(0, 'scoped-read', { tenant });
        const observedTenants: string[] = [];
        await adapters[0].scopeTransaction(scopeFor(tenant), async (tx) => {
          const res = await tx.query({ table: TABLE, limit: 1000, offset: 0 });
          for (const row of res.rows) observedTenants.push(String(row.tenant));
        });
        history.ok(0, 'scoped-read', { tenant, observedTenants, rowCount: observedTenants.length });
      }

      const rows = await control.query('SELECT id, tenant, writer_tenant, seq FROM public.pooled_record ORDER BY id');
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
      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'pgbouncer-history')) : undefined;
      return {
        workload: 'pgbouncer',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        usedPgBouncer,
        proxyStats: proxies.map((p) => ({ node: p.name, stats: p.proxy.stats() })),
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      for (const adapter of adapters) await adapter.close().catch(() => {});
      for (const item of proxies) await item.proxy.close().catch(() => {});
    }
  });
}
