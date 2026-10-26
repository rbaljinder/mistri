/** Private observation on a trusted caller-owned PostgreSQL transaction.
 * No opens/writes/commits, cookie proof or durable execution authority. Native
 * transaction attestation is not provenance for an arbitrary supplied PgQuery.
 */
import { isPromise, isProxy } from 'node:util/types';
import { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery, PgResult } from '@mistriwork/engine/adapters/postgresPool.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { assertAppApiContext } from '../api/appApiValidation.js';
import { apiReadTokenCatalog } from '../api/apiEventOperations.js';
import type { ApiTenantCatalog } from '../api/apiTenantCommandCatalog.js';
import { apiTokenSecretId, matchesApiTokenSecret } from '../api/apiTokenSecret.js';
import { narrowApiTokenScope, narrowTenantApiTokenScope } from '../api/apiTokenScope.js';
import { createPostgresApiTokenStore } from './postgresApiTokenStore.js';
import { readPostgresEligibleAccountRoles } from './nativeAccountObservation.js';
import { ApiTokenStoreUnavailable, throughApiTokenStoreAsync } from './apiTokenStoreFailure.js';
import type { captureApiTokenCommandContext } from './apiTokenCommandContext.js';

const refuse = (): never => {
  throw new Error('PostgreSQL API token observation is unavailable.');
};
const accounts = runtimeTable('postgres', 'auth_user'),
  tokens = runtimeTable('postgres', 'auth_api_token'),
  accessTable = runtimeTable('postgres', 'auth_oauth_access'),
  grants = runtimeTable('postgres', 'auth_oauth_grant');
/** `commands` is the combined read + command catalog from
 * `captureApiTokenCommandContext`, exactly as the SQLite observer takes it;
 * without it the App must be a read-only API context, as before. */
