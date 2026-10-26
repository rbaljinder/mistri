/**
 * What a maintenance receipt may say. @mistriwork/mistri/maintenance journals each of
 * its tenant-store steps in the administration journal, beside the
 * operators', invitations' and support receipts, under the actor
 * `maintenance:<operator>` and an operation name no other writer uses, so no
 * browser recovery path can ever replay one. The journal validates a stored
 * pair by its operation (tenantAdministrationJournalContract.ts); this is
 * that validation for the maintenance names: exact shapes, the actor prefix,
 * and the one compare-and-set step each change is. Pure: no clock, store or
 * native account is consulted.
 */
import { isDeepStrictEqual } from 'node:util';
import type { AdministrationAudit, StoredAdministrationReceipt } from './tenantAdministrationJournalValidation.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';

export const MAINTENANCE_OPERATIONS = Object.freeze([
  'putTenant',
  'setPlatformStatus',
  'grantPlatformMembership',
  'revokePlatformMembership',
  'grantTenantMembership',
  'revokeTenantMembership',
  'cloneSandbox',
  'setSandboxClock',
] as const);
export type MaintenanceOperation = (typeof MAINTENANCE_OPERATIONS)[number];
/** The operations whose receipt sits under the platform's reserved row, the
 * one journal scope that is not a tenant selector. */
export const PLATFORM_MAINTENANCE_OPERATIONS: readonly string[] = Object.freeze([
  'setPlatformStatus',
  'grantPlatformMembership',
  'revokePlatformMembership',
]);
/** What stands in the audit's policy columns: maintenance has no policy file. */
export const MAINTENANCE_POLICY = Object.freeze({ id: 'mistri-maintenance', version: '1' });
export const MAINTENANCE_ACTOR_PREFIX = 'maintenance:';
/** An operator name: what follows the prefix. */
export const MAINTENANCE_OPERATOR = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;

export interface MaintenanceAnchorImage {
  readonly tenantId: string;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly version: string;
}
export interface MaintenanceMemberImage {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly status: 'active' | 'invited' | 'revoked';
  readonly version: string;
  readonly roles: readonly string[];
  readonly validUntil: number;
}
export type MaintenanceChange =
  | Readonly<{ operation: 'putTenant' | 'setPlatformStatus'; before: MaintenanceAnchorImage | null; after: MaintenanceAnchorImage }>
  | Readonly<{
      operation: 'grantPlatformMembership' | 'grantTenantMembership';
      anchor: MaintenanceAnchorImage;
      membership: MaintenanceMemberImage;
    }>
  | Readonly<{
      operation: 'revokeTenantMembership';
      anchor: MaintenanceAnchorImage;
      before: MaintenanceMemberImage;
      after: MaintenanceMemberImage;
    }>
  | Readonly<{
      operation: 'revokePlatformMembership';
      anchor: MaintenanceAnchorImage;
      before: MaintenanceMemberImage;
      after: MaintenanceMemberImage;
      supportRevoked: readonly string[];
      /** Of the revoked support sessions, those whose audit chain did not verify
       * when their end was recorded, so no `parent_revoked` entry could be
       * appended to it. Cutting access never waits on a record it cannot repair,
       * so the receipt says which ones rather than the revocation refusing. */
      supportChainUnverified: readonly string[];
    }>
  /** A sandbox made from a copy of `source` (tenantCloneEngine.ts): the new tenant's row and how many rows it took. */
  | Readonly<{
      operation: 'cloneSandbox';
      source: MaintenanceAnchorImage;
      after: MaintenanceAnchorImage;
      samples: boolean;
      rows: number;
    }>
  /** A sandbox's dev clock, before and after (tenantSandboxClock.ts). */
  | Readonly<{
      operation: 'setSandboxClock';
      anchor: MaintenanceAnchorImage;
      before: MaintenanceClockImage;
      after: MaintenanceClockImage;
    }>;
