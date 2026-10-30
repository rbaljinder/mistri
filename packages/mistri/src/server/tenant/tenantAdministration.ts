import { randomUUID } from 'node:crypto';
import { statSync, type Stats } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { isPromise, isProxy } from 'node:util/types';
import { isPoolBusy } from '@mistriwork/engine/adapters/poolMetrics.js';
import { Serial, TransactionOutcomeUnknown, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { tenantAdapter } from './tenantConnections.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { SqliteAdapter } from '@mistriwork/engine/adapters/sqlite.js';
import { captureAppAuthRuntime, type AppAuthRuntime, type AppAuthRuntimeBinding, type VerifiedSessionInstance } from '../auth/auth.js';
import { assertAuthStoreSeparation, captureAuthStoreExclusion } from '../auth/authStoreSeparation.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import { WriterRetargeted, writerLifecycle } from './tenantWriterLifecycle.js';
import { createSqliteTenantAdministration, TENANT_TABLES, type TenantStoreAdministration, type TenantStoreBinding } from './tenantStore.js';
import { createPostgresTenantAdministration } from './tenantStorePostgres.js';
import {
  assertPostgresTenantAdministrationJournal,
  createPostgresTenantAdministrationJournal,
} from './tenantAdministrationJournalPostgres.js';
import {
  administrationFingerprint,
  administrationGrant,
  assertAdministrationRoles,
  assertDelegatedTerms,
  captureAdministrationIntent,
  captureAdministrationPolicy,
  DELEGABLE_ADMINISTRATION_OPERATIONS,
  operatorGrant,
  type AdministrationIntent,
  type AdministrationPolicy,
  type DelegableAdministrationOperation,
} from './tenantAdministrationModel.js';
import {
  assertDelegateMembership,
  decodeDelegateMembership,
  decodeDelegateTenants,
  delegateCeiling,
  type DelegateMembership,
} from './tenantDelegation.js';
import { createNativeAccount, findNativeAccountByEmail, nativeAccountEmailOf, type NativeAccountInput } from '../auth/authAccounts.js';
import {
  assertSqliteTenantAdministrationJournal,
  createSqliteTenantAdministrationJournal,
  type StoredAdministrationReceipt,
  type TenantAdministrationJournal,
} from './tenantAdministrationJournal.js';
import { postgresAssistantSwitch, sqliteAssistantSwitch, type AssistantSwitchStore } from './tenantAssistantSwitch.js';
import { postgresDecisionSwitch, sqliteDecisionSwitch, type DecisionSwitchStore } from './tenantDecisionSwitch.js';
import { assistantSwitch } from './tenantAdministrationModel.js';
import type {
  AdministrationAssistantImage as AssistantImage,
  AdministrationDecisionSwitch as DecisionSwitch,
  AdministrationDecisionUsagePage,
  AdministrationUsagePage,
  AdministrationUsageRequest,
  AdministrationTenantImage as TenantImage,
  AdministrationMembershipImage as MembershipImage,
  AdministrationState,
  AdministrationChange,
  AdministrationResult,
  AdministrationAttempt,
  AdministrationSession,
} from '../../shared/tenantAdministration.js';
import {
  ADMINISTRATION_OPERATIONS,
  ASSISTANT_USAGE_MOST,
  DECISION_USAGE_MOST,
  type AdministrationOwner,
  type AdministrationPageRequest,
  type AdministrationTenantPage,
  type AdministrationMembershipPageRequest,
  type AdministrationMembershipPage,
  type AdministrationTenantTarget,
  type AdministrationImportPlan,
  type AdministrationImportPlanRequest,
} from '../../shared/tenantAdministration.js';
import { captureInvitationPolicy, type InvitationPolicy } from './tenantInvitationModel.js';
import { assertSqliteTenantInvitations, createSqliteTenantInvitations } from './tenantInvitationStore.js';
import { captureInvitationChange } from './tenantInvitationChange.js';
import { assertLinkedTenantInvitations } from './tenantInvitationLinks.js';
import { assertLinkedPostgresTenantInvitations, postgresInvitationStoragePresent } from './tenantInvitationLinksPostgres.js';
import { assertPostgresTenantInvitations, createPostgresTenantInvitations } from './tenantInvitationStorePostgres.js';
import { createTenantInvitationOperations, type TenantInvitations } from './tenantInvitationOperations.js';
import { createSqliteInvitationTransaction, type InvitationTransaction } from './tenantInvitationTransaction.js';
import { createPostgresInvitationTransaction } from './tenantInvitationTransactionPostgres.js';
import { assertSqliteSupportAudit, createSqliteSupportAuditOwner } from './tenantSupportAudit.js';
import type { SupportAuditKey, SupportAuditOwner } from './tenantSupportAuditContract.js';
import type { TenantClonePlan } from './tenantClonePlan.js';
import { CLONE_ROWS_MOST, copyTenant, planImport } from './tenantCloneEngine.js';
import {
  assertSandboxStore,
  postgresSandboxSession,
  sandboxRows,
  sandboxStorePresent,
  sqliteSandboxSession,
  type SandboxSession,
} from './tenantSandboxStore.js';
import {
  prepareSupportReceiptRecovery,
  type SupportReceiptRecoveryOptions,
  type SupportReceiptRecovery,
} from './tenantSupportReceiptRecovery.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

export class TenantAdministrationFailure extends Error {
  readonly code = 'tenant_administration_unavailable';
  constructor(readonly outcome: 'not_applied' | 'unknown') {
    super('The administration operation could not be confirmed.');
    this.name = 'TenantAdministrationFailure';
  }
}
export interface AdministrationRequest extends AdministrationAttempt {
  readonly expectedAccount: string;
  readonly context: string;
}
export interface TenantAdministration {
  /** The named SCIM directory's hold on its tenant, when this owner was opened with it. */
  directory?(name: string): TenantDirectory;
  readonly invitations?: TenantInvitations;
  /** Explicit native-login ownership, available before business tenant selection.
   * Null means this signed-in account has no administration grant. */
  open(request: IncomingMessage, input: { readonly expectedAccount: string }): Promise<AdministrationSession | null>;
  tenants(request: IncomingMessage, input: AdministrationPageRequest): Promise<AdministrationTenantPage>;
  memberships(request: IncomingMessage, input: AdministrationMembershipPageRequest): Promise<AdministrationMembershipPage>;
  execute(request: IncomingMessage, input: AdministrationRequest): Promise<AdministrationResult>;
  /** Assistant tokens by tenant and day, for an account that may set some tenant's assistant as an operator. */
  usage(request: IncomingMessage, input: AdministrationUsageRequest): Promise<AdministrationUsagePage>;
  /** Decision calls, units and cost by tenant and day, for an account that may set some tenant's decisions as an operator. */
  decisionUsage(request: IncomingMessage, input: AdministrationUsageRequest): Promise<AdministrationDecisionUsagePage>;
  /** Exact-intent recovery, authorized independently of current business membership. */
  status(request: IncomingMessage, input: AdministrationRequest): Promise<AdministrationResult | null>;
  /** What importing a sandbox into its live tenant would change, and what conflicts: for the live tenant's owner, who approves it. */
  importPlan(request: IncomingMessage, input: AdministrationImportPlanRequest): Promise<AdministrationImportPlan>;
  retire(): Promise<void>;
}
export interface TenantAdministrationOptions {
  /** Exactly one: the SQLite business file, or a PostgreSQL source's resolved
   * URL, which is never logged. */
  readonly path?: string;
  readonly url?: string;
  readonly binding: TenantStoreBinding;
  /** Borrowed genuine runtime; its composition owner retires us before closing it. */
  readonly auth: AppAuthRuntime;
  readonly policy?: AdministrationPolicy;
  readonly invitations?: InvitationPolicy;
  readonly deployment: string;
  readonly now?: () => number;
  readonly maxLifetimeMs?: number;
  /** The App declares an assistant: its per-tenant switch is an operation here (tenantAssistantSwitch.ts). */
  readonly assistant?: true;
  /** The providers the App's decisions name: each one's per-tenant switch is an operation here (tenantDecisionSwitch.ts). */
  readonly decisions?: readonly string[];
  /** SCIM directory name → the tenant whose members it manages (auth/scimDirectory.ts). */
  readonly directories?: Readonly<Record<string, string>>;
  /** The App marks resources clone: cloning a tenant into a sandbox, and importing one back, are operations here (tenantClonePlan.ts). */
  readonly clone?: TenantClonePlan;
}

/** One SCIM directory's hold on its tenant's member rows. */
interface TenantDirectory {
  /** Make the account an active member with exactly these roles; `null` revokes
   * its live membership. Resolves whether a row changed. */
  apply(accountId: string, roles: readonly string[] | null): Promise<boolean>;
}

function exact(value: unknown, fields: readonly string[], optional: readonly string[] = []): asserts value is Record<string, unknown> {
  tenantRecord(value, [...fields, ...optional]);
  if (fields.some((field) => !Object.hasOwn(value, field))) denyTenant();
}
function revision(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length > 128 || !/^[1-9][0-9]*$/.test(value)) denyTenant();
}
function next(value: string): string {
  const result = String(BigInt(value) + 1n);
  revision(result);
  return result;
}
function time(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) denyTenant();
}
function count(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > CLONE_ROWS_MOST) denyTenant();
}
function tenantImage(value: unknown): asserts value is TenantImage {
  exact(value, ['tenantId', 'status', 'version']);
  tenantIdentifier(value.tenantId, 128);
  parseTenantSelector([value.tenantId]);
  revision(value.version);
  if (!['active', 'suspended', 'closed'].includes(value.status as string)) denyTenant();
}
function membershipImage(value: unknown): asserts value is MembershipImage {
  exact(value, ['membershipId', 'tenantId', 'accountId', 'status', 'version', 'roles', 'validUntil']);
  tenantIdentifier(value.membershipId, 1024);
  tenantIdentifier(value.tenantId, 128);
  parseTenantSelector([value.tenantId]);
  tenantIdentifier(value.accountId, 1024);
  revision(value.version);
  time(value.validUntil);
  if (
    !['active', 'invited', 'revoked'].includes(value.status as string) ||
    !Array.isArray(value.roles) ||
    value.roles.length > 256 ||
    new Set(value.roles).size !== value.roles.length
  )
    return denyTenant();
  for (const role of value.roles) tenantIdentifier(role);
}
function assistantImage(value: unknown): asserts value is AssistantImage {
  exact(value, ['enabled', 'consent']);
  // A stored switch was off and unconsented before it was first set; its consent is otherwise a switch's.
  if (!(value.enabled === false && value.consent === '')) assistantSwitch(value.enabled, value.consent);
}
function decisionImage(value: unknown): asserts value is DecisionSwitch {
  exact(value, ['provider', 'enabled', 'consent']);
  if (typeof value.provider !== 'string' || !/^[a-z]{1,32}$/.test(value.provider)) return denyTenant();
  // As the assistant's: a switch never set was off and unconsented.
  if (!(value.enabled === false && value.consent === '')) assistantSwitch(value.enabled, value.consent);
}
function stateImage(value: unknown): asserts value is AdministrationState {
  exact(value, ['tenant'], ['membership', 'assistant', 'decisions']);
  tenantImage(value.tenant);
  if (Object.hasOwn(value, 'assistant')) assistantImage(value.assistant);
  if (Object.hasOwn(value, 'decisions')) decisionImage(value.decisions);
  if (Object.hasOwn(value, 'membership')) {
    membershipImage(value.membership);
    if (value.membership.tenantId !== value.tenant.tenantId) denyTenant();
  }
}
const sameRoles = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((role) => b.includes(role));

