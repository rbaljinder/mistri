/** Private PG invitation link attestation; no enrollment or authority creation. */
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { describePostgresRelations } from '../../adapters/commands/postgresCommandJournal.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { INVITATION_TABLES } from './tenantInvitationStore.js';
import { assertPostgresTenantInvitations } from './tenantInvitationStorePostgres.js';
import { TENANT_TABLES, type TenantStoreBinding } from './tenantStore.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

/** Capture presence even without a current invitation policy. Partial or foreign
 * reserved layouts must reach the attestor, never masquerade as absent storage. */
export async function postgresInvitationStoragePresent(client: PgQuery): Promise<boolean> {
  return (await describePostgresRelations(client, '__mistri_invitation_')).length !== 0;
}

/** Entry/final fence only, not between the two writes of a linked transition.
 * Accepted membership roles/expiry may evolve independently of its history. */
export async function assertLinkedPostgresTenantInvitations(client: PgQuery, binding: TenantStoreBinding): Promise<void> {
  try {
    await assertPostgresTenantInvitations(client, binding);
    const broken = await client.query(`SELECT 1 FROM ${runtimeTable('postgres', INVITATION_TABLES.invitation)} i
      LEFT JOIN ${runtimeTable('postgres', TENANT_TABLES.membership)} m ON m.id = i.membership_id AND m.kind = 'member'
      LEFT JOIN ${runtimeTable('postgres', TENANT_TABLES.tenant)} t ON t.id = i.tenant_id AND t.kind = 'tenant'
      WHERE m.id IS NULL OR t.id IS NULL OR m.tenant_id <> i.tenant_id
        OR m.account_id <> i.account_id
        OR (i.status = 'pending' AND m.status <> 'invited')
        OR (i.status = 'accepted' AND m.status NOT IN ('active', 'revoked'))
        OR (i.status = 'revoked' AND m.status <> 'revoked')
        OR (i.status IN ('pending', 'revoked') AND (m.valid_until <> i.valid_until
          OR EXISTS (SELECT value::jsonb FROM json_array_elements(i.roles_json::json)
            EXCEPT SELECT value::jsonb FROM json_array_elements(m.roles_json::json))
          OR EXISTS (SELECT value::jsonb FROM json_array_elements(m.roles_json::json)
            EXCEPT SELECT value::jsonb FROM json_array_elements(i.roles_json::json))))
      LIMIT 1`);
    if (broken.rows.length) denyTenant();
  } catch {
    denyTenant();
  }
}
