/** Server-only assignment receipts. Resolving/issuing/verifying never records an
 * exposure. The host supplies registered epochs and verified native context;
 * neither this factory nor its resolved handles is a browser authority port. */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  flagValuesEqual,
  normalizeFlagCatalog,
  normalizeFlagContext,
  normalizeFlagSnapshot,
  type FlagCatalog,
  type FlagContext,
  type FlagOverrideSnapshot,
} from '../../shared/appFlags.js';
import { createFlagEvaluator } from '../flags/evaluation.js';
import {
  ensure,
  identifier,
  identifyEpoch,
  normalizeBinding,
  normalizeReference,
  opaqueIdentifier,
  record,
  time,
  type EpochReference,
  type ExperimentBinding,
  type ExperimentUnit,
  type RegisteredEpoch,
} from './contracts.js';
import { epochAdmits } from './eligibility.js';

export const ASSIGNMENT_RECEIPT_LIMITS = Object.freeze({ bytes: 4096, lifetimeMs: 300_000, maxClockSkewMs: 120_000 });
const PURPOSE = Buffer.from('mistri.experiments.assignment-receipt.aes256gcm.v1');
declare const resolved: unique symbol;
export interface ResolvedExperimentAssignment {
  readonly [resolved]: true;
}
export interface AssignmentReceiptClaims {
  readonly epoch: EpochReference;
  readonly scope: RegisteredEpoch['declaration']['scope'];
  readonly flagId: string;
  readonly version: string;
  readonly unit: ExperimentUnit;
  readonly arm: string;
  readonly proof: { readonly kind: 'session' | 'visitor'; readonly id: string };
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
}
export interface TrustedAssignmentInput {
  readonly epoch: RegisteredEpoch;
  readonly context: FlagContext;
  /** Fresh atomic global/selected-tenant control pair from the owning provider. */
  readonly snapshots: { readonly global: FlagOverrideSnapshot; readonly tenant: FlagOverrideSnapshot | null };
  /** Exact native session-instance ID, or explicit-interaction signed visitor
   * proof ID. Never an account ID substituted for a session instance. */
  readonly proof: AssignmentReceiptClaims['proof'];
}

