/**
 * Sign-in for an app, through Better Auth.
 *
 * mistri's own trust model is loopback, or a header a proxy sets. An app
 * that says `auth` in its manifest wants people to sign in to *it*: email
 * and password, or a social provider, with sessions, verification, rate
 * limits and an admin plugin that this project would otherwise write badly
 * and slowly. Better Auth does all of that; what this file does is fit it:
 *
 *   - it is an optional dependency, imported only when a manifest asks, so
 *     nobody else pays for it — the pattern `pg` and `mysql2` set;
 *   - the store is a SQLite file of mistri's own, through node:sqlite,
 *     or a PostgreSQL database of its own when `auth.store` is a
 *     `postgres://` URL (authStore.ts) — never the app's database (it is
 *     not ours to add tables to) and never the app directory (it is
 *     committed);
 *   - secrets come from the environment, refused at startup when missing,
 *     the way `${VAR}` connections are;
 *   - the handler mounts on the plain node:http server at /api/auth/*, and
 *     `session()` is the whole server-side check, answering the `who` the
 *     journal and the write scope already read.
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { isAsyncFunction, isGeneratorFunction, isPromise, isProxy } from 'node:util/types';
import { SIGN_UP_MODES, TENANT_OIDC, TENANT_SAML, signInOf, type AppSignIn } from '../../shared/app.js';
import { isRecord } from '@mistriwork/engine/shared/model.js';
import { EMAIL_DOMAIN, isAuthProvider } from '../../shared/appAuthGrants.js';
import {
  backchannelLogoutUrl,
  identityProblems,
  samlServiceProvider,
  type FederatedProviderConfig,
  type IdentityProviderConfig,
  type SamlProviderConfig,
} from './identityConfig.js';
import { oidcProvider, type Jose, type SignInEvidence } from './identityProviders.js';
import { identityHooks, namedProviders, roleClaimsOf, sessionRoles, signUpShut, type FederatedSignIn } from './identityRoles.js';
import type { LogoutContext } from './backchannelLogout.js';
import { LOADED_APP_KEYS, type LoadedApp } from '../app/apps.js';
import { configLocations } from '@mistriwork/engine/server/config/locations.js';
import { createAccountProfileHandler, type AccountProfileApi } from './accountProfile.js';
import { createAccountAdministration, type AccountAdminApi, type AccountAdministrationRuntime } from './accountAdministration.js';
import { ADMIN_ROLE, rolesOf } from '../../shared/accountAdministration.js';
import {
  accountAuditPlugin,
  createAccountAuditStore,
  provisionSqliteAccountAudit,
  type AuditAdapter,
  type AuditTransactions,
} from './accountAudit.js';
import { TEST_AUTH_LIMITS, authLimitsOffForTests, closedNativeAdminPath, homeRealm, nativeAdminPath } from './requestRules.js';
export { TEST_AUTH_LIMITS };
import { identityStorePlugin } from './identityStore.js';
import { registerNativeAccounts, registerSuiteAccountObservations } from './authAccounts.js';
import {
  captureTenantData,
  denyTenant,
  recordRefusalCause,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import {
  assertAuthStoreSeparation,
  assertPostgresAuthStoreSeparation,
  assertPostgresAuthStoreServerSeparation,
  type AuthStoreExclusion,
  type PostgresSeparationConnection,
} from './authStoreSeparation.js';
import { isPostgresAuthStore, openPostgresAuthStore, openSqliteAuthStore, type AuthStoreHandle } from './authStore.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import type { PgQuery, PgPool, PgClient, PgResult } from '@mistriwork/engine/adapters/postgresPool.js';
import { assertPostgresAuthStore, withPostgresAuthModels } from '../../adapters/auth/postgresAuthStore.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { nativeAccountEligible, readSqliteEligibleAccountRoles } from './nativeAccountObservation.js';
import { instantOf, postgresObserver, type AccountRoles, type StoreObserver } from './storeObserver.js';
import type { DatabaseSync } from 'node:sqlite';
import { signInState } from './signInState.js';
import { signInLockoutPlugin } from './signInLockout.js';
import { clientAddress } from '@mistriwork/engine/server/http/rateLimit.js';
import { insecureCookieWarning, warnOnce } from '@mistriwork/engine/server/startupWarnings.js';
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
import { createNativeSignInAge } from './nativeSignInAge.js';
import type { EmailTransport } from '../email/email.js';
import { appAuthProviders, passwordResetDelivery } from './authProviders.js';
import { embedProblems, issuersFor, type EmbedIssuerConfig } from '../embed/issuerConfig.js';
import { EmbedRefusal, embedIssuers } from '../embed/assertion.js';
import { createEmbedExchange } from '../embed/exchange.js';
import { assertionLedger, type LedgerAdapter } from '../embed/ledger.js';
import type { ProxyRange } from '@mistriwork/engine/server/http/trust.js';
import { embedSignInPlugin, type EmbedApi, type EmbedSignInAnswer } from '../embed/signInPlugin.js';
import { oauthProblems, oauthRoleCeiling, type OAuthServerConfig } from '../api/oauthConfig.js';
import { bindOAuthResource, oauthTenancyOf } from './oauthResource.js';
import { scimEntriesFor, type ScimDirectoryConfig } from './scimConfig.js';
import { scimProvisioning } from './scimDirectory.js';
import { authFailureLog } from './authFailureLog.js';

/** A name that is one plain line: trimmed, short, no control characters. A malformed one is not said at all. */
function sayableName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name === name.trim() &&
    Buffer.byteLength(name, 'utf8') <= 256 &&
    !/[\p{Cc}\p{Cs}]/u.test(name)
  );
}

/** A display name for an account made with only an email (the bootstrapped admin): its local part
 * as words, so a dashboard greets "Margaret Hollis" and not "margaret.hollis". The person can change it. */

/** The header Better Auth reads the client's address from: set by this server on every auth request, never the client's. */
const CLIENT_ADDRESS_HEADER = 'x-mistri-client-address';

export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? '';
  const words = local.split(/[._+-]+/).filter((word) => /^\p{L}/u.test(word));
  return words.length ? words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ') : local;
}

/**
 * Why the first-start admin variables made no account, or undefined when they
 * are unset or would make one. Said on the log because a half-set pair or an
 * App with no sign-in otherwise ends in a sign-in screen that knows no one,
 * with nothing to say the variables were read at all.
 */
export function ignoredAdminEnvironment(env: NodeJS.ProcessEnv, appName: string, signsIn: boolean): string | undefined {
  const email = Boolean(env.MISTRI_AUTH_ADMIN_EMAIL?.trim());
  const password = Boolean(env.MISTRI_AUTH_ADMIN_PASSWORD);
  if (!email && !password) return undefined;
  const named =
    email && password
      ? 'MISTRI_AUTH_ADMIN_EMAIL and MISTRI_AUTH_ADMIN_PASSWORD are'
      : email
        ? 'MISTRI_AUTH_ADMIN_EMAIL is'
        : 'MISTRI_AUTH_ADMIN_PASSWORD is';
  if (!signsIn) return `mistri: ${named} set, but "${appName}" declares no auth, so no one signs in to it and no admin account was made.`;
  if (email && password) return undefined;
  const missing = email ? 'MISTRI_AUTH_ADMIN_PASSWORD' : 'MISTRI_AUTH_ADMIN_EMAIL';
  return `mistri: ${named} set but ${missing} is not, so no admin account was made for "${appName}". Set both.`;
}

export interface Identity {
  id: string;
  /** The email, which is how a person is named in the journal. */
  who: string;
  role?: string;
  /** The account's own name, for a dashboard that greets its reader (appGreeting.ts): words on a screen, never
      an authority, and absent where it is not a plain line of text. */
  name?: string;
  /** The sign-in store says the account proved its email (a verification link): what a link by email needs. */
  emailVerified?: true;
  /** Anyone may sign up here and this account has not proved its email: until it does, the address names
      nobody — no `me`, no inbox — since any visitor could have typed it (appStamps.ts signedInAs). */
  emailUnproven?: true;
}
/** Server-only identity for one particular verified login, never a cookie token
 * or browser credential. A same-account new login has a different session ID. */
export interface VerifiedSessionInstance {
  readonly identity: Readonly<Identity>;
  readonly sessionId: string;
  readonly expiresAt: number;
}

export interface AppAuthRuntime {
  /** Captured by suite composition; absent for standalone Apps. */
  readonly suite?: Readonly<{ basePath: string }>;
  /** Only the built-in own-account name editor, not general user management. */
  accountProfile?: true;
  /** An administrator's accounts screen (accountAdministration.ts): the
      accounts, their roles and whether each signs in, through Better Auth's
      admin API with the request's own session. Absent where nothing signs in. */
  accounts?: AccountAdministrationRuntime;
  /** A forgotten password is reset by a one-time link the server delivers
   * (`passwordResetDelivery`). Absent: an administrator resets it. */
  passwordReset?: 'link';
  /** The manifest's block, for what the client is told. */
  spec: AppSignIn;
  /** The words on each identity provider's button, by how `auth.providers` names it: never its configuration. */
  labels?: Readonly<Record<string, string>>;
  /** The Better Auth routes, mounted under /api/auth. */
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  /** Who this request is, by its session cookie, or null. */
  session: (req: IncomingMessage) => Promise<Identity | null>;
  /** Optional for other auth implementations; tenant contexts require it and
   * never substitute the account-only session() method. */
  sessionInstance?: (req: IncomingMessage) => Promise<VerifiedSessionInstance | null>;
  /** Where sessions live, for the startup log: the file's path, or a
   * `postgres://` URL shown without its password. */
  store: string;
  /** Release the session store after requests have drained. Idempotent. */
  close: () => void;
  /** Hosts that sign people in for this App (embed/): the origins they are on, and a cross-origin
      bearer as the session cookie it stands for. Absent where the config file names none. */
  embed?: Readonly<{
    origins: ReadonlySet<string>;
    sessionCookie: string;
    bearer: (req: IncomingMessage) => Promise<string | undefined>;
  }>;
}

/** Private built-in provenance, not a structural alternative auth provider.
 * The composition owner must drain requests before closing the auth store. */
