import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeFlagCatalog, type FlagOverrideSnapshot } from '../packages/mistri/src/shared/appFlags.js';
import { flagAssignmentBucket } from '../packages/mistri/src/server/flags/assignment.js';
import { identifyEpoch } from '../packages/mistri/src/server/experiments/contracts.js';
import {
  createAssignmentReceiptProvider,
  type TrustedAssignmentInput,
} from '../packages/mistri/src/server/experiments/assignmentReceipt.js';

const start = Date.parse('2026-11-01T00:00:00Z');
function fixture(tenantId: string | null = null, variants = ['a', 'b']) {
  let now = start + 1000;
  const key = new Uint8Array(32).fill(7),
    binding = { suiteId: 'suite', deploymentId: 'deployment' };
  const catalog = normalizeFlagCatalog({
    flags: { copy: { type: 'string', default: 'a', safeValue: 'safe', variants, owner: 'team', tenantManaged: true } },
    roles: ['member'],
    audiences: { east: { roles: ['member'], attributes: { emailDomain: ['east.example'] } } },
  });
  const weights = variants.map((value, i) => ({ value, weight: i === variants.length - 1 ? 100 - 5 * i : 5 }));
  const epoch = identifyEpoch(binding, {
    scope: { appId: 'target', environment: 'production', controlTenantId: null, evaluationTenantId: tenantId },
    flagId: 'copy',
    version: 'v1',
    owner: 'team',
    unit: 'subject',
    control: 'variant-0',
    arms: weights.map((weight, index) => ({ ...weight, id: `variant-${index}` })),
    eligibility: { rollout: 100, audiences: { east: catalog.audiences.east } },
    startsAtMs: start,
    endsAtMs: start + 3_600_000,
    conversionWindowMs: 3_600_000,
    deliveryGraceMs: 0,
    primary: { id: 'submitted', event: 'submitted', eventVersion: 1, unitField: 'actorId' },
    guardrails: [],
  });
  const global: FlagOverrideSnapshot = {
    appId: 'target',
    environment: 'production',
    tenantId: null,
    revision: 1,
    overrides: { copy: { experiment: { version: 'v1', weights } } },
  };
  const input: TrustedAssignmentInput = {
    epoch,
    context: {
      identity: { kind: 'subject', id: 'subject' },
      roles: ['member'],
      attributes: { emailDomain: 'east.example' },
      ...(tenantId === null ? {} : { tenantId }),
    },
    snapshots: { global, tenant: tenantId === null ? null : { ...global, tenantId, overrides: {} } },
    proof: { kind: 'session', id: 'native-session-1' },
  };
  const options = { appId: 'target', environment: 'production', binding, catalog, key, clock: () => now };
  const provider = createAssignmentReceiptProvider(options);
  return {
    provider,
    options,
    input,
    key,
    setTime: (value: number) => {
      now = value;
    },
  };
}

test('receipt encryption uses fresh 96-bit nonces and a captured dedicated operator key; replay is passive', () => {
  const f = fixture(),
    assignment = f.provider.resolveAssignment(f.input);
  const first = f.provider.issue(assignment),
    second = f.provider.issue(assignment);
  assert.notEqual(first, second);
  assert.ok(first.length <= 4096);
  const one = Buffer.from(first.slice(4), 'base64url'),
    two = Buffer.from(second.slice(4), 'base64url');
  assert.equal(one.subarray(0, 12).equals(two.subarray(0, 12)), false);
  assert.equal(one.includes(Buffer.from('subject')), false);
  f.key.fill(0);
  assert.equal(f.provider.verify(first, assignment).claims.proof.id, 'native-session-1');
  assert.deepEqual(f.provider.verify(first, assignment), f.provider.verify(first, assignment));
  assert.throws(() => createAssignmentReceiptProvider({ ...f.options, key: new Uint8Array(31) }));
  assert.throws(() => f.provider.issue({} as never));
  assert.throws(() => f.provider.issue({ ...assignment }));
  assert.throws(() => createAssignmentReceiptProvider(f.options).decode(first));
});

test('authenticated token tampering, truncation, noncanonical encoding and foreign owner fail closed', () => {
  const f = fixture('north'),
    token = f.provider.issue(f.provider.resolveAssignment(f.input));
  const bytes = Buffer.from(token.slice(4), 'base64url');
  for (const index of [0, 12, 28, bytes.length - 1]) {
    const changed = Buffer.from(bytes);
    changed[index] ^= 1;
    assert.throws(() => f.provider.decode(`ar1.${changed.toString('base64url')}`));
  }
  for (const wrong of [token.slice(0, -10), `${token}=`, 'ar2.' + token.slice(4), 'x'.repeat(4097), {}, null])
    assert.throws(() => f.provider.decode(wrong));
  for (const input of [
    { ...f.input, context: { ...f.input.context, identity: { kind: 'subject' as const, id: 'another-subject' } } },
    { ...f.input, proof: { kind: 'session' as const, id: 'native-session-2' } },
  ])
    assert.throws(() => f.provider.verify(token, f.provider.resolveAssignment(input)));
  const south = fixture('south');
  assert.throws(() => south.provider.verify(token, south.provider.resolveAssignment(south.input)));
  const otherDeployment = createAssignmentReceiptProvider({ ...f.options, binding: { suiteId: 'suite', deploymentId: 'other' } });
  assert.throws(() => otherDeployment.resolveAssignment(f.input));
});

