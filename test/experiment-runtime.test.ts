import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { FlagOverride } from '../packages/mistri/src/shared/appFlags.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { bool, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { captureAppFlagCatalog } from '../packages/mistri/src/server/flags/appCatalog.js';
import {
  ExperimentConflict,
  ExperimentExposurePending,
  identifyEpoch,
  type ExperimentStore,
  type ExposureFact,
  type RegisteredEpoch,
} from '../packages/mistri/src/server/experiments/contracts.js';
import { defineExperimentConversion } from '../packages/mistri/src/server/experiments/declarations.js';
import { createExperimentConversionRegistry } from '../packages/mistri/src/server/experiments/conversionRegistry.js';
import { createExperimentRuntime, type ExperimentRequestObservation } from '../packages/mistri/src/server/experiments/runtime.js';

const start = Date.parse('2026-11-01T00:00:00.000Z'),
  end = Date.parse('2026-11-15T00:00:00.000Z');
const active: FlagOverride = {
  experiment: {
    version: 'v1',
    weights: [
      { value: 'a', weight: 50 },
      { value: 'b', weight: 50 },
    ],
  },
};
function fixture(tenantApp = false) {
  const event = defineEvent('application.submitted', shape({ success: bool() }));
  const conversion = defineExperimentConversion({ id: 'submitted', on: event, unit: { kind: 'subject', source: 'actor' } });
  const commands = defineCommands({
    submit: defineCommand({
      source: 'business',
      target: 'item',
      output: { parse: (value) => value as { success: boolean } },
      events: { submitted: defineEventProjection(event, (value: { success: boolean }) => value) },
      handle() {
        return { success: true };
      },
    }),
  });
  const conversions = createExperimentConversionRegistry({ conversions: [conversion], commands });
  const app = parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      sources: { business: { connection: 'db' } },
      resources: { item: { access: 'write', ...(tenantApp ? { owner: 'tenant' } : {}) } },
      views: { items: { kind: 'list', from: 'item' } },
      home: 'items',
      flags: { copy: { type: 'string', default: 'a', safeValue: 'safe', variants: ['a', 'b'], owner: 'team', tenantManaged: true } },
      audiences: {
        east: { roles: ['member'], attributes: { emailDomain: ['east.example'] }, ...(tenantApp ? { tenants: ['north'] } : {}) },
      },
      experiments: {
        copy: {
          version: 'v1',
          unit: 'subject',
          control: 'a',
          startsAt: new Date(start).toISOString(),
          endsAt: new Date(end).toISOString(),
          conversionWindow: '48 hours',
          deliveryGrace: '24 hours',
          eligibility: { rollout: 100, audiences: ['east'] },
          allocation: [
            { value: 'a', weight: 50 },
            { value: 'b', weight: 50 },
          ],
          primary: { conversion: 'submitted' },
        },
      },
      auth: {
        ...(tenantApp ? { rows: 'tenant', tenancy: { platform: { label: 'Platform' } } } : {}),
        roles: {
          member: { read: true, ...(tenantApp ? { realm: 'tenant' } : {}) },
          ops: { read: false, ...(tenantApp ? { realm: 'platform' } : {}) },
        },
      },
    },
    'AN2 runtime',
  );
  const graph = captureAppFlagCatalog(app, commands),
    epochs = new Map<string, RegisteredEpoch>(),
    exposures: ExposureFact[] = [];
  let now = start + 1000,
    revoked = false,
    registrations = 0,
    enrollments = 0;
  let fault: 'enroll' | 'ingest' | undefined;
  const binding = { suiteId: 'suite', deploymentId: 'deployment' };
  const store = {
    binding,
    async registerEpoch(epoch, guard) {
      const pinned = identifyEpoch(binding, epoch),
        existing = epochs.get(pinned.key);
      if (existing && existing.fingerprint !== pinned.fingerprint) throw new ExperimentConflict();
      await guard();
      registrations++;
      epochs.set(pinned.key, pinned);
      return pinned;
    },
    async readEpoch(reference) {
      const value = epochs.get(reference.key);
      if (!value || value.fingerprint !== reference.fingerprint) throw new ExperimentConflict();
      return value;
    },
    async enrollExposure(_reference, _assignment, guard) {
      await guard();
      if (fault === 'enroll') throw new Error('enrollment unavailable');
      enrollments++;
    },
    async ingestExposure(_reference, fact, guard) {
      await guard();
      if (fault === 'ingest') throw new Error('ingestion unavailable');
      exposures.push(fact);
      return { status: 'inserted', dataRevision: exposures.length, late: false };
    },
  } satisfies Pick<ExperimentStore, 'binding' | 'registerEpoch' | 'readEpoch' | 'ingestExposure' | 'enrollExposure'>;
  const runtime = createExperimentRuntime({
    appId: app.id,
    environment: 'production',
    graph,
    conversions,
    store: store as ExperimentStore,
    clock: () => now,
  });
  const scope = { controlTenantId: null, evaluationTenantId: tenantApp ? 'north' : null };
  const reobserve = () => {
    if (revoked) throw new Error('Native owner revoked');
  };
  const observation = (): ExperimentRequestObservation => ({
    appId: app.id,
    environment: 'production',
    evaluationTenantId: scope.evaluationTenantId,
    realm: tenantApp ? 'tenant' : 'app',
    context: { identity: { kind: 'subject', id: 'subject-verified' }, roles: ['member'], attributes: { emailDomain: 'east.example' } },
    snapshots: {
      global: { appId: app.id, environment: 'production', tenantId: null, revision: 3, overrides: { copy: active } },
      tenant: tenantApp ? { appId: app.id, environment: 'production', tenantId: 'north', revision: 4, overrides: {} } : null,
    },
    reobserve,
  });
  return {
    event,
    conversion,
    commands,
    conversions,
    graph,
    app,
    runtime,
    epochs,
    exposures,
    scope,
    observation,
    reobserve,
    setFault: (value: typeof fault) => {
      fault = value;
    },
    enrollments: () => enrollments,
    registrations: () => registrations,
    setTime: (value: number) => {
      now = value;
    },
    revoke: () => {
      revoked = true;
    },
  };
}

