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
    const member = async (id: string, locked: boolean) =>
      (
        await client.query(
          `SELECT id,tenant_id,account_id,status,version,roles_json,
      valid_until::text AS valid_until,kind,parent_id,parent_version,platform_version
      FROM ${runtimeTable('postgres', TENANT_TABLES.membership)} WHERE id=$1${locked && locks ? ' FOR SHARE' : ''}`,
          [id],
        )
      ).rows[0];
    const tenant = async (id: string) =>
      (
        await client.query(
          `SELECT id,status,version,kind FROM ${runtimeTable('postgres', TENANT_TABLES.tenant)}
      WHERE id=$1${locks ? ' FOR SHARE' : ''}`,
          [id],
        )
      ).rows[0];
    const parentId = supportParentLocator(await member(lookup.supportId, false), lookup);
    // Never lock the child before its parent. The final locked child must
    // still name the locator; parent/tenant replacement is refusal, not retry.
    // With `locks` off the order no longer matters, and is kept anyway so both
    // callers read the same rows in the same sequence.
    const platform = await tenant('@platform');
    const parent = await member(parentId, true);
    const dealer = await tenant(lookup.tenantId);
    const support = await member(lookup.supportId, true);
    return supportMembershipObservation(owner, lookup, support, parent, platform, dealer, parentId);
  } catch {
    return denyTenant();
  }
}
