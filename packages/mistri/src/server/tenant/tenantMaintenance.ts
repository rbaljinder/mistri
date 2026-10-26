/**
 * Tenant maintenance for `@mistriwork/mistri/maintenance`: the operator steps a
 * deployment's own scripts run to seed and look after a tenant store — a
 * tenant's row, the platform's `@platform` row, platform memberships, tenant
 * memberships — and native accounts in the App's own auth store. Platform
 * staff are managed here and only here: none of it has an HTTP surface.
 *
 * Every store step is one transaction on the business database, on the same
 * private store capability and administration journal tenant administration
 * composes: the change and its receipt/audit pair commit together, under the
 * actor `maintenance:<operator>`, with its before and after images
 * (tenantMaintenanceChange.ts). Versions are compare-and-set; a stale one
 * refuses and nothing is written. On PostgreSQL the anchor row (the tenant's,
 * or `@platform`) is locked FOR UPDATE before the membership, the order every
 * business fence shares, so a grant or revocation waits for an in-flight
 * business commit and a later one waits for it.
 *
 * Role ceilings are the loaded App's: a platform grant takes platform-realm
 * roles only, a tenant grant tenant-realm roles only, and neither lasts more
 * than 366 days. An account holds one live membership per realm or tenant.
 * The account a grant names must exist in the App's auth store. That is a
 * separate store, read before the transaction, so this is not a distributed
 * transaction: an account removed in between is granted a membership no
 * session can ever present.
 */
import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { TransactionOutcomeUnknown, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { signInOf } from '../../shared/app.js';
import { loadApp, type LoadedApp } from '../app/apps.js';
import { captureAppAuthRuntime, createAppAuth, type AppAuthRuntime } from '../auth/auth.js';
import {
  createNativeAccount,
  findNativeAccountByEmail,
  nativeAccountInput,
  NativeAccountRefusal,
  type NativeAccountInput,
} from '../auth/authAccounts.js';
import {
  assertSqliteTenantAdministrationJournal,
  createSqliteTenantAdministrationJournal,
  type TenantAdministrationJournal,
} from './tenantAdministrationJournal.js';
import {
  assertPostgresTenantAdministrationJournal,
  createPostgresTenantAdministrationJournal,
} from './tenantAdministrationJournalPostgres.js';
import { assertLinkedTenantInvitations } from './tenantInvitationLinks.js';
import { assertLinkedPostgresTenantInvitations, postgresInvitationStoragePresent } from './tenantInvitationLinksPostgres.js';
import {
  captureMaintenanceChange,
  MAINTENANCE_ACTOR_PREFIX,
  MAINTENANCE_OPERATOR,
  MAINTENANCE_POLICY,
  type MaintenanceAnchorImage,
  type MaintenanceChange,
  type MaintenanceMemberImage,
  type MaintenanceOperation,
} from './tenantMaintenanceChange.js';
import { parseTenantSelector } from './tenantMembership.js';
import { PLATFORM_TENANT_ID } from './tenantPlatform.js';
import { createSqliteTenantAdministration, TENANT_TABLES, type TenantStoreAdministration, type TenantStoreBinding } from './tenantStore.js';
import { binding as storeBinding } from './tenantStoreContract.js';
import { createPostgresTenantAdministration } from './tenantStorePostgres.js';
import { assertSqliteSupportAudit, createSqliteSupportAuditOwner } from './tenantSupportAudit.js';
import { SUPPORT_AUDIT_KEY_VARIABLE, SUPPORT_AUDIT_PREFIX, supportAuditKey, type SupportAuditOwner } from './tenantSupportAuditContract.js';
import { assertPostgresSupportAudit, createPostgresSupportAuditOwner } from './tenantSupportAuditPostgres.js';
import { MEMBER_COLUMNS, supportMemberRow, type SupportMember } from './tenantSupportTransaction.js';
import { membershipRole } from './tenantFeatureMembershipRoles.js';
import { describePostgresRelations } from '../../adapters/commands/postgresCommandJournal.js';
import { isTenantClonePlan, type TenantClonePlan } from './tenantClonePlan.js';
import { copyTenant, planImport, TenantCloneConflict, type ImportPlan } from './tenantCloneEngine.js';
import { captureSandboxClock } from './tenantSandboxClock.js';
import {
  postgresSandboxSession,
  sandboxRows,
  sandboxStorePresent,
  sqliteSandboxSession,
  type SandboxClock,
  type SandboxSession,
} from './tenantSandboxStore.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

/** Why a maintenance step changed nothing — or, `unknown`, may have changed
 * something: the commit was sent and its answer lost. Look before retrying. */
export class TenantMaintenanceRefusal extends Error {
  readonly code = 'tenant_maintenance_refused';
  constructor(
    message: string,
    readonly outcome: 'not_applied' | 'unknown' = 'not_applied',
  ) {
    super(message);
    this.name = 'TenantMaintenanceRefusal';
  }
}
const refuse = (message: string): never => {
  throw new TenantMaintenanceRefusal(message);
};

/** Where the business database is: an existing SQLite file, or a PostgreSQL URL. */
export type TenantMaintenanceTarget = Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
type AnchorStatus = MaintenanceAnchorImage['status'];

const DAY = 24 * 60 * 60 * 1000;
const MAXIMUM_LIFETIME = 366 * DAY;
/** A step's refusal of a version that is not the current one; with `expectedVersion: null`, the row already exists. */
export const STALE = 'The change was refused and nothing was written: the version given is not the current one, or the row is missing.';
const invitationTables = `SELECT 1 FROM main.sqlite_schema WHERE substr(name, 1, 23) = '__mistri_invitation_' COLLATE NOCASE LIMIT 1`;
const supportAuditTables =
  `SELECT 1 FROM main.sqlite_schema WHERE substr(name, 1, ${SUPPORT_AUDIT_PREFIX.length}) ` +
  `= '${SUPPORT_AUDIT_PREFIX}' COLLATE NOCASE LIMIT 1`;
/** A live support session under a membership being revoked, and no audit to
 * end it in: the operator is told which key to set rather than given a
 * half-recorded revocation. */
const SUPPORT_AUDIT_NEEDED =
  'This platform membership holds a live support session and the support audit could not be opened to end it: ' +
  `set ${SUPPORT_AUDIT_KEY_VARIABLE} to the key the audit was provisioned with, then revoke again.`;
const utf8 = (a: string, b: string) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
const sorted = (values: readonly string[]) => [...new Set(values)].sort(utf8);

/* ---------- inputs ---------- */

function request(value: unknown, required: readonly string[], what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    return refuse(`${what} takes an object: { ${required.join(', ')} }.`);
  }
  const keys = Reflect.ownKeys(value);
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !required.includes(key) || !descriptor || !('value' in descriptor)) {
      return refuse(`${what} takes exactly { ${required.join(', ')} }.`);
    }
    out[key] = descriptor.value;
  }
  if (required.some((key) => !Object.hasOwn(out, key))) return refuse(`${what} takes exactly { ${required.join(', ')} }.`);
  return out;
}
/* A lone surrogate would be stored as U+FFFD on PostgreSQL and match a
   different identity, so every identity input refuses one. */
