/** Private native reads on an already-owned handle. These helpers neither
 * attest ownership nor open, migrate, bootstrap, admit or manage transactions.
 * Runtime proof/lifetime fencing stays with auth.ts; maintenance callers must
 * independently attest their store and retain their own transaction fences. */
import type { DatabaseSync } from 'node:sqlite';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { captureTenantData, denyTenant, tenantIdentifier } from '@mistriwork/engine/server/evidence.js';

function exact(accountId: string): void {
  tenantIdentifier(accountId, 1024);
  if (/\p{Cs}/u.test(accountId)) denyTenant();
}
function nativeRoles(role: unknown): readonly string[] {
  if (role === null) return [];
  if (typeof role !== 'string' || /\p{Cs}/u.test(role) || role.includes('\0')) return denyTenant();
  return [
    ...new Set(
      role
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/** Preserve native SQLite eligibility including malformed unbanned expiry
 * refusal. Better Auth writes booleans as 0/1 and dates as ISO text; its admin
 * session-create hook expires bans strictly before now (not at it). Observe
 * eligibility without performing its login-time unban/account mutation.
 * Exported privately for the existing role-independent sync lookup. */
export function nativeAccountEligible(row: Record<string, unknown>): boolean {
  if (row.banned !== null && row.banned !== 0 && row.banned !== 1) return denyTenant();
  if (row.banExpiresNul !== null && row.banExpiresNul !== 0) return denyTenant();
  let expiresAt: number | null = null;
  if (row.banExpires !== null) {
    if (typeof row.banExpires !== 'string') return denyTenant();
    expiresAt = new Date(row.banExpires).getTime();
    if (!Number.isSafeInteger(expiresAt) || new Date(expiresAt).toISOString() !== row.banExpires) return denyTenant();
  }
  const now = Date.now();
  if (!Number.isSafeInteger(now)) return denyTenant();
  return row.banned !== 1 || (expiresAt !== null && expiresAt < now);
}

export function readSqliteEligibleAccountRoles(database: Pick<DatabaseSync, 'prepare'>, accountId: string) {
  exact(accountId);
  // Stored NUL guards prevent node:sqlite truncation from changing facts.
  const row = captureTenantData(
    database
      .prepare(
        `SELECT id, role, instr(role, char(0)) AS roleNul, banned, banExpires,
        instr(banExpires, char(0)) AS banExpiresNul FROM "user" WHERE id = ? COLLATE BINARY`,
      )
      .get(accountId),
  );
  if (!row) return null;
  if (row.id !== accountId || (row.roleNul !== null && row.roleNul !== 0)) return denyTenant();
  return nativeAccountEligible(row) ? captureTenantData({ accountId, roles: nativeRoles(row.role) }) : null;
}

export async function readPostgresEligibleAccountRoles(client: PgQuery, accountId: string) {
  exact(accountId);
  const row = (
    await client.query(
      `SELECT id, role, banned, floor(extract(epoch FROM "banExpires") * 1000)::float8 AS "banExpires" FROM ${runtimeTable('postgres', 'auth_user')} WHERE id = $1`,
      [accountId],
    )
  ).rows[0];
  if (!row) return null;
  if (row.id !== accountId || (row.banned !== null && typeof row.banned !== 'boolean')) return denyTenant();
  if (row.banned === true) {
    // Preserve PostgreSQL's existing unbanned-expiry short circuit.
    const until = row.banExpires === null ? null : typeof row.banExpires === 'number' ? row.banExpires : NaN;
    if (until !== null && !Number.isSafeInteger(until)) return denyTenant();
    if (until === null || !(until < Date.now())) return null;
  }
  return captureTenantData({ accountId, roles: nativeRoles(row.role) });
}
