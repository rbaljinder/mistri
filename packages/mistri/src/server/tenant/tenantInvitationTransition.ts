/** Shared storage transition meaning only; no membership, policy or auth proof. */
import { captureTenantData, denyTenant, tenantRecord } from '@mistriwork/engine/server/evidence.js';

/** The storage contract's existing UUID4 and revision assertions. */
export function invitationUuid(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length !== 36 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
  )
    denyTenant();
}
export function invitationRevision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 128 || !/^[1-9]/.test(value) || /[^0-9]/.test(value)) denyTenant();
}

export function planInvitationTransition(
  current: { invitationId: string; version: string; status: string } | null,
  input: { invitationId: string; expectedVersion: string; status: 'accepted' | 'revoked' },
) {
  const row = captureTenantData(current),
    request = captureTenantData(input);
  tenantRecord(request, ['invitationId', 'expectedVersion', 'status']);
  if (!row) return denyTenant();
  tenantRecord(row, ['invitationId', 'version', 'status']);
  invitationUuid(request.invitationId);
  invitationRevision(request.expectedVersion);
  if (
    row.invitationId !== request.invitationId ||
    row.version !== request.expectedVersion ||
    row.status !== 'pending' ||
    !['accepted', 'revoked'].includes(request.status)
  )
    return denyTenant();
  const nextVersion = String(BigInt(row.version) + 1n);
  invitationRevision(nextVersion);
  return Object.freeze({
    invitationId: request.invitationId,
    expectedVersion: request.expectedVersion,
    status: request.status,
    nextVersion,
  });
}