interface MaintenanceClockImage {
  readonly skewMs: number;
  readonly rate: number;
  readonly setAt: number;
}
function clockImage(value: unknown): asserts value is MaintenanceClockImage {
  exact(value, ['skewMs', 'rate', 'setAt']);
  for (const field of [value.skewMs, value.rate, value.setAt])
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) denyTenant();
  if ((value.rate as number) < 1) denyTenant();
}

function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  tenantRecord(value, fields);
  if (fields.some((field) => !Object.hasOwn(value, field))) denyTenant();
}
function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,127}$/.test(value)) denyTenant();
}
const next = (value: string) => {
  const result = String(BigInt(value) + 1n);
  revision(result);
  return result;
};
function scopeTenant(value: unknown, platform: boolean): asserts value is string {
  if (platform) {
    if (value !== PLATFORM_TENANT_ID) denyTenant();
    return;
  }
  tenantIdentifier(value, 128);
  parseTenantSelector([value]);
}
function anchor(value: unknown, platform: boolean): asserts value is MaintenanceAnchorImage {
  exact(value, ['tenantId', 'status', 'version']);
  scopeTenant(value.tenantId, platform);
  revision(value.version);
  if (!['active', 'suspended', 'closed'].includes(value.status as string)) denyTenant();
}
function member(value: unknown, platform: boolean): asserts value is MaintenanceMemberImage {
  exact(value, ['membershipId', 'tenantId', 'accountId', 'status', 'version', 'roles', 'validUntil']);
  tenantIdentifier(value.membershipId, 1024);
  scopeTenant(value.tenantId, platform);
  tenantIdentifier(value.accountId, 1024);
  revision(value.version);
  if (
    !['active', 'invited', 'revoked'].includes(value.status as string) ||
    !Array.isArray(value.roles) ||
    !value.roles.length ||
    value.roles.length > 256 ||
    new Set(value.roles).size !== value.roles.length ||
    typeof value.validUntil !== 'number' ||
    !Number.isSafeInteger(value.validUntil) ||
    value.validUntil < 0
  )
    return denyTenant();
  for (const role of value.roles) tenantIdentifier(role);
}
const sameRoles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((role) => b.includes(role));
/** `after` is `before` revoked: the same membership, one version on, nothing else changed. */
const revokes = (before: MaintenanceMemberImage, after: MaintenanceMemberImage) =>
  after.status === 'revoked' &&
  after.membershipId === before.membershipId &&
  after.tenantId === before.tenantId &&
  after.accountId === before.accountId &&
  after.validUntil === before.validUntil &&
  sameRoles(after.roles, before.roles) &&
  after.version === next(before.version);

