/** Feature decisions are data, never authority. These closed, immutable shapes
 * are shared by the future DSL, control store and server providers. No request
 * headers, expressions or permission grants belong in an evaluation context. */
type FlagJson = null | boolean | number | string | readonly FlagJson[] | { readonly [key: string]: FlagJson };
type FlagObject = { readonly [key: string]: FlagJson };
export type FlagValue = boolean | string | number | FlagObject;
type FlagKind = 'boolean' | 'string' | 'number' | 'object';

interface Definition<T extends FlagValue, K extends FlagKind> {
  readonly type: K;
  readonly default: T;
  readonly variants?: readonly T[];
  readonly owner: string;
  /** UTC ISO timestamp. Metadata only: expiry does not silently change a value. */
  readonly expiry?: string;
  readonly tenantManaged?: boolean;
  /** Boolean definitions normalize an omitted safe value to false. Other
   * definitions without one cannot be disabled. A safe value need not be a variant. */
  readonly safeValue?: T;
}
type FlagDefinition =
  | Definition<boolean, 'boolean'>
  | Definition<string, 'string'>
  | Definition<number, 'number'>
  | Definition<FlagObject, 'object'>;

/** Who a flag rule or an experiment reaches, declared once in the App and
 * named wherever it is used, so a flag and an experiment that say "beta" mean
 * the same people. Conditions are ANDed and the values within one are ORed;
 * `deny` wins over everything, then `allow`. Every condition is read from what
 * the server verified about the request, never from a header or a body. */
export interface AudienceDefinition {
  readonly roles?: readonly string[];
  readonly tenants?: readonly string[];
  /** Verified facts about the signed-in principal. Only the domain of an email
   * the account proved today: a visitor, a service and an unproven address have none. */
  readonly attributes?: { readonly emailDomain?: readonly string[] };
  /** A stable percentage of identities, hashed on the audience's name: the same
   * people for every flag and experiment that names it, and none without an identity. */
  readonly rollout?: number;
  /** Account ids always in (unless denied) and always out. A visitor is never listed. */
  readonly allow?: readonly string[];
  readonly deny?: readonly string[];
}
/** The principal attributes an audience may read: closed, so a new one is a
 * server change that says where its value comes from. */
const AUDIENCE_ATTRIBUTES = Object.freeze(['emailDomain'] as const);
export interface FlagCatalog {
  readonly flags: Readonly<Record<string, FlagDefinition>>;
  readonly roles: readonly string[];
  readonly audiences: Readonly<Record<string, AudienceDefinition>>;
}
export interface FlagScope {
  readonly appId: string;
  readonly environment: string;
  readonly tenantId: string | null;
}
/** Verification is the host's responsibility; accepting this shape never
 * authenticates an identity or grants any of its roles. */
interface FlagIdentity {
  readonly kind: 'subject' | 'visitor';
  readonly id: string;
}
export interface FlagContext {
  /** Verified evaluation tenant, independent of the control record's owner. */
  readonly tenantId?: string;
  readonly identity?: FlagIdentity;
  readonly roles?: readonly string[];
  /** What the server verified about the principal; see AudienceDefinition.attributes. */
  readonly attributes?: { readonly emailDomain?: string };
}
/** Rules are ordered; the first whose audiences hold the context serves its value.
 * Who a rule reaches is said only by audiences, so a rule and an experiment
 * naming "beta" mean the same people. */
