/**
 * Jepsen Valkey Cache Consistency & Partition-Degradation workload.
 *
 * Topology:
 *  - Connects two Mistri `ValkeyCacheStore` instances (over `RespClient`) to a
 *    live Valkey 8 server routed behind a `FaultProxy`, alongside an isolated
 *    PostgreSQL database acting as the source of truth.
 *  - Uses `scopedCache(store, 'tenant:<id>')` for 3 tenants (`alpha`, `beta`, `gamma`).
 *
 * Behaviour under test:
 *  - Writers update PostgreSQL and invalidate the tenant's Valkey key; readers
 *    use cache-aside (`get` -> fallback to Postgres -> `set`), and rate-limiter
 *    probes call `incr` (which MUST fail closed with `CacheUnavailable` when
 *    Valkey is partitioned).
 *  - Nemesis partitions Valkey, resets Valkey TCP sockets mid-command, and
 *    injects latency spikes — then heals.
 *  - Verifies zero cross-tenant cache bleed, graceful fail-open reads during
 *    Valkey outage, fail-closed `incr`, and fresh post-heal invalidation.
 */
import { join } from 'node:path';
import { CacheUnavailable, scopedCache, ValkeyCacheStore } from '../../../packages/engine/src/adapters/cache/cacheStore.js';
import { RespClient } from '../../../packages/engine/src/adapters/cache/resp.js';
import { checkValkeyCache, type ValkeyCacheCheckResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface ValkeyCacheWorkloadOptions {
  readonly pgUrl: string;
  readonly valkeyUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface ValkeyCacheWorkloadReport {
  readonly workload: 'cache';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: ValkeyCacheCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const TENANTS = ['alpha', 'beta', 'gamma'] as const;

export async function runValkeyCacheWorkload(options: ValkeyCacheWorkloadOptions): Promise<ValkeyCacheWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);

  return withIsolatedPostgresDb(options.pgUrl, 'cache', async ({ control }) => {
    await control.query(`
      CREATE TABLE public.tenant_profile (
        tenant text PRIMARY KEY,
        version integer NOT NULL DEFAULT 1,
        payload text NOT NULL
      );
    `);
    for (const tenant of TENANTS) {
      await control.query(`INSERT INTO public.tenant_profile (tenant, version, payload) VALUES ($1, 1, $2)`, [
        tenant,
        JSON.stringify({ tenant, version: 1 }),
      ]);
    }

    const parsedValkey = new URL(options.valkeyUrl);
    const valkeyHost = parsedValkey.hostname || '127.0.0.1';
    const valkeyPort = Number(parsedValkey.port || 6379);
    const valkeyDb = Number(parsedValkey.pathname.replace(/^\//, '') || 0);

    const proxy = new FaultProxy(valkeyHost, valkeyPort);
    await proxy.start();

    const makeStore = (prefix: string) => {
      const client = new RespClient({
        host: proxy.host,
        port: proxy.port,
        tls: false,
        db: valkeyDb,
        policy: { allowPrivate: true, allowLinkLocal: false },
        connectTimeoutMs: 400,
        commandTimeoutMs: 400,
        retryAfterMs: 150,
      });
      const raw = new ValkeyCacheStore(client, () => {});
      return { raw, scoped: scopedCache(raw, `jepsen:${options.seed}:${prefix}`) };
    };

    const rawStores = [makeStore('shared'), makeStore('shared')];
    const stores = rawStores.map((s) => s.scoped);
    const history = new HistoryRecorder<unknown>();
    let nemesisEvents = 0;
    let partitioned = false;
    let partitionDegradedReads = 0;
    let incrUnavailableErrors = 0;
    let postHealFreshChecks = 0;

    try {
      const versionByTenant: Record<string, number> = { alpha: 1, beta: 1, gamma: 1 };
      const stopAt = Date.now() + options.durationSec * 1_000;

      const nemesisLoop = async () => {
        if (!options.nemesis) return;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(400);
          if (Date.now() >= stopAt) break;
          const action = round % 3;
          round++;
          nemesisEvents++;
          if (action === 0) {
            partitioned = true;
            proxy.setPartition(true);
            history.info('nemesis', 'valkey-partition-start', {});
            await sleep(550);
            proxy.setPartition(false);
            partitioned = false;
            history.info('nemesis', 'valkey-partition-heal', {});
          } else if (action === 1) {
            const count = proxy.resetConnections();
            history.info('nemesis', 'valkey-tcp-reset', { sockets: count });
          } else {
            proxy.setLatency(50, 25);
            history.info('nemesis', 'valkey-latency', { ms: 50 });
            await sleep(300);
            proxy.setLatency(0, 0);
          }
        }
        proxy.heal();
        partitioned = false;
        history.info('nemesis', 'heal', { all: true });
      };

      const workerLoop = async (workerId: number) => {
        while (Date.now() < stopAt) {
          const tenant = TENANTS[rng.int(0, TENANTS.length)];
          const store = stores[rng.int(0, stores.length)];
          const tenantCache = scopedCache(store, `t:${tenant}`);
          const roll = rng.next();

          if (roll < 0.25) {
            // Write to Postgres and invalidate Valkey key.
            const nextVer = ++versionByTenant[tenant];
            const payload = JSON.stringify({ tenant, version: nextVer });
            history.invoke(workerId, 'cache-write', { tenant, version: nextVer });
            await control.query(`UPDATE public.tenant_profile SET version = $2, payload = $3 WHERE tenant = $1`, [
              tenant,
              nextVer,
              payload,
            ]);
            await tenantCache.delete('profile');
            history.ok(workerId, 'cache-write', { tenant, version: nextVer });
          } else if (roll < 0.45) {
            // Rate-limit counter probe: `incr` must either succeed or throw CacheUnavailable during partition.
            try {
              await tenantCache.incr('ratelimit', 10_000, 1);
            } catch (error) {
              if (error instanceof CacheUnavailable) incrUnavailableErrors++;
              else throw error;
            }
          } else {
            // Cache-aside read: miss/partition degrades cleanly to Postgres without ever mixing tenants.
            history.invoke(workerId, 'cache-read', { tenant, partitioned });
            const cached = await tenantCache.get('profile');
            let parsed: { tenant: string; version: number };
            if (cached !== undefined) {
              parsed = JSON.parse(cached) as { tenant: string; version: number };
            } else {
              if (partitioned) partitionDegradedReads++;
              const row = (await control.query('SELECT payload FROM public.tenant_profile WHERE tenant = $1', [tenant])).rows[0];
              parsed = JSON.parse(String(row.payload)) as { tenant: string; version: number };
              await tenantCache.set('profile', JSON.stringify(parsed), 5_000);
            }
            history.ok(workerId, 'cache-read', {
              tenant,
              observedTenant: parsed.tenant,
              observedVersion: parsed.version,
              fromCache: cached !== undefined,
            });
          }
          await sleep(rng.int(5, 25));
        }
      };

      await Promise.all([nemesisLoop(), ...Array.from({ length: options.concurrency }, (_, i) => workerLoop(i))]);

      // Post-heal phase: wait past RespClient quiet window, write a new version per tenant,
      // invalidate Valkey on store[0], and verify store[1] reads the fresh version.
      proxy.heal();
      partitioned = false;
      await sleep(250);

      for (const tenant of TENANTS) {
        const nextVer = ++versionByTenant[tenant] + 100;
        const payload = JSON.stringify({ tenant, version: nextVer });
        await control.query(`UPDATE public.tenant_profile SET version = $2, payload = $3 WHERE tenant = $1`, [tenant, nextVer, payload]);
        await scopedCache(stores[0], `t:${tenant}`).delete('profile');

        history.invoke(0, 'cache-read', { tenant, postHeal: true, expectedMinVersion: nextVer });
        const cached = await scopedCache(stores[1], `t:${tenant}`).get('profile');
        let observed: { tenant: string; version: number };
        if (cached !== undefined) {
          observed = JSON.parse(cached) as { tenant: string; version: number };
        } else {
          const row = (await control.query('SELECT payload FROM public.tenant_profile WHERE tenant = $1', [tenant])).rows[0];
          observed = JSON.parse(String(row.payload)) as { tenant: string; version: number };
          await scopedCache(stores[1], `t:${tenant}`).set('profile', JSON.stringify(observed), 5_000);
        }
        postHealFreshChecks++;
        history.ok(0, 'cache-read', {
          tenant,
          observedTenant: observed.tenant,
          observedVersion: observed.version,
          expectedMinVersion: nextVer,
          postHeal: true,
        });
      }

      const check = checkValkeyCache({
        history: history.entries(),
        partitionDegradedReads,
        incrUnavailableErrors,
        postHealFreshChecks,
      });
      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'cache-history')) : undefined;
      return {
        workload: 'cache',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        proxyStats: [{ node: 'valkey', stats: proxy.stats() }],
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      for (const store of rawStores) await store.raw.close().catch(() => {});
      await proxy.close().catch(() => {});
    }
  });
}
