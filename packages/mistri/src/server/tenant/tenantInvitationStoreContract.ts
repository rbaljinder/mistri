/** Shared invitation row meaning; physical attestation and transactions stay in each store. */
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantStoreBinding } from './tenantStore.js';
import { invitationUuid as uuid, invitationRevision as revision } from './tenantInvitationTransition.js';

/** Private immutable issuance meaning. Never return this digest-bearing row to a browser. */
export interface StoredTenantInvitation {
  readonly invitationId: string;
  readonly version: string;
  readonly tenantId: string;
  readonly membershipId: string;
  readonly accountId: string;
  readonly inviterId: string;
  readonly issuanceOperation: 'issueInvitation' | 'reissueInvitation';
  readonly roles: readonly string[];
  readonly expectedTenantVersion: string;
  readonly policyId: string;
  readonly policyVersion: string;
  readonly createdAt: number;
  readonly redeemUntil: number;
  readonly validUntil: number;
  readonly status: 'pending' | 'accepted' | 'revoked';
  readonly digest: string;
}

export const invitationFields = Object.freeze([
  'invitationId',
  'version',
  'tenantId',
  'membershipId',
  'accountId',
  'inviterId',
  'issuanceOperation',
  'roles',
  'expectedTenantVersion',
  'policyId',
  'policyVersion',
  'createdAt',
  'redeemUntil',
  'validUntil',
  'status',
  'digest',
] as const);
export const invitationColumns = Object.freeze([
  'invitation_id',
  'version',
  'tenant_id',
  'membership_id',
  'account_id',
  'inviter_id',
  'issuance_operation',
  'roles_json',
  'expected_tenant_version',
  'policy_id',
  'policy_version',
  'created_at',
  'redeem_until',
  'valid_until',
  'status',
  'digest',
] as const);
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  tenantRecord(value, keys);
  if (keys.some((key) => !Object.hasOwn(value, key))) denyTenant();
}
function identifier(value: unknown, maximum = 256): asserts value is string {
  tenantIdentifier(value, maximum);
  if (Buffer.byteLength(value, 'utf8') > maximum || /[\uD800-\uDFFF]/u.test(value)) denyTenant();
}
function time(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) denyTenant();
}

/** Capture descriptors before inspecting data; no getters, proxies or serialization hooks run. */
export function captureStoredTenantInvitation(input: unknown): StoredTenantInvitation {
  const value = captureTenantData(input);
  exact(value, invitationFields);
  uuid(value.invitationId);
  uuid(value.membershipId);
  revision(value.version);
  revision(value.expectedTenantVersion);
  identifier(value.tenantId, 128);
  parseTenantSelector([value.tenantId]);
  identifier(value.accountId, 1024);
  identifier(value.inviterId, 1024);
  identifier(value.policyId);
  identifier(value.policyVersion);
  if (value.issuanceOperation !== 'issueInvitation' && value.issuanceOperation !== 'reissueInvitation') return denyTenant();
  if (!Array.isArray(value.roles) || !value.roles.length || value.roles.length > 256 || new Set(value.roles).size !== value.roles.length)
    return denyTenant();
  for (const role of value.roles) identifier(role);
  time(value.createdAt);
  time(value.redeemUntil);
  time(value.validUntil);
  if (value.createdAt >= value.redeemUntil || value.redeemUntil > value.validUntil) return denyTenant();
  if (value.status !== 'pending' && value.status !== 'accepted' && value.status !== 'revoked') return denyTenant();
  if (typeof value.digest !== 'string' || value.digest.length !== 64 || !/^[0-9a-f]{64}$/.test(value.digest)) return denyTenant();
  return Object.freeze({ ...value, roles: Object.freeze([...value.roles].sort()) }) as unknown as StoredTenantInvitation;
}

export function invitationBinding(input: TenantStoreBinding): TenantStoreBinding {
  const value = captureTenantData(input);
  exact(value, ['appId', 'source', 'storeId']);
  tenantIdentifier(value.appId);
  tenantIdentifier(value.storeId);
  exact(value.source, ['id', 'connection']);
  tenantIdentifier(value.source.id);
  tenantIdentifier(value.source.connection, 1024);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.source.id)) return denyTenant();
  return value;
}

/** SQL rows use logical aliases; each backend must attest its physical row
 * and return exact safe-number times before calling this common decoder. */
export function decodeInvitationRow(input: unknown): StoredTenantInvitation {
  const value = captureTenantData(input);
  exact(value, invitationFields);
  if (typeof value.roles !== 'string' || Buffer.byteLength(value.roles, 'utf8') > 262144) return denyTenant();
  const captured = captureStoredTenantInvitation({ ...value, roles: JSON.parse(value.roles) });
  if (JSON.stringify(captured.roles) !== value.roles) return denyTenant();
  return captured;
}

export function invitationRowValues(input: StoredTenantInvitation): readonly (string | number)[] {
  const row = captureStoredTenantInvitation(input);
  return Object.freeze(invitationFields.map((field) => (field === 'roles' ? JSON.stringify(row.roles) : row[field])));
}