test('conversion authoring requires genuine event handles and closed actor provenance', () => {
  const f = fixture();
  assert.throws(() => defineExperimentConversion({ id: 'forged', on: { ...f.event }, unit: { kind: 'subject', source: 'actor' } }));
  for (const unit of [
    { kind: 'subject', source: 'payload', field: 'subjectId' },
    { kind: 'subject', field: 'actorId' },
    { kind: 'visitor', source: 'actor' },
    { kind: 'subject', source: 'actor', field: 'claimedSubject' },
  ]) {
    assert.throws(() => defineExperimentConversion({ id: 'forged', on: f.event, unit } as never));
  }
  assert.throws(() => createExperimentConversionRegistry({ conversions: [{ ...f.conversion }], commands: f.commands }));
  assert.throws(() => createExperimentConversionRegistry({ conversions: [f.conversion, f.conversion], commands: f.commands }));
  let invoked = false;
  assert.throws(() =>
    defineExperimentConversion({
      id: 'getter',
      on: f.event,
      get unit() {
        invoked = true;
        return { kind: 'subject', source: 'actor' };
      },
    } as never),
  );
  assert.equal(invoked, false);
});

test('epoch registration precedes control activation, pins both scopes, and grants no exposure', async () => {
  const f = fixture(true);
  let committed = false;
  await f.runtime.activate(
    { flagId: 'copy', scope: f.scope, override: active },
    {
      reobserve: f.reobserve,
      async commitControl(epoch, override) {
        assert.ok(f.epochs.has(epoch.key));
        assert.equal(f.registrations(), 1);
        assert.equal(epoch.declaration.scope.controlTenantId, null);
        assert.equal(epoch.declaration.scope.evaluationTenantId, 'north');
        assert.equal(epoch.declaration.primary.unitField, 'actorId');
        assert.deepEqual(override, active);
        committed = true;
      },
    },
  );
  assert.equal(committed, true);
  assert.equal(f.exposures.length, 0);
  const global = [...f.epochs.values()][0];
  const tenant = await f.runtime.registerForActivation(
    'copy',
    { controlTenantId: 'north', evaluationTenantId: 'north' },
    active,
    f.reobserve,
  );
  assert.notEqual(tenant.epoch.key, global.key);
  const g = fixture();
  await assert.rejects(
    g.runtime.activate(
      { flagId: 'copy', scope: g.scope, override: active },
      {
        reobserve: g.reobserve,
        async commitControl() {
          throw new Error('Control CAS failed');
        },
      },
    ),
    /Control CAS/,
  );
  assert.equal(g.epochs.size, 1);
  assert.equal(g.exposures.length, 0);
});

