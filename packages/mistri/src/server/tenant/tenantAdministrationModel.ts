import { createHash } from 'node:crypto';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantStoreBinding } from './tenantStore.js';
import {
  ADMINISTRATION_OPERATIONS,
  ASSISTANT_CONSENT_MOST,
  type AdministrationIntent,
  type AdministrationOperation,
} from '../../shared/tenantAdministration.js';
import { captureDelegates, type DelegateRule } from './tenantDelegation.js';

export { ADMINISTRATION_OPERATIONS, type AdministrationIntent, type AdministrationOperation } from '../../shared/tenantAdministration.js';
/** What a tenant's own member may be delegated: its members, never the tenant row; and turning its assistant
 * off, never on, and likewise any provider's decisions (the owner refuses a delegate's `enabled: true`). */
export const DELEGABLE_ADMINISTRATION_OPERATIONS = Object.freeze([
  'grantMembership',
  'replaceMembership',
  'revokeMembership',
  'setTenantAssistant',
  'setTenantDecisions',
  /* A tenant's owner clones its own tenant into a sandbox, and approves a sandbox's import into it.
     An import is the live tenant's own decision: an operator rule naming it is refused. */
  'cloneTenant',
  'importTenant',
] as const);
/** The operations that grant no roles, so a rule naming only them has an empty ceiling. */
export const ROLELESS_ADMINISTRATION_OPERATIONS: readonly AdministrationOperation[] = Object.freeze([
  'createTenant',
  'setTenantStatus',
  'setTenantAssistant',
  'setTenantDecisions',
  'cloneTenant',
  'importTenant',
]);
export type DelegableAdministrationOperation = (typeof DELEGABLE_ADMINISTRATION_OPERATIONS)[number];
export interface AdministrationPolicy {
  readonly id: string;
  readonly version: string;
  readonly maxMembershipLifetimeMs: number;
  readonly operators: readonly {
    readonly accountId: string;
    readonly tenants: readonly string[];
    readonly operations: readonly AdministrationOperation[];
    readonly roles: readonly string[];
  }[];
  /** A tenant's own members administering it (tenantDelegation.ts). */
  readonly delegates?: readonly DelegateRule<DelegableAdministrationOperation>[];
}
type AdministrationGrant = AdministrationPolicy['operators'][number];
const maximumLifetimeMs = 366 * 24 * 60 * 60 * 1000;
const ruleFields = ['accountId', 'tenants', 'operations', 'roles'];
const intentFields: Record<AdministrationOperation, readonly string[]> = {
  createTenant: ['operation', 'tenantId'],
  setTenantStatus: ['operation', 'tenantId', 'expectedTenantVersion', 'status'],
  grantMembership: ['operation', 'tenantId', 'expectedTenantVersion', 'accountId', 'roles', 'validUntil'],
  replaceMembership: ['operation', 'tenantId', 'expectedTenantVersion', 'membershipId', 'expectedMembershipVersion', 'roles', 'validUntil'],
  revokeMembership: ['operation', 'tenantId', 'expectedTenantVersion', 'membershipId', 'expectedMembershipVersion'],
  setTenantAssistant: ['operation', 'tenantId', 'expectedTenantVersion', 'enabled', 'consent'],
  setTenantDecisions: ['operation', 'tenantId', 'expectedTenantVersion', 'provider', 'enabled', 'consent'],
  cloneTenant: ['operation', 'tenantId', 'sourceTenantId', 'expectedSourceVersion', 'samples'],
  importTenant: ['operation', 'tenantId', 'expectedTenantVersion', 'sandboxTenantId', 'expectedSandboxVersion'],
};

function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  tenantRecord(value, fields);
  if (fields.some((field) => !Object.hasOwn(value, field))) denyTenant();
}
function operation(value: unknown): asserts value is AdministrationOperation {
  if (typeof value !== 'string' || !ADMINISTRATION_OPERATIONS.includes(value as AdministrationOperation)) denyTenant();
}
function revision(value: unknown): void {
  if (typeof value !== 'string' || value.length > 128 || !/^[1-9][0-9]*$/.test(value)) denyTenant();
}
function list(value: unknown, maximum: number, minimum = 1): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || new Set(value).size !== value.length) denyTenant();
}
function roles(value: unknown, minimum = 1): asserts value is readonly string[] {
  list(value, 256, minimum);
  for (const role of value) tenantIdentifier(role);
}
function time(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) denyTenant();
}
function rule(value: unknown): asserts value is AdministrationGrant {
  exact(value, ruleFields);
  tenantIdentifier(value.accountId, 1024);
  list(value.tenants, 256);
  for (const tenantId of value.tenants) {
    tenantIdentifier(tenantId, 128);
    parseTenantSelector([tenantId]);
  }
  list(value.operations, ADMINISTRATION_OPERATIONS.length);
  for (const entry of value.operations) operation(entry);
  roles(
    value.roles,
    value.operations.every((entry) => ROLELESS_ADMINISTRATION_OPERATIONS.includes(entry as AdministrationOperation)) ? 0 : 1,
  );
}

