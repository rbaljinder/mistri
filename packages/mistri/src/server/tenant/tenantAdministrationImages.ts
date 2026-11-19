/**
 * The shapes administration reads back and judges before releasing them: a tenant's, a membership's, a switch's and the
 * state of a change, and the small guards beneath them. Each denies what is not exactly its shape; none is authority.
 */
import { denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import type {
  AdministrationAssistantImage as AssistantImage,
  AdministrationDecisionSwitch as DecisionSwitch,
  AdministrationMembershipImage as MembershipImage,
  AdministrationState,
  AdministrationTenantImage as TenantImage,
} from '../../shared/tenantAdministration.js';
import { assistantSwitch } from './tenantAdministrationModel.js';
import { CLONE_ROWS_MOST } from './tenantCloneEngine.js';
import { parseTenantSelector } from './tenantMembership.js';

export function exact(
  value: unknown,
  fields: readonly string[],
  optional: readonly string[] = [],
): asserts value is Record<string, unknown> {
  tenantRecord(value, [...fields, ...optional]);
  if (fields.some((field) => !Object.hasOwn(value, field))) denyTenant();
}
function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 128 || !/^[1-9][0-9]*$/.test(value)) denyTenant();
}
export function next(value: string): string {
  const result = String(BigInt(value) + 1n);
  revision(result);
  return result;
}
export function time(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) denyTenant();
}
export function count(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > CLONE_ROWS_MOST) denyTenant();
}
export function tenantImage(value: unknown): asserts value is TenantImage {
  exact(value, ['tenantId', 'status', 'version']);
  tenantIdentifier(value.tenantId, 128);
  parseTenantSelector([value.tenantId]);
  revision(value.version);
  if (!['active', 'suspended', 'closed'].includes(value.status as string)) denyTenant();
}
export function membershipImage(value: unknown): asserts value is MembershipImage {
  exact(value, ['membershipId', 'tenantId', 'accountId', 'status', 'version', 'roles', 'validUntil']);
  tenantIdentifier(value.membershipId, 1024);
  tenantIdentifier(value.tenantId, 128);
  parseTenantSelector([value.tenantId]);
  tenantIdentifier(value.accountId, 1024);
  revision(value.version);
  time(value.validUntil);
  if (
    !['active', 'invited', 'revoked'].includes(value.status as string) ||
    !Array.isArray(value.roles) ||
    value.roles.length > 256 ||
    new Set(value.roles).size !== value.roles.length
  )
    return denyTenant();
  for (const role of value.roles) tenantIdentifier(role);
}
function assistantImage(value: unknown): asserts value is AssistantImage {
  exact(value, ['enabled', 'consent']);
  // A stored switch was off and unconsented before it was first set; its consent is otherwise a switch's.
  if (!(value.enabled === false && value.consent === '')) assistantSwitch(value.enabled, value.consent);
}
function decisionImage(value: unknown): asserts value is DecisionSwitch {
  exact(value, ['provider', 'enabled', 'consent']);
  if (typeof value.provider !== 'string' || !/^[a-z]{1,32}$/.test(value.provider)) return denyTenant();
  // As the assistant's: a switch never set was off and unconsented.
  if (!(value.enabled === false && value.consent === '')) assistantSwitch(value.enabled, value.consent);
}
export function stateImage(value: unknown): asserts value is AdministrationState {
  exact(value, ['tenant'], ['membership', 'assistant', 'decisions']);
  tenantImage(value.tenant);
  if (Object.hasOwn(value, 'assistant')) assistantImage(value.assistant);
  if (Object.hasOwn(value, 'decisions')) decisionImage(value.decisions);
  if (Object.hasOwn(value, 'membership')) {
    membershipImage(value.membership);
    if (value.membership.tenantId !== value.tenant.tenantId) denyTenant();
  }
}
