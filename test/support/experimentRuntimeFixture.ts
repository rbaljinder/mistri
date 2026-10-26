/** Trusted runtime fixture; PostgreSQL persistence is covered independently. */
import { captureAppFlagCatalog } from '../../packages/mistri/src/server/flags/appCatalog.js';
import type { AppDef } from '../../packages/mistri/src/shared/app.js';
import { defineCommand, defineCommands } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../../packages/mistri/src/server/commands/businessEvents.js';
import { bool, shape } from '../../packages/mistri/src/server/commands/commandShapes.js';
import { defineExperimentConversion } from '../../packages/mistri/src/server/experiments/declarations.js';
import { createExperimentConversionRegistry } from '../../packages/mistri/src/server/experiments/conversionRegistry.js';
import { createExperimentRuntime } from '../../packages/mistri/src/server/experiments/runtime.js';
import { createExperimentVisitorIdentity } from '../../packages/mistri/src/server/experiments/visitorIdentity.js';
import { createAssignmentReceiptProvider } from '../../packages/mistri/src/server/experiments/assignmentReceipt.js';
import {
  ExperimentConflict,
  identifyEpoch,
  type ExperimentStore,
  type ExposureFact,
  type RegisteredEpoch,
} from '../../packages/mistri/src/server/experiments/contracts.js';

export const experimentDeclaration = () => ({
  version: 'v1',
  unit: 'subject',
  control: 'a',
  startsAt: new Date(Date.now() - 60_000).toISOString(),
  endsAt: new Date(Date.now() + 3600_000).toISOString(),
  conversionWindow: '1 hour',
  deliveryGrace: '1 hour',
  eligibility: { rollout: 100 },
  allocation: [
    { value: 'a', weight: 50 },
    { value: 'b', weight: 50 },
  ],
  primary: { conversion: 'completed' },
});
export const experimentFlag = { type: 'string', default: 'a', safeValue: 'a', owner: 'team', tenantManaged: true, variants: ['a', 'b'] };
export const experimentOverride = {
  experiment: {
    version: 'v1',
    weights: [
      { value: 'a', weight: 50 },
      { value: 'b', weight: 50 },
    ],
  },
};
export async function experimentRuntimeFixture(app: AppDef, tenantId: string | null = null, visitor = false) {
  const event = defineEvent('experiment.completed', shape({ ok: bool() }));
  const commands = defineCommands({
    complete: defineCommand({
      source: 'data',
      target: 'item',
      ...(visitor ? { public: true, targets: 'none' as const } : {}),
      output: { parse: (value) => value as { ok: boolean } },
      events: { completed: defineEventProjection(event, (value: { ok: boolean }) => value) },
      handle() {
        return { ok: true };
      },
    }),
  });
  const conversions = createExperimentConversionRegistry({
    commands,
    conversions: [
      defineExperimentConversion({
        id: 'completed',
        on: event,
        unit: visitor ? { kind: 'visitor', source: 'public-intake' } : { kind: 'subject', source: 'actor' },
      }),
    ],
  });
  const graph = captureAppFlagCatalog(app),
    binding = { suiteId: 'fixture', deploymentId: 'experiments' };
  let beforeExposure: (() => void) | undefined;
  const epochs = new Map<string, RegisteredEpoch>(),
    exposures = new Map<string, ExposureFact>(),
    obligations = new Set<string>();
  const store = {
    binding,
    async registerEpoch(epoch, guard) {
      const registered = identifyEpoch(binding, epoch);
      await guard();
      epochs.set(registered.key, registered);
      return registered;
    },
    async readEpoch(reference) {
      const epoch = epochs.get(reference.key);
      if (!epoch || epoch.fingerprint !== reference.fingerprint) throw new ExperimentConflict();
      return epoch;
    },
    async enrollExposure(reference, assignment, guard) {
      await guard();
      obligations.add(`${reference.key}:${assignment.unit.id}`);
    },
    async ingestExposure(reference, fact, guard) {
      beforeExposure?.();
      await guard();
      const key = `${reference.key}:${fact.unit.id}`,
        status = exposures.has(key) ? ('duplicate' as const) : ('inserted' as const);
      exposures.set(key, fact);
      return { status, dataRevision: exposures.size, late: false };
    },
  } satisfies Pick<ExperimentStore, 'binding' | 'registerEpoch' | 'readEpoch' | 'enrollExposure' | 'ingestExposure'>;
  const runtime = createExperimentRuntime({
    appId: app.id,
    environment: 'production',
    graph,
    conversions,
    store: store as ExperimentStore,
  });
  await runtime.registerForActivation('copy', { controlTenantId: tenantId, evaluationTenantId: tenantId }, experimentOverride, () => {});
  const receipts = createAssignmentReceiptProvider({
    appId: app.id,
    environment: 'production',
    binding,
    catalog: graph.catalog,
    key: Buffer.alloc(32, 17),
  });
  return {
    port: {
      runtime,
      receipts,
      store: store as ExperimentStore,
      ...(visitor
        ? {
            visitors: createExperimentVisitorIdentity({
              appId: app.id,
              environment: 'production',
              binding,
              key: Buffer.alloc(32, 17),
              mount: '/desk',
              secure: false,
            }),
          }
        : {}),
    },
    exposures,
    obligations,
    beforeExposure: (callback?: () => void) => {
      beforeExposure = callback;
    },
  };
}
