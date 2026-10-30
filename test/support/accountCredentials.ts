/**
 * A live API token and OAuth grant for an account, written into a provisioned
 * SQLite token store as issuance leaves them, and read back: whether each has
 * been revoked since (auth/accountApiTokens.ts).
 */
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { SQLITE_API_TOKEN_TABLES as t } from '../../packages/mistri/src/adapters/auth/sqliteApiTokenLayout.js';

export function accountCredentials(store: string, appId: string, accountId: string): () => { token: boolean; grant: boolean } {
  const now = Date.now() - 1000,
    token = randomUUID(),
    grant = randomUUID(),
    client = `twc1.${randomUUID()}`;
  const db = new DatabaseSync(store);
  try {
    db.prepare(
      `INSERT INTO "${t.token}" (token_id, app_id, subject_kind, subject_id, label, roles_json, created_at, created_by, expires_at, format, digest, version)
        VALUES (?, ?, 'account', ?, 'cli', '["viewer"]', ?, ?, ?, 'twa1', ?, '1')`,
    ).run(token, appId, accountId, now, accountId, now + 3_600_000, 'a'.repeat(64));
    db.prepare(`INSERT INTO "${t.client}" (client_id, redirect_uris_json, created_at) VALUES (?, '["http://127.0.0.1/cb"]', ?)`).run(
      client,
      now,
    );
    db.prepare(
      `INSERT INTO "${t.grant}" (grant_id, client_id, subject, app_id, version, roles_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, 1, '["viewer"]', ?, ?)`,
    ).run(grant, client, accountId, appId, now, now + 3_600_000);
  } finally {
    db.close();
  }
  return () => {
    const read = new DatabaseSync(store, { readOnly: true });
    try {
      const row = (sql: string, id: string) => (read.prepare(sql).get(id) as { revoked_at: unknown }).revoked_at !== null;
      return {
        token: row(`SELECT revoked_at FROM "${t.token}" WHERE token_id = ?`, token),
        grant: row(`SELECT revoked_at FROM "${t.grant}" WHERE grant_id = ?`, grant),
      };
    } finally {
      read.close();
    }
  };
}
