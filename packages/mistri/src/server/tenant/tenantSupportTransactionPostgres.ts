/**
 * The support-row facts on PostgreSQL, on the support owner's borrowed writer
 * transaction. Row locks are what serialise support: every owner operation
 * takes, in this order and never backwards,
 *
 *   its own receipt scope (the journal's advisory lock)
 *   → `@platform` FOR UPDATE
 *   → the parent platform memberships, in byte order, FOR UPDATE
 *   → the dealers, in byte order, FOR UPDATE
 *   → the support rows, in byte order, FOR UPDATE
 *   → the audit sessions (the audit reads a session FOR UPDATE).
 *
 * Platform membership maintenance also takes `@platform` first, then the
 * member; a tenant status change takes only its tenant row. So a revocation
 * racing an opening waits on, or is waited on by, the one anchor, and no
 * order here reaches back. Locators read without locks and are rechecked
 * against the locked row; a changed locator refuses, it is never followed.
 */
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';
import { nextRevision, revision, TENANT_TABLES } from './tenantStoreContract.js';
import {
  MEMBER_COLUMNS,
  supportAnchorRow,
  supportInsertRow,
  supportMemberRow,
  supportOperation,
  supportText,
  type SupportAnchor,
  type SupportFacts,
  type SupportInsert,
} from './tenantSupportTransaction.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const member = runtimeTable('postgres', TENANT_TABLES.membership),
  tenant = runtimeTable('postgres', TENANT_TABLES.tenant);
const columns = MEMBER_COLUMNS.replace('valid_until', 'valid_until::text AS valid_until');

export function createPostgresSupportFacts(client: PgQuery, operations: TransactionOperations, active: () => void): SupportFacts {
  const run = supportOperation(operations, active);
  const anchor = async (id: string, kind: SupportAnchor['kind']) => {
    const rows = (await client.query(`SELECT id, kind, status, version FROM ${tenant} WHERE id = $1 AND kind = $2 FOR UPDATE`, [id, kind]))
      .rows;
    if (rows.length > 1) return denyTenant();
    return rows.length ? supportAnchorRow({ ...rows[0] }, kind) : null;
  };
  return Object.freeze({
    platform: () => run(() => anchor(PLATFORM_TENANT_ID, 'platform')),
    tenant: (id: string) =>
      run(() => {
        parseTenantSelector([supportText(id, 128)]);
        return anchor(id, 'tenant');
      }),
    parentLocator: (accountId: string) =>
      run(async () => {
        supportText(accountId);
        const rows = (
          await client.query(
            `SELECT id FROM ${member} WHERE tenant_id = $1 AND account_id = $2
        AND kind = 'member' AND status <> 'revoked'`,
            [PLATFORM_TENANT_ID, accountId],
          )
        ).rows;
        if (rows.length > 1) return denyTenant();
        return rows.length ? supportText(rows[0].id) : null;
      }),
    supportLocators: (accountId: string) =>
      run(async () => {
        supportText(accountId);
        const rows = (
          await client.query(
            `SELECT ${columns} FROM ${member} WHERE account_id = $1 AND kind = 'support' AND status = 'active'
        ORDER BY id`,
            [accountId],
          )
        ).rows.map((row) => supportMemberRow({ ...row }));
        if (rows.length > 1 || rows.some((row) => row.accountId !== accountId)) return denyTenant();
        return Object.freeze(rows);
      }),
    member: (id: string) =>
      run(async () => {
        const rows = (await client.query(`SELECT ${columns} FROM ${member} WHERE id = $1 FOR UPDATE`, [supportText(id)])).rows;
        if (rows.length > 1) return denyTenant();
        return rows.length ? supportMemberRow({ ...rows[0] }) : null;
      }),
    activeTenants: (limit: number) =>
      run(async () => {
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return denyTenant();
        // Identity columns are COLLATE "C": the order is byte order.
        return Object.freeze(
          (
            await client.query(
              `SELECT id FROM ${tenant} WHERE kind = 'tenant' AND status = 'active'
        ORDER BY id LIMIT $1`,
              [limit],
            )
          ).rows.map((row) => parseTenantSelector([supportText(row.id, 128)])),
        );
      }),
    insertSupport: (input: SupportInsert) =>
      run(async () => {
        const row = supportInsertRow(input);
        const result = await client.query(
          `INSERT INTO ${member} (id, tenant_id, account_id, status, version, roles_json, valid_until, kind,
        parent_id, parent_version, platform_version) VALUES ($1, $2, $3, 'active', '1', $4, $5, 'support', $6, $7, $8)`,
          [
            row.id,
            row.tenantId,
            row.accountId,
            JSON.stringify([row.role]),
            row.validUntil,
            row.parentId,
            row.parentVersion,
            row.platformVersion,
          ],
        );
        if (result.rowCount !== 1) denyTenant();
      }),
    revokeSupport: (id: string, expectedVersion: string) =>
      run(async () => {
        supportText(id);
        revision(expectedVersion);
        const result = await client.query(
          `UPDATE ${member} SET status = 'revoked', version = $1
        WHERE id = $2 AND kind = 'support' AND status = 'active' AND version = $3`,
          [nextRevision(expectedVersion), id, expectedVersion],
        );
        if (result.rowCount !== 1) denyTenant();
      }),
  });
}
