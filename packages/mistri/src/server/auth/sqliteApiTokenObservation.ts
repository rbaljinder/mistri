/** Private observation on a caller-owned native transaction. No opens, writes,
 * commits, session proof, HTTP admission or durable execution authority. */
import { DatabaseSync } from 'node:sqlite';
import { isPromise, isProxy } from 'node:util/types';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { assertAppApiContext } from '../api/appApiValidation.js';
import { apiReadTokenCatalog } from '../api/apiEventOperations.js';
import type { ApiTenantCatalog } from '../api/apiTenantCommandCatalog.js';
import { apiTokenSecretId, matchesApiTokenSecret } from '../api/apiTokenSecret.js';
import { narrowApiTokenScope, narrowTenantApiTokenScope, type TokenRecord } from '../api/apiTokenScope.js';
import { createSqliteApiTokenStore } from './sqliteApiTokenStore.js';
import { readSqliteEligibleAccountRoles } from './nativeAccountObservation.js';
import { captureApiTokenCommandContext } from './apiTokenCommandContext.js';
import { ApiTokenStoreUnavailable } from './apiTokenStoreFailure.js';
import { SQLITE_API_TOKEN_TABLES } from '../../adapters/auth/sqliteApiTokenLayout.js';

/** Where OAuth-issued tokens are honoured (api/oauthConfig.ts): the ceiling on the roles they carry. */
type OAuthCeiling = Readonly<{ roles: readonly string[] }>;

const refuse = (): never => {
  throw new Error('SQLite API token observation is unavailable.');
};

export function observeSqliteAccountToken(
  db: DatabaseSync,
  input: { app: AppDef; schema: DatabaseSchema; storeId: string; assertCurrent: () => void; oauth?: OAuthCeiling },
  rawCredential: unknown,
  now: number,
) {
  return observeAccountToken(db, input, rawCredential, now);
}

/** Private command-capable leaf factory, still requiring a caller-owned native
 * transaction. Captured catalog data is not genuine runtime or execution proof. */
export function createSqliteAccountCommandTokenObserver(...args: Parameters<typeof captureApiTokenCommandContext>) {
  const context = captureApiTokenCommandContext(...args);
  return (
    db: DatabaseSync,
    input: { storeId: string; assertCurrent: () => void; oauth?: OAuthCeiling },
    rawCredential: unknown,
    now: number,
  ) => observeAccountToken(db, { ...input, app: context.app, schema: context.schema }, rawCredential, now, context.catalog);
}

/** A tenant App's token on a caller-owned native transaction: still an eligible
 * account, bound to a membership, scoped by the tenant catalog (its reads and
 * any commands). The membership itself lives in the business store; the
 * tenant runtime observes it there. */
export function observeSqliteTenantAccountToken(
  db: DatabaseSync,
  input: { app: AppDef; catalog: ApiTenantCatalog; storeId: string; assertCurrent: () => void; oauth?: OAuthCeiling },
  rawCredential: unknown,
  now: number,
) {
  return observeAccountToken(
    db,
    { app: input.app, storeId: input.storeId, assertCurrent: input.assertCurrent, ...(input.oauth ? { oauth: input.oauth } : {}) },
    rawCredential,
    now,
    undefined,
    input.catalog,
  );
}

function observeAccountToken(
  db: DatabaseSync,
  input: { app: AppDef; schema?: DatabaseSchema; storeId: string; assertCurrent: () => void; oauth?: OAuthCeiling },
  rawCredential: unknown,
  now: number,
  commands?: ReturnType<typeof captureApiTokenCommandContext>['catalog'],
  tenant?: ApiTenantCatalog,
) {
  try {
    // App/schema are trusted invocation snapshots. This callback checks owner
    // lifetime only; accepting it does not establish native host provenance.
    if (isProxy(db) || !(db instanceof DatabaseSync) || typeof input.assertCurrent !== 'function' || isProxy(input.assertCurrent))
      return refuse();
    const { app, schema, storeId, assertCurrent } = input;
    const active = () => {
      if (!db.isTransaction) return refuse();
      const result = assertCurrent() as unknown;
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined || !db.isTransaction) return refuse();
    };
    active();
    if (!app.api) return refuse();
    // A tenant catalog serves a tenant App's token only, and never beside the
    // ordinary command evidence: its commands are already in its catalog.
    if (tenant ? commands !== undefined || app.auth?.rows !== 'tenant' : app.auth?.rows === 'tenant') return refuse();
    if (!commands && !tenant) assertAppApiContext(app);
    const catalog = tenant ?? commands ?? apiReadTokenCatalog(app.api, app, schema!);
    const id = apiTokenSecretId(rawCredential);
    // Reading a row is not wrapped: a row that will not decode is a judgement
    // about what is stored, not proof the store is down, and the two cannot be
    // told apart here. The file being unusable at all shows up when the
    // caller's transaction begins or commits, which is where it is reported.
    const stored = createSqliteApiTokenStore(db, { appId: app.id, storeId }, active).lookup(id);
    active();
    if (!stored || stored.record.subject.kind !== 'account' || !matchesApiTokenSecret(app.id, id, rawCredential, stored.digest))
      return refuse();
    const account = readSqliteEligibleAccountRoles(db, stored.record.subject.id);
    active();
    if (!account) return refuse();
    const record = oauthRecord(db, stored.record, app, input.oauth, now);
    active();
    const operations = catalog.operations.map((operation) => ({ id: operation.id, eligibleRoles: operation.eligibleRoles }));
    const bound = tenant
      ? narrowTenantApiTokenScope(record, app, { appId: app.id, subject: stored.record.subject, eligible: true }, operations, now)
      : undefined;
    const scope =
      bound ??
      narrowApiTokenScope(
        record,
        app,
        {
          appId: app.id,
          subject: stored.record.subject,
          eligible: true,
          roles: account.roles,
        },
        operations,
        now,
      );
    active();
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
  } catch (error) {
    // A store that could not answer stays distinguishable; every judgement
    // this observer made stays the one opaque refusal it already was.
    if (error instanceof ApiTokenStoreUnavailable) throw error;
    return refuse();
  }
}

/**
 * A token the OAuth authorization server issued (oauth_access names it) is
 * honoured only where that server is configured, while its grant stands —
 * not revoked, not past its thirty days — and for the very API it was issued
 * for: this App, at this version. Its roles are narrowed by the operator's
 * ceiling before the person's and the API's narrow them. Any other token has
 * no row and is exactly what it was.
 */
function oauthRecord(db: DatabaseSync, record: Readonly<TokenRecord>, app: AppDef, oauth: OAuthCeiling | undefined, now: number) {
  const rows = db
    .prepare(
      `SELECT a.app_id AS app_id, a.version AS version, g.revoked_at AS revoked_at, g.expires_at AS expires_at
       FROM main."${SQLITE_API_TOKEN_TABLES.access}" a JOIN main."${SQLITE_API_TOKEN_TABLES.grant}" g ON g.grant_id = a.grant_id
       WHERE a.token_id = ? COLLATE BINARY`,
    )
    .all(record.id);
  if (!rows.length) return record;
  const [row] = rows;
  if (
    rows.length !== 1 ||
    !oauth ||
    row.revoked_at !== null ||
    typeof row.expires_at !== 'number' ||
    !(row.expires_at > now) ||
    row.app_id !== app.id ||
    row.version !== app.api?.version
  )
    return refuse();
  return { ...record, roles: record.roles.filter((role) => oauth.roles.includes(role)) };
}
