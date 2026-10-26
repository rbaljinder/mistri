import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { copyFileSync, renameSync, rmSync } from 'node:fs';
import { TransactionOperations } from '../packages/engine/src/adapters/adapter.js';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import { COMMAND_EVENT_TABLES } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { EVENT_DELIVERY_TABLES } from '../packages/mistri/src/adapters/events/eventDeliverySchema.js';
import type { CommandEventEnvelope } from '../packages/mistri/src/adapters/events/commandEventTypes.js';
import { defineCommand, defineCommands, withCommandVersions } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { bool, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineExperimentConversion } from '../packages/mistri/src/server/experiments/declarations.js';
import {
  createExperimentConversionRegistry,
  experimentDeliveryPolicy,
} from '../packages/mistri/src/server/experiments/conversionRegistry.js';
import {
  openPostgresExperimentConversionOwner,
  openSqliteExperimentConversionOwner,
} from '../packages/mistri/src/server/experiments/conversionOwner.js';
import { createTenantExperimentConversionAuthority } from '../packages/mistri/src/server/tenant/experimentConversionAuthority.js';
import {
  activateExperimentConversionProducer,
  createExperimentConversionTransport,
} from '../packages/mistri/src/server/experiments/conversionTransport.js';
import { openExperimentProducerHost, provisionExperimentSource } from '../packages/mistri/src/server/experiments/producerHost.js';
import { identifyEpoch, type ExperimentEpoch, type ExperimentStore } from '../packages/mistri/src/server/experiments/contracts.js';
import { openPostgresExperimentStore, provisionPostgresExperimentStore } from '../packages/mistri/src/server/experiments/storePostgres.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { openPostgresTenantReadSource } from '../packages/mistri/src/server/tenant/tenantReadSource.js';
import { TENANT_TABLES, type TenantStoreAdministration } from '../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { mapScopeCatalog } from '../packages/engine/src/shared/scopeCatalog.js';
import { eventDeliveryFixture, eventDeliveryPolicy } from './support/eventDeliveryFixture.js';
import { beginPostgresSeed, deliveryEngines } from './support/eventDeliveryEngines.js';
import { ownedPostgresDatabase, pgControl } from './support/jobStoreEngines.js';
import { openTenantEngine, uuidPostgresDatabase } from './support/tenantDialects.js';

function declaration(scope: 'app' | 'tenant' = 'tenant', multi = false) {
  const base = eventDeliveryPolicy(1, scope);
  const event = defineEvent('assignment.fact-0', shape({ assigned: bool() }));
  const conversion = defineExperimentConversion({ id: 'assigned', on: event, unit: { kind: 'subject', source: 'actor' } });
  const commands = withCommandVersions(
    defineCommands({
      assign: defineCommand({
        source: 'business',
        target: 'effects',
        output: { parse: (value) => value as { assigned: boolean } },
        events: { assignment: defineEventProjection(event, (value: { assigned: boolean }) => value) },
        handle() {
          return { assigned: true };
        },
      }),
    }),
    () => 2,
  );
  const registry = createExperimentConversionRegistry({
    commands,
    conversions: [
      conversion,
      ...(multi
        ? [
            defineExperimentConversion({
              id: 'adverse',
              on: event,
              unit: { kind: 'subject', source: 'actor' },
            }),
          ]
        : []),
    ],
  });
  const epochDeclaration: ExperimentEpoch = {
    scope: {
      appId: base.source.appId,
      environment: 'production',
      controlTenantId: null,
      evaluationTenantId: scope === 'tenant' ? 'north' : null,
    },
    flagId: 'assignment',
    version: 'v1',
    owner: 'team',
    unit: 'subject',
    control: 'a',
    arms: [
      { id: 'a', value: 'a', weight: 50 },
      { id: 'b', value: 'b', weight: 50 },
    ],
    eligibility: { rollout: 100, audiences: {} },
    startsAtMs: Date.parse('2026-09-08T00:00:00.000Z'),
    endsAtMs: Date.parse('2026-09-09T00:00:00.000Z'),
    conversionWindowMs: 86_400_000,
    deliveryGraceMs: 86_400_000,
    primary: { id: 'assigned', event: event.name, eventVersion: event.version, unitField: 'actorId' },
    guardrails: multi ? [{ id: 'adverse', event: event.name, eventVersion: event.version, unitField: 'actorId', maxIncrease: 0.1 }] : [],
  };
  const binding = { suiteId: 'suite', deploymentId: 'deployment' },
    epoch = identifyEpoch(binding, epochDeclaration);
  const policy = experimentDeliveryPolicy(registry, {
    epoch,
    source: base.source,
    serviceId: base.serviceId,
    commandIds: ['assign'],
    evaluationTenantId: epochDeclaration.scope.evaluationTenantId,
    limits: { ...base.limits, leaseMs: 20_000, timeoutMs: 10_000 },
  });
  const enrollment = { source: policy.source, producerId: 'assignment-producer', correlationNamespace: 'assignment-facts' };
  return { epoch, policy, registry, binding, enrollment, maxClockSkewMs: 1000 };
}
const pgEngine = deliveryEngines.find((engine) => engine.name === 'postgres')!;

