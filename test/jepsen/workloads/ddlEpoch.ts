/**
 * Jepsen Online Schema Migration (`DDL`) & Catalog-Epoch Invalidation workload.
 *
 * Topology:
 *  - Two independent Mistri `PostgresAdapter` hosts (`ddl-a`, `ddl-b`) behind
 *    `FaultProxy` links writing and reading row-scoped records while a DDL
 *    nemesis performs live schema changes (`ADD COLUMN`, `ADD CONSTRAINT`,
 *    `DROP CONSTRAINT`, trigger function updates) on the underlying table.
 *
 * Behaviour under test:
 *  - Mistri's catalog attestation and `forgetAttestations` / `suspectsStores`
 *    react safely to concurrent DDL without admitting constraint-violating
 *    rows, cross-tenant rows, or false-negative rollbacks.
 */
import { join } from 'node:path';
import { TransactionOutcomeUnknown, type Filter } from '../../../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../../../packages/engine/src/adapters/postgres.js';
import type { RowScope } from '../../../packages/engine/src/shared/rowScope.js';
import { checkDdlEpoch, type DdlEpochCheckResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface DdlEpochWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface DdlEpochWorkloadReport {
  readonly workload: 'ddl';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: DdlEpochCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const TENANTS = ['north', 'south'] as const;
const TABLE = 'public.ddl_item';
const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const scopeFor = (tenant: string): RowScope => ({ [TABLE]: eq('tenant', tenant) });

export async function runDdlEpochWorkload(options: DdlEpochWorkloadOptions): Promise<DdlEpochWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);

  return withIsolatedPostgresDb(options.pgUrl, 'ddl', async ({ dbUrl, control }) => {
    await control.query(`
      CREATE TABLE public.ddl_item (
        id integer PRIMARY KEY,
        tenant text NOT NULL,
        amount integer NOT NULL CHECK (amount >= 0),
        label text NOT NULL
      );
      INSERT INTO public.ddl_item (id, tenant, amount, label) VALUES
        (1, 'north', 10, 'seed-north'),
        (2, 'south', 20, 'seed-south');
    `);

    const parsed = new URL(dbUrl);
    const pgHost = parsed.hostname || '127.0.0.1';
    const pgPort = Number(parsed.port || 5432);

    const proxies = [
      { name: 'ddl-a', proxy: new FaultProxy(pgHost, pgPort) },
      { name: 'ddl-b', proxy: new FaultProxy(pgHost, pgPort) },
    ];
    for (const item of proxies) await item.proxy.start();

    const adapters = proxies.map(({ name, proxy }) => new PostgresAdapter(proxy.proxiedUrl(dbUrl), `jepsen-${name}`, ['public']));

    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;
    let ddlStepsExecuted = 0;

    try {
      for (const adapter of adapters) await adapter.introspect();
      let nextId = 10;
      const stopAt = Date.now() + options.durationSec * 1_000;

      const ddlNemesis = async () => {
        // Always execute live DDL steps even when --no-nemesis is off? Respect --nemesis for TCP faults,
        // while always executing the core online DDL mutations that this workload tests.
        const steps = [
          () => control.query(`ALTER TABLE public.ddl_item ADD COLUMN IF NOT EXISTS tag text DEFAULT 'v1'`),
          () => control.query(`ALTER TABLE public.ddl_item ADD CONSTRAINT ddl_amount_cap CHECK (amount <= 10000)`),
          () => control.query(`CREATE INDEX IF NOT EXISTS ddl_item_tenant_idx ON public.ddl_item (tenant)`),
          () => control.query(`ALTER TABLE public.ddl_item ADD COLUMN IF NOT EXISTS audit_note text`),
          () => control.query(`ALTER TABLE public.ddl_item DROP CONSTRAINT IF EXISTS ddl_amount_cap`),
          () => control.query(`ALTER TABLE public.ddl_item ADD CONSTRAINT ddl_amount_nonneg CHECK (amount >= 0)`),
        ];
        let stepIdx = 0;
        while (Date.now() < stopAt) {
          await sleep(450);
          if (Date.now() >= stopAt) break;
          if (stepIdx < steps.length) {
            try {
              await steps[stepIdx]();
              ddlStepsExecuted++;
              nemesisEvents++;
              history.info('nemesis', 'ddl-step', { step: stepIdx + 1 });
            } catch (error) {
              history.info('nemesis', 'ddl-step-error', { step: stepIdx + 1, error: String(error) });
            }
            stepIdx++;
          } else if (options.nemesis) {
            const target = proxies[nemesisEvents % proxies.length];
            nemesisEvents++;
            if (nemesisEvents % 2 === 0) {
              target.proxy.armCommitCut(1);
              history.info('nemesis', 'arm-commit-cut', { node: target.name });
            } else {
              const count = target.proxy.resetConnections();
              history.info('nemesis', 'tcp-reset', { node: target.name, sockets: count });
            }
          }
        }
        for (const p of proxies) p.proxy.heal();
      };

      const workerLoop = async (workerId: number) => {
        while (Date.now() < stopAt) {
          const adapter = adapters[rng.int(0, adapters.length)];
          const tenant = TENANTS[rng.int(0, TENANTS.length)];
          const id = nextId++;
          // Occasionally attempt an invalid negative amount (must ALWAYS be rejected by CHECK constraint).
          const amount = rng.next() < 0.15 ? -5 : rng.int(1, 500);
          history.invoke(workerId, 'ddl-write', { id, tenant, amount });
          try {
            await adapter.scopeTransaction(scopeFor(tenant), async (tx) => {
              await tx.insert({
                table: TABLE,
                values: { id, tenant, amount, label: `item-${id}` },
              });
            });
            history.ok(workerId, 'ddl-write', { id, tenant, amount, outcome: 'applied' });
          } catch (error) {
            if (error instanceof TransactionOutcomeUnknown) {
              history.info(workerId, 'ddl-write', { id, tenant, amount, outcome: 'unknown' }, error.message);
            } else {
              const pgCode = (error as { code?: unknown } | null)?.code;
              const definitive = typeof pgCode === 'string' && /^[24]/.test(pgCode);
              if (definitive) {
                history.fail(workerId, 'ddl-write', { id, tenant, amount, outcome: 'not_applied' }, pgCode);
              } else {
                history.info(
                  workerId,
                  'ddl-write',
                  { id, tenant, amount, outcome: 'unknown' },
                  error instanceof Error ? error.message : String(error),
                );
              }
            }
          }
          await sleep(rng.int(5, 25));
        }
      };

      await Promise.all([ddlNemesis(), ...Array.from({ length: options.concurrency }, (_, i) => workerLoop(i))]);

      for (const p of proxies) p.proxy.heal();
      await sleep(100);

      // Verify both hosts re-introspect and write cleanly after all online DDL changes settled.
      for (let i = 0; i < adapters.length; i++) {
        const id = nextId++;
        const tenant = TENANTS[i % TENANTS.length];
        history.invoke(0, 'ddl-write', { id, tenant, amount: 42 });
        await adapters[i].scopeTransaction(scopeFor(tenant), async (tx) => {
          await tx.insert({ table: TABLE, values: { id, tenant, amount: 42, label: `post-ddl-${i}` } });
        });
        history.ok(0, 'ddl-write', { id, tenant, amount: 42, outcome: 'applied' });
      }

      const rows = await control.query('SELECT id, tenant, amount FROM public.ddl_item ORDER BY id');
      const finalRows = rows.rows.map((r) => ({
        id: Number(r.id),
        tenant: String(r.tenant),
        amount: Number(r.amount),
      }));

      const check = checkDdlEpoch({
        history: history.entries(),
        finalRows,
        ddlStepsExecuted,
      });
      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'ddl-history')) : undefined;
      return {
        workload: 'ddl',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
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