export interface AppAuthRuntimeBinding {
  readonly appId: string;
  readonly spec: AppSignIn;
  readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly sessionInstance: (req: IncomingMessage) => Promise<VerifiedSessionInstance | null>;
  /** Final synchronous observation of a proof issued by this binding. This is
   * not a credential verifier or a distributed auth/business transaction. */
  readonly assertSessionCurrent: (proof: VerifiedSessionInstance) => void;
  /** Private exact native user-ID existence only, not email verification or an
   * authorization decision. The owner must authorize before using this lookup.
   * Synchronous stores only: refuses on a PostgreSQL store (`lookupAccountCurrent`). */
  readonly lookupAccount: (accountId: string) => Readonly<{ accountId: string }> | null;
  /** Current native account/ban eligibility, independent of any ongoing login.
   * Private observation only: no tenant grant or distributed transaction.
   * Synchronous stores only, as `lookupAccount`. */
  readonly lookupEligibleAccount: (accountId: string) => Readonly<{ accountId: string }> | null;
  readonly close: () => void;
  readonly assertCurrent: () => void;
  /** Whether the store can be read synchronously: the file store. A PostgreSQL
   * store is observed with the asynchronous methods below, which the owner calls
   * at its last await before COMMIT; there `assertSessionCurrent` checks only
   * what needs no read — a proof this binding issued, not yet expired. */
  readonly synchronous: boolean;
  /** A fresh observation of an issued proof's session and account in the
   * store: refuses a session that ended, was shortened or is impersonated, and
   * an account that is banned. On the file store, `assertSessionCurrent`. */
  readonly observeSession: (proof: VerifiedSessionInstance) => Promise<void>;
  readonly lookupAccountCurrent: (accountId: string) => Promise<Readonly<{ accountId: string }> | null>;
  readonly lookupEligibleAccountCurrent: (accountId: string) => Promise<Readonly<{ accountId: string }> | null>;
  /** One native row observation, not a token verifier or an admitted principal.
   * Null roles mean no roles; signup defaults never broaden this observation. */
  readonly lookupEligibleAccountRolesCurrent: (accountId: string) => Promise<AccountRoles | null>;
  /** The hosts that sign people in here, for a server's cross-origin door (embed/crossOrigin.ts). */
  readonly embed?: AppAuthRuntime['embed'];
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
const authRuntimes = new WeakMap<AppAuthRuntime, AppAuthRuntimeBinding>();
const nativeTokenFiles = new WeakMap<AppAuthRuntime, DatabaseSync>();
const nativeTokenPools = new WeakMap<AppAuthRuntime, PgPool>();
const suiteAuthSources = new WeakMap<AppAuthRuntime, AppAuthRuntime>();
const nativeSignInAges = new WeakMap<AppAuthRuntime, ReturnType<typeof createNativeSignInAge>>();
const nativeDisplayNames = new WeakMap<AppAuthRuntime, Readonly<{ displayName(proof: VerifiedSessionInstance): string }>>();
const nativeStepUpProviders = new WeakMap<AppAuthRuntime, Readonly<{ provider(proof: VerifiedSessionInstance): string | undefined }>>();
/** Where the deployment's OAuth authorization server issues for this runtime's App: the ceiling on its tokens' roles.
 * Absent, a token it issued is refused (the token observers). */
const nativeOAuth = new WeakMap<AppAuthRuntime, Readonly<{ roles: readonly string[] }>>();
const oauthOf = (runtime: AppAuthRuntime) => {
  const oauth = nativeOAuth.get(runtime);
  return oauth ? { oauth } : {};
};

/** Native issued-proof age only; not a support grant or a structural provider port. */
export function captureNativeSignInAge(runtime: AppAuthRuntime) {
  captureAppAuthRuntime(runtime);
  return nativeSignInAges.get(runtime) ?? denyTenant();
}
/** The display name the native store held when it issued a proof, for a record
 * others read (a support session's audit), where the email must not appear.
 * Only a proof this runtime issued has one; a copy or a proxy has none. */
export function captureNativeDisplayName(runtime: AppAuthRuntime) {
  captureAppAuthRuntime(runtime);
  return nativeDisplayNames.get(runtime) ?? denyTenant();
}

/** The identity provider a proof's session came through, where a step-up goes back to: absent for any
 * other sign-in. Only a proof this runtime issued has one; a copy or a proxy has none. */
export function captureNativeStepUpProvider(runtime: AppAuthRuntime) {
  captureAppAuthRuntime(runtime);
  return nativeStepUpProviders.get(runtime) ?? denyTenant();
}

/** Genuine native-pool observation only. The composition owner must retire
 * and drain this capability before closing auth; this is not HTTP admission. */
export async function acquirePostgresApiTokenObservation(runtime: AppAuthRuntime, app: AppDef, schema: DatabaseSchema) {
  return acquirePostgresTokenObservation(runtime, app, schema);
}

/** Explicit private command-capable counterpart, as on SQLite: the same native
 * pool, held transactions, retirement and handoff, with the combined read +
 * command catalog instead of the read-only assertion. Not execution admission. */
export async function acquirePostgresApiCommandTokenObservation(
  runtime: AppAuthRuntime,
  app: AppDef,
  schema: DatabaseSchema,
  registry: Parameters<typeof captureApiTokenCommandContext>[2],
  evidence: Parameters<typeof captureApiTokenCommandContext>[3],
) {
  return acquirePostgresTokenObservation(runtime, app, schema, { registry, evidence });
}

/** A tenant App's token observation on the same native pool, held transactions
 * and handoff, scoped by the tenant catalog trusted composition built from the
 * deployment's attested ownership — its reads and, when it exposes them, its
 * commands. Bound tokens only; never the ordinary command evidence. */
export async function acquirePostgresApiTenantTokenObservation(runtime: AppAuthRuntime, app: AppDef, catalog: ApiTenantCatalog) {
  return acquirePostgresTokenObservation(runtime, app, undefined, undefined, catalog);
}

async function acquirePostgresTokenObservation(
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
    const binding = captureAppAuthRuntime(runtime),
      pool = nativeTokenPools.get(runtime);
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
      if (retired || nativeTokenPools.get(runtime) !== pool) return refuse();
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
              { app: observeInput.app, schema: observeInput.schema, storeId, assertCurrent: current, ...oauthOf(runtime) },
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
              { app: observeInput.app, schema: observeInput.schema, storeId, assertCurrent: current, ...oauthOf(runtime) },
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

/** Explicit private capability acquisition, not bearer admission. Only a
 * genuinely registered runtime supplies the native file; App/schema are the
 * trusted host's captured catalog, not proof of a serving deployment epoch. */
export function acquireSqliteApiTokenObservation(runtime: AppAuthRuntime, app: AppDef, schema: DatabaseSchema) {
  return acquireSqliteTokenObservation(runtime, app, schema);
}

/** Explicit private command-capable counterpart. Same genuine runtime/native
 * file proof and opaque observation lifetime; not command execution admission. */
export function acquireSqliteApiCommandTokenObservation(
  runtime: AppAuthRuntime,
  app: AppDef,
  schema: DatabaseSchema,
  registry: Parameters<typeof createSqliteAccountCommandTokenObserver>[2],
  evidence: Parameters<typeof createSqliteAccountCommandTokenObserver>[3],
) {
  return acquireSqliteTokenObservation(runtime, app, schema, { registry, evidence });
}

/** A tenant App's token observation on the native file, scoped by the tenant
 * catalog trusted composition built from the deployment's attested ownership —
 * its reads and, when it exposes them, its commands. Bound tokens only; never
 * the ordinary command evidence. Not membership observation: that is the
 * tenant runtime's, in the business store. */
export function acquireSqliteApiTenantTokenObservation(runtime: AppAuthRuntime, app: AppDef, catalog: ApiTenantCatalog) {
  return acquireSqliteTokenObservation(runtime, app, undefined, undefined, catalog);
}

function acquireSqliteTokenObservation(
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
    const binding = captureAppAuthRuntime(runtime),
      db = nativeTokenFiles.get(runtime);
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
      if (retired || nativeTokenFiles.get(runtime) !== db) return refuse();
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
                  { app: capturedApp, catalog: tenant, storeId, assertCurrent: current, ...oauthOf(runtime) },
                  credential,
                  Date.now(),
                )
              : commandObserver
                ? commandObserver(db, { storeId, assertCurrent: current, ...oauthOf(runtime) }, credential, Date.now())
                : observeSqliteAccountToken(
                    db,
                    { app: capturedApp, schema: capturedSchema!, storeId, assertCurrent: current, ...oauthOf(runtime) },
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

export function captureAppAuthRuntime(runtime: AppAuthRuntime): AppAuthRuntimeBinding {
  try {
    if (!runtime || typeof runtime !== 'object' || isProxy(runtime)) return denyTenant();
    const binding = authRuntimes.get(runtime);
    if (!binding) return denyTenant();
    binding.assertCurrent();
    return binding;
  } catch {
    return denyTenant();
  }
}

/** Injection cannot bypass the store fence: resolve the private native owner,
 * never a caller-provided store label, and compare before mounting a child. */
export async function assertAppAuthStoreSeparation(
  runtime: AppAuthRuntime,
  exclusions: readonly AuthStoreExclusion[],
  connections: readonly PostgresSeparationConnection[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const binding = captureAppAuthRuntime(runtime);
  const source = suiteAuthSources.get(runtime) ?? runtime;
  captureAppAuthRuntime(source);
  const db = nativeTokenFiles.get(source),
    pool = nativeTokenPools.get(source);
  if (db) {
    const file = db
      .prepare('PRAGMA database_list')
      .all()
      .find((row) => row.name === 'main')?.file;
    if (typeof file !== 'string' || !file) return denyTenant();
    for (const exclusion of exclusions) assertAuthStoreSeparation(file, exclusion);
  } else if (pool) await assertPostgresAuthStoreServerSeparation(pool, connections, environment);
  else return denyTenant();
  binding.assertCurrent();
}

type SuiteGrantVia = Readonly<{ provider: string | undefined }> | 'account';
type SuiteGrantRead = Readonly<{ revision: number; roles: readonly string[] }>;

/** A suite's native login, projected through one App's current grant. The
 * child owns only its projection lifetime; the suite closes the native store
 * after all children drain. Never alias native token/account administration:
 * those operations need separately scoped owners. */
export function createSuiteAppAuth(
  source: AppAuthRuntime,
  options: {
    appId: string;
    spec: AppSignIn;
    roles: readonly string[];
    basePath: string;
    suiteBase: string;
    /** The grant a session may use (`{ provider }`: the identity provider that opened it, if any), or the account's own ('account'). */
    grant?: (subjectId: string, appId: string, via: SuiteGrantVia) => SuiteGrantRead;
    /** The same read from a store that answers asynchronously (a suite's grants on PostgreSQL), given instead of `grant`. */
    grantCurrent?: (subjectId: string, appId: string, via: SuiteGrantVia) => Promise<SuiteGrantRead>;
  },
): AppAuthRuntime {
  const native = captureAppAuthRuntime(source);
  const given = tenantOptions(options, ['appId', 'spec', 'roles', 'basePath', 'suiteBase', 'grant', 'grantCurrent']);
  const { appId, spec, roles, basePath, suiteBase } = captureTenantData({
    ...given,
    grant: undefined,
    grantCurrent: undefined,
  }) as unknown as typeof options;
  const grant = given.grant as typeof options.grant,
    grantCurrent = given.grantCurrent as typeof options.grantCurrent;
  if ((grant === undefined) === (grantCurrent === undefined) || typeof (grant ?? grantCurrent) !== 'function') return denyTenant();
  /* A grant store read synchronously (the SQLite ledger) keeps every fence a
     final synchronous check can make: each check below re-reads the grant. One
     read asynchronously (PostgreSQL) cannot be read there, so the projection is
     not synchronous either and fences as a PostgreSQL session does: the owner
     observes it (`observeSession`, which re-reads the grant) at its last await
     before COMMIT, and the synchronous checks hold only what needs no read. */
  const synchronous = grant !== undefined;
  tenantIdentifier(appId, 64);
  const allowed = new Set(roles);
  let closed = false;
  const current = () => {
    if (closed) return denyTenant();
    native.assertCurrent();
  };
  /* Every session's authority is read with the provider that opened it, so a
     grant derived from claims holds only for that provider's sessions
     (suiteGrantStore.ts readForSession); no sign-in path reaches a role around it. */
  const sessionProvider = captureNativeStepUpProvider(source);
  const checked = (value: SuiteGrantRead) => {
    if (
      !Number.isSafeInteger(value.revision) ||
      value.revision < 0 ||
      !Array.isArray(value.roles) ||
      new Set(value.roles).size !== value.roles.length ||
      value.roles.some((role) => typeof role !== 'string' || !allowed.has(role))
    )
      return denyTenant();
    return value;
  };
  const readGrant = (id: string, via: SuiteGrantVia) => {
    current();
    if (!grant) return denyTenant();
    return checked(captureTenantData(grant(id, appId, via)));
  };
  const readGrantCurrent = async (id: string, via: SuiteGrantVia) => {
    current();
    if (!grantCurrent) return denyTenant();
    const value = await grantCurrent(id, appId, via);
    current();
    return checked(captureTenantData(value));
  };
  const proofs = new WeakMap<
    VerifiedSessionInstance,
    { native: VerifiedSessionInstance; revision: number; provider: string | undefined }
  >();
  const keptOf = (proof: VerifiedSessionInstance) => {
    current();
    return proofs.get(proof) ?? denyTenant();
  };
  const unchanged = (proof: VerifiedSessionInstance, kept: { revision: number }, value: SuiteGrantRead) => {
    if (!value.roles.length || value.revision !== kept.revision || value.roles.join(',') !== proof.identity.role) return denyTenant();
  };
  /** The native proof behind one this projection issued, its grant re-read where that can be done synchronously; with an
   * asynchronous grant store only that the proof is ours and unexpired, as a PostgreSQL session's synchronous check. */
  const original = (proof: VerifiedSessionInstance) => {
    const kept = keptOf(proof);
    if (synchronous) unchanged(proof, kept, readGrant(kept.native.identity.id, { provider: kept.provider }));
    else if (!(proof.expiresAt > Date.now())) return denyTenant();
    return kept.native;
  };
  /** `original` with the grant re-read from an asynchronous store: the fence at each await an asynchronous owner observes. */
  const originalCurrent = async (proof: VerifiedSessionInstance) => {
    const kept = keptOf(proof);
    unchanged(proof, kept, await readGrantCurrent(kept.native.identity.id, { provider: kept.provider }));
    return kept.native;
  };
  const instance = async (req: IncomingMessage): Promise<VerifiedSessionInstance | null> => {
    current();
    const proof = await native.sessionInstance(req);
    current();
    if (!proof) return null;
    await native.observeSession(proof);
    current();
    const provider = sessionProvider.provider(proof);
    const value = synchronous ? readGrant(proof.identity.id, { provider }) : await readGrantCurrent(proof.identity.id, { provider });
    if (!value.roles.length) return null;
    native.assertSessionCurrent(proof);
    const projected = captureTenantData({
      identity: { ...proof.identity, role: value.roles.join(',') },
      sessionId: proof.sessionId,
      expiresAt: proof.expiresAt,
    });
    proofs.set(projected, { native: proof, revision: value.revision, provider });
    return projected;
  };
  const runtime: AppAuthRuntime = {
    spec,
    store: source.store,
    accountProfile: source.accountProfile,
    passwordReset: source.passwordReset,
    ...(source.labels ? { labels: source.labels } : {}),
    suite: Object.freeze({ basePath: suiteBase }),
    close: () => {
      closed = true;
    },
    sessionInstance: instance,
    session: async (req) => {
      const proof = await instance(req);
      if (!proof) return null;
      const identity = await source.session(req);
      current();
      if (synchronous) {
        await native.observeSession(original(proof));
        native.assertSessionCurrent(original(proof));
      } else {
        await native.observeSession(await originalCurrent(proof));
        native.assertSessionCurrent(await originalCurrent(proof));
      }
      if (!identity || identity.id !== proof.identity.id) return denyTenant();
      return { ...identity, role: proof.identity.role };
    },
    handler: async (req, res) => {
      current();
      const arrived = req.url;
      const url = new URL(arrived ?? '/', 'http://localhost');
      const prefix = `${basePath}/api/auth`;
      const route = url.pathname.slice(prefix.length);
      // A suite App may manage its own profile, never the native admin plugin
      // or automatic provider linking in the central identity store.
      const routes = [
        '/sign-in/email',
        '/sign-up/email',
        '/sign-out',
        '/profile',
        '/update-user',
        '/change-password',
        '/request-password-reset',
        '/reset-password',
        '/verify-email',
        '/send-verification-email',
      ];
      /* An identity provider's sign-in starts from the App's door and returns to
         the native store's own callback, both the single App's code: state,
         nonce and PKCE, and linking only on a verified email (identityRoles.ts). */
      const own = basePath === suiteBase;
      const oidc = native.spec.providers.some((provider) => provider.startsWith('oidc:'));
      const saml = native.spec.providers.some((provider) => provider.startsWith('saml:'));
      /* Which tenant's provider an address signs in through (homeRealm): asked at the App's door before any session. */
      const tenantRealm = native.spec.providers.some((provider) => provider === TENANT_OIDC || provider === TENANT_SAML);
      const federated =
        (tenantRealm && route === '/work-email') ||
        (oidc &&
          (route === '/sign-in/social' ||
            (own && (/^\/callback\/[A-Za-z0-9_-]+$/.test(route) || /^\/backchannel-logout\/[a-z][a-z0-9-]{0,39}$/.test(route))))) ||
        /* A SAML provider's sign-in starts from the App's door; its responses
           and the service provider's metadata are the native store's own. */
        (saml &&
          (route === '/sign-in/sso' ||
            (own && (/^\/sso\/saml2\/sp\/acs\/[a-z][a-z0-9-]{0,39}$/.test(route) || route === '/sso/saml2/sp/metadata'))));
      if (!url.pathname.startsWith(`${prefix}/`) || (!routes.includes(route) && !federated)) {
        res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'No suite authentication route.' }));
        return;
      }
      req.url = `${suiteBase}/api/auth${route}${url.search}`;
      try {
        await native.handler(req, res);
      } finally {
        req.url = arrived;
      }
    },
  };
  const eligible = (id: string) => readGrant(id, 'account').roles.length > 0;
  const eligibleCurrent = async (id: string) =>
    (synchronous ? readGrant(id, 'account') : await readGrantCurrent(id, 'account')).roles.length > 0;
  const binding = Object.freeze<AppAuthRuntimeBinding>({
    appId,
    spec,
    handler: runtime.handler,
    sessionInstance: instance,
    close: runtime.close,
    assertCurrent: current,
    synchronous: native.synchronous && synchronous,
    assertSessionCurrent: (proof) => {
      native.assertSessionCurrent(original(proof));
      original(proof);
    },
    observeSession: async (proof) => {
      if (synchronous) {
        await native.observeSession(original(proof));
        original(proof);
      } else {
        await native.observeSession(await originalCurrent(proof));
        await originalCurrent(proof);
      }
    },
    // A synchronous lookup reads the grant; an asynchronous grant store refuses it, as a PostgreSQL sign-in store does.
    lookupAccount: (id) => (eligible(id) ? native.lookupAccount(id) : null),
    lookupEligibleAccount: (id) => (eligible(id) ? native.lookupEligibleAccount(id) : null),
    lookupAccountCurrent: async (id) => {
      const found = await native.lookupAccountCurrent(id);
      return (synchronous ? eligible(id) : await eligibleCurrent(id)) ? found : null;
    },
    lookupEligibleAccountCurrent: async (id) => {
      const found = await native.lookupEligibleAccountCurrent(id);
      return (synchronous ? eligible(id) : await eligibleCurrent(id)) ? found : null;
    },
    lookupEligibleAccountRolesCurrent: async (id) => {
      const found = await native.lookupEligibleAccountCurrent(id);
      const value = synchronous ? readGrant(id, 'account') : await readGrantCurrent(id, 'account');
      return found && value.roles.length ? Object.freeze({ accountId: id, roles: value.roles }) : null;
    },
  });
  authRuntimes.set(runtime, binding);
  suiteAuthSources.set(runtime, source);
  // Tenant support consumes native observations with the App's issued proof.
  // Map back by object identity and fence its grant on both sides of awaits.
  const age = captureNativeSignInAge(source);
  const assertAge = (proof: VerifiedSessionInstance, at: number, maximumAgeMs: number) => {
    age.assertAge(original(proof), at, maximumAgeMs);
    original(proof);
  };
  nativeSignInAges.set(
    runtime,
    // Sign-in age is synchronous only where both the native store and the grant can be read synchronously.
    age.synchronous && synchronous
      ? Object.freeze({
          synchronous: true as const,
          assertAge,
          observeRecent(proof: VerifiedSessionInstance, at: number, maximumAgeMs: number) {
            age.observeRecent(original(proof), at, maximumAgeMs);
            original(proof);
          },
        })
      : Object.freeze({
          synchronous: false as const,
          assertAge,
          async observeRecent(proof: VerifiedSessionInstance, at: number, maximumAgeMs: number) {
            if (synchronous) {
              await age.observeRecent(original(proof), at, maximumAgeMs);
              original(proof);
            } else {
              await age.observeRecent(await originalCurrent(proof), at, maximumAgeMs);
              await originalCurrent(proof);
            }
          },
        }),
  );
  const display = captureNativeDisplayName(source);
  nativeDisplayNames.set(runtime, Object.freeze({ displayName: (proof: VerifiedSessionInstance) => display.displayName(original(proof)) }));
  nativeStepUpProviders.set(
    runtime,
    Object.freeze({ provider: (proof: VerifiedSessionInstance) => sessionProvider.provider(original(proof)) }),
  );
  registerSuiteAccountObservations(runtime, source, synchronous ? eligible : eligibleCurrent, current);
  return Object.freeze(runtime);
}

function registerAppAuthRuntime(
  runtime: AppAuthRuntime,
  appId: string,
  closed: () => boolean,
  observer: StoreObserver,
  signInInstants: WeakMap<VerifiedSessionInstance, number>,
  displayNames: WeakMap<VerifiedSessionInstance, string>,
  stepUps: { instants: WeakMap<VerifiedSessionInstance, number | null>; providers: WeakMap<VerifiedSessionInstance, string> },
): void {
  const descriptors = Object.getOwnPropertyDescriptors(runtime);
  const prototype = Object.getPrototypeOf(runtime);
  const { handler, sessionInstance, close, spec, embed } = runtime;
  const proofs = new WeakSet<VerifiedSessionInstance>();
  if (!sessionInstance) return denyTenant();
  const assertCurrent = () => {
    try {
      if (closed() || Object.getPrototypeOf(runtime) !== prototype) return denyTenant();
      for (const [key, captured] of Object.entries(descriptors)) {
        const current = Object.getOwnPropertyDescriptor(runtime, key);
        if (
          !current ||
          !('value' in current) ||
          current.value !== captured.value ||
          current.enumerable !== captured.enumerable ||
          current.configurable !== captured.configurable ||
          current.writable !== captured.writable
        )
          return denyTenant();
      }
    } catch {
      return denyTenant();
    }
  };
  const binding: AppAuthRuntimeBinding = {
    appId,
    spec,
    assertCurrent,
    close,
    ...(embed ? { embed } : {}),
    handler: async (req, res) => {
      assertCurrent();
      await handler(req, res);
      assertCurrent();
    },
    sessionInstance: async (req) => {
      assertCurrent();
      const result = await sessionInstance(req);
      assertCurrent();
      if (result) proofs.add(result);
      return result;
    },
    assertSessionCurrent: (proof) => {
      try {
        assertCurrent();
        if (!proofs.has(proof)) return denyTenant();
        if (observer.synchronous) observer.checkSession(proof);
        // Nothing here can read a PostgreSQL store; `observeSession` does.
        else if (!(proof.expiresAt > Date.now())) return denyTenant();
        assertCurrent();
      } catch {
        return denyTenant();
      }
    },
    lookupAccount: (accountId) => {
      try {
        assertCurrent();
        tenantIdentifier(accountId, 1024);
        if (!observer.synchronous) return denyTenant();
        const result = observer.lookupAccount(accountId);
        assertCurrent();
        return result === null ? null : captureTenantData({ accountId: result.accountId });
      } catch {
        return denyTenant();
      }
    },
    lookupEligibleAccount: (accountId) => {
      try {
        assertCurrent();
        tenantIdentifier(accountId, 1024);
        if (!observer.synchronous) return denyTenant();
        const result = captureTenantData(observer.lookupEligibleAccount(accountId));
        if (result !== null && result.accountId !== accountId) return denyTenant();
        assertCurrent();
        return result;
      } catch {
        return denyTenant();
      }
    },
    synchronous: observer.synchronous,
    observeSession: async (proof) => {
      try {
        assertCurrent();
        if (!proofs.has(proof)) return denyTenant();
        if (observer.synchronous) observer.checkSession(proof);
        else await observer.checkSession(proof);
        assertCurrent();
      } catch {
        return denyTenant();
      }
    },
    lookupAccountCurrent: async (accountId) => {
      try {
        assertCurrent();
        tenantIdentifier(accountId, 1024);
        const result = observer.synchronous ? observer.lookupAccount(accountId) : await observer.lookupAccount(accountId);
        assertCurrent();
        return result === null ? null : captureTenantData({ accountId: result.accountId });
      } catch {
        return denyTenant();
      }
    },
    lookupEligibleAccountCurrent: async (accountId) => {
      try {
        assertCurrent();
        tenantIdentifier(accountId, 1024);
        const result = captureTenantData(
          observer.synchronous ? observer.lookupEligibleAccount(accountId) : await observer.lookupEligibleAccount(accountId),
        );
        if (result !== null && result.accountId !== accountId) return denyTenant();
        assertCurrent();
        return result;
      } catch {
        return denyTenant();
      }
    },
    lookupEligibleAccountRolesCurrent: async (accountId) => {
      try {
        assertCurrent();
        tenantIdentifier(accountId, 1024);
        if (/\p{Cs}/u.test(accountId)) return denyTenant();
        const result = captureTenantData(
          observer.synchronous ? observer.lookupEligibleAccountRoles(accountId) : await observer.lookupEligibleAccountRoles(accountId),
        );
        if (result !== null && result.accountId !== accountId) return denyTenant();
        assertCurrent();
        return result;
      } catch {
        return denyTenant();
      }
    },
  };
  // Omit these observations from enumerable binding snapshots. Genuine runtime
  // capture still relies on the WeakMap; no runtime/HTTP method is installed.
  for (const key of [
    'lookupEligibleAccount',
    'synchronous',
    'observeSession',
    'lookupAccountCurrent',
    'lookupEligibleAccountCurrent',
    'lookupEligibleAccountRolesCurrent',
  ]) {
    Object.defineProperty(binding, key, { enumerable: false });
  }
  authRuntimes.set(runtime, Object.freeze(binding));
  nativeSignInAges.set(runtime, createNativeSignInAge(proofs, signInInstants, assertCurrent, observer, stepUps.instants));
  nativeStepUpProviders.set(
    runtime,
    Object.freeze({
      provider(proof: VerifiedSessionInstance): string | undefined {
        assertCurrent();
        if (!proofs.has(proof)) return denyTenant();
        return stepUps.providers.get(proof);
      },
    }),
  );
  nativeDisplayNames.set(
    runtime,
    Object.freeze({
      displayName(proof: VerifiedSessionInstance): string {
        assertCurrent();
        // Identity before field access: a copied or proxied proof has no name.
        if (!proofs.has(proof)) return denyTenant();
        return displayNames.get(proof) ?? denyTenant();
      },
    }),
  );
}

/**
 * Whether a write under `/api/auth` holds its own proof, so the door does not
 * ask its Origin (an App's gate, http/gate.ts, and a tenant's native host,
 * tenantAuthenticatedHttp.ts, ask the rest alike). Each is posted from
 * somewhere that is not the App's page: an identity provider's callback is a
 * cross-site form POST and carries its state; a SAML response is a
 * provider's form POST and a logout token is posted server to server, each
 * signed (samlSignIn.ts, backchannelLogout.ts); an OAuth client registers,
 * exchanges and revokes from its own process with a code's verifier or a
 * refresh token, and is answered no cookie (oauthServer.ts); a host's
 * exchange and sign-out hold their own origin line, to the origins its
 * issuers list (embed/exchange.ts).
 */
export function authHoldsOwnProof(path: string, embedded: boolean): boolean {
  return (
    path.startsWith('/api/auth/callback/') ||
    (embedded && (path === '/api/auth/embed/exchange' || path === '/api/auth/embed/sign-out')) ||
    path.startsWith('/api/auth/sso/saml2/sp/acs/') ||
    path.startsWith('/api/auth/backchannel-logout/') ||
    path === '/api/auth/oauth/register' ||
    path === '/api/auth/oauth/token' ||
    path === '/api/auth/oauth/revoke'
  );
}

/** What the client needs to draw the sign-in screen. Never the store, the roles, an identity provider's
    configuration or which domains may sign up: a provider's button words, and whether accounts are made at a
    first sign-in through one (`provider`). A tenant's own provider is found by an email's domain, never listed. */
export function signInInfo(runtime: AppAuthRuntime, appName: string): Record<string, unknown> {
  const signUp = runtime.spec.signUp;
  return {
    app: appName,
    providers: runtime.spec.providers,
    signUp: typeof signUp === 'string' ? signUp : 'provider',
    ...(runtime.suite ? { suite: runtime.suite } : {}),
    ...(runtime.labels && Object.keys(runtime.labels).length ? { labels: runtime.labels } : {}),
    ...(runtime.passwordReset ? { reset: runtime.passwordReset } : {}),
  };
}

/**
 * Where the session store lives when the manifest does not say: the config
 * directory mistri already keeps, named for the app.
 */
function defaultStore(appId: string, env: NodeJS.ProcessEnv): string {
  const locations = configLocations(undefined, env);
  const home = dirname(locations[locations.length - 1]);
  return join(home, 'auth', `${appId}.db`);
}

/** Resolve without opening: deployment preflight must be able to keep the
 * native session store separate from an existing application database.
 * A `postgres://` URL is returned as written, after `${NAME}` expansion so
 * the manifest can name the password (or the whole URL) by reference the
 * way a connection does. Only the braced form: a bare `$` in a store URL is
 * literal, since a password may contain one. A file path is never expanded. */
export function appAuthStore(loaded: LoadedApp, env: NodeJS.ProcessEnv = process.env): string {
  const store = loaded.app.auth?.store;
  if (!store) return defaultStore(loaded.app.id, env);
  const named = /^\$\{|^postgres(ql)?:\/\//i.test(store) ? expandEnvReferences(store, env) : store;
  if (isPostgresAuthStore(named)) return named;
  return isAbsolute(named) ? named : resolve(loaded.dir ?? dirname(loaded.path), named);
}

export async function createAppAuth(
  loaded: LoadedApp,
  opts: {
    baseURL: string;
    trustedOrigins: string[];
    excludeStore?: AuthStoreExclusion;
    excludeStores?: readonly AuthStoreExclusion[];
    /** This App's private deployment environment; captured before startup awaits. */
    environment?: NodeJS.ProcessEnv;
    /** Every configured connection; a PostgreSQL store naming or reaching one of their databases is refused. */
    excludeConnections?: readonly PostgresSeparationConnection[];
    /** `false`: a process that serves no sign-in (App MCP). It never holds the
     * session-signing secret — Better Auth gets a random per-process one, since
     * nothing it signs outlives the process — configures no OAuth provider,
     * bootstraps no admin, and every session entry point refuses. The native
     * store and its token observation are exactly the serving ones. */
    sessions?: false;
    /** The server's email service: verification and reset links go by email. */
    mail?: EmailTransport;
    /** The identity providers the config file names (kinds "oidc" and "saml"), as written: secrets still references. */
    identity?: readonly FederatedProviderConfig[];
    /** Trusted server code told of each sign-in through an identity provider, before its session is made:
     * a suite derives its Apps' grants from the claims here (suiteIdentity.ts). A throw refuses the sign-in. */
    federatedSignIn?: FederatedSignIn;
    /** The hosts the config file names (kind "embed"), as written: secrets still references. */
    embed?: readonly EmbedIssuerConfig[];
    /** `--trust-proxy`: whose X-Forwarded-For names the client a host's exchange is budgeted by. */
    trustedProxies?: readonly ProxyRange[];
    /** The address the server listens on (`--host`). Absent, the host of `baseURL`: what a test's server is. */
    listenHost?: string;
    /** The deployment's OAuth authorization server (kind "oauth"), as written, and the App's home as the
     * browser shows it, its consent page under it. Served only when it names this App and sign-in is. */
    oauth?: Readonly<{ config: OAuthServerConfig; home: string }>;
    /** The SCIM directories the config file names (kind "scim"), as written: tokens still references. */
    scim?: readonly ScimDirectoryConfig[];
  },
): Promise<AppAuthRuntime> {
  // Capture before any import/migration wait: metadata and native configuration
  // must describe the same App, paths and origins even if the caller mutates it.
  // The loader now keeps executable commands beside its data. Authentication
  // needs the manifest and paths, never the handlers; inspect descriptors
  // before separating them so an accessor cannot run during capture.
  const metadata = tenantOptions(loaded, LOADED_APP_KEYS);
  /* A page's loaders and the App's human checks are code beside the commands: authentication needs none of them. */
  loaded = captureTenantData({ ...metadata, commands: undefined, loaders: undefined, challenges: undefined }) as unknown as LoadedApp;
  /* The transport is trusted server code, not evidence: held apart from what
     is captured. Taken off the options without invoking an accessor, as
     captureTenantData reads the rest; spreading the options first ran a
     hostile getter before anything refused it. */
  const given = tenantOptions(opts, [
    'baseURL',
    'trustedOrigins',
    'excludeStore',
    'excludeStores',
    'excludeConnections',
    'sessions',
    'mail',
    'identity',
    'environment',
    'federatedSignIn',
    'embed',
    'trustedProxies',
    'listenHost',
    'oauth',
    'scim',
  ]);
  const transport = given.mail as EmailTransport | undefined;
  const federatedSignIn = given.federatedSignIn as FederatedSignIn | undefined;
  if (federatedSignIn !== undefined && typeof federatedSignIn !== 'function') return denyTenant();
  opts = captureTenantData({ ...given, mail: undefined, federatedSignIn: undefined }) as typeof opts;
  tenantRecord(loaded);
  tenantRecord(loaded.app);
  tenantRecord(opts, [
    'baseURL',
    'trustedOrigins',
    'excludeStore',
    'excludeStores',
    'excludeConnections',
    'sessions',
    'mail',
    'identity',
    'environment',
    'federatedSignIn',
    'embed',
    'trustedProxies',
    'listenHost',
    'oauth',
    'scim',
  ]);
  if (opts.sessions !== undefined && opts.sessions !== false) return denyTenant();
  const sessions = opts.sessions !== false;
  const environment = opts.environment ?? { ...process.env };
  tenantRecord(environment);
  if (Object.values(environment).some((value) => value !== undefined && typeof value !== 'string')) return denyTenant();
  /* The sign-in settings only: the role grants are the App's, re-read per
     request, and a reload may change them without a restart. */
  const spec = captureTenantData(signInOf(loaded.app.auth));
  tenantRecord(spec, ['providers', 'signUp', 'store', 'defaultRole']);
  tenantIdentifier(loaded.app.id, 1024);
  tenantIdentifier(loaded.app.name, 1024);
  tenantIdentifier(loaded.path, 4096);
  if (loaded.dir !== undefined) tenantIdentifier(loaded.dir, 4096);
  tenantIdentifier(opts.baseURL, 4096);
  if (!Array.isArray(opts.trustedOrigins) || opts.trustedOrigins.length > 256) return denyTenant();
  for (const origin of opts.trustedOrigins) tenantIdentifier(origin, 4096);
  if (
    !Array.isArray(spec.providers) ||
    !spec.providers.length ||
    spec.providers.some((provider) => !isAuthProvider(provider)) ||
    !signUpShape(spec)
  )
    return denyTenant();
  tenantIdentifier(spec.defaultRole, 1024);
  if (spec.store !== undefined) tenantIdentifier(spec.store, 4096);
  const at = loaded.path;
  const store = appAuthStore(loaded, environment);
  const postgres = isPostgresAuthStore(store);
  if (opts.excludeConnections !== undefined && !Array.isArray(opts.excludeConnections)) return denyTenant();
  if (opts.excludeStores !== undefined && !Array.isArray(opts.excludeStores)) return denyTenant();
  const separate = () => {
    /* The file rule protects a captured SQLite business file and its sidecars
       from a file store. A postgres:// store cannot alias a file; it is kept
       apart from every configured connection below instead. */
    if (opts.excludeStore !== undefined && !postgres) assertAuthStoreSeparation(store, opts.excludeStore);
    if (!postgres) for (const exclusion of opts.excludeStores ?? []) assertAuthStoreSeparation(store, exclusion);
    if (postgres && opts.excludeConnections !== undefined) assertPostgresAuthStoreSeparation(store, opts.excludeConnections, environment);
  };
  separate();

  /* Imported through a variable so the type checker does not demand the
     package be installed to compile this file, and so a missing install is
     one sentence naming the command. */
  const load = async (name: string): Promise<Record<string, unknown>> => {
    try {
      return (await import(name)) as Record<string, unknown>;
    } catch {
      throw new Error(`${at}: "auth" needs the better-auth package. Install it with: npm install better-auth`);
    }
  };
  const { betterAuth } = (await load('better-auth')) as { betterAuth: (o: Record<string, unknown>) => AuthLike };
  const { toNodeHandler, fromNodeHeaders } = (await load('better-auth/node')) as {
    toNodeHandler: (a: AuthLike) => (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    fromNodeHeaders: (h: IncomingMessage['headers']) => Headers;
  };
  const { admin } = (await load('better-auth/plugins')) as { admin: (o: Record<string, unknown>) => unknown };
  const { createAuthMiddleware } = (await load('better-auth/api')) as unknown as {
    createAuthMiddleware: Parameters<typeof signInLockoutPlugin>[0]['createAuthMiddleware'];
  };
  const { getMigrations } = (await load('better-auth/db/migration')) as {
    getMigrations: (o: Record<string, unknown>) => Promise<{ runMigrations: () => Promise<void> }>;
  };
  /* Better Auth's own transaction context, which its adapter calls read: the
     account-administration trail joins a change's transaction through it. The
     context lives in module state, so it must be the very copy better-auth
     loaded: resolved from better-auth's own place, never ours, a second copy
     (another version hoisted beside it) would put the trail outside the
     change's transaction without a word. */
  const { transactions, jose, APIError } = await (async () => {
    try {
      const fromBetterAuth = createRequire(import.meta.resolve('better-auth'));
      const beside = async (name: string) => (await import(pathToFileURL(fromBetterAuth.resolve(name)).href)) as Record<string, unknown>;
      return {
        transactions: (await beside('@better-auth/core/context')) as unknown as AuditTransactions & {
          tryGetCurrentAuthEndpointContext(): object | undefined;
        },
        /* The ID token verifier (identityProviders.ts): jose, the copy
           Better Auth itself verifies with, and its error class, so a hook's
           refusal is one Better Auth recognises and sends back with a code. */
        jose: (await beside('jose')) as unknown as Jose,
        APIError: (await beside('@better-auth/core/error')).APIError as new (
          status: string,
          body: { code: string; message: string },
        ) => Error,
      };
    } catch {
      throw new Error(`${at}: "auth" needs the better-auth package. Install it with: npm install better-auth`);
    }
  })();

  const secret = sessions
    ? (environment.BETTER_AUTH_SECRET ?? '').trim()
    : Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  if (secret.length < 32) {
    throw new Error(
      `${at}: "auth" needs BETTER_AUTH_SECRET in the environment — at least 32 characters, ` +
        'generated once and kept: `openssl rand -base64 32`. Sessions are signed with it.',
    );
  }

  const mail = transport ? { send: transport.send.bind(transport), app: loaded.app.name } : undefined;
  const providers = sessions ? appAuthProviders(spec, environment, at, mail) : {};
  /* Identity providers: each `oidc('<name>')` or `saml('<name>')` the App
     names is the config file's entry of that name, and `oidc.tenants()` and
     `saml.tenants()` are every entry of that kind a tenant owns. A process
     that signs no one in needs none of them. */
  const federation = sessions
    ? await (async () => {
        const configs = captureTenantData([...(opts.identity ?? [])]);
        const problems = identityProblems(loaded.app, configs);
        if (problems.length) throw new Error(`${at}: ${problems[0]}`);
        const named = namedProviders(spec.providers).map((name) => configs.find((config) => config.name === name)!);
        const tenants = configs.filter(
          (config) => config.tenant !== undefined && spec.providers.includes(config.kind === 'saml' ? TENANT_SAML : TENANT_OIDC),
        );
        const used = new Map([...named, ...tenants].map((config) => [config.name, config]));
        if (!used.size) return undefined;
        const evidence = new WeakMap<object, SignInEvidence>();
        let auditStore: ReturnType<typeof createAccountAuditStore> | undefined;
        const mapping = roleClaimsOf(loaded.app.auth?.roles);
        const { hooks, stepUp } = identityHooks({
          signUp: spec.signUp,
          roles: new Set(Object.keys(loaded.app.auth?.roles ?? {})),
          mapping,
          providers: used,
          evidence,
          APIError,
          appName: loaded.app.name,
          audit: () => auditStore ?? denyTenant(),
          ...(federatedSignIn ? { federated: federatedSignIn } : {}),
        });
        const current = () => transactions.tryGetCurrentAuthEndpointContext() ?? undefined;
        const built = [...used.values()]
          .filter((config): config is IdentityProviderConfig => config.kind === 'oidc')
          .map((config) =>
            oidcProvider(config, {
              jose,
              where: at,
              evidence,
              environment,
              current,
              signUp: (token) => !signUpShut(spec.signUp, token),
            }),
          );
        const samls = [...used.values()].filter((config): config is SamlProviderConfig => config.kind === 'saml');
        /* Loaded only here: no other process pays for the SAML stack (samlSignIn.ts). */
        const saml = samls.length
          ? await (
              await import('./samlSignIn.js')
            ).samlSignInPlugin({ configs: samls, baseURL: opts.baseURL, evidence, current, APIError, where: at, load })
          : undefined;
        /* What each provider's administrator registers: printed once, at startup. */
        for (const config of used.values()) {
          if (config.kind === 'saml') {
            const sp = samlServiceProvider(opts.baseURL, config.name);
            console.log(`mistri: SAML provider "${config.name}" for "${loaded.app.name}": entity ID ${sp.entityId}, ACS ${sp.acs}`);
          } else if (config.backchannelLogout) {
            console.log(
              `mistri: identity provider "${config.name}" for "${loaded.app.name}": back-channel logout ${backchannelLogoutUrl(opts.baseURL, config.name)}`,
            );
          }
        }
        return {
          hooks,
          stepUp,
          tenants,
          saml,
          /* The providers that may end sessions here (backchannelLogout.ts), by name. */
          logout: new Map(
            built
              .filter((provider) => (used.get(provider.id) as IdentityProviderConfig).backchannelLogout)
              .map((provider) => [provider.id, provider]),
          ),
          /* What a session's roles are (identityRoles.ts sessionRoles): the ones the claims gave only through the provider's own session. */
          rolesFor: (role: string | null | undefined, opener: string | undefined) =>
            sessionRoles(role, mapping, opener, (name) => used.get(name)?.tenant === undefined),
          bindAudit: (store: ReturnType<typeof createAccountAuditStore>) => {
            auditStore = store;
          },
          plugin: {
            id: 'mistri-identity',
            init: (ctx: { socialProviders: unknown[] }) => ({ context: { socialProviders: [...built, ...ctx.socialProviders] } }),
          },
          labels: Object.fromEntries(named.map((config) => [`${config.kind}:${config.name}`, config.label ?? config.name])),
        };
      })()
    : undefined;
  const passwordReset = sessions && passwordResetDelivery(spec, environment, at, Boolean(mail)) !== undefined;
  /* Hosts that sign their own people in here (embed/): each issuer the config
     file names for this App, its key read now so a missing secret refuses
     startup. A process that signs no one in trusts none. */
  const embedded = (() => {
    if (!sessions || !opts.embed?.length) return [];
    const configs = issuersFor(loaded.app.id, captureTenantData([...opts.embed]));
    const problems = embedProblems(loaded.app, configs);
    if (problems.length) throw new Error(`${at}: ${problems[0]}`);
    return embedIssuers(configs, jose, environment, at);
  })();
  const embedPlugin = embedded.length ? await embedSignInPlugin(load) : undefined;
  /* The authorization server that issues for this App (api/oauthConfig.ts):
     judged now, before the store opens, as an identity provider is. Its
     consent is a session's, so a process that signs no one in serves none. */
  const oauth = (() => {
    if (!sessions || !opts.oauth || !opts.oauth.config.apps.includes(loaded.app.id)) return undefined;
    const { config, home } = opts.oauth;
    const problems = oauthProblems(loaded.app, [config]);
    if (problems.length) throw new Error(`${at}: ${problems[0]}`);
    const base = new URL(opts.baseURL);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(base.hostname))) {
      throw new Error(
        `${at}: the OAuth authorization server "${config.name}" is reached over https: its codes and tokens cross the network. ` +
          `Serve it behind TLS and set MISTRI_PUBLIC_URL to its https address (http only on this machine).`,
      );
    }
    // The App's home as the browser has it: '' at the root, else a path with no trailing slash.
    if (typeof home !== 'string' || (home !== '' && !/^\/[^\s?#]*[^/\s?#]$/.test(home)) || home.length > 4096) {
      throw new Error(`${at}: the OAuth authorization server's App home is not a path.`);
    }
    return { config, home, ceiling: Object.freeze(oauthRoleCeiling(loaded.app, config)) };
  })();

  /* The directories that provision this App (scimConfig.ts), judged before the store opens: none where no one signs in. */
  const directories = sessions ? scimEntriesFor(loaded.app, opts.scim ?? [], opts.identity ?? [], at) : [];
  separate();
  const handle: AuthStoreHandle = postgres ? await openPostgresAuthStore(store) : openSqliteAuthStore(store, separate);
  separate();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    handle.close();
  };
  try {
    /* The URL comparison above cannot see aliases; the servers can. Each
       PostgreSQL connection is asked who it is before sign-in is accepted. */
    if (postgres && opts.excludeConnections !== undefined) {
      await assertPostgresAuthStoreServerSeparation(handle.database as PgQuery, opts.excludeConnections, environment);
    }
    /* `baseURL` is where the server is served, a reverse proxy's path
       included (shared/mount.ts): its routes and the links it mails are
       under that path, and its cookies are named for this App and scoped to
       it, so a second App on the same host — the main App at `/` beside
       `/billing`, or another container behind the proxy — never reads this
       one's session, nor overwrites it. */
    const served = new URL(opts.baseURL);
    const under = served.pathname.replace(/\/+$/, '');
    // Better Auth marks its cookies Secure from this address alone: said once, never refused, since a TLS proxy is the usual front.
    const insecure = sessions ? insecureCookieWarning(opts.baseURL, opts.listenHost ?? served.hostname) : undefined;
    if (insecure) warnOnce(`insecure-cookies ${served.origin}`, insecure);
    /* Where a directory provisions this App (scimDirectory.ts): its plugin, its routes, and its tenants' members. */
    const current = () => transactions.tryGetCurrentAuthEndpointContext() ?? undefined;
    const scim = { environment, baseURL: opts.baseURL, APIError, store: handle, current };
    const provisioning = directories.length ? await scimProvisioning(directories, loaded, scim, () => auth.handler) : undefined;
    const failures = authFailureLog(loaded.app.id, under);
    const given = {
      appName: loaded.app.name,
      database: handle.database,
      baseURL: `${served.origin}${under}/api/auth`,
      basePath: '/api/auth',
      advanced: {
        cookiePrefix: `mistri-${loaded.app.id.replace(/[^A-Za-z0-9_-]/g, '-')}`,
        defaultCookieAttributes: { path: under || '/' },
        /* The client its budgets count and its sessions record is the one
           this server names (trust.ts forwardedClient), written by the handler
           below over whatever the request carried. Better Auth's own reading
           believed a client's single X-Forwarded-For — a new address per
           guess was a new budget — and without one put everyone in one. */
        ipAddress: { ipAddressHeaders: [CLIENT_ADDRESS_HEADER] },
      },
      secret,
      trustedOrigins: [...opts.trustedOrigins],
      ...providers,
      plugins: [
        admin({ defaultRole: spec.defaultRole }),
        accountAuditPlugin(),
        signInLockoutPlugin({ appId: loaded.app.id, createAuthMiddleware, APIError }),
        // Always: the store's layout is the mistri version's, never the configuration's (identityStore.ts).
        identityStorePlugin(),
        ...(federation ? [federation.plugin] : []),
        ...(federation?.saml ? [federation.saml] : []),
        ...(embedPlugin ? [embedPlugin] : []),
        ...(provisioning ? [provisioning.plugin] : []),
      ],
      /* The SAML plugin's registration and management routes, also refused by its allowlist (samlSignIn.ts). */
      ...(federation?.saml ? { disabledPaths: [...(await import('./samlSignIn.js')).SAML_DISABLED_PATHS] } : {}),
      /* A verified address from a provider links to the account that has it,
         whether or not that account's own address was ever verified: the
         hooks end what such an account held first (identityRoles.ts). An
         unverified address never links: no provider is trusted by name. */
      account: { accountLinking: { enabled: true, requireLocalEmailVerified: false, trustedProviders: [] } },
      ...(federation ? { databaseHooks: federation.hooks } : {}),
      telemetry: { enabled: false },
      /* Its default error logging is silent in production: the failure log says which route failed (authFailureLog.ts). */
      onAPIError: { onError: failures.onError },
      /* Better Auth limits its own routes (in production, by the client's
         forwarded address). Counted where the deployment's sign-in state is,
         so a second instance behind the load balancer does not double it. */
      /* A directory is counted per connection, not per address, before Better Auth sees it (scimDirectory.ts). */
      rateLimit: {
        /* Always, not only where NODE_ENV says production: a server started without it was a password oracle. */
        enabled: !authLimitsOffForTests(opts.listenHost ?? new URL(opts.baseURL).hostname),
        customStorage: { consume: signInState.consume },
        ...(provisioning ? { customRules: { '/scim/**': false } } : {}),
      },
    };
    /* On PostgreSQL every table is the runtime schema's `auth_` one (postgresAuthStore.ts); the file keeps Better Auth's names. */
    const options = postgres ? withPostgresAuthModels(given) : given;
    /* Bring the private session store up before accepting sign-in requests:
       Better Auth migrates the file itself; the PostgreSQL layout is attested.
       Before Better Auth is made, because making it starts its own schema
       check (1.7.3 and later), which on a file not yet migrated logs a
       mismatch for tables the migration is about to create. */
    await handle.prepare(async () => {
      const { runMigrations } = await getMigrations(options);
      await runMigrations();
      // Better Auth makes the trail's table; its append-only triggers are mistri's.
      if (handle.file) provisionSqliteAccountAudit(handle.file);
    });
    separate();
    const auth = betterAuth(options);
    /* Better Auth checks the store holds what it writes, and every request
       waits on that check. Waited for here, so a store it refuses stops the
       start rather than each sign-in, and a runtime closed soon after it
       starts is not closed under the check's own reads. */
    await ((await auth.$context) as unknown as { checkSchema?: () => Promise<void> | undefined }).checkSchema?.();

    const adminEmail = environment.MISTRI_AUTH_ADMIN_EMAIL?.trim();
    const adminPassword = environment.MISTRI_AUTH_ADMIN_PASSWORD;
    const halfSet = sessions ? ignoredAdminEnvironment(environment, loaded.app.name, true) : undefined;
    if (halfSet) console.error(halfSet);
    if (sessions && adminEmail && adminPassword) {
      try {
        await auth.api.createUser({
          // The operator names this address: it is proven as far as this App can know.
          body: {
            email: adminEmail,
            password: adminPassword,
            name: nameFromEmail(adminEmail),
            role: 'admin',
            data: { emailVerified: true },
          },
        });
        console.log(`mistri: created the admin account ${adminEmail} for "${loaded.app.name}"`);
      } catch (err) {
        /* Already there is the usual case after the first start. The password
           is read only to make the account, so one that no longer opens it is
           said to be unused, and where the store is, since a store an earlier
           start left elsewhere is the usual reason it is not the one meant. */
        if (!/exist|already/i.test((err as Error).message ?? '')) throw err;
        const context = (await auth.$context) as unknown as {
          internalAdapter: {
            findUserByEmail(
              email: string,
              options: { includeAccounts: true },
            ): Promise<{ accounts: { providerId: string; password?: string | null }[] } | null>;
          };
          password: { verify(data: { password: string; hash: string }): Promise<boolean> };
        };
        const found = await context.internalAdapter.findUserByEmail(adminEmail.toLowerCase(), { includeAccounts: true });
        const hash = found?.accounts.find((account) => account.providerId === 'credential')?.password;
        if (!hash || !(await context.password.verify({ password: adminPassword, hash }))) {
          const where = postgres ? 'its PostgreSQL auth store' : store;
          console.error(
            `mistri: the admin account ${adminEmail} already exists in ${where} with another password, so MISTRI_AUTH_ADMIN_PASSWORD was not applied: it is read only when the account is made.`,
          );
        }
      }
    }

    const nativeHandler = toNodeHandler(auth);
    const profileHandler = createAccountProfileHandler({
      appId: loaded.app.id,
      trustedOrigins: [...opts.trustedOrigins, opts.baseURL],
      api: auth.api,
      headers: fromNodeHeaders,
      emailChange: Boolean(mail && spec.providers.includes('email')),
      connectedClients: Boolean(oauth),
    });
    const audit = createAccountAuditStore((await auth.$context).adapter as AuditAdapter, transactions);
    federation?.bindAudit(audit);
    const administration = createAccountAdministration(auth.api as unknown as AccountAdminApi, {
      passwords: spec.providers.includes('email'),
      audit,
    });
    const signInInstants = new WeakMap<VerifiedSessionInstance, number>();
    const displayNames = new WeakMap<VerifiedSessionInstance, string>();
    const sessionsAsked = new WeakMap<IncomingMessage, Promise<Identity | null>>();
    const stepUps = {
      instants: new WeakMap<VerifiedSessionInstance, number | null>(),
      providers: new WeakMap<VerifiedSessionInstance, string>(),
    };
    const workEmail = federation?.tenants.length ? homeRealm(federation.tenants) : undefined;
    /* Loaded only where a provider takes it (backchannelLogout.ts). */
    const logout = federation?.logout.size
      ? (await import('./backchannelLogout.js')).backchannelLogout({
          providers: federation.logout,
          context: async () => (await auth.$context) as unknown as LogoutContext,
          where: at,
        })
      : undefined;
    const logoutPrefix = `${under}/api/auth/backchannel-logout/`;
    const oauthPrefix = `${under}/api/auth/oauth/`;
    let oauthDoor: { handle(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> } | undefined;
    const sessionCookie = ((await auth.$context) as unknown as { authCookies: { sessionToken: { name: string } } }).authCookies.sessionToken
      .name;
    const embedExchange = embedded.length
      ? createEmbedExchange({
          appId: loaded.app.id,
          issuers: embedded,
          jose,
          ...(opts.trustedProxies ? { trustedProxies: opts.trustedProxies } : {}),
          /* Spent ids live in the auth store, so a replay is refused by every
             instance that shares it, cache or none (ledger.ts). */
          spend: assertionLedger(async () => ((await auth.$context) as unknown as { adapter: LedgerAdapter }).adapter).spend,
          signIn: async (assertion, userAgent, lifetimeMs) => {
            const { config } = assertion.issuer;
            let answer: { headers: Headers; response: EmbedSignInAnswer };
            try {
              answer = await (auth.api as unknown as EmbedApi).mistriEmbedSignIn({
                body: {
                  issuer: config.name,
                  iss: config.issuer,
                  subject: assertion.subject,
                  ...(assertion.email ? { email: assertion.email } : {}),
                  emailVerified: assertion.emailVerified,
                  ...(assertion.name || assertion.email ? { name: assertion.name ?? nameFromEmail(assertion.email!) } : {}),
                  link: config.accounts === 'link-verified-email',
                  create: config.createAccounts !== false,
                  ...(lifetimeMs ? { lifetimeMs } : {}),
                },
                headers: new Headers(userAgent ? { 'user-agent': userAgent } : {}),
                returnHeaders: true,
              });
            } catch (error) {
              // A banned account, or one a hook refused: Better Auth's own word, said as a refusal.
              if ((error as { statusCode?: unknown }).statusCode !== undefined || (error as Error).name === 'APIError') {
                throw new EmbedRefusal(403, 'account_refused', 'This account may not sign in.');
              }
              throw error;
            }
            const { response } = answer;
            if ('refused' in response) throw new EmbedRefusal(response.refused.status, response.refused.code, response.refused.message);
            const cookies = answer.headers.getSetCookie();
            const token = cookies
              .find((line) => line.startsWith(`${sessionCookie}=`))
              ?.slice(sessionCookie.length + 1)
              .split(';')[0];
            if (!token) throw new Error(`${at}: the embed sign-in set no session cookie.`);
            /* The roles the issuer's mapping gave, for this session alone
               (embedRole): the account keeps what an administrator set. */
            if (config.roles) {
              await signInState.put('embed', response.sessionId, { issuer: config.name, roles: [...assertion.roles] }, response.expiresAt);
            }
            return { accountId: response.accountId, sessionId: response.sessionId, expiresAt: response.expiresAt, cookies, token };
          },
          endSession: async (token) => {
            await (auth.api as unknown as EmbedApi).mistriEmbedEnd({ body: { token } });
          },
          signOutCookie: async (req) => {
            try {
              const { headers } = await (auth.api as unknown as EmbedApi).signOut({
                headers: fromNodeHeaders(req.headers),
                returnHeaders: true,
              });
              return headers.getSetCookie();
            } catch {
              return [];
            }
          },
        })
      : undefined;
    /* A session an issuer that maps roles opened holds the roles its
       assertion gave in place of the ones that mapping can give: the host
       gives and takes those, and every other role stays as an administrator
       set it. Any other session, and an issuer without a mapping, reads the
       account's roles unchanged — a `roles` claim is never read there. */
    const roleMappings = new Map(
      embedded.flatMap((issuer) => (issuer.config.roles ? [[issuer.config.name, issuer.config.roles] as const] : [])),
    );
    const embedRole = async (sessionId: string | undefined, role: string | null | undefined): Promise<string | undefined> => {
      if (!roleMappings.size || !sessionId) return role ?? undefined;
      const kept = await signInState.read<{ issuer?: unknown; roles?: unknown }>('embed', sessionId);
      const mapping = typeof kept?.issuer === 'string' ? roleMappings.get(kept.issuer) : undefined;
      if (!mapping || !Array.isArray(kept!.roles)) return role ?? undefined;
      const given = kept!.roles.filter((held): held is string => typeof held === 'string' && Object.hasOwn(mapping, held));
      const next = [...new Set([...rolesOf(role).filter((held) => !Object.hasOwn(mapping, held)), ...given])];
      return next.length ? next.join(',') : undefined;
    };
    const runtime: AppAuthRuntime = {
      accountProfile: true,
      ...(sessions
        ? {
            accounts: {
              list: (req, options, roles) => administration.list(fromNodeHeaders(req.headers), options, roles),
              change: (req, actor, change, roles) => administration.change(fromNodeHeaders(req.headers), actor, change, roles),
              trail: (options) => administration.trail(options),
            } satisfies AccountAdministrationRuntime,
          }
        : {}),
      ...(passwordReset ? { passwordReset: 'link' as const } : {}),
      spec,
      ...(federation && Object.keys(federation.labels).length ? { labels: Object.freeze(federation.labels) } : {}),
      store: handle.label,
      close,
      ...(embedExchange ? { embed: Object.freeze({ origins: embedExchange.origins, sessionCookie, bearer: embedExchange.bearer }) } : {}),
      handler: async (req, res) => {
        // Before anything reaches Better Auth, so no value the client sent under this name survives.
        req.headers[CLIENT_ADDRESS_HEADER] = clientAddress(req, opts.trustedProxies ?? []);
        const path = new URL(req.url ?? '', opts.baseURL).pathname;
        if (path === `${under}/api/auth/profile`) return profileHandler(req, res);
        if (workEmail && path === `${under}/api/auth/work-email`) return workEmail(req, res);
        // Every provider's logout address answers, 404 for one that does not take it: none reaches Better Auth.
        if (path.startsWith(logoutPrefix)) {
          const name = path.slice(logoutPrefix.length);
          if (logout) return logout(req, res, name);
          res
            .writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        // Every OAuth address answers, 404 where no authorization server issues for this App: none reaches Better Auth.
        if (path.startsWith(oauthPrefix)) {
          if (oauthDoor) return oauthDoor.handle(req, res, path.slice(oauthPrefix.length - 1));
          res
            .writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        if (provisioning && path.startsWith(`${under}/api/auth/scim/`)) return provisioning.serve(req, res);
        if (embedExchange && path === `${under}/api/auth/embed/exchange`) return embedExchange.exchange(req, res);
        if (embedExchange && path === `${under}/api/auth/embed/sign-out`) return embedExchange.signOut(req, res);
        /* Better Auth's own admin endpoints judge the role the account has
           stored. A role the App maps from claims is the provider's, and
           counts only for its sessions (sessionRoles): a password session of
           an account whose admin came from claims must not set passwords or
           roles through them. They answer a session whose App roles hold
           admin, as the accounts screen in front of them does. */
        if (federation && nativeAdminPath(path.slice(under.length)) && !rolesOf((await runtime.session(req))?.role).includes(ADMIN_ROLE)) {
          res.statusCode = 403;
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-store');
          res.end(JSON.stringify({ error: 'Only an administrator manages accounts.' }));
          return;
        }
        /* What changes an account goes through the accounts screen (accountAdministration.ts), which keeps the last
           administrator, the App's own roles and the trail; Better Auth's own doors for the same changes, and the one for
           signing in as somebody else, are not this App's. */
        if (closedNativeAdminPath(path.slice(under.length))) {
          res
            .writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' })
            .end(JSON.stringify({ error: 'not_found' }));
          return;
        }
        return nativeHandler(req, res);
      },
      /* Once per request: the gate asks, and so does a row policy's verifier
         for the same request, and each ask was the session and its account
         read again from the store. One request is one answer. */
      session: (req) => {
        let asked = sessionsAsked.get(req);
        if (!asked)
          sessionsAsked.set(
            req,
            (asked = (async () => {
              const got = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
              if (!got?.user) return null;
              const user = got.user as { id: string; email?: string; name?: string; role?: string | null; emailVerified?: unknown };
              const role = await embedRole(
                got.session?.id,
                federation
                  ? federation.rolesFor(user.role, (await federation.stepUp.evidence(got.session?.id ?? ''))?.provider)
                  : user.role,
              );
              const verified = (user.emailVerified === true || user.emailVerified === 1) && Boolean(user.email);
              return {
                id: user.id,
                who: user.email ?? user.name ?? user.id,
                ...(role ? { role } : {}),
                ...(sayableName(user.name) ? { name: user.name } : {}),
                ...(verified ? { emailVerified: true as const } : {}),
                ...(spec.signUp === 'open' && !verified ? { emailUnproven: true as const } : {}),
              };
            })()),
          );
        // A copy each time: a caller that changes what it was handed changes nothing another caller reads.
        return asked.then((identity) => identity && { ...identity });
      },
      sessionInstance: async (req) => {
        try {
          if (closed) return denyTenant();
          const got = await auth.api.getSession({
            headers: fromNodeHeaders(req.headers),
            query: { disableCookieCache: true, disableRefresh: true },
          });
          if (closed) return denyTenant();
          if (got === null) return null;
          if (!got?.user || !got.session) return denyTenant();
          const user = got.user,
            session = got.session;
          // Native deployment admins may impersonate users in ordinary auth.
          // That delegated login must never become the user's own tenant or
          // operator authority after its provenance is projected away.
          if (session.impersonatedBy !== undefined && session.impersonatedBy !== null) return denyTenant();
          const evidence = await federation?.stepUp.evidence(session.id);
          if (closed) return denyTenant();
          const role = await embedRole(
            session.id,
            federation
              ? federation.rolesFor(typeof user.role === 'string' ? user.role : undefined, evidence?.provider)
              : (user.role as string | null | undefined),
          );
          if (closed) return denyTenant();
          const identity = captureTenantData({ id: user.id, who: user.email ?? user.name ?? user.id, ...(role ? { role } : {}) });
          tenantIdentifier(identity.id, 1024);
          tenantIdentifier(session.id, 1024);
          if (
            typeof identity.who !== 'string' ||
            (identity.role !== undefined && typeof identity.role !== 'string') ||
            session.userId !== identity.id
          )
            return denyTenant();
          const expiresAt = instantOf(session.expiresAt);
          if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) return denyTenant();
          const proof = captureTenantData({ identity: identity as unknown as Identity, sessionId: session.id, expiresAt });
          const createdAt = instantOf(session.createdAt);
          // Bad age metadata disables only the private opening capability.
          if (Number.isSafeInteger(createdAt) && createdAt >= 0 && createdAt <= Date.now() && createdAt < expiresAt) {
            signInInstants.set(proof, createdAt);
          }
          // A malformed name disables only what needs one (a support opening).
          const name: unknown = user.name;
          if (sayableName(name)) displayNames.set(proof, name);
          /* A session an identity provider opened is as recent, for a step-up,
             as the provider's own authentication says (identityProviders.ts). */
          if (evidence) {
            stepUps.instants.set(proof, evidence.at);
            stepUps.providers.set(proof, evidence.provider);
          }
          return proof;
        } catch {
          return denyTenant();
        }
      },
      // Nothing is signed in here, and nothing may become so.
      ...(sessions
        ? {}
        : {
            handler: (_req: IncomingMessage, res: ServerResponse) => {
              res.statusCode = 404;
              res.end();
              return Promise.resolve();
            },
            session: async () => null,
            sessionInstance: async () => denyTenant(),
          }),
    };
    /* A 5xx from any auth route is one line on stderr, with the route and the error but no request data (authFailureLog.ts). */
    const unwatched = runtime.handler;
    runtime.handler = (req, res) => failures.watch(req, res, () => unwatched(req, res));
    /* The tenant binding observes the file store synchronously, and a
       PostgreSQL store asynchronously, on its own pool. */
    const database = handle.file;
    if (database) nativeTokenFiles.set(runtime, database);
    else nativeTokenPools.set(runtime, handle.database as PgPool);
    /* The authorization server, on the store the API tokens are in: that store
       must be there already (`mistri api-token provision`), since every
       token it issues is one of them. Loaded only here (oauthServer.ts). */
    if (oauth) {
      const [{ createOAuthServer }, { sqliteOAuthStore, postgresOAuthStore }] = await Promise.all([
        import('./oauthServer.js'),
        import('./oauthStore.js'),
      ]);
      const store = database ? sqliteOAuthStore(database, loaded.app.id) : postgresOAuthStore(handle.database as PgPool, loaded.app.id);
      try {
        // The store's own attestation (layout, version, this App's binding), then one read of the OAuth rows.
        await store(function* (tables) {
          yield { kind: 'all', sql: `SELECT count(*) AS n FROM ${tables.client}`, params: [] };
          return true;
        });
      } catch {
        throw new Error(
          `${at}: the OAuth authorization server "${oauth.config.name}" issues API tokens, and this App's API token store ` +
            'is not ready. Provision it first: mistri api-token provision (see mistri api-token --help).',
        );
      }
      oauthDoor = createOAuthServer({
        app: loaded.app,
        config: oauth.config,
        origin: served.origin,
        under,
        home: oauth.home,
        store,
        sessionInstance: runtime.sessionInstance!,
        trustedOrigins: [...opts.trustedOrigins, opts.baseURL],
        ...(opts.trustedProxies ? { trustedProxies: opts.trustedProxies } : {}),
        tenancy: () => oauthTenancyOf(runtime),
      });
      nativeOAuth.set(runtime, Object.freeze({ roles: oauth.ceiling }));
      bindOAuthResource(runtime, { origin: served.origin, under, appId: loaded.app.id, version: loaded.app.api!.version });
    }
    /* Accounts made on someone's behalf (authAccounts.ts): the operator's
       maintenance step and an invitation's claim, through Better Auth's own
       createUser, called with no request as the admin bootstrap above is. */
    if (provisioning) provisioning.register(runtime);
    registerNativeAccounts(runtime, {
      create: (body) => auth.api.createUser({ body }),
      audit,
      closed: () => closed,
      ...(database ? { file: database } : { pool: handle.database as PgQuery }),
    });
    if (!database)
      registerAppAuthRuntime(
        runtime,
        loaded.app.id,
        () => closed,
        postgresObserver(handle.database as PgQuery),
        signInInstants,
        displayNames,
        stepUps,
      );
    else
      registerAppAuthRuntime(
        runtime,
        loaded.app.id,
        () => closed,
        {
          synchronous: true,
          lookupAccount: (accountId) => {
            const row = database.prepare('SELECT id FROM "user" WHERE id = ? COLLATE BINARY').get(accountId);
            if (!row) return null;
            if (row.id !== accountId) return denyTenant();
            return { accountId };
          },
          lookupEligibleAccount: (accountId) => {
            const row = captureTenantData(
              database
                .prepare(
                  `SELECT id, banned, banExpires, instr(banExpires, char(0)) AS banExpiresNul
        FROM "user" WHERE id = ? COLLATE BINARY`,
                )
                .get(accountId),
            );
            if (!row) return null;
            if (row.id !== accountId) return denyTenant();
            return nativeAccountEligible(row) ? { accountId } : null;
          },
          lookupEligibleAccountRoles: (accountId) => readSqliteEligibleAccountRoles(database, accountId),
          checkSession: (proof, expectedCreatedAt) => {
            const row = database
              .prepare(`SELECT s.userId, s.expiresAt, s.createdAt, instr(s.createdAt, char(0)) AS createdAtNul, s.impersonatedBy, u.banned
        FROM "session" s JOIN "user" u ON u.id = s.userId
        WHERE s.id = ? COLLATE BINARY`)
              .get(proof.sessionId);
            if (
              !row ||
              row.userId !== proof.identity.id ||
              row.impersonatedBy !== null ||
              (row.banned !== null && row.banned !== 0) ||
              typeof row.expiresAt !== 'string'
            )
              return denyTenant();
            const expiresAt = new Date(row.expiresAt).getTime();
            if (expectedCreatedAt !== undefined && (row.createdAtNul !== 0 || instantOf(row.createdAt) !== expectedCreatedAt))
              return denyTenant();
            // Shortened sessions require fresh admission; a refresh never extends the
            // already-issued proof. The owning writer also checks its own deadline.
            if (!Number.isSafeInteger(expiresAt) || expiresAt < proof.expiresAt || expiresAt <= Date.now()) denyTenant();
          },
        },
        signInInstants,
        displayNames,
        stepUps,
      );
    return runtime;
  } catch (error) {
    close();
    throw error;
  }
}

/** A captured sign-up, re-read before anything trusts it: one of the two words, or just in time within the App's own providers. */
function signUpShape(spec: AppSignIn): boolean {
  const signUp: unknown = spec.signUp;
  if (typeof signUp === 'string') return (SIGN_UP_MODES as readonly string[]).includes(signUp);
  if (!isRecord(signUp)) return false;
  const { domains = [], providers = [] } = signUp as { domains?: unknown; providers?: unknown };
  return (
    Array.isArray(domains) &&
    domains.every((domain) => typeof domain === 'string' && EMAIL_DOMAIN.test(domain)) &&
    Array.isArray(providers) &&
    providers.every((provider) => isAuthProvider(provider) && spec.providers.includes(provider))
  );
}

/** The slice of Better Auth's instance this file calls. */
interface AuthLike {
  $context: Promise<{ adapter: unknown }>;
  handler: (request: Request) => Promise<Response>;
  api: Omit<AccountProfileApi, 'getSession'> & {
    getSession: (a: { headers: Headers; query?: { disableCookieCache: true; disableRefresh: true } }) => Promise<{
      user?: Record<string, unknown>;
      session?: { id: string; userId: string; expiresAt: Date; createdAt?: unknown; impersonatedBy?: unknown };
    } | null>;
    createUser: (a: { body: Record<string, unknown> }) => Promise<unknown>;
  };
}