test('activation refuses changed version/allocation/eligibility and active forced values', async () => {
  const f = fixture(true);
  for (const override of [
    { ...active, rollout: 25 },
    { ...active, value: 'a' },
    { ...active, rules: [{ audiences: ['east'], value: 'b' }] },
    { experiment: { version: 'v2', weights: active.experiment!.weights } },
    {
      experiment: {
        version: 'v1',
        weights: [
          { value: 'a', weight: 60 },
          { value: 'b', weight: 40 },
        ],
      },
    },
  ]) {
    await assert.rejects(f.runtime.registerForActivation('copy', f.scope, override, f.reobserve));
  }
  await assert.rejects(
    f.runtime.registerForActivation('copy', { controlTenantId: 'other', evaluationTenantId: 'north' }, active, f.reobserve),
  );
  assert.equal(f.registrations(), 0);
});

test('request evaluation never records exposure; explicit use is subject/scoped and reobserved', async () => {
  const f = fixture(true);
  await f.runtime.registerForActivation('copy', f.scope, active, f.reobserve);
  const request = await f.runtime.captureRequest(f.observation),
    decision = await request.decision('copy');
  assert.equal(decision.evaluation.reason, 'experiment');
  assert.equal(f.exposures.length, 0);
  assert.equal(await request.decision('copy'), decision);
  assert.deepEqual(request.version, { global: 3, tenant: 4 });
  await decision.recordUse!();
  assert.equal(f.exposures.length, 1);
  assert.deepEqual(f.exposures[0].unit, { kind: 'subject', id: 'subject-verified' });
  assert.equal(f.exposures[0].usedAtMs, start + 1000);
  f.revoke();
  await assert.rejects(decision.recordUse!(), /Native owner revoked/);
  assert.equal(f.exposures.length, 1);
});

test('fixed dates, audience, missing identity and global kill prevent enrollment', async () => {
  const f = fixture(true);
  await f.runtime.registerForActivation('copy', f.scope, active, f.reobserve);
  for (const clock of [start - 1, end]) {
    f.setTime(clock);
    const decision = await (await f.runtime.captureRequest(f.observation)).decision('copy');
    assert.equal(decision.evaluation.reason, 'default');
    assert.equal(decision.recordUse, null);
  }
  f.setTime(start);
  assert.equal((await (await f.runtime.captureRequest(f.observation)).decision('copy')).evaluation.reason, 'experiment');
  for (const context of [
    { roles: ['ops'], identity: { kind: 'subject', id: 'subject-verified' }, attributes: { emailDomain: 'east.example' } },
    { roles: ['member'], identity: { kind: 'subject', id: 'subject-verified' }, attributes: { emailDomain: 'west.example' } },
    { roles: ['member'], attributes: { emailDomain: 'east.example' } },
  ]) {
    if (context.roles[0] === 'ops')
      await assert.rejects(f.runtime.captureRequest(() => ({ ...f.observation(), context: context as never })));
    else
      assert.equal(
        (await (await f.runtime.captureRequest(() => ({ ...f.observation(), context: context as never }))).decision('copy')).recordUse,
        null,
      );
  }
  const original = f.observation();
  const killed = await f.runtime.captureRequest(() => ({
    ...original,
    snapshots: {
      ...original.snapshots,
      global: { ...original.snapshots.global, overrides: { copy: { ...active, disabled: true } } },
      tenant: { ...original.snapshots.tenant!, overrides: { copy: active } },
    },
  }));
  const answer = await killed.decision('copy');
  assert.equal(answer.evaluation.reason, 'disabled');
  assert.equal(answer.evaluation.value, 'safe');
  assert.equal(answer.recordUse, null);
});