async function nativeAuthority(t: TestContext, config: ReturnType<typeof declaration>, url: string) {
  const binding = {
    appId: config.policy.source.appId,
    storeId: config.policy.source.storeId,
    source: { id: 'business', connection: 'source' },
  };
  await migratePostgresTenantStore(url, binding);
  const control = await pgControl(url);
  t.after(async () => {
    for (const name of Object.values(TENANT_TABLES)) await control.query(`DROP TABLE IF EXISTS public."${name}" CASCADE`);
    await control.end();
  });
  await control.query("ALTER TABLE public.delivery_fixture_effects ADD COLUMN tenant_id text NOT NULL DEFAULT 'north'");
  const administer = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
    await control.query('BEGIN');
    const operations = new TransactionOperations();
    try {
      await run(createPostgresTenantAdministration(control, operations, binding));
      await operations.finish();
      await control.query('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      await control.query('ROLLBACK');
      throw error;
    }
  };
  await administer(async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  const adapter = new PostgresAdapter(url, 'Native conversion owner fixture');
  const physicalSchema = await adapter.introspect();
  await adapter.close();
  const logical = mapScopeCatalog(physicalSchema, new Map([['public.delivery_fixture_effects', 'effects']]));
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: { ...logical, tables: logical.tables.map((table) => ({ ...table, name: table.id, schema: '' })) },
    resources: { effects: 'public.delivery_fixture_effects' },
    ownership: { effects: { kind: 'tenant', column: 'tenant_id' } },
  });
  const reader = await openPostgresTenantReadSource(url, ownership, binding);
  const authority = createTenantExperimentConversionAuthority({ ...config, reader });
  t.after(async () => {
    authority.close();
    await reader.close();
  });
  return {
    ...authority,
    suspend: () => administer((admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' })),
  };
}

async function liveFixture(t: TestContext, scope: 'app' | 'tenant' = 'tenant', multi = false) {
  const config = declaration(scope, multi),
    source = await pgEngine.fixture(t, config.policy),
    url = await ownedPostgresDatabase();
  const resultDatabase = await uuidPostgresDatabase('experiment_owner');
  t.after(() => resultDatabase.drop());
  await provisionPostgresExperimentStore({ url: resultDatabase.url, binding: config.binding });
  const durable = await openPostgresExperimentStore({ url: resultDatabase.url, binding: config.binding });
  await durable.registerEpoch(config.epoch.declaration, () => {});
  let retired = false,
    now = 1000,
    mode: 'up' | 'down' | 'lost-ack' = 'up';
  let beforeResults: (() => Promise<void>) | undefined;
  const authority = scope === 'tenant' ? await nativeAuthority(t, config, url) : undefined;
  const owner = await openPostgresExperimentConversionOwner({
    ...config,
    url,
    authorize:
      authority?.authorize ??
      (async (request) => {
        assert.equal(request.serviceId, config.policy.serviceId);
        assert.equal(request.destinationId, config.policy.destinationId);
        return () => {
          assert.equal(retired, false, 'Deployment authority revoked');
        };
      }),
  });
  const store: ExperimentStore = {
    ...durable,
    async ingestConversion(...args) {
      if (mode === 'down') throw new Error('Result store unavailable');
      const result = await durable.ingestConversion(...args);
      if (mode === 'lost-ack') throw new Error('Lost response after durable COMMIT');
      return result;
    },
    async publishResults(...args) {
      await beforeResults?.();
      return durable.publishResults(...args);
    },
  };
  const options = { ...config, store, owner, clock: () => now };
  const bridge = await createExperimentConversionTransport(options);
  t.after(async () => {
    await owner.close();
    await durable.close();
    await resultDatabase.drop();
  });
  const publication = (envelope: CommandEventEnvelope) => ({
    envelope,
    destinationId: config.policy.destinationId,
    serviceId: config.policy.serviceId,
    idempotencyKey: envelope.eventId,
    signal: new AbortController().signal,
    deadline: now + 10_000,
  });
  const coverage = () =>
    settled(async () => {
      const lease = await owner.captureCompleteness({
        epoch: config.epoch,
        policy: config.policy,
        dataRevision: await durable.readDataRevision(config.epoch),
      });
      try {
        await lease.reobserve();
        return lease.delivery;
      } finally {
        await lease.release?.();
      }
    });
  return {
    config,
    source,
    url,
    owner,
    durable,
    options,
    bridge,
    publication,
    coverage,
    authority,
    revoke: () => {
      retired = true;
      authority?.close();
    },
    mode: (value: typeof mode) => {
      mode = value;
    },
    clock: (value: number) => {
      now = value;
    },
    beforeResults: (callback: typeof beforeResults) => {
      beforeResults = callback;
    },
  };
}

/* The owner reads the source's in-flight writers between capture and reobserve, and the fixture's own tenant
   authority can still be one of them: PostgreSQL's readSnapshot answers before its COMMIT. The owner then refuses,
   safely — a coverage changed under it — and a refused capture or publish changes nothing, so a question this suite
   asks once in passing is asked once more after that refusal, and only that one. The fence itself stays as strict as
   the 'results fence' test below holds it, which calls the owner directly and expects the refusal. */
async function settled<T>(ask: () => Promise<T>): Promise<T> {
  try {
    return await ask();
  } catch (error) {
    if (!/watermark or destination coverage changed/.test((error as Error).message)) throw error;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return ask();
  }
}

for (const scope of ['app', 'tenant'] as const)
  test(`native SQLite ${scope} owner proves exact receipt/audit and holds source fence`, async (t) => {
    const config = declaration(scope),
      f = eventDeliveryFixture(t, config.policy);
    const owner = await openSqliteExperimentConversionOwner({ ...config, path: f.path, authorize: async () => () => {} });
    t.after(() => owner.close());
    const [event] = await f.seed(),
      observed = await owner.observeCommittedActor(event);
    assert.equal(observed.subjectId, 'native-account-proof');
    assert.equal(observed.realm, scope);
    await observed.reobserve();
    for (const patch of [
      { actorId: 'forged' },
      { receiptId: 'absent' },
      { commandVersion: 3 },
      { occurredAt: '2026-09-08T13:00:00.000Z' },
      { scope: 'app', tenantId: null },
      { payloadJson: '{"assigned":false}' },
    ]) {
      if (scope === 'app' && patch.scope === 'app') continue;
      await assert.rejects(owner.observeCommittedActor({ ...event, ...patch } as CommandEventEnvelope));
    }
    const lease = await owner.captureCompleteness({ epoch: config.epoch, policy: config.policy, dataRevision: 0 });
    assert.equal(lease.delivery.pending, 1);
    assert.equal(lease.delivery.incomplete, 0, 'exposure coverage is merged by the results store');
    await lease.reobserve();
    assert.throws(() => f.db.exec('BEGIN IMMEDIATE'), /locked/);
    await lease.release?.();
    await assert.rejects(async () => lease.reobserve());
    await f.seed('next');
    await owner.close();
    await assert.rejects(owner.observeCommittedActor(event));
  });

test(
  'native PostgreSQL bridge: rollback, undiscovered backlog, outage, partial multi-metric ACK loss and replay',
  { skip: pgEngine.skip },
  async (t) => {
    const o = await liveFixture(t, 'tenant', true);
    const rolledBack = await beginPostgresSeed(o.config.policy, 'rollback');
    await rolledBack.rollback();
    assert.equal(await o.source.executions(), 0);
    assert.equal((await o.coverage()).pending, 0);
    const [event] = await o.source.seed();
    assert.equal((await o.coverage()).pending, 1, 'empty destination is not complete');
    assert.equal((await settled(() => o.bridge.publishResults())).statistics.finalized, false);
    const first = await activateExperimentConversionProducer(await o.source.open(), o.options);
    o.mode('down');
    assert.equal((await first.producer.tick()).status, 'unknown');
    assert.equal(await o.durable.readDataRevision(o.config.epoch), 0);
    assert.equal(await o.source.executions(), 1);
    o.mode('lost-ack');
    o.clock(1010);
    assert.equal((await first.producer.tick()).status, 'unknown');
    assert.equal(await o.durable.readDataRevision(o.config.epoch), 1, 'first metric committed; second metric unacknowledged');
    assert.equal((await o.coverage()).pending, 1);
    await first.producer.stop();
    o.mode('up');
    o.clock(1030);
    const restarted = await activateExperimentConversionProducer(await o.source.open(), o.options);
    t.after(() => restarted.producer.stop());
    assert.equal((await restarted.producer.tick()).status, 'accepted');
    assert.equal(await o.durable.readDataRevision(o.config.epoch), 2);
    assert.equal((await o.coverage()).pending, 0);
    assert.equal(await o.source.executions(), 1);
    await o.bridge.transport(o.publication(event));
    assert.equal(await o.durable.readDataRevision(o.config.epoch), 2);
    const result = await settled(() => o.bridge.publishResults());
    assert.equal(result.diagnostics.pendingConversions, 2);
    assert.equal(result.delivery.incomplete, 0);
    assert.equal(result.statistics.finalized, false);
  },
);

test('native PostgreSQL App scope and revoked commit authority refuse forged provenance', { skip: pgEngine.skip }, async (t) => {
  const o = await liveFixture(t, 'app'),
    [event] = await o.source.seed();
  assert.equal((await o.owner.observeCommittedActor(event)).realm, 'app');
  assert.equal((await o.coverage()).pending, 1);
  for (const patch of [
    { actorId: 'public:application' },
    { actorId: 'service:worker' },
    { commandVersion: 99 },
    { storeId: 'other' },
    { occurredAt: '2026-09-08T12:01:00.000Z' },
    { receiptId: 'missing' },
  ]) {
    await assert.rejects(o.owner.observeCommittedActor({ ...event, ...patch }));
  }
  const observation = await o.owner.observeCommittedActor(event);
  o.revoke();
  await assert.rejects(async () => observation.reobserve(), /authority revoked/);
  await assert.rejects(o.bridge.transport(o.publication(event)), /authority revoked/);
  await assert.rejects(o.bridge.publishResults(), /authority revoked/);
  assert.equal(await o.durable.readDataRevision(o.config.epoch), 0);
});

test('native PostgreSQL late transaction cannot pass a source high-watermark fence', { skip: pgEngine.skip }, async (t) => {
  const o = await liveFixture(t),
    early = await beginPostgresSeed(o.config.policy, 'early');
  // A later transaction can commit first: a MAX(transaction ID) cursor alone
  // would incorrectly certify that all earlier facts had been observed.
  await o.source.seed('later');
  await assert.rejects(o.coverage(), /lock timeout/);
  await early.commit();
  assert.equal((await o.coverage()).pending, 2);
  const client = await pgControl(o.url);
  t.after(() => client.end());
  await client.query('BEGIN');
  await client.query('SELECT 1');
  const lease = await o.owner.captureCompleteness({ epoch: o.config.epoch, policy: o.config.policy, dataRevision: 0 });
  try {
    assert.ok(lease.delivery.incomplete > 0, 'pre-journal writer is unresolved');
    await client.query('ROLLBACK');
    await assert.rejects(async () => lease.reobserve(), /watermark or destination coverage changed/);
  } finally {
    await lease.release?.();
  }
});

test('native PostgreSQL results fence rejects advancing writers and releases locks after rollback', { skip: pgEngine.skip }, async (t) => {
  const o = await liveFixture(t);
  await o.source.seed();
  const writer = await pgControl(o.url);
  t.after(() => writer.end());
  o.beforeResults(async () => {
    await writer.query('BEGIN');
    await writer.query('SELECT 1');
  });
  await assert.rejects(o.bridge.publishResults(), /watermark or destination coverage changed/);
  await writer.query('ROLLBACK');
  o.beforeResults(undefined);
  await o.source.seed('after-failed-publication');
  assert.equal((await o.coverage()).pending, 2);
  o.beforeResults(async () => {
    await o.durable.ingestExposure(
      o.config.epoch,
      { unit: { kind: 'subject', id: 'native-account-proof' }, arm: 'a', usedAtMs: o.config.epoch.declaration.startsAtMs },
      () => {},
    );
  });
  await assert.rejects(o.bridge.publishResults(), /revision|conflict|changed/i);
  o.beforeResults(undefined);
  const result = await o.bridge.publishResults();
  assert.equal(result.evidenceRevision, 1, 'failed evidence publication rolled back');
  assert.equal(result.dataRevision, 1);
});

test('native PostgreSQL tenant anchor suspension revokes committed-actor and results leases', { skip: pgEngine.skip }, async (t) => {
  const o = await liveFixture(t),
    [event] = await o.source.seed();
  const observed = await o.owner.observeCommittedActor(event);
  const lease = await o.owner.captureCompleteness({ epoch: o.config.epoch, policy: o.config.policy, dataRevision: 0 });
  try {
    await o.authority!.suspend();
    await assert.rejects(async () => observed.reobserve(), /authority changed/);
    await assert.rejects(async () => lease.reobserve(), /authority changed/);
  } finally {
    await lease.release?.();
  }
  await assert.rejects(o.bridge.transport(o.publication(event)), /anchors are inactive/);
  assert.equal(await o.durable.readDataRevision(o.config.epoch), 0);
});

test('native PostgreSQL source outage invalidates a captured proof before result commit', { skip: pgEngine.skip }, async (t) => {
  const o = await liveFixture(t),
    control = await pgControl(o.url);
  t.after(() => control.end());
  o.beforeResults(async () => {
    const killed = await control.query(`SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity
      WHERE datname=current_database() AND application_name='mistri-experiment-conversion-owner'`);
    assert.equal(killed.rows.length, 1);
    assert.equal(killed.rows[0].killed, true);
  });
  await assert.rejects(o.bridge.publishResults());
  o.beforeResults(undefined);
  const result = await o.bridge.publishResults();
  assert.equal(result.evidenceRevision, 1);
  assert.equal(result.statistics.status, 'final-blocked');
});

test(
  'native PostgreSQL failed delivery, retention gap and bounded scan cannot certify final evidence',
  { skip: pgEngine.skip },
  async (t) => {
    const o = await liveFixture(t);
    await o.source.seed();
    const activated = await activateExperimentConversionProducer(await o.source.open(), o.options);
    t.after(() => activated.producer.stop());
    o.mode('down');
    for (const now of [1000, 1010, 1030]) {
      o.clock(now);
      assert.equal((await activated.producer.tick()).status, 'unknown');
    }
    assert.equal((await o.coverage()).failed, 1);
    assert.equal((await o.bridge.publishResults()).statistics.finalized, false);
    // A separate receipt succeeds, then its ACK rows are pruned by the actual
    // outbox retention operation. The permanent marker must become a gap.
    o.mode('up');
    o.clock(1040);
    await o.source.seed('delivered');
    assert.equal((await activated.producer.tick()).status, 'accepted');
    const delivery = await o.source.open();
    await delivery.prune(0, 2000, 10);
    assert.ok((await o.coverage()).incomplete > 0);
    const bounded = await openPostgresExperimentConversionOwner({
      ...o.config,
      url: o.url,
      maxReceipts: 1,
      authorize: async () => () => {},
    });
    try {
      const lease = await bounded.captureCompleteness({
        epoch: o.config.epoch,
        policy: o.config.policy,
        dataRevision: await o.durable.readDataRevision(o.config.epoch),
      });
      try {
        assert.ok(lease.delivery.incomplete >= 2);
      } finally {
        await lease.release?.();
      }
    } finally {
      await bounded.close();
    }
  },
);

test('SQLite native owner detects missing receipt batch and tampered committed audit', async (t) => {
  const config = declaration(),
    f = eventDeliveryFixture(t, config.policy);
  const owner = await openSqliteExperimentConversionOwner({ ...config, path: f.path, authorize: async () => () => {} });
  t.after(() => owner.close());
  const [event] = await f.seed();
  f.db.prepare('UPDATE __mistri_command_receipt SET actor_id=? WHERE id=?').run('different-subject', event.receiptId);
  await assert.rejects(owner.observeCommittedActor(event));
  await assert.rejects(owner.captureCompleteness({ epoch: config.epoch, policy: config.policy, dataRevision: 0 }));
  f.db.prepare('UPDATE __mistri_command_receipt SET actor_id=? WHERE id=?').run(event.actorId, event.receiptId);
  f.db.prepare(`DELETE FROM "${COMMAND_EVENT_TABLES.event}" WHERE receipt_id=?`).run(event.receiptId);
  await assert.rejects(owner.captureCompleteness({ epoch: config.epoch, policy: config.policy, dataRevision: 0 }));
  assert.equal(f.db.prepare(`SELECT count(*) AS count FROM "${EVENT_DELIVERY_TABLES.delivery}"`).get()!.count, 0);
});

test('SQLite native source identity stays pinned between observation transactions', async (t) => {
  const config = declaration(),
    f = eventDeliveryFixture(t, config.policy);
  const owner = await openSqliteExperimentConversionOwner({ ...config, path: f.path, authorize: async () => () => {} });
  t.after(() => owner.close());
  const [event] = await f.seed(),
    observation = await owner.observeCommittedActor(event);
  const previous = `${f.path}.previous`;
  renameSync(f.path, previous);
  copyFileSync(previous, f.path);
  try {
    await assert.rejects(async () => observation.reobserve());
  } finally {
    rmSync(f.path);
    renameSync(previous, f.path);
  }
  await observation.reobserve();
});

test('native tenant service authority uses genuine anchors and refuses suspension, replacement and retirement', async (t) => {
  const config = declaration(),
    binding = {
      appId: config.policy.source.appId,
      storeId: config.policy.source.storeId,
      source: { id: 'business', connection: 'source' },
    };
  const engine = await openTenantEngine('sqlite', {
    database: 'unused',
    tables: ['db_item'],
    postgres: '',
    sqlite: 'CREATE TABLE db_item(id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL)',
  });
  await engine.provisionStore(binding);
  await engine.maintenance(binding, async (admin) => {
    await admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: null });
    await admin.putPlatform({ status: 'active', expectedVersion: null });
  });
  const physicalSchema = await engine.physicalSchema(),
    resources = { item: 'db_item' };
  const logical = mapScopeCatalog(physicalSchema, new Map([['db_item', 'item']]));
  const ownership = captureTenantOwnership({
    appId: binding.appId,
    source: binding.source,
    physicalSchema,
    schema: { ...logical, tables: logical.tables.map((table) => ({ ...table, name: table.id, schema: '' })) },
    resources,
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
  const reader = await engine.openRead(ownership, binding);
  t.after(async () => {
    await reader.close();
    await engine.close();
  });
  const authority = createTenantExperimentConversionAuthority({ ...config, reader });
  const request = {
    operation: 'observe' as const,
    serviceId: config.policy.serviceId,
    destinationId: config.policy.destinationId,
    source: config.policy.source,
    epoch: config.epoch,
  };
  const guard = await authority.authorize(request);
  await guard();
  await assert.rejects(authority.authorize({ ...request, serviceId: 'foreign' }));
  await engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'north', status: 'suspended', expectedVersion: '1' }));
  await assert.rejects(async () => guard(), /authority changed/);
  await assert.rejects(authority.authorize(request), /anchors are inactive/);
  await engine.maintenance(binding, (admin) => admin.putTenant({ tenantId: 'north', status: 'active', expectedVersion: '2' }));
  await assert.rejects(async () => guard(), /authority changed/);
  const resumed = await authority.authorize(request);
  await resumed();
  authority.close();
  await assert.rejects(async () => resumed(), /authority retired/);
  assert.throws(() => createTenantExperimentConversionAuthority({ ...config, reader: { ...reader } }));
});