function text(value: unknown, maximum: number, what: string): string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value !== value.trim() || /[\p{Cc}\p{Cs}]/u.test(value))
    return refuse(`${what} is not valid.`);
  return value;
}
function operatorOf(value: unknown): string {
  if (typeof value !== 'string' || !MAINTENANCE_OPERATOR.test(value)) {
    return refuse(
      'operator names who ran the step: 1 to 128 characters of letters, digits, ".", "_", "@" and "-", starting with a letter or digit.',
    );
  }
  return value;
}
function tenantOf(value: unknown): string {
  try {
    return parseTenantSelector([value as string]);
  } catch {
    return refuse('tenantId is not a tenant id: 1 to 128 characters of a–z, 0–9, "_" and "-", starting with a letter or digit.');
  }
}
function statusOf(value: unknown): AnchorStatus {
  if (value !== 'active' && value !== 'suspended' && value !== 'closed') return refuse('status is "active", "suspended" or "closed".');
  return value;
}
function versionOf(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,127}$/.test(value)) {
    return refuse(`expectedVersion is the row's current version, a decimal string${nullable ? ', or null to create it' : ''}.`);
  }
  return value;
}
function bindingOf(value: unknown): TenantStoreBinding {
  try {
    return storeBinding(value as TenantStoreBinding);
  } catch {
    return refuse('The binding is { appId, source: { id, connection }, storeId }, as the tenant store was provisioned with.');
  }
}
function targetOf(value: unknown): Readonly<{ sqlite: string }> | Readonly<{ postgres: string }> {
  const where = value as Record<string, unknown> | null;
  if (where && typeof where === 'object' && Object.keys(where).length === 1) {
    if (typeof where.sqlite === 'string' && where.sqlite.length) {
      let file = false;
      try {
        file = statSync(where.sqlite).isFile();
      } catch {
        /* Refused below. */
      }
      if (!file) return refuse('The SQLite business database must be an existing file; maintenance never creates one.');
      return Object.freeze({ sqlite: where.sqlite });
    }
    if (typeof where.postgres === 'string' && /^postgres(ql)?:\/\//i.test(where.postgres))
      return Object.freeze({ postgres: where.postgres });
  }
  return refuse('The target is { sqlite: path } or { postgres: url }.');
}
function rolesOf(value: unknown, ceiling: ReadonlySet<string>, realm: 'platform' | 'tenant'): readonly string[] {
  if (!Array.isArray(value) || !value.length || value.length > 256 || new Set(value).size !== value.length) {
    return refuse('roles is a list of 1 to 256 distinct role names.');
  }
  for (const role of value) {
    if (typeof role !== 'string' || !ceiling.has(role)) {
      return refuse(
        `${JSON.stringify(role)} is not one of this App's ${realm}-realm roles a person holds (a service role is a jobs principal's), so a ${realm} membership cannot hold it.`,
      );
    }
  }
  return Object.freeze([...(value as string[])]);
}
function validUntilOf(value: unknown, now: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= now || value > now + MAXIMUM_LIFETIME) {
    return refuse('validUntil is a future instant, in epoch milliseconds, at most 366 days away.');
  }
  return value;
}

/* ---------- the App: its roles and its auth store ---------- */