export interface FlagTarget {
  /** Declared audience names; the rule matches a member of any of them. */
  readonly audiences: readonly string[];
  readonly value: FlagValue;
}
export interface FlagExperiment {
  readonly version: string;
  /** Every declared variant occurs exactly once, including zero-weight ones. */
  readonly weights: readonly { readonly value: FlagValue; readonly weight: number }[];
}
export interface FlagOverride {
  readonly value?: FlagValue;
  readonly disabled?: boolean;
  readonly rules?: readonly FlagTarget[];
  /** Percentage admitted to value/experiment; absent means all. */
  readonly rollout?: number;
  readonly experiment?: FlagExperiment;
}
export interface FlagOverrideSnapshot extends FlagScope {
  readonly revision: number;
  readonly overrides: Readonly<Record<string, FlagOverride>>;
}
export type FlagDiagnostic = 'provider_error' | 'invalid_snapshot' | 'scope_mismatch' | 'invalid_context' | 'missing_identity';
type FlagReason = 'default' | 'disabled' | 'target' | 'override' | 'rollout' | 'experiment';
export interface FlagEvaluation {
  readonly value: FlagValue;
  readonly reason: FlagReason;
  readonly revision: number | null;
  readonly diagnostics: readonly FlagDiagnostic[];
  readonly experimentVersion?: string;
  readonly variant?: number;
}
export interface FlagRequestSnapshot {
  readonly scope: FlagScope;
  readonly revision: number | null;
  readonly evaluate: (flagId: string) => FlagEvaluation;
}
export interface FlagProviderRequest {
  readonly scope: FlagScope;
  readonly context: FlagContext;
}
/** A server-side, dependency-free provider seam. The targeting context has the
 * same purpose as OpenFeature's evaluation context; this is not an SDK adapter.
 * null means no overrides. Other results are untrusted until normalized. */
export interface FlagProvider {
  readonly readSnapshot: (request: FlagProviderRequest) => unknown | Promise<unknown>;
}
export interface FlagAssignment extends FlagScope {
  readonly flagId: string;
  readonly experimentVersion: string | null;
  readonly identity?: FlagIdentity;
  /** Separate rollout admission from variant allocation. */
  readonly purpose: 'rollout' | 'variant';
}
export interface FlagEvaluationInput {
  readonly catalog: FlagCatalog;
  readonly scope: FlagScope;
  readonly context: FlagContext;
  readonly snapshot: unknown;
  readonly failure?: 'provider_error' | 'invalid_context';
}
export interface FlagRequestInput {
  readonly catalog: FlagCatalog;
  readonly scope: FlagScope;
  readonly context: FlagContext;
  readonly provider: FlagProvider;
}

export const FLAG_LIMITS = Object.freeze({
  flags: 256,
  roles: 256,
  audiences: 64,
  variants: 32,
  rules: 64,
  tenants: 128,
  depth: 8,
  nodes: 32768,
  string: 4096,
  entries: 256,
});

export class FlagValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FlagValidationError';
  }
}
const refuse = (message: string): never => {
  throw new FlagValidationError(message);
};
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
function name(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) || forbidden.has(value))
    return refuse('Invalid flag identifier.');
  return value;
}
/** Clone before judging values. Accessors, symbols, sparse arrays and foreign
 * prototypes are not JSON data. Bounds apply to the whole captured document. */
