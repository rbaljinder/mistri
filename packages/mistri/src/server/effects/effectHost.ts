/**
 * Effect delivery: the webhook destinations a command registry's effects
 * need, derived exactly as maintenance provisions them, and the host that
 * delivers them once the server listens.
 *
 * One destination per webhook, routing every command that posts to it. Its
 * id names what it routes and how it is bounded (`effect:<webhook>@<hash>`),
 * because a delivery store keeps a destination's policy whole and refuses a
 * different one under the same id: a command version or an effect added is a
 * new destination, provisioned once with the server stopped. The store sits
 * beside the App's event store on the commands' source.
 *
 * The host is the jobs host without a runner: one publisher per destination,
 * a `setTimeout` chain, never `setInterval`, again at once after work and
 * after a second when idle. A publisher that halts stays halted; readiness
 * says so (`effects`), and a restart is the recovery.
 */
import { createHash } from 'node:crypto';
import type { EventDeliveryStore } from '../../adapters/events/eventDeliveryContract.js';
import { openSqliteEventDeliveryStore } from '../../adapters/events/eventDeliveryStore.js';
import { captureEventDeliveryPolicy, type EventDeliveryPolicy } from '../../adapters/events/eventDeliveryTypes.js';
import { openPostgresEventDeliveryStore } from '../../adapters/events/postgresEventDeliveryStore.js';
import { RUNTIME_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';
import { sharedPgConnections } from '@mistriwork/engine/adapters/postgresPool.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { appCommandEventStore, type StoreTarget } from '../commands/appCommandEvents.js';
import { CHANNEL_DESTINATION_PREFIX, webhookTransport, type Webhook } from '../commands/commandEffects.js';
import type { CommandEventStoreBinding } from '../../adapters/events/commandEventSchema.js';
import type { EventPublicationTransport } from '../events/eventPublisher.js';
import {
  BusinessCommandDefinitionError,
  getCommandEffects,
  getCommandEvents,
  type BusinessCommandRegistry,
} from '../commands/businessCommands.js';
import { activateEventProducer, type EventProducer } from '../events/eventProducer.js';
import type { ReadinessCheckInput, ReadinessCode } from '../operations/operations.js';
import { deliveryQueueOperator, type DeliveryQueueOperator } from '../operations/queueOperator.js';

const EFFECT_SERVICE_ID = 'mistri.effects';
/* A webhook destination's bounds, part of its identity like its routes. A
   request is given 12 s inside a 30 s lease; a webhook that is down is
   asked again after 1 s, doubling to 5 minutes, eight times in all. */
const EFFECT_LIMITS = Object.freeze({
  maxAttempts: 8,
  leaseMs: 30_000,
  timeoutMs: 12_000,
  backoffMs: 1_000,
  maxBackoffMs: 300_000,
  maxRetained: 10_000,
  scanBatch: 8,
});

interface EffectDestination {
  readonly webhook: string;
  readonly policy: EventDeliveryPolicy;
  /** `<commandId>\n<event name>` for each effect this destination sends. */
  readonly routed: ReadonlySet<string>;
}
export interface EffectDeployment {
  readonly appId: string;
  readonly sourceId: string;
  /** The event store the effects are recorded in: the App's own, or a tenant App's, whose routes take every tenant's facts. */
  readonly events: CommandEventStoreBinding;
  readonly scope: 'app' | 'tenants';
  readonly destinations: readonly EffectDestination[];
}

/**
 * The destinations a registry's effects need, or undefined when no command
 * declares one. Every effect's command shares the one source its event store
 * sits beside, as every emitting command does.
 */
export function effectDeployment(
  options: Readonly<{
    appId: string;
    commands: BusinessCommandRegistry;
    /** A tenant App's event store, by the source it sits on: its effects are every tenant's, each delivered as that tenant's. */
    tenants?: (sourceId: string) => CommandEventStoreBinding;
  }>,
): EffectDeployment | undefined {
  const { appId, commands } = options;
  const scope = options.tenants ? ('tenants' as const) : ('app' as const);
  const posting = Object.entries(commands).flatMap(([id, command]) =>
    (getCommandEffects(command) ?? []).map((target) => ({ id, command, target })),
  );
  if (!posting.length) return undefined;
  const sources = [...new Set(posting.map(({ command }) => command.source))];
  if (sources.length > 1) {
    throw new BusinessCommandDefinitionError(
      `Commands with effects must share one source, which holds their event store; they are on ${sources.map((s) => `"${s}"`).join(' and ')}.`,
    );
  }
  const events = options.tenants ? options.tenants(sources[0]) : appCommandEventStore(appId, sources[0]);
  const byWebhook = new Map<string, typeof posting>();
  for (const entry of posting) byWebhook.set(entry.target.destination, [...(byWebhook.get(entry.target.destination) ?? []), entry]);
  const destinations = [...byWebhook]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([webhook, entries]) => {
      const commandIds = [...new Set(entries.map(({ id }) => id))].sort();
      const routes = commandIds.map((id) => ({
        scope,
        commandId: id,
        commandVersion: commands[id].version,
        manifest: [...getCommandEvents(commands[id])!.expectation],
      }));
      const identity = createHash('sha256')
        .update(
          canonicalCommandJson({ routes, limits: EFFECT_LIMITS, effects: entries.map(({ id, target }) => `${id}\n${target.name}`).sort() }),
        )
        .digest('hex')
        .slice(0, 16);
      let policy: EventDeliveryPolicy;
      try {
        policy = captureEventDeliveryPolicy({
          source: events,
          serviceId: EFFECT_SERVICE_ID,
          destinationId: `effect:${webhook}@${identity}`,
          limits: { ...EFFECT_LIMITS },
          routes,
        });
      } catch {
        throw new BusinessCommandDefinitionError(`Webhook "${webhook}" does not make a valid delivery destination for App "${appId}".`);
      }
      return Object.freeze({ webhook, policy, routed: new Set(entries.map(({ id, target }) => `${id}\neffect.${target.name}`)) });
    });
  return Object.freeze({ appId, sourceId: sources[0], events, scope, destinations: Object.freeze(destinations) });
}

