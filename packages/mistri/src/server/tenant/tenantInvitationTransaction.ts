/** Private SQLite owner port. No connection, transaction, or authority creation. */
import type { DatabaseSync } from 'node:sqlite';
import { isPromise } from 'node:util/types';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { AdministrationMembershipImage, AdministrationTenantImage } from '../../shared/tenantAdministration.js';
import type { InvitationPair } from '../../shared/tenantInvitations.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import { createSqliteTenantAdministration, TENANT_TABLES, type TenantStoreBinding } from './tenantStore.js';
import { createSqliteTenantAdministrationJournal } from './tenantAdministrationJournal.js';
import { createSqliteTenantInvitations, INVITATION_TABLES, type StoredTenantInvitation } from './tenantInvitationStore.js';
import { decodeDelegateMembership, decodeDelegateTenants } from './tenantDelegation.js';

export function invitationTenantImage(input: unknown, tenantId: string): AdministrationTenantImage {
  const row = captureTenantData(input) as Record<string, unknown> | undefined;
  if (
    !row ||
    row.tenantId !== tenantId ||
    !['active', 'suspended', 'closed'].includes(row.status as string) ||
    typeof row.version !== 'string' ||
    !/^[1-9][0-9]{0,127}$/.test(row.version)
  )
    return denyTenant();
  return row as unknown as AdministrationTenantImage;
}
export function invitationMembershipPair(input: unknown, row: StoredTenantInvitation): InvitationPair {
  const m = captureTenantData(input) as Record<string, unknown> | undefined;
  if (!m || typeof m.roles !== 'string') return denyTenant();
  const member = captureTenantData({ ...m, roles: JSON.parse(m.roles) }) as unknown as AdministrationMembershipImage;
  if (
    member.membershipId !== row.membershipId ||
    member.tenantId !== row.tenantId ||
    member.accountId !== row.accountId ||
    member.status !== 'invited' ||
    !/^[1-9][0-9]{0,127}$/.test(member.version) ||
    member.validUntil !== row.validUntil ||
    !Array.isArray(member.roles) ||
    member.roles.length !== row.roles.length ||
    member.roles.some((role) => !row.roles.includes(role))
  )
    return denyTenant();
  const { digest: _digest, ...visible } = row;
  return { invitation: captureTenantData(visible), membership: member };
}

