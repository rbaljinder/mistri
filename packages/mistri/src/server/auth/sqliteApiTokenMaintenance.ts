/** Private local-operator maintenance, not a browser/API authorization seam.
 * The supplied actor is eligible native audit metadata, not operator authority.
 * Only preprovisioned stores are opened; no DDL, bootstrap or issuance retry.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { assertSqliteAuthTokenLayout } from '../../adapters/auth/sqliteAuthStoreLayout.js';
import { assertApiTokenAppId, assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import { issueAccountToken, type IssueCatalog } from './apiTokenIssuance.js';
import { apiReadTokenCatalog } from '../api/apiEventOperations.js';
import { assertAuthStoreSeparation, type AuthStoreExclusion } from './authStoreSeparation.js';
import { readSqliteEligibleAccountRoles } from './nativeAccountObservation.js';
import { createSqliteApiTokenStore } from './sqliteApiTokenStore.js';
import { captureApiTokenCommandContext } from './apiTokenCommandContext.js';

const refuse = (): never => {
  throw new Error('SQLite API token maintenance is unavailable.');
};
interface Owner {
  appId: string;
  storeId: string;
  exclusions: readonly AuthStoreExclusion[];
}
interface IssueOptions {
  storeId: string;
  exclusions: readonly AuthStoreExclusion[];
  subjectId: string;
  actorId: string;
  roles: readonly string[];
  operations?: readonly string[];
  label: string;
  expiresAt: number;
  tokenId?: string;
  /** Tenant Apps only: `{ tenantId, membershipId, membershipVersion, roles }` read natively from the business store. */
  tenant?: unknown;
}
interface RevokeOptions extends Owner {
  tokenId: string;
  expectedVersion: string;
  actorId: string;
}
function exact(raw: unknown, required: string[], optional: string[] = []) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return refuse();
  const value = raw as Record<string, unknown>;
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => ![...required, ...optional].includes(key)))
    return refuse();
  return value;
}
function instant(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000) return refuse();
  return value;
}
function owner(raw: unknown): Owner {
  const value = exact(snapshot(raw, 131072).value, ['appId', 'storeId', 'exclusions']);
  assertApiTokenAppId(value.appId);
  assertApiTokenSecretId(value.storeId);
  if (!Array.isArray(value.exclusions) || value.exclusions.length > 128) return refuse();
  return value as unknown as Owner;
}
/** The caller owns the complete exclusion set. These inode/path checks do not
 * promise protection against a hostile concurrent filesystem writer. */
function transaction<T>(
  existingPath: string,
  binding: Owner,
  work: (db: DatabaseSync, store: ReturnType<typeof createSqliteApiTokenStore>, current: () => void) => T,
): T {
  let db: DatabaseSync | undefined;
  try {
    if (typeof existingPath !== 'string' || !isAbsolute(existingPath) || existingPath.includes('\0')) return refuse();
    const path = realpathSync(existingPath),
      identity = statSync(path);
    if (!identity.isFile()) return refuse();
    const fence = () => {
      const info = statSync(path);
      if (realpathSync(existingPath) !== path || !info.isFile() || info.dev !== identity.dev || info.ino !== identity.ino) return refuse();
      for (const excluded of binding.exclusions) assertAuthStoreSeparation(path, excluded);
    };
    fence();
    const uri = pathToFileURL(path);
    uri.searchParams.set('mode', 'rw');
    db = new DatabaseSync(uri.href, { enableForeignKeyConstraints: true });
    fence();
    db.exec('BEGIN IMMEDIATE');
    const current = () => {
      fence();
      if (!db?.isTransaction) return refuse();
    };
    current();
    assertSqliteAuthTokenLayout(db);
    const store = createSqliteApiTokenStore(db, { appId: binding.appId, storeId: binding.storeId }, current);
    // Enforce binding even before the maintenance operation's native reads.
    store.lookup(binding.storeId);
    const result = work(db, store, current);
    current();
    assertSqliteAuthTokenLayout(db);
    current();
    db.exec('COMMIT');
    // A COMMIT exception never hands off a secret, even if its result is
    // uncertain. The operator must reconcile; never automatically reissue.
    return result;
  } catch {
    return refuse();
  } finally {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* close owned handle */
    }
    try {
      db?.close();
    } catch {
      /* no native diagnostics */
    }
  }
}

/** Missing operations retains current/future eligible operations under the
 * exact issued roles. Explicit [] is deny-all. Authorized dormant roles are
 * valid. App/schema are trusted parsed logical inputs, never request data.
 * `now` is the operator's explicit instant; native bans use the native clock.
 * An optional preselected locator lets the CLI reconcile an uncertain commit
 * without disclosing the secret before commit. Existing IDs never overwrite.
 */
export function issueSqliteApiToken(existingPath: string, app: AppDef, schema: DatabaseSchema, rawOptions: IssueOptions, now: number) {
  return issueSqliteAccountToken(existingPath, app, schema, rawOptions, now);
}

/** Private local-operator command issuance. No CLI/HTTP activation and no
 * operator authority inferred from the native audit actor or declared grants. */
