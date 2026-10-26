/**
 * The two drivers for the OAuth server's operations (oauthGrants.ts): each
 * runs one operation in one transaction of the native auth store the API
 * tokens live in, with the token store's own attestation first — its layout,
 * its version and its App binding — so an OAuth grant is never kept beside a
 * token store this server would not serve.
 *
 * The file is the very handle Better Auth reads and writes. It is driven
 * synchronously from BEGIN IMMEDIATE to COMMIT, so nothing else on this
 * process runs inside the transaction; while Better Auth holds one of its own
 * across an await, the operation waits its turn, briefly, then says the store
 * is busy. PostgreSQL's runs on a connection of its own from the auth pool.
 *
 * A failed statement abandons the operation and rolls it back: only a
 * refusal the operation returned commits.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgClient, PgPool } from '@mistriwork/engine/adapters/postgresPool.js';
import { assertSqliteAuthTokenLayout } from '../../adapters/auth/sqliteAuthStoreLayout.js';
import { SQLITE_API_TOKEN_TABLES } from '../../adapters/auth/sqliteApiTokenLayout.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import { ApiTokenStoreUnavailable, throughApiTokenStore, throughApiTokenStoreAsync } from './apiTokenStoreFailure.js';
import { createSqliteApiTokenStore } from './sqliteApiTokenStore.js';
import { createPostgresApiTokenStore } from './postgresApiTokenStore.js';
import { readPostgresEligibleAccountRoles, readSqliteEligibleAccountRoles } from './nativeAccountObservation.js';
import type { OAuthTables, OAuthWork } from './oauthGrants.js';

/** Runs one operation in one transaction and gives back what it returned. */
export type OAuthStore = <T>(work: (tables: OAuthTables) => OAuthWork<T>) => Promise<T>;

const SQLITE_TABLES: OAuthTables = Object.freeze({
  client: `main."${SQLITE_API_TOKEN_TABLES.client}"`,
  code: `main."${SQLITE_API_TOKEN_TABLES.code}"`,
  grant: `main."${SQLITE_API_TOKEN_TABLES.grant}"`,
  refresh: `main."${SQLITE_API_TOKEN_TABLES.refresh}"`,
  access: `main."${SQLITE_API_TOKEN_TABLES.access}"`,
  token: `main."${SQLITE_API_TOKEN_TABLES.token}"`,
});
const POSTGRES_TABLES: OAuthTables = Object.freeze({
  client: runtimeTable('postgres', 'auth_oauth_client'),
  code: runtimeTable('postgres', 'auth_oauth_code'),
  grant: runtimeTable('postgres', 'auth_oauth_grant'),
  refresh: runtimeTable('postgres', 'auth_oauth_refresh'),
  access: runtimeTable('postgres', 'auth_oauth_access'),
  token: runtimeTable('postgres', 'auth_api_token'),
});

/** How long the file's operation waits for Better Auth's own transaction to end: a few hundred turns of the loop. */
const SQLITE_TURNS = 400;
const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

export function sqliteOAuthStore(db: DatabaseSync, appId: string): OAuthStore {
  return async <T>(work: (tables: OAuthTables) => OAuthWork<T>): Promise<T> => {
    for (let waited = 0; db.isTransaction; waited += 1) {
      if (waited >= SQLITE_TURNS) throw new ApiTokenStoreUnavailable();
      await turn();
    }
    // From here to COMMIT nothing awaits: no other request runs inside this transaction.
    throughApiTokenStore(() => db.exec('BEGIN IMMEDIATE'));
    try {
      const current = () => {
        if (!db.isTransaction) throw new Error('The OAuth transaction ended early.');
      };
      assertSqliteAuthTokenLayout(db);
      const meta = db.prepare(`SELECT store_id FROM main."${SQLITE_API_TOKEN_TABLES.meta}"`).all();
      if (meta.length !== 1) throw new Error('The API token store is not provisioned.');
      const storeId = meta[0].store_id;
      assertApiTokenSecretId(storeId);
      const store = createSqliteApiTokenStore(db, { appId, storeId }, current);
      // The shared attestation: layout, version and this App's binding.
      store.lookup(storeId);
      const operation = work(SQLITE_TABLES);
      let step = operation.next();
      while (!step.done) {
        const asked = step.value;
        let answer: unknown;
        try {
          if (asked.kind === 'all') answer = db.prepare(asked.sql).all(...(asked.params as SQLInputValue[]));
          else if (asked.kind === 'run') answer = Number(db.prepare(asked.sql).run(...(asked.params as SQLInputValue[])).changes);
          else if (asked.kind === 'eligible') answer = readSqliteEligibleAccountRoles(db, asked.accountId);
          else answer = store.insert(asked.stored);
        } catch (error) {
          operation.return(undefined as never);
          throw error;
        }
        current();
        step = operation.next(answer);
      }
      throughApiTokenStore(() => db.exec('COMMIT'));
      return step.value;
    } finally {
      if (db.isTransaction) db.exec('ROLLBACK');
    }
  };
}

/** `?` placeholders, numbered as PostgreSQL wants them. The operations' SQL holds no `?` of its own. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

export function postgresOAuthStore(pool: PgPool, appId: string): OAuthStore {
  return async <T>(work: (tables: OAuthTables) => OAuthWork<T>): Promise<T> => {
    const client: PgClient = await throughApiTokenStoreAsync(() => pool.connect());
    let begun = false,
      broken = false;
    try {
      try {
        await client.query('BEGIN');
        begun = true;
      } catch {
        broken = true;
        throw new ApiTokenStoreUnavailable();
      }
      const operations = new TransactionOperations();
      const meta = (await client.query(`SELECT store_id FROM ${runtimeTable('postgres', 'auth_api_token_meta')}`)).rows;
      if (meta.length !== 1) throw new Error('The API token store is not provisioned.');
      const storeId = meta[0].store_id;
      assertApiTokenSecretId(storeId);
      const store = createPostgresApiTokenStore(client, operations, { appId, storeId }, () => undefined);
      await store.lookup(storeId);
      const operation = work(POSTGRES_TABLES);
      let step = operation.next();
      while (!step.done) {
        const asked = step.value;
        let answer: unknown;
        try {
          if (asked.kind === 'all') answer = (await client.query(numbered(asked.sql), [...asked.params])).rows;
          else if (asked.kind === 'run') answer = (await client.query(numbered(asked.sql), [...asked.params])).rowCount ?? 0;
          else if (asked.kind === 'eligible') answer = await readPostgresEligibleAccountRoles(client, asked.accountId);
          else answer = await store.insert(asked.stored);
        } catch (error) {
          operation.return(undefined as never);
          throw error;
        }
        step = operation.next(answer);
      }
      await operations.finish();
      try {
        await client.query('COMMIT');
        begun = false;
      } catch {
        broken = true;
        throw new ApiTokenStoreUnavailable();
      }
      return step.value;
    } finally {
      if (begun) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true;
        }
      }
      client.release(broken);
    }
  };
}
