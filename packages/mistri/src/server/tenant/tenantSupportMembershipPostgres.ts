/** Pending linked facts on a borrowed PG transaction, not an auth capability. */
import { isProxy } from 'node:util/types';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import { binding, TENANT_TABLES, type TenantStoreBinding } from './tenantStoreContract.js';
import { assertPostgresTenantStore } from './tenantStorePostgres.js';
import {
  captureSupportLookup,
  supportMembershipObservation,
  supportParentLocator,
  type SupportMembershipLookup,
  type SupportMembershipObservation,
} from './tenantSupportMembership.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

/**
 * The composition owner supplies the actual client. SAVEPOINT in the store
 * attestor rejects native autocommit, not a fake client that fabricates results.
 * Locks last only through the caller's transaction; no retained lease is issued.
 *
 * `locks` is true for a writer, which must hold these rows against a concurrent
 * revocation until it commits. A reader passes false, because `SELECT … FOR
 * SHARE` writes tuple headers and PostgreSQL refuses it inside the `BEGIN READ
 * ONLY` transaction every read snapshot opens. Nothing is weakened by that: a
 * read-only snapshot already sees one consistent state, so there is no window
 * between these reads for a lock to protect, and a revocation that lands after
 * the snapshot is caught by the next operation's own revalidation.
 */
const MEMBERSHIP_TABLE = runtimeTable('postgres', TENANT_TABLES.membership);
const TENANT_TABLE = runtimeTable('postgres', TENANT_TABLES.tenant);
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * Unlocked support observation in one SQL statement: the support row, its
 * parent platform membership, `@platform` and the dealer, all from the
 * caller's single read snapshot. Replaces four sequential round trips on
 * every support read and lets the statement ride in the message that begins
 * a snapshot (`fenced.ahead`) or ends it (`togetherFenced`).
 */
const supportObservationSql = (supportId: string, tenantId: string, platformId: string) =>
  `WITH sup AS (
     SELECT id, tenant_id, account_id, status, version, roles_json,
       valid_until::text AS valid_until, kind, parent_id, parent_version, platform_version
     FROM ${MEMBERSHIP_TABLE} WHERE id = ${supportId}
   ),
   par AS (
     SELECT m.id, m.tenant_id, m.account_id, m.status, m.version, m.roles_json,
       m.valid_until::text AS valid_until, m.kind, m.parent_id, m.parent_version, m.platform_version
     FROM ${MEMBERSHIP_TABLE} m JOIN sup ON m.id = sup.parent_id
   ),
   anc AS (
     SELECT id, status, version, kind
     FROM ${TENANT_TABLE} WHERE id IN (${platformId}, ${tenantId})
   )
   SELECT 'support'::text AS _role, id, tenant_id, account_id, status, version, roles_json,
     valid_until, kind, parent_id, parent_version, platform_version FROM sup
   UNION ALL
   SELECT 'parent'::text AS _role, id, tenant_id, account_id, status, version, roles_json,
     valid_until, kind, parent_id, parent_version, platform_version FROM par
   UNION ALL
   SELECT CASE WHEN id = ${platformId} THEN 'platform' ELSE 'dealer' END::text AS _role,
     id, NULL::text AS tenant_id, NULL::text AS account_id, status, version, NULL::text AS roles_json,
     NULL::text AS valid_until, kind, NULL::text AS parent_id, NULL::text AS parent_version, NULL::text AS platform_version FROM anc`;

function stripMemberRow(row: Record<string, unknown>): Record<string, unknown> {
  const { _role: _ignored, ...rest } = row;
  return rest;
}

function stripTenantRow(row: Record<string, unknown>): Record<string, unknown> {
  return { id: row.id, status: row.status, version: row.version, kind: row.kind };
}

/**
 * The unlocked support membership observation as a statement without parameters
 * for the message that begins or ends a read snapshot.
 */