async function loadedApp(target: unknown): Promise<LoadedApp> {
  const path = text(target, 4096, 'The App directory');
  try {
    return await loadApp(path);
  } catch (error) {
    return refuse(`The App could not be loaded: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
/** The tenant App the binding names, whose roles are the grant's ceiling. */
async function appOf(target: unknown, owner: TenantStoreBinding): Promise<LoadedApp> {
  const loaded = await loadedApp(target);
  if (loaded.app.id !== owner.appId) return refuse(`The App is "${loaded.app.id}", not "${owner.appId}", the App this binding names.`);
  if (loaded.app.auth?.rows !== 'tenant') return refuse("The App is not a tenant App (auth.rows: 'tenant').");
  return loaded;
}
function ceilingOf(loaded: LoadedApp, realm: 'platform' | 'tenant'): ReadonlySet<string> {
  const auth = loaded.app.auth!;
  if (realm === 'platform' && !auth.tenancy?.platform) return refuse('The App declares no platform realm (auth.tenancy.platform).');
  // A service role is a jobs module principal's, never a membership's: nobody signs in as it.
  return new Set(Object.keys(auth.roles ?? {}).filter((name) => membershipRole(loaded.app, name, realm)));
}
/** The App's own auth store, opened as serving opens it but with no sign-in:
 * no session secret, no provider, no admin bootstrap (auth.ts). A file store
 * that does not exist yet is created and migrated, as the first start would. */
async function accountsOf<T>(loaded: LoadedApp, work: (runtime: AppAuthRuntime) => Promise<T>): Promise<T> {
  let runtime: AppAuthRuntime;
  try {
    runtime = await createAppAuth(loaded, {
      baseURL: 'http://127.0.0.1',
      trustedOrigins: [],
      sessions: false,
    });
  } catch (error) {
    return refuse(`The App's auth store could not be opened: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  try {
    return await work(runtime);
  } finally {
    runtime.close();
  }
}
async function assertAccount(loaded: LoadedApp, accountId: string): Promise<void> {
  const found = await accountsOf(loaded, async (runtime) => {
    try {
      return await captureAppAuthRuntime(runtime).lookupAccountCurrent(accountId);
    } catch {
      return null;
    }
  });
  if (found?.accountId !== accountId)
    refuse("No account with that id exists in the App's auth store; create it first (createAppAccounts).");
}

/* ---------- one transaction ---------- */

interface Step {
  readonly store: TenantStoreAdministration;
  readonly journal: TenantAdministrationJournal;
  /** The anchor row of this kind, locked FOR UPDATE on PostgreSQL, or null. */
  anchor(id: string, kind: 'tenant' | 'platform'): Promise<MaintenanceAnchorImage | null>;
  /** One ordinary membership by id, locked FOR UPDATE on PostgreSQL, or null. */
  member(id: string): Promise<MaintenanceMemberImage | null>;
  /** Whether the account holds a live (active or invited) membership under the anchor. */
  live(anchorId: string, accountId: string): Promise<boolean>;
  /** The live support rows under a parent platform membership, read without
   * locks: locators, rechecked against the locked row. */
  supportUnder(parentId: string): Promise<readonly SupportMember[]>;
  /** One support row by id, locked FOR UPDATE on PostgreSQL, or null. */
  support(id: string): Promise<SupportMember | null>;
  /** Compare-and-set revoke of one live support row. */
  revokeSupport(id: string, expectedVersion: string): Promise<void>;
  /** The support audit on this transaction, attested; null when the store has
   * none at all. Opened only when a support row has to be ended. */
  audit(): Promise<SupportAuditOwner | null>;
  /** This transaction's statements, for a clone, an import plan or a sandbox's clock (tenantCloneEngine.ts). */
  readonly rows: SandboxSession;
}
function anchorImage(row: Record<string, unknown> | undefined): MaintenanceAnchorImage | null {
  if (!row) return null;
  return Object.freeze({
    tenantId: row.id as string,
    status: row.status as AnchorStatus,
    version: row.version as string,
  });
}
function memberImage(row: Record<string, unknown> | undefined): MaintenanceMemberImage | null {
  if (!row) return null;
  if (typeof row.roles_json !== 'string') return refuse(STALE);
  return Object.freeze({
    membershipId: row.id as string,
    tenantId: row.tenant_id as string,
    accountId: row.account_id as string,
    status: row.status as MaintenanceMemberImage['status'],
    version: row.version as string,
    roles: Object.freeze(JSON.parse(row.roles_json) as string[]),
    validUntil: row.valid_until as number,
  });
}

function sqliteStep(db: DatabaseSync, operations: TransactionOperations, owner: TenantStoreBinding, assertCurrent: () => void): Step {
  const get = (sql: string, ...params: (string | number)[]) => {
    assertCurrent();
    return db.prepare(sql).get(...params);
  };
  const many = (sql: string, ...params: (string | number)[]) => {
    assertCurrent();
    return db.prepare(sql).all(...params);
  };
  return {
    rows: sqliteSandboxSession(db, assertCurrent),
    store: createSqliteTenantAdministration(db, operations, owner, assertCurrent),
    journal: createSqliteTenantAdministrationJournal(db, operations, owner, assertCurrent),
    anchor: async (id, kind) =>
      anchorImage(
        get(
          `SELECT id, status, version FROM main."${TENANT_TABLES.tenant}"
      WHERE id = ? COLLATE BINARY AND kind = ?`,
          id,
          kind,
        ),
      ),
    member: async (id) =>
      memberImage(
        get(
          `SELECT id, tenant_id, account_id, status, version, roles_json, valid_until
      FROM main."${TENANT_TABLES.membership}" WHERE id = ? COLLATE BINARY AND kind = 'member'`,
          id,
        ),
      ),
    live: async (anchorId, accountId) =>
      !!get(
        `SELECT 1 FROM main."${TENANT_TABLES.membership}" WHERE tenant_id = ? COLLATE BINARY
      AND account_id = ? COLLATE BINARY AND kind = 'member' AND status <> 'revoked'`,
        anchorId,
        accountId,
      ),
    // BEGIN IMMEDIATE already excludes every other writer, so these need no
    // lock of their own; the order still matches PostgreSQL's.
    supportUnder: async (parentId) =>
      Object.freeze(
        many(
          `SELECT ${MEMBER_COLUMNS} FROM main."${TENANT_TABLES.membership}"
      WHERE parent_id = ? COLLATE BINARY AND kind = 'support' AND status = 'active' ORDER BY id COLLATE BINARY`,
          parentId,
        ).map((row) => supportMemberRow({ ...row })),
      ),
    support: async (id) => {
      const row = get(
        `SELECT ${MEMBER_COLUMNS} FROM main."${TENANT_TABLES.membership}"
        WHERE id = ? COLLATE BINARY AND kind = 'support'`,
        id,
      );
      return row ? supportMemberRow({ ...row }) : null;
    },
    revokeSupport: async (id, expectedVersion) => {
      assertCurrent();
      const result = db
        .prepare(
          `UPDATE main."${TENANT_TABLES.membership}" SET status = 'revoked', version = ?
        WHERE id = ? COLLATE BINARY AND kind = 'support' AND status = 'active' AND version = ?`,
        )
        .run(next(expectedVersion), id, expectedVersion);
      if (result.changes !== 1) refuse(STALE);
    },
    audit: async () => {
      assertCurrent();
      if (!get(supportAuditTables)) return null;
      try {
        const key = supportAuditKey();
        assertSqliteSupportAudit(db, owner, key);
        return createSqliteSupportAuditOwner(db, operations, owner, key, assertCurrent);
      } catch {
        return refuse(SUPPORT_AUDIT_NEEDED);
      }
    },
  };
}
function postgresStep(client: PgQuery, operations: TransactionOperations, owner: TenantStoreBinding, assertCurrent: () => void): Step {
  const get = async (sql: string, params: (string | number)[]) => {
    assertCurrent();
    const rows = (await client.query(sql, params)).rows;
    assertCurrent();
    if (rows.length > 1) return refuse(STALE);
    return rows[0] as Record<string, unknown> | undefined;
  };
  const many = async (sql: string, params: (string | number)[]) => {
    assertCurrent();
    const rows = (await client.query(sql, params)).rows;
    assertCurrent();
    return rows as Record<string, unknown>[];
  };
  /** A bigint instant renders as text, as the support owner's facts read it. */
  const supportColumns = MEMBER_COLUMNS.replace('valid_until', 'valid_until::text AS valid_until');
  return {
    rows: postgresSandboxSession(client, assertCurrent),
    store: createPostgresTenantAdministration(client, operations, owner, assertCurrent),
    journal: createPostgresTenantAdministrationJournal(client, operations, owner, assertCurrent),
    anchor: async (id, kind) =>
      anchorImage(
        await get(
          `SELECT id, status, version FROM ${runtimeTable('postgres', TENANT_TABLES.tenant)}
      WHERE id = $1 AND kind = $2 FOR UPDATE`,
          [id, kind],
        ),
      ),
    member: async (id) =>
      memberImage(
        await get(
          `SELECT id, tenant_id, account_id, status, version, roles_json, valid_until::float8 AS valid_until
      FROM ${runtimeTable('postgres', TENANT_TABLES.membership)} WHERE id = $1 AND kind = 'member' FOR UPDATE`,
          [id],
        ),
      ),
    live: async (anchorId, accountId) =>
      !!(await get(
        `SELECT id FROM ${runtimeTable('postgres', TENANT_TABLES.membership)} WHERE tenant_id = $1
      AND account_id = $2 AND kind = 'member' AND status <> 'revoked' FOR UPDATE`,
        [anchorId, accountId],
      )),
    // Locators read without locks; the caller rechecks each against its locked
    // row, and a locator that moved refuses rather than being followed.
    supportUnder: async (parentId) =>
      Object.freeze(
        (
          await many(
            `SELECT ${supportColumns} FROM ${runtimeTable('postgres', TENANT_TABLES.membership)}
      WHERE parent_id = $1 AND kind = 'support' AND status = 'active' ORDER BY id`,
            [parentId],
          )
        ).map((row) => supportMemberRow({ ...row })),
      ),
    support: async (id) => {
      const row = await get(
        `SELECT ${supportColumns} FROM ${runtimeTable('postgres', TENANT_TABLES.membership)}
        WHERE id = $1 AND kind = 'support' FOR UPDATE`,
        [id],
      );
      return row ? supportMemberRow({ ...row }) : null;
    },
    revokeSupport: async (id, expectedVersion) => {
      assertCurrent();
      const result = await client.query(
        `UPDATE ${runtimeTable('postgres', TENANT_TABLES.membership)} SET status = 'revoked', version = $1
        WHERE id = $2 AND kind = 'support' AND status = 'active' AND version = $3`,
        [next(expectedVersion), id, expectedVersion],
      );
      assertCurrent();
      if (result.rowCount !== 1) refuse(STALE);
    },
    audit: async () => {
      assertCurrent();
      if (!(await describePostgresRelations(client, SUPPORT_AUDIT_PREFIX)).length) return null;
      assertCurrent();
      try {
        const key = supportAuditKey();
        await assertPostgresSupportAudit(client, owner, key);
        return createPostgresSupportAuditOwner(client, operations, owner, key, assertCurrent);
      } catch {
        return refuse(SUPPORT_AUDIT_NEEDED);
      }
    },
  };
}

/** One maintenance transaction: the journal (and the store beneath it)
 * attested at its start and again before COMMIT, linked invitations, where
 * provisioned, consistent at both ends. */
async function transact<T>(where: unknown, owner: TenantStoreBinding, work: (step: Step) => Promise<T>): Promise<T> {
  const at = targetOf(where);
  try {
    if ('sqlite' in at) {
      const writer = new SqliteAdapter(at.sqlite, 'Tenant maintenance');
      try {
        let invitations = false;
        return await writer.runtimeMaintenanceTransaction(
          (db) => {
            assertSqliteTenantAdministrationJournal(db, owner);
            invitations = !!db.prepare(invitationTables).get();
          },
          async (db, operations, assertCurrent) => {
            if (invitations) assertLinkedTenantInvitations(db, owner);
            // Every facade call is awaited in the work, so its queue has drained.
            const result = await work(sqliteStep(db, operations, owner, assertCurrent));
            if (invitations) assertLinkedTenantInvitations(db, owner);
            return result;
          },
        );
      } finally {
        await writer.close().catch(() => {});
      }
    }
    const writer = new PostgresAdapter(at.postgres, 'Tenant maintenance');
    try {
      return await writer.runtimeMaintenanceTransaction(
        async (client) => {
          await assertPostgresTenantAdministrationJournal(client, owner);
          if (await postgresInvitationStoragePresent(client)) await assertLinkedPostgresTenantInvitations(client, owner);
        },
        (client, operations, assertCurrent) => work(postgresStep(client, operations, owner, assertCurrent)),
      );
    } finally {
      await writer.close().catch(() => {});
    }
  } catch (error) {
    if (error instanceof TenantMaintenanceRefusal) throw error;
    if (error instanceof TransactionOutcomeUnknown) {
      throw new TenantMaintenanceRefusal(
        'The commit was sent and its answer lost: the change may or may not have applied. Read the store before retrying.',
        'unknown',
      );
    }
    throw new TenantMaintenanceRefusal(
      'The tenant store refused the change and nothing was written: a version that is no longer current, ' +
        "a missing or closed row, a live membership already there, or a store and journal that are not this binding's.",
    );
  }
}

/** The receipt and its audit, in the step's transaction. A fresh key: every
 * maintenance call is its own attempt, recovered by reading the store. */
async function record(
  step: Step,
  owner: TenantStoreBinding,
  operator: string,
  operation: MaintenanceOperation,
  tenantId: string,
  intent: Record<string, unknown>,
  change: MaintenanceChange,
): Promise<string> {
  const resultJson = JSON.stringify(captureMaintenanceChange(change, operation, tenantId));
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        'mistri:tenant-maintenance:v1',
        owner.appId,
        owner.storeId,
        owner.source.id,
        operation,
        tenantId,
        Object.keys(intent)
          .sort()
          .map((key) => [key, intent[key]]),
      ]),
    )
    .digest('hex');
  const id = randomUUID();
  await step.journal.commit(
    {
      id,
      actorId: `${MAINTENANCE_ACTOR_PREFIX}${operator}`,
      tenantId,
      operation,
      operationVersion: 1,
      idempotencyKey: randomUUID(),
      fingerprint,
      requestId: randomUUID(),
      completedAt: new Date().toISOString(),
      resultJson,
    },
    {
      policyId: MAINTENANCE_POLICY.id,
      policyVersion: MAINTENANCE_POLICY.version,
      deployment: 'maintenance',
      sessionId: `${MAINTENANCE_ACTOR_PREFIX}${randomUUID()}`,
      changeJson: resultJson,
    },
  );
  return id;
}
const next = (version: string) => String(BigInt(version) + 1n);

