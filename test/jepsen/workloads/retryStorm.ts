/**
 * Jepsen Retry-Storm & Metastable Overload Protection workload (`retry-storm`).
 *
 * Standalone adversarial chaos workload (no Docker or PostgreSQL needed) that
 * drives Mistri's retry-storm defenses concurrently under a Nemesis cycling
 * through brownouts, 429 Retry-After pushback, Error Ownership `unclaimed`
 * cascades, blackhole hangs (AbortSignal withdrawal), and saturated primary
 * spillover bursts — followed by a mandatory post-heal recovery phase to prove
 * zero metastable lock-in.
 *
 * Subsystems exercised live:
 *  - Shared retry primitives (`@mistriwork/engine/shared/retry.js`)
 *  - Egress HTTP client (`egress.ts`: `AbortSignal` socket teardown, `Retry-After`, `x-mistri-error-claim`)
 *  - Server admission (`PoolAdmission`: retry shedding >= 75% queue depth, client-abort slot withdrawal)
 *  - Read-replica spillover gating (`ReplicaSet` with `primarySaturated`)
 *  - Integration runtime (`integrationCalls`: token-bucket `RetryBudget`, `outerRetries: true` anti-multiplication, `unclaimed` upward propagation)
 *  - In-flight idempotency coalescing (`executeBusinessCommand` over real SQLite + command journal)
 *  - Durable workflow engine (`workflowEngine.ts`: `unclaimed` -> immediate `StepRefused`, `Retry-After` wake scheduling)
 *  - Event outbox publisher (`createEventPublisher`: `Retry-After` cooldown pausing)
 *  - AI decision circuits & fan-out (`decisionProviders.ts` single-probe half-open leasing + `anthropicDecisions.ts` bounded concurrency)
 */
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DEFAULT_POLICY, send } from '../../../packages/engine/src/adapters/http/egress.js';
import { admitAs, PoolAdmission, withAdmission } from '../../../packages/engine/src/adapters/poolAdmission.js';
import { PoolBusy } from '../../../packages/engine/src/adapters/poolMetrics.js';
import { lagTolerantReads, ReplicaSet } from '../../../packages/engine/src/adapters/replicas.js';
import { Registry } from '../../../packages/engine/src/server/connections.js';
import { ERROR_CLAIM_HEADER } from '../../../packages/engine/src/shared/retry.js';
import { migrateSqliteCommandJournal } from '../../../packages/mistri/src/adapters/commands/commandJournal.js';
import type { EventDeliveryStore } from '../../../packages/mistri/src/adapters/events/eventDeliveryContract.js';
import type { EventDeliveryPolicy } from '../../../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { openIntegrationStore, provisionSqliteIntegrations } from '../../../packages/mistri/src/adapters/integrations/integrationStore.js';
import { refusalHeaders } from '../../../packages/mistri/src/server/api/apiCommandResponse.js';
import { loadAppRuntimeResources } from '../../../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../../../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../../../packages/mistri/src/server/commands/businessCommandExecution.js';
import { businessCommandHttpError } from '../../../packages/mistri/src/server/commands/businessCommandHttp.js';
import { defineCommand, defineCommands } from '../../../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent } from '../../../packages/mistri/src/server/commands/businessEvents.js';
import { BusinessCommandExecutionError, markErrorOwnership } from '../../../packages/mistri/src/server/commands/commandErrors.js';
import { text } from '../../../packages/mistri/src/server/commands/commandShapes.js';
import { anthropicDecisions } from '../../../packages/mistri/src/server/decide/providers/anthropicDecisions.js';
import {
  recordCall,
  releaseCircuitTrial,
  resetCircuits,
  tryAcquireCircuit,
} from '../../../packages/mistri/src/server/decide/providers/decisionProviders.js';
import { createEventPublisher } from '../../../packages/mistri/src/server/events/eventPublisher.js';
import { defineIntegration, shape } from '../../../packages/mistri/src/server/integration.js';
import { captureIntegrations } from '../../../packages/mistri/src/server/integrations/integrationDeclaration.js';
import {
  createIntegrationRuntime,
  integrationCalls,
  registerIntegrationRuntime,
  resetIntegrationRetryBudgets,
} from '../../../packages/mistri/src/server/integrations/integrationRuntime.js';
import { createWorkflowDriver } from '../../../packages/mistri/src/server/testing/workflows.js';
import { defineWorkflow, StepRefused } from '../../../packages/mistri/src/server/workflows.js';
import { parseTestApp } from '../../support/commandCatalog.js';
import { checkRetryStorm, type RetryStormCheckResult } from '../checkers.js';
import type { FaultProxyStats } from '../faultProxy.js';
import { HistoryRecorder } from '../history.js';
import { SeededRng, sleep } from '../pgHelper.js';