function capture(input: unknown): unknown {
  let nodes = 0;
  const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > FLAG_LIMITS.nodes || depth > 20) return refuse('Flag data exceeds its size limit.');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number')
      return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : refuse('Flag numbers must be finite.');
    if (typeof value === 'string') return value.length <= FLAG_LIMITS.string ? value : refuse('Flag text is too long.');
    if (typeof value !== 'object' || ancestors.has(value)) return refuse('Flags require plain JSON data.');
    const array = Array.isArray(value),
      proto = Object.getPrototypeOf(value);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return refuse('Flags require plain JSON data.');
    ancestors.add(value);
    const keys = Reflect.ownKeys(value).filter((key) => !(array && key === 'length'));
    if (keys.length > FLAG_LIMITS.entries || (array && keys.length !== value.length))
      return refuse('Invalid or oversized flag collection.');
    const entries = keys.map((key, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (
        typeof key !== 'string' ||
        forbidden.has(key) ||
        key.length > 128 ||
        !descriptor.enumerable ||
        !('value' in descriptor) ||
        (array && key !== String(index))
      )
        return refuse('Flags require own, enumerable data fields.');
      return [key, copy(descriptor.value, depth + 1)] as const;
    });
    ancestors.delete(value);
    return Object.freeze(array ? entries.map(([, item]) => item) : Object.fromEntries(entries));
  };
  return copy(input, 0);
}
function object(value: unknown, keys?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse('Expected a flag object.');
  if (keys && Object.keys(value).some((key) => !keys.includes(key))) return refuse('Unknown flag field.');
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > maximum) return refuse('Invalid flag list.');
  return value;
}
function names(value: unknown, maximum: number, allowed?: readonly string[]): readonly string[] {
  const result = list(value, maximum).map(name);
  if (new Set(result).size !== result.length || (allowed && result.some((item) => !allowed.includes(item))))
    return refuse('Duplicate or undeclared flag name.');
  return Object.freeze(result);
}
function optionalBoolean(record: Record<string, unknown>, key: string): void {
  if (Object.hasOwn(record, key) && typeof record[key] !== 'boolean') refuse('Expected a flag boolean.');
}
function jsonDepth(value: unknown, depth = 0): void {
  if (depth > FLAG_LIMITS.depth) refuse('Flag value is too deep.');
  if (value && typeof value === 'object') for (const child of Object.values(value)) jsonDepth(child, depth + 1);
}
function typedValue(value: unknown, type: unknown): FlagValue {
  if (!['boolean', 'string', 'number', 'object'].includes(type as string)) return refuse('Unknown flag type.');
  if (type === 'object') {
    object(value);
    jsonDepth(value);
  } else if (typeof value !== type) return refuse('Flag value has the wrong type.');
  return value as FlagValue;
}
/** Structural JSON equality, independent of authored object key order. */
export function flagValuesEqual(a: FlagValue, b: FlagValue): boolean {
  const canonical = (value: FlagJson): string => {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as FlagObject;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  };
  return canonical(a) === canonical(b);
}
function definition(value: unknown): FlagDefinition {
  const raw = object(value, ['type', 'default', 'variants', 'owner', 'expiry', 'tenantManaged', 'safeValue']);
  name(raw.owner);
  typedValue(raw.default, raw.type);
  optionalBoolean(raw, 'tenantManaged');
  if (Object.hasOwn(raw, 'expiry')) {
    if (
      typeof raw.expiry !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(raw.expiry) ||
      !Number.isFinite(Date.parse(raw.expiry)) ||
      new Date(raw.expiry).toISOString() !== raw.expiry
    )
      refuse('Flag expiry must be a UTC ISO timestamp.');
  }
  if (Object.hasOwn(raw, 'variants')) {
    const variants = list(raw.variants, FLAG_LIMITS.variants).map((item) => typedValue(item, raw.type));
    if (
      variants.some((item, index) => variants.slice(0, index).some((other) => flagValuesEqual(item, other))) ||
      !variants.some((item) => flagValuesEqual(item, raw.default as FlagValue))
    )
      refuse('Flag variants must be distinct and include the default.');
  }
  if (Object.hasOwn(raw, 'safeValue')) {
    typedValue(raw.safeValue, raw.type);
    if (raw.type === 'boolean' && raw.safeValue !== false) refuse('A boolean kill switch can only disable.');
  }
  return Object.freeze({ ...raw, ...(raw.type === 'boolean' ? { safeValue: false } : {}) }) as unknown as FlagDefinition;
}
export function normalizeFlagDefinition(input: unknown): FlagDefinition {
  return definition(capture(input));
}

const DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
function domain(value: unknown): string {
  if (typeof value !== 'string' || !DOMAIN.test(value)) return refuse('An email domain is lowercase, like "example.com".');
  return value;
}
/** One audience, canonical: lists sorted, so an equal definition hashes equal
 * wherever it is frozen (an experiment epoch keeps its audiences' definitions). */