/**
 * The support memberships a revoked platform membership ends, in the same
 * transaction: each live one under `membershipId` is revoked and its audit
 * chain closed with end reason `parent_revoked`. Their ids go in the receipt.
 *
 * The locks continue the order every support fence takes. The caller already
 * holds `@platform` and the parent membership; this adds the dealers and then
 * the support rows, each in byte order, so a revocation racing an opening
 * waits on it instead of deadlocking. Locators are read without locks and
 * rechecked against the locked row; one that moved refuses the step.
 *
 * The end reason lives in the audit session, so ending a session appends an
 * `exit` entry to its chain. What keeps a lease out is the membership row, so
 * a store with no support audit at all, or a session already closed, is still
 * revoked rather than left live — revocation never waits on a record it
 * cannot repair.
 *
 * Nor does it wait on a record someone has damaged. A chain that exists and
 * does not verify once refused this whole step, which handed anyone able to
 * edit an audit row a way to keep the access that row covers: corrupt the
 * chain, and the revocation that would cut it off refuses. So the row is
 * revoked either way, and the session's id is returned as unverifiable for
 * the receipt to state. The chain is asked with `verify`, which answers,
 * rather than `readHeader`, which refuses — and a refused queue operation
 * would fail the transaction at its drain however it were caught.
 *
 * A missing key or a layout that is not this one still refuses (`step.audit`),
 * because that is repairable: set the key the audit was provisioned with and
 * revoke again, and the end is recorded properly.
 */
