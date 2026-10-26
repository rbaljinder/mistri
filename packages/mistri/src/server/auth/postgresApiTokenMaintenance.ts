/** Private local-operator maintenance. Actor IDs are audit metadata, not
 * authority. No CLI/admission, bootstrap, DDL, default grants or issue retry. */
import { randomUUID } from 'node:crypto';
import { isPromise, isProxy } from 'node:util/types';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery, PgResult } from '@mistriwork/engine/adapters/postgresPool.js';
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { withPostgresMaintenanceTransaction } from '../../adapters/commands/postgresCommandJournal.js';
import { assertPostgresAuthStore } from '../../adapters/auth/postgresAuthStore.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { assertApiTokenAppId, assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import { issueAccountToken, type IssueCatalog } from './apiTokenIssuance.js';
import { apiReadTokenCatalog } from '../api/apiEventOperations.js';
import {
  assertPostgresAuthStoreSeparation,
  assertPostgresAuthStoreServerSeparation,
  type PostgresSeparationConnection,
} from './authStoreSeparation.js';
import { readPostgresEligibleAccountRoles } from './nativeAccountObservation.js';
import { createPostgresApiTokenStore } from './postgresApiTokenStore.js';
import { captureApiTokenCommandContext } from './apiTokenCommandContext.js';

const refuse = (): never => {
  throw new Error('PostgreSQL API token maintenance is unavailable.');
};
const meta = runtimeTable('postgres', 'auth_api_token_meta'),
  tokens = runtimeTable('postgres', 'auth_api_token'),
  accountTable = runtimeTable('postgres', 'auth_user');
