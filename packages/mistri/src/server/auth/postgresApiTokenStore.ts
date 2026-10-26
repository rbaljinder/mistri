/** Private transaction-borrowing storage. Not issuance, auth or provisioning. */
import { API_TOKEN_STORE_VERSION } from '../../adapters/auth/sqliteApiTokenLayout.js';
import { isPromise, isProxy } from 'node:util/types';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery, PgResult } from '@mistriwork/engine/adapters/postgresPool.js';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { assertPostgresAuthStore } from '../../adapters/auth/postgresAuthStore.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { assertApiTokenAppId, assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import {
  apiTokenSqlColumns,
  captureStoredApiToken,
  decodeApiTokenSqlRow,
  encodeApiTokenSqlRow,
  planApiTokenRevocation,
} from '../api/apiTokenStorageContract.js';

/** Says which way the layout differs where the version row does (layoutRefusal.ts); otherwise only that the storage is unavailable. */
class PostgresApiTokenStoreUnavailable extends Error {
  constructor(message = 'PostgreSQL API token storage is unavailable.') {
    super(message);
    this.name = 'PostgresApiTokenStoreUnavailable';
  }
}
const refuse = (message?: string): never => {
  throw new PostgresApiTokenStoreUnavailable(message);
};
const layoutMessage = (found: unknown) => layoutRefusal('The PostgreSQL API token store', found, API_TOKEN_STORE_VERSION);
const table = runtimeTable('postgres', 'auth_api_token'),
  meta = runtimeTable('postgres', 'auth_api_token_meta');
const times = new Set<string>(['created_at', 'expires_at', 'revoked_at', 'last_used_at']);
function exact(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) return refuse();
  return value;
}

export function createPostgresApiTokenStore(
  client: PgQuery,
  operations: TransactionOperations,
  input: { appId: string; storeId: string },
  assertCurrent: () => void,
) {
  try {
    const value = exact(snapshot(input, 4096).value, ['appId', 'storeId']);
    assertApiTokenAppId(value.appId);
    assertApiTokenSecretId(value.storeId);
    const owner = Object.freeze({ appId: value.appId, storeId: value.storeId });
    if (!client || isProxy(client) || typeof client.query !== 'function' || typeof assertCurrent !== 'function' || isProxy(assertCurrent))
      return refuse();
    const active = () => {
      const result = assertCurrent() as unknown;
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined) return refuse();
    };
    // Guard even individual SQL awaits inside the shared full-layout attestor.
    function query(sql: string, values?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
    function query(sql: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
    async function query(sql: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
      active();
      const result = typeof sql === 'string' ? await client.query(sql, values) : await client.query(sql);
      active();
      return result;
    }
    const guarded: PgQuery = { query };
    const verified = async () => {
      active();
      try {
        await assertPostgresAuthStore(guarded);
      } catch (error) {
        const message = layoutMessage(await postgresLayoutVersion(guarded, meta));
        if (message === undefined) throw error;
        return refuse(message);
      }
      active();
      // Missing extension refuses, even though core-only native auth is valid.
      await query(`LOCK TABLE ${meta}, ${table} IN ROW EXCLUSIVE MODE`);
      active();
      const rows = (
        await query(
          `SELECT singleton,version,app_id,store_id,format,
        (app_id=$1 COLLATE "C" AND store_id=$2 COLLATE "C") AS matches FROM ${meta}`,
          [owner.appId, owner.storeId],
        )
      ).rows;
      active();
      if (
        rows.length !== 1 ||
        rows[0].singleton !== 1 ||
        rows[0].version !== API_TOKEN_STORE_VERSION ||
        rows[0].format !== 'twa1' ||
        rows[0].matches !== true ||
        rows[0].app_id !== owner.appId ||
        rows[0].store_id !== owner.storeId
      )
        return refuse(layoutMessage(rows.length === 1 ? rows[0].version : undefined));
    };
    const invoke = <T>(raw: unknown, work: (captured: unknown) => Promise<T>): Promise<T> => {
      let captured: unknown,
        invalid = false;
      try {
        captured = snapshot(raw, 1_048_576).value;
      } catch {
        invalid = true;
      }
      const pending = operations
        .run(async () => {
          try {
            if (invalid) return refuse();
            await verified();
            active();
            const result = await work(captured);
            active();
            await verified();
            active();
            return result;
          } catch (error) {
            if (error instanceof PostgresApiTokenStoreUnavailable) throw error;
            return refuse();
          }
        })
        .catch((error) => {
          if (error instanceof PostgresApiTokenStoreUnavailable) throw error;
          return refuse();
        });
      void pending.catch(() => {});
      return pending;
    };
    const lookup = async (id: string) => {
      assertApiTokenSecretId(id);
      const projection = apiTokenSqlColumns.map((name) => `${name}${times.has(name) ? '::float8' : ''} AS "${name}"`).join(',');
      const rows = (
        await query(`SELECT ${projection} FROM ${table} WHERE token_id=$1 COLLATE "C" AND app_id=$2 COLLATE "C"`, [id, owner.appId])
      ).rows;
      active();
      if (rows.length > 1) return refuse();
      if (!rows.length) return null;
      const result = decodeApiTokenSqlRow(rows[0]);
      if (result.record.id !== id || result.record.appId !== owner.appId) return refuse();
      return result;
    };
    return Object.freeze({
      lookup: (id: string) =>
        invoke(id, async (value) => {
          assertApiTokenSecretId(value);
          return lookup(value);
        }),
      /** Historical snapshots allowed; issuance/restore authority is not here. */
      insert: (raw: unknown) =>
        invoke(raw, async (value) => {
          const stored = captureStoredApiToken(value);
          if (stored.record.appId !== owner.appId) return refuse();
          const row = encodeApiTokenSqlRow(stored);
          const result = await query(
            `INSERT INTO ${table} (${apiTokenSqlColumns.join(',')}) VALUES (${apiTokenSqlColumns.map((_, i) => `$${i + 1}`).join(',')})`,
            apiTokenSqlColumns.map((name) => row[name]),
          );
          active();
          if (result.rowCount !== 1) return refuse();
        }),
      revoke: (raw: unknown) =>
        invoke(raw, async (value) => {
          const request = exact(value, ['tokenId', 'appId', 'expectedVersion', 'revokedAt', 'revokedBy']);
          assertApiTokenSecretId(request.tokenId);
          if (request.appId !== owner.appId) return refuse();
          const previous = await lookup(request.tokenId);
          active();
          const plan = planApiTokenRevocation(previous, request);
          const result = await query(
            `UPDATE ${table} SET version=$1,revoked_at=$2,revoked_by=$3
          WHERE token_id=$4 COLLATE "C" AND app_id=$5 COLLATE "C" AND version=$6 COLLATE "C" AND revoked_at IS NULL`,
            [
              plan.next.version,
              plan.next.record.revokedAt,
              plan.next.record.revokedBy,
              plan.where.tokenId,
              plan.where.appId,
              plan.where.version,
            ],
          );
          active();
          if (result.rowCount !== 1) return refuse();
        }),
    });
  } catch {
    return refuse();
  }
}
