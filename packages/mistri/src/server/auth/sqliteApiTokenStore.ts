/** Private owner-supplied transaction storage, not issuance or bearer auth.
 * No DDL, connections, commits, telemetry or permission grants are created. */
import { DatabaseSync } from 'node:sqlite';
import { isPromise, isProxy } from 'node:util/types';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { API_TOKEN_STORE_VERSION, SQLITE_API_TOKEN_TABLES } from '../../adapters/auth/sqliteApiTokenLayout.js';
import { assertSqliteAuthTokenLayout } from '../../adapters/auth/sqliteAuthStoreLayout.js';
import { assertApiTokenAppId, assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import {
  apiTokenSqlColumns,
  captureStoredApiToken,
  decodeApiTokenSqlRow,
  encodeApiTokenSqlRow,
  planApiTokenRevocation,
} from '../api/apiTokenStorageContract.js';

/** Says which way the layout differs where the version row does (layoutRefusal.ts); otherwise only that the storage is unavailable. */
class SqliteApiTokenStoreUnavailable extends Error {
  constructor(message = 'SQLite API token storage is unavailable.') {
    super(message);
    this.name = 'SqliteApiTokenStoreUnavailable';
  }
}
const refuse = (message?: string): never => {
  throw new SqliteApiTokenStoreUnavailable(message);
};
const layoutMessage = (found: unknown) => layoutRefusal('The API token store', found, API_TOKEN_STORE_VERSION);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const times = new Set<string>(['created_at', 'expires_at', 'revoked_at', 'last_used_at']);
const table = `main."${SQLITE_API_TOKEN_TABLES.token}"`;
function text(raw: unknown): string {
  if (!(raw instanceof Uint8Array)) return refuse();
  return decoder.decode(raw);
}
function exact(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) return refuse();
  return value;
}

export function createSqliteApiTokenStore(db: DatabaseSync, input: { appId: string; storeId: string }, assertCurrent: () => void) {
  try {
    const capturedOwner = exact(snapshot(input, 4096).value, ['appId', 'storeId']);
    assertApiTokenAppId(capturedOwner.appId);
    assertApiTokenSecretId(capturedOwner.storeId);
    const owner = Object.freeze({ appId: capturedOwner.appId, storeId: capturedOwner.storeId });
    if (isProxy(db) || !(db instanceof DatabaseSync) || typeof assertCurrent !== 'function' || isProxy(assertCurrent)) return refuse();
    const active = () => {
      if (!db.isTransaction) return refuse();
      const result = assertCurrent() as unknown;
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined || !db.isTransaction) return refuse();
    };
    const verified = () => {
      active();
      try {
        assertSqliteAuthTokenLayout(db);
      } catch {
        return refuse(layoutMessage(sqliteLayoutVersion(db, SQLITE_API_TOKEN_TABLES.meta)));
      }
      const rows = db
        .prepare(`SELECT singleton,version,CAST(app_id AS BLOB) AS app_id,CAST(store_id AS BLOB) AS store_id,
        CAST(format AS BLOB) AS format,typeof(app_id) AS app_type,typeof(store_id) AS store_type,typeof(format) AS format_type,
        (app_id = ? COLLATE BINARY AND store_id = ? COLLATE BINARY) AS matches
        FROM main."${SQLITE_API_TOKEN_TABLES.meta}"`)
        .all(owner.appId, owner.storeId);
      if (rows.length !== 1) return refuse();
      const meta = rows[0];
      if (
        meta.singleton !== 1 ||
        meta.version !== API_TOKEN_STORE_VERSION ||
        meta.app_type !== 'text' ||
        meta.store_type !== 'text' ||
        meta.format_type !== 'text' ||
        meta.matches !== 1 ||
        text(meta.app_id) !== owner.appId ||
        text(meta.store_id) !== owner.storeId ||
        text(meta.format) !== 'twa1'
      )
        return refuse(layoutMessage(meta.version));
      active();
    };
    const invoke = <T>(raw: unknown, work: (captured: unknown) => T): T => {
      try {
        const captured = snapshot(raw, 1_048_576).value;
        verified();
        const result = work(captured);
        verified();
        return result;
      } catch (error) {
        if (error instanceof SqliteApiTokenStoreUnavailable) throw error;
        return refuse();
      }
    };
    const lookup = (id: string) => {
      assertApiTokenSecretId(id);
      const projection = apiTokenSqlColumns
        .flatMap((name) => [`${times.has(name) ? name : `CAST(${name} AS BLOB)`} AS "${name}"`, `typeof(${name}) AS "type_${name}"`])
        .join(',');
      const rows = db
        .prepare(`SELECT ${projection} FROM ${table} WHERE token_id = ? COLLATE BINARY AND app_id = ? COLLATE BINARY`)
        .all(id, owner.appId);
      active();
      if (rows.length > 1) return refuse();
      if (!rows.length) return null;
      const values = Object.fromEntries(
        apiTokenSqlColumns.map((name) => {
          const value = rows[0][name],
            kind = rows[0][`type_${name}`];
          if (value === null) {
            if (kind !== 'null') return refuse();
            return [name, null];
          }
          if (kind !== (times.has(name) ? 'integer' : 'text')) return refuse();
          return [name, times.has(name) ? value : text(value)];
        }),
      );
      const result = decodeApiTokenSqlRow(values);
      if (result.record.id !== id || result.record.appId !== owner.appId) return refuse();
      return result;
    };
    return Object.freeze({
      lookup: (id: string) =>
        invoke(id, (value) => {
          assertApiTokenSecretId(value);
          return lookup(value);
        }),
      /** Valid historical snapshots are supported; caller owns issuance/restore policy. */
      insert: (raw: unknown) =>
        invoke(raw, (value) => {
          const stored = captureStoredApiToken(value);
          if (stored.record.appId !== owner.appId) return refuse();
          const row = encodeApiTokenSqlRow(stored);
          const result = db
            .prepare(`INSERT INTO ${table} (${apiTokenSqlColumns.join(',')}) VALUES (${apiTokenSqlColumns.map(() => '?').join(',')})`)
            .run(...apiTokenSqlColumns.map((name) => row[name]));
          active();
          if (result.changes !== 1) return refuse();
        }),
      revoke: (raw: unknown) =>
        invoke(raw, (value) => {
          const request = exact(value, ['tokenId', 'appId', 'expectedVersion', 'revokedAt', 'revokedBy']);
          assertApiTokenSecretId(request.tokenId);
          if (request.appId !== owner.appId) return refuse();
          const plan = planApiTokenRevocation(lookup(request.tokenId), request);
          const result = db
            .prepare(`UPDATE ${table} SET version=?,revoked_at=?,revoked_by=?
          WHERE token_id = ? COLLATE BINARY AND app_id = ? COLLATE BINARY AND version = ? COLLATE BINARY AND revoked_at IS NULL`)
            .run(
              plan.next.version,
              plan.next.record.revokedAt!,
              plan.next.record.revokedBy!,
              plan.where.tokenId,
              plan.where.appId,
              plan.where.version,
            );
          active();
          if (result.changes !== 1) return refuse();
        }),
    });
  } catch {
    return refuse();
  }
}