async function endSupportUnder(
  step: Step,
  membershipId: string,
  endedAt: string,
  operator: string,
): Promise<{
  readonly ended: readonly string[];
  readonly unverified: readonly string[];
}> {
  const none = Object.freeze({
    ended: Object.freeze([]),
    unverified: Object.freeze([]),
  });
  const located = await step.supportUnder(membershipId);
  if (!located.length) return none;
  const dealers = new Map<string, MaintenanceAnchorImage | null>();
  for (const tenantId of sorted(located.map((row) => row.tenantId))) dealers.set(tenantId, await step.anchor(tenantId, 'tenant'));
  const rows = new Map<string, SupportMember | null>();
  for (const id of sorted(located.map((row) => row.id))) rows.set(id, await step.support(id));
  const audit = await step.audit();
  const ended: string[] = [],
    unverified: string[] = [];
  for (const locator of located) {
    const row = rows.get(locator.id) ?? null,
      dealer = dealers.get(locator.tenantId) ?? null;
    if (!row || !isDeepStrictEqual(row, locator) || row.parentId !== membershipId || !dealer) return refuse(STALE);
    // null: no session of that id, so there is no chain to close.
    const intact = audit ? await audit.audit.verify(row.id) : null;
    if (audit && intact === true) {
      const header = await audit.readHeader(row.id);
      if (header && header.session.endedAt === null) {
        await audit.audit.append(row.id, {
          kind: 'exit',
          at: endedAt,
          requestId: randomUUID(),
          actorId: `${MAINTENANCE_ACTOR_PREFIX}${operator}`,
          tenantVersion: dealer.version,
          supportMembershipVersion: row.version,
          parentMembershipVersion: row.parentVersion!,
          platformVersion: row.platformVersion!,
          resource: null,
          operation: null,
          keyJson: null,
          detailJson: JSON.stringify({ endReason: 'parent_revoked' }),
          commandReceiptId: null,
        });
      }
    } else if (intact === false) unverified.push(row.id);
    await step.revokeSupport(row.id, row.version);
    ended.push(row.id);
  }
  return Object.freeze({
    ended: Object.freeze(ended.sort(utf8)),
    unverified: Object.freeze(unverified.sort(utf8)),
  });
}

/* ---------- the steps ---------- */

export interface TenantAnchorResult {
  readonly version: string;
  readonly status: AnchorStatus;
  readonly receiptId: string;
}
export interface MembershipResult {
  readonly membershipId: string;
  readonly version: string;
  readonly receiptId: string;
}

/** Create a tenant (`expectedVersion: null`, which starts it active) or change
 * its status: suspend, reactivate, or close it for good. */
export async function putTenant(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{
    tenantId: string;
    status: AnchorStatus;
    expectedVersion: string | null;
    operator: string;
  }>,
): Promise<TenantAnchorResult> {
  const value = request(input, ['tenantId', 'status', 'expectedVersion', 'operator'], 'putTenant');
  const owner = bindingOf(binding),
    tenantId = tenantOf(value.tenantId),
    status = statusOf(value.status);
  const expectedVersion = versionOf(value.expectedVersion, true),
    operator = operatorOf(value.operator);
  if (expectedVersion === null && status !== 'active') refuse('A new tenant starts active.');
  return transact(where, owner, async (step) => {
    const before = await step.anchor(tenantId, 'tenant');
    if (expectedVersion === null ? before : !before || before.version !== expectedVersion) return refuse(STALE);
    if (before?.status === 'closed') return refuse('The tenant is closed, and closing is for good.');
    await step.store.putTenant({ tenantId, status, expectedVersion });
    const after = Object.freeze({
      tenantId,
      status,
      version: before ? next(before.version) : '1',
    });
    const receiptId = await record(
      step,
      owner,
      operator,
      'putTenant',
      tenantId,
      { tenantId, status, expectedVersion },
      { operation: 'putTenant', before, after },
    );
    return Object.freeze({ status, version: after.version, receiptId });
  });
}

/* ---------- sandboxes ---------- */

function planOf(value: unknown): TenantClonePlan {
  if (!isTenantClonePlan(value)) return refuse("plan is the App's clone plan, as startup computed it (tenantClonePlan).");
  return value;
}
/** The sandbox store on this step's transaction, or a refusal naming the provisioning step. */
async function sandboxesOf(step: Step, owner: TenantStoreBinding) {
  let present = false;
  try {
    present = await sandboxStorePresent(step.rows);
  } catch {
    return refuse('The sandbox store is not the layout this mistri provisions.');
  }
  if (!present)
    return refuse(
      "The sandbox store is not provisioned: run provisionStores(<the database>, { only: ['tenant-sandboxes'] }) from @mistriwork/mistri/maintenance first.",
    );
  return sandboxRows(step.rows, owner.appId);
}
/** A clone's or an import's own refusal, in its own words, and a statement
 * the database refused in the database's: the operator reading
 * it needs the column the copy tripped on, not the store's list of causes.
 * Anything else is the store's. */
