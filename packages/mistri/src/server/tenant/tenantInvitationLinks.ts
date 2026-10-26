import type { DatabaseSync } from 'node:sqlite';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { INVITATION_TABLES, assertSqliteTenantInvitations } from './tenantInvitationStore.js';
import { TENANT_TABLES, type TenantStoreBinding } from './tenantStore.js';

/** Entry/final fence only. A composed transaction briefly changes one side
 * before the other, so per-facade-operation checks must not call this. Accepted
 * membership roles/expiry can evolve later; historical invitations cannot. */
export function assertLinkedTenantInvitations(db: DatabaseSync, binding: TenantStoreBinding): void {
  assertSqliteTenantInvitations(db, binding);
  const broken = db
    .prepare(`SELECT 1 FROM main."${INVITATION_TABLES.invitation}" i
    LEFT JOIN main."${TENANT_TABLES.membership}" m ON m.id = i.membership_id COLLATE BINARY AND m.kind = 'member'
    LEFT JOIN main."${TENANT_TABLES.tenant}" t ON t.id = i.tenant_id COLLATE BINARY AND t.kind = 'tenant'
    WHERE m.id IS NULL OR t.id IS NULL OR m.tenant_id <> i.tenant_id COLLATE BINARY
      OR m.account_id <> i.account_id COLLATE BINARY
      OR (i.status = 'pending' AND m.status <> 'invited')
      OR (i.status = 'accepted' AND m.status NOT IN ('active', 'revoked'))
      OR (i.status = 'revoked' AND m.status <> 'revoked')
      OR (i.status IN ('pending', 'revoked') AND (m.valid_until <> i.valid_until
        OR EXISTS (SELECT value FROM json_each(i.roles_json) EXCEPT SELECT value FROM json_each(m.roles_json))
        OR EXISTS (SELECT value FROM json_each(m.roles_json) EXCEPT SELECT value FROM json_each(i.roles_json))))
    LIMIT 1`)
    .get();
  if (broken) denyTenant();
}
