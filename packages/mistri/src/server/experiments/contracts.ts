/** Trusted AN2 storage port. None of these methods is a browser/API capability. */
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import type { computeExperimentStatistics, ExperimentStatisticsInput } from './statistics.js';
import { normalizeAudience, type AudienceDefinition } from '../../shared/appFlags.js';

export const EXPERIMENT_LIMITS = Object.freeze({
  arms: 16,
  guardrails: 16,
  exposures: 100_000,
  conversions: 100_000,
  pendingConversions: 10_000,
  page: 100,
  documentBytes: 1_048_576,
  time: 8_640_000_000_000_000,
});
export class ExperimentContractError extends Error {
  constructor(message = 'Invalid experiment contract.') {
    super(message);
    this.name = 'ExperimentContractError';
  }
}
export class ExperimentStoreUnavailable extends Error {
  constructor(message = 'Experiment store unavailable or owner/layout not recognized.') {
    super(message);
    this.name = 'ExperimentStoreUnavailable';
  }
}
/** Only issued after a durable exposure obligation has committed. The
 * business command may continue; unresolved coverage still blocks evidence. */
export class ExperimentExposurePending extends Error {
  constructor() {
    super('Exposure delivery pending behind a durable obligation.');
    this.name = 'ExperimentExposurePending';
  }
}
export class ExperimentConflict extends Error {
  constructor() {
    super('Experiment identity, observation or revision conflicts.');
    this.name = 'ExperimentConflict';
  }
}
export class ExperimentCapacityExceeded extends Error {
  constructor() {
    super('Experiment ingestion capacity exceeded; delivery was not acknowledged.');
    this.name = 'ExperimentCapacityExceeded';
  }
}
export function ensure(condition: unknown, message?: string): asserts condition {
  if (!condition) throw new ExperimentContractError(message);
}
export function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  ensure(value !== null && typeof value === 'object' && !Array.isArray(value));
  ensure(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
  ensure(Object.getOwnPropertySymbols(value).length === 0);
  const captured: Record<string, unknown> = Object.create(null);
  for (const [key, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    ensure(keys.includes(key) && 'value' in property && property.enumerable);
    captured[key] = property.value;
  }
  return captured;
}
export function list(value: unknown, max: number): readonly unknown[] {
  ensure(Array.isArray(value) && value.length <= max);
  const items: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const property = Object.getOwnPropertyDescriptor(value, i);
    ensure(property && 'value' in property);
    items.push(property.value);
  }
  return items;
}
export function identifier(value: unknown): string {
  ensure(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value));
  return value;
}
export function opaqueIdentifier(value: unknown): string {
  const result = identifier(value);
  ensure(!isIP(result) && !/^\d+(?:\.\d+){3}$/.test(result), 'Raw network identities are not accepted.');
  return result;
}
export function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  ensure(typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max);
  return value;
}
export const time = (value: unknown): number => integer(value, 1, EXPERIMENT_LIMITS.time);
export function addTime(...values: number[]): number {
  return time(values.reduce((a, b) => a + b, 0));
}
export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function json(value: unknown): string {
  const result = JSON.stringify(value);
  ensure(Buffer.byteLength(result) <= EXPERIMENT_LIMITS.documentBytes);
  return result;
}
type VariantValue = null | boolean | number | string | readonly VariantValue[] | { readonly [key: string]: VariantValue };
function variant(value: unknown, budget = { nodes: 0 }, depth = 0): VariantValue {
  ensure(++budget.nodes <= 1024 && depth <= 8);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    ensure(Number.isFinite(value));
    return value;
  }
  if (typeof value === 'string') {
    ensure(value.length <= 4096);
    return value;
  }
  if (Array.isArray(value)) return Object.freeze(list(value, 128).map((item) => variant(item, budget, depth + 1)));
  ensure(value !== null && typeof value === 'object');
  const entries = record(value, Object.keys(value)),
    output: Record<string, VariantValue> = Object.create(null);
  ensure(Object.keys(entries).length <= 128);
  for (const key of Object.keys(entries).sort()) {
    ensure(key.length <= 128);
    output[key] = variant(entries[key], budget, depth + 1);
  }
  return Object.freeze(output);
}
export interface ExperimentBinding {
  readonly suiteId: string;
  readonly deploymentId: string;
}
interface ExperimentScope {
  readonly appId: string;
  readonly environment: string;
  readonly controlTenantId: string | null;
  readonly evaluationTenantId: string | null;
}
export interface ExperimentEpoch {
  readonly scope: ExperimentScope;
  readonly flagId: string;
  readonly version: string;
  readonly owner: string;
  readonly unit: 'subject' | 'visitor';
  readonly control: string;
  readonly arms: readonly { readonly id: string; readonly value: VariantValue; readonly weight: number }[];
  readonly eligibility: {
    readonly rollout: number;
    /** Each named audience's definition as it stood at registration: editing an
     * audience changes the epoch's fingerprint, so it needs a new version.
     * Absent only in an epoch a 0.8 release registered. */
    readonly audiences?: Readonly<Record<string, AudienceDefinition>>;
    /** Only in an epoch a 0.8 release registered, which said who directly and
     * named no audience (its segments are always empty: nothing ever supplied
     * a segment value). Kept as stored, since its fingerprint is a digest of
     * exactly this shape; a 1.0 epoch says who only through audiences. */
    readonly roles?: readonly string[];
    readonly tenants?: readonly string[];
    readonly segments?: Readonly<Record<string, never>>;
  };
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly conversionWindowMs: number;
  readonly deliveryGraceMs: number;
  readonly primary: { readonly id: string; readonly event: string; readonly eventVersion: number; readonly unitField: string };
  readonly guardrails: readonly {
    readonly id: string;
    readonly event: string;
    readonly eventVersion: number;
    readonly unitField: string;
    readonly maxIncrease: number;
  }[];
}
export interface EpochReference {
  readonly key: string;
  readonly fingerprint: string;
}
export interface RegisteredEpoch extends EpochReference {
  readonly declaration: ExperimentEpoch;
}
export function normalizeBinding(input: unknown): ExperimentBinding {
  const raw = record(input, ['suiteId', 'deploymentId']);
  return Object.freeze({ suiteId: identifier(raw.suiteId), deploymentId: identifier(raw.deploymentId) });
}
function percentage(value: unknown): number {
  ensure(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100);
  return value;
}
function identifiers(value: unknown): readonly string[] {
  const values = list(value, 128).map(identifier).sort();
  ensure(new Set(values).size === values.length);
  return Object.freeze(values);
}
function metric(input: unknown, guardrail: boolean) {
  const raw = record(input, ['id', 'event', 'eventVersion', 'unitField', ...(guardrail ? ['maxIncrease'] : [])]);
  return Object.freeze({
    id: identifier(raw.id),
    event: identifier(raw.event),
    eventVersion: integer(raw.eventVersion, 1),
    unitField: identifier(raw.unitField),
  });
}
export function normalizeEpoch(input: unknown): ExperimentEpoch {
  const raw = record(input, [
    'scope',
    'flagId',
    'version',
    'owner',
    'unit',
    'control',
    'arms',
    'eligibility',
    'startsAtMs',
    'endsAtMs',
    'conversionWindowMs',
    'deliveryGraceMs',
    'primary',
    'guardrails',
  ]);
  const s = record(raw.scope, ['appId', 'environment', 'controlTenantId', 'evaluationTenantId']);
  const scope = Object.freeze({
    appId: identifier(s.appId),
    environment: identifier(s.environment),
    controlTenantId: s.controlTenantId === null ? null : identifier(s.controlTenantId),
    evaluationTenantId: s.evaluationTenantId === null ? null : identifier(s.evaluationTenantId),
  });
  ensure(scope.controlTenantId === null || scope.controlTenantId === scope.evaluationTenantId);
  ensure(raw.unit === 'subject' || raw.unit === 'visitor');
  const arms = list(raw.arms, 16)
    .map((inputArm) => {
      const arm = record(inputArm, ['id', 'value', 'weight']);
      return Object.freeze({ id: identifier(arm.id), value: variant(arm.value), weight: percentage(arm.weight) });
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  ensure(
    arms.length >= 2 &&
      new Set(arms.map((arm) => arm.id)).size === arms.length &&
      new Set(arms.map((arm) => json(arm.value))).size === arms.length,
  );
  ensure(arms.reduce((total, arm) => total + arm.weight, 0) === 100);
  const control = identifier(raw.control);
  ensure(arms.some((arm) => arm.id === control));
  const legacy = raw.eligibility !== null && typeof raw.eligibility === 'object' && Object.hasOwn(raw.eligibility, 'segments');
  const e = record(raw.eligibility, legacy ? ['rollout', 'roles', 'tenants', 'segments'] : ['rollout', 'audiences']);
  if (legacy) {
    ensure(e.segments !== null && typeof e.segments === 'object');
    ensure(Object.keys(e.segments).length === 0, 'Experiment segments are retired; name an audience.');
    record(e.segments, []);
  } else ensure(e.audiences !== null && typeof e.audiences === 'object');
  const audiences = legacy ? {} : record(e.audiences, Object.keys(e.audiences as object));
  ensure(Object.keys(audiences).length <= 64);
  const normalizedAudiences: Record<string, AudienceDefinition> = Object.create(null);
  for (const key of Object.keys(audiences).sort()) {
    const definition = record(audiences[key], ['roles', 'tenants', 'attributes', 'rollout', 'allow', 'deny']);
    // The App's catalog already judged its roles; here the definition is only made canonical.
    const roles = Array.isArray(definition.roles) ? (definition.roles as string[]) : [];
    try {
      normalizedAudiences[identifier(key)] = normalizeAudience({ ...definition }, roles);
    } catch {
      ensure(false, 'Invalid experiment audience.');
    }
  }
  const startsAtMs = time(raw.startsAtMs),
    endsAtMs = time(raw.endsAtMs),
    conversionWindowMs = time(raw.conversionWindowMs);
  const deliveryGraceMs = integer(raw.deliveryGraceMs, 0, EXPERIMENT_LIMITS.time);
  ensure(startsAtMs < endsAtMs);
  addTime(endsAtMs, conversionWindowMs, deliveryGraceMs);
  const primary = metric(raw.primary, false);
  const guardrails = list(raw.guardrails, 16)
    .map((inputMetric) => {
      const value = record(inputMetric, ['id', 'event', 'eventVersion', 'unitField', 'maxIncrease']);
      ensure(
        typeof value.maxIncrease === 'number' && Number.isFinite(value.maxIncrease) && value.maxIncrease >= 0 && value.maxIncrease <= 1,
      );
      return Object.freeze({ ...metric(inputMetric, true), maxIncrease: value.maxIncrease });
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  ensure(new Set([primary.id, ...guardrails.map((g) => g.id)]).size === guardrails.length + 1);
  ensure(
    guardrails.every((g) => g.id !== 'primary'),
    'The statistical primary metric label is reserved.',
  );
  return Object.freeze({
    scope,
    flagId: identifier(raw.flagId),
    version: identifier(raw.version),
    owner: identifier(raw.owner),
    unit: raw.unit,
    control,
    arms: Object.freeze(arms),
    eligibility: Object.freeze({
      rollout: percentage(e.rollout),
      ...(legacy
        ? { roles: identifiers(e.roles), tenants: identifiers(e.tenants), segments: Object.freeze({}) }
        : { audiences: Object.freeze(normalizedAudiences) }),
    }),
    startsAtMs,
    endsAtMs,
    conversionWindowMs,
    deliveryGraceMs,
    primary,
    guardrails: Object.freeze(guardrails),
  });
}
export function identifyEpoch(binding: ExperimentBinding, input: ExperimentEpoch): RegisteredEpoch {
  const owner = normalizeBinding(binding),
    declaration = normalizeEpoch(input);
  const key = digest(['mistri.experiments.epoch.v1', owner, declaration.scope, declaration.flagId, declaration.version]);
  return Object.freeze({ key, fingerprint: digest(['mistri.experiments.declaration.v1', owner, declaration]), declaration });
}
export function normalizeReference(input: unknown): EpochReference {
  // RegisteredEpoch is structurally an EpochReference; capture only its pinned
  // identifiers. An accompanying declaration never supplies storage authority.
  const raw = record(input, ['key', 'fingerprint', 'declaration']);
  for (const field of [raw.key, raw.fingerprint]) ensure(typeof field === 'string' && /^[a-f0-9]{64}$/.test(field));
  return Object.freeze({ key: raw.key as string, fingerprint: raw.fingerprint as string });
}
export interface ExperimentUnit {
  readonly kind: 'subject' | 'visitor';
  readonly id: string;
}
export function unitKey(reference: EpochReference, unit: ExperimentUnit, kind: ExperimentEpoch['unit']): string {
  const raw = record(unit, ['kind', 'id']);
  ensure(raw.kind === kind);
  // Database stores a scoped digest, never the submitted subject/visitor identifier.
  return digest(['mistri.experiments.unit.v1', reference.key, kind, opaqueIdentifier(raw.id)]);
}
export type CommitGuard = () => void | Promise<void>;
export interface ExposureFact {
  readonly unit: ExperimentUnit;
  readonly arm: string;
  readonly usedAtMs: number;
}
export interface ConversionFact {
  readonly unit: ExperimentUnit;
  readonly source: string;
  readonly eventId: string;
  readonly event: string;
  readonly eventVersion: number;
  readonly metric: string;
  readonly occurredAtMs: number;
}
export interface IngestionReceipt {
  readonly status: 'inserted' | 'duplicate' | 'earlier-exposure';
  readonly dataRevision: number;
  readonly late: boolean;
}
export interface DeliveryCompleteness {
  readonly throughMs: number;
  readonly pending: number;
  readonly failed: number;
  readonly incomplete: number;
}
interface ResultPublication {
  readonly expectedDataRevision: number;
  readonly delivery: DeliveryCompleteness;
}
export interface ExperimentResult {
  readonly epoch: EpochReference;
  readonly declaration: ExperimentEpoch;
  readonly dataRevision: number;
  readonly evidenceRevision: number;
  readonly capturedAtMs: number;
  readonly delivery: DeliveryCompleteness;
  readonly diagnostics: {
    readonly pendingConversions: number;
    readonly unattributedConversions: number;
    readonly lateConversions: number;
    readonly lateExposures: number;
  };
  readonly input: ExperimentStatisticsInput;
  readonly statisticsVersion: 'an2-binary-v1';
  /** Persist the actual inference/method metadata used, not just recomputable counts. */
  readonly statistics: ReturnType<typeof computeExperimentStatistics>;
}
export interface DecisionEvidenceInput {
  readonly decisionId: string;
  readonly evidenceRevision: number;
  readonly expectedDataRevision: number;
  readonly arm: string;
  readonly actorId: string;
  readonly reason: string;
  readonly controlRevision: number;
}
export interface DecisionEvidence extends Omit<DecisionEvidenceInput, 'actorId'> {
  readonly actorKey: string;
  readonly epoch: EpochReference;
  readonly recordedAtMs: number;
}
export interface ExperimentStore {
  readonly binding: ExperimentBinding;
  registerEpoch(epoch: ExperimentEpoch, beforeCommit: CommitGuard): Promise<RegisteredEpoch>;
  readEpoch(reference: EpochReference): Promise<RegisteredEpoch>;
  ingestExposure(reference: EpochReference, fact: ExposureFact, beforeCommit: CommitGuard): Promise<IngestionReceipt>;
  ingestConversion(reference: EpochReference, fact: ConversionFact, beforeCommit: CommitGuard): Promise<IngestionReceipt>;
  /** Persist before delivering an experimental value/receipt. Evaluation is not
   * exposure; an obligation without actual use remains unknown coverage. */
  enrollExposure(
    reference: EpochReference,
    assignment: { readonly unit: ExperimentUnit; readonly arm: string },
    beforeCommit: CommitGuard,
  ): Promise<void>;
  readDataRevision(reference: EpochReference): Promise<number>;
  publishResults(reference: EpochReference, publication: ResultPublication, beforeCommit: CommitGuard): Promise<ExperimentResult>;
  /** Omitted revision reads the latest published immutable evidence, not raw events. */
  readResults(reference: EpochReference, evidenceRevision?: number): Promise<ExperimentResult>;
  /** Records a trusted control-owner correlation only. Does not apply a flag
   * value, grant decide authority, or claim an atomic cross-database decision. */
  appendDecisionEvidence(reference: EpochReference, input: DecisionEvidenceInput, beforeCommit: CommitGuard): Promise<DecisionEvidence>;
  decisions(
    reference: EpochReference,
    query: { readonly after?: string; readonly limit: number },
  ): Promise<{
    readonly entries: readonly DecisionEvidence[];
    readonly nextAfter: string | null;
  }>;
  close(): Promise<void>;
}