export function issueSqliteApiCommandToken(
  existingPath: string,
  app: AppDef,
  schema: DatabaseSchema,
  registry: Parameters<typeof captureApiTokenCommandContext>[2],
  evidence: Parameters<typeof captureApiTokenCommandContext>[3],
  rawOptions: IssueOptions,
  now: number,
) {
  try {
    const context = captureApiTokenCommandContext(app, schema, registry, evidence);
    return issueSqliteAccountToken(existingPath, context.app, context.schema, rawOptions, now, context.catalog);
  } catch {
    return refuse();
  }
}

/** Local-operator issuance for a tenant App. The caller read the subject's
 * membership natively in the business store (a separate database: this is not
 * one transaction with it) and supplies its binding and roles, and the tenant
 * catalog. The token binds that membership's version, so a membership changed
 * after this read leaves the token without authority, never with more. */
export function issueSqliteApiTenantToken(existingPath: string, app: AppDef, catalog: IssueCatalog, rawOptions: IssueOptions, now: number) {
  return issueSqliteAccountToken(existingPath, app, undefined, rawOptions, now, catalog);
}

function issueSqliteAccountToken(
  existingPath: string,
  app: AppDef,
  schema: DatabaseSchema | undefined,
  rawOptions: IssueOptions,
  now: number,
  commands?: IssueCatalog,
) {
  try {
    const options = exact(
      snapshot(rawOptions, 131072).value,
      ['storeId', 'exclusions', 'subjectId', 'actorId', 'roles', 'label', 'expiresAt'],
      ['operations', 'tokenId', 'tenant'],
    );
    // A tenant App issues from its tenant catalog; any other from its own.
    if ((Object.hasOwn(options, 'tenant') && !commands) || (!Object.hasOwn(options, 'tenant') && !commands && !schema)) return refuse();
    const binding = owner({ appId: app.id, storeId: options.storeId, exclusions: options.exclusions });
    const clock = instant(now);
    if (!app.api) return refuse();
    const issue = issueAccountToken({
      app,
      appId: binding.appId,
      catalog: commands ?? apiReadTokenCatalog(app.api, app, schema!),
      tokenId: Object.hasOwn(options, 'tokenId') ? (options.tokenId as string) : randomUUID(),
      subjectId: options.subjectId as string,
      actorId: options.actorId as string,
      roles: options.roles as string[],
      label: options.label as string,
      expiresAt: options.expiresAt as number,
      createdAt: clock,
      ...(Object.hasOwn(options, 'operations') ? { operations: options.operations as string[] } : {}),
      ...(Object.hasOwn(options, 'tenant') ? { tenant: options.tenant } : {}),
    });
    const { record } = issue;
    return transaction(existingPath, binding, (db, store, current) => {
      const eligible = () => {
        current();
        const subject = readSqliteEligibleAccountRoles(db, record.subject.id);
        current();
        const actor = readSqliteEligibleAccountRoles(db, record.createdBy);
        current();
        issue.admit(subject, actor, clock);
      };
      eligible();
      const minted = issue.mint();
      store.insert(minted.stored);
      eligible();
      return minted.result;
    });
  } catch {
    return refuse();
  }
}

/** Local operator reconciliation only. Never return the stored digest or a
 * recoverable secret; successful lookup does not admit a bearer request. */
export function inspectSqliteApiToken(existingPath: string, rawOptions: Owner & { tokenId: string }) {
  try {
    const options = exact(snapshot(rawOptions, 131072).value, ['appId', 'storeId', 'exclusions', 'tokenId']);
    const binding = owner({ appId: options.appId, storeId: options.storeId, exclusions: options.exclusions });
    assertApiTokenSecretId(options.tokenId);
    const tokenId = options.tokenId;
    return transaction(existingPath, binding, (_db, store) => {
      const stored = store.lookup(tokenId);
      return stored === null ? null : Object.freeze({ record: stored.record, version: stored.version });
    });
  } catch {
    return refuse();
  }
}

/** Subject demotion, expiry and removed API exposure cannot prevent a local
 * operator's revoke. An eligible native actor is still required for audit. */
export function revokeSqliteApiToken(existingPath: string, rawOptions: RevokeOptions, now: number) {
  try {
    const options = exact(snapshot(rawOptions, 131072).value, ['appId', 'storeId', 'exclusions', 'tokenId', 'expectedVersion', 'actorId']);
    const binding = owner({ appId: options.appId, storeId: options.storeId, exclusions: options.exclusions });
    const clock = instant(now);
    assertApiTokenSecretId(options.tokenId);
    const tokenId = options.tokenId;
    return transaction(existingPath, binding, (db, store, current) => {
      const eligible = () => {
        current();
        if (typeof options.actorId !== 'string' || !readSqliteEligibleAccountRoles(db, options.actorId)) return refuse();
        current();
      };
      eligible();
      store.revoke({
        tokenId,
        appId: binding.appId,
        expectedVersion: options.expectedVersion,
        revokedAt: clock,
        revokedBy: options.actorId,
      });
      const revoked = store.lookup(tokenId);
      if (!revoked || revoked.record.revokedAt !== clock) return refuse();
      eligible();
      return Object.freeze({ tokenId, version: revoked.version });
    });
  } catch {
    return refuse();
  }
}