async function cloneWork<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof TenantCloneConflict) return refuse(error.message);
    const said = databaseSaid(error);
    if (said) return refuse(`The tenant store refused the copy and nothing was written. The database said: ${said}`);
    throw error;
  }
}
/* A statement's refusal by the engine itself: PostgreSQL's carries a SQLSTATE
   and a severity, node:sqlite's its own code. Never a driver's lost connection. */
function databaseSaid(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  const engine = (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) && typeof severity === 'string') || code === 'ERR_SQLITE_ERROR';
  return engine && error.message ? error.message : undefined;
}

interface TenantCloneResult {
  readonly version: '1';
  /** Rows copied, by resource. */
  readonly rows: Readonly<Record<string, number>>;
  readonly receiptId: string;
}
/**
 * Clone the source tenant into a fresh sandbox tenant: its configuration, and
 * its samples when `samples` is true. Both tenant rows are locked; the new
 * tenant must not exist, the source must be active and no sandbox itself. The
 * copy names no other tenant (tenantCloneEngine.ts), and its receipt commits
 * with it. No membership is made: grant the sandbox's members as for any tenant.
 */
export async function cloneTenantSandbox(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{
    plan: TenantClonePlan;
    sourceTenantId: string;
    tenantId: string;
    samples: boolean;
    operator: string;
  }>,
): Promise<TenantCloneResult> {
  const value = request(input, ['plan', 'sourceTenantId', 'tenantId', 'samples', 'operator'], 'cloneTenantSandbox');
  const owner = bindingOf(binding),
    plan = planOf(value.plan),
    operator = operatorOf(value.operator),
    tenantId = tenantOf(value.tenantId),
    sourceTenantId = tenantOf(value.sourceTenantId);
  if (typeof value.samples !== 'boolean') refuse('samples is true or false.');
  if (plan.appId !== owner.appId) refuse(`The plan is "${plan.appId}"'s, not "${owner.appId}"'s, the App this binding names.`);
  if (tenantId === sourceTenantId) refuse('A tenant is not cloned into itself.');
  const samples = value.samples as boolean;
  return transact(where, owner, async (step) => {
    const sandboxes = await sandboxesOf(step, owner);
    const anchors = new Map<string, MaintenanceAnchorImage | null>();
    for (const id of sorted([tenantId, sourceTenantId])) anchors.set(id, await step.anchor(id, 'tenant'));
    const source = anchors.get(sourceTenantId) ?? null;
    if (anchors.get(tenantId)) return refuse(`"${tenantId}" already exists; a clone makes a new tenant.`);
    if (source?.status !== 'active') return refuse(`"${sourceTenantId}" must exist and be active.`);
    if (await sandboxes.read(sourceTenantId)) return refuse(`"${sourceTenantId}" is a sandbox; a sandbox is not cloned again.`);
    await step.store.putTenant({
      tenantId,
      status: 'active',
      expectedVersion: null,
    });
    await sandboxes.create({
      tenantId,
      sourceTenantId,
      samples,
      createdAt: new Date().toISOString(),
    });
    const copied = await cloneWork(() =>
      copyTenant(step.rows, plan, sandboxes, {
        sourceTenantId,
        tenantId,
        samples,
      }),
    );
    const after = Object.freeze({
      tenantId,
      status: 'active' as const,
      version: '1',
    });
    const receiptId = await record(
      step,
      owner,
      operator,
      'cloneSandbox',
      tenantId,
      { tenantId, sourceTenantId, samples },
      {
        operation: 'cloneSandbox',
        source,
        after,
        samples,
        rows: Object.values(copied.rows).reduce((sum, n) => sum + n, 0),
      },
    );
    return Object.freeze({
      version: '1' as const,
      rows: copied.rows,
      receiptId,
    });
  });
}

/**
 * What importing the sandbox into its live tenant would change, and what
 * conflicts. Read only: the import itself is the live tenant's owner's to
 * approve, in Manage tenants, through its own membership.
 */
export async function readSandboxImport(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{ plan: TenantClonePlan; sandboxTenantId: string }>,
): Promise<ImportPlan & { readonly tenantId: string }> {
  const value = request(input, ['plan', 'sandboxTenantId'], 'readSandboxImport');
  const owner = bindingOf(binding),
    plan = planOf(value.plan),
    sandboxTenantId = tenantOf(value.sandboxTenantId);
  return transact(where, owner, async (step) => {
    const sandboxes = await sandboxesOf(step, owner);
    const sandbox = await sandboxes.read(sandboxTenantId);
    if (!sandbox) return refuse(`"${sandboxTenantId}" is not a sandbox.`);
    const planned = await cloneWork(() =>
      planImport(step.rows, plan, sandboxes, {
        tenantId: sandbox.sourceTenantId,
        sandboxTenantId,
      }),
    );
    return Object.freeze({
      ...planned.summary,
      tenantId: sandbox.sourceTenantId,
    });
  });
}

/**
 * Set a sandbox's dev clock: how far ahead of real time it reads, and how
 * fast it runs, from now (tenantSandboxClock.ts). Only a sandbox has one: a
 * live tenant is refused, and nothing about its time can be changed here.
 */
export async function setSandboxClock(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{
    tenantId: string;
    skewMs: number;
    rate: number;
    operator: string;
  }>,
): Promise<Readonly<{ clock: SandboxClock; receiptId: string }>> {
  const value = request(input, ['tenantId', 'skewMs', 'rate', 'operator'], 'setSandboxClock');
  const owner = bindingOf(binding),
    operator = operatorOf(value.operator),
    tenantId = tenantOf(value.tenantId);
  let clock: SandboxClock;
  try {
    clock = captureSandboxClock({ skewMs: value.skewMs, rate: value.rate }, Date.now());
  } catch (error) {
    return refuse((error as Error).message);
  }
  return transact(where, owner, async (step) => {
    const sandboxes = await sandboxesOf(step, owner);
    const anchor = await step.anchor(tenantId, 'tenant');
    const sandbox = await sandboxes.read(tenantId);
    if (!anchor || !sandbox) return refuse(`"${tenantId}" is not a sandbox: only a sandbox has a dev clock, never a live tenant.`);
    await sandboxes.setClock(tenantId, clock);
    const receiptId = await record(
      step,
      owner,
      operator,
      'setSandboxClock',
      tenantId,
      { tenantId, skewMs: clock.skewMs, rate: clock.rate },
      {
        operation: 'setSandboxClock',
        anchor,
        before: sandbox.clock,
        after: clock,
      },
    );
    return Object.freeze({ clock, receiptId });
  });
}

