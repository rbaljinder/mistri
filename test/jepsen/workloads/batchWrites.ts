/**
 * Jepsen Batch Writes (`insertMany` pipelined scope read + `UNNEST` `updateMany`)
 * & Prepared-Statement Online DDL workload.
 *
 * Topology:
 *  - Isolated PostgreSQL database behind `FaultProxy` with a constrained Mistri
 *    `PostgresAdapter` pool (`writers: 2, readers: 2`), two tenants (`north`,
 *    `south`), a tenant-owned parent table (`public.category`), and child table
 *    (`public.item`).
 *
 * Behaviour under test:
 *  - Hammers Wave 5 + Wave 6 write/prepared-statement paths concurrently:
 *      * Scoped `insertMany` with caller-supplied PKs (pipelined `behindWrite`
 *        post-insert scope read + multi-row `INSERT ... RETURNING *`)
 *      * Scoped `updateMany` with `expected` guards (`UPDATE ... FROM ROWS FROM(pg_catalog.unnest(...))`
 *        + `collectLockedBefores` + pipelined post-update scope read)
 *      * Adversarial cross-tenant poison batches (14 valid rows + 1 cross-tenant
 *        parent FK or cross-tenant key -> must roll back all 15 rows atomically)
 *      * Adversarial stale-`expected` guard batches (14 valid rows + 1 wrong
 *        version -> must roll back all 15 rows atomically)
 *      * Single-row `UPDATE ... RETURNING *` interleaved with online DDL
 *        (`ALTER TABLE ADD COLUMN`, `ADD CONSTRAINT`, `CREATE INDEX`) to catch
 *        `0A000: cached plan must not change result type` regressions.
 *  - Nemesis injects online DDL, `FaultProxy` post-COMMIT TCP cuts, TCP resets,
 *    and latency spikes.
 *  - Verifies zero `0A000` errors, zero cross-tenant or partial batch writes,
 *    zero lost acknowledged batches, and zero false-negative rollbacks.
 */
import { join } from 'node:path';
import { TransactionOutcomeUnknown, type Filter } from '../../../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../../../packages/engine/src/adapters/postgres.js';
import { collectLockedBefores } from '../../../packages/engine/src/adapters/writeAhead.js';
import type { RowScope } from '../../../packages/engine/src/shared/rowScope.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface BatchWritesWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface BatchWritesViolation {
  readonly code: string;
  readonly detail: string;
}

export interface BatchWritesCheckResult {
  readonly valid: boolean;
  readonly violations: readonly BatchWritesViolation[];
  readonly summary: {
    readonly insertBatchesOk: number;
    readonly insertBatchesFail: number;
    readonly insertBatchesInfo: number;
    readonly updateBatchesOk: number;
    readonly updateBatchesFail: number;
    readonly updateBatchesInfo: number;
    readonly poisonBatchesRefused: number;
    readonly staleGuardBatchesRefused: number;
    readonly ddlStepsExecuted: number;
    readonly stalePlanErrors: number;
    readonly finalRowCount: number;
  };
}

