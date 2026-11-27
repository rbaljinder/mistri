/**
 * Jepsen Two-Host Durable Workflow Epoch Fencing & Step Idempotency workload.
 *
 * Topology:
 *  - One isolated PostgreSQL database provisioned with Mistri's workflow store.
 *  - Two independent `PgConnectionManager` + `openPostgresWorkflowStore` hosts
 *    (`host-a`, `host-b`) routed through two independent `FaultProxy` links.
 *
 * Behaviour under test:
 *  - Both hosts race to advance the same multi-step workflows simultaneously
 *    through Mistri's real `advanceWorkflow` engine.
 *  - Nemesis injects post-COMMIT TCP cuts, socket resets, host stalls/aborts,
 *    and latency spikes between steps and store writes.
 *  - An idempotency-keyed downstream command ledger records every non-deduplicated
 *    execution; verifies every workflow converges to `completed` with zero
 *    divergence and every step's side effect executes exactly once.
 */
import { join } from 'node:path';
import { PgConnectionManager } from '../../../packages/engine/src/adapters/postgresPool.js';
import { openPostgresWorkflowStore } from '../../../packages/mistri/src/adapters/workflows/postgresWorkflowStore.js';
import { migratePostgresWorkflowStore } from '../../../packages/mistri/src/adapters/workflows/workflowStoreSchema.js';
import { defineEvent } from '../../../packages/mistri/src/server/commands/businessEvents.js';
import { shape, text } from '../../../packages/mistri/src/server/commands/commandShapes.js';
import { advance } from '../../../packages/mistri/src/server/workflows/workflowEngine.js';
import { capturedWorkflows, defineWorkflow, defineWorkflows } from '../../../packages/mistri/src/server/workflows/workflowModule.js';
import { checkWorkflowFencing, type WorkflowFencingResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface WorkflowWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly workflowCount?: number;
  readonly outDir?: string;
}