interface Owner {
  appId: string;
  storeId: string;
  excludeConnections: readonly PostgresSeparationConnection[];
}
interface IssueOptions {
  storeId: string;
  excludeConnections: readonly PostgresSeparationConnection[];
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
function clockReader(clock: () => number) {
  if (typeof clock !== 'function' || isProxy(clock)) return refuse();
  let previous = -1;
  return () => {
    const value: unknown = clock();
    if (isPromise(value)) void Promise.prototype.then.call(value, undefined, () => {});
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 8640000000000000 || value < previous)
      return refuse();
    previous = value;
    return value;
  };
}
function owner(raw: unknown): Owner {
  const value = exact(snapshot(raw, 131072).value, ['appId', 'storeId', 'excludeConnections']);
  assertApiTokenAppId(value.appId);
  assertApiTokenSecretId(value.storeId);
  if (!Array.isArray(value.excludeConnections) || value.excludeConnections.length > 128) return refuse();
  for (const rawConnection of value.excludeConnections) {
    const connection = exact(rawConnection, ['url'], ['name', 'source']);
    if (
      typeof connection.url !== 'string' ||
      !connection.url.length ||
      ['name', 'source'].some((key) => Object.hasOwn(connection, key) && typeof connection[key] !== 'string')
    )
      return refuse();
  }
  return value as unknown as Owner;
}
async function transaction<T>(
  url: string,
  binding: Owner,
  accounts: readonly string[],
  work: (client: PgQuery, store: ReturnType<typeof createPostgresApiTokenStore>) => Promise<{ result: T; finalCheck: () => void }>,
) {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url)) return refuse();
  assertPostgresAuthStoreSeparation(url, binding.excludeConnections);
  return withPostgresMaintenanceTransaction(url, async (native) => {
    let active = true,
      drained = false;
    const current = () => {
      if (!active) return refuse();
    };
    function query(sql: string, values?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
    function query(sql: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
    async function query(sql: string | { text: string; values?: unknown[]; rowMode?: string }, values?: unknown[]) {
      current();
      const result = typeof sql === 'string' ? await native.query(sql, values) : await native.query(sql);
      current();
      return result;
    }
    const client: PgQuery = { query },
      operations = new TransactionOperations();
    try {
      // The shared autocommit-oriented probe deliberately catches a denied
      // pg_control_system read and uses unknown identity. In our transaction
      // even that swallowed SQL error aborts the subtransaction. Always undo
      // this read-only probe before proceeding, including apparent success.
      await query('SAVEPOINT api_token_separation_probe');
      try {
        await assertPostgresAuthStoreServerSeparation(client, binding.excludeConnections);
        current();
      } finally {
        await query('ROLLBACK TO SAVEPOINT api_token_separation_probe');
        await query('RELEASE SAVEPOINT api_token_separation_probe');
      }
      await assertPostgresAuthStore(client);
      current();
      // The advisory lock only coordinates maintenance. Native account writers
      // do not take it, so actual row locks must fence ban/demotion/deletion.
      await query(`LOCK TABLE ${meta}, ${tokens}, ${accountTable} IN ROW EXCLUSIVE MODE`);
      await assertPostgresAuthStore(client);
      current();
      const rows = (await query(`SELECT app_id,store_id FROM ${meta} WHERE singleton=1 FOR SHARE`)).rows;
      if (rows.length !== 1 || rows[0].app_id !== binding.appId || rows[0].store_id !== binding.storeId) return refuse();
      // Deduplicate subject==actor; every caller uses the same UTF16 ordering.
      for (const id of [...new Set(accounts)].sort()) {
        const locked = (await query(`SELECT id FROM ${accountTable} WHERE id=$1 COLLATE "C" FOR UPDATE`, [id])).rows;
        if (locked.length !== 1 || locked[0].id !== id) return refuse();
      }
      const store = createPostgresApiTokenStore(client, operations, { appId: binding.appId, storeId: binding.storeId }, current);
      await store.lookup(binding.storeId);
      current();
      const completed = await work(client, store);
      current();
      await operations.finish();
      drained = true;
      current();
      await assertPostgresAuthStore(client);
      current();
      completed.finalCheck();
      current();
      return completed.result;
    } finally {
      try {
        if (!drained) await operations.finish();
      } finally {
        active = false;
      }
    }
  });
}

/** Missing operations retains future eligible operations under exact issued
 * roles; [] denies all. Dormant authorized roles are allowed. Trusted parsed
 * App/logical schema and synchronous clock are captured per local invocation.
 * Account locks remain held through the helper's COMMIT, before secret return.
 */
export async function issuePostgresApiToken(
  url: string,
  app: AppDef,
  schema: DatabaseSchema,
  rawOptions: IssueOptions,
  clock: () => number,
) {
  return issuePostgresAccountToken(url, app, schema, rawOptions, clock);
}

/** Private local-operator command issuance, as on SQLite: operations are
 * checked against the combined read + command catalog. No CLI/HTTP
 * activation and no operator authority inferred from the audit actor. */
export async function issuePostgresApiCommandToken(
  url: string,
  app: AppDef,
  schema: DatabaseSchema,
  registry: Parameters<typeof captureApiTokenCommandContext>[2],
  evidence: Parameters<typeof captureApiTokenCommandContext>[3],
  rawOptions: IssueOptions,
  clock: () => number,
) {
  try {
    const context = captureApiTokenCommandContext(app, schema, registry, evidence);
    return await issuePostgresAccountToken(url, context.app, context.schema, rawOptions, clock, context.catalog);
  } catch {
    return refuse();
  }
}

/** Tenant App issuance, as on SQLite: the caller read the membership natively in
 * the business database (not one transaction with this one) and supplies its
 * binding, roles and the tenant catalog. The bound version makes a later
 * membership change leave the token without authority, never with more. */
export async function issuePostgresApiTenantToken(
  url: string,
  app: AppDef,
  catalog: IssueCatalog,
  rawOptions: IssueOptions,
  clock: () => number,
) {
  return issuePostgresAccountToken(url, app, undefined, rawOptions, clock, catalog);
}

async function issuePostgresAccountToken(
  url: string,
  app: AppDef,
  schema: DatabaseSchema | undefined,
  rawOptions: IssueOptions,
  clock: () => number,
  commands?: IssueCatalog,
) {
  try {
    const options = exact(
      snapshot(rawOptions, 131072).value,
      ['storeId', 'excludeConnections', 'subjectId', 'actorId', 'roles', 'label', 'expiresAt'],
      ['operations', 'tokenId', 'tenant'],
    );
    // A tenant App issues from its tenant catalog; any other from its own.
    if ((Object.hasOwn(options, 'tenant') && !commands) || (!Object.hasOwn(options, 'tenant') && !commands && !schema)) return refuse();
    if (Object.hasOwn(options, 'tokenId')) assertApiTokenSecretId(options.tokenId);
    const tokenId = Object.hasOwn(options, 'tokenId') ? (options.tokenId as string) : randomUUID();
    const binding = owner({ appId: app.id, storeId: options.storeId, excludeConnections: options.excludeConnections });
    const now = clockReader(clock);
    if (!app.api) return refuse();
    const catalog = commands ?? apiReadTokenCatalog(app.api, app, schema!);
    const prepare = () =>
      issueAccountToken({
        app,
        appId: binding.appId,
        catalog,
        tokenId,
        subjectId: options.subjectId as string,
        actorId: options.actorId as string,
        roles: options.roles as string[],
        label: options.label as string,
        expiresAt: options.expiresAt as number,
        createdAt: now(),
        ...(Object.hasOwn(options, 'operations') ? { operations: options.operations as string[] } : {}),
        ...(Object.hasOwn(options, 'tenant') ? { tenant: options.tenant } : {}),
      });
    const initial = prepare();
    return await transaction(url, binding, [initial.record.subject.id, initial.record.createdBy], async (client, store) => {
      // The record's instant is the transaction's, once its locks are held.
      const issue = prepare();
      const { record } = issue;
      const eligible = async () =>
        issue.admit(
          await readPostgresEligibleAccountRoles(client, record.subject.id),
          await readPostgresEligibleAccountRoles(client, record.createdBy),
        );
      await eligible();
      const minted = issue.mint();
      await store.insert(minted.stored);
      await eligible();
      return {
        result: minted.result,
        finalCheck: () => {
          if (now() >= record.expiresAt) return refuse();
        },
      };
    });
  } catch {
    return refuse();
  }
}

/** Local operator reconciliation after an uncertain issue response. Never
 * returns digest or secret, and never reissues or requires current API scope. */
export async function inspectPostgresApiToken(url: string, rawOptions: Owner & { tokenId: string }) {
  try {
    const options = exact(snapshot(rawOptions, 131072).value, ['appId', 'storeId', 'excludeConnections', 'tokenId']);
    assertApiTokenSecretId(options.tokenId);
    const tokenId = options.tokenId;
    const binding = owner({ appId: options.appId, storeId: options.storeId, excludeConnections: options.excludeConnections });
    return await transaction(url, binding, [], async (_client, store) => {
      const stored = await store.lookup(tokenId);
      return { result: stored ? Object.freeze({ record: stored.record, version: stored.version }) : null, finalCheck: () => {} };
    });
  } catch {
    return refuse();
  }
}

/** Local revoke remains possible after API removal, expiry or subject demotion.
 * The eligible actor is audit metadata; the operator is the authority. */
export async function revokePostgresApiToken(url: string, rawOptions: RevokeOptions, clock: () => number) {
  try {
    const options = exact(snapshot(rawOptions, 131072).value, [
      'appId',
      'storeId',
      'excludeConnections',
      'tokenId',
      'expectedVersion',
      'actorId',
    ]);
    const binding = owner({ appId: options.appId, storeId: options.storeId, excludeConnections: options.excludeConnections });
    assertApiTokenSecretId(options.tokenId);
    if (
      typeof options.actorId !== 'string' ||
      !options.actorId.length ||
      options.actorId.length > 1024 ||
      options.actorId !== options.actorId.trim() ||
      /[\p{Cc}\p{Cs}]/u.test(options.actorId)
    )
      return refuse();
    const now = clockReader(clock),
      tokenId = options.tokenId,
      actorId = options.actorId;
    now();
    return await transaction(url, binding, [actorId], async (client, store) => {
      if (!(await readPostgresEligibleAccountRoles(client, actorId))) return refuse();
      await store.revoke({ tokenId, appId: binding.appId, expectedVersion: options.expectedVersion, revokedAt: now(), revokedBy: actorId });
      const revoked = await store.lookup(tokenId);
      if (!revoked || !(await readPostgresEligibleAccountRoles(client, actorId))) return refuse();
      return {
        result: Object.freeze({ tokenId, version: revoked.version }),
        finalCheck: () => {
          now();
        },
      };
    });
  } catch {
    return refuse();
  }
}