export function postgresSupportMembershipStatement(input: TenantStoreBinding, requested: Omit<SupportMembershipLookup, 'at'>): string {
  binding(input);
  const lookup = captureSupportLookup({ ...requested, at: 0 });
  return supportObservationSql(literal(lookup.supportId), literal(lookup.tenantId), literal('@platform'));
}

/** Judge the rows returned by `supportObservationSql` by the exact observation rules. */
export function postgresSupportMembershipRows(
  input: TenantStoreBinding,
  requested: SupportMembershipLookup,
  rows: readonly Record<string, unknown>[],
): SupportMembershipObservation {
  try {
    const owner = binding(input),
      lookup = captureSupportLookup(requested);
    let support: Record<string, unknown> | undefined;
    let parent: Record<string, unknown> | undefined;
    let platform: Record<string, unknown> | undefined;
    let dealer: Record<string, unknown> | undefined;
    for (const row of rows) {
      if (row._role === 'support') {
        if (support !== undefined) return denyTenant();
        support = stripMemberRow(row);
      } else if (row._role === 'parent') {
        if (parent !== undefined) return denyTenant();
        parent = stripMemberRow(row);
      } else if (row._role === 'platform') {
        if (platform !== undefined) return denyTenant();
        platform = stripTenantRow(row);
      } else if (row._role === 'dealer') {
        if (dealer !== undefined) return denyTenant();
        dealer = stripTenantRow(row);
      } else return denyTenant();
    }
    const parentId = supportParentLocator(support, lookup);
    return supportMembershipObservation(owner, lookup, support, parent, platform, dealer, parentId);
  } catch {
    return denyTenant();
  }
}

export async function observePostgresSupportMembership(
  client: PgQuery,
  input: TenantStoreBinding,
  requested: SupportMembershipLookup,
  locks = true,
): Promise<SupportMembershipObservation> {
  try {
    const owner = binding(input),
      lookup = captureSupportLookup(requested);
    if (!client || isProxy(client)) return denyTenant();
    // Inspect descriptors before reading query: structural clients are trusted
    // adapters, but accessor execution is not part of this data boundary.
    let cursor: object | null = client,
      query: unknown;
    while (cursor) {
      if (isProxy(cursor)) return denyTenant();
      const descriptor = Object.getOwnPropertyDescriptor(cursor, 'query');
      if (descriptor) {
        if (!Object.hasOwn(descriptor, 'value')) return denyTenant();
        query = descriptor.value;
        break;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    if (typeof query !== 'function' || isProxy(query)) return denyTenant();
    await assertPostgresTenantStore(client, owner);
    if (!locks) {
      const result = await client.query(supportObservationSql('$1', '$2', '$3'), [lookup.supportId, lookup.tenantId, '@platform']);
      return postgresSupportMembershipRows(owner, lookup, result.rows);
    }
    const member = async (id: string, locked: boolean) =>
      (
        await client.query(
          `SELECT id,tenant_id,account_id,status,version,roles_json,
      valid_until::text AS valid_until,kind,parent_id,parent_version,platform_version
      FROM ${MEMBERSHIP_TABLE} WHERE id=$1${locked ? ' FOR SHARE' : ''}`,
          [id],
        )
      ).rows[0];
    const tenant = async (id: string) =>
      (
        await client.query(
          `SELECT id,status,version,kind FROM ${TENANT_TABLE}
      WHERE id=$1 FOR SHARE`,
          [id],
        )
      ).rows[0];
    const parentId = supportParentLocator(await member(lookup.supportId, false), lookup);
    // Never lock the child before its parent. The final locked child must
    // still name the locator; parent/tenant replacement is refusal, not retry.
    const platform = await tenant('@platform');
    const parent = await member(parentId, true);
    const dealer = await tenant(lookup.tenantId);
    const support = await member(lookup.supportId, true);
    return supportMembershipObservation(owner, lookup, support, parent, platform, dealer, parentId);
  } catch {
    return denyTenant();
  }
}