test('five-minute deadline is strict; skew is explicit, bounded and never extends expiry', () => {
  const f = fixture(),
    handle = f.provider.resolveAssignment(f.input),
    token = f.provider.issue(handle);
  f.setTime(start + 300_999);
  assert.ok(f.provider.decode(token));
  f.setTime(start + 301_000);
  assert.throws(() => f.provider.decode(token));
  f.setTime(start + 999);
  assert.throws(() => f.provider.decode(token));
  const skewed = createAssignmentReceiptProvider({ ...f.options, clockSkewMs: 120_000 });
  assert.ok(skewed.decode(token));
  f.setTime(start + 301_000);
  assert.throws(() => skewed.decode(token));
  assert.throws(() => createAssignmentReceiptProvider({ ...f.options, clockSkewMs: 120_001 }));
  f.setTime(start + 3_600_000);
  assert.throws(() => f.provider.issue(handle));
});

test('resolution recomputes declared deterministic assignment with canonical numeric variant indices', () => {
  const f = fixture(
    'north',
    Array.from({ length: 12 }, (_, index) => String.fromCharCode(97 + index)),
  );
  const seen = new Set<string>();
  for (let index = 0; index < 128; index++) {
    const identity = { kind: 'subject' as const, id: `subject-${index}` };
    const token = f.provider.issue(f.provider.resolveAssignment({ ...f.input, context: { ...f.input.context, identity } }));
    const claims = f.provider.decode(token);
    const bucket = flagAssignmentBucket({
      appId: 'target',
      environment: 'production',
      tenantId: 'north',
      flagId: 'copy',
      experimentVersion: 'v1',
      purpose: 'variant',
      identity,
    })!;
    assert.equal(claims.arm, `variant-${Math.min(Math.floor(bucket / 5), 11)}`);
    seen.add(claims.arm);
    assert.equal(claims.scope.evaluationTenantId, 'north');
    assert.equal(claims.scope.controlTenantId, null);
  }
  assert.ok(seen.has('variant-2') && seen.has('variant-10'));
});

test('current eligibility, frozen allocation, exact scopes and dominant global kill are required', () => {
  const f = fixture('north'),
    global = f.input.snapshots.global,
    tenant = f.input.snapshots.tenant!;
  const changed = (override: unknown): TrustedAssignmentInput => ({
    ...f.input,
    snapshots: { ...f.input.snapshots, global: { ...global, overrides: { copy: override as never } } },
  });
  for (const input of [
    changed({ disabled: true }),
    changed({ value: 'a' }),
    changed({ ...global.overrides.copy, rollout: 50 }),
    changed({
      experiment: {
        version: 'v1',
        weights: [
          { value: 'a', weight: 50 },
          { value: 'b', weight: 50 },
        ],
      },
    }),
    { ...f.input, context: { ...f.input.context, roles: [] } },
    { ...f.input, context: { ...f.input.context, attributes: { emailDomain: 'west.example' } } },
    { ...f.input, context: { ...f.input.context, identity: undefined } },
    {
      ...f.input,
      snapshots: { global: { ...global, overrides: { copy: { disabled: true } } }, tenant: { ...tenant, overrides: global.overrides } },
    },
    { ...f.input, snapshots: { global, tenant: { ...tenant, tenantId: 'south' } } },
  ])
    assert.throws(() => f.provider.resolveAssignment(input));
  assert.throws(() => f.provider.resolveAssignment({ ...f.input, epoch: { ...f.input.epoch, fingerprint: '0'.repeat(64) } }));
});

test('visitor identity requires its own proof and never becomes a subject assignment on sign-in', () => {
  const f = fixture(),
    epoch = identifyEpoch(f.options.binding, { ...f.input.epoch.declaration, unit: 'visitor' });
  const visitor: TrustedAssignmentInput = {
    ...f.input,
    epoch,
    context: { ...f.input.context, identity: { kind: 'visitor', id: 'visitor-opaque' } },
    proof: { kind: 'visitor', id: 'explicit-interaction-proof' },
  };
  const token = f.provider.issue(f.provider.resolveAssignment(visitor));
  assert.equal(f.provider.decode(token).unit.kind, 'visitor');
  assert.throws(() => f.provider.resolveAssignment({ ...visitor, proof: f.input.proof }));
  assert.throws(() => f.provider.verify(token, f.provider.resolveAssignment(f.input)));
  assert.throws(() =>
    f.provider.resolveAssignment({ ...visitor, context: { ...visitor.context, identity: { kind: 'visitor', id: '127.0.0.1' } } }),
  );
});
