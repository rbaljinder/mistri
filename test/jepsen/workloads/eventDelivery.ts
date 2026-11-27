/**
 * Jepsen Two-Host Event Delivery (Transactional Outbox) + Lease Fencing +
 * Clock-Regression workload.
 *
 * Topology:
 *  - One isolated PostgreSQL database provisioned with Mistri's command journal,
 *    command event store, and event delivery store.
 *  - One command writer producing real committed `item.noted` events (and
 *    occasional rolled-back refusals, which must NEVER emit phantom events).
 *  - Two competing Mistri `createEventPublisher` hosts (`pub-a`, `pub-b`) over
 *    two independent `PgConnectionManager` pools routed through two `FaultProxy`
 *    links.
 *
 * Chaos injected:
 *  - Post-COMMIT TCP cuts and socket resets on both publisher links.
 *  - Indeterminate transport failures: downstream consumer records the event,
 *    then throws before returning `'accepted'` (forcing retries & verifying
 *    Mistri keeps `idempotencyKey` strictly stable across retries and hosts).
 *  - Backward clock regression on `pub-b` (`claimedAt < lastClaimAt`).
 *  - Slow transport exceeding `leaseMs` so the second host claims the expired
 *    lease while the first host settles late.
 */
import { join } from 'node:path';
import { PgConnectionManager } from '../../../packages/engine/src/adapters/postgresPool.js';
import { Registry } from '../../../packages/engine/src/server/connections.js';
import { migratePostgresCommandJournal } from '../../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { EventDeliveryPolicy } from '../../../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { provisionPostgresCommandEventStore } from '../../../packages/mistri/src/adapters/events/postgresCommandEventStore.js';
import {
  openPostgresEventDeliveryStore,
  provisionPostgresEventDeliveryStore,
} from '../../../packages/mistri/src/adapters/events/postgresEventDeliveryStore.js';
import { loadAppRuntimeResources } from '../../../packages/mistri/src/server/app/appRuntimeResources.js';
import { appCommandEventStore, appCommandEventsFor } from '../../../packages/mistri/src/server/commands/appCommandEvents.js';
import { bindBusinessCommands } from '../../../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand, refuse } from '../../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../../../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../../../packages/mistri/src/server/commands/businessEvents.js';
import { shape, text } from '../../../packages/mistri/src/server/commands/commandShapes.js';
import { createEventPublisher, type EventPublication } from '../../../packages/mistri/src/server/events/eventPublisher.js';
import { parseAppConfig } from '../../../packages/mistri/src/shared/app.js';
import { checkEventDelivery, type EventDeliveryCheckResult } from '../checkers.js';
import { FaultProxy, type FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep, withIsolatedPostgresDb } from '../pgHelper.js';