export interface RetryStormWorkloadOptions {
  readonly durationSec: number;
  readonly concurrency: number;
  readonly nemesis: boolean;
  readonly seed: number;
  readonly outDir?: string;
}

export interface RetryStormWorkloadReport {
  readonly workload: 'retry-storm';
  readonly valid: boolean;
  readonly durationMs: number;
  readonly nemesisEvents: number;
  readonly proxyStats: readonly { readonly node: string; readonly stats: FaultProxyStats }[];
  readonly check: RetryStormCheckResult;
  readonly historyFiles?: { readonly jsonl: string; readonly edn: string };
}

type FaultMode = 'healthy' | 'brownout_503' | 'overload_429' | 'unclaimed_cascade' | 'blackhole_hang';

const FAULT_CYCLE: readonly FaultMode[] = ['brownout_503', 'overload_429', 'unclaimed_cascade', 'blackhole_hang', 'healthy'];

export async function runRetryStormWorkload(options: RetryStormWorkloadOptions): Promise<RetryStormWorkloadReport> {
  process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';
  const startedAt = Date.now();
  const rng = new SeededRng(options.seed);
  const workDir = mkdtempSync(join(tmpdir(), 'mistri-jepsen-retry-storm-'));
  const history = new HistoryRecorder<unknown>();

  // Reset shared process-level retry/circuit state cleanly before and after the run.
  resetIntegrationRetryBudgets();
  resetCircuits();

  let faultMode: FaultMode = options.nemesis ? 'brownout_503' : 'healthy';
  let primarySaturated = options.nemesis;
  let nemesisEvents = 0;

  // Metrics gathered across all concurrent adversarial phases.
  let unclaimedDownstreamFailures = 0;
  let unclaimedAmplifications = 0;
  let stormRequestsSent = 0;
  let stormDownstreamAttempts = 0;
  let stormSuccesses = 0;
  let nestedOuterCalls = 0;
  let maxNestedInnerAttempts = 0;
  let coalescedUniqueKeys = 0;
  let coalescedTotalRequests = 0;
  const handlerExecutionsByKey = new Map<string, number>();
  let conflictRacesAttempted = 0;
  let conflictRacesSucceeded = 0;
  let freshRequestsAdmitted = 0;
  let retryRequestsShed = 0;
  let abortedWaitersWithdrawn = 0;
  let leakedAdmissionSlots = 0;
  let replicaSpilloversSuppressed = 0;
  let replicaSpilloversDuringSaturation = 0;
  let publisherCooldownPauses = 0;
  let publisherCooldownBreaches = 0;
  let maxConcurrentHalfOpenProbes = 0;
  let maxConcurrentAnthropicAsks = 0;
  let exhaustedRefusalsChecked = 0;
  let exhaustedRefusalsClaimed = 0;
  let postHealRecoveriesOk = 0;
  let postHealRecoveriesFailed = 0;

  // 1. Loopback chaos downstream HTTP server (exercises real TCP + egress.ts + Error Ownership + Retry-After).
  const hangingResponses = new Set<ServerResponse>();
  const downstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const mode = faultMode;
    if (req.url === '/hang' || (req.url === '/storm' && mode === 'blackhole_hang')) {
      hangingResponses.add(res);
      res.on('close', () => hangingResponses.delete(res));
      return;
    }
    if (req.url === '/unclaimed' || mode === 'unclaimed_cascade') {
      res.writeHead(503, {
        'content-type': 'application/json',
        'retry-after': '2',
        [ERROR_CLAIM_HEADER]: 'unclaimed',
      });
      res.end('{"error":"upstream_exhausted"}');
      return;
    }
    if (req.url === '/429' || mode === 'overload_429') {
      res.writeHead(429, {
        'content-type': 'application/json',
        'retry-after': '1',
        [ERROR_CLAIM_HEADER]: 'claimed',
      });
      res.end('{"error":"rate_limited"}');
      return;
    }
    if (req.url === '/503' || mode === 'brownout_503') {
      res.writeHead(503, {
        'content-type': 'application/json',
        [ERROR_CLAIM_HEADER]: 'claimed',
      });
      res.end('{"error":"busy"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  downstream.listen(0, '127.0.0.1');
  await once(downstream, 'listening');
  const downstreamPort = (downstream.address() as { port: number }).port;
  const egressPolicy = { ...DEFAULT_POLICY, insecure: true, allowPrivate: true, timeoutMs: 800, connectTimeoutMs: 500 };

  // 2. Real SQLite command database + integration store.
  const appDbPath = join(workDir, 'app.db');
  const appDb = new DatabaseSync(appDbPath);
  appDb.exec(`
    CREATE TABLE items(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, title TEXT);
    INSERT INTO items VALUES (1, 0, 'seed-1'), (2, 0, 'seed-2'), (3, 0, 'seed-3'), (4, 0, 'seed-4');
  `);
  migrateSqliteCommandJournal(appDbPath);

  const intDbPath = join(workDir, 'integrations.db');
  new DatabaseSync(intDbPath).close();
  provisionSqliteIntegrations(intDbPath);
  const integrationStore = await openIntegrationStore({ sqlite: intDbPath });

  const registry = new Registry();
  registry.add({ id: 'db', name: 'db', url: appDbPath, writable: true, source: 'config' });

  let unregisterIntegration: (() => void) | undefined;

  try {
    // 3. Real integration backed by chaos HTTP downstream (`gateway.charge`).
    let activeNestedCounter: { count: number } | undefined;
    let stormPhaseActive = false;
    const gateway = defineIntegration({
      name: 'gateway',
      secrets: [],
      client: () => ({}),
      actions: {
        charge: {
          input: shape({ tag: text() }),
          output: shape({ ok: text() }),
          async run(_client, input, ctx) {
            const tag = String((input as { tag: string }).tag);
            if (tag.startsWith('nested:') && activeNestedCounter) {
              activeNestedCounter.count += 1;
            } else if (stormPhaseActive) {
              stormDownstreamAttempts += 1;
            }
            const path = tag.startsWith('heal:') ? '/healthy' : tag.startsWith('nested:') ? '/503' : '/storm';
            const reply = await send(new URL(`http://127.0.0.1:${downstreamPort}${path}`), {}, egressPolicy, ctx.signal);
            if (reply.status >= 200 && reply.status <= 299) {
              if (stormPhaseActive) stormSuccesses += 1;
              return { ok: 'yes' };
            }
            const err = Object.assign(new Error(`HTTP ${reply.status}`), {
              status: reply.status,
              ...(reply.retryAfterMs !== undefined ? { retryAfterMs: reply.retryAfterMs } : {}),
            });
            throw err;
          },
        },
      },
    });
    const declared = captureIntegrations({ use: [gateway] }, new Map(), (msg) => {
      throw new Error(msg);
    });
    const runtime = createIntegrationRuntime({ appId: 'jepsen-retry', declared, store: integrationStore });
    unregisterIntegration = registerIntegrationRuntime(runtime);

    // 4. Real Mistri command binding for in-flight idempotency coalescing.
    const inputSchema = { title: { label: 'Title', type: 'text' }, keyTag: { label: 'Key', type: 'text' } } as const;
    const app = parseTestApp(
      {
        id: 'jepsen-retry',
        name: 'Jepsen Retry',
        sources: { db: { connection: 'db' } },
        resources: {
          items: {
            access: 'write',
            actions: { rename: { label: 'Rename', command: { id: 'rename', version: 1, target: 'items', input: inputSchema } } },
          },
        },
        auth: { roles: { staff: { read: true, commands: ['rename'] } } },
        views: { items: { kind: 'list', from: 'items' } },
        home: 'items',
        nav: ['items'],
      },
      'jepsen retry-storm fixture',
    );
    const commands = defineCommands({
      rename: defineCommand({
        source: 'db',
        target: 'items',
        input: inputSchema,
        validate: (v) => ({ title: String(v.title), keyTag: String(v.keyTag) }),
        output: { parse: (v) => v as { title: string; version: number } },
        async handle({ db: tx, record }, value) {
          handlerExecutionsByKey.set(value.keyTag, (handlerExecutionsByKey.get(value.keyTag) ?? 0) + 1);
          await sleep(18);
          const updated = await tx.items.update(record, { title: value.title });
          return { title: value.title, version: Number(updated.version) };
        },
      }),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'db');
    const binding = bindBusinessCommands({ app, resources, registry: commands, writableConnection: () => true });
    const actor = { id: 'jepsen-user', appId: 'jepsen-retry', roles: ['staff'] };

    // 5. Chaos deadline & Nemesis loop cycling fault modes.
    const deadlineAt = Date.now() + Math.max(1, options.durationSec) * 1_000;
    let running = true;
    const nemesisTask = (async () => {
      if (!options.nemesis) return;
      let cycle = 0;
      while (running && Date.now() < deadlineAt) {
        faultMode = FAULT_CYCLE[cycle % FAULT_CYCLE.length];
        primarySaturated = cycle % 2 === 0;
        nemesisEvents += 1;
        history.info('nemesis', 'fault-mode', { faultMode, primarySaturated, cycle });
        cycle += 1;
        // Destroy any sockets held by a prior blackhole phase when leaving blackhole_hang.
        if (faultMode !== 'blackhole_hang') {
          for (const held of hangingResponses) held.destroy();
          hangingResponses.clear();
        }
        await sleep(Math.min(350, Math.max(80, Math.floor((options.durationSec * 1_000) / 8))));
      }
    })();

    // 6. Sub-workload A: PoolAdmission retry shedding + AbortSignal withdrawal under contention.
    const admissionTask = (async () => {
      const admission = new PoolAdmission('read', 1, 4);
      let round = 0;
      while (running && Date.now() < deadlineAt) {
        round += 1;
        const hold = await admission.enter(2_000);
        // Spawn a burst of aborted waiters first; every single one must withdraw cleanly without leaking slots.
        const abortControllers = [new AbortController(), new AbortController()];
        const abortedPromises = abortControllers.map((c, idx) =>
          withAdmission(`198.51.100.${10 + idx}`, () => admission.enter(5_000), { signal: c.signal }).then(
            (rel) => {
              rel();
              return false;
            },
            () => true,
          ),
        );
        for (const c of abortControllers) c.abort();
        const withdrew = await Promise.all(abortedPromises);
        abortedWaitersWithdrawn += withdrew.filter(Boolean).length;

        // Fill 3 of 4 slots (75% utilization) with distinct accounts, then contend retry vs fresh.
        const fillers = [0, 1, 2].map((i) =>
          withAdmission(`198.51.100.${20 + i}`, () => {
            admitAs(`filler-${round}-${i}`);
            return admission.enter(3_000).then((rel) => {
              rel();
              return true;
            });
          }),
        );

        // Retry attempt at >= 75% queue depth MUST be shed.
        history.invoke(1, 'pool-retry-shed', { round, retryAttempt: 2 });
        try {
          const rel = await withAdmission(
            '198.51.100.99',
            () => {
              admitAs(`retrier-${round}`);
              return admission.enter(2_000);
            },
            { retryAttempt: 2 },
          );
          rel();
          history.fail(1, 'pool-retry-shed', { round }, 'retry_admitted_above_threshold');
        } catch (err) {
          if (err instanceof PoolBusy && err.why === 'queue_full') {
            retryRequestsShed += 1;
            history.ok(1, 'pool-retry-shed', { round, shed: true });
          }
        }

        // Fresh first attempt MUST still claim the 4th slot (proving zero leaked slots from aborted waiters).
        history.invoke(2, 'pool-fresh-admit', { round, retryAttempt: 0 });
        const freshPlace = withAdmission('198.51.100.100', () => {
          admitAs(`fresh-${round}`);
          return admission.enter(3_000).then((rel) => {
            rel();
            return true;
          });
        });

        hold();
        const settled = await Promise.allSettled([...fillers, freshPlace]);
        const last = settled[settled.length - 1];
        if (last.status === 'fulfilled') {
          freshRequestsAdmitted += 1;
          history.ok(2, 'pool-fresh-admit', { round, admitted: true });
        } else {
          leakedAdmissionSlots += 1;
          history.fail(2, 'pool-fresh-admit', { round }, 'fresh_rejected_after_abort');
        }
        await sleep(25);
      }
    })();

    // 7. Sub-workload B: ReplicaSet spillover suppression under saturated primary.
    const replicaTask = (async () => {
      const replica = {
        query: async () => {
          throw new PoolBusy('read', 'queue_full');
        },
      };
      const set = new ReplicaSet([replica], Date.now, {
        primarySaturated: () => primarySaturated,
      });
      let seq = 0;
      while (running && Date.now() < deadlineAt) {
        seq += 1;
        const wasSaturated = primarySaturated;
        let hitPrimary = false;
        history.invoke(3, 'replica-read', { seq, primarySaturated: wasSaturated });
        try {
          await lagTolerantReads(() =>
            set.read(
              (pool) => pool.query(),
              async () => {
                hitPrimary = true;
                return { ok: true };
              },
            ),
          );
          if (wasSaturated && hitPrimary) {
            replicaSpilloversDuringSaturation += 1;
            history.fail(3, 'replica-read', { seq, hitPrimary }, 'spilled_while_saturated');
          } else {
            history.ok(3, 'replica-read', { seq, hitPrimary });
          }
        } catch (err) {
          if (err instanceof PoolBusy && wasSaturated && !hitPrimary) {
            replicaSpilloversSuppressed += 1;
            history.ok(3, 'replica-read', { seq, suppressed: true });
          } else {
            history.info(3, 'replica-read', { seq }, String(err));
          }
        }
        await sleep(30);
      }
    })();

    // 8. Sub-workload C: Concurrent idempotency-key coalescing + conflict storms on real SQLite commands.
    const coalescingTask = (async () => {
      const itemVersions = new Map<number, number>([
        [1, 0],
        [2, 0],
        [3, 0],
        [4, 0],
      ]);
      let seq = 0;
      while (running && Date.now() < deadlineAt) {
        seq += 1;
        const itemId = (seq % 4) + 1;
        const expectedVersion = itemVersions.get(itemId) ?? 0;
        const keyTag = `jepsen-coalesce-${options.seed}-${seq}`;
        const dupCount = Math.max(3, Math.min(options.concurrency, 6));
        coalescedUniqueKeys += 1;
        coalescedTotalRequests += dupCount;

        const baseReq = {
          command: 'rename',
          commandVersion: 1,
          key: { id: itemId },
          expectedVersion,
          idempotencyKey: keyTag,
          input: { title: `v-${seq}`, keyTag },
        };

        history.invoke(4, 'coalesce-burst', { keyTag, dupCount });
        const duplicates = Array.from({ length: dupCount }, () => executeBusinessCommand(binding, actor, baseReq, { door: 'api' }));
        // Race a conflicting payload under the exact same idempotencyKey while the burst is in flight.
        conflictRacesAttempted += 1;
        const conflict = executeBusinessCommand(
          binding,
          actor,
          { ...baseReq, input: { title: `conflict-${seq}`, keyTag } },
          { door: 'api' },
        );

        const [dupResults, conflictResult] = await Promise.all([
          Promise.allSettled(duplicates),
          conflict.then(
            () => 'ok',
            (e) => e,
          ),
        ]);
        const succeeded = dupResults.filter((r) => r.status === 'fulfilled');
        if (succeeded.length > 0) {
          const nextVer = (succeeded[0].value.result as { version: number }).version;
          itemVersions.set(itemId, nextVer);
          history.ok(4, 'coalesce-burst', { keyTag, succeeded: succeeded.length, executions: handlerExecutionsByKey.get(keyTag) ?? 0 });
        } else {
          history.info(4, 'coalesce-burst', { keyTag }, 'all_failed');
        }
        if (conflictResult === 'ok') {
          conflictRacesSucceeded += 1;
        }
        await sleep(15);
      }
    })();

    // 9. Sub-workload D: Integration retry-budget storm + Error Ownership propagation + outerRetries anti-multiplication.
    const integrationStormTask = (async () => {
      // First prove outerRetries: true runs strictly 1 attempt (zero nested R^d multiplication).
      for (let i = 0; i < 4; i++) {
        nestedOuterCalls += 1;
        const counter = { count: 0 };
        activeNestedCounter = counter;
        const calls = integrationCalls({
          appId: 'jepsen-retry',
          tenant: '',
          commandId: 'wf-sync',
          actorId: 'worker',
          idempotencyKey: `nested-key-${options.seed}-${i}`,
          signal: AbortSignal.timeout(2_000),
          declared: { gateway: ['charge'] },
          outerRetries: true,
        });
        await calls.gateway.charge({ tag: `nested:${i}` }).catch(() => {});
        activeNestedCounter = undefined;
        maxNestedInnerAttempts = Math.max(maxNestedInnerAttempts, counter.count);
      }

      // Now hammer interactive integration calls concurrently during brownout/overload so RetryBudget must clamp attempts.
      stormPhaseActive = true;
      const stormWorkers = Array.from({ length: Math.max(2, Math.min(options.concurrency, 6)) }, (_, workerIdx) =>
        (async () => {
          let localSeq = 0;
          while (running && Date.now() < deadlineAt) {
            localSeq += 1;
            stormRequestsSent += 1;
            const calls = integrationCalls({
              appId: 'jepsen-retry',
              tenant: '',
              commandId: 'ui-charge',
              actorId: `u-${workerIdx}`,
              idempotencyKey: `storm-${options.seed}-${workerIdx}-${localSeq}`,
              signal: AbortSignal.timeout(1_200),
              declared: { gateway: ['charge'] },
              outerRetries: false,
            });
            history.invoke(10 + workerIdx, 'integration-storm', { workerIdx, localSeq, mode: faultMode });
            try {
              await calls.gateway.charge({ tag: `storm:${workerIdx}:${localSeq}` });
              history.ok(10 + workerIdx, 'integration-storm', { workerIdx, localSeq });
            } catch (err) {
              if (err instanceof BusinessCommandExecutionError && err.code === 'temporarily_unavailable') {
                exhaustedRefusalsChecked += 1;
                const apiHdrs = refusalHeaders('temporarily_unavailable', err);
                const httpErr = businessCommandHttpError(err);
                if (apiHdrs?.[ERROR_CLAIM_HEADER] !== 'unclaimed' || httpErr.errorClaim !== 'unclaimed') {
                  exhaustedRefusalsClaimed += 1;
                }
              }
              history.info(10 + workerIdx, 'integration-storm', { workerIdx, localSeq }, 'temporarily_unavailable');
            }
            await sleep(rng.int(10, 35));
          }
        })(),
      );
      await Promise.all(stormWorkers);
      stormPhaseActive = false;
    })();

    // 10. Sub-workload E: Workflow Error Ownership (`unclaimed` -> 1 attempt) + EventPublisher cooldown + AI half-open leasing.
    const protocolTask = (async () => {
      // E1. Workflow Error Ownership against real HTTP `unclaimed` endpoint via egress.ts.
      const Trigger = defineEvent('jepsen.trigger', shape({ id: text() }));
      const attemptsById = new Map<string, number>();
      const wf = defineWorkflow({
        runAs: 'worker',
        start: { event: Trigger, key: (e) => e.id },
        run: async (w, start) => {
          try {
            return await w.call(
              'downstream',
              'chaos',
              { path: '/unclaimed', body: { id: start.id } },
              { retry: { attempts: 4, backoff: '1 second' } },
            );
          } catch (err) {
            if (err instanceof StepRefused) return { refused: true };
            throw err;
          }
        },
      });
      const driver = await createWorkflowDriver({
        workflow: { wf },
        commands: {},
        calls: {
          chaos: async (req) => {
            const id = String((req.body as { id: string }).id);
            attemptsById.set(id, (attemptsById.get(id) ?? 0) + 1);
            const reply = await send(new URL(`http://127.0.0.1:${downstreamPort}/unclaimed`), {}, egressPolicy);
            unclaimedDownstreamFailures += 1;
            throw markErrorOwnership(new Error(`HTTP ${reply.status}`), reply.errorClaim ?? 'claimed', reply.retryAfterMs);
          },
        },
      });
      try {
        for (let i = 0; i < 4; i++) {
          const id = `unclaimed-${i}`;
          history.invoke(5, 'workflow-unclaimed', { id });
          await driver.emit(Trigger, { id }, `evt-${id}`);
          const count = attemptsById.get(id) ?? 0;
          if (count > 1) unclaimedAmplifications += 1;
          history.ok(5, 'workflow-unclaimed', { id, attempts: count });
        }
      } finally {
        await driver.close();
      }

      // E2. EventPublisher Retry-After cooldown suppression under rapid ticks.
      let pubClock = 100_000;
      let pubClaims = 0;
      let cooldownActive = false;
      const pubPolicy: EventDeliveryPolicy = {
        source: { appId: 'jepsen-retry', storeId: 's1', sourceId: 'db' } as EventDeliveryPolicy['source'],
        serviceId: 'svc',
        destinationId: 'dest',
        routes: [],
        limits: {
          maxAttempts: 5,
          leaseMs: 30_000,
          timeoutMs: 10_000,
          backoffMs: 1_000,
          maxBackoffMs: 60_000,
          maxRetained: 100,
          scanBatch: 50,
        },
      };
      const pubStore = {
        policy: pubPolicy,
        async discover() {
          return { discovered: 0, pressure: false };
        },
        async claim() {
          if (cooldownActive) publisherCooldownBreaches += 1;
          pubClaims += 1;
          return {
            deliveryId: `d-${pubClaims}`,
            eventId: `e-${pubClaims}`,
            leaseToken: `lease-${pubClaims}`,
            destinationId: 'dest',
            serviceId: 'svc',
            idempotencyKey: `evt-key-${pubClaims}`,
            attempts: 1,
            attemptLimit: 5,
            deadline: pubClock + 30_000,
            envelope: {
              id: `e-${pubClaims}`,
              name: 'order.created',
              version: 1,
              occurredAt: new Date(pubClock).toISOString(),
              payload: {},
              appId: 'jepsen-retry',
              sourceId: 'db',
              command: 'createOrder',
              commandVersion: 1,
              receiptId: 'r1',
              actorId: 'u1',
            },
          };
        },
        async complete() {
          return true;
        },
        async close() {},
      } as unknown as EventDeliveryStore;
      const publisher = createEventPublisher(
        pubStore,
        async () => {
          throw Object.assign(new Error('429'), { retryAfterMs: 10_000 });
        },
        () => pubClock,
      );
      await publisher.tick();
      cooldownActive = true;
      for (let i = 0; i < 6; i++) {
        const res = await publisher.tick();
        if (res.status === 'idle') publisherCooldownPauses += 1;
        pubClock += 1_000;
      }
      cooldownActive = false;

      // E3. AI half-open single-probe circuit leasing under concurrent worker contention.
      let probesInFlight = 0;
      for (let cycle = 0; cycle < 4; cycle++) {
        resetCircuits();
        const baseNow = 10_000 + cycle * 100_000;
        recordCall('anthropic', false, baseNow, 5_000);
        const halfOpenNow = baseNow + 5_000;
        await Promise.all(
          Array.from({ length: Math.max(4, options.concurrency) }, async () => {
            if (!tryAcquireCircuit('anthropic', halfOpenNow)) return;
            probesInFlight += 1;
            maxConcurrentHalfOpenProbes = Math.max(maxConcurrentHalfOpenProbes, probesInFlight);
            try {
              await sleep(15);
              recordCall('anthropic', true, halfOpenNow + 15);
            } finally {
              probesInFlight -= 1;
              releaseCircuitTrial('anthropic');
            }
          }),
        );
      }

      // E4. Anthropic multi-ask concurrency bound (<= 4 for 10 asks).
      let anthropicInFlight = 0;
      const provider = anthropicDecisions('jepsen-key', async () => {
        anthropicInFlight += 1;
        maxConcurrentAnthropicAsks = Math.max(maxConcurrentAnthropicAsks, anthropicInFlight);
        await sleep(15);
        anthropicInFlight -= 1;
        return new Response(
          JSON.stringify({
            model: 'claude-sonnet-5-5',
            content: [{ type: 'tool_use', name: 'answer', input: { answer: true, probability: 0.9 } }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
      const asks = Array.from({ length: 10 }, (_, i) => ({
        id: `ask-${i}`,
        question: `Classify ${i}?`,
        inputs: { i },
        answer: { kind: 'bool' as const },
      }));
      await provider.decide({ asks, signal: AbortSignal.timeout(5_000) });
    })();

    await Promise.all([nemesisTask, admissionTask, replicaTask, coalescingTask, integrationStormTask, protocolTask]);
    running = false;

    // 11. Post-heal recovery verification: prove ZERO metastable lock-in once the nemesis stands down.
    faultMode = 'healthy';
    primarySaturated = false;
    for (const held of hangingResponses) held.destroy();
    hangingResponses.clear();
    history.info('nemesis', 'heal', { faultMode, primarySaturated });

    for (let i = 0; i < 4; i++) {
      history.invoke(99, 'post-heal-probe', { i });
      try {
        const reply = await send(new URL(`http://127.0.0.1:${downstreamPort}/healthy`), {}, egressPolicy);
        const calls = integrationCalls({
          appId: 'jepsen-retry',
          tenant: '',
          commandId: 'heal-check',
          actorId: 'probe',
          idempotencyKey: `heal-key-${options.seed}-${i}`,
          signal: AbortSignal.timeout(3_000),
          declared: { gateway: ['charge'] },
          outerRetries: false,
        });
        const answered = await calls.gateway.charge({ tag: `heal:${i}` });
        if (reply.status === 200 && answered.ok === 'yes') {
          postHealRecoveriesOk += 1;
          history.ok(99, 'post-heal-probe', { i });
        } else {
          postHealRecoveriesFailed += 1;
          history.fail(99, 'post-heal-probe', { i }, 'unexpected_reply');
        }
      } catch (err) {
        postHealRecoveriesFailed += 1;
        history.fail(99, 'post-heal-probe', { i }, err instanceof Error ? err.message : String(err));
      }
    }

    const durationMs = Date.now() - startedAt;
    const maxHandlerExecutionsPerKey = Math.max(0, ...handlerExecutionsByKey.values());
    const stormMaxAllowedAttempts = stormRequestsSent + 10 + Math.ceil((durationMs / 60_000) * 6) + Math.ceil(stormSuccesses * 0.1) + 2;

    const check = checkRetryStorm(history.entries(), {
      unclaimedDownstreamFailures,
      unclaimedAmplifications,
      stormRequestsSent,
      stormDownstreamAttempts,
      stormMaxAllowedAttempts,
      nestedOuterCalls,
      maxNestedInnerAttempts,
      coalescedUniqueKeys,
      coalescedTotalRequests,
      maxHandlerExecutionsPerKey,
      conflictRacesAttempted,
      conflictRacesSucceeded,
      freshRequestsAdmitted,
      retryRequestsShed,
      abortedWaitersWithdrawn,
      leakedAdmissionSlots,
      replicaSpilloversSuppressed,
      replicaSpilloversDuringSaturation,
      publisherCooldownPauses,
      publisherCooldownBreaches,
      maxConcurrentHalfOpenProbes,
      maxConcurrentAnthropicAsks,
      exhaustedRefusalsChecked,
      exhaustedRefusalsClaimed,
      postHealRecoveriesOk,
      postHealRecoveriesFailed,
    });

    const historyFiles = options.outDir ? history.writeFiles(join(options.outDir, 'retry-storm-history')) : undefined;
    return {
      workload: 'retry-storm',
      valid: check.valid,
      durationMs,
      nemesisEvents,
      proxyStats: [],
      check,
      ...(historyFiles ? { historyFiles } : {}),
    };
  } finally {
    unregisterIntegration?.();
    resetIntegrationRetryBudgets();
    resetCircuits();
    for (const held of hangingResponses) held.destroy();
    hangingResponses.clear();
    downstream.closeAllConnections();
    await new Promise<void>((resolve) => downstream.close(() => resolve()));
    await registry.closeAll();
    await integrationStore.close();
    appDb.close();
    rmSync(workDir, { recursive: true, force: true });
  }
}
