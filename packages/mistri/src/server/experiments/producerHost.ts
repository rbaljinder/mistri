/** One explicitly provisioned source destination. Serving opens and attests;
 * the CLI owns provisioning. A serialized worker never overlaps source fences. */
import { SMALL_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';
import { PgConnectionManager } from '@mistriwork/engine/adapters/postgresPool.js';
import { openSqliteEventDeliveryStore } from '../../adapters/events/eventDeliveryStore.js';
import { provisionSqliteEventDeliveryStore } from '../../adapters/events/eventDeliverySchema.js';
import { openPostgresEventDeliveryStore, provisionPostgresEventDeliveryStore } from '../../adapters/events/postgresEventDeliveryStore.js';
import { provisionSqliteCommandEventStore } from '../../adapters/events/commandEventSchema.js';
import { provisionPostgresCommandEventStore } from '../../adapters/events/postgresCommandEventStore.js';
import { experimentDeliveryPolicy, type ExperimentConversionRegistry } from './conversionRegistry.js';
import { activateExperimentConversionProducer } from './conversionTransport.js';
import {
  openPostgresExperimentConversionOwner,
  openSqliteExperimentConversionOwner,
  type NativeConversionAuthorityRequest,
} from './conversionOwner.js';
import { ensure, type CommitGuard, type ExperimentStore, type RegisteredEpoch } from './contracts.js';
import type { SuiteExperimentSource } from '../cli/suiteControlConfig.js';

export interface ExperimentSourceConfiguration extends SuiteExperimentSource {
  readonly url: string;
}
const limits = Object.freeze({
  maxAttempts: 8,
  leaseMs: 30_000,
  timeoutMs: 10_000,
  backoffMs: 1000,
  maxBackoffMs: 60_000,
  maxRetained: 10_000,
  scanBatch: 8,
});
export function experimentSourcePolicy(
  source: ExperimentSourceConfiguration,
  epoch: RegisteredEpoch,
  registry: ExperimentConversionRegistry,
) {
  ensure(
    source.appId === epoch.declaration.scope.appId &&
      source.flagId === epoch.declaration.flagId &&
      source.tenantId === epoch.declaration.scope.evaluationTenantId,
  );
  return experimentDeliveryPolicy(registry, {
    epoch,
    source: { appId: source.appId, sourceId: source.sourceId, storeId: source.storeId },
    serviceId: 'mistri.experiments',
    commandIds: source.commandIds,
    evaluationTenantId: source.tenantId,
    limits,
  });
}
export async function provisionExperimentSource(
  source: ExperimentSourceConfiguration,
  epoch: RegisteredEpoch,
  registry: ExperimentConversionRegistry,
) {
  const policy = experimentSourcePolicy(source, epoch, registry);
  if (/^postgres(ql)?:\/\//.test(source.url)) {
    await provisionPostgresCommandEventStore(source.url, policy.source);
    await provisionPostgresEventDeliveryStore(source.url, policy);
  } else {
    ensure(!source.url.includes('://'), 'Experiment source must be SQLite or PostgreSQL.');
    provisionSqliteCommandEventStore(source.url, policy.source);
    provisionSqliteEventDeliveryStore(source.url, policy, { stopped: true });
  }
}
export async function openExperimentProducerHost(options: {
  readonly source: ExperimentSourceConfiguration;
  readonly epoch: RegisteredEpoch;
  readonly registry: ExperimentConversionRegistry;
  readonly store: ExperimentStore;
  readonly authorize: (request: NativeConversionAuthorityRequest) => Promise<CommitGuard>;
}) {
  const { source, epoch, registry, store, authorize } = options,
    policy = experimentSourcePolicy(source, epoch, registry);
  const enrollment = { source: policy.source, producerId: policy.serviceId, correlationNamespace: policy.serviceId };
  const pg = /^postgres(ql)?:\/\//.test(source.url)
    ? new PgConnectionManager(source.url, undefined, undefined, SMALL_STORE_POOL)
    : undefined;
  let owner: Awaited<ReturnType<typeof openPostgresExperimentConversionOwner>> | undefined;
  let delivery: Awaited<ReturnType<typeof openPostgresEventDeliveryStore>> | undefined;
  try {
    owner = pg
      ? await openPostgresExperimentConversionOwner({
          url: source.url,
          binding: store.binding,
          epoch,
          registry,
          enrollment,
          policy,
          authorize,
          maxClockSkewMs: source.maxClockSkewMs,
        })
      : await openSqliteExperimentConversionOwner({
          path: source.url,
          binding: store.binding,
          epoch,
          registry,
          enrollment,
          policy,
          authorize,
          maxClockSkewMs: source.maxClockSkewMs,
        });
    delivery = pg ? await openPostgresEventDeliveryStore(pg, policy) : openSqliteEventDeliveryStore(source.url, policy);
    const bridge = await activateExperimentConversionProducer(delivery, { store, epoch, registry, enrollment, policy, owner });
    const sourceOwner = owner;
    let closing: Promise<void> | undefined;
    let stopped = false,
      timer: ReturnType<typeof setTimeout> | undefined,
      pending: Promise<void> | undefined;
    let publishedRevision = -1,
      publishedAt = 0,
      completeFinal = false;
    let status: 'idle' | 'running' | 'unavailable' | 'stopped' = 'idle';
    const tick = () =>
      (pending ??= (async () => {
        if (stopped) return;
        status = 'running';
        try {
          // Bounded draining; continuous business traffic cannot starve results.
          for (let count = 0; count < 32 && !stopped; count++) {
            const outcome = await bridge.producer.tick();
            if (outcome.status !== 'accepted') break;
          }
          if (!stopped) {
            const revision = await store.readDataRevision(epoch),
              now = Date.now();
            if (revision !== publishedRevision || (!completeFinal && now - publishedAt >= 30_000)) {
              const evidence = await bridge.publishResults();
              publishedRevision = evidence.dataRevision;
              publishedAt = now;
              completeFinal = evidence.statistics.finalized && evidence.statistics.complete;
            }
          }
          if (!stopped) status = 'idle';
        } catch {
          if (!stopped) status = 'unavailable';
        }
      })().finally(() => {
        pending = undefined;
      }));
    const schedule = () => {
      if (!stopped) {
        timer = setTimeout(() => {
          void tick().finally(schedule);
        }, 1000);
        timer.unref();
      }
    };
    return Object.freeze({
      policy,
      status: () => status,
      tick,
      start() {
        ensure(!stopped && timer === undefined);
        schedule();
      },
      close() {
        stopped = true;
        status = 'stopped';
        if (timer) clearTimeout(timer);
        return (closing ??= (async () => {
          await pending;
          const outcomes = await Promise.allSettled([bridge.producer.stop(), sourceOwner.close()]);
          const pool = await Promise.allSettled([pg?.close()]);
          const errors = [...outcomes, ...pool].filter((result) => result.status === 'rejected').map((result) => result.reason);
          if (errors.length) throw new AggregateError(errors, 'Experiment producer cleanup failed.');
        })());
      },
    });
  } catch (error) {
    await Promise.allSettled([delivery?.close(), owner?.close()]);
    await pg?.close().catch(() => {});
    throw error;
  }
}
