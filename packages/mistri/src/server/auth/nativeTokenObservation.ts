/**
 * What reads a bearer token against the native auth store (SQLite file or
 * PostgreSQL pool), for the API's token observers (auth.ts exports the
 * acquire* doors).
 *
 * The runtime's private state stays in auth.ts: this module is handed the
 * owner's few accessors (`NativeTokenOwner`) rather than the maps, so a
 * token observer can only ask for what the genuine runtime holds, and a copy
 * or a proxy of a runtime still gets nothing.
 */
import {} from 'node:path';
import { isAsyncFunction, isGeneratorFunction, isPromise, isProxy } from 'node:util/types';
import { captureTenantData, recordRefusalCause } from '@mistriwork/engine/server/evidence.js';
import type { PgQuery, PgClient, PgResult } from '@mistriwork/engine/adapters/postgresPool.js';
import { assertPostgresAuthStore } from '../../adapters/auth/postgresAuthStore.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import {
  observeSqliteAccountToken,
  observeSqliteTenantAccountToken,
  createSqliteAccountCommandTokenObserver,
} from './sqliteApiTokenObservation.js';
import { createSqliteApiTokenStore } from './sqliteApiTokenStore.js';
import { assertSqliteAuthTokenLayout } from '../../adapters/auth/sqliteAuthStoreLayout.js';
import { SQLITE_API_TOKEN_TABLES } from '../../adapters/auth/sqliteApiTokenLayout.js';
import { assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import { checkApiReadCatalog } from '../api/apiReadCatalog.js';
import type { ApiTenantCatalog } from '../api/apiTenantCommandCatalog.js';
import { assertAppApiContext } from '../api/appApiValidation.js';
import { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { observePostgresAccountToken } from './postgresApiTokenObservation.js';
import { ApiTokenStoreUnavailable, throughApiTokenStore, throughApiTokenStoreAsync } from './apiTokenStoreFailure.js';
import { captureApiTokenCommandContext } from './apiTokenCommandContext.js';
import { createPostgresApiTokenStore } from './postgresApiTokenStore.js';
import type { PgPool } from '@mistriwork/engine/adapters/postgresPool.js';
import type { DatabaseSync } from 'node:sqlite';
import type { AppAuthRuntime, AppAuthRuntimeBinding } from './auth.js';

/** The runtime-private lookups auth.ts lends an observer: the genuine binding, the native store, the OAuth ceiling. */
interface NativeTokenOwner<Store> {
  readonly capture: (runtime: AppAuthRuntime) => AppAuthRuntimeBinding;
  readonly stores: WeakMap<AppAuthRuntime, Store>;
  readonly oauthOf: (runtime: AppAuthRuntime) => { oauth?: Readonly<{ roles: readonly string[] }> };
}

/* The first read an API owner makes is the token store's own metadata; a
   store that never answers it has not been provisioned (or cannot be
   reached), and the server that will not start says so. */
const tokenStoreNotReady = (cause: unknown): never => {
  throw recordRefusalCause(
    new Error(
      "This App's API token store could not be read: it is not provisioned, or not reachable. " +
        'Provision it first: mistri api-token provision (see mistri api-token --help).',
    ),
    cause,
  );
};

export async function acquirePostgresTokenObservation(
  owner: NativeTokenOwner<PgPool>,
  runtime: AppAuthRuntime,
  app: AppDef,
  schema: DatabaseSchema | undefined,
  commands?: {
    registry: Parameters<typeof captureApiTokenCommandContext>[2];
    evidence: Parameters<typeof captureApiTokenCommandContext>[3];
  },
  tenantCatalog?: ApiTenantCatalog,
) {
  const refuse = (cause?: unknown): never => {
    throw recordRefusalCause(new Error('Native token observation is unavailable.'), cause);
  };
  try {
    const binding = owner.capture(runtime),
      pool = owner.stores.get(runtime);
    const capturedApp = captureTenantData(app),
      capturedSchema = schema === undefined ? undefined : captureTenantData(schema);
    if (!pool || capturedApp.id !== binding.appId) return refuse();
    if (!capturedApp.api) return refuse();
    const tenant = tenantCatalog === undefined ? undefined : captureTenantData(tenantCatalog);
    if (tenant ? commands !== undefined || capturedApp.auth?.rows !== 'tenant' : capturedApp.auth?.rows === 'tenant' || !capturedSchema)
      return refuse();
    const commandContext = commands && captureApiTokenCommandContext(capturedApp, capturedSchema!, commands.registry, commands.evidence);
    if (!commandContext && !tenant) {
      assertAppApiContext(capturedApp);
      checkApiReadCatalog(capturedApp.api, capturedApp, capturedSchema!);
    }
    // The catalog the observations derive scope from: read-only, or combined.
    const observeInput = { app: commandContext?.app ?? capturedApp, schema: commandContext?.schema ?? capturedSchema };
    let retired = false;
    const pending = new Set<Promise<unknown>>();
    const current = () => {
      binding.assertCurrent();
      if (retired || owner.stores.get(runtime) !== pool) return refuse();
    };
    const transaction = <T>(work: (client: PgQuery, operations: TransactionOperations) => Promise<T>): Promise<T> => {
      current();
      // Register before any pool callback can reentrantly retire the owner.
      const operation = Promise.resolve().then(async () => {
        let client: PgClient | undefined,
          begun = false,
          broken = false,
          drained = false;
        let failed = false,
          value!: T;
        // Kept, so a store that could not answer stays distinguishable from a
        // judgement about the credential after this catch flattens both.
        let thrown: unknown;
        const operations = new TransactionOperations();
        try {
          current();
          client = await throughApiTokenStoreAsync(() => pool.connect());
          current();
          function query(sql: string, values?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
          function query(sql: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
          async function query(sql: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
            current();
            const result = typeof sql === 'string' ? await client!.query(sql, values) : await client!.query(sql);
            current();
            return result;
          }
          // Even a failed BEGIN may have reached the server; cleanup must not
          // return an uncertain transaction to the native auth pool.
          begun = true;
          try {
            await query('BEGIN');
          } catch {
            broken = true;
            throw new ApiTokenStoreUnavailable();
          }
          value = await work({ query }, operations);
          current();
          await operations.finish();
          drained = true;
          current();
          try {
            await client.query('COMMIT');
          } catch {
            broken = true;
            throw new ApiTokenStoreUnavailable();
          }
          begun = false;
          current();
        } catch (error) {
          failed = true;
          thrown = error;
        } finally {
          try {
            if (!drained) {
              try {
                await operations.finish();
              } catch {
                /* Original refusal retained. */
              }
            }
            if (client && begun) {
              try {
                await client.query('ROLLBACK');
              } catch {
                broken = true;
              }
            }
          } finally {
            if (client) {
              try {
                client.release(broken);
              } catch {
                failed = true;
              }
            }
          }
        }
        // A store that could not be read decided nothing about the credential;
        // anything else stays the one opaque refusal it already was.
        if (failed) {
          if (thrown instanceof ApiTokenStoreUnavailable) throw thrown;
          return refuse();
        }
        return value;
      });
      pending.add(operation);
      void operation.then(
        () => pending.delete(operation),
        () => pending.delete(operation),
      );
      return operation;
    };
    const storeId = await transaction(async (client, operations) => {
      await assertPostgresAuthStore(client);
      current();
      const rows = (await client.query(`SELECT store_id FROM ${runtimeTable('postgres', 'auth_api_token_meta')}`)).rows;
      if (rows.length !== 1) return refuse();
      const id = rows[0].store_id;
      assertApiTokenSecretId(id);
      await createPostgresApiTokenStore(client, operations, { appId: binding.appId, storeId: id }, current).lookup(id);
      current();
      return id;
    }).catch(tokenStoreNotReady);
    current();
    type Observation = Awaited<ReturnType<typeof observePostgresAccountToken>>;
    const handles = new WeakMap<object, Observation>();
    const handedOff = new WeakSet<object>();
    return Object.freeze({
      /** Trusted composition only: send an already serialized response while
       * the native subject/token locks remain held. No client or observation
       * escapes to the callback. This does not prove business-schema lifetime.
       * Once entered, a callback or cleanup failure is irreversible uncertainty,
       * never permission to retry the callback or emit another response. */
      handoff: async (credential: unknown, expectedHandle: unknown, send: () => void) => {
        let entered = false;
        try {
          current();
          if (
            typeof send !== 'function' ||
            isProxy(send) ||
            isAsyncFunction(send) ||
            isGeneratorFunction(send) ||
            !expectedHandle ||
            typeof expectedHandle !== 'object' ||
            isProxy(expectedHandle)
          )
            return refuse();
          const expected = handles.get(expectedHandle);
          if (!expected || handedOff.has(expectedHandle) || !(expected.expiresAt > Date.now())) return refuse();
          // Claim before the first await; concurrent calls cannot reuse a send.
          handedOff.add(expectedHandle);
          await transaction(async (client, operations) => {
            const observed = await observePostgresAccountToken(
              client,
              operations,
              { app: observeInput.app, schema: observeInput.schema, storeId, assertCurrent: current, ...owner.oauthOf(runtime) },
              credential,
              Date.now,
              commandContext?.catalog,
              tenant,
            );
            await operations.finish();
            current();
            if (!(observed.expiresAt > Date.now()) || JSON.stringify(observed) !== JSON.stringify(expected)) return refuse();
            entered = true;
            const result: unknown = send();
            // Never inspect a then getter. Native promises are drained solely
            // to avoid an unhandled rejection from an invalid trusted callback.
            if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
            if (result !== undefined) return refuse();
          });
          current();
          return Object.freeze({ stage: 'token-handoff' as const, outcome: 'complete' as const });
        } catch {
          if (!entered) return refuse();
          return Object.freeze({ stage: 'token-handoff' as const, outcome: 'uncertain' as const });
        }
      },
      retire: async () => {
        retired = true;
        await Promise.allSettled([...pending]);
      },
      observe: async (credential: unknown): Promise<Readonly<object>> => {
        try {
          const value = await transaction((client, operations) =>
            observePostgresAccountToken(
              client,
              operations,
              { app: observeInput.app, schema: observeInput.schema, storeId, assertCurrent: current, ...owner.oauthOf(runtime) },
              credential,
              Date.now,
              commandContext?.catalog,
              tenant,
            ),
          );
          current();
          const handle = Object.freeze(Object.create(null) as object);
          handles.set(handle, value);
          return handle;
        } catch (error) {
          if (error instanceof ApiTokenStoreUnavailable) throw error;
          return refuse();
        }
      },
      /** Provenance/lifetime only, not a fresh token or role observation. */
      inspect: (handle: unknown): Observation => {
        try {
          current();
          if (!handle || typeof handle !== 'object' || isProxy(handle)) return refuse();
          const value = handles.get(handle);
          if (!value || !(value.expiresAt > Date.now())) return refuse();
          return value;
        } catch {
          return refuse();
        }
      },
    });
  } catch (error) {
    // Kept for the operator: a server that will not start says why.
    return refuse(error);
  }
}

export function acquireSqliteTokenObservation(
  owner: NativeTokenOwner<DatabaseSync>,
  runtime: AppAuthRuntime,
  app: AppDef,
  schema: DatabaseSchema | undefined,
  commands?: {
    registry: Parameters<typeof createSqliteAccountCommandTokenObserver>[2];
    evidence: Parameters<typeof createSqliteAccountCommandTokenObserver>[3];
  },
  tenantCatalog?: ApiTenantCatalog,
) {
  const refuse = (cause?: unknown): never => {
    throw recordRefusalCause(new Error('Native token observation is unavailable.'), cause);
  };
  try {
    const binding = owner.capture(runtime),
      db = owner.stores.get(runtime);
    const capturedApp = captureTenantData(app),
      capturedSchema = schema === undefined ? undefined : captureTenantData(schema);
    if (!db || capturedApp.id !== binding.appId) return refuse();
    if (!capturedApp.api) return refuse();
    const tenant = tenantCatalog === undefined ? undefined : captureTenantData(tenantCatalog);
    if (tenant ? commands !== undefined || capturedApp.auth?.rows !== 'tenant' : capturedApp.auth?.rows === 'tenant' || !capturedSchema)
      return refuse();
    const commandObserver =
      commands && createSqliteAccountCommandTokenObserver(capturedApp, capturedSchema!, commands.registry, commands.evidence);
    if (!commandObserver && !tenant) {
      assertAppApiContext(capturedApp);
      checkApiReadCatalog(capturedApp.api, capturedApp, capturedSchema!);
    }
    let retired = false;
    const current = () => {
      binding.assertCurrent();
      if (retired || owner.stores.get(runtime) !== db) return refuse();
    };
    const transaction = <T>(work: () => T): T => {
      current();
      if (db.isTransaction) return refuse();
      // A file that will not open a transaction, or will not commit one, has
      // decided nothing about any credential: that is the store being down.
      throughApiTokenStore(() => db.exec('BEGIN'));
      try {
        current();
        // SQLite's BEGIN is deferred, so a locked or unreadable file refuses at
        // the first read, not at BEGIN. This one reads the store's own metadata
        // and no token, so it can never stand in for a judgement about a
        // credential — it only answers whether the store can be read at all.
        throughApiTokenStore(() => {
          db.prepare(`SELECT store_id FROM main."${SQLITE_API_TOKEN_TABLES.meta}" LIMIT 1`).get();
        });
        const value = work();
        current();
        throughApiTokenStore(() => db.exec('COMMIT'));
        current();
        return value;
      } finally {
        if (db.isTransaction) db.exec('ROLLBACK');
      }
    };
    const storeId = (() => {
      try {
        return transaction(() => {
          assertSqliteAuthTokenLayout(db);
          const rows = db.prepare(`SELECT CAST(store_id AS BLOB) AS id FROM main."${SQLITE_API_TOKEN_TABLES.meta}"`).all();
          if (rows.length !== 1 || !(rows[0].id instanceof Uint8Array)) return refuse();
          const id = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(rows[0].id);
          assertApiTokenSecretId(id);
          // This forces the shared exact metadata/layout validator, including
          // App binding, even when no token records exist yet.
          createSqliteApiTokenStore(db, { appId: binding.appId, storeId: id }, current).lookup(id);
          return id;
        });
      } catch (error) {
        return tokenStoreNotReady(error);
      }
    })();
    type Observation = ReturnType<typeof observeSqliteAccountToken>;
    const handles = new WeakMap<object, Observation>();
    return Object.freeze({
      retire: () => {
        retired = true;
      },
      observe: (credential: unknown): Readonly<object> => {
        try {
          const value = transaction(() =>
            tenant
              ? observeSqliteTenantAccountToken(
                  db,
                  { app: capturedApp, catalog: tenant, storeId, assertCurrent: current, ...owner.oauthOf(runtime) },
                  credential,
                  Date.now(),
                )
              : commandObserver
                ? commandObserver(db, { storeId, assertCurrent: current, ...owner.oauthOf(runtime) }, credential, Date.now())
                : observeSqliteAccountToken(
                    db,
                    { app: capturedApp, schema: capturedSchema!, storeId, assertCurrent: current, ...owner.oauthOf(runtime) },
                    credential,
                    Date.now(),
                  ),
          );
          current();
          const handle = Object.freeze(Object.create(null) as object);
          handles.set(handle, value);
          return handle;
        } catch (error) {
          if (error instanceof ApiTokenStoreUnavailable) throw error;
          return refuse();
        }
      },
      /** Provenance/lifetime inspection only. Not a new account/role/token
       * observation: callers must freshly observe before admission. */
      inspect: (handle: unknown): Observation => {
        try {
          current();
          if (!handle || typeof handle !== 'object' || isProxy(handle)) return refuse();
          const value = handles.get(handle);
          if (!value || !(value.expiresAt > Date.now())) return refuse();
          return value;
        } catch {
          return refuse();
        }
      },
    });
  } catch (error) {
    // Kept for the operator: a server that will not start says why.
    return refuse(error);
  }
}