export interface EffectHost {
  readiness(): readonly ReadinessCheckInput[];
  /** Each webhook destination, as an operator lists and redrives its deliveries (the Console's Operations room). */
  readonly deliveries: readonly DeliveryQueueOperator[];
  /** One cycle: each publisher delivers what is due. True when anything moved. */
  tick(): Promise<boolean>;
  start(): void;
  stop(): Promise<void>;
}

const DELIVERIES_PER_CYCLE = 16;
const SNAPSHOT_MS = 5_000;
const BACKLOG_LEASES = 5;

/** Open every destination's delivery store, attested against its policy, and a publisher over each. */
export async function openEffectHost(
  options: Readonly<{
    deployment: EffectDeployment;
    target: StoreTarget;
    webhooks: ReadonlyMap<string, Webhook>;
    /** A channel destination's transport (`channel:sms`), from the App's integrations (integrationChannels.ts). */
    channels?: (destination: string, routed: ReadonlySet<string>) => EventPublicationTransport | undefined;
    now?: () => number;
    idleMs?: number;
  }>,
): Promise<EffectHost> {
  const { deployment, target, webhooks } = options;
  const now = options.now ?? Date.now,
    idleMs = options.idleMs ?? 1_000;
  const clock = options.now ? ('caller' as const) : ('database' as const);
  const pg = 'postgres' in target ? sharedPgConnections(target.postgres, RUNTIME_STORE_POOL) : undefined;
  const deliveries: Array<{ webhook: string; store: EventDeliveryStore; producer: EventProducer }> = [];
  const events = deployment.events;
  try {
    for (const { webhook, policy, routed } of deployment.destinations) {
      const hook = webhooks.get(webhook);
      const transport = webhook.startsWith(CHANNEL_DESTINATION_PREFIX)
        ? options.channels?.(webhook, routed)
        : hook && webhookTransport({ webhook: hook, routed });
      if (!transport) throw new Error();
      const store = pg
        ? await openPostgresEventDeliveryStore(pg, policy, { clock })
        : openSqliteEventDeliveryStore((target as { sqlite: string }).sqlite, policy);
      try {
        deliveries.push({
          webhook,
          store,
          producer: activateEventProducer(store, {
            enrollment: { source: events, producerId: EFFECT_SERVICE_ID, correlationNamespace: EFFECT_SERVICE_ID },
            transport,
            clock: now,
          }),
        });
      } catch (error) {
        await store.close().catch(() => {});
        throw error;
      }
    }
  } catch {
    for (const { producer } of deliveries) await producer.stop().catch(() => {});
    await pg?.close().catch(() => {});
    throw new BusinessCommandDefinitionError(
      `Effects: the webhook delivery on source "${deployment.sourceId}" could not be opened and attested. ` +
        "Provision it once, with the server stopped: `mistri migrate stores up --app <the App's directory>`, or provisionStores with the App's commands from @mistriwork/mistri/maintenance.",
    );
  }

  let stopping = false;
  let stopped: Promise<void> | undefined;
  let active: Promise<boolean> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pressure = new Set<string>();
  const check = (code: ReadinessCode): ReadinessCheckInput =>
    Object.freeze({
      name: 'effects',
      state: code === 'ok' ? 'ready' : code === 'worker_halted' || code === 'shutting_down' ? 'not_ready' : 'degraded',
      code,
    });
  let snapshot = check('ok');
  let refreshedAt = Number.NEGATIVE_INFINITY;
  /** Bounded reads: one row to see failure, a page to see age. No payload or id leaves here. */
  async function refresh(): Promise<void> {
    const at = now();
    if (at - refreshedAt < SNAPSHOT_MS) return;
    refreshedAt = at;
    const late = (time: number | null) => time !== null && time + BACKLOG_LEASES * EFFECT_LIMITS.leaseMs < at;
    try {
      let code: ReadinessCode = 'ok';
      for (const { webhook, store } of deliveries) {
        // Exhausted ambiguous attempts are already 'failed' in the store.
        const failed = (await store.inspect('failed', '', 1)).length;
        const waiting = [
          ...(await store.inspect('pending', '', 128)),
          ...(await store.inspect('retry', '', 128)),
          ...(await store.inspect('unknown', '', 128)),
        ];
        if (failed) code = 'work_failed';
        else if (code === 'ok' && (pressure.has(webhook) || waiting.some((row) => late(row.nextAt)))) code = 'backlog_pressure';
      }
      snapshot = check(code);
    } catch {
      snapshot = check('unknown');
    }
  }
  async function cycle(): Promise<boolean> {
    let worked = false;
    for (const { webhook, producer } of deliveries) {
      for (let i = 0; i < DELIVERIES_PER_CYCLE && !stopping; i++) {
        const tick = await producer.tick();
        if (tick.pressure) pressure.add(webhook);
        else if (tick.status === 'idle') pressure.delete(webhook);
        if (tick.status !== 'accepted' && tick.status !== 'rejected' && tick.status !== 'unknown') break;
        worked = true;
      }
    }
    if (!stopping) await refresh();
    return worked;
  }
  const tick = (): Promise<boolean> =>
    stopping
      ? Promise.resolve(false)
      : (active ??= cycle().finally(() => {
          active = undefined;
        }));
  const schedule = (delay: number): void => {
    if (stopping) return;
    timer = setTimeout(() => {
      timer = undefined;
      void tick().then(
        (worked) => schedule(worked ? 0 : idleMs),
        () => schedule(idleMs),
      );
    }, delay);
    timer.unref?.();
  };
  let started = false;
  return Object.freeze({
    readiness: () =>
      Object.freeze([
        stopping
          ? check('shutting_down')
          : deliveries.every(({ producer }) => producer.status() === 'running')
            ? snapshot
            : check('worker_halted'),
      ]),
    deliveries: Object.freeze(deliveries.map(({ webhook, store }) => deliveryQueueOperator('webhook', webhook, store, now))),
    tick,
    start(): void {
      if (started || stopping) return;
      started = true;
      schedule(0);
    },
    stop(): Promise<void> {
      return (stopped ??= (async () => {
        stopping = true;
        if (timer) clearTimeout(timer);
        for (const { producer } of deliveries) await producer.stop().catch(() => {});
        await active?.catch(() => false);
        await pg?.close().catch(() => {});
      })());
    },
  });
}