/** Create the platform's `@platform` row (`expectedVersion: null`, active) or
 * change its status. Suspending it stops the whole platform realm. */
export async function setPlatformStatus(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{
    status: AnchorStatus;
    expectedVersion: string | null;
    operator: string;
  }>,
): Promise<TenantAnchorResult> {
  const value = request(input, ['status', 'expectedVersion', 'operator'], 'setPlatformStatus');
  const owner = bindingOf(binding),
    status = statusOf(value.status);
  const expectedVersion = versionOf(value.expectedVersion, true),
    operator = operatorOf(value.operator);
  if (expectedVersion === null && status !== 'active') refuse('The platform row starts active.');
  return transact(where, owner, async (step) => {
    const before = await step.anchor(PLATFORM_TENANT_ID, 'platform');
    if (expectedVersion === null ? before : !before || before.version !== expectedVersion) return refuse(STALE);
    if (before?.status === 'closed') return refuse('The platform row is closed, and closing is for good.');
    await step.store.putPlatform({ status, expectedVersion });
    const after = Object.freeze({
      tenantId: PLATFORM_TENANT_ID,
      status,
      version: before ? next(before.version) : '1',
    });
    const receiptId = await record(
      step,
      owner,
      operator,
      'setPlatformStatus',
      PLATFORM_TENANT_ID,
      { status, expectedVersion },
      { operation: 'setPlatformStatus', before, after },
    );
    return Object.freeze({ status, version: after.version, receiptId });
  });
}

/** One platform membership for an existing account, with platform-realm roles
 * of the App at `app`. `@platform` must be active, and the account must hold
 * no live platform membership: replace one by revoking it first. */
export async function grantPlatformMembership(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{
    app: string;
    accountId: string;
    roles: readonly string[];
    validUntil: number;
    operator: string;
  }>,
): Promise<MembershipResult> {
  const value = request(input, ['app', 'accountId', 'roles', 'validUntil', 'operator'], 'grantPlatformMembership');
  const owner = bindingOf(binding),
    operator = operatorOf(value.operator),
    accountId = text(value.accountId, 1024, 'accountId');
  targetOf(where);
  const loaded = await appOf(value.app, owner);
  const roles = rolesOf(value.roles, ceilingOf(loaded, 'platform'), 'platform');
  const validUntil = validUntilOf(value.validUntil, Date.now());
  await assertAccount(loaded, accountId);
  return transact(where, owner, async (step) => {
    const anchor = await step.anchor(PLATFORM_TENANT_ID, 'platform');
    if (!anchor || anchor.status !== 'active')
      return refuse('The platform row (@platform) must exist and be active: setPlatformStatus creates it.');
    if (await step.live(PLATFORM_TENANT_ID, accountId))
      return refuse('That account already holds a live platform membership; revoke it first.');
    const membershipId = randomUUID();
    await step.store.putPlatformMembership({
      accountId,
      membershipId,
      status: 'active',
      roles,
      validUntil,
      expectedVersion: null,
    });
    const membership = Object.freeze({
      membershipId,
      tenantId: PLATFORM_TENANT_ID,
      accountId,
      status: 'active' as const,
      version: '1',
      roles,
      validUntil,
    });
    const receiptId = await record(
      step,
      owner,
      operator,
      'grantPlatformMembership',
      PLATFORM_TENANT_ID,
      { accountId, roles: [...roles].sort(), validUntil },
      { operation: 'grantPlatformMembership', anchor, membership },
    );
    return Object.freeze({ membershipId, version: '1', receiptId });
  });
}

/** Revoke one platform membership at its current version; revocation is
 * terminal. The support sessions opened under it end with it, in this same
 * transaction and with end reason `parent_revoked` (see endSupportUnder); the
 * receipt names the ones it ended, and `supportChainUnverified` names those
 * whose audit chain did not verify, so ending access is never blockable by
 * damaging the record of it. */
export async function revokePlatformMembership(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{
    membershipId: string;
    expectedVersion: string;
    operator: string;
  }>,
): Promise<
  MembershipResult & {
    readonly supportRevoked: readonly string[];
    readonly supportChainUnverified: readonly string[];
  }
> {
  const value = request(input, ['membershipId', 'expectedVersion', 'operator'], 'revokePlatformMembership');
  const owner = bindingOf(binding),
    operator = operatorOf(value.operator),
    membershipId = text(value.membershipId, 1024, 'membershipId');
  const expectedVersion = versionOf(value.expectedVersion, false)!;
  return transact(where, owner, async (step) => {
    // The anchor first: the lock order every fence on this realm shares.
    const anchor = await step.anchor(PLATFORM_TENANT_ID, 'platform');
    const before = await step.member(membershipId);
    if (!anchor || !before || before.tenantId !== PLATFORM_TENANT_ID || before.status === 'revoked' || before.version !== expectedVersion)
      return refuse(STALE);
    await step.store.putPlatformMembership({
      accountId: before.accountId,
      membershipId,
      status: 'revoked',
      roles: before.roles,
      validUntil: before.validUntil,
      expectedVersion,
    });
    const { ended: supportRevoked, unverified: supportChainUnverified } = await endSupportUnder(
      step,
      membershipId,
      new Date().toISOString(),
      operator,
    );
    const after = Object.freeze({
      ...before,
      status: 'revoked' as const,
      version: next(before.version),
    });
    const receiptId = await record(
      step,
      owner,
      operator,
      'revokePlatformMembership',
      PLATFORM_TENANT_ID,
      { membershipId, expectedVersion },
      {
        operation: 'revokePlatformMembership',
        anchor,
        before,
        after,
        supportRevoked,
        supportChainUnverified,
      },
    );
    return Object.freeze({
      membershipId,
      version: after.version,
      receiptId,
      supportRevoked,
      supportChainUnverified,
    });
  });
}

/** One active tenant membership for an existing account, with tenant-realm
 * roles of the App at `app`. The tenant must be active, and the account must
 * hold no live membership in it (an active one, or a pending invitation's). */