export async function observePostgresAccountToken(
  client: PgQuery,
  operations: TransactionOperations,
  input: {
    app: AppDef;
    schema?: DatabaseSchema;
    storeId: string;
    assertCurrent: () => void;
    /** Where OAuth-issued tokens are honoured (api/oauthConfig.ts): the ceiling on the roles they carry. */
    oauth?: Readonly<{ roles: readonly string[] }>;
  },
  rawCredential: unknown,
  clock: () => number,
  commands?: ReturnType<typeof captureApiTokenCommandContext>['catalog'],
  /** A tenant App's catalog — its reads and any commands: its token must be
   * bound to a membership, never beside the ordinary command evidence. */
  tenant?: ApiTenantCatalog,
) {
  try {
    if (
      !client ||
      isProxy(client) ||
      typeof client.query !== 'function' ||
      typeof input.assertCurrent !== 'function' ||
      isProxy(input.assertCurrent) ||
      typeof clock !== 'function' ||
      isProxy(clock)
    )
      return refuse();
    const { app, schema, storeId, assertCurrent } = input;
    if (!app.api) return refuse();
    if (tenant ? commands !== undefined || app.auth?.rows !== 'tenant' : app.auth?.rows === 'tenant') return refuse();
    if (!commands && !tenant) assertAppApiContext(app);
    const catalog = tenant ?? commands ?? apiReadTokenCatalog(app.api, app, schema!),
      id = apiTokenSecretId(rawCredential);
    const scopeOperations = Object.freeze(
      catalog.operations.map((operation) =>
        Object.freeze({
          id: operation.id,
          eligibleRoles: operation.eligibleRoles,
        }),
      ),
    );
    // Only the facts narrowApiTokenScope reads are retained across awaits.
    // The complete parsed App remains the trusted catalog construction input.
    const scopedApp = { ...app, api: { ...app.api, roles: [...app.api.roles] }, auth: { ...app.auth!, roles: { ...app.auth!.roles } } };
    let previous = -1;
    const now = () => {
      const value: unknown = clock();
      if (isPromise(value)) void Promise.prototype.then.call(value, undefined, () => {});
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000 || value < previous)
        return refuse();
      previous = value;
      return value;
    };
    now();
    return await operations.run(async () => {
      let live = true,
        drained = false;
      const current = () => {
        if (!live) return refuse();
        const result: unknown = assertCurrent();
        if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
        if (result !== undefined || !live) return refuse();
      };
      function query(sql: string, values?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
      function query(sql: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
      async function query(sql: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
        current();
        // The driver call alone is the store: a statement that will not run is
        // the store failing, while this owner's own lifetime checks around it
        // stay the opaque refusal they were.
        const result =
          typeof sql === 'string'
            ? await throughApiTokenStoreAsync(() => client.query(sql, values))
            : await throughApiTokenStoreAsync(() => client.query(sql));
        current();
        return result;
      }
      const guarded: PgQuery = { query },
        storeOperations = new TransactionOperations();
      try {
        current();
        const store = createPostgresApiTokenStore(guarded, storeOperations, { appId: scopedApp.id, storeId }, current);
        // Reading a row is not wrapped: a row that will not decode is a
        // judgement about what is stored, not proof the store is down, and the
        // two cannot be told apart here. The plain statements below are, and so
        // are connecting, beginning and committing, where an unreachable or
        // terminated store actually shows itself.
        const initial = await store.lookup(id);
        current();
        if (
          !initial ||
          initial.record.subject.kind !== 'account' ||
          !matchesApiTokenSecret(scopedApp.id, id, rawCredential, initial.digest)
        )
          return refuse();
        // Discovery is not the result. Lock account before token, matching
        // maintenance revoke when audit actor and token subject are identical.
        const subjectId = initial.record.subject.id;
        const accountLock = (await query(`SELECT id FROM ${accounts} WHERE id=$1 COLLATE "C" FOR SHARE`, [subjectId])).rows;
        if (accountLock.length !== 1 || accountLock[0].id !== subjectId) return refuse();
        const tokenLock = (
          await query(`SELECT token_id FROM ${tokens} WHERE token_id=$1 COLLATE "C" AND app_id=$2 COLLATE "C" FOR SHARE`, [
            id,
            scopedApp.id,
          ])
        ).rows;
        if (tokenLock.length !== 1 || tokenLock[0].token_id !== id) return refuse();
        const stored = await store.lookup(id);
        current();
        if (
          !stored ||
          stored.record.subject.kind !== 'account' ||
          stored.record.subject.id !== subjectId ||
          !matchesApiTokenSecret(scopedApp.id, id, rawCredential, stored.digest)
        )
          return refuse();
        const account = await readPostgresEligibleAccountRoles(guarded, subjectId);
        current();
        if (!account) return refuse();
        /* A token the OAuth authorization server issued is honoured only where
           that server is configured, while its grant stands, and for the API
           it was issued for; the operator's ceiling narrows its roles first.
           Any other token has no row (sqliteApiTokenObservation.ts says the same). */
        const access = (
          await query(
            `SELECT a.app_id, a.version::float8 AS version, g.revoked_at::float8 AS revoked_at, g.expires_at::float8 AS expires_at
             FROM ${accessTable} a JOIN ${grants} g ON g.grant_id = a.grant_id WHERE a.token_id = $1 COLLATE "C" FOR SHARE OF g`,
            [id],
          )
        ).rows;
        await storeOperations.finish();
        drained = true;
        current();
        const instant = now();
        current();
        let record = stored.record;
        if (access.length) {
          const [row] = access;
          if (
            access.length !== 1 ||
            !input.oauth ||
            row.revoked_at !== null ||
            typeof row.expires_at !== 'number' ||
            !(row.expires_at > instant) ||
            row.app_id !== scopedApp.id ||
            row.version !== scopedApp.api.version
          )
            return refuse();
          const ceiling = input.oauth.roles;
          record = { ...record, roles: record.roles.filter((role) => ceiling.includes(role)) };
        }
        const bound = tenant
          ? narrowTenantApiTokenScope(
              record,
              scopedApp,
              { appId: scopedApp.id, subject: stored.record.subject, eligible: true },
              scopeOperations,
              instant,
            )
          : undefined;
        const scope =
          bound ??
          narrowApiTokenScope(
            record,
            scopedApp,
            {
              appId: scopedApp.id,
              subject: stored.record.subject,
              eligible: true,
              roles: account.roles,
            },
            scopeOperations,
            instant,
          );
        current();
        return Object.freeze({
          stage: 'token-observation' as const,
          authorization: 'pending' as const,
          tokenId: scope.tokenId,
          appId: scope.appId,
          subject: scope.subject,
          version: stored.version,
          expiresAt: stored.record.expiresAt,
          roles: scope.roles,
          operations: scope.operations,
          ...(bound ? { tenant: bound.tenant } : {}),
        });
      } finally {
        try {
          if (!drained) await storeOperations.finish();
        } finally {
          live = false;
        }
      }
    });
  } catch (error) {
    // A store that could not answer stays distinguishable; every judgement
    // this observer made stays the one opaque refusal it already was.
    if (error instanceof ApiTokenStoreUnavailable) throw error;
    return refuse();
  }
}