function pagination(input: AdministrationPageRequest, maximumKeyLength: number): number {
  tenantIdentifier(input.expectedAccount, 1024);
  tenantIdentifier(input.context);
  if (Object.hasOwn(input, 'after')) tenantIdentifier(input.after, maximumKeyLength);
  const limit = input.limit === undefined ? 20 : input.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || (Object.hasOwn(input, 'limit') && input.limit === undefined))
    return denyTenant();
  return limit;
}
/** Count and byte bounds apply after authorization. A lookahead can only name
 * another visible item; neither hidden roster totals nor scan positions escape. */
function pageItems<T>(candidates: readonly T[], limit: number, key: (value: T) => string) {
  const items: T[] = [];
  let bytes = 0;
  for (const item of candidates) {
    const size = Buffer.byteLength(JSON.stringify(item));
    if (items.length >= limit || bytes + size > 2_000_000) {
      if (!items.length) return denyTenant();
      return { items, next: key(items[items.length - 1]) };
    }
    items.push(item);
    bytes += size;
  }
  return { items, next: null };
}

/** Stored JSON is not authority. Validate both historical images against the
 * exact operation before releasing them under today's operator role ceiling. */
function captureChange(input: unknown, intent: AdministrationIntent, ceiling: readonly string[]): AdministrationChange {
  const value = captureTenantData(input);
  exact(value, ['operation', 'before', 'after'], ['invitation', 'clone', 'import']);
  if (value.operation !== intent.operation) return denyTenant();
  stateImage(value.after);
  const after = value.after;
  if (after.tenant.tenantId !== intent.tenantId) return denyTenant();
  // Only the switch's own change carries the switch.
  if (intent.operation !== 'setTenantAssistant' && (after.assistant || (value.before as AdministrationState | null)?.assistant))
    return denyTenant();
  if (intent.operation !== 'setTenantDecisions' && (after.decisions || (value.before as AdministrationState | null)?.decisions))
    return denyTenant();
  // A clone's and an import's own account of what they did, and nobody else's.
  if (
    Object.hasOwn(value, 'clone') !== (intent.operation === 'cloneTenant') ||
    Object.hasOwn(value, 'import') !== (intent.operation === 'importTenant')
  )
    return denyTenant();
  if (intent.operation === 'cloneTenant') {
    if (value.before !== null || after.tenant.status !== 'active' || after.tenant.version !== '1') return denyTenant();
    exact(value.clone, ['sourceTenantId', 'samples', 'rows']);
    const clone = value.clone;
    count(clone.rows);
    if (clone.sourceTenantId !== intent.sourceTenantId || clone.samples !== intent.samples) return denyTenant();
    // A delegate who clones is a member of its copy, as of its own tenant: active, new.
    if (after.membership && (after.membership.status !== 'active' || after.membership.version !== '1')) return denyTenant();
    return value as unknown as AdministrationChange;
  }
  if (intent.operation === 'importTenant') {
    stateImage(value.before);
    const before = value.before;
    // The import writes the tenant's records, never its row: an open tab's lease there stays.
    if (
      before.membership ||
      after.membership ||
      before.tenant.tenantId !== intent.tenantId ||
      before.tenant.version !== intent.expectedTenantVersion ||
      before.tenant.status !== 'active' ||
      !isDeepStrictEqual(before.tenant, after.tenant)
    )
      return denyTenant();
    exact(value.import, ['sandboxTenantId', 'inserted', 'updated', 'deleted']);
    const imported = value.import;
    for (const counted of [imported.inserted, imported.updated, imported.deleted]) count(counted);
    if (imported.sandboxTenantId !== intent.sandboxTenantId) return denyTenant();
    return value as unknown as AdministrationChange;
  }
  if (intent.operation === 'createTenant') {
    if (value.before !== null || after.membership || after.tenant.status !== 'active' || after.tenant.version !== '1') return denyTenant();
  } else {
    stateImage(value.before);
    const before = value.before;
    if (before.tenant.tenantId !== intent.tenantId || before.tenant.version !== intent.expectedTenantVersion) return denyTenant();
    if (intent.operation === 'setTenantAssistant') {
      /* The tenant row is read and locked, not written: a new version would end every open tab's lease there. */
      if (
        before.membership ||
        after.membership ||
        !before.assistant ||
        !after.assistant ||
        before.tenant.status === 'closed' ||
        after.tenant.status !== before.tenant.status ||
        after.tenant.version !== before.tenant.version ||
        after.assistant.enabled !== intent.enabled ||
        after.assistant.consent !== intent.consent ||
        (intent.enabled && before.tenant.status !== 'active')
      )
        return denyTenant();
    } else if (intent.operation === 'setTenantDecisions') {
      // As the assistant's: the tenant row is read and locked, not written.
      if (
        before.membership ||
        after.membership ||
        !before.decisions ||
        !after.decisions ||
        before.decisions.provider !== intent.provider ||
        after.decisions.provider !== intent.provider ||
        before.tenant.status === 'closed' ||
        after.tenant.status !== before.tenant.status ||
        after.tenant.version !== before.tenant.version ||
        after.decisions.enabled !== intent.enabled ||
        after.decisions.consent !== intent.consent ||
        (intent.enabled && before.tenant.status !== 'active')
      )
        return denyTenant();
    } else if (intent.operation === 'setTenantStatus') {
      if (
        before.membership ||
        after.membership ||
        before.tenant.status === 'closed' ||
        after.tenant.status !== intent.status ||
        after.tenant.version !== next(before.tenant.version)
      )
        return denyTenant();
    } else {
      if (after.tenant.version !== before.tenant.version || after.tenant.status !== before.tenant.status || !after.membership)
        return denyTenant();
      const member = after.membership;
      if (member.roles.some((role) => !ceiling.includes(role))) return denyTenant();
      if (intent.operation === 'grantMembership') {
        if (
          before.membership ||
          before.tenant.status !== 'active' ||
          member.status !== 'active' ||
          member.version !== '1' ||
          member.accountId !== intent.accountId ||
          !sameRoles(member.roles, intent.roles) ||
          member.validUntil !== intent.validUntil
        )
          return denyTenant();
      } else {
        const previous = before.membership;
        if (
          !previous ||
          previous.status === 'revoked' ||
          previous.membershipId !== intent.membershipId ||
          previous.version !== intent.expectedMembershipVersion ||
          previous.roles.some((role) => !ceiling.includes(role)) ||
          member.membershipId !== previous.membershipId ||
          member.accountId !== previous.accountId ||
          member.version !== next(previous.version)
        )
          return denyTenant();
        if (intent.operation === 'replaceMembership') {
          // Invitations have their own acceptance workflow; role replacement
          // cannot activate a pending invitation as an accidental side effect.
          if (
            before.tenant.status !== 'active' ||
            previous.status !== 'active' ||
            member.status !== 'active' ||
            !sameRoles(member.roles, intent.roles) ||
            member.validUntil !== intent.validUntil
          )
            return denyTenant();
        } else if (member.status !== 'revoked' || !sameRoles(member.roles, previous.roles) || member.validUntil !== previous.validUntil)
          return denyTenant();
      }
    }
  }
  if (Object.hasOwn(value, 'invitation')) {
    if (intent.operation !== 'revokeMembership') return denyTenant();
    exact(value.invitation, ['before', 'after']);
    stateImage(value.before);
    stateImage(value.after);
    if (!value.before.membership || !value.after.membership) return denyTenant();
    tenantRecord(value.invitation.before);
    const link = value.invitation.before;
    const linked = captureInvitationChange(
      {
        operation: 'revokeInvitation',
        tenant: value.after.tenant,
        before: { invitation: link, membership: value.before.membership },
        after: {
          invitation: value.invitation.after,
          membership: value.after.membership,
        },
      },
      {
        operation: 'revokeInvitation',
        tenantId: intent.tenantId,
        expectedTenantVersion: intent.expectedTenantVersion,
        invitationId: link.invitationId as string,
        expectedInvitationVersion: link.version as string,
        membershipId: intent.membershipId,
        expectedMembershipVersion: intent.expectedMembershipVersion,
      },
      ceiling,
    );
    if (linked.before!.membership.status !== 'invited') return denyTenant();
  }
  return value as unknown as AdministrationChange;
}

function readTenant(db: DatabaseSync, id: string): TenantImage | null {
  const row = db
    .prepare(
      `SELECT id AS tenantId, status, version FROM main."${TENANT_TABLES.tenant}"
    WHERE id = ? COLLATE BINARY AND kind = 'tenant'`,
    )
    .get(id);
  if (!row) return null;
  tenantImage(row);
  return captureTenantData(row);
}
function readMembership(db: DatabaseSync, tenantId: string, id: string): MembershipImage | null {
  const row = db
    .prepare(
      `SELECT id AS membershipId, tenant_id AS tenantId, account_id AS accountId, status, version,
    roles_json AS roles, valid_until AS validUntil FROM main."${TENANT_TABLES.membership}"
    WHERE id = ? COLLATE BINARY AND tenant_id = ? COLLATE BINARY AND kind = 'member'`,
    )
    .get(id, tenantId);
  if (!row) return null;
  if (typeof row.roles !== 'string') return denyTenant();
  const value = { ...row, roles: JSON.parse(row.roles) };
  membershipImage(value);
  return captureTenantData(value);
}

type StoreSession = DatabaseSync | PgQuery;
/** The engine half of the administration owner: one maintenance transaction
 * on the store's own writer and queue, and the reads and facades composed on
 * it. Policy, sessions, receipts and every authorization rule stay in the one
 * owner below; neither engine decides or grants anything. */
