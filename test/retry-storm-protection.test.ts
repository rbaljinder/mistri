/**
 * Retry-storm defenses across Mistri's layers: shared jitter/budget/error-claim
 * primitives, egress AbortSignal & pushback headers, OTLP non-spinning backoff,
 * pool admission abort-withdrawal and retry shedding, replica spillover gating,
 * integration single-layer retry & budget, in-flight idempotency coalescing,
 * workflow error-claim/Retry-After handling, and AI decision provider circuits.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import {
  ERROR_CLAIM_HEADER,
  equalJitter,
  jitteredBackoffMs,
  MAX_RETRY_AFTER_MS,
  parseErrorClaim,
  parseRetryAfterMs,
  parseRetryAttempt,
  RetryBudget,
  RetryBudgetRegistry,
  retryAfterWithJitter,
  shouldRetryErrorClaim,
} from '../packages/engine/src/shared/retry.js';
import { DEFAULT_POLICY, HttpSourceError, send } from '../packages/engine/src/adapters/http/egress.js';
import { startOtlp } from '../packages/engine/src/adapters/telemetry/otlp.js';
import { inSpan } from '../packages/engine/src/adapters/telemetry/trace.js';
import { admitAs, PoolAdmission, withAdmission } from '../packages/engine/src/adapters/poolAdmission.js';
import { PoolBusy } from '../packages/engine/src/adapters/poolMetrics.js';
import { lagTolerantReads, REPLICA_BACKOFF_MS, ReplicaSet } from '../packages/engine/src/adapters/replicas.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { scheduleDeliveryBackoff } from '../packages/mistri/src/adapters/events/eventDeliveryRules.js';
import type { EventDeliveryPolicy } from '../packages/mistri/src/adapters/events/eventDeliveryTypes.js';
import { createEventPublisher } from '../packages/mistri/src/server/events/eventPublisher.js';
import type { EventDeliveryStore } from '../packages/mistri/src/adapters/events/eventDeliveryContract.js';
import { refusalHeaders } from '../packages/mistri/src/server/api/apiCommandResponse.js';
import {
  BusinessCommandExecutionError,
  errorClaimOf,
  errorRetryAfterMs,
  markErrorOwnership,
} from '../packages/mistri/src/server/commands/commandErrors.js';
import { businessCommandHttpError } from '../packages/mistri/src/server/commands/businessCommandHttp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { defineIntegration, shape } from '../packages/mistri/src/server/integration.js';
import { captureIntegrations } from '../packages/mistri/src/server/integrations/integrationDeclaration.js';
import {
  createIntegrationRuntime,
  integrationCalls,
  registerIntegrationRuntime,
  resetIntegrationRetryBudgets,
} from '../packages/mistri/src/server/integrations/integrationRuntime.js';
import { openIntegrationStore, provisionSqliteIntegrations } from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { defineEvent } from '../packages/mistri/src/server/commands/businessEvents.js';
import { text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { createWorkflowDriver } from '../packages/mistri/src/server/testing/workflows.js';
import { defineWorkflow, StepRefused } from '../packages/mistri/src/server/workflows.js';
import { anthropicDecisions } from '../packages/mistri/src/server/decide/providers/anthropicDecisions.js';
import { failureOfStatus, ProviderFailure } from '../packages/mistri/src/server/decide/providers/decisionProvider.js';
import {
  circuitClosed,
  recordCall,
  releaseCircuitTrial,
  resetCircuits,
  tryAcquireCircuit,
} from '../packages/mistri/src/server/decide/providers/decisionProviders.js';
import { parseTestApp } from './support/commandCatalog.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('shared retry primitives parse Error Ownership, Retry-After, jitter, and enforce token-bucket retry budgets', () => {
  assert.equal(parseErrorClaim('claimed'), 'claimed');
  assert.equal(parseErrorClaim('UNCLAIMED'), 'unclaimed');
  assert.equal(parseErrorClaim('true'), 'claimed');
  assert.equal(parseErrorClaim('false'), 'unclaimed');
  assert.equal(parseErrorClaim(['unclaimed', 'claimed']), 'unclaimed');
  assert.equal(parseErrorClaim('other'), undefined);

  assert.equal(shouldRetryErrorClaim(undefined), true);
  assert.equal(shouldRetryErrorClaim('claimed'), true);
  assert.equal(shouldRetryErrorClaim('unclaimed'), false);

  assert.equal(parseRetryAttempt('2'), 2);
  assert.equal(parseRetryAttempt('0'), 0);
  assert.equal(parseRetryAttempt('-1'), 0);
  assert.equal(parseRetryAttempt('bogus'), 0);

  const now = 1_700_000_000_000;
  assert.equal(parseRetryAfterMs('5', now), 5_000);
  assert.equal(parseRetryAfterMs('999999', now), MAX_RETRY_AFTER_MS);
  assert.equal(parseRetryAfterMs(new Date(now + 12_000).toUTCString(), now), 12_000);
  assert.equal(parseRetryAfterMs('not-a-date', now), undefined);

  assert.equal(
    equalJitter(1_000, () => 0),
    500,
  );
  assert.equal(
    equalJitter(1_000, () => 0.999999),
    1_000,
  );
  assert.equal(
    retryAfterWithJitter(2_000, 500, () => 0.5),
    2_250,
  );
  assert.equal(jitteredBackoffMs(1, 1_000, 60_000, { minDelayMs: 5_000, random: () => 0 }), 5_000);

  // Token-bucket budget: drains on consecutive retries and refills on successes.
  let clock = 10_000;
  const budget = new RetryBudget(
    {
      maxTokens: 5,
      initialTokens: 5,
      retryCost: 1,
      successCredit: 0.2,
      refillPerMinute: 0,
    },
    () => clock,
  );
  let allowed = 0;
  for (let i = 0; i < 8; i++) {
    if (budget.tryConsumeRetry().allowed) allowed += 1;
  }
  assert.equal(allowed, 5);
  const denied = budget.tryConsumeRetry();
  assert.equal(denied.allowed, false);
  if (!denied.allowed) assert.equal(denied.reason, 'budget');

  // Recording 5 successes deposits 1.0 token, restoring 1 retry.
  for (let i = 0; i < 5; i++) budget.recordSuccess();
  assert.equal(budget.tryConsumeRetry().allowed, true);

  // Explicit Retry-After sets a cooldown across the budget.
  budget.recordFailure(clock, 3_000);
  const cooled = budget.tryConsumeRetry();
  assert.equal(cooled.allowed, false);
  if (!cooled.allowed) {
    assert.equal(cooled.reason, 'cooldown');
    assert.equal(cooled.waitMs, 3_000);
  }
  clock += 3_000;
  assert.equal(budget.cooldownRemainingMs(), 0);

  // Registry enforces bounded LRU size.
  const registry = new RetryBudgetRegistry({}, 2);
  const a = registry.for('a');
  registry.for('b');
  registry.for('c');
  assert.notEqual(registry.for('a'), a, 'oldest key was evicted past maxDestinations');
});

test('egress honors AbortSignal and parses Retry-After and Error Ownership headers', async () => {
  let heldRes: ServerResponse | undefined;
  let serverSawClose = false;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/slow') {
      heldRes = res;
      res.on('close', () => {
        serverSawClose = true;
      });
      return;
    }
    res.writeHead(503, {
      'content-type': 'application/json',
      'retry-after': '7',
      [ERROR_CLAIM_HEADER]: 'unclaimed',
    });
    res.end('{"error":"busy"}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const policy = { ...DEFAULT_POLICY, insecure: true, allowPrivate: true, timeoutMs: 2_000 };
  try {
    const reply = await send(new URL(`http://127.0.0.1:${port}/busy`), {}, policy);
    assert.equal(reply.status, 503);
    assert.equal(reply.retryAfterMs, 7_000);
    assert.equal(reply.errorClaim, 'unclaimed');

    const error = new HttpSourceError('status', 'downstream failed', 503, reply.retryAfterMs, reply.errorClaim);
    assert.equal(error.retryAfterMs, 7_000);
    assert.equal(error.errorClaim, 'unclaimed');

    const controller = new AbortController();
    const pending = send(new URL(`http://127.0.0.1:${port}/slow`), {}, { ...policy, timeoutMs: 10_000 }, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(pending, (err: unknown) => err instanceof HttpSourceError && err.reason === 'timeout');
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(serverSawClose, true);
  } finally {
    heldRes?.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('OTLP exporter does not spin-retry on 429 and honors Retry-After cooldown', async () => {
  let requests = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      requests += 1;
      res.writeHead(429, { 'retry-after': '10' });
      res.end('slow down');
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  const exporter = startOtlp(
    {
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_COMPRESSION: 'none',
      OTEL_LOGS_EXPORTER: 'none',
      OTEL_METRICS_EXPORTER: 'none',
      OTEL_BSP_SCHEDULE_DELAY: '60000',
      OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '1',
      OTEL_BSP_MAX_QUEUE_SIZE: '64',
    },
    '0.0.0',
    'mistri',
  );
  try {
    // batchSize: 1 triggers immediate export on the first span; subsequent spans must wait out Retry-After.
    for (let i = 0; i < 6; i++) {
      await inSpan(`op-${i}`, { kind: 'internal' }, async () => {});
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(requests, 1, 'failed OTLP POST must not recurse into an immediate retry storm');
  } finally {
    await exporter.shutdown();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('PoolAdmission withdraws aborted waiters and sheds retries before first attempts under load', async () => {
  const line = new PoolAdmission('read', 1, 4);
  const holding = await line.enter(1_000);

  // 1. Disconnected client's AbortSignal removes its waiter immediately so all 4 slots remain usable.
  const controller = new AbortController();
  const abandoned = withAdmission('203.0.113.10', () => line.enter(5_000), { signal: controller.signal });
  controller.abort();
  await assert.rejects(abandoned, (err: unknown) => err instanceof PoolBusy && err.why === 'queue_timeout');

  // 2. Fill queue to 75% (3 of 4) with distinct accounts so per-account half-line cap is not hit.
  const q1 = withAdmission('203.0.113.1', () => {
    admitAs('a1');
    return line.enter(5_000);
  });
  const q2 = withAdmission('203.0.113.2', () => {
    admitAs('a2');
    return line.enter(5_000);
  });
  const q3 = withAdmission('203.0.113.3', () => {
    admitAs('a3');
    return line.enter(5_000);
  });

  // A retry (retryAttempt = 1) at >= 75% utilization is shed immediately.
  await assert.rejects(
    withAdmission(
      '203.0.113.4',
      () => {
        admitAs('retry-caller');
        return line.enter(5_000);
      },
      { retryAttempt: 1 },
    ),
    (err: unknown) => err instanceof PoolBusy && err.why === 'queue_full',
  );

  // A fresh first attempt (retryAttempt = 0) still takes the remaining 4th slot.
  const fresh = withAdmission('203.0.113.5', () => {
    admitAs('fresh-caller');
    return line.enter(5_000);
  });

  holding();
  for (const place of [q1, q2, q3, fresh]) (await place)();
});

test('ReplicaSet skips primary spillover when primary is saturated and jitters replica backoff', async () => {
  let primaryReads = 0;
  let saturated = true;
  const primary = {
    query: async () => {
      primaryReads += 1;
      return { rows: [{ ok: true }] };
    },
  };
  const replica = {
    query: async () => {
      throw new PoolBusy('read', 'queue_full');
    },
  };

  let clock = 10_000;
  const set = new ReplicaSet([replica], () => clock, {
    primarySaturated: () => saturated,
    random: () => 0, // 0.75 * REPLICA_BACKOFF_MS
  });

  // Replica busy + primary saturated -> fail fast, never spill onto primary.
  await assert.rejects(
    lagTolerantReads(() =>
      set.read(
        (pool) => pool.query(),
        () => primary.query(),
      ),
    ),
    (err: unknown) => err instanceof PoolBusy,
  );
  assert.equal(primaryReads, 0);

  // Same replica error when primary has headroom -> falls back to primary.
  saturated = false;
  const res = await lagTolerantReads(() =>
    set.read(
      (pool) => pool.query(),
      () => primary.query(),
    ),
  );
  assert.equal(primaryReads, 1);
  assert.deepEqual(res.rows, [{ ok: true }]);

  // Replica backoff is jittered in [0.75x, 1.0x] of REPLICA_BACKOFF_MS (random=0 -> 0.75x).
  set.down(0);
  assert.equal(set.healthy(0), false);
  clock += Math.round(REPLICA_BACKOFF_MS * 0.75);
  assert.equal(set.healthy(0), true);
});

test('event delivery backoff honors Retry-After and EventPublisher pauses during cooldown', async () => {
  const row = { attempts: 1, attempt_limit: 5 } as Parameters<typeof scheduleDeliveryBackoff>[1];
  const policy: EventDeliveryPolicy = {
    source: { appId: 'demo', storeId: 's1', sourceId: 'db' } as EventDeliveryPolicy['source'],
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
  assert.equal(
    scheduleDeliveryBackoff(policy, row, undefined, () => 0),
    500,
  );
  assert.equal(
    scheduleDeliveryBackoff(policy, row, 12_000, () => 0),
    12_000,
  );

  let claims = 0;
  let recordedMinDelay: number | undefined;
  let now = 50_000;
  const store: EventDeliveryStore = {
    policy,
    async discover() {
      return { discovered: 0, pressure: false };
    },
    async claim() {
      claims += 1;
      return {
        deliveryId: 'd1',
        eventId: 'e1',
        leaseToken: 'lease-1',
        destinationId: 'dest',
        serviceId: 'svc',
        idempotencyKey: 'evt-key-1',
        attempts: 1,
        attemptLimit: 5,
        deadline: now + 30_000,
        envelope: {
          id: 'e1',
          name: 'order.created',
          version: 1,
          occurredAt: new Date(now).toISOString(),
          payload: {},
          appId: 'demo',
          sourceId: 'db',
          command: 'createOrder',
          commandVersion: 1,
          receiptId: 'r1',
          actorId: 'u1',
        },
      };
    },
    async complete(_claim: unknown, _outcome: unknown, _code: unknown, _at: number, minDelayMs?: number) {
      recordedMinDelay = minDelayMs;
      return true;
    },
    async close() {},
  } as unknown as EventDeliveryStore;

  const publisher = createEventPublisher(
    store,
    async () => {
      throw Object.assign(new Error('HTTP 429'), { retryAfterMs: 15_000 });
    },
    () => now,
  );

  const first = await publisher.tick();
  assert.equal(first.status, 'unknown');
  assert.equal(recordedMinDelay, 15_000);
  assert.equal(claims, 1);

  // While cooldown is active, tick() returns idle without claiming or hitting the downstream endpoint.
  const second = await publisher.tick();
  assert.equal(second.status, 'idle');
  assert.equal(claims, 1);

  // After cooldown expires, claiming resumes.
  now += 15_000;
  await publisher.tick();
  assert.equal(claims, 2);
});

test('integrationCalls avoids nested retries under outer workflows, enforces retry budget, and marks unclaimed', async () => {
  process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';
  resetIntegrationRetryBudgets();
  const dir = mkdtempSync(join(tmpdir(), 'mistri-retry-int-'));
  const file = join(dir, 'int.db');
  new DatabaseSync(file).close();
  provisionSqliteIntegrations(file);
  const store = await openIntegrationStore({ sqlite: file });
  let unregister: (() => void) | undefined;
  try {
    let attempts = 0;
    const flaky = defineIntegration({
      name: 'flaky',
      secrets: [],
      client: () => ({}),
      actions: {
        ping: {
          input: shape({}),
          output: shape({}),
          async run() {
            attempts += 1;
            const err = Object.assign(new Error('503'), { status: 503, retryAfterMs: 10 });
            throw err;
          },
        },
      },
    });
    const declared = captureIntegrations({ use: [flaky] }, new Map(), (m) => {
      throw new Error(m);
    });
    const runtime = createIntegrationRuntime({
      appId: 'demo-retry',
      declared,
      store,
    });
    unregister = registerIntegrationRuntime(runtime);

    // 1. Under outer workflow/job retries, integrationCalls makes exactly 1 attempt (no 3x3 multiplication).
    const workflowCalls = integrationCalls({
      appId: 'demo-retry',
      tenant: '',
      commandId: 'sync',
      actorId: 'u1',
      idempotencyKey: 'wf-key-0000000001',
      signal: AbortSignal.timeout(5_000),
      declared: { flaky: ['ping'] },
      outerRetries: true,
    });
    await assert.rejects(
      workflowCalls.flaky.ping({}),
      (err: unknown) => err instanceof BusinessCommandExecutionError && err.code === 'temporarily_unavailable',
    );
    assert.equal(attempts, 1, 'outerRetries: true must run exactly 1 attempt');

    // 2. Interactive command runs retries internally and marks exhausted error unclaimed.
    attempts = 0;
    const interactiveCalls = integrationCalls({
      appId: 'demo-retry',
      tenant: '',
      commandId: 'sync',
      actorId: 'u1',
      idempotencyKey: 'ui-key-0000000001',
      signal: AbortSignal.timeout(5_000),
      declared: { flaky: ['ping'] },
      outerRetries: false,
    });
    let captured: unknown;
    try {
      await interactiveCalls.flaky.ping({});
    } catch (err) {
      captured = err;
    }
    assert.ok(captured instanceof BusinessCommandExecutionError);
    assert.equal(attempts, 3, 'interactive call tries up to 3 attempts');
    assert.equal(errorClaimOf(captured), 'unclaimed');
    assert.equal(errorRetryAfterMs(captured), 10);

    // 3. HTTP refusal layers forward x-mistri-error-claim: unclaimed and Retry-After.
    const apiHeaders = refusalHeaders('temporarily_unavailable', captured);
    assert.ok(apiHeaders);
    assert.equal(apiHeaders[ERROR_CLAIM_HEADER], 'unclaimed');
    assert.equal(apiHeaders['retry-after'], '1');
    const httpErr = businessCommandHttpError(captured);
    assert.equal(httpErr.errorClaim, 'unclaimed');
    assert.equal(httpErr.retryAfter, 1);

    // 4. Local row_locked remains claimed with Retry-After.
    const lockHeaders = refusalHeaders('row_locked');
    assert.ok(lockHeaders);
    assert.equal(lockHeaders[ERROR_CLAIM_HEADER], 'claimed');
    assert.equal(lockHeaders['retry-after'], '1');
  } finally {
    unregister?.();
    await store.close();
    resetIntegrationRetryBudgets();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('executeBusinessCommand coalesces concurrent identical idempotency keys and rejects mismatched concurrent input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-coalesce-'));
  const file = join(dir, 'app.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE items(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, title TEXT);
    INSERT INTO items VALUES (1, 0, 'before');`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'db', name: 'db', url: file, writable: true, source: 'config' });
  try {
    let executions = 0;
    let releaseHandler!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const input = { title: { label: 'Title', type: 'text' } } as const;
    const app = parseTestApp(
      {
        id: 'demo',
        name: 'Demo',
        sources: { db: { connection: 'db' } },
        resources: {
          items: {
            access: 'write',
            actions: { rename: { label: 'Rename', command: { id: 'rename', version: 1, target: 'items', input } } },
          },
        },
        auth: { roles: { staff: { read: true, commands: ['rename'] } } },
        views: { items: { kind: 'list', from: 'items' } },
        home: 'items',
        nav: ['items'],
      },
      'coalesce fixture',
    );
    const commands = defineCommands({
      rename: defineCommand({
        source: 'db',
        target: 'items',
        input,
        validate: (v) => ({ title: String(v.title) }),
        output: { parse: (v) => v as { title: string; version: number } },
        async handle({ db: tx, record }, value) {
          executions += 1;
          await gate;
          const updated = await tx.items.update(record, { title: value.title });
          return { title: value.title, version: Number(updated.version) };
        },
      }),
    });
    const resources = await loadAppRuntimeResources(registry, app, 'db');
    const binding = bindBusinessCommands({ app, resources, registry: commands, writableConnection: () => true });
    const actor = { id: 'user-1', appId: 'demo', roles: ['staff'] };
    const req = {
      command: 'rename',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: 0,
      idempotencyKey: 'coalesce-key-000001',
      input: { title: 'after' },
    };

    // Launch two identical requests concurrently + one with same key but different input.
    const first = executeBusinessCommand(binding, actor, req, { door: 'api' });
    await tick();
    const second = executeBusinessCommand(binding, actor, req, { door: 'api' });
    const conflict = executeBusinessCommand(binding, actor, { ...req, input: { title: 'different' } }, { door: 'api' });

    releaseHandler();
    const [r1, r2] = await Promise.all([first, second]);
    await assert.rejects(conflict, (err: unknown) => err instanceof BusinessCommandExecutionError && err.code === 'idempotency_conflict');
    assert.equal(executions, 1, 'concurrent duplicate requests must execute the handler only once');
    assert.equal(r1.replayed, false);
    assert.equal(r2.replayed, true);
    assert.deepEqual(r2.result, r1.result);
  } finally {
    await registry.closeAll();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('workflow engine honors Error Ownership unclaimed (fails fast) and downstream Retry-After', async () => {
  const Ping = defineEvent('demo.ping', shape({ id: text() }));
  let attempts = 0;
  let refusedSeen = false;
  const wf = defineWorkflow({
    runAs: 'worker',
    start: { event: Ping, key: (e) => e.id },
    run: async (w, start) => {
      try {
        return await w.call('ext', 'api', { path: '/go', body: { id: start.id } }, { retry: { attempts: 4, backoff: '1 second' } });
      } catch (err) {
        if (err instanceof StepRefused) {
          refusedSeen = true;
          return { refused: true };
        }
        throw err;
      }
    },
  });

  // 1. Downstream error tagged unclaimed refuses immediately without retrying.
  const driver1 = await createWorkflowDriver({
    workflow: { wf },
    commands: {},
    calls: {
      api: () => {
        attempts += 1;
        throw markErrorOwnership(new Error('upstream exhausted'), 'unclaimed');
      },
    },
  });
  try {
    await driver1.emit(Ping, { id: 'u-1' }, 'e-1');
    const [inst] = await driver1.instances();
    assert.equal(inst.state, 'completed');
    assert.equal(refusedSeen, true);
    assert.equal(attempts, 1, 'unclaimed failure must not be retried by workflow');
  } finally {
    await driver1.close();
  }

  // 2. Downstream Retry-After pushes wakeAt past nominal 1s backoff.
  let seen = 0;
  const driver2 = await createWorkflowDriver({
    workflow: { wf },
    commands: {},
    calls: {
      api: () => {
        seen += 1;
        if (seen === 1) throw markErrorOwnership(new Error('429'), 'claimed', 10_000);
        return { ok: true };
      },
    },
  });
  try {
    await driver2.emit(Ping, { id: 'u-2' }, 'e-2');
    const [waiting] = await driver2.instances();
    assert.equal(waiting.state, 'waiting');
    // Nominal backoff was 1s; Retry-After was 10s so advancing 5s must NOT trigger attempt 2.
    await driver2.advance(5_000);
    assert.equal(seen, 1);
    await driver2.advance(10_000);
    assert.equal(seen, 2);
    const [done] = await driver2.instances();
    assert.equal(done.state, 'completed');
  } finally {
    await driver2.close();
  }
});

test('AI decision circuits lease a single half-open probe, honor Retry-After, and cap Anthropic ask concurrency', async () => {
  resetCircuits();
  try {
    // 1. Single explicit Retry-After pauses provider immediately without waiting for 5 failures.
    recordCall('anthropic', false, 1_000, 15_000);
    assert.equal(circuitClosed('anthropic', 15_999), false);
    assert.equal(circuitClosed('anthropic', 16_000), true);

    // 2. Single-probe half-open trial leasing prevents concurrent probe stampede.
    assert.equal(tryAcquireCircuit('anthropic', 16_000), true);
    assert.equal(tryAcquireCircuit('anthropic', 16_000), false, 'second concurrent caller must not stampede half-open probe');
    assert.equal(circuitClosed('anthropic', 16_000), false);
    releaseCircuitTrial('anthropic');
    assert.equal(tryAcquireCircuit('anthropic', 16_000), true);
    recordCall('anthropic', true, 16_010);
    assert.equal(circuitClosed('anthropic', 16_010), true);

    // 3. failureOfStatus parses Retry-After header onto ProviderFailure.
    const failure = failureOfStatus(429, 'Anthropic', '12');
    assert.ok(failure instanceof ProviderFailure);
    assert.equal(failure.kind, 'busy');
    assert.equal(failure.retryAfterMs, 12_000);

    // 4. anthropicDecisions caps concurrent asks at 4 for a batch of 10 asks.
    let inFlight = 0;
    let peakInFlight = 0;
    const provider = anthropicDecisions('test-key', async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight -= 1;
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
      id: `d-${i}`,
      question: `Q${i}?`,
      inputs: { i },
      answer: { kind: 'bool' as const },
    }));
    const result = await provider.decide({ asks, signal: AbortSignal.timeout(5_000) });
    assert.equal(result.replies.length, 10);
    assert.ok(peakInFlight <= 4, `expected peak concurrency <= 4, got ${peakInFlight}`);
    assert.ok(peakInFlight >= 2, `expected concurrent execution, got ${peakInFlight}`);
  } finally {
    resetCircuits();
  }
});