export function normalizeAudience(input: unknown, roles: readonly string[]): AudienceDefinition {
  const raw = object(input, ['roles', 'tenants', 'attributes', 'rollout', 'allow', 'deny']);
  const sorted = (values: readonly string[]) => Object.freeze([...values].sort());
  const out: Record<string, unknown> = {};
  if (Object.hasOwn(raw, 'roles')) {
    const named = names(raw.roles, FLAG_LIMITS.roles);
    const undeclared = named.find((role) => !roles.includes(role));
    if (undeclared !== undefined) refuse(`An audience names the role "${undeclared}", which auth.roles does not declare.`);
    out.roles = sorted(named);
  }
  if (Object.hasOwn(raw, 'tenants')) out.tenants = sorted(names(raw.tenants, FLAG_LIMITS.tenants));
  if (Object.hasOwn(raw, 'attributes')) {
    const attributes = object(raw.attributes, AUDIENCE_ATTRIBUTES);
    if (!Object.keys(attributes).length) refuse("An audience's attributes name at least one.");
    const emailDomain = list(attributes.emailDomain, FLAG_LIMITS.entries).map(domain);
    if (new Set(emailDomain).size !== emailDomain.length) refuse('Duplicate email domain.');
    out.attributes = Object.freeze({ emailDomain: sorted(emailDomain) });
  }
  if (Object.hasOwn(raw, 'rollout')) out.rollout = percentage(raw.rollout);
  for (const key of ['allow', 'deny'] as const) if (Object.hasOwn(raw, key)) out[key] = sorted(names(raw[key], FLAG_LIMITS.entries));
  if (!Object.keys(out).length) refuse('An audience needs a condition: roles, tenants, attributes, rollout, allow or deny.');
  const allow = (out.allow ?? []) as string[];
  if ((out.deny as string[] | undefined)?.some((id) => allow.includes(id))) refuse('An account is both allowed and denied.');
  return Object.freeze(out) as AudienceDefinition;
}
export function normalizeFlagCatalog(input: unknown): FlagCatalog {
  const raw = object(capture(input), ['flags', 'roles', 'audiences']);
  const flags = object(raw.flags),
    audiences = object(raw.audiences);
  if (Object.keys(flags).length > FLAG_LIMITS.flags || Object.keys(audiences).length > FLAG_LIMITS.audiences)
    refuse('Too many flags or audiences.');
  const normalized = Object.fromEntries(Object.entries(flags).map(([key, value]) => [name(key), definition(value)]));
  const roles = Array.isArray(raw.roles) && raw.roles.length === 0 ? Object.freeze([]) : names(raw.roles, FLAG_LIMITS.roles);
  const declared = Object.fromEntries(Object.entries(audiences).map(([key, value]) => [name(key), normalizeAudience(value, roles)]));
  return Object.freeze({ flags: Object.freeze(normalized), roles, audiences: Object.freeze(declared) });
}
export function normalizeFlagScope(input: unknown): FlagScope {
  const raw = object(capture(input), ['appId', 'environment', 'tenantId']);
  name(raw.appId);
  name(raw.environment);
  if (raw.tenantId !== null) name(raw.tenantId);
  return raw as unknown as FlagScope;
}
export function normalizeFlagContext(input: unknown, catalog: FlagCatalog): FlagContext {
  const raw = object(capture(input), ['identity', 'roles', 'attributes', 'tenantId']);
  if (Object.hasOwn(raw, 'tenantId')) name(raw.tenantId);
  if (Object.hasOwn(raw, 'identity')) {
    const identity = object(raw.identity, ['kind', 'id']);
    if (identity.kind !== 'subject' && identity.kind !== 'visitor') refuse('Invalid flag identity kind.');
    name(identity.id);
  }
  if (Object.hasOwn(raw, 'roles') && !(Array.isArray(raw.roles) && raw.roles.length === 0))
    names(raw.roles, FLAG_LIMITS.roles, catalog.roles);
  if (Object.hasOwn(raw, 'attributes')) {
    const attributes = object(raw.attributes, AUDIENCE_ATTRIBUTES);
    if (Object.hasOwn(attributes, 'emailDomain')) domain(attributes.emailDomain);
  }
  return raw as unknown as FlagContext;
}
export function normalizeFlagAssignment(input: unknown): FlagAssignment {
  const raw = object(capture(input), ['appId', 'environment', 'tenantId', 'flagId', 'experimentVersion', 'identity', 'purpose']);
  normalizeFlagScope({ appId: raw.appId, environment: raw.environment, tenantId: raw.tenantId });
  name(raw.flagId);
  if (raw.experimentVersion !== null) name(raw.experimentVersion);
  if (raw.purpose !== 'rollout' && raw.purpose !== 'variant') refuse('Invalid assignment purpose.');
  if (Object.hasOwn(raw, 'identity')) normalizeFlagContext({ identity: raw.identity }, { flags: {}, roles: [], audiences: {} });
  return raw as unknown as FlagAssignment;
}
function decisionValue(value: unknown, declared: FlagDefinition): FlagValue {
  const result = typedValue(value, declared.type);
  if (declared.variants && !declared.variants.some((item) => flagValuesEqual(item, result))) refuse('Undeclared flag variant.');
  return result;
}
function percentage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)
    return refuse('Flag percentage must be between 0 and 100.');
  return value;
}
export function normalizeFlagSnapshot(input: unknown, catalog: FlagCatalog): FlagOverrideSnapshot {
  const raw = object(capture(input), ['appId', 'environment', 'tenantId', 'revision', 'overrides']);
  normalizeFlagScope({ appId: raw.appId, environment: raw.environment, tenantId: raw.tenantId });
  if (!Number.isSafeInteger(raw.revision) || (raw.revision as number) < 0) refuse('Invalid flag snapshot revision.');
  const overrides = object(raw.overrides);
  for (const [flagId, inputOverride] of Object.entries(overrides)) {
    if (!Object.hasOwn(catalog.flags, flagId)) refuse('Undeclared flag override.');
    const declared = catalog.flags[flagId];
    if (raw.tenantId !== null && !declared.tenantManaged) refuse('Flag is not tenant managed.');
    const override = object(inputOverride, ['value', 'disabled', 'rules', 'rollout', 'experiment']);
    optionalBoolean(override, 'disabled');
    if (override.disabled && declared.safeValue === undefined) refuse('This flag has no kill-switch safe value.');
    if (Object.hasOwn(override, 'value')) decisionValue(override.value, declared);
    if (Object.hasOwn(override, 'rollout')) {
      percentage(override.rollout);
      if (!Object.hasOwn(override, 'value') && !Object.hasOwn(override, 'experiment')) refuse('A rollout needs a value or experiment.');
    }
    if (Object.hasOwn(override, 'rules')) {
      const rules = Array.isArray(override.rules) && override.rules.length === 0 ? [] : list(override.rules, FLAG_LIMITS.rules);
      for (const inputRule of rules) {
        const retired = ['roles', 'tenants'].find((key) => inputRule && typeof inputRule === 'object' && Object.hasOwn(inputRule, key));
        if (retired) refuse(`A flag rule names its ${retired} through an audience: declare one with ${retired} and name it in audiences.`);
        const rule = object(inputRule, ['audiences', 'value']);
        decisionValue(rule.value, declared);
        if (!Object.hasOwn(rule, 'audiences')) refuse('A targeting rule names at least one audience.');
        names(rule.audiences, FLAG_LIMITS.audiences, Object.keys(catalog.audiences));
      }
    }
    if (Object.hasOwn(override, 'experiment')) {
      if (Object.hasOwn(override, 'value')) refuse('An experiment and a fixed value are mutually exclusive.');
      const experiment = object(override.experiment, ['version', 'weights']);
      name(experiment.version);
      const variants = declared.variants;
      if (!variants || variants.length < 2) return refuse('An experiment needs at least two declared variants.');
      const weights = list(experiment.weights, FLAG_LIMITS.variants);
      const seen = new Set<number>();
      let total = 0;
      for (const inputWeight of weights) {
        const weight = object(inputWeight, ['value', 'weight']);
        const value = decisionValue(weight.value, declared);
        const index = variants.findIndex((item) => flagValuesEqual(item, value));
        if (seen.has(index)) refuse('Duplicate experiment variant.');
        seen.add(index);
        total += percentage(weight.weight);
      }
      if (seen.size !== variants.length || total !== 100) refuse('Experiment weights must cover every variant and total 100.');
    }
  }
  return raw as unknown as FlagOverrideSnapshot;
}