interface AdministrationStore {
  readonly invitationStorage: boolean;
  supportAudit?(session: StoreSession, operations: TransactionOperations, active: () => void): SupportAuditOwner;
  maintenance<T>(
    verify: (session: StoreSession) => void | Promise<void>,
    work: (session: StoreSession, operations: TransactionOperations, assertCurrent: () => void) => Promise<T>,
  ): Promise<T>;
  assertJournal(session: StoreSession): void | Promise<void>;
  assertInvitations(session: StoreSession): void | Promise<void>;
  invitations(session: StoreSession, operations: TransactionOperations, active: () => void): InvitationTransaction['invitations'];
  invitationTransaction(
    session: StoreSession,
    operations: TransactionOperations,
    active: () => void,
    assertCurrent: () => void,
  ): InvitationTransaction;
  /** `lock` holds the row for the rest of a mutating transaction where the
   * engine has row locks; SQLite's writer fence already holds everything. */
  readTenant(session: StoreSession, id: string, lock?: boolean): TenantImage | null | Promise<TenantImage | null>;
  readMembership(
    session: StoreSession,
    tenantId: string,
    id: string,
    lock?: boolean,
  ): MembershipImage | null | Promise<MembershipImage | null>;
  /** Filtered by status and by the complete role set before the bound, in byte order.
   * `excludeAccount` leaves out one account's own row, before the bound too. */
  listMemberships(
    session: StoreSession,
    tenantId: string,
    after: string,
    activeOnly: boolean,
    roles: readonly string[],
    limit: number,
    excludeAccount?: string,
  ): Record<string, unknown>[] | Promise<Record<string, unknown>[]>;
  /** A delegate's own member row in an active tenant — never a support or
   * platform row — or null. `lock` takes the tenant row, then it, FOR UPDATE
   * where the engine has row locks: the order every administrative change takes. */
  readAccountMembership(
    session: StoreSession,
    tenantId: string,
    accountId: string,
    lock?: boolean,
  ): DelegateMembership | null | Promise<DelegateMembership | null>;
  /** The id of the account's live (active or invited) member row in a tenant, whatever the tenant's status. */
  liveMembershipId(session: StoreSession, tenantId: string, accountId: string): string | null | Promise<string | null>;
  /** Every active tenant where the account holds an active, unexpired member row. */
  listAccountTenants(
    session: StoreSession,
    accountId: string,
    now: number,
  ): ReturnType<typeof decodeDelegateTenants> | Promise<ReturnType<typeof decodeDelegateTenants>>;
  journal(session: StoreSession, operations: TransactionOperations, active: () => void): TenantAdministrationJournal;
  administration(session: StoreSession, operations: TransactionOperations, active: () => void): TenantStoreAdministration;
  /** The assistant store's switch, conversations and counts, on this transaction's session. */
  assistant(session: StoreSession): AssistantSwitchStore;
  /** The decision store's switches, records and usage, on this transaction's session. */
  decisions(session: StoreSession): DecisionSwitchStore;
  close(): Promise<void>;
}
const invitationTables = `SELECT 1 FROM main.sqlite_schema WHERE substr(name, 1, 20) = '__mistri_invitation_' COLLATE NOCASE LIMIT 1`;

