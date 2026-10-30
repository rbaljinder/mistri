/**
 * An account's live API tokens and OAuth grants, revoked at once: when a
 * directory or an administrator deactivates the person (scimDirectory.ts,
 * accountAdministration.ts), and when their password is reset by its link or
 * set by an administrator (auth.ts), since a token made by whoever held the
 * old password must not outlive the reset that shut them out. A ban refuses
 * tokens only while it lasts; revoked, they stay refused after it is lifted.
 */
import type { DatabaseSync } from 'node:sqlite';
import { SQLITE_API_TOKEN_TABLES } from '../../adapters/auth/sqliteApiTokenLayout.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';

/** The account's live API tokens and OAuth grants, revoked: on the file in the caller's transaction, on PostgreSQL on its own connection. */
export function accountTokenRevoker(store: { file?: DatabaseSync; pool?: PgQuery }) {
  return async (accountId: string, by: string, now = Date.now()): Promise<void> => {
    if (store.file) {
      const db = store.file;
      const t = SQLITE_API_TOKEN_TABLES;
      // A store that never provisioned API tokens has none to revoke.
      if (!db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(t.meta)) return;
      const live = db
        .prepare(`SELECT token_id, version, created_at FROM main."${t.token}"
          WHERE subject_kind = 'account' AND subject_id = ? COLLATE BINARY AND revoked_at IS NULL`)
        .all(accountId);
      const revoke = db.prepare(`UPDATE main."${t.token}" SET version = ?, revoked_at = ?, revoked_by = ?
        WHERE token_id = ? COLLATE BINARY AND version = ? COLLATE BINARY AND revoked_at IS NULL`);
      for (const row of live) {
        // The version is decimal text past 2^53; a revocation is one step on it.
        revoke.run(
          String(BigInt(String(row.version)) + 1n),
          Math.max(Number(row.created_at), now),
          by,
          String(row.token_id),
          String(row.version),
        );
      }
      db.prepare(
        `UPDATE main."${t.grant}" SET revoked_at = CASE WHEN created_at > ? THEN created_at ELSE ? END WHERE subject = ? COLLATE BINARY AND revoked_at IS NULL`,
      ).run(now, now, accountId);
      return;
    }
    if (!store.pool) return;
    const present = (
      await store.pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [runtimeTable('postgres', 'auth_api_token_meta')])
    ).rows[0];
    if (!present?.present) return;
    await store.pool.query(
      `UPDATE ${runtimeTable('postgres', 'auth_api_token')} SET version = (version::numeric + 1)::text, revoked_at = GREATEST(created_at, $2::bigint), revoked_by = $3
        WHERE subject_kind = 'account' AND subject_id = $1 AND revoked_at IS NULL`,
      [accountId, now, by],
    );
    await store.pool.query(
      `UPDATE ${runtimeTable('postgres', 'auth_oauth_grant')} SET revoked_at = GREATEST(created_at, $2::bigint) WHERE subject = $1 AND revoked_at IS NULL`,
      [accountId, now],
    );
  };
}