/* Recorded for the operator's console alone (evidence.ts): the key and the limit, which the fixed sentence never named. */
const policyRefusal = (reason: string): never => denyTenant(new Error(`The tenant policy's administration.${reason}`));
/** Detached, frozen server policy. Native roles and business memberships supply no grants here. */
export function captureAdministrationPolicy(input: unknown): AdministrationPolicy {
  const value = captureTenantData(input);
  tenantRecord(value, ['id', 'version', 'maxMembershipLifetimeMs', 'operators', 'delegates']);
  exact(value, ['id', 'version', 'maxMembershipLifetimeMs', 'operators', ...(Object.hasOwn(value, 'delegates') ? ['delegates'] : [])]);
  tenantIdentifier(value.id);
  tenantIdentifier(value.version);
  if (
    typeof value.maxMembershipLifetimeMs !== 'number' ||
    !Number.isSafeInteger(value.maxMembershipLifetimeMs) ||
    value.maxMembershipLifetimeMs < 1 ||
    value.maxMembershipLifetimeMs > maximumLifetimeMs
  )
    return policyRefusal(
      `maxMembershipLifetimeMs is ${JSON.stringify(value.maxMembershipLifetimeMs)}; it is a whole number from 1 to ${maximumLifetimeMs} ms.`,
    );
  if (Object.hasOwn(value, 'delegates'))
    captureDelegates(value.delegates, DELEGABLE_ADMINISTRATION_OPERATIONS, ROLELESS_ADMINISTRATION_OPERATIONS);
  // With delegates, a policy may name no operator at all; without, it grants nothing and is refused.
  if (!Array.isArray(value.operators) || (!value.operators.length && !Object.hasOwn(value, 'delegates')) || value.operators.length > 256)
    return policyRefusal('operators is a list of 1 to 256 { accountId, tenants, operations, roles }, or empty beside delegates.');
  for (const entry of value.operators) rule(entry);
  // A target/operation must have one ceiling, independent of declaration order.
  const operators = value.operators as AdministrationGrant[];
  for (const [index, entry] of operators.entries()) {
    if (
      operators
        .slice(0, index)
        .some(
          (previous) =>
            previous.accountId === entry.accountId &&
            previous.tenants.some((tenantId) => entry.tenants.includes(tenantId)) &&
            previous.operations.some((operation) => entry.operations.includes(operation)),
        )
    )
      return policyRefusal(`operators grants ${entry.accountId} the same operation on the same tenant twice.`);
  }
  return value as unknown as AdministrationPolicy;
}

/** Capture before inspecting discriminants, so even rejected keys cannot execute hooks. */
export function captureAdministrationIntent(input: unknown): AdministrationIntent {
  const value = captureTenantData(input);
  tenantRecord(value);
  operation(value.operation);
  exact(value, intentFields[value.operation]);
  tenantIdentifier(value.tenantId, 128);
  parseTenantSelector([value.tenantId]);
  if (value.operation !== 'createTenant' && value.operation !== 'cloneTenant') revision(value.expectedTenantVersion);
  if (value.operation === 'cloneTenant') {
    tenantIdentifier(value.sourceTenantId, 128);
    parseTenantSelector([value.sourceTenantId]);
    revision(value.expectedSourceVersion);
    if (typeof value.samples !== 'boolean' || value.sourceTenantId === value.tenantId) denyTenant();
  }
  if (value.operation === 'importTenant') {
    tenantIdentifier(value.sandboxTenantId, 128);
    parseTenantSelector([value.sandboxTenantId]);
    revision(value.expectedSandboxVersion);
    if (value.sandboxTenantId === value.tenantId) denyTenant();
  }
  if (value.operation === 'setTenantStatus' && value.status !== 'active' && value.status !== 'suspended' && value.status !== 'closed')
    return denyTenant();
  if (value.operation === 'grantMembership') tenantIdentifier(value.accountId, 1024);
  if (value.operation === 'replaceMembership' || value.operation === 'revokeMembership') {
    tenantIdentifier(value.membershipId, 1024);
    revision(value.expectedMembershipVersion);
  }
  if (value.operation === 'grantMembership' || value.operation === 'replaceMembership') {
    roles(value.roles);
    time(value.validUntil);
  }
  if (value.operation === 'setTenantAssistant') assistantSwitch(value.enabled, value.consent);
  if (value.operation === 'setTenantDecisions') {
    if (typeof value.provider !== 'string' || !/^[a-z]{1,32}$/.test(value.provider)) denyTenant();
    assistantSwitch(value.enabled, value.consent);
  }
  return value as unknown as AdministrationIntent;
}

/** A switch's terms: on needs the customer's consent reference, said in one plain line; off may say why. */
export function assistantSwitch(enabled: unknown, consent: unknown): void {
  if (
    typeof enabled !== 'boolean' ||
    typeof consent !== 'string' ||
    consent !== consent.trim() ||
    [...consent].length > ASSISTANT_CONSENT_MOST ||
    /[\p{Cc}\p{Cs}]/u.test(consent) ||
    (enabled && !consent)
  )
    denyTenant();
}