/** The existing business file, never native auth's, on a private writer. */
async function openSqliteAdministrationStore(
  path: string,
  owner: TenantStoreBinding,
  auth: AppAuthRuntimeBinding,
  authStore: string,
  invitations: boolean,
  supportKey?: SupportAuditKey,
): Promise<AdministrationStore> {
  const excluded = captureAuthStoreExclusion(path);
  assertAuthStoreSeparation(authStore, excluded);
  auth.assertCurrent();
  const writer = new SqliteAdapter(excluded.path, 'Private tenant administration');
  try {
    let invitationStorage = false;
    await writer.runtimeMaintenanceTransaction(
      (db) => {
        auth.assertCurrent();
        assertAuthStoreSeparation(authStore, excluded);
        assertSqliteTenantAdministrationJournal(db, owner);
        if (supportKey) assertSqliteSupportAudit(db, owner, supportKey);
        invitationStorage = !!db.prepare(invitationTables).get();
        if (invitations || invitationStorage) assertLinkedTenantInvitations(db, owner);
      },
      async () => {},
    );
    auth.assertCurrent();
    assertAuthStoreSeparation(authStore, excluded);
    const sqlite = (session: StoreSession) => session as DatabaseSync;
    return Object.freeze<AdministrationStore>({
      invitationStorage,
      ...(supportKey
        ? {
            supportAudit: (session: StoreSession, operations: TransactionOperations, active: () => void) =>
              createSqliteSupportAuditOwner(sqlite(session), operations, owner, supportKey, active),
          }
        : {}),
      maintenance: (verify, work) =>
        writer.runtimeMaintenanceTransaction(
          (db) => {
            // The SQLite writer fence is synchronous, and so is every verifier here.
            // The private support path puts its final native check AFTER every
            // storage check. Ordinary maintenance retains its exact old ordering.
            if (!supportKey && verify(db) !== undefined) return denyTenant();
            const present = !!db.prepare(invitationTables).get();
            if (present !== invitationStorage) return denyTenant();
            if (present) assertSqliteTenantInvitations(db, owner);
            if (supportKey) {
              assertSqliteSupportAudit(db, owner, supportKey);
              if (verify(db) !== undefined) return denyTenant();
            }
          },
          async (db, operations, assertCurrent) => {
            if (invitationStorage) assertLinkedTenantInvitations(db, owner);
            const result = await work(db, operations, assertCurrent);
            if (invitationStorage) assertLinkedTenantInvitations(db, owner);
            return result;
          },
        ),
      assertJournal: (session) => assertSqliteTenantAdministrationJournal(sqlite(session), owner),
      assertInvitations: (session) => assertSqliteTenantInvitations(sqlite(session), owner),
      invitations: (session, operations, active) => createSqliteTenantInvitations(sqlite(session), operations, owner, active),
      invitationTransaction: (session, operations, active, assertCurrent) =>
        createSqliteInvitationTransaction(sqlite(session), operations, owner, active, assertCurrent),
      readTenant: (session, id) => readTenant(sqlite(session), id),
      readMembership: (session, tenantId, id) => readMembership(sqlite(session), tenantId, id),
      listMemberships: (session, tenantId, after, activeOnly, roles, limit, excludeAccount) =>
        sqlite(session)
          .prepare(
            `SELECT m.id AS membershipId, m.tenant_id AS tenantId, m.account_id AS accountId,
            m.status, m.version, m.roles_json AS roles, m.valid_until AS validUntil
            FROM main."${TENANT_TABLES.membership}" m
            WHERE m.tenant_id = ? COLLATE BINARY AND m.kind = 'member' AND m.id > ? COLLATE BINARY
              AND m.status IN (${activeOnly ? "'active'" : "'active','invited'"})
              AND NOT EXISTS (SELECT 1 FROM json_each(m.roles_json) r
                WHERE r.type <> 'text' OR r.value NOT IN (${roles.map(() => '?').join(',')}))
              ${excludeAccount === undefined ? '' : 'AND m.account_id <> ? COLLATE BINARY'}
            ORDER BY m.id COLLATE BINARY LIMIT ?`,
          )
          .all(tenantId, after, ...roles, ...(excludeAccount === undefined ? [] : [excludeAccount]), limit) as Record<string, unknown>[],
      readAccountMembership: (session, tenantId, accountId) =>
        decodeDelegateMembership(
          sqlite(session)
            .prepare(
              `SELECT m.id AS membershipId,
            m.tenant_id AS tenantId, m.account_id AS accountId, m.status, m.roles_json AS roles, m.valid_until AS validUntil
            FROM main."${TENANT_TABLES.membership}" m JOIN main."${TENANT_TABLES.tenant}" t ON t.id = m.tenant_id
            WHERE m.tenant_id = ? COLLATE BINARY AND m.account_id = ? COLLATE BINARY AND m.kind = 'member' AND m.status <> 'revoked'
              AND t.kind = 'tenant' AND t.status = 'active'`,
            )
            .get(tenantId, accountId),
        ),
      liveMembershipId: (session, tenantId, accountId) => {
        const row = sqlite(session)
          .prepare(
            `SELECT id FROM main."${TENANT_TABLES.membership}"
            WHERE tenant_id = ? COLLATE BINARY AND account_id = ? COLLATE BINARY AND kind = 'member' AND status <> 'revoked'`,
          )
          .get(tenantId, accountId);
        return typeof row?.id === 'string' ? row.id : null;
      },
      listAccountTenants: (session, accountId, now) =>
        decodeDelegateTenants(
          sqlite(session)
            .prepare(
              `SELECT m.tenant_id AS tenantId,
            m.roles_json AS roles FROM main."${TENANT_TABLES.membership}" m JOIN main."${TENANT_TABLES.tenant}" t ON t.id = m.tenant_id
            WHERE m.account_id = ? COLLATE BINARY AND m.kind = 'member' AND m.status = 'active' AND m.valid_until > ?
              AND t.kind = 'tenant' AND t.status = 'active' ORDER BY m.tenant_id COLLATE BINARY LIMIT 257`,
            )
            .all(accountId, now),
        ),
      journal: (session, operations, active) => createSqliteTenantAdministrationJournal(sqlite(session), operations, owner, active),
      administration: (session, operations, active) => createSqliteTenantAdministration(sqlite(session), operations, owner, active),
      assistant: (session) => sqliteAssistantSwitch(sqlite(session), owner.appId),
      decisions: (session) => sqliteDecisionSwitch(sqlite(session), owner.appId),
      close: () => writer.close(),
    });
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
}

/** The store on a PostgreSQL tenant source. A database is not a file native
 * auth could alias; a postgres:// auth store is separated when native auth
 * opens. The store and journal are attested and pinned at the start of every
 * maintenance transaction and again before COMMIT, and a mutation reads the
 * tenant row, then the membership row, FOR UPDATE: its before-images are what
 * it changes, in the lock order the business fence shares. */
async function openPostgresAdministrationStore(
  url: string,
  owner: TenantStoreBinding,
  auth: AppAuthRuntimeBinding,
): Promise<AdministrationStore> {
  auth.assertCurrent();
  const writer = tenantAdapter(url, 'Private tenant administration');
  try {
    let invitationStorage: boolean | undefined;
    const attestInvitations = async (client: PgQuery) => {
      const present = await postgresInvitationStoragePresent(client);
      if (invitationStorage !== undefined && invitationStorage !== present) return denyTenant();
      invitationStorage = present;
      if (present) await assertLinkedPostgresTenantInvitations(client, owner);
    };
    await writer.runtimeMaintenanceTransaction(
      async (client) => {
        auth.assertCurrent();
        await assertPostgresTenantAdministrationJournal(client, owner);
        await attestInvitations(client);
      },
      async () => {},
    );
    auth.assertCurrent();
    const pg = (session: StoreSession) => session as PgQuery;
    // A lone surrogate would be stored, and so matched, as U+FFFD.
    const wellFormed = (...values: readonly string[]) => {
      if (values.some((value) => /\p{Cs}/u.test(value))) denyTenant();
    };
    return Object.freeze<AdministrationStore>({
      invitationStorage: invitationStorage!,
      maintenance: (verify, work) =>
        writer.runtimeMaintenanceTransaction(async (client) => {
          // Storage checks precede the caller's final native auth observation.
          // The adapter invokes this again after draining work, just before COMMIT.
          await attestInvitations(client);
          await verify(client);
        }, work),
      assertJournal: (session) => assertPostgresTenantAdministrationJournal(pg(session), owner),
      assertInvitations: (session) => assertPostgresTenantInvitations(pg(session), owner),
      invitations: (session, operations, active) => createPostgresTenantInvitations(pg(session), operations, owner, active),
      invitationTransaction: (session, operations, active, assertCurrent) =>
        createPostgresInvitationTransaction(pg(session), operations, owner, active, assertCurrent),
      async readTenant(session, id, lock = false) {
        wellFormed(id);
        const row = (
          await pg(session).query(
            `SELECT id AS "tenantId", status, version FROM ${runtimeTable('postgres', TENANT_TABLES.tenant)}
          WHERE id = $1 AND kind = 'tenant'${lock ? ' FOR UPDATE' : ''}`,
            [id],
          )
        ).rows[0];
        if (!row) return null;
        tenantImage(row);
        return captureTenantData(row);
      },
      async readMembership(session, tenantId, id, lock = false) {
        wellFormed(tenantId, id);
        const row = (
          await pg(session).query(
            `SELECT id AS "membershipId", tenant_id AS "tenantId", account_id AS "accountId", status, version,
          roles_json AS roles, valid_until::float8 AS "validUntil" FROM ${runtimeTable('postgres', TENANT_TABLES.membership)}
          WHERE id = $1 AND tenant_id = $2 AND kind = 'member'${lock ? ' FOR UPDATE' : ''}`,
            [id, tenantId],
          )
        ).rows[0];
        if (!row) return null;
        if (typeof row.roles !== 'string') return denyTenant();
        const value = { ...row, roles: JSON.parse(row.roles) };
        membershipImage(value);
        return captureTenantData(value);
      },
      async listMemberships(session, tenantId, after, activeOnly, roles, limit, excludeAccount) {
        wellFormed(tenantId, after, ...roles, ...(excludeAccount === undefined ? [] : [excludeAccount]));
        // Identity columns are COLLATE "C": the bound and the order are byte order.
        return (
          await pg(session).query(
            `SELECT m.id AS "membershipId", m.tenant_id AS "tenantId", m.account_id AS "accountId",
            m.status, m.version, m.roles_json AS roles, m.valid_until::float8 AS "validUntil"
          FROM ${runtimeTable('postgres', TENANT_TABLES.membership)} m
          WHERE m.tenant_id = $1 AND m.kind = 'member' AND m.id > $2 AND m.status = ANY($3::text[])
            AND NOT EXISTS (SELECT 1 FROM json_array_elements(m.roles_json::json) r
              WHERE json_typeof(r) <> 'string' OR NOT ((r #>> '{}') = ANY($4::text[])))
            AND ($6::text IS NULL OR m.account_id <> $6)
          ORDER BY m.id LIMIT $5`,
            [tenantId, after, activeOnly ? ['active'] : ['active', 'invited'], [...roles], limit, excludeAccount ?? null],
          )
        ).rows;
      },
      async liveMembershipId(session, tenantId, accountId) {
        wellFormed(tenantId, accountId);
        const row = (
          await pg(session).query(
            `SELECT id FROM ${runtimeTable('postgres', TENANT_TABLES.membership)}
          WHERE tenant_id = $1 AND account_id = $2 AND kind = 'member' AND status <> 'revoked'`,
            [tenantId, accountId],
          )
        ).rows[0];
        return typeof row?.id === 'string' ? row.id : null;
      },
      async readAccountMembership(session, tenantId, accountId, lock = false) {
        wellFormed(tenantId, accountId);
        const tenant = (
          await pg(session).query(
            `SELECT status FROM ${runtimeTable('postgres', TENANT_TABLES.tenant)}
          WHERE id = $1 AND kind = 'tenant'${lock ? ' FOR UPDATE' : ''}`,
            [tenantId],
          )
        ).rows[0];
        if (!tenant || tenant.status !== 'active') return null;
        const rows = (
          await pg(session).query(
            `SELECT id AS "membershipId", tenant_id AS "tenantId", account_id AS "accountId", status,
          roles_json AS roles, valid_until::float8 AS "validUntil" FROM ${runtimeTable('postgres', TENANT_TABLES.membership)}
          WHERE tenant_id = $1 AND account_id = $2 AND kind = 'member' AND status <> 'revoked'${lock ? ' FOR UPDATE' : ''}`,
            [tenantId, accountId],
          )
        ).rows;
        if (rows.length > 1) return denyTenant();
        return decodeDelegateMembership(rows[0]);
      },
      async listAccountTenants(session, accountId, now) {
        wellFormed(accountId);
        return decodeDelegateTenants(
          (
            await pg(session).query(
              `SELECT m.tenant_id AS "tenantId", m.roles_json AS roles
          FROM ${runtimeTable('postgres', TENANT_TABLES.membership)} m JOIN ${runtimeTable('postgres', TENANT_TABLES.tenant)} t ON t.id = m.tenant_id
          WHERE m.account_id = $1 AND m.kind = 'member' AND m.status = 'active' AND m.valid_until > $2
            AND t.kind = 'tenant' AND t.status = 'active' ORDER BY m.tenant_id LIMIT 257`,
              [accountId, now],
            )
          ).rows,
        );
      },
      journal: (session, operations, active) => createPostgresTenantAdministrationJournal(pg(session), operations, owner, active),
      administration: (session, operations, active) => createPostgresTenantAdministration(pg(session), operations, owner, active),
      assistant: (session) => postgresAssistantSwitch(pg(session), owner.appId),
      decisions: (session) => postgresDecisionSwitch(pg(session), owner.appId),
      close: () => writer.close(),
    });
  } catch (error) {
    await writer.close().catch(() => {});
    throw error;
  }
}

const OPTION_KEYS = [
  'path',
  'url',
  'binding',
  'auth',
  'policy',
  'invitations',
  'deployment',
  'now',
  'maxLifetimeMs',
  'assistant',
  'decisions',
  'directories',
  'clone',
];

/** Private, explicit existing-file owner. No provisioning, public route, policy
 * callback, arbitrary SQL or business-resource capability is exposed here. */
export function openSqliteTenantAdministration(options: TenantAdministrationOptions): Promise<TenantAdministration> {
  return openAdministration(options, 'sqlite');
}
/** The enrolled host's owner, on the engine its captured source names. */
export function openTenantAdministration(options: TenantAdministrationOptions): Promise<TenantAdministration> {
  let postgres: boolean;
  try {
    postgres = tenantOptions(options, OPTION_KEYS).url !== undefined;
  } catch {
    return Promise.reject(new TenantAdministrationFailure('not_applied'));
  }
  return openAdministration(options, postgres ? 'postgres' : 'sqlite');
}

/** Private status-only native owner. No support write/admission methods and no
 * new ordinary options or public startup branch. Reuses the same store factory. */
export async function openSqliteSupportReceiptRecovery(
  options: TenantAdministrationOptions,
  support: SupportReceiptRecoveryOptions,
): Promise<SupportReceiptRecovery & { retire(): Promise<void> }> {
  const administration = await openAdministration(options, 'sqlite', support);
  if (!administration.supportHistory) {
    await administration.retire();
    return denyTenant();
  }
  return Object.freeze({
    status: administration.supportHistory.status,
    retire: administration.retire,
  });
}

async function openAdministration(
  options: TenantAdministrationOptions,
  engine: 'sqlite' | 'postgres',
  supportInput?: SupportReceiptRecoveryOptions,
): Promise<TenantAdministration & { supportHistory?: SupportReceiptRecovery }> {
  let store: AdministrationStore | undefined;
  try {
    const raw = tenantOptions(options, OPTION_KEYS);
    if (engine === 'sqlite' ? raw.url !== undefined : raw.path !== undefined) return denyTenant();
    const owner = captureTenantData(raw.binding) as TenantStoreBinding;
    const policy = raw.policy === undefined ? undefined : captureAdministrationPolicy(raw.policy);
    if (raw.assistant !== undefined && raw.assistant !== true) return denyTenant();
    const providers = raw.decisions as readonly string[] | undefined;
    if (
      providers !== undefined &&
      (!Array.isArray(providers) ||
        providers.length < 1 ||
        providers.length > 8 ||
        new Set(providers).size !== providers.length ||
        providers.some((provider) => typeof provider !== 'string' || !/^[a-z]{1,32}$/.test(provider)))
    )
      return denyTenant();
    // Where the App declares no assistant, the switch is no operation of this owner's; where it marks nothing clone, neither is a sandbox.
    const clonePlan = raw.clone as TenantClonePlan | undefined;
    if (clonePlan !== undefined && (typeof clonePlan !== 'object' || clonePlan.appId !== (raw.binding as TenantStoreBinding).appId))
      return denyTenant();
    const offered = (operation: string) =>
      operation === 'setTenantAssistant'
        ? raw.assistant === true
        : operation === 'setTenantDecisions'
          ? providers !== undefined
          : operation === 'cloneTenant' || operation === 'importTenant'
            ? clonePlan !== undefined
            : true;
    /* The sandbox store on a transaction's own session: a clone or an import runs inside the one the receipt commits in. */
    const sandboxSession = (session: StoreSession, active: () => void): SandboxSession =>
      engine === 'sqlite' ? sqliteSandboxSession(session as DatabaseSync, active) : postgresSandboxSession(session as PgQuery, active);
    /** The sandbox rows where the store is provisioned; a store never provisioned has no sandbox to name. */
    const sandboxesOf = async (session: StoreSession, active: () => void) => {
      const rows = sandboxSession(session, active);
      return (await sandboxStorePresent(rows)) ? sandboxRows(rows, owner.appId) : undefined;
    };
    const invitationPolicy = raw.invitations === undefined ? undefined : captureInvitationPolicy(raw.invitations);
    if (!policy && !invitationPolicy && !supportInput) return denyTenant();
    // The same strict binding validation as durable fingerprinting, before acquisition.
    if (policy)
      administrationFingerprint(policy, owner, {
        operation: 'createTenant',
        tenantId: 'binding-check',
      });
    else {
      exact(owner, ['appId', 'source', 'storeId']);
      tenantIdentifier(owner.appId);
      tenantIdentifier(owner.storeId);
      exact(owner.source, ['id', 'connection']);
      tenantIdentifier(owner.source.id);
      tenantIdentifier(owner.source.connection, 1024);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(owner.source.id)) return denyTenant();
    }
    const auth = captureAppAuthRuntime(raw.auth as AppAuthRuntime);
    if (owner.appId !== auth.appId) return denyTenant();
    if (supportInput && engine !== 'sqlite') return denyTenant();
    const support = supportInput
      ? prepareSupportReceiptRecovery(supportInput, owner, raw.auth as AppAuthRuntime, raw.deployment as string)
      : undefined;
    const supportCurrent = () => {
      if (!support) return;
      support.assertCurrent();
      const latest = tenantOptions(options, OPTION_KEYS);
      if (
        latest.auth !== raw.auth ||
        latest.path !== raw.path ||
        latest.url !== raw.url ||
        latest.deployment !== raw.deployment ||
        JSON.stringify(captureTenantData(latest.binding)) !== JSON.stringify(owner)
      )
        return denyTenant();
    };
    // Only the PostgreSQL owner has an awaitable final native checkpoint (after
    // drain and storage attestation, before COMMIT). SQLite's final verifier is
    // synchronous, so SQLite invitations still need the synchronous file store.
    if (invitationPolicy && !auth.synchronous && engine !== 'postgres') return denyTenant();
    if (engine === 'sqlite') tenantIdentifier(raw.path, 32768);
    else {
      tenantIdentifier(raw.url, 32768);
      if (!/^postgres(ql)?:\/\//i.test(raw.url)) return denyTenant();
    }
    tenantIdentifier(raw.deployment);
    const deployment = raw.deployment;
    const now = raw.now === undefined ? Date.now : raw.now;
    const lifetime = raw.maxLifetimeMs === undefined ? 300_000 : raw.maxLifetimeMs;
    if (
      typeof now !== 'function' ||
      isProxy(now) ||
      typeof lifetime !== 'number' ||
      !Number.isSafeInteger(lifetime) ||
      lifetime < 1 ||
      lifetime > 300_000
    )
      return denyTenant();
    const openStore = () =>
      engine === 'sqlite'
        ? openSqliteAdministrationStore(
            raw.path as string,
            owner,
            auth,
            (raw.auth as AppAuthRuntime).store,
            invitationPolicy !== undefined,
            support?.key,
          )
        : openPostgresAdministrationStore(raw.url as string, owner, auth);
    const first = (store = await openStore());
    supportCurrent();
    const { invitationStorage } = first;
    if (invitationPolicy && !invitationStorage) return denyTenant();
    /* The file the SQLite store opened, by identity: a path that names another file since is never reopened. */
    const fileAt = (): Stats | undefined => {
      try {
        return statSync(raw.path as string);
      } catch {
        return undefined;
      }
    };
    const file = engine === 'sqlite' ? fileAt() : undefined;
    // SQLite's verifier stays synchronous; PostgreSQL's attestation is a query.
    const attested = (session: StoreSession, live: () => void): void | Promise<void> => {
      live();
      const result = opened().assertJournal(session);
      if (!isPromise(result)) {
        live();
        return;
      }
      return result.then(() => {
        live();
      });
    };

    let retired = false,
      retirement: Promise<void> | undefined;
    const pending = new Set<Promise<unknown>>(),
      queue = new Serial();
    const sessions = new Map<
      string,
      {
        readonly value: AdministrationSession;
        readonly proof: VerifiedSessionInstance;
      }
    >();
    /* An operation whose outcome could not be confirmed (a COMMIT never
       acknowledged, a ROLLBACK a lost connection could not carry) keeps its
       own refusal, `unknown`; the store closes behind the operations already
       admitted and reopens where it was, attested again, as the App's writer
       does (tenantWriterLifecycle.ts). Until rc.1 it retired for good, so one
       connection a pooler or failover ended refused Manage tenants,
       invitations and support receipts until a restart. While it is closed
       every operation is refused before it starts, and `/readyz` says so. */
    const life = writerLifecycle({
      owner,
      name: `${owner.appId}'s tenant administration`,
      paused: `${owner.appId}/administration`,
      initial: first,
      drain: async (work) => {
        await Promise.allSettled([...pending]);
        await work();
      },
      reopen: async () => {
        if (file) {
          const seen = fileAt();
          if (seen?.dev !== file.dev || seen.ino !== file.ino) throw new WriterRetargeted();
        }
        const next = await openStore();
        if (next.invitationStorage !== invitationStorage) {
          await next.close().catch(() => {});
          throw new Error('The administration store is not the one this owner opened.');
        }
        return { handle: next };
      },
    });
    /* The store open now: one operation runs on one, since a reopen waits for every operation admitted before it. */
    const opened = (): AdministrationStore => life.handle();
    const maintenance = (<T>(...args: Parameters<AdministrationStore['maintenance']>) =>
      opened().maintenance<T>(...(args as [never, never]))) as AdministrationStore['maintenance'];
    const uncertain = () => life.pause(undefined);
    const retire = (): Promise<void> => {
      if (!retirement) {
        retired = true;
        sessions.clear();
        retirement = life.close().catch(() => {
          throw new TenantAdministrationFailure('unknown');
        });
        void retirement.catch(() => {});
      }
      return retirement;
    };
    const clock = (): number => {
      if (retired || life.closing()) return denyTenant();
      auth.assertCurrent();
      supportCurrent();
      const instant: unknown = now();
      if (isPromise(instant)) void Promise.prototype.then.call(instant, undefined, () => {});
      time(instant);
      auth.assertCurrent();
      supportCurrent();
      if (retired || life.closing()) return denyTenant();
      return instant;
    };
    const tracked = <T>(work: () => Promise<T>): Promise<T> => {
      const promise = Promise.resolve().then(work);
      pending.add(promise);
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      );
      return promise;
    };
    /* Delegation (tenantDelegation.ts): what a member's roles earn in its own
       tenant, and the delegate's own membership, read in the caller's
       transaction. Tenant creation and status are never delegated. */
    const delegateCapabilities = (memberRoles: readonly string[]) =>
      DELEGABLE_ADMINISTRATION_OPERATIONS.filter(offered).flatMap((operation) => {
        const roles = delegateCeiling(policy?.delegates, memberRoles, operation);
        return roles ? [{ operation, roles }] : [];
      });
    const delegatedTargets = async (session: StoreSession, accountId: string) => {
      if (!policy?.delegates) return new Map<string, ReturnType<typeof delegateCapabilities>>();
      const tenants = await opened().listAccountTenants(session, accountId, clock());
      return new Map(
        tenants.map((tenant) => [tenant.tenantId, delegateCapabilities(tenant.roles)] as const).filter(([, found]) => found.length),
      );
    };
    const delegatedGrant = async (session: StoreSession, accountId: string, tenantId: string, operation: string, lock: boolean) => {
      if (!policy?.delegates || !(DELEGABLE_ADMINISTRATION_OPERATIONS as readonly string[]).includes(operation) || !offered(operation))
        return denyTenant();
      const own = assertDelegateMembership(
        await opened().readAccountMembership(session, tenantId, accountId, lock),
        accountId,
        tenantId,
        clock(),
      );
      return Object.freeze({
        roles: delegateCeiling(policy.delegates, own.roles, operation as DelegableAdministrationOperation) ?? denyTenant(),
        validUntil: own.validUntil,
        /* What the delegate holds in its own tenant: what a clone it makes gives it in the copy, no more. */
        memberRoles: own.roles,
      });
    };
    const open = (request: IncomingMessage, input: { readonly expectedAccount: string }): Promise<AdministrationSession | null> => {
      let accountId: string, started: number;
      try {
        const captured = captureTenantData(input);
        exact(captured, ['expectedAccount']);
        tenantIdentifier(captured.expectedAccount, 1024);
        accountId = captured.expectedAccount;
        started = clock();
        if (started > Number.MAX_SAFE_INTEGER - lifetime) return denyTenant();
      } catch {
        return Promise.reject(new TenantAdministrationFailure('not_applied'));
      }
      return tracked(async () => {
        try {
          const proof = await auth.sessionInstance(request);
          let instant = clock();
          if (!proof || proof.identity.id !== accountId || request.aborted || instant < started) return denyTenant();
          auth.assertSessionCurrent(proof);
          if (!auth.synchronous) await auth.observeSession(proof);
          let expiresAt = Math.min(started + lifetime, proof.expiresAt);
          if (instant >= expiresAt) return denyTenant();
          // Login is identity, never operator authority. No tenant store or
          // account directory is queried for an ordinary authenticated account,
          // unless the policy delegates: then the account's own member rows say.
          if (!policy?.operators.some((entry) => entry.accountId === accountId)) {
            if (!policy?.delegates) return null;
            const fence = () => {
              auth.assertSessionCurrent(proof);
              if (request.aborted) denyTenant();
            };
            const delegated = await queue.run(() =>
              maintenance<number>(
                (session) => attested(session, fence),
                async (session) => (await delegatedTargets(session, accountId)).size,
              ),
            );
            if (!delegated) return null;
          }
          const fresh = await auth.sessionInstance(request);
          const before = instant;
          instant = clock();
          if (!fresh || fresh.identity.id !== accountId || fresh.sessionId !== proof.sessionId || request.aborted || instant < before)
            return denyTenant();
          auth.assertSessionCurrent(proof);
          auth.assertSessionCurrent(fresh);
          if (!auth.synchronous) await auth.observeSession(proof);
          expiresAt = Math.min(expiresAt, fresh.expiresAt);
          if (instant >= expiresAt) return denyTenant();
          for (const [key, session] of sessions) if (session.value.expiresAt <= instant) sessions.delete(key);
          if (sessions.size >= 1024 || [...sessions.values()].filter((session) => session.value.accountId === accountId).length >= 16)
            return denyTenant();
          const value = captureTenantData({
            appId: owner.appId,
            accountId,
            context: randomUUID(),
            expiresAt,
            maxMembershipLifetimeMs: policy.maxMembershipLifetimeMs,
          });
          sessions.set(value.context, { value, proof: fresh });
          return value;
        } catch {
          throw new TenantAdministrationFailure('not_applied');
        }
      });
    };
    // Administration reads use the same source owner and native-login fences as
    // mutations, not an ordinary business reader or a pre-selection bypass.
    const readOwned = <T>(
      request: IncomingMessage,
      input: AdministrationOwner,
      inspect: (session: StoreSession, active: () => void) => T | Promise<T>,
    ): Promise<T> => {
      let session: {
          readonly value: AdministrationSession;
          readonly proof: VerifiedSessionInstance;
        },
        started: number;
      try {
        const found = sessions.get(input.context);
        if (!found || found.value.accountId !== input.expectedAccount) return denyTenant();
        session = found;
        started = clock();
        if (started > Number.MAX_SAFE_INTEGER - lifetime) return denyTenant();
      } catch {
        return Promise.reject(new TenantAdministrationFailure('not_applied'));
      }
      return tracked(async () => {
        let deadline = Math.min(started + lifetime, session.value.expiresAt),
          last = started;
        const live = () => {
          const instant = clock();
          auth.assertSessionCurrent(session.proof);
          if (request.aborted || instant < last || instant >= deadline) return denyTenant();
          last = instant;
        };
        const current = async () => {
          live();
          const proof = await auth.sessionInstance(request);
          live();
          if (!proof || proof.identity.id !== input.expectedAccount || proof.sessionId !== session.proof.sessionId) return denyTenant();
          auth.assertSessionCurrent(proof);
          // A PostgreSQL store is observed against the admission proof, as the
          // file store's synchronous check in `live` is.
          if (!auth.synchronous) {
            await auth.observeSession(session.proof);
            live();
          }
          deadline = Math.min(deadline, proof.expiresAt);
          live();
        };
        try {
          await current();
          const result = await queue.run(async () => {
            await current();
            return maintenance<T>(
              (session) => attested(session, live),
              async (session, _operations, assertCurrent) => {
                const active = () => {
                  live();
                  assertCurrent();
                };
                await current();
                active();
                const value = await inspect(session, active);
                active();
                await current();
                return value;
              },
            );
          });
          await current();
          live();
          return captureTenantData(result);
        } catch (error) {
          if (error instanceof TransactionOutcomeUnknown) uncertain();
          throw new TenantAdministrationFailure('not_applied');
        }
      });
    };
    const tenants = async (request: IncomingMessage, input: AdministrationPageRequest): Promise<AdministrationTenantPage> => {
      try {
        const captured = captureTenantData(input);
        exact(captured, ['expectedAccount', 'context'], ['after', 'limit']);
        const limit = pagination(captured, 128);
        if (captured.after !== undefined) parseTenantSelector([captured.after]);
        const grants = policy?.operators.filter((entry) => entry.accountId === captured.expectedAccount) ?? [];
        if (!grants.length && !policy?.delegates) return denyTenant();
        return await readOwned(request, captured, async (session, active) => {
          // Policy enumeration discloses only explicitly delegated targets, even
          // before creation, and a delegate's own tenants. Never enumerate the
          // database's global tenant table.
          const delegated = await delegatedTargets(session, captured.expectedAccount);
          active();
          const ids = [...new Set([...grants.flatMap((entry) => entry.tenants), ...delegated.keys()])]
            .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
            .filter((id) => captured.after === undefined || Buffer.compare(Buffer.from(id), Buffer.from(captured.after)) > 0)
            .slice(0, limit + 1);
          const targets: AdministrationTenantTarget[] = [];
          for (const tenantId of ids) {
            active();
            const capabilities = ADMINISTRATION_OPERATIONS.filter(offered).flatMap((operation) => {
              // Where an operator grant covers the operation, it decides.
              const grant =
                operation === 'importTenant'
                  ? undefined
                  : grants.find((entry) => entry.tenants.includes(tenantId) && entry.operations.includes(operation));
              const roles = grant?.roles ?? delegated.get(tenantId)?.find((found) => found.operation === operation)?.roles;
              return roles ? [{ operation, roles }] : [];
            });
            const switchable = capabilities.some((capability) => capability.operation === 'setTenantAssistant');
            const assistant = switchable ? await opened().assistant(session).read(tenantId) : null;
            const decidable = providers && capabilities.some((capability) => capability.operation === 'setTenantDecisions');
            const decisions = decidable
              ? await opened()
                  .decisions(session)
                  .read(tenantId, [...providers].sort())
              : null;
            /* A sandbox says so, and a tenant whose owner may import says which of its sandboxes there are. */
            const sandboxes = clonePlan ? await sandboxesOf(session, active) : undefined;
            const record = sandboxes ? await sandboxes.read(tenantId) : null;
            const importable = capabilities.some((capability) => capability.operation === 'importTenant');
            const copies = sandboxes && importable && !record ? await sandboxes.of(tenantId) : [];
            const images: TenantImage[] = [];
            for (const id of copies) {
              const image = await opened().readTenant(session, id);
              if (image) images.push(image);
            }
            targets.push({
              tenantId,
              tenant: await opened().readTenant(session, tenantId),
              capabilities,
              ...(assistant ? { assistant } : {}),
              ...(decisions ? { decisions } : {}),
              ...(record ? { sandbox: { sourceTenantId: record.sourceTenantId } } : {}),
              ...(importable && !record ? { sandboxes: images } : {}),
            });
          }
          const usage = raw.assistant === true && grants.some((entry) => entry.operations.includes('setTenantAssistant'));
          const decisionUsage = providers !== undefined && grants.some((entry) => entry.operations.includes('setTenantDecisions'));
          return {
            ...pageItems(targets, limit, (item) => item.tenantId),
            ...(usage ? { usage: true as const } : {}),
            ...(decisionUsage ? { decisionUsage: true as const } : {}),
          };
        });
      } catch {
        throw new TenantAdministrationFailure('not_applied');
      }
    };
    const memberships = async (
      request: IncomingMessage,
      input: AdministrationMembershipPageRequest,
    ): Promise<AdministrationMembershipPage> => {
      try {
        const captured = captureTenantData(input);
        exact(captured, ['expectedAccount', 'context', 'tenantId', 'operation'], ['after', 'limit']);
        const limit = pagination(captured, 1024);
        tenantIdentifier(captured.tenantId, 128);
        parseTenantSelector([captured.tenantId]);
        if (captured.operation !== 'replaceMembership' && captured.operation !== 'revokeMembership') return denyTenant();
        if (!policy) return denyTenant();
        const operator = operatorGrant(policy, captured.expectedAccount, captured.tenantId, captured.operation);
        if (!operator && !policy.delegates) return denyTenant();
        return await readOwned(request, captured, async (session, active) => {
          active();
          const grant = operator ?? (await delegatedGrant(session, captured.expectedAccount, captured.tenantId, captured.operation, false));
          active();
          const tenant = await opened().readTenant(session, captured.tenantId);
          // Filter the exact operation's entire existing role set BEFORE LIMIT
          // or lookahead. A broader revoke grant cannot disclose replace rows.
          // A delegate never acts on its own membership, so it is never offered.
          const rows = await opened().listMemberships(
            session,
            captured.tenantId,
            captured.after ?? '',
            captured.operation === 'replaceMembership',
            grant.roles,
            limit + 1,
            operator ? undefined : captured.expectedAccount,
          );
          const candidates = rows.map((row) => {
            active();
            if (typeof row.roles !== 'string') return denyTenant();
            const member = { ...row, roles: JSON.parse(row.roles) };
            membershipImage(member);
            if (member.roles.some((role) => !grant.roles.includes(role))) return denyTenant();
            return member;
          });
          return {
            tenant,
            operation: captured.operation,
            roles: grant.roles,
            ...pageItems(candidates, limit, (item) => item.membershipId),
          };
        });
      } catch {
        throw new TenantAdministrationFailure('not_applied');
      }
    };
    /* What the assistant cost, by tenant and day: the platform owner's bill, so an operator's alone (a tenant's own
       admin may turn its assistant off, and reads no counts), and only for the tenants its grant names. */
    const usage = async (request: IncomingMessage, input: AdministrationUsageRequest): Promise<AdministrationUsagePage> => {
      try {
        const captured = captureTenantData(input);
        exact(captured, ['expectedAccount', 'context'], ['since']);
        tenantIdentifier(captured.expectedAccount, 1024);
        tenantIdentifier(captured.context);
        const since = captured.since ?? '0000-01-01';
        if (typeof since !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(since) || raw.assistant !== true) return denyTenant();
        const tenants = [
          ...new Set(
            (policy?.operators ?? [])
              .filter((entry) => entry.accountId === captured.expectedAccount && entry.operations.includes('setTenantAssistant'))
              .flatMap((entry) => entry.tenants),
          ),
        ];
        if (!tenants.length) return denyTenant();
        return await readOwned(request, captured, async (session, active) => {
          const rows = await opened()
            .assistant(session)
            .usage(tenants, since, ASSISTANT_USAGE_MOST + 1);
          active();
          return {
            rows: rows.slice(0, ASSISTANT_USAGE_MOST),
            truncated: rows.length > ASSISTANT_USAGE_MOST,
          };
        });
      } catch {
        throw new TenantAdministrationFailure('not_applied');
      }
    };
    /* What the decisions cost, by tenant and day: the platform owner's bill, so an operator's alone, as the assistant's. */
    const decisionUsage = async (request: IncomingMessage, input: AdministrationUsageRequest): Promise<AdministrationDecisionUsagePage> => {
      try {
        const captured = captureTenantData(input);
        exact(captured, ['expectedAccount', 'context'], ['since']);
        tenantIdentifier(captured.expectedAccount, 1024);
        tenantIdentifier(captured.context);
        const since = captured.since ?? '0000-01-01';
        if (typeof since !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(since) || providers === undefined) return denyTenant();
        const tenants = [
          ...new Set(
            (policy?.operators ?? [])
              .filter((entry) => entry.accountId === captured.expectedAccount && entry.operations.includes('setTenantDecisions'))
              .flatMap((entry) => entry.tenants),
          ),
        ];
        if (!tenants.length) return denyTenant();
        return await readOwned(request, captured, async (session, active) => {
          const rows = await opened()
            .decisions(session)
            .usage(tenants, since, DECISION_USAGE_MOST + 1);
          active();
          return {
            rows: rows.slice(0, DECISION_USAGE_MOST),
            truncated: rows.length > DECISION_USAGE_MOST,
          };
        });
      } catch {
        throw new TenantAdministrationFailure('not_applied');
      }
    };
    /* What an import would do, read for the live tenant's owner before it approves: the same plan the import
       itself makes, in a transaction that writes nothing. */
    const importPlan = async (request: IncomingMessage, input: AdministrationImportPlanRequest): Promise<AdministrationImportPlan> => {
      try {
        const captured = captureTenantData(input);
        exact(captured, ['expectedAccount', 'context', 'tenantId', 'sandboxTenantId']);
        tenantIdentifier(captured.expectedAccount, 1024);
        tenantIdentifier(captured.context);
        parseTenantSelector([captured.tenantId]);
        parseTenantSelector([captured.sandboxTenantId]);
        if (!clonePlan || !policy?.delegates || captured.tenantId === captured.sandboxTenantId) return denyTenant();
        return await readOwned(request, captured, async (session, active) => {
          await delegatedGrant(session, captured.expectedAccount, captured.tenantId, 'importTenant', false);
          const rows = sandboxSession(session, active);
          await assertSandboxStore(rows);
          const sandboxes = sandboxRows(rows, owner.appId);
          const record = await sandboxes.read(captured.sandboxTenantId);
          if (record?.sourceTenantId !== captured.tenantId || (await sandboxes.read(captured.tenantId))) return denyTenant();
          return (await planImport(rows, clonePlan, sandboxes, captured)).summary;
        });
      } catch {
        throw new TenantAdministrationFailure('not_applied');
      }
    };
    const run = (execute: boolean, request: IncomingMessage, input: AdministrationRequest): Promise<AdministrationResult | null> => {
      let captured: AdministrationRequest, started: number;
      let session: {
        readonly value: AdministrationSession;
        readonly proof: VerifiedSessionInstance;
      };
      try {
        captured = captureTenantData(input);
        exact(captured, ['expectedAccount', 'context', 'idempotencyKey', 'intent']);
        tenantIdentifier(captured.expectedAccount, 1024);
        tenantIdentifier(captured.idempotencyKey);
        tenantIdentifier(captured.context);
        const found = sessions.get(captured.context);
        if (!found || found.value.accountId !== captured.expectedAccount) return denyTenant();
        session = found;
        if (Buffer.byteLength(captured.idempotencyKey) > 256) return denyTenant();
        captured = {
          ...captured,
          intent: captureAdministrationIntent(captured.intent),
        };
        started = clock();
        if (started > Number.MAX_SAFE_INTEGER - lifetime) return denyTenant();
      } catch {
        return Promise.reject(new TenantAdministrationFailure('not_applied'));
      }
      const work = async (): Promise<AdministrationResult | null> => {
        let completed = false,
          attempted = false,
          entered = false;
        let deadline = Math.min(started + lifetime, session.value.expiresAt),
          lastTime = started;
        let proof: VerifiedSessionInstance | undefined;
        const intent = captured.intent;
        let requiredAccount: string | undefined;
        let requiredValidity: number | undefined;
        // An operator's grant is the policy's; a delegate's is its own member
        // row, read (and on PostgreSQL locked) inside the transaction below.
        /* A clone is authorized at its source as well: an operator's grant names both tenants, and a delegate's
           authority is its membership in the source, the tenant it is copying. */
        const authority = intent.operation === 'cloneTenant' ? intent.sourceTenantId : intent.tenantId;
        const operator =
          policy && (intent.operation !== 'cloneTenant' || operatorGrant(policy, captured.expectedAccount, authority, intent.operation))
            ? operatorGrant(policy, captured.expectedAccount, intent.tenantId, intent.operation)
            : null;
        let delegated:
          | Readonly<{
              roles: readonly string[];
              validUntil: number;
              memberRoles: readonly string[];
            }>
          | undefined;
        const live = (): number => {
          const instant = clock();
          auth.assertSessionCurrent(session.proof);
          if (proof) auth.assertSessionCurrent(proof);
          if (request.aborted || instant < lastTime || instant >= deadline) return denyTenant();
          if (
            (requiredValidity !== undefined && instant >= requiredValidity) ||
            (delegated !== undefined && instant >= delegated.validUntil) ||
            (requiredAccount && auth.synchronous && auth.lookupAccount(requiredAccount)?.accountId !== requiredAccount)
          )
            return denyTenant();
          lastTime = instant;
          return instant;
        };
        const current = async () => {
          live();
          const verified = await auth.sessionInstance(request);
          live();
          if (
            !verified ||
            verified.identity.id !== captured.expectedAccount ||
            verified.sessionId !== session.proof.sessionId ||
            (proof && (verified.sessionId !== proof.sessionId || verified.identity.id !== proof.identity.id))
          )
            return denyTenant();
          deadline = Math.min(deadline, verified.expiresAt);
          proof ??= verified;
          live();
          // A PostgreSQL auth store cannot be read in `live`: observe the
          // admission proof and the target account here, at every await the
          // operation passes, the last of them just before COMMIT.
          if (!auth.synchronous) {
            await auth.observeSession(session.proof);
            if (requiredAccount && (await auth.lookupAccountCurrent(requiredAccount))?.accountId !== requiredAccount) return denyTenant();
            live();
          }
          if (!policy) return denyTenant();
          // Null until a delegate's own membership is read in the transaction.
          if (operator && intent.operation === 'cloneTenant')
            administrationGrant(policy, verified.identity.id, authority, intent.operation);
          const grant: { readonly roles: readonly string[] } | null = operator
            ? administrationGrant(policy, verified.identity.id, intent.tenantId, intent.operation)
            : (delegated ?? null);
          if (requiredAccount && auth.synchronous && auth.lookupAccount(requiredAccount)?.accountId !== requiredAccount)
            return denyTenant();
          live();
          return grant;
        };
        try {
          if (!policy || (!operator && !policy.delegates)) return denyTenant();
          await current();
          const fingerprint = administrationFingerprint(policy, owner, intent);
          const scope = {
            actorId: captured.expectedAccount,
            tenantId: intent.tenantId,
            operation: intent.operation,
            operationVersion: 1,
            idempotencyKey: captured.idempotencyKey,
          };
          const returned = await queue.run(async () => {
            await current();
            attempted = true;
            return maintenance<AdministrationResult | null>(
              (session) => {
                entered = true;
                const checked = attested(session, live);
                if (auth.synchronous) return checked;
                // PG storage attestation can yield after the work's native-auth
                // check. Observe again after that final attestation and drain,
                // before COMMIT; this is not cross-database atomic revocation.
                return Promise.resolve(checked).then(async () => {
                  await current();
                  live();
                });
              },
              async (session, operations, assertCurrent) => {
                const active = () => {
                  live();
                  assertCurrent();
                };
                const journal = opened().journal(session, operations, active);
                const administration = opened().administration(session, operations, active);
                if (!operator) {
                  // A delegate: the tenant row, then its own member row, locked to
                  // COMMIT where the engine has row locks (SQLite's writer fence
                  // holds everything), so a concurrent demotion waits or refuses it.
                  delegated = await delegatedGrant(session, captured.expectedAccount, authority, intent.operation, true);
                  active();
                }
                let grant = (await current()) ?? denyTenant();
                const stored = await journal.read(scope);
                // A verified matching receipt establishes a historical commit even
                // if the next authentication barrier refuses its disclosure.
                if (stored?.fingerprint === fingerprint) completed = true;
                grant = (await current()) ?? denyTenant();
                if (stored) {
                  if (stored.fingerprint !== fingerprint) return denyTenant();
                  const change = captureChange(JSON.parse(stored.resultJson), intent, grant.roles);
                  return {
                    receiptId: stored.id,
                    requestId: stored.requestId,
                    completedAt: stored.completedAt,
                    change,
                    replayed: true,
                  };
                }
                if (!execute) return null;
                let before: AdministrationState | null = null;
                let after: AdministrationState;
                let invitation: AdministrationChange['invitation'];
                let cloned: AdministrationChange['clone'];
                let imported: AdministrationChange['import'];
                if (intent.operation === 'cloneTenant' || intent.operation === 'importTenant') {
                  if (!clonePlan) return denyTenant();
                  const rows = sandboxSession(session, active);
                  await assertSandboxStore(rows);
                  const sandboxes = sandboxRows(rows, owner.appId);
                  const other = intent.operation === 'cloneTenant' ? intent.sourceTenantId : intent.sandboxTenantId;
                  // Both tenant rows, locked in byte order: two clones or imports of one pair take them alike, and neither deadlocks.
                  const images = new Map<string, TenantImage | null>();
                  for (const id of [intent.tenantId, other].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))))
                    images.set(id, await opened().readTenant(session, id, true));
                  active();
                  if (intent.operation === 'cloneTenant') {
                    const source = images.get(intent.sourceTenantId);
                    if (images.get(intent.tenantId) || source?.status !== 'active' || source.version !== intent.expectedSourceVersion)
                      return denyTenant();
                    // A sandbox imports back into its source only, so it is not itself cloned.
                    if (await sandboxes.read(intent.sourceTenantId)) return denyTenant();
                    // A delegate names a sandbox of its own tenant, never a tenant id of its choosing.
                    if (delegated && !intent.tenantId.startsWith(`${intent.sourceTenantId}-sandbox`)) return denyTenant();
                    await administration.putTenant({
                      tenantId: intent.tenantId,
                      status: 'active',
                      expectedVersion: null,
                    });
                    await sandboxes.create({
                      tenantId: intent.tenantId,
                      sourceTenantId: intent.sourceTenantId,
                      samples: intent.samples,
                      createdAt: new Date(live()).toISOString(),
                    });
                    const copied = await copyTenant(rows, clonePlan, sandboxes, intent);
                    active();
                    let membership: MembershipImage | undefined;
                    if (delegated) {
                      membership = {
                        membershipId: randomUUID(),
                        tenantId: intent.tenantId,
                        accountId: captured.expectedAccount,
                        status: 'active',
                        version: '1',
                        roles: delegated.memberRoles,
                        validUntil: delegated.validUntil,
                      };
                      const { version: _new, ...change } = membership;
                      await administration.putMembership({
                        ...change,
                        expectedVersion: null,
                      });
                    }
                    after = {
                      tenant: {
                        tenantId: intent.tenantId,
                        status: 'active',
                        version: '1',
                      },
                      ...(membership ? { membership } : {}),
                    };
                    cloned = {
                      sourceTenantId: intent.sourceTenantId,
                      samples: intent.samples,
                      rows: Object.values(copied.rows).reduce((sum, n) => sum + n, 0),
                    };
                  } else {
                    // The live tenant's owner approves, through its own membership; an operator never does.
                    if (!delegated) return denyTenant();
                    const current = images.get(intent.tenantId),
                      sandbox = images.get(intent.sandboxTenantId);
                    if (
                      current?.status !== 'active' ||
                      current.version !== intent.expectedTenantVersion ||
                      !sandbox ||
                      sandbox.version !== intent.expectedSandboxVersion
                    )
                      return denyTenant();
                    const record = await sandboxes.read(intent.sandboxTenantId);
                    // Only a sandbox, only into the tenant it was cloned from, and never into another sandbox.
                    if (record?.sourceTenantId !== intent.tenantId || (await sandboxes.read(intent.tenantId))) return denyTenant();
                    const planned = await planImport(rows, clonePlan, sandboxes, intent);
                    if (planned.summary.conflicts.length) return denyTenant();
                    await planned.apply();
                    active();
                    before = { tenant: current };
                    after = { tenant: current };
                    imported = {
                      sandboxTenantId: intent.sandboxTenantId,
                      inserted: planned.summary.inserted,
                      updated: planned.summary.updated,
                      deleted: planned.summary.deleted,
                    };
                  }
                } else {
                  const beforeTenant = await opened().readTenant(session, intent.tenantId, true);
                  if (intent.operation === 'createTenant') {
                    if (beforeTenant) return denyTenant();
                    await administration.putTenant({
                      tenantId: intent.tenantId,
                      status: 'active',
                      expectedVersion: null,
                    });
                    after = {
                      tenant: {
                        tenantId: intent.tenantId,
                        status: 'active',
                        version: '1',
                      },
                    };
                  } else {
                    if (!beforeTenant || beforeTenant.version !== intent.expectedTenantVersion) return denyTenant();
                    before = { tenant: beforeTenant };
                    if (intent.operation === 'setTenantAssistant') {
                      // A tenant's own admin may turn its assistant off, never on: turning it on is the platform owner's.
                      if (!offered(intent.operation) || (delegated !== undefined && intent.enabled)) return denyTenant();
                      if (beforeTenant.status === 'closed' || (intent.enabled && beforeTenant.status !== 'active')) return denyTenant();
                      const switches = opened().assistant(session);
                      const previous = (await switches.read(intent.tenantId)) ?? denyTenant();
                      active();
                      const assistant = {
                        enabled: intent.enabled,
                        consent: intent.consent,
                      };
                      await switches.put(intent.tenantId, assistant, new Date(live()).toISOString());
                      active();
                      before = { tenant: beforeTenant, assistant: previous };
                      after = { tenant: beforeTenant, assistant };
                    } else if (intent.operation === 'setTenantDecisions') {
                      // A tenant's own admin may turn a provider off, never on: turning it on is the platform owner's.
                      if (!providers?.includes(intent.provider) || (delegated !== undefined && intent.enabled)) return denyTenant();
                      if (beforeTenant.status === 'closed' || (intent.enabled && beforeTenant.status !== 'active')) return denyTenant();
                      const switches = opened().decisions(session);
                      const previous = ((await switches.read(intent.tenantId, [intent.provider])) ?? denyTenant())[0];
                      active();
                      const decisions = {
                        provider: intent.provider,
                        enabled: intent.enabled,
                        consent: intent.consent,
                      };
                      await switches.put(intent.tenantId, decisions, new Date(live()).toISOString());
                      active();
                      before = { tenant: beforeTenant, decisions: previous };
                      after = { tenant: beforeTenant, decisions };
                    } else if (intent.operation === 'setTenantStatus') {
                      await administration.putTenant({
                        tenantId: intent.tenantId,
                        status: intent.status,
                        expectedVersion: intent.expectedTenantVersion,
                      });
                      // A closed tenant's conversations go with it, in this transaction; its token counts stay for the bill.
                      if (intent.status === 'closed' && raw.assistant === true) {
                        await opened().assistant(session).forget(intent.tenantId);
                        active();
                      }
                      // Likewise its decision records and switches; the usage rows stay for the bill.
                      if (intent.status === 'closed' && providers !== undefined) {
                        await opened().decisions(session).forget(intent.tenantId);
                        active();
                      }
                      after = {
                        tenant: {
                          ...beforeTenant,
                          status: intent.status,
                          version: next(beforeTenant.version),
                        },
                      };
                    } else {
                      const previous =
                        intent.operation === 'grantMembership'
                          ? null
                          : await opened().readMembership(session, intent.tenantId, intent.membershipId, true);
                      if (intent.operation !== 'grantMembership') {
                        // A delegate never replaces or revokes its own membership.
                        if (
                          !previous ||
                          previous.status === 'revoked' ||
                          previous.version !== intent.expectedMembershipVersion ||
                          previous.roles.some((role) => !grant.roles.includes(role)) ||
                          (delegated !== undefined && previous.accountId === captured.expectedAccount)
                        )
                          return denyTenant();
                        before = { tenant: beforeTenant, membership: previous };
                      }
                      const revoking = intent.operation === 'revokeMembership';
                      if (!revoking) {
                        if (beforeTenant.status !== 'active' || (previous && previous.status !== 'active')) return denyTenant();
                        if (delegated) {
                          if (intent.operation === 'grantMembership' && intent.accountId === captured.expectedAccount) return denyTenant();
                          assertDelegatedTerms(policy, grant.roles, intent.roles, intent.validUntil, live());
                        } else {
                          assertAdministrationRoles(
                            policy,
                            administrationGrant(policy, captured.expectedAccount, intent.tenantId, intent.operation),
                            intent.roles,
                            intent.validUntil,
                            live(),
                          );
                        }
                        requiredAccount = intent.operation === 'grantMembership' ? intent.accountId : previous!.accountId;
                        requiredValidity = intent.validUntil;
                        await current();
                      }
                      const membership: MembershipImage = {
                        membershipId: previous?.membershipId ?? randomUUID(),
                        tenantId: intent.tenantId,
                        accountId: intent.operation === 'grantMembership' ? intent.accountId : previous!.accountId,
                        status: revoking ? 'revoked' : 'active',
                        version: previous ? next(previous.version) : '1',
                        roles: revoking ? previous!.roles : intent.roles,
                        validUntil: revoking ? previous!.validUntil : intent.validUntil,
                      };
                      await administration.putMembership({
                        membershipId: membership.membershipId,
                        tenantId: membership.tenantId,
                        accountId: membership.accountId,
                        status: membership.status,
                        roles: membership.roles,
                        validUntil: membership.validUntil,
                        expectedVersion: previous?.version ?? null,
                      });
                      if (
                        revoking &&
                        previous?.status === 'invited' &&
                        invitationStorage &&
                        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(previous.membershipId)
                      ) {
                        // Older administrative reservations may use non-UUID IDs.
                        // Invitation-owned pairs always use UUIDv4; those unrelated
                        // reservations still retain their ordinary revoke path.
                        const invitations = opened().invitations(session, operations, active);
                        const linked = await invitations.forMembership(previous.membershipId);
                        if (linked) {
                          if (linked.status !== 'pending') return denyTenant();
                          const { digest: _digest, ...image } = linked;
                          invitation = {
                            before: image,
                            after: {
                              ...image,
                              version: next(image.version),
                              status: 'revoked',
                            },
                          };
                          await invitations.transition({
                            invitationId: linked.invitationId,
                            expectedVersion: linked.version,
                            status: 'revoked',
                          });
                        }
                      }
                      after = { tenant: beforeTenant, membership };
                    }
                  }
                }
                grant = (await current()) ?? denyTenant();
                const change = captureChange(
                  {
                    operation: intent.operation,
                    before,
                    after,
                    ...(invitation ? { invitation } : {}),
                    ...(cloned ? { clone: cloned } : {}),
                    ...(imported ? { import: imported } : {}),
                  },
                  intent,
                  grant.roles,
                );
                const receipt: StoredAdministrationReceipt = {
                  ...scope,
                  id: randomUUID(),
                  fingerprint,
                  requestId: randomUUID(),
                  completedAt: new Date(live()).toISOString(),
                  resultJson: JSON.stringify(change),
                };
                await journal.commit(receipt, {
                  policyId: policy.id,
                  policyVersion: policy.version,
                  deployment,
                  sessionId: proof!.sessionId,
                  changeJson: receipt.resultJson,
                });
                await current();
                return {
                  receiptId: receipt.id,
                  requestId: receipt.requestId,
                  completedAt: receipt.completedAt,
                  change,
                  replayed: false,
                };
              },
            );
          });
          completed = returned !== null;
          const finalGrant = (await current()) ?? denyTenant();
          if (returned) captureChange(returned.change, intent, finalGrant.roles);
          live();
          return captureTenantData(returned);
        } catch (error) {
          // A checkout the pool refused leased nothing: busy, not uncertain (tenantWriteSource.ts says why).
          if (error instanceof TransactionOutcomeUnknown || (attempted && !entered && !isPoolBusy(error))) uncertain();
          throw new TenantAdministrationFailure(completed || error instanceof TransactionOutcomeUnknown ? 'unknown' : 'not_applied');
        }
      };
      // Publish the drain entry before trusted clocks or authentication can reenter.
      return tracked(work);
    };
    const invitations =
      invitationPolicy &&
      createTenantInvitationOperations({
        binding: owner,
        policy: invitationPolicy,
        auth,
        deployment,
        clock,
        lifetime,
        tracked,
        uncertain,
        // Email invitations reach the native auth store only through this capability (authAccounts.ts).
        accounts: Object.freeze({
          emailSignIn: auth.spec.providers.includes('email'),
          emailOf: (accountId: string) => nativeAccountEmailOf(raw.auth as AppAuthRuntime, accountId),
          findByEmail: (email: string) => findNativeAccountByEmail(raw.auth as AppAuthRuntime, email),
          create: (input: NativeAccountInput, invitationId: string) =>
            createNativeAccount(raw.auth as AppAuthRuntime, input, {
              by: 'invitation',
              invitationId,
            }),
        }),
        // One queue, writer, transaction lifetime and drain for every maintenance
        // operation. Recipient admission never opens an administration session.
        transact: (checks, work) =>
          queue.run(() =>
            maintenance(
              (session) => {
                clock();
                if (engine === 'postgres')
                  return (async () => {
                    await opened().assertJournal(session);
                    await opened().assertInvitations(session);
                    checks.active();
                    await checks.observe();
                    // No storage await may follow this native observation. The shared
                    // maintenance owner already attested links, and drained before final.
                    checks.active();
                  })();
                if (opened().assertJournal(session) !== undefined || opened().assertInvitations(session) !== undefined) return denyTenant();
                checks.active();
              },
              (session, operations, assertCurrent) =>
                work((active) => opened().invitationTransaction(session, operations, active, assertCurrent), assertCurrent),
            ),
          ),
      });
    const supportHistory = support?.create({
      clock,
      tracked,
      uncertain,
      transact: (live, work) =>
        queue.run(() =>
          maintenance(
            (session) => {
              clock();
              if (opened().assertJournal(session) !== undefined) return denyTenant();
              supportCurrent();
              live();
            },
            (session, operations, assertCurrent) => {
              const store = opened();
              if (!store.supportAudit) return denyTenant();
              const active = () => {
                clock();
                live();
                assertCurrent();
              };
              return work(store.journal(session, operations, active), store.supportAudit(session, operations, active), active);
            },
          ),
        ),
    });
    /* A SCIM directory bound to one tenant writes that tenant's member rows
       after its own transaction has committed (auth/scimDirectory.ts). No
       session, policy grant or receipt stands behind it: the directory's bearer
       token and the config file that binds it to this tenant are its authority,
       and the account audit already records what it did. A member it makes
       holds no end date, since the directory is what ends it. */
    const directories = new Map<string, string>();
    if (raw.directories !== undefined) {
      const given = captureTenantData(raw.directories) as Record<string, unknown>;
      tenantRecord(given, Object.keys(given));
      for (const [name, tenantId] of Object.entries(given)) {
        tenantIdentifier(name);
        tenantIdentifier(tenantId, 128);
        parseTenantSelector([tenantId as string]);
        directories.set(name, tenantId as string);
      }
    }
    const directory = (name: string): TenantDirectory => {
      const tenantId = directories.get(name) ?? denyTenant();
      return Object.freeze({
        apply: (accountId: string, roles: readonly string[] | null) =>
          tracked(async () => {
            tenantIdentifier(accountId, 1024);
            const granted = roles === null ? null : [...new Set(captureTenantData(roles) as string[])];
            if (granted) for (const role of granted) tenantIdentifier(role);
            return queue.run(() =>
              maintenance<boolean>(
                (session) =>
                  attested(session, () => {
                    clock();
                  }),
                async (session, operations, assertCurrent) => {
                  const active = () => {
                    clock();
                    assertCurrent();
                  };
                  const tenant = await opened().readTenant(session, tenantId, true);
                  const id = await opened().liveMembershipId(session, tenantId, accountId);
                  const previous = id ? await opened().readMembership(session, tenantId, id, true) : null;
                  active();
                  const administration = opened().administration(session, operations, active);
                  if (!granted || !granted.length) {
                    if (!previous) return false;
                    await administration.putMembership({
                      membershipId: previous.membershipId,
                      tenantId,
                      accountId,
                      status: 'revoked',
                      roles: previous.roles,
                      validUntil: previous.validUntil,
                      expectedVersion: previous.version,
                    });
                    return true;
                  }
                  // A suspended or closed tenant takes no member; the directory's next push lands once it is active again.
                  if (tenant?.status !== 'active') return false;
                  if (
                    previous?.status === 'active' &&
                    sameRoles(previous.roles, granted) &&
                    previous.validUntil === Number.MAX_SAFE_INTEGER
                  )
                    return false;
                  await administration.putMembership({
                    membershipId: previous?.membershipId ?? randomUUID(),
                    tenantId,
                    accountId,
                    status: 'active',
                    roles: granted,
                    validUntil: Number.MAX_SAFE_INTEGER,
                    expectedVersion: previous?.version ?? null,
                  });
                  return true;
                },
              ),
            );
          }),
      });
    };
    return Object.freeze({
      ...(directories.size ? { directory } : {}),
      ...(supportHistory ? { supportHistory } : {}),
      ...(invitations ? { invitations } : {}),
      open,
      tenants,
      memberships,
      usage,
      decisionUsage,
      importPlan,
      execute: async (request: IncomingMessage, input: AdministrationRequest) => (await run(true, request, input))!,
      status: (request: IncomingMessage, input: AdministrationRequest) => run(false, request, input),
      retire,
    });
  } catch {
    try {
      await store?.close();
    } catch {
      /* Nothing is published after failed acquisition. */
    }
    throw new TenantAdministrationFailure('not_applied');
  }
}