export async function grantTenantMembership(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{
    app: string;
    tenantId: string;
    accountId: string;
    roles: readonly string[];
    validUntil: number;
    operator: string;
  }>,
): Promise<MembershipResult> {
  const value = request(input, ['app', 'tenantId', 'accountId', 'roles', 'validUntil', 'operator'], 'grantTenantMembership');
  const owner = bindingOf(binding),
    operator = operatorOf(value.operator),
    tenantId = tenantOf(value.tenantId);
  const accountId = text(value.accountId, 1024, 'accountId');
  targetOf(where);
  const loaded = await appOf(value.app, owner);
  const roles = rolesOf(value.roles, ceilingOf(loaded, 'tenant'), 'tenant');
  const validUntil = validUntilOf(value.validUntil, Date.now());
  await assertAccount(loaded, accountId);
  return transact(where, owner, async (step) => {
    const anchor = await step.anchor(tenantId, 'tenant');
    if (!anchor || anchor.status !== 'active') return refuse('The tenant must exist and be active.');
    if (await step.live(tenantId, accountId)) return refuse('That account already holds a live membership in this tenant.');
    const membershipId = randomUUID();
    await step.store.putMembership({
      tenantId,
      accountId,
      membershipId,
      status: 'active',
      roles,
      validUntil,
      expectedVersion: null,
    });
    const membership = Object.freeze({
      membershipId,
      tenantId,
      accountId,
      status: 'active' as const,
      version: '1',
      roles,
      validUntil,
    });
    const receiptId = await record(
      step,
      owner,
      operator,
      'grantTenantMembership',
      tenantId,
      { tenantId, accountId, roles: [...roles].sort(), validUntil },
      { operation: 'grantTenantMembership', anchor, membership },
    );
    return Object.freeze({ membershipId, version: '1', receiptId });
  });
}

/** Revoke one active tenant membership at its current version; revocation is
 * terminal. Idempotent: a membership already revoked is left as it is and
 * answered with its version and `receiptId: null`, so a caller cleaning up
 * after itself (mistri shot) can run it again without a refusal. An
 * invitation's pending membership is withdrawn with its invitation, through
 * tenant administration, not here. */
export async function revokeTenantMembership(
  where: TenantMaintenanceTarget,
  binding: TenantStoreBinding,
  input: Readonly<{
    tenantId: string;
    membershipId: string;
    expectedVersion: string;
    operator: string;
  }>,
): Promise<Omit<MembershipResult, 'receiptId'> & { readonly receiptId: string | null }> {
  const value = request(input, ['tenantId', 'membershipId', 'expectedVersion', 'operator'], 'revokeTenantMembership');
  const owner = bindingOf(binding),
    operator = operatorOf(value.operator),
    tenantId = tenantOf(value.tenantId);
  const membershipId = text(value.membershipId, 1024, 'membershipId'),
    expectedVersion = versionOf(value.expectedVersion, false)!;
  return transact(where, owner, async (step) => {
    // The anchor first: the lock order every fence on this tenant shares.
    const anchor = await step.anchor(tenantId, 'tenant');
    const before = await step.member(membershipId);
    if (!anchor || !before || before.tenantId !== tenantId) return refuse(STALE);
    if (before.status === 'revoked')
      return Object.freeze({
        membershipId,
        version: before.version,
        receiptId: null,
      });
    if (before.status !== 'active') return refuse("That membership is an invitation's: withdraw the invitation instead.");
    if (before.version !== expectedVersion) return refuse(STALE);
    await step.store.putMembership({
      tenantId,
      accountId: before.accountId,
      membershipId,
      status: 'revoked',
      roles: before.roles,
      validUntil: before.validUntil,
      expectedVersion,
    });
    const after = Object.freeze({
      ...before,
      status: 'revoked' as const,
      version: next(before.version),
    });
    const receiptId = await record(
      step,
      owner,
      operator,
      'revokeTenantMembership',
      tenantId,
      { tenantId, membershipId, expectedVersion },
      { operation: 'revokeTenantMembership', anchor, before, after },
    );
    return Object.freeze({ membershipId, version: after.version, receiptId });
  });
}

/** The native account with this email in the App's own auth store, or null: `mistri tenant grant` reuses one a
 * first run made, so a first boot that stopped part-way runs again. */
export async function findAppAccount(appDir: string, email: string): Promise<string | null> {
  const loaded = await loadedApp(appDir);
  return accountsOf(loaded, (runtime) => findNativeAccountByEmail(runtime, email));
}

/**
 * Native accounts in the App's own auth store, through its native user
 * creation, one per `{ email, name, password }`, with the store's default
 * native role. Their ids, in order. Every address is checked first: one that
 * already has an account refuses the whole call before any is made. A
 * failure part-way (the store went away) is `unknown` and names how many were
 * made. Passwords are never logged, returned or repeated in a refusal.
 */
export async function createAppAccounts(appDir: string, accounts: readonly NativeAccountInput[]): Promise<readonly string[]> {
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 256)
    return refuse('accounts is a list of 1 to 256 { email, name, password }.');
  const inputs = accounts.map((account, index) => {
    try {
      return nativeAccountInput(account);
    } catch {
      return refuse(`Account ${index + 1} is not valid: an email address, a name of 1 to 120 characters and a password of 8 to 128.`);
    }
  });
  if (new Set(inputs.map((input) => input.email)).size !== inputs.length) refuse('The same email address is listed twice.');
  const loaded = await loadedApp(appDir);
  // Without email sign-in, the accounts could never sign in with their passwords.
  if (!signInOf(loaded.app.auth)?.providers.includes('email'))
    refuse('The App does not sign in with email (auth.providers), so these accounts could never sign in.');
  return accountsOf(loaded, async (runtime) => {
    const taken: string[] = [];
    for (const input of inputs) if ((await findNativeAccountByEmail(runtime, input.email)) !== null) taken.push(input.email);
    if (taken.length) return refuse(`These addresses already have accounts, so none was created: ${taken.join(', ')}.`);
    const ids: string[] = [];
    for (const input of inputs) {
      try {
        ids.push(await createNativeAccount(runtime, input, { by: 'maintenance' }));
      } catch (error) {
        // Refused before anything went out, and nothing made yet: nothing to look for.
        if (error instanceof NativeAccountRefusal && error.reason !== 'unavailable' && !ids.length)
          return refuse(`${input.email}: ${error.message}`);
        throw new TenantMaintenanceRefusal(
          `${input.email} could not be confirmed as created; the ${ids.length} before it were. ` +
            'Look the addresses up before running this again.',
          'unknown',
        );
      }
    }
    return Object.freeze(ids);
  });
}