/* A visitor converts on an App's own public form and on a tenant's public intake alike: the tenant's journal
   carries the same audit envelope, and the conversion is attributed in that tenant's epoch. */
for (const scope of ['app', 'tenant'] as const)
  test(`native SQLite ${scope} visitor conversion proves same-transaction audit provenance without payload identity`, async (t) => {
    const subject = declaration(scope);
    const event = defineEvent('assignment.fact-0', shape({ assigned: bool() }));
    const commands = withCommandVersions(
      defineCommands({
        assign: defineCommand({
          source: 'business',
          target: 'effects',
          targets: 'none',
          public: true,
          output: { parse: (value) => value as { assigned: boolean } },
          events: { assignment: defineEventProjection(event, (value: { assigned: boolean }) => value) },
          handle() {
            return { assigned: true };
          },
        }),
      }),
      () => 2,
    );
    const registry = createExperimentConversionRegistry({
      commands,
      conversions: [defineExperimentConversion({ id: 'assigned', on: event, unit: { kind: 'visitor', source: 'public-intake' } })],
    });
    const epoch = identifyEpoch(subject.binding, {
      ...subject.epoch.declaration,
      unit: 'visitor',
      primary: { ...subject.epoch.declaration.primary, unitField: 'visitorId' },
    });
    const policy = experimentDeliveryPolicy(registry, {
      epoch,
      source: subject.policy.source,
      serviceId: subject.policy.serviceId,
      commandIds: ['assign'],
      evaluationTenantId: subject.epoch.declaration.scope.evaluationTenantId,
      limits: subject.policy.limits,
    });
    const config = { ...subject, epoch, policy, registry },
      f = eventDeliveryFixture(t, policy);
    const owner = await openSqliteExperimentConversionOwner({ ...config, path: f.path, authorize: async () => () => {} });
    t.after(() => owner.close());
    const wrapped = (id: string) => JSON.stringify({ format: 'mistri.visitor-audit.v1', changes: [], visitor: { kind: 'visitor', id } });
    const [eventWithVisitor] = await f.seed('visitor', policy.routes[0], {
      actorId: 'public:apply',
      changesJson: wrapped('opaque-visitor'),
    });
    const observed = await owner.observeCommittedActor(eventWithVisitor);
    assert.equal(observed.visitorId, 'opaque-visitor');
    assert.equal(observed.subjectId, undefined);
    await observed.reobserve();
    f.db
      .prepare(
        `UPDATE "${(await import('../packages/mistri/src/adapters/commands/commandJournal.js')).COMMAND_JOURNAL_TABLES.receipt}" SET changes_json=json_array(?) WHERE id=?`,
      )
      .run(wrapped('changed-visitor'), 'visitor');
    await assert.rejects(async () => {
      await observed.reobserve();
    }, /provenance changed/);
    const [anonymous] = await f.seed('anonymous', policy.routes[0], { actorId: 'public:apply', changesJson: '[]' });
    assert.equal((await owner.observeCommittedActor(anonymous)).visitorId, null, 'unconsented intake never fabricates a unit');
    const [privateActor] = await f.seed('private-actor');
    await assert.rejects(owner.observeCommittedActor(privateActor), /public intake actor/);
  });

test(
  'configured producer opens a provisioned source, drains committed conversion and publishes evidence',
  { skip: pgEngine.skip },
  async (t) => {
    const o = await liveFixture(t, 'app');
    const source = {
      appId: o.config.epoch.declaration.scope.appId,
      flagId: o.config.epoch.declaration.flagId,
      tenantId: null,
      sourceId: o.config.policy.source.sourceId,
      storeId: o.config.policy.source.storeId,
      commandIds: ['assign'],
      maxClockSkewMs: 1000,
      url: o.url,
    };
    await provisionExperimentSource(source, o.config.epoch, o.config.registry);
    const host = await openExperimentProducerHost({
      source,
      epoch: o.config.epoch,
      registry: o.config.registry,
      store: o.durable,
      authorize: async () => () => {},
    });
    t.after(() => host.close());
    await o.source.seed();
    await host.tick();
    assert.equal(host.status(), 'idle');
    assert.equal(await o.durable.readDataRevision(o.config.epoch), 1);
    const result = await o.durable.readResults(o.config.epoch);
    assert.equal(result.diagnostics.pendingConversions, 1);
    assert.equal(result.statistics.complete, false);
    await host.close();
    assert.equal(host.status(), 'stopped');
  },
);