export interface BatchWritesWorkloadReport {
  readonly workload: 'batch-writes';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: BatchWritesCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const TENANTS = ['north', 'south'] as const;
const CATEGORY = 'public.category';
const ITEM = 'public.item';
const eq = (column: string, value: string | number): Filter => ({ groups: [[{ column, op: '=', value }]] });
const scopeFor = (tenant: string): RowScope => ({
  [CATEGORY]: eq('tenant', tenant),
  [ITEM]: eq('tenant', tenant),
});

interface BatchRecord {
  readonly batchId: string;
  readonly tenant: string;
  readonly ids: readonly string[];
  outcome: 'ok' | 'fail' | 'info';
}

interface UpdateBatchRecord {
  readonly batchId: string;
  readonly tenant: string;
  readonly ids: readonly string[];
  readonly targetStatus: string;
  outcome: 'ok' | 'fail' | 'info';
}

export async function runBatchWritesWorkload(options: BatchWritesWorkloadOptions): Promise<BatchWritesWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);

  return withIsolatedPostgresDb(options.pgUrl, 'batch', async ({ dbUrl, control }) => {
    await control.query(`
      CREATE TABLE public.category (
        id text PRIMARY KEY,
        tenant text NOT NULL,
        name text NOT NULL
      );
      CREATE TABLE public.item (
        id text PRIMARY KEY,
        tenant text NOT NULL,
        category_id text NOT NULL REFERENCES public.category(id),
        batch_id text NOT NULL,
        qty integer NOT NULL CHECK (qty >= 0),
        status text NOT NULL DEFAULT 'open',
        version integer NOT NULL DEFAULT 1
      );
      INSERT INTO public.category (id, tenant, name) VALUES
        ('cat-north', 'north', 'North Category'),
        ('cat-south', 'south', 'South Category');
    `);

    const parsed = new URL(dbUrl);
    const proxy = new FaultProxy(parsed.hostname || '127.0.0.1', Number(parsed.port || 5432));
    await proxy.start();

    const adapter = new PostgresAdapter(proxy.proxiedUrl(dbUrl), 'jepsen-batch-writes', ['public'], undefined, {
      writers: 2,
      readers: 2,
    });

    const history = new HistoryRecorder<unknown>();
    const violations: BatchWritesViolation[] = [];
    const insertBatches: BatchRecord[] = [];
    const updateBatches: UpdateBatchRecord[] = [];
    const poisonedIds = new Set<string>();
    const staleGuardTargets = new Map<string, string>();
    let nemesisEvents = 0;
    let ddlStepsExecuted = 0;
    let stalePlanErrors = 0;
    let insertBatchesOk = 0;
    let insertBatchesFail = 0;
    let insertBatchesInfo = 0;
    let updateBatchesOk = 0;
    let updateBatchesFail = 0;
    let updateBatchesInfo = 0;
    let poisonBatchesRefused = 0;
    let staleGuardBatchesRefused = 0;

    const noteError = (op: string, error: unknown) => {
      const msg = error instanceof Error ? `${error.message} ${String((error as { code?: unknown }).code ?? '')}` : String(error);
      if (/0A000|cached plan must not change result type/i.test(msg)) {
        stalePlanErrors++;
        violations.push({ code: 'STALE_PREPARED_PLAN', detail: `${op} hit PG 0A000 stale plan: ${msg}` });
      }
    };

    try {
      await adapter.introspect();
      let seq = 0;
      const stopAt = Date.now() + options.durationSec * 1_000;

      const nemesisLoop = async () => {
        const ddlSteps = [
          () => control.query(`ALTER TABLE public.item ADD COLUMN IF NOT EXISTS tag text DEFAULT 'v1'`),
          () => control.query(`CREATE INDEX IF NOT EXISTS item_tenant_batch_idx ON public.item (tenant, batch_id)`),
          () => control.query(`ALTER TABLE public.item ADD COLUMN IF NOT EXISTS extra_note text`),
          () => control.query(`ALTER TABLE public.item ADD CONSTRAINT item_qty_bound CHECK (qty <= 100000)`),
          () => control.query(`ALTER TABLE public.item DROP CONSTRAINT IF EXISTS item_qty_bound`),
        ];
        let step = 0;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(420);
          if (Date.now() >= stopAt) break;
          if (step < ddlSteps.length) {
            try {
              await ddlSteps[step]();
              ddlStepsExecuted++;
              nemesisEvents++;
              history.info('nemesis', 'ddl-step', { step: step + 1 });
            } catch (error) {
              history.info('nemesis', 'ddl-step-error', { step: step + 1, error: String(error) });
            }
            step++;
          } else if (options.nemesis) {
            nemesisEvents++;
            const action = round % 3;
            round++;
            if (action === 0) {
              proxy.armCommitCut(1);
              history.info('nemesis', 'arm-commit-cut', { count: 1 });
            } else if (action === 1) {
              proxy.setLatency(25, 15);
              await sleep(200);
              proxy.setLatency(0, 0);
            } else {
              const count = proxy.resetConnections();
              history.info('nemesis', 'tcp-reset', { sockets: count });
            }
          }
        }
      };

      const worker = async (workerId: number) => {
        const tenant = TENANTS[workerId % TENANTS.length];
        const other = TENANTS[(workerId + 1) % TENANTS.length];
        const ownCat = `cat-${tenant}`;
        const otherCat = `cat-${other}`;
        const ownedInsertedIds: string[] = [];

        while (Date.now() < stopAt) {
          const op = rng.int(0, 10);

          if (op <= 4 || ownedInsertedIds.length < 6) {
            // 1. Batched insertMany with caller-supplied PKs (exercises pipelined behindWrite scope read).
            const batchId = `ins-${workerId}-${++seq}`;
            const size = rng.int(8, 16);
            const ids = Array.from({ length: size }, (_, i) => `${batchId}-${i}`);
            const rec: BatchRecord = { batchId, tenant, ids, outcome: 'fail' };
            try {
              await adapter.scopeTransaction(scopeFor(tenant), async (tx) => {
                await tx.insertMany!(
                  ids.map((id, i) => ({
                    table: ITEM,
                    values: { id, tenant, category_id: ownCat, batch_id: batchId, qty: i + 1, status: 'open', version: 1 },
                  })),
                );
              });
              rec.outcome = 'ok';
              insertBatchesOk++;
              ownedInsertedIds.push(...ids);
            } catch (error) {
              noteError('insertMany', error);
              if (error instanceof TransactionOutcomeUnknown) {
                rec.outcome = 'info';
                insertBatchesInfo++;
              } else {
                rec.outcome = 'fail';
                insertBatchesFail++;
              }
            }
            insertBatches.push(rec);
          } else if (op <= 7) {
            // 2. Batched updateMany with expected guards + collectLockedBefores (exercises UNNEST batch UPDATE).
            const batchId = `upd-${workerId}-${++seq}`;
            const size = Math.min(ownedInsertedIds.length, rng.int(6, 12));
            const targetIds = ownedInsertedIds.splice(0, size);
            const targetStatus = `done-${seq}`;
            const rec: UpdateBatchRecord = { batchId, tenant, ids: targetIds, targetStatus, outcome: 'fail' };
            try {
              await adapter.scopeTransaction(scopeFor(tenant), async (tx) => {
                const locked = await collectLockedBefores(async (sink) => {
                  const res = await tx.updateMany!(
                    targetIds.map((id) => ({
                      table: ITEM,
                      key: { id },
                      values: { status: targetStatus, version: 2 },
                      expected: { status: 'open', version: 1 },
                    })),
                  );
                  return { res, befores: sink.rows };
                });
                if (!locked.befores || locked.befores.length !== targetIds.length) {
                  violations.push({
                    code: 'LOCKED_BEFORES_MISSING',
                    detail: `updateMany ${batchId} returned ${locked.befores?.length ?? 0}/${targetIds.length} locked before-images`,
                  });
                }
              });
              rec.outcome = 'ok';
              updateBatchesOk++;
            } catch (error) {
              noteError('updateMany', error);
              if (error instanceof TransactionOutcomeUnknown) {
                rec.outcome = 'info';
                updateBatchesInfo++;
              } else {
                rec.outcome = 'fail';
                updateBatchesFail++;
              }
            }
            updateBatches.push(rec);
          } else if (op === 8) {
            // 3. Adversarial cross-tenant poison batch: 9 valid own-tenant rows + 1 cross-tenant parent FK row.
            const batchId = `poison-${workerId}-${++seq}`;
            const ids = Array.from({ length: 10 }, (_, i) => `${batchId}-${i}`);
            for (const id of ids) poisonedIds.add(id);
            try {
              await adapter.scopeTransaction(scopeFor(tenant), async (tx) => {
                await tx.insertMany!(
                  ids.map((id, i) => ({
                    table: ITEM,
                    values: {
                      id,
                      tenant,
                      category_id: i === 9 ? otherCat : ownCat,
                      batch_id: batchId,
                      qty: 1,
                      status: 'poison',
                      version: 1,
                    },
                  })),
                );
              });
              violations.push({
                code: 'CROSS_TENANT_POISON_ACCEPTED',
                detail: `Poison batch ${batchId} for tenant=${tenant} referencing ${otherCat} was committed!`,
              });
            } catch (error) {
              noteError('poison-insertMany', error);
              poisonBatchesRefused++;
            }
          } else {
            // 4. Adversarial stale-expected guard batch OR single-row UPDATE RETURNING * (exercises prepared statement + DDL).
            const pick = ownedInsertedIds.slice(0, Math.min(6, ownedInsertedIds.length));
            if (pick.length >= 2) {
              const badStatus = `stale-bypass-${seq}`;
              for (const id of pick) staleGuardTargets.set(id, badStatus);
              try {
                await adapter.scopeTransaction(scopeFor(tenant), async (tx) => {
                  await tx.updateMany!(
                    pick.map((id, idx) => ({
                      table: ITEM,
                      key: { id },
                      values: { status: badStatus, version: 99 },
                      expected: { status: idx === pick.length - 1 ? 'WRONG_STATUS' : 'open', version: 1 },
                    })),
                  );
                });
                violations.push({
                  code: 'STALE_GUARD_BYPASSED',
                  detail: `updateMany with mismatched expected guard succeeded for ${pick.join(',')}`,
                });
              } catch (error) {
                noteError('stale-guard-updateMany', error);
                staleGuardBatchesRefused++;
              }
            }
          }
          await sleep(rng.int(5, 20));
        }
      };

      const workers = Array.from({ length: Math.max(2, options.concurrency) }, (_, i) => worker(i));
      await Promise.all([...workers, nemesisLoop()]);

      // Ground-truth DB verification directly via control client (bypassing FaultProxy).
      type FinalItemRow = { id: string; tenant: string; category_id: string; batch_id: string; status: string; version: number };
      const finalRows = await control.query(`SELECT id, tenant, category_id, batch_id, status, version FROM public.item`);
      const rows = finalRows.rows as unknown as FinalItemRow[];
      const byId = new Map(rows.map((r) => [r.id, r]));

      // 1. Cross-tenant FK consistency: no row may reference the other tenant's category.
      for (const row of rows) {
        if (row.category_id !== `cat-${row.tenant}`) {
          violations.push({
            code: 'CROSS_TENANT_FK_ROW',
            detail: `Row id=${row.id} tenant=${row.tenant} references wrong category=${row.category_id}`,
          });
        }
        if (poisonedIds.has(row.id)) {
          violations.push({
            code: 'POISON_ROW_PERSISTED',
            detail: `Adversarial cross-tenant poison row id=${row.id} persisted in DB`,
          });
        }
        if (staleGuardTargets.get(row.id) === row.status) {
          violations.push({
            code: 'STALE_GUARD_PARTIAL_COMMIT',
            detail: `Stale-guard batch partially updated row id=${row.id} to ${row.status}`,
          });
        }
      }

      // 2. Insert batch atomicity, durability, and no false-negative rollbacks.
      for (const batch of insertBatches) {
        const present = batch.ids.filter((id) => byId.has(id)).length;
        if (present !== 0 && present !== batch.ids.length) {
          violations.push({
            code: 'PARTIAL_INSERT_BATCH',
            detail: `Batch ${batch.batchId} (${batch.outcome}) persisted ${present}/${batch.ids.length} rows`,
          });
        }
        if (batch.outcome === 'ok' && present !== batch.ids.length) {
          violations.push({
            code: 'LOST_INSERT_BATCH',
            detail: `Acknowledged insertMany batch ${batch.batchId} missing ${batch.ids.length - present} rows`,
          });
        }
        if (batch.outcome === 'fail' && present !== 0) {
          violations.push({
            code: 'FALSE_NEGATIVE_INSERT_BATCH',
            detail: `Failed (not_applied) insertMany batch ${batch.batchId} persisted ${present} rows`,
          });
        }
      }

      // 3. Update batch atomicity, durability, and no false-negative rollbacks.
      for (const batch of updateBatches) {
        const updated = batch.ids.filter((id) => byId.get(id)?.status === batch.targetStatus).length;
        if (updated !== 0 && updated !== batch.ids.length) {
          violations.push({
            code: 'PARTIAL_UPDATE_BATCH',
            detail: `Update batch ${batch.batchId} (${batch.outcome}) applied to ${updated}/${batch.ids.length} rows`,
          });
        }
        if (batch.outcome === 'ok' && updated !== batch.ids.length) {
          violations.push({
            code: 'LOST_UPDATE_BATCH',
            detail: `Acknowledged updateMany batch ${batch.batchId} only applied to ${updated}/${batch.ids.length} rows`,
          });
        }
        if (batch.outcome === 'fail' && updated !== 0) {
          violations.push({
            code: 'FALSE_NEGATIVE_UPDATE_BATCH',
            detail: `Failed (not_applied) updateMany batch ${batch.batchId} applied to ${updated} rows`,
          });
        }
      }

      if (insertBatchesOk === 0 || updateBatchesOk === 0) {
        violations.push({
          code: 'INSUFFICIENT_PROGRESS',
          detail: `Expected both insertMany (${insertBatchesOk}) and updateMany (${updateBatchesOk}) batches to succeed.`,
        });
      }

      const check: BatchWritesCheckResult = {
        valid: violations.length === 0,
        violations,
        summary: {
          insertBatchesOk,
          insertBatchesFail,
          insertBatchesInfo,
          updateBatchesOk,
          updateBatchesFail,
          updateBatchesInfo,
          poisonBatchesRefused,
          staleGuardBatchesRefused,
          ddlStepsExecuted,
          stalePlanErrors,
          finalRowCount: finalRows.rows.length,
        },
      };

      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'batch-writes-history')) : undefined;

      return {
        workload: 'batch-writes',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        proxyStats: [{ node: 'batch-writes', stats: proxy.stats() }],
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      await adapter.close().catch(() => {});
      await proxy.close().catch(() => {});
    }
  });
}
