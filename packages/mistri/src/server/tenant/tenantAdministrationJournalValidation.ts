/** Shared journal data/validation only; operation dispatch must not be imported here. */
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import type { TenantStoreBinding } from './tenantStoreContract.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';
import { PLATFORM_MAINTENANCE_OPERATIONS } from './tenantMaintenanceChange.js';

/** Private maintenance provenance; none of these rows are App resources. */
export interface AdministrationReceiptScope {
  actorId: string;
  tenantId: string;
  operation: string;
  operationVersion: number;
  idempotencyKey: string;
}
export interface StoredAdministrationReceipt extends AdministrationReceiptScope {
  id: string;
  fingerprint: string;
  resultJson: string;
  requestId: string;
  completedAt: string;
}
export interface AdministrationAudit {
  policyId: string;
  policyVersion: string;
  deployment: string;
  /** Native session ID only, never its bearer token. */
  sessionId: string;
  changeJson: string;
}
export function identifier(value: unknown, maximum = 256): asserts value is string {
  tenantIdentifier(value, maximum);
  if (Buffer.byteLength(value, 'utf8') > maximum || /[\uD800-\uDFFF]/u.test(value)) denyTenant();
}
export function binding(input: TenantStoreBinding): TenantStoreBinding {
  const value = captureTenantData(input);
  tenantRecord(value, ['appId', 'source', 'storeId']);
  // Keep the tenant-store binding contract, including transient connection aliases.
  tenantIdentifier(value.appId);
  tenantIdentifier(value.storeId);
  tenantRecord(value.source, ['id', 'connection']);
  tenantIdentifier(value.source.id);
  tenantIdentifier(value.source.connection, 1024);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value.source.id)) return denyTenant();
  return value;
}
export const scopeFields = ['actorId', 'tenantId', 'operation', 'operationVersion', 'idempotencyKey'];
export const receiptFields = [...scopeFields, 'id', 'fingerprint', 'resultJson', 'requestId', 'completedAt'];
export function scopeValues(value: AdministrationReceiptScope): [string, string, string, number, string] {
  identifier(value.actorId, 1024);
  identifier(value.operation);
  // Platform maintenance is scoped to the platform's reserved row, the one
  // scope that is not a tenant selector, and only under those operation names.
  if (value.tenantId !== PLATFORM_TENANT_ID || !PLATFORM_MAINTENANCE_OPERATIONS.includes(value.operation))
    parseTenantSelector([value.tenantId]);
  identifier(value.idempotencyKey);
  if (!Number.isSafeInteger(value.operationVersion) || value.operationVersion < 1) return denyTenant();
  return [value.actorId, value.tenantId, value.operation, value.operationVersion, value.idempotencyKey];
}
export function json(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maximum) return denyTenant();
  // The shared snapshot bounds depth/nodes and rejects non-finite numbers. The
  // service owns the operation-specific result/change shapes, not this store.
  captureTenantData(JSON.parse(value));
}
export function validateReceipt(value: StoredAdministrationReceipt): void {
  tenantRecord(value, receiptFields);
  scopeValues(value);
  identifier(value.id, 1024);
  identifier(value.fingerprint);
  identifier(value.requestId, 1024);
  identifier(value.completedAt, 32);
  const date = new Date(value.completedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value.completedAt) return denyTenant();
  json(value.resultJson, 16 * 1024);
}
export function validateAudit(value: AdministrationAudit): void {
  tenantRecord(value, ['policyId', 'policyVersion', 'deployment', 'sessionId', 'changeJson']);
  identifier(value.policyId);
  identifier(value.policyVersion);
  identifier(value.deployment);
  identifier(value.sessionId, 1024);
  json(value.changeJson, 64 * 1024);
}
