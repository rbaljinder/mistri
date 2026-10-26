/** Private borrowed PG transaction facts, not an invitation/auth capability.
 * The owner must install its genuine async native verifier in the maintenance
 * transaction's pre-COMMIT callback; these synchronous fences cannot do that. */
import { isPromise, isProxy } from 'node:util/types';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { captureTenantData, denyTenant, tenantIdentifier } from '@mistriwork/engine/server/evidence.js';
import { TENANT_TABLES, type TenantStoreBinding } from './tenantStore.js';
import { createPostgresTenantAdministration } from './tenantStorePostgres.js';
import { createPostgresTenantAdministrationJournal } from './tenantAdministrationJournalPostgres.js';
import { INVITATION_TABLES } from './tenantInvitationStore.js';
import { assertPostgresTenantInvitations, createPostgresTenantInvitations } from './tenantInvitationStorePostgres.js';
import { captureStoredTenantInvitation, invitationBinding } from './tenantInvitationStoreContract.js';
import { invitationMembershipPair, invitationTenantImage, type InvitationTransaction } from './tenantInvitationTransaction.js';
import { invitationUuid } from './tenantInvitationTransition.js';
import { decodeDelegateMembership, decodeDelegateTenants } from './tenantDelegation.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

export function createPostgresInvitationTransaction(
  client: PgQuery,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  active: () => void,
  assertCurrent: () => void,
): InvitationTransaction {
  const binding = invitationBinding(input);
  if (
    !client ||
    isProxy(client) ||
    typeof client.query !== 'function' ||
    [active, assertCurrent].some((fn) => typeof fn !== 'function' || isProxy(fn))
  )
    return denyTenant();
  const sync = (fn: () => void) => {
    const result = fn() as unknown;
    if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
    if (result !== undefined) return denyTenant();
  };
  const check = () => {
    sync(assertCurrent);
    sync(active);
    sync(assertCurrent);
  };
  const verified = async () => {
    check();
    await assertPostgresTenantInvitations(client, binding);
    check();
  };
  const query = async (sql: string, params?: unknown[]) => {
    check();
    const result = await client.query(sql, params);
    check();
    return result;
  };
  const identifier = (id: unknown, max = 128) => {
    tenantIdentifier(id, max);
    // PG replaces lone surrogates before storage; never alias those identities.
    if (/\p{Cs}/u.test(id as string) || Buffer.byteLength(id as string) > max) return denyTenant();
  };
  const invoke = <A, R>(raw: A, work: (captured: A) => Promise<R>): Promise<R> => {
    let value: A,
      invalid = false;
    try {
      value = captureTenantData(raw);
    } catch {
      invalid = true;
    }
    const pending = operations
      .run(async () => {
        try {
          if (invalid) return denyTenant();
          await verified();
          const result = await work(value!);
          await verified();
          return captureTenantData(result);
        } catch {
          return denyTenant();
        }
      })
      .catch(() => denyTenant());
    void pending.catch(() => {});
    return pending;
  };
  const tenant = async (id: string, optional = false) => {
    identifier(id);
    // This lock serializes reservation counts and is always acquired before a
    // membership lock, including pair() invoked without an earlier tenant().
    const rows = (
      await query(
        `SELECT id AS "tenantId",status,version,kind FROM ${runtimeTable('postgres', TENANT_TABLES.tenant)}
      WHERE id=$1 FOR UPDATE`,
        [id],
      )
    ).rows;
    if (!rows.length && optional) return null;
    if (rows.length !== 1 || rows[0].kind !== 'tenant') return denyTenant();
    const { kind: _kind, ...row } = rows[0];
    return invitationTenantImage(row, id);
  };
  return Object.freeze({
    tenant: (id: string) => invoke(id, async (value) => (await tenant(value))!),
    optionalTenant: (id: string) => invoke(id, (value) => tenant(value, true)),
    pair: (raw) =>
      invoke(raw, async (value) => {
        const row = captureStoredTenantInvitation(value);
        await tenant(row.tenantId);
        const members = (
          await query(
            `SELECT id AS "membershipId",tenant_id AS "tenantId",account_id AS "accountId",status,version,
        roles_json AS roles,valid_until::float8 AS "validUntil" FROM ${runtimeTable('postgres', TENANT_TABLES.membership)}
        WHERE id=$1 AND kind='member' FOR UPDATE`,
            [row.membershipId],
          )
        ).rows;
        if (members.length !== 1) return denyTenant();
        return invitationMembershipPair(members[0], row);
      }),
    pendingIds: (tenantId, after, roles, limit) =>
      invoke({ tenantId, after, roles, limit }, async (value) => {
        identifier(value.tenantId);
        if (value.after !== '') identifier(value.after);
        if (
          !Array.isArray(value.roles) ||
          !value.roles.length ||
          value.roles.length > 256 ||
          new Set(value.roles).size !== value.roles.length ||
          !Number.isSafeInteger(value.limit) ||
          value.limit < 1 ||
          value.limit > 101
        )
          return denyTenant();
        for (const role of value.roles) identifier(role, 256);
        const rows = (
          await query(
            `SELECT invitation_id AS id FROM ${runtimeTable('postgres', INVITATION_TABLES.invitation)} i
        WHERE tenant_id=$1 AND status='pending' AND invitation_id>$2
        AND NOT EXISTS (SELECT 1 FROM json_array_elements(i.roles_json::json) r
          WHERE json_typeof(r)<>'string' OR NOT ((r #>> '{}')=ANY($3::text[])))
        ORDER BY invitation_id COLLATE "C" LIMIT $4`,
            [value.tenantId, value.after, [...value.roles], value.limit],
          )
        ).rows;
        if (rows.length > value.limit) return denyTenant();
        let previous = value.after;
        return rows.map((row) => {
          invitationUuid(row.id);
          if (typeof row.id !== 'string' || row.id <= previous) return denyTenant();
          previous = row.id;
          return row.id;
        });
      }),
    pendingCount: (id) =>
      invoke(id, async (value) => {
        await tenant(value);
        const rows = (
          await query(
            `SELECT count(*)::text AS count FROM ${runtimeTable('postgres', INVITATION_TABLES.invitation)}
        WHERE tenant_id=$1 AND status='pending'`,
            [value],
          )
        ).rows;
        const count = rows[0]?.count;
        if (
          rows.length !== 1 ||
          typeof count !== 'string' ||
          !/^(?:0|[1-9][0-9]{0,15})(?![\s\S])/.test(count) ||
          BigInt(count) > BigInt(Number.MAX_SAFE_INTEGER)
        )
          return denyTenant();
        return Number(count);
      }),
    /* A delegate's own membership: the tenant row, then the membership, FOR
       UPDATE to COMMIT — the order every administrative change takes — so a
       concurrent demotion waits for this transaction or refuses it. */
    accountMembership: (tenantId, accountId) =>
      invoke({ tenantId, accountId }, async (value) => {
        identifier(value.tenantId);
        identifier(value.accountId, 1024);
        const current = await tenant(value.tenantId, true);
        if (!current || current.status !== 'active') return null;
        const rows = (
          await query(
            `SELECT id AS "membershipId",tenant_id AS "tenantId",account_id AS "accountId",status,
        roles_json AS roles,valid_until::float8 AS "validUntil" FROM ${runtimeTable('postgres', TENANT_TABLES.membership)}
        WHERE tenant_id=$1 AND account_id=$2 AND kind='member' AND status<>'revoked' FOR UPDATE`,
            [value.tenantId, value.accountId],
          )
        ).rows;
        if (rows.length > 1) return denyTenant();
        return decodeDelegateMembership(rows[0]);
      }),
    accountTenants: (accountId, now) =>
      invoke({ accountId, now }, async (value) => {
        identifier(value.accountId, 1024);
        if (!Number.isSafeInteger(value.now)) return denyTenant();
        return decodeDelegateTenants(
          (
            await query(
              `SELECT m.tenant_id AS "tenantId",m.roles_json AS roles
        FROM ${runtimeTable('postgres', TENANT_TABLES.membership)} m JOIN ${runtimeTable('postgres', TENANT_TABLES.tenant)} t ON t.id=m.tenant_id
        WHERE m.account_id=$1 AND m.kind='member' AND m.status='active' AND m.valid_until>$2
          AND t.kind='tenant' AND t.status='active' ORDER BY m.tenant_id LIMIT 257`,
              [value.accountId, value.now],
            )
          ).rows,
        );
      }),
    invitations: createPostgresTenantInvitations(client, operations, binding, check),
    administration: createPostgresTenantAdministration(client, operations, binding, check),
    journal: createPostgresTenantAdministrationJournal(client, operations, binding, check),
  });
}