export interface EventDeliveryWorkloadOptions {
  readonly pgUrl: string;
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface EventDeliveryWorkloadReport {
  readonly workload: 'outbox';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: EventDeliveryCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

const APP_ID = 'jepsen-outbox';
const SOURCE_ID = 'orders';
const CONNECTION_ID = 'jepsen-outbox-pg';
const ACTOR: BusinessCommandActor = { id: 'jepsen-issuer', appId: APP_ID, roles: ['issuer'] };

const notedOutput = shape({ eventKey: text() });
const ItemNoted = defineEvent('order.noted', notedOutput);

const commands = defineCommands({
  note: defineCommand({
    source: SOURCE_ID,
    target: 'ledger_anchor',
    read: ['order_note'],
    write: ['order_note'],
    input: {
      eventKey: { label: 'Event key', type: 'text' },
      shouldRefuse: { label: 'Refuse', type: 'boolean' },
    },
    output: notedOutput,
    events: {
      noted: defineEventProjection(ItemNoted, (output) => output),
    },
    async handle({ db }, input) {
      const eventKey = String(input.eventKey);
      await db.order_note.insert({ event_key: eventKey });
      if (input.shouldRefuse === true) refuse('ineligible_state');
      return { eventKey };
    },
  }),
});

export async function runEventDeliveryWorkload(options: EventDeliveryWorkloadOptions): Promise<EventDeliveryWorkloadReport> {
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);

  return withIsolatedPostgresDb(options.pgUrl, 'outbox', async ({ dbUrl, control }) => {
    await control.query(`
      CREATE TABLE public.ledger_anchor (
        id text PRIMARY KEY,
        version integer NOT NULL DEFAULT 0
      );
      CREATE TABLE public.order_note (
        id serial PRIMARY KEY,
        event_key text NOT NULL UNIQUE
      );
      INSERT INTO public.ledger_anchor (id, version) VALUES ('main', 0);
    `);

    const storeBinding = appCommandEventStore(APP_ID, SOURCE_ID);
    await migratePostgresCommandJournal(dbUrl);
    await provisionPostgresCommandEventStore(dbUrl, storeBinding);

    const policy: EventDeliveryPolicy = {
      source: storeBinding,
      serviceId: 'jepsen-outbox-service',
      destinationId: 'jepsen-consumer-v1',
      routes: [
        {
          scope: 'app',
          commandId: 'note',
          commandVersion: 1,
          manifest: [{ name: 'order.noted', version: 1 }],
        },
      ],
      limits: {
        maxAttempts: 16,
        leaseMs: 150,
        timeoutMs: 120,
        backoffMs: 25,
        maxBackoffMs: 100,
        maxRetained: 256,
        scanBatch: 8,
      },
    };
    await provisionPostgresEventDeliveryStore(dbUrl, policy);

    const parsed = new URL(dbUrl);
    const pgHost = parsed.hostname || '127.0.0.1';
    const pgPort = Number(parsed.port || 5432);

    const proxies = [
      { name: 'pub-a', proxy: new FaultProxy(pgHost, pgPort) },
      { name: 'pub-b', proxy: new FaultProxy(pgHost, pgPort) },
    ];
    for (const item of proxies) await item.proxy.start();

    const registry = new Registry();
    registry.add({ id: CONNECTION_ID, name: 'Outbox writer', url: dbUrl, writable: true, source: 'config' });

    const app = parseAppConfig(
      {
        id: APP_ID,
        name: 'Jepsen Outbox',
        sources: { [SOURCE_ID]: { connection: CONNECTION_ID } },
        resources: {
          ledger_anchor: { physical: 'public.ledger_anchor', access: 'write' },
          order_note: { physical: 'public.order_note', access: 'write' },
        },
        auth: { roles: { issuer: { read: true, commands: ['note'] } } },
        views: { notes: { kind: 'list', from: 'order_note' } },
        home: 'notes',
      },
      'jepsen outbox app',
    );

    const history = new HistoryRecorder<unknown>();
    const deliveries: Array<{ readonly eventKey: string; readonly idempotencyKey: string; readonly publisher: string }> = [];
    const managers: PgConnectionManager[] = [];
    const publishers: ReturnType<typeof createEventPublisher>[] = [];
    let nemesisEvents = 0;

    try {
      const resources = await loadAppRuntimeResources(registry, app, CONNECTION_ID);
      const eventsScope = await appCommandEventsFor(app, commands, resources, (id) => registry.configOf(id)?.url);
      const binding = bindBusinessCommands({
        app,
        registry: commands,
        resources,
        writableConnection: (id) => registry.configOf(id)?.writable === true,
        events: eventsScope,
      });

      // Controlled clock offset per publisher so the nemesis can inject backward clock regression on pub-b.
      const clockOffsetMs = [0, 0];
      let transportChaosEnabled = options.nemesis;

      const makeTransport =
        (pubName: string) =>
        async (pub: EventPublication): Promise<'accepted' | 'rejected'> => {
          const payload = JSON.parse(pub.envelope.payloadJson) as { eventKey?: string };
          const eventKey = String(payload.eventKey ?? '');
          history.invoke(pubName === 'pub-a' ? 0 : 1, 'deliver', {
            publisher: pubName,
            eventKey,
            idempotencyKey: pub.idempotencyKey,
          });
          if (transportChaosEnabled) {
            const roll = rng.next();
            if (roll < 0.15) {
              // Simulate downstream accepting the event, then network dropping before ack returns (unknown outcome!).
              deliveries.push({ eventKey, idempotencyKey: pub.idempotencyKey, publisher: pubName });
              history.info(
                pubName === 'pub-a' ? 0 : 1,
                'deliver',
                { publisher: pubName, eventKey, idempotencyKey: pub.idempotencyKey },
                'transport_ack_lost',
              );
              throw new Error('Simulated lost ack after downstream accept');
            }
            if (roll < 0.25) {
              // Slow delivery to provoke lease expiry / concurrent re-claim on the other host.
              await sleep(170);
            }
          }
          deliveries.push({ eventKey, idempotencyKey: pub.idempotencyKey, publisher: pubName });
          history.ok(pubName === 'pub-a' ? 0 : 1, 'deliver', {
            publisher: pubName,
            eventKey,
            idempotencyKey: pub.idempotencyKey,
          });
          return 'accepted';
        };

      for (let idx = 0; idx < proxies.length; idx++) {
        const manager = new PgConnectionManager(proxies[idx].proxy.proxiedUrl(dbUrl));
        managers.push(manager);
        const store = await openPostgresEventDeliveryStore(manager, policy);
        const pub = createEventPublisher(store, makeTransport(proxies[idx].name), () => Date.now() + clockOffsetMs[idx]);
        publishers.push(pub);
      }

      const stopAt = Date.now() + options.durationSec * 1_000;
      const targetEvents = Math.max(18, Math.min(48, options.durationSec * 4));
      let produced = 0;

      // Producer loop: emits committed events plus ~20% rolled-back refusals (must produce 0 phantom events).
      const producerLoop = async () => {
        for (let i = 1; i <= targetEvents && Date.now() < stopAt; i++) {
          const eventKey = `jepsen-ev-${options.seed}-${i}`;
          const shouldRefuse = rng.next() < 0.2;
          history.invoke(99, 'produce', { eventKey, shouldRefuse });
          try {
            await executeBusinessCommand(binding, ACTOR, {
              command: 'note',
              commandVersion: 1,
              key: { id: 'main' },
              expectedVersion: 0,
              input: { eventKey, shouldRefuse },
              idempotencyKey: `produce-${eventKey}`,
            });
            produced++;
            history.ok(99, 'produce', { eventKey });
          } catch (error) {
            history.fail(99, 'produce', { eventKey, shouldRefuse }, error instanceof Error ? error.message : String(error));
          }
          await sleep(rng.int(20, 70));
        }
      };

      // Competing publisher loops (pub-a and pub-b).
      const publisherLoop = async (idx: number) => {
        while (Date.now() < stopAt) {
          try {
            const tick = await publishers[idx].tick();
            if (tick.status === 'idle' || tick.status === 'unavailable') await sleep(25);
          } catch {
            await sleep(25);
          }
        }
      };

      const nemesisLoop = async () => {
        if (!options.nemesis) return;
        let round = 0;
        while (Date.now() < stopAt) {
          await sleep(300);
          if (Date.now() >= stopAt) break;
          const idx = round % proxies.length;
          const action = round % 4;
          round++;
          nemesisEvents++;
          if (action === 0) {
            history.info('nemesis', 'arm-commit-cut', { host: proxies[idx].name });
            proxies[idx].proxy.armCommitCut(1);
          } else if (action === 1) {
            // Backward clock jump on pub-b to exercise regressed-clock handling.
            clockOffsetMs[1] -= 5_000;
            history.info('nemesis', 'clock-regress', { host: 'pub-b', offsetMs: clockOffsetMs[1] });
          } else if (action === 2) {
            const count = proxies[idx].proxy.resetConnections();
            history.info('nemesis', 'tcp-reset', { host: proxies[idx].name, sockets: count });
          } else {
            proxies[idx].proxy.setLatency(40, 20);
            history.info('nemesis', 'latency', { host: proxies[idx].name, ms: 40 });
            await sleep(200);
            proxies[idx].proxy.setLatency(0, 0);
          }
        }
        for (const p of proxies) p.proxy.heal();
        clockOffsetMs[0] = 0;
        clockOffsetMs[1] = 0;
        history.info('nemesis', 'heal', { all: true });
      };

      await Promise.all([producerLoop(), publisherLoop(0), publisherLoop(1), nemesisLoop()]);

      // Phase 2: Heal faults & transport chaos, reopen fresh publishers if any halted, and drain all pending deliveries.
      transportChaosEnabled = false;
      for (const p of proxies) p.proxy.heal();
      clockOffsetMs[0] = 0;
      clockOffsetMs[1] = 0;

      const drainManager = new PgConnectionManager(dbUrl);
      managers.push(drainManager);
      const drainStore = await openPostgresEventDeliveryStore(drainManager, policy);
      const drainPub = createEventPublisher(drainStore, makeTransport('drain'));
      publishers.push(drainPub);

      const drainDeadline = Date.now() + 8_000;
      while (Date.now() < drainDeadline) {
        const tick = await drainPub.tick();
        if (tick.status === 'idle') {
          const deliveredUnique = new Set(deliveries.map((d) => d.eventKey)).size;
          if (deliveredUnique >= produced) break;
          await sleep(50);
        }
      }

      // Ground truth: committed order_note rows in PostgreSQL.
      const rows = await control.query('SELECT event_key FROM public.order_note ORDER BY id');
      const committedKeys = rows.rows.map((r) => String(r.event_key));

      const check = checkEventDelivery({ committedKeys, deliveries, history: history.entries() });
      const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'outbox-history')) : undefined;
      return {
        workload: 'outbox',
        valid: check.valid,
        durationMs: Date.now() - startedAt,
        nemesisEvents,
        proxyStats: proxies.map((p) => ({ node: p.name, stats: p.proxy.stats() })),
        check,
        ...(historyFiles ? { historyFiles } : {}),
      };
    } finally {
      for (const pub of publishers) await pub.stop().catch(() => {});
      for (const m of managers) await m.close().catch(() => {});
      await registry.closeAll().catch(() => {});
      for (const item of proxies) await item.proxy.close().catch(() => {});
    }
  });
}