export function createSqliteInvitationTransaction(
  db: DatabaseSync,
  operations: TransactionOperations,
  binding: TenantStoreBinding,
  active: () => void,
  assertCurrent: () => void,
) {
  const check = () => {
    assertCurrent();
    if (!db.isTransaction) return denyTenant();
    // Facts are reusable only within this request as well as this transaction.
    // Like the stores, never mistake an async callback for a completed fence.
    const result = active() as unknown;
    if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
    if (result !== undefined) return denyTenant();
    assertCurrent();
    if (!db.isTransaction) return denyTenant();
  };
  const read = <T>(work: () => T): T => {
    check();
    const result = work();
    check();
    return result;
  };
  const tenant = (tenantId: string) =>
    invitationTenantImage(
      db
        .prepare(`SELECT id AS tenantId, status, version FROM main."${TENANT_TABLES.tenant}"
    WHERE id = ? COLLATE BINARY AND kind = 'tenant'`)
        .get(tenantId),
      tenantId,
    );
  return Object.freeze({
    tenant: (tenantId: string) => read(() => tenant(tenantId)),
    optionalTenant: (tenantId: string) =>
      read(() => {
        const exists = db.prepare(`SELECT 1 FROM main."${TENANT_TABLES.tenant}" WHERE id = ? COLLATE BINARY`).get(tenantId);
        return exists ? tenant(tenantId) : null;
      }),
    pair: (row: StoredTenantInvitation) =>
      read(() =>
        invitationMembershipPair(
          db
            .prepare(`SELECT id AS membershipId, tenant_id AS tenantId, account_id AS accountId, status, version,
      roles_json AS roles, valid_until AS validUntil FROM main."${TENANT_TABLES.membership}"
      WHERE id = ? COLLATE BINARY AND kind = 'member'`)
            .get(row.membershipId),
          row,
        ),
      ),
    pendingIds: (tenantId: string, after: string, roles: readonly string[], limit: number) =>
      read(() =>
        Object.freeze(
          db
            .prepare(`SELECT invitation_id AS id FROM main."${INVITATION_TABLES.invitation}" i
      WHERE tenant_id = ? COLLATE BINARY AND status = 'pending' AND invitation_id > ? COLLATE BINARY
      AND NOT EXISTS (SELECT 1 FROM json_each(i.roles_json) r WHERE r.type <> 'text'
        OR r.value NOT IN (${roles.map(() => '?').join(',')}))
      ORDER BY invitation_id COLLATE BINARY LIMIT ?`)
            .all(tenantId, after, ...roles, limit)
            .map((row) => row.id as string),
        ),
      ),
    pendingCount: (tenantId: string) =>
      read(
        () =>
          db
            .prepare(
              `SELECT count(*) AS count FROM main."${INVITATION_TABLES.invitation}" WHERE tenant_id = ? COLLATE BINARY AND status = 'pending'`,
            )
            .get(tenantId)?.count,
      ),
    /* A delegate's own membership, and an account's delegate tenants: member
       rows of active tenants only, never a support or platform row. The
       writer's BEGIN IMMEDIATE holds them to COMMIT. */
    accountMembership: (tenantId: string, accountId: string) =>
      read(() =>
        decodeDelegateMembership(
          db
            .prepare(`SELECT m.id AS membershipId,
      m.tenant_id AS tenantId, m.account_id AS accountId, m.status, m.roles_json AS roles, m.valid_until AS validUntil
      FROM main."${TENANT_TABLES.membership}" m JOIN main."${TENANT_TABLES.tenant}" t ON t.id = m.tenant_id
      WHERE m.tenant_id = ? COLLATE BINARY AND m.account_id = ? COLLATE BINARY AND m.kind = 'member' AND m.status <> 'revoked'
        AND t.kind = 'tenant' AND t.status = 'active'`)
            .get(tenantId, accountId),
        ),
      ),
    accountTenants: (accountId: string, now: number) =>
      read(() =>
        decodeDelegateTenants(
          db
            .prepare(`SELECT m.tenant_id AS tenantId,
      m.roles_json AS roles FROM main."${TENANT_TABLES.membership}" m JOIN main."${TENANT_TABLES.tenant}" t ON t.id = m.tenant_id
      WHERE m.account_id = ? COLLATE BINARY AND m.kind = 'member' AND m.status = 'active' AND m.valid_until > ?
        AND t.kind = 'tenant' AND t.status = 'active' ORDER BY m.tenant_id COLLATE BINARY LIMIT 257`)
            .all(accountId, now),
        ),
      ),
    invitations: createSqliteTenantInvitations(db, operations, binding, active),
    administration: createSqliteTenantAdministration(db, operations, binding, active),
    journal: createSqliteTenantAdministrationJournal(db, operations, binding, active),
  });
}
type SqliteInvitationTransaction = ReturnType<typeof createSqliteInvitationTransaction>;
type Fact = 'tenant' | 'optionalTenant' | 'pair' | 'pendingIds' | 'pendingCount' | 'accountMembership' | 'accountTenants';
/** Awaitable facts do not make the stores' synchronous lifetime fences async. */
export type InvitationTransaction = Omit<SqliteInvitationTransaction, Fact> & {
  [K in Fact]: (
    ...args: Parameters<SqliteInvitationTransaction[K]>
  ) => ReturnType<SqliteInvitationTransaction[K]> | Promise<ReturnType<SqliteInvitationTransaction[K]>>;
};