test('ineligible tenant experiment falls through to global fixed value; tenant activation owns its own epoch', async () => {
  const f = fixture(true);
  const original = f.observation();
  const snapshots = {
    global: { ...original.snapshots.global, overrides: { copy: { value: 'b' } } },
    tenant: { ...original.snapshots.tenant!, overrides: { copy: active } },
  };
  const ineligible = await f.runtime.captureRequest(() => ({
    ...original,
    snapshots,
    context: { ...original.context, attributes: { emailDomain: 'west.example' } },
  }));
  const fixed = await ineligible.decision('copy');
  assert.equal(fixed.evaluation.value, 'b');
  assert.equal(fixed.recordUse, null);
  const eligible = await f.runtime.captureRequest(() => ({ ...original, snapshots }));
  await assert.rejects(eligible.decision('copy'), ExperimentConflict, 'request capture cannot auto-register an inactive owner');
  await f.runtime.registerForActivation('copy', { controlTenantId: 'north', evaluationTenantId: 'north' }, active, f.reobserve);
  const fresh = await (await f.runtime.captureRequest(() => ({ ...original, snapshots }))).decision('copy');
  assert.equal(fresh.epoch!.declaration.scope.controlTenantId, 'north');
});

test('foreign host/scope, mixed realm and forged active controls fail closed', async () => {
  const f = fixture(true),
    original = f.observation();
  for (const change of [
    { appId: 'other' },
    { environment: 'staging' },
    { realm: 'platform' },
    { context: { ...original.context, tenantId: 'other' } },
    { context: { ...original.context, roles: ['member', 'ops'] } },
    { context: { ...original.context, identity: { kind: 'subject', id: 'email@example.test' } } },
    { snapshots: { ...original.snapshots, global: { ...original.snapshots.global, tenantId: 'north' } } },
    { snapshots: { ...original.snapshots, tenant: { ...original.snapshots.tenant!, tenantId: 'other' } } },
    { snapshots: { ...original.snapshots, global: { ...original.snapshots.global, overrides: { copy: { ...active, value: 'b' } } } } },
  ]) {
    await assert.rejects(f.runtime.captureRequest(() => ({ ...original, ...change }) as ExperimentRequestObservation));
  }
  assert.equal(f.registrations(), 0);
  assert.equal(f.exposures.length, 0);
});

test('passive decisions create no delivery obligations; explicit delivery and use are guarded', async () => {
  const f = fixture();
  await f.runtime.registerForActivation('copy', f.scope, active, f.reobserve);
  const request = await f.runtime.captureRequest(f.observation),
    decision = await request.decision('copy');
  assert.equal(f.enrollments(), 0);
  assert.equal(f.exposures.length, 0);
  await decision.recordDelivery!();
  assert.equal(f.enrollments(), 1);
  assert.equal(f.exposures.length, 0);
  await decision.recordUse!();
  assert.equal(f.exposures.length, 1);
  f.revoke();
  await assert.rejects(decision.recordDelivery!());
});

test('global activation derives isolated tenant epochs only from its registered canonical parent', async () => {
  const f = fixture(true),
    scope = { controlTenantId: null, evaluationTenantId: 'north' };
  await assert.rejects(f.runtime.ensureEvaluationEpoch('copy', scope, f.reobserve), ExperimentConflict);
  await f.runtime.registerForActivation('copy', { controlTenantId: null, evaluationTenantId: null }, active, f.reobserve);
  const derived = await f.runtime.ensureEvaluationEpoch('copy', scope, f.reobserve);
  assert.equal(derived.declaration.scope.evaluationTenantId, 'north');
  assert.equal(f.registrations(), 2);
  await f.runtime.ensureEvaluationEpoch('copy', scope, f.reobserve);
  assert.equal(f.registrations(), 2);
  await assert.rejects(
    f.runtime.ensureEvaluationEpoch('copy', { controlTenantId: 'north', evaluationTenantId: 'north' }, f.reobserve),
    ExperimentConflict,
  );
  f.revoke();
  await assert.rejects(f.runtime.ensureEvaluationEpoch('copy', { controlTenantId: null, evaluationTenantId: 'south' }, f.reobserve));
});

test('only failures after durable exposure enrollment may continue as pending delivery', async () => {
  const f = fixture();
  await f.runtime.registerForActivation('copy', f.scope, active, f.reobserve);
  const decision = await (await f.runtime.captureRequest(f.observation)).decision('copy');
  f.setFault('enroll');
  await assert.rejects(decision.recordUse!(), (error) => error instanceof Error && !(error instanceof ExperimentExposurePending));
  assert.equal(f.enrollments(), 0);
  f.setFault('ingest');
  await assert.rejects(decision.recordUse!(), ExperimentExposurePending);
  assert.equal(f.enrollments(), 1);
  assert.equal(f.exposures.length, 0);
  f.revoke();
  await assert.rejects(decision.recordUse!(), (error) => error instanceof Error && !(error instanceof ExperimentExposurePending));
});