/** Policy capture guarantees one matching rule and one role ceiling. */
export function administrationGrant(
  policy: AdministrationPolicy,
  accountId: string,
  tenantId: string,
  requestedOperation: AdministrationOperation,
): AdministrationGrant {
  const captured = captureAdministrationPolicy(policy);
  tenantIdentifier(accountId, 1024);
  parseTenantSelector([tenantId]);
  operation(requestedOperation);
  return (
    captured.operators.find(
      (entry) => entry.accountId === accountId && entry.tenants.includes(tenantId) && entry.operations.includes(requestedOperation),
    ) ?? denyTenant()
  );
}

/** The explicit operator grant for this exact account, tenant and operation,
 * or null: a delegate's authority is read from the store, never from here. */
export function operatorGrant(
  policy: AdministrationPolicy,
  accountId: string,
  tenantId: string,
  requestedOperation: AdministrationOperation,
): AdministrationGrant | null {
  const captured = captureAdministrationPolicy(policy);
  /* An import is approved by the live tenant's own owner, through its own
     membership: never an operator's side door. A rule may list it, as a rule
     listing every operation does, and it grants nothing. */
  if (requestedOperation === 'importTenant') return null;
  return (
    captured.operators.find(
      (entry) => entry.accountId === accountId && entry.tenants.includes(tenantId) && entry.operations.includes(requestedOperation),
    ) ?? null
  );
}

/** A delegate's terms: the requested roles within the ceiling its own
 * membership earned, and the policy's lifetime. */
export function assertDelegatedTerms(
  policy: AdministrationPolicy,
  ceiling: readonly string[],
  requestedRoles: readonly string[],
  validUntil: number,
  now: number,
): void {
  const captured = captureAdministrationPolicy(policy);
  const requested = captureTenantData(requestedRoles);
  roles(requested);
  if (
    !captured.delegates?.some((rule) => rule.roles.length === ceiling.length && rule.roles.every((role) => ceiling.includes(role))) ||
    requested.some((role) => !ceiling.includes(role))
  )
    return denyTenant();
  time(now);
  time(validUntil);
  if (
    now > Number.MAX_SAFE_INTEGER - captured.maxMembershipLifetimeMs ||
    validUntil <= now ||
    validUntil > now + captured.maxMembershipLifetimeMs
  )
    denyTenant();
}

/** The service separately checks existing roles and current tenant/membership revisions. */
export function assertAdministrationRoles(
  policy: AdministrationPolicy,
  grant: AdministrationGrant,
  requestedRoles: readonly string[],
  validUntil: number,
  now: number,
): void {
  const captured = captureAdministrationPolicy(policy);
  const ceiling = captureTenantData(grant);
  rule(ceiling);
  const sameSet = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length && left.every((value) => right.includes(value));
  if (
    !captured.operators.some(
      (entry) =>
        entry.accountId === ceiling.accountId &&
        sameSet(entry.tenants, ceiling.tenants) &&
        sameSet(entry.operations, ceiling.operations) &&
        sameSet(entry.roles, ceiling.roles),
    )
  )
    return denyTenant();
  const requested = captureTenantData(requestedRoles);
  roles(requested);
  if (requested.some((role) => !ceiling.roles.includes(role))) return denyTenant();
  time(now);
  time(validUntil);
  if (
    now > Number.MAX_SAFE_INTEGER - captured.maxMembershipLifetimeMs ||
    validUntil <= now ||
    validUntil > now + captured.maxMembershipLifetimeMs
  )
    denyTenant();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Durable attempt meaning excludes connection aliases and deployment/session epochs.
 * Policy content changes require a new policy version; current grants are rechecked by the service. */
export function administrationFingerprint(policy: AdministrationPolicy, binding: TenantStoreBinding, intent: AdministrationIntent): string {
  const capturedPolicy = captureAdministrationPolicy(policy);
  const owner = captureTenantData(binding);
  exact(owner, ['appId', 'source', 'storeId']);
  tenantIdentifier(owner.appId);
  tenantIdentifier(owner.storeId);
  exact(owner.source, ['id', 'connection']);
  tenantIdentifier(owner.source.id);
  tenantIdentifier(owner.source.connection, 1024);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(owner.source.id)) return denyTenant();
  const capturedIntent = captureAdministrationIntent(intent);
  const normalizedIntent = 'roles' in capturedIntent ? { ...capturedIntent, roles: [...capturedIntent.roles].sort() } : capturedIntent;
  return createHash('sha256')
    .update(
      canonical({
        operationVersion: 1,
        policy: { id: capturedPolicy.id, version: capturedPolicy.version },
        binding: { appId: owner.appId, storeId: owner.storeId, source: { id: owner.source.id } },
        intent: normalizedIntent,
      }),
    )
    .digest('hex');
}