export function createAssignmentReceiptProvider(options: {
  readonly appId: string;
  readonly environment: string;
  readonly binding: ExperimentBinding;
  readonly catalog: FlagCatalog;
  /** Dedicated operator-provisioned key, captured once. Never cookie/placement
   * key material; no serving-time generation, ambient lookup or fallback. */
  readonly key: Uint8Array;
  readonly clock?: () => number;
  readonly clockSkewMs?: number;
}) {
  ensure(options.key instanceof Uint8Array && options.key.byteLength === 32, 'A dedicated 32-byte receipt key is required.');
  const key = Buffer.from(options.key),
    binding = normalizeBinding(options.binding),
    catalog = normalizeFlagCatalog(options.catalog);
  const appId = identifier(options.appId),
    environment = identifier(options.environment),
    clock = options.clock ?? Date.now;
  const skew = options.clockSkewMs ?? 0;
  ensure(Number.isSafeInteger(skew) && skew >= 0 && skew <= ASSIGNMENT_RECEIPT_LIMITS.maxClockSkewMs);
  ensure(typeof clock === 'function');
  const handles = new WeakMap<ResolvedExperimentAssignment, Omit<AssignmentReceiptClaims, 'issuedAtMs' | 'expiresAtMs'>>();
  const horizons = new WeakMap<ResolvedExperimentAssignment, { starts: number; ends: number }>();
  const now = () => time(clock());
  const resolveAssignment = (input: TrustedAssignmentInput): ResolvedExperimentAssignment => {
    const registered = identifyEpoch(binding, input.epoch.declaration),
      reference = normalizeReference(input.epoch);
    ensure(reference.key === registered.key && reference.fingerprint === registered.fingerprint);
    const epoch = registered.declaration,
      scope = epoch.scope,
      flag = catalog.flags[epoch.flagId];
    ensure(scope.appId === appId && scope.environment === environment && flag && flag.owner === epoch.owner);
    const context = normalizeFlagContext(input.context, catalog);
    ensure((context.tenantId ?? null) === scope.evaluationTenantId && context.identity?.kind === epoch.unit);
    const unit = Object.freeze({ kind: epoch.unit, id: opaqueIdentifier(context.identity.id) });
    const rawProof = record(input.proof, ['kind', 'id']);
    ensure(rawProof.kind === (unit.kind === 'subject' ? 'session' : 'visitor'));
    const proof = Object.freeze({ kind: rawProof.kind as 'session' | 'visitor', id: opaqueIdentifier(rawProof.id) });
    const global = normalizeFlagSnapshot(input.snapshots.global, catalog);
    const tenant = input.snapshots.tenant === null ? null : normalizeFlagSnapshot(input.snapshots.tenant, catalog);
    ensure(global.appId === appId && global.environment === environment && global.tenantId === null);
    ensure(
      scope.evaluationTenantId === null
        ? tenant === null
        : tenant?.appId === appId && tenant.environment === environment && tenant.tenantId === scope.evaluationTenantId,
    );
    // Canonical catalog indices, not lexicographic arm IDs (variant-10 < variant-2).
    ensure(
      flag.variants?.length === epoch.arms.length &&
        flag.variants.every((value, index) => {
          const arm = epoch.arms.find((arm) => arm.id === `variant-${index}`);
          return arm && flagValuesEqual(value, arm.value as never);
        }),
    );
    const evaluate = (snapshot: FlagOverrideSnapshot) =>
      createFlagEvaluator({ catalog, context, scope: { appId, environment, tenantId: snapshot.tenantId }, snapshot }).evaluate(
        epoch.flagId,
      );
    let evaluation = evaluate(global),
      selected = global;
    if (evaluation.reason !== 'disabled' && flag.tenantManaged && tenant) {
      const local = evaluate(tenant);
      if (local.reason !== 'default') {
        evaluation = local;
        selected = tenant;
      }
    }
    ensure(
      selected.tenantId === scope.controlTenantId &&
        evaluation.reason === 'experiment' &&
        evaluation.experimentVersion === epoch.version &&
        evaluation.variant !== undefined,
    );
    const override = selected.overrides[epoch.flagId];
    ensure(
      override.experiment &&
        override.value === undefined &&
        !override.rules?.length &&
        (override.rollout ?? 100) === epoch.eligibility.rollout,
    );
    ensure(
      epoch.arms.every((arm) =>
        override.experiment!.weights.some((weight) => flagValuesEqual(weight.value, arm.value as never) && weight.weight === arm.weight),
      ),
    );
    ensure(epochAdmits(epoch, context, scope.evaluationTenantId));
    const at = now();
    ensure(at >= epoch.startsAtMs && at < epoch.endsAtMs);
    const handle = Object.freeze({}) as ResolvedExperimentAssignment;
    handles.set(
      handle,
      Object.freeze({
        epoch: reference,
        scope,
        flagId: epoch.flagId,
        version: epoch.version,
        unit,
        arm: `variant-${evaluation.variant}`,
        proof,
      }),
    );
    horizons.set(handle, { starts: epoch.startsAtMs, ends: epoch.endsAtMs });
    return handle;
  };
  const assignment = (handle: ResolvedExperimentAssignment) => {
    const value = handles.get(handle),
      horizon = horizons.get(handle),
      at = now();
    ensure(value && horizon && at >= horizon.starts && at < horizon.ends, 'A current trusted resolved assignment is required.');
    return value;
  };
  const decode = (token: unknown): AssignmentReceiptClaims => {
    ensure(typeof token === 'string' && token.length <= ASSIGNMENT_RECEIPT_LIMITS.bytes && /^ar1\.[A-Za-z0-9_-]+$/.test(token));
    const bytes = Buffer.from(token.slice(4), 'base64url');
    ensure(bytes.toString('base64url') === token.slice(4) && bytes.length > 28);
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(PURPOSE);
    decipher.setAuthTag(bytes.subarray(12, 28));
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
    } catch {
      throw new Error('Invalid assignment receipt.');
    }
    const raw = record(parsed, ['epoch', 'scope', 'flagId', 'version', 'unit', 'arm', 'proof', 'issuedAtMs', 'expiresAtMs']);
    const issuedAtMs = time(raw.issuedAtMs),
      expiresAtMs = time(raw.expiresAtMs),
      at = now();
    ensure(expiresAtMs - issuedAtMs === ASSIGNMENT_RECEIPT_LIMITS.lifetimeMs && issuedAtMs <= at + skew && at < expiresAtMs);
    // Payloads are created only by this key owner. Capture/freeze every nested
    // value before exposing authenticated selection hints to the native owner.
    const freeze = (value: unknown): void => {
      if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze);
        Object.freeze(value);
      }
    };
    freeze(parsed);
    return parsed as AssignmentReceiptClaims;
  };
  return Object.freeze({
    resolveAssignment,
    decode,
    issue(handle: ResolvedExperimentAssignment): string {
      const value = assignment(handle),
        issuedAtMs = now(),
        nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(PURPOSE);
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify({ ...value, issuedAtMs, expiresAtMs: issuedAtMs + ASSIGNMENT_RECEIPT_LIMITS.lifetimeMs }), 'utf8'),
        cipher.final(),
      ]);
      const token = `ar1.${Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url')}`;
      ensure(token.length <= ASSIGNMENT_RECEIPT_LIMITS.bytes);
      return token;
    },
    verify(token: unknown, current: ResolvedExperimentAssignment) {
      const claims = decode(token),
        value = assignment(current);
      const { issuedAtMs: _issued, expiresAtMs: _expires, ...bound } = claims;
      ensure(JSON.stringify(bound) === JSON.stringify(value), 'Assignment receipt owner or allocation changed.');
      return Object.freeze({ claims, fact: Object.freeze({ unit: value.unit, arm: value.arm, usedAtMs: now() }) });
    },
  });
}
export type AssignmentReceiptProvider = ReturnType<typeof createAssignmentReceiptProvider>;
