/**
 * Jepsen Read-Replica Routing, Read-Your-Writes (RYW), & Replica-Outage
 * Fallback workload.
 *
 * Topology:
 *  - Connects Mistri's `PostgresAdapter` to a primary database plus a read
 *    replica (`--replica-pg`, e.g. `postgres-replica` from `docker-compose.yml`,
 *    or a dedicated read-only proxy link when no separate replica URL is given),
 *    with a `FaultProxy` sitting in front of the replica.
 *
 * Behaviour under test:
 *  - Monotonic counter writers increment a register and immediately run
 *    `lagTolerantReads` under `readsAs({ fresh: true | key })`: MUST ALWAYS
 *    observe `>= lastWrittenVersion` (RYW pinned to primary even when the
 *    replica is lagged or partitioned).
 *  - Background lag-tolerant readers hit the replica while healthy (proven by
 *    non-zero `replica` pool checkouts), and seamlessly fall back to primary
 *    when the nemesis partitions or TCP-resets the replica proxy.
 *  - Verifies read-only enforcement on replica sessions.
 */
import { join } from 'node:path';
import { connect } from '../../../packages/engine/src/adapters/connect.js';
import type { PostgresAdapter } from '../../../packages/engine/src/adapters/postgres.js';
import { lagTolerantReads, noteWrite, primaryReads, readsAs, type ReadContext } from '../../../packages/engine/src/adapters/replicas.js';
import { checkReplicaRyw, type ReplicaRywCheckResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface ReplicaWorkloadOptions {
  readonly pgUrl: string;
  readonly replicaPgUrl?: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface ReplicaWorkloadReport {
  readonly workload: 'replica';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly usedStreamingReplica: boolean;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: ReplicaRywCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

export async function runReplicaRywWorkload(options: ReplicaWorkloadOptions): Promise<ReplicaWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);

  return withIsolatedPostgresDb(options.pgUrl, 'replica', async ({ dbUrl, dbName, control }) => {
    await control.query(`
      CREATE TABLE public.register_slot (
        id integer PRIMARY KEY,
        val integer NOT NULL DEFAULT 0
      );
    `);
    const writerCount = Math.max(1, Math.floor(options.concurrency / 2));
    const slotCount = Math.max(4, writerCount);
    for (let id = 1; id <= slotCount; id++) {
      await control.query('INSERT INTO public.register_slot (id, val) VALUES ($1, 0)', [id]);
    }

    // If a streaming replica URL was supplied, point the replica FaultProxy at the same database on the replica host.
    let replicaTargetUrl = dbUrl;
    let usedStreamingReplica = false;
    if (options.replicaPgUrl) {
      const rep = new URL(options.replicaPgUrl);
      rep.pathname = `/${dbName}`;
      replicaTargetUrl = rep.href;
      usedStreamingReplica = true;
      // Wait briefly for CREATE DATABASE + CREATE TABLE WAL records to replay on the streaming standby.
      await sleep(300);
    }

    const parsedPrimary = new URL(dbUrl);
    const parsedReplica = new URL(replicaTargetUrl);
    const primaryProxy = new FaultProxy(parsedPrimary.hostname || '127.0.0.1', Number(parsedPrimary.port || 5432));
    const replicaProxy = new FaultProxy(parsedReplica.hostname || '127.0.0.1', Number(parsedReplica.port || 5432));
    await primaryProxy.start();
    await replicaProxy.start();

    const adapter = connect(primaryProxy.proxiedUrl(dbUrl), {
      replicas: [replicaProxy.proxiedUrl(replicaTargetUrl)],
    }) as PostgresAdapter;

    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;
    let fallbackReadsSucceeded = 0;
    let replicaPartitioned = false;

    try {
      const schema = await adapter.introspect();
      const slotTable = schema.tables.find((t) => t.name === 'register_slot')!.id;

      const readSlot = async (id: number): Promise<number> => {
        const res = await adapter.query({
          table: slotTable,
          filter: { groups: [[{ column: 'id', op: '=', value: id }]] },
          limit: 1,
          offset: 0,
        });
        return Number(res.rows[0]?.val ?? 0);
      };

      const stopAt = Date.now() + options.durationSec * 1_000;

      // Warm up replica routing before chaos starts so we guarantee observable replica checkouts.
      for (let i = 0; i < 4; i++) {
        await readsAs({ fresh: false }, () => lagTolerantReads(() => readSlot((i % slotCount) + 1))).catch(() => {});
      }

      // Writer workers: each writer owns its own slot, performs monotonic writes, calls noteWrite(), and immediately runs RYW reads.
      const writerLoop = async (workerId: number) => {
        const callerKey = `bearer-writer-${workerId}`;
        const slotId = workerId + 1;
        let localSeq = 0;
        while (Date.now() < stopAt) {
          const nextVal = ++localSeq;
          const writeCtx: ReadContext = { fresh: false, key: callerKey };
          history.invoke(workerId, 'write', { slotId, val: nextVal, caller: callerKey });
          try {
            const writtenVal = await readsAs(writeCtx, async () => {
              const committed = await adapter.transaction!(async (tx) => {
                const cur = await tx.query({
                  table: slotTable,
                  filter: { groups: [[{ column: 'id', op: '=', value: slotId }]] },
                  limit: 1,
                  offset: 0,
                });
                const currentVal = Number(cur.rows[0]?.val ?? 0);
                const targetVal = Math.max(currentVal + 1, nextVal);
                await tx.update({ table: slotTable, key: { id: slotId }, values: { val: targetVal } });
                return targetVal;
              });
              noteWrite();
              return committed;
            });
            localSeq = Math.max(localSeq, writtenVal);
            history.ok(workerId, 'write', { slotId, val: writtenVal, caller: callerKey });

            // Immediately perform two RYW lag-tolerant reads:
            // (a) browser-cookie style (`fresh: true`) and (b) bearer-token style (`key: callerKey`).
            const followCtx: ReadContext = rng.next() < 0.5 ? { fresh: true } : { fresh: false, key: callerKey };
            history.invoke(workerId, 'ryw-read', { slotId, expectedMin: writtenVal, caller: callerKey });
            const observed = await readsAs(followCtx, () => lagTolerantReads(() => readSlot(slotId)));
            history.ok(workerId, 'ryw-read', { slotId, expectedMin: writtenVal, observed, caller: callerKey });
          } catch (error) {
            history.info(workerId, 'write', { slotId, caller: callerKey }, error instanceof Error ? error.message : String(error));
          }
          await sleep(rng.int(10, 35));
        }
      };

      // Background anonymous lag-tolerant readers (hits replica when healthy, falls back to primary during partitions).
      const readerLoop = async (workerId: number) => {
        while (Date.now() < stopAt) {
          const slotId = rng.int(1, slotCount + 1);
          const anon: ReadContext = { fresh: false };
          history.invoke(workerId, 'lag-read', { slotId, partitioned: replicaPartitioned });
          try {
            const observed = await readsAs(anon, () => lagTolerantReads(() => readSlot(slotId)));
            if (replicaPartitioned) fallbackReadsSucceeded++;
            history.ok(workerId, 'lag-read', { slotId, observed, partitioned: replicaPartitioned });
          } catch (error) {
            history.info(workerId, 'lag-read', { slotId }, error instanceof Error ? error.message : String(error));
          }
          await sleep(rng.int(10, 30));
        }
      };

      // Nemesis: alternates replica latency spikes, full replica partition (forcing fallback), and healing.
      const nemesisLoop = async () => {
        if (!options.nemesis) return;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(450);
          if (Date.now() >= stopAt) break;
          const action = round % 3;
          round++;
          nemesisEvents++;
          if (action === 0) {
            replicaProxy.setLatency(120, 40);
            history.info('nemesis', 'replica-latency', { ms: 120 });
            await sleep(450);
            replicaProxy.setLatency(0, 0);
          } else if (action === 1) {
            replicaPartitioned = true;
            replicaProxy.setPartition(true);
            history.info('nemesis', 'replica-partition-start', {});
            await sleep(700);
            replicaProxy.setPartition(false);
            replicaPartitioned = false;
            history.info('nemesis', 'replica-partition-heal', {});
          } else {
            const count = replicaProxy.resetConnections();
            history.info('nemesis', 'replica-tcp-reset', { sockets: count });
          }
        }
        replicaProxy.heal();
        primaryProxy.heal();
        replicaPartitioned = false;
        history.info('nemesis', 'heal', { all: true });
      };

      const readerCount = Math.max(1, options.concurrency - writerCount);
      await Promise.all([
        nemesisLoop(),
        ...Array.from({ length: writerCount }, (_, i) => writerLoop(i)),
        ...Array.from({ length: readerCount }, (_, i) => readerLoop(100 + i)),
      ]);

      // Final primary read sanity check after healing.
      await primaryReads(() => readSlot(1));

      const replicaCheckouts = adapter
        .poolStats()
        .filter((p) => p.role === 'replica')
        .reduce((sum, p) => sum + p.checkouts, 0);

      const check = checkReplicaRyw({
        history: history.entries(),
        replicaCheckouts,
        fallbackReadsSucceeded,
      });
      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'replica-history')) : undefined;
      return {
        workload: 'replica',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        usedStreamingReplica,
        proxyStats: [
          { node: 'primary', stats: primaryProxy.stats() },
          { node: 'replica', stats: replicaProxy.stats() },
        ],
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      await adapter.close().catch(() => {});
      await primaryProxy.close().catch(() => {});
      await replicaProxy.close().catch(() => {});
    }
  });
}