/** One maintenance change, checked against the operation and scope it is journaled under. */
export function captureMaintenanceChange(input: unknown, operation: string, tenantId: string): MaintenanceChange {
  const value = captureTenantData(input);
  if (!MAINTENANCE_OPERATIONS.includes(operation as MaintenanceOperation)) return denyTenant();
  const platform = PLATFORM_MAINTENANCE_OPERATIONS.includes(operation);
  scopeTenant(tenantId, platform);
  if (operation === 'putTenant' || operation === 'setPlatformStatus') {
    exact(value, ['operation', 'before', 'after']);
    anchor(value.after, platform);
    if (value.operation !== operation || value.after.tenantId !== tenantId) return denyTenant();
    if (value.before === null) {
      if (value.after.status !== 'active' || value.after.version !== '1') return denyTenant();
    } else {
      anchor(value.before, platform);
      if (value.before.tenantId !== tenantId || value.before.status === 'closed' || value.after.version !== next(value.before.version))
        return denyTenant();
    }
  } else if (operation === 'grantPlatformMembership' || operation === 'grantTenantMembership') {
    exact(value, ['operation', 'anchor', 'membership']);
    anchor(value.anchor, platform);
    member(value.membership, platform);
    if (
      value.operation !== operation ||
      value.anchor.tenantId !== tenantId ||
      value.anchor.status !== 'active' ||
      value.membership.tenantId !== tenantId ||
      value.membership.status !== 'active' ||
      value.membership.version !== '1'
    )
      return denyTenant();
  } else if (operation === 'cloneSandbox') {
    exact(value, ['operation', 'source', 'after', 'samples', 'rows']);
    anchor(value.source, false);
    anchor(value.after, false);
    if (
      value.operation !== operation ||
      value.after.tenantId !== tenantId ||
      value.source.tenantId === tenantId ||
      value.source.status !== 'active' ||
      value.after.status !== 'active' ||
      value.after.version !== '1' ||
      typeof value.samples !== 'boolean' ||
      typeof value.rows !== 'number' ||
      !Number.isSafeInteger(value.rows) ||
      value.rows < 0
    )
      return denyTenant();
  } else if (operation === 'setSandboxClock') {
    exact(value, ['operation', 'anchor', 'before', 'after']);
    anchor(value.anchor, false);
    clockImage(value.before);
    clockImage(value.after);
    if (value.operation !== operation || value.anchor.tenantId !== tenantId) return denyTenant();
  } else if (operation === 'revokeTenantMembership') {
    exact(value, ['operation', 'anchor', 'before', 'after']);
    anchor(value.anchor, false);
    member(value.before, false);
    member(value.after, false);
    // Maintenance revokes an active membership only: an invitation's pair is withdrawn with its invitation.
    if (
      value.operation !== operation ||
      value.anchor.tenantId !== tenantId ||
      value.before.tenantId !== tenantId ||
      value.before.status !== 'active' ||
      !revokes(value.before, value.after)
    )
      return denyTenant();
  } else {
    exact(value, ['operation', 'anchor', 'before', 'after', 'supportRevoked', 'supportChainUnverified']);
    anchor(value.anchor, true);
    member(value.before, true);
    member(value.after, true);
    const { before, after } = value;
    if (
      value.operation !== operation ||
      before.status === 'revoked' ||
      !revokes(before, after) ||
      !Array.isArray(value.supportRevoked) ||
      value.supportRevoked.length > 256 ||
      new Set(value.supportRevoked).size !== value.supportRevoked.length ||
      !Array.isArray(value.supportChainUnverified) ||
      value.supportChainUnverified.length > value.supportRevoked.length ||
      new Set(value.supportChainUnverified).size !== value.supportChainUnverified.length
    )
      return denyTenant();
    for (const id of value.supportRevoked) tenantIdentifier(id, 1024);
    // An unverifiable chain is said only of a session this step actually ended.
    for (const id of value.supportChainUnverified) {
      tenantIdentifier(id, 1024);
      if (!value.supportRevoked.includes(id)) return denyTenant();
    }
  }
  return value as unknown as MaintenanceChange;
}

function parse(value: unknown, maximum: number): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maximum) return denyTenant();
  try {
    return captureTenantData(JSON.parse(value));
  } catch {
    return denyTenant();
  }
}
/** The journal's read and commit both come here for a maintenance name. */
export function validateMaintenanceJournalPair(inputReceipt: StoredAdministrationReceipt, inputAudit: AdministrationAudit): void {
  const receipt = captureTenantData(inputReceipt),
    audit = captureTenantData(inputAudit);
  tenantRecord(receipt);
  tenantRecord(audit);
  if (
    typeof receipt.actorId !== 'string' ||
    !receipt.actorId.startsWith(MAINTENANCE_ACTOR_PREFIX) ||
    !MAINTENANCE_OPERATOR.test(receipt.actorId.slice(MAINTENANCE_ACTOR_PREFIX.length)) ||
    receipt.operationVersion !== 1 ||
    audit.policyId !== MAINTENANCE_POLICY.id ||
    audit.policyVersion !== MAINTENANCE_POLICY.version
  )
    return denyTenant();
  const result = parse(receipt.resultJson, 16 * 1024),
    change = parse(audit.changeJson, 64 * 1024);
  if (!isDeepStrictEqual(result, change)) return denyTenant();
  captureMaintenanceChange(result, receipt.operation, receipt.tenantId);
}