export interface WorkflowWorkloadReport {
  readonly workload: 'workflow';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: WorkflowFencingResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const NAMESPACE = 'jepsen-workflows';
const OrderPlaced = defineEvent('order.placed', shape({ orderId: text() }));
const STEPS = ['reserve-stock', 'charge-card', 'dispatch-shipment'] as const;

const orderFlow = capturedWorkflows(
  defineWorkflows({
    fulfill: defineWorkflow({
      runAs: 'fulfillment',
      start: { event: OrderPlaced, key: (e) => e.orderId },
      async run(w, start: { orderId: string }) {
        const reserved = await w.run('reserve-stock', 'reserveStock', { target: start.orderId });
        const charged = await w.call('charge-card', 'payments', { path: '/charge', body: { orderId: start.orderId, reserved } });
        return await w.run('dispatch-shipment', 'dispatchShipment', { target: start.orderId, input: { charged } });
      },
    }),
  }),
)[0];

export async function runWorkflowFencingWorkload(options: WorkflowWorkloadOptions): Promise<WorkflowWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);
  const workflowCount = options.workflowCount ?? 12;

  return withIsolatedPostgresDb(options.pgUrl, 'workflow', async ({ dbUrl }) => {
    await migratePostgresWorkflowStore(dbUrl, NAMESPACE);

    const parsed = new URL(dbUrl);
    const pgHost = parsed.hostname || '127.0.0.1';
    const pgPort = Number(parsed.port || 5432);

    const proxies = [
      { name: 'host-a', proxy: new FaultProxy(pgHost, pgPort) },
      { name: 'host-b', proxy: new FaultProxy(pgHost, pgPort) },
    ];
    for (const item of proxies) await item.proxy.start();

    const managers = proxies.map((p) => new PgConnectionManager(p.proxy.proxiedUrl(dbUrl)));
    const stores = await Promise.all(managers.map((m) => openPostgresWorkflowStore(m, NAMESPACE)));
    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;

    try {
      const workflowIds: string[] = [];
      for (let i = 1; i <= workflowCount; i++) {
        const orderId = `order-${options.seed}-${i}`;
        const started = await stores[0].start(
          {
            workflow: 'fulfill',
            version: 1,
            key: orderId,
            eventId: `evt-${orderId}`,
            startJson: JSON.stringify({ orderId }),
          },
          Date.now(),
        );
        if (!started) throw new Error(`Failed to start workflow for ${orderId}`);
        workflowIds.push(started.id);
      }

      // Simulated idempotent downstream command/payment sink keyed by Mistri's step `idempotencyKey`.
      // Records non-deduplicated executions per `${instance}:${step}` AND verifies Mistri supplies
      // a stable idempotencyKey across retries/crashes for the same step.
      const seenIdempotencyKeys = new Map<string, { readonly instance: string; readonly step: string; readonly output: unknown }>();
      const sideEffectExecutions: Record<string, number> = {};

      const executeIdempotentStep = async (
        hostName: string,
        request: { readonly instance: string; readonly step: string; readonly idempotencyKey: string; readonly signal: AbortSignal },
      ) => {
        // Introduce realistic async latency so two hosts overlap in-flight and test epoch fencing.
        const jitter = rng.int(5, 35);
        await sleep(jitter);
        if (request.signal.aborted) throw new Error('aborted during step');

        const existing = seenIdempotencyKeys.get(request.idempotencyKey);
        if (existing) return existing.output;

        const effectKey = `${request.instance}:${request.step}`;
        sideEffectExecutions[effectKey] = (sideEffectExecutions[effectKey] ?? 0) + 1;
        const output = { ok: true, step: request.step, host: hostName, key: request.idempotencyKey };
        seenIdempotencyKeys.set(request.idempotencyKey, { instance: request.instance, step: request.step, output });
        return output;
      };

      const runAdvance = async (proc: number, hostIdx: number, instanceId: string, abortAfterMs?: number) => {
        const hostName = proxies[hostIdx].name;
        const controller = new AbortController();
        const timer = abortAfterMs !== undefined ? setTimeout(() => controller.abort(), abortAfterMs) : undefined;
        history.invoke(proc, 'advance', { host: hostName, instanceId });
        try {
          const outcome = await advance(
            {
              store: stores[hostIdx],
              workflow: orderFlow,
              now: Date.now,
              signal: controller.signal,
              budgetMs: 2_000,
              stepTimeoutMs: 2_000,
              runCommand: (req) => executeIdempotentStep(hostName, req),
              call: (req) => executeIdempotentStep(hostName, req),
            },
            instanceId,
          );
          history.ok(proc, 'advance', { host: hostName, instanceId, status: outcome.status });
        } catch (error) {
          history.info(proc, 'advance', { host: hostName, instanceId }, error instanceof Error ? error.message : String(error));
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      const stopAt = Date.now() + Math.min(options.durationSec, 10) * 1_000;

      const nemesisLoop = async () => {
        if (!options.nemesis) return;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(250);
          if (Date.now() >= stopAt) break;
          const target = proxies[round % proxies.length];
          const action = round % 3;
          round++;
          nemesisEvents++;
          if (action === 0) {
            history.info('nemesis', 'arm-commit-cut', { host: target.name });
            target.proxy.armCommitCut(1);
          } else if (action === 1) {
            history.info('nemesis', 'latency', { host: target.name, ms: 35 });
            target.proxy.setLatency(35, 20);
            await sleep(200);
            target.proxy.setLatency(0, 0);
          } else {
            const count = target.proxy.resetConnections();
            history.info('nemesis', 'tcp-reset', { host: target.name, sockets: count });
          }
        }
        for (const p of proxies) p.proxy.heal();
        history.info('nemesis', 'heal', { all: true });
      };

      // Phase 1: Chaotic concurrent multi-host racing (both hosts advance overlapping workflows with random aborts).
      const raceWorker = async (workerId: number) => {
        while (Date.now() < stopAt) {
          const wfId = rng.pick(workflowIds);
          const hostIdx = workerId % stores.length;
          // Occasionally abort mid-advance to simulate a host crash/lease expiry.
          const abortAfterMs = options.nemesis && rng.next() < 0.25 ? rng.int(10, 40) : undefined;
          await runAdvance(workerId, hostIdx, wfId, abortAfterMs);
        }
      };

      await Promise.all([nemesisLoop(), ...Array.from({ length: Math.max(2, options.concurrency) }, (_, i) => raceWorker(i))]);

      // Phase 2: Heal all faults and drive every workflow cleanly to terminal completion.
      for (const p of proxies) p.proxy.heal();
      await sleep(100);
      for (let pass = 0; pass < 10; pass++) {
        const listed = await stores[0].inspect({ workflow: 'fulfill' }, workflowCount + 10);
        const stateById = new Map(listed.map((row) => [row.id, row.state]));
        let pending = 0;
        for (const wfId of workflowIds) {
          const state = stateById.get(wfId);
          if (state && state !== 'completed' && state !== 'failed' && state !== 'diverged') {
            pending++;
            await runAdvance(0, pass % stores.length, wfId);
          }
        }
        if (pending === 0) break;
      }

      const finalListed = await stores[0].inspect({ workflow: 'fulfill' }, workflowCount + 10);
      const finalStateMap = new Map(finalListed.map((row) => [row.id, row.state]));
      const finalStatuses: Record<string, string> = {};
      for (const wfId of workflowIds) {
        finalStatuses[wfId] = finalStateMap.get(wfId) ?? 'missing';
      }

      const check = checkWorkflowFencing({
        expectedWorkflows: workflowIds,
        expectedStepsPerWorkflow: STEPS,
        finalStatuses,
        sideEffectExecutions,
        history: history.entries(),
      });

      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'workflow-history')) : undefined;
      return {
        workload: 'workflow',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        proxyStats: proxies.map((p) => ({ node: p.name, stats: p.proxy.stats() })),
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      for (const s of stores) await s.close().catch(() => {});
      for (const m of managers) await m.close().catch(() => {});
      for (const p of proxies) await p.proxy.close().catch(() => {});
    }
  });
}
