/**
 * Fixed support-row facts on the support owner's borrowed writer transaction:
 * the `@platform` anchor, a dealer, an account's platform membership and its
 * support rows, and the two support writes (insert, compare-and-set revoke).
 * Each method is one operation on the owner's queue. Nothing here decides
 * eligibility, reads a policy or grants a role; the owner does, under the
 * lock order its PostgreSQL counterpart documents. The rows are parsed
 * strictly, so a malformed row refuses instead of admitting.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector } from './tenantMembership.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';
import { nextRevision, revision, roles, TENANT_TABLES, time } from './tenantStoreContract.js';

export interface SupportAnchor {
  readonly id: string;
  readonly kind: 'tenant' | 'platform';
  readonly status: 'active' | 'suspended' | 'closed';
  readonly version: string;
}
export interface SupportMember {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly kind: 'member' | 'support';
  readonly status: 'active' | 'invited' | 'revoked';
  readonly version: string;
  readonly roles: readonly string[];
  readonly validUntil: number;
  readonly parentId: string | null;
  readonly parentVersion: string | null;
  readonly platformVersion: string | null;
}
export interface SupportInsert {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly role: string;
  readonly validUntil: number;
  readonly parentId: string;
  readonly parentVersion: string;
  readonly platformVersion: string;
}
/** Locks: on PostgreSQL `platform`, `tenant` and `member` take the row FOR
 * UPDATE; the locators take none. SQLite's writer reservation holds all. */
export interface SupportFacts {
  platform(): Promise<SupportAnchor | null>;
  tenant(id: string): Promise<SupportAnchor | null>;
  /** The account's live platform membership id, unlocked: a locator only. */
  parentLocator(accountId: string): Promise<string | null>;
  /** The account's active support rows, unlocked: locators only. */
  supportLocators(accountId: string): Promise<readonly SupportMember[]>;
  member(id: string): Promise<SupportMember | null>;
  /** Active dealers in byte order, for a grant naming every dealer. */
  activeTenants(limit: number): Promise<readonly string[]>;
  insertSupport(row: SupportInsert): Promise<void>;
  revokeSupport(id: string, expectedVersion: string): Promise<void>;
}

/** Identity text: no control character, no lone surrogate (PostgreSQL would
 * store, and so match, a lone surrogate as U+FFFD). */
export function supportText(value: unknown, maximum = 1024): string {
  tenantIdentifier(value, maximum);
  if (/\p{Cs}/u.test(value)) return denyTenant();
  return value;
}
/** SQLite's integer or PostgreSQL's `::text` rendering of a bigint instant. */
function instant(value: unknown): number {
  if (typeof value === 'string') {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) return denyTenant();
    value = Number(value);
  }
  time(value);
  return value;
}
export function supportAnchorRow(input: unknown, kind: SupportAnchor['kind']): SupportAnchor {
  const row = captureTenantData(input);
  tenantRecord(row, ['id', 'kind', 'status', 'version']);
  const id = supportText(row.id, 128);
  if (kind === 'platform' ? id !== PLATFORM_TENANT_ID : parseTenantSelector([id]) !== id) return denyTenant();
  if (row.kind !== kind || !['active', 'suspended', 'closed'].includes(row.status as string)) return denyTenant();
  revision(row.version);
  return Object.freeze({ id, kind, status: row.status as SupportAnchor['status'], version: row.version });
}
export function supportMemberRow(input: unknown): SupportMember {
  const row = captureTenantData(input);
  tenantRecord(row, [
    'id',
    'tenant_id',
    'account_id',
    'kind',
    'status',
    'version',
    'roles_json',
    'valid_until',
    'parent_id',
    'parent_version',
    'platform_version',
  ]);
  const id = supportText(row.id),
    tenantId = supportText(row.tenant_id, 128),
    accountId = supportText(row.account_id);
  if (tenantId !== PLATFORM_TENANT_ID) parseTenantSelector([tenantId]);
  if (!['member', 'support'].includes(row.kind as string) || !['active', 'invited', 'revoked'].includes(row.status as string))
    return denyTenant();
  revision(row.version);
  if (typeof row.roles_json !== 'string') return denyTenant();
  let granted: unknown;
  try {
    granted = JSON.parse(row.roles_json);
  } catch {
    return denyTenant();
  }
  roles(granted);
  for (const role of granted) supportText(role, 256);
  const validUntil = instant(row.valid_until);
  let parentId: string | null = null,
    parentVersion: string | null = null,
    platformVersion: string | null = null;
  if (row.kind === 'support') {
    parentId = supportText(row.parent_id);
    revision(row.parent_version);
    revision(row.platform_version);
    parentVersion = row.parent_version;
    platformVersion = row.platform_version;
    if (row.status === 'invited' || granted.length !== 1 || tenantId === PLATFORM_TENANT_ID) return denyTenant();
  } else if (row.parent_id !== null || row.parent_version !== null || row.platform_version !== null) return denyTenant();
  return Object.freeze({
    id,
    tenantId,
    accountId,
    kind: row.kind as SupportMember['kind'],
    status: row.status as SupportMember['status'],
    version: row.version,
    roles: Object.freeze([...granted]),
    validUntil,
    parentId,
    parentVersion,
    platformVersion,
  });
}
export function supportInsertRow(input: SupportInsert): SupportInsert {
  const value = captureTenantData(input);
  tenantRecord(value, ['id', 'tenantId', 'accountId', 'role', 'validUntil', 'parentId', 'parentVersion', 'platformVersion']);
  supportText(value.id);
  supportText(value.accountId);
  supportText(value.role, 256);
  supportText(value.parentId);
  parseTenantSelector([supportText(value.tenantId, 128)]);
  time(value.validUntil);
  revision(value.parentVersion);
  revision(value.platformVersion);
  return value;
}
export const MEMBER_COLUMNS =
  'id, tenant_id, account_id, kind, status, version, roles_json, valid_until, parent_id, parent_version, platform_version';

/** One queued operation with the owner's liveness fence on both sides. */
export function supportOperation(operations: TransactionOperations, active: () => void) {
  return <T>(work: () => T | Promise<T>): Promise<T> => {
    const pending = operations.run(async () => {
      active();
      const result = await work();
      active();
      return result;
    });
    void pending.catch(() => {});
    return pending;
  };
}

/** The owner supplies its genuine writer handle inside BEGIN IMMEDIATE. */
export function createSqliteSupportFacts(db: DatabaseSync, operations: TransactionOperations, active: () => void): SupportFacts {
  const run = supportOperation(operations, active);
  const member = `main."${TENANT_TABLES.membership}"`,
    tenant = `main."${TENANT_TABLES.tenant}"`;
  const inTransaction = () => {
    if (!db.isTransaction) denyTenant();
  };
  const anchor = (id: string, kind: SupportAnchor['kind']) => {
    inTransaction();
    const row = db.prepare(`SELECT id, kind, status, version FROM ${tenant} WHERE id = ? COLLATE BINARY AND kind = ?`).get(id, kind);
    return row ? supportAnchorRow({ ...row }, kind) : null;
  };
  return Object.freeze({
    platform: () => run(() => anchor(PLATFORM_TENANT_ID, 'platform')),
    tenant: (id: string) =>
      run(() => {
        parseTenantSelector([supportText(id, 128)]);
        return anchor(id, 'tenant');
      }),
    parentLocator: (accountId: string) =>
      run(() => {
        inTransaction();
        supportText(accountId);
        const rows = db
          .prepare(`SELECT id FROM ${member} WHERE tenant_id = ? COLLATE BINARY AND account_id = ? COLLATE BINARY
        AND kind = 'member' AND status <> 'revoked'`)
          .all(PLATFORM_TENANT_ID, accountId);
        if (rows.length > 1) return denyTenant();
        return rows.length ? supportText(rows[0].id) : null;
      }),
    supportLocators: (accountId: string) =>
      run(() => {
        inTransaction();
        supportText(accountId);
        const rows = db
          .prepare(`SELECT ${MEMBER_COLUMNS} FROM ${member} WHERE account_id = ? COLLATE BINARY
        AND kind = 'support' AND status = 'active' ORDER BY id COLLATE BINARY`)
          .all(accountId)
          .map((row) => supportMemberRow({ ...row }));
        // The live-support index allows one; more means the store is not ours.
        if (rows.length > 1 || rows.some((row) => row.accountId !== accountId)) return denyTenant();
        return Object.freeze(rows);
      }),
    member: (id: string) =>
      run(() => {
        inTransaction();
        const row = db.prepare(`SELECT ${MEMBER_COLUMNS} FROM ${member} WHERE id = ? COLLATE BINARY`).get(supportText(id));
        return row ? supportMemberRow({ ...row }) : null;
      }),
    activeTenants: (limit: number) =>
      run(() => {
        inTransaction();
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) return denyTenant();
        return Object.freeze(
          db
            .prepare(`SELECT id FROM ${tenant} WHERE kind = 'tenant' AND status = 'active'
        ORDER BY id COLLATE BINARY LIMIT ?`)
            .all(limit)
            .map((row) => parseTenantSelector([supportText(row.id, 128)])),
        );
      }),
    insertSupport: (input: SupportInsert) =>
      run(() => {
        inTransaction();
        const row = supportInsertRow(input);
        const result = db
          .prepare(`INSERT INTO ${member} (id, tenant_id, account_id, status, version, roles_json, valid_until, kind,
        parent_id, parent_version, platform_version) VALUES (?, ?, ?, 'active', '1', ?, ?, 'support', ?, ?, ?)`)
          .run(
            row.id,
            row.tenantId,
            row.accountId,
            JSON.stringify([row.role]),
            row.validUntil,
            row.parentId,
            row.parentVersion,
            row.platformVersion,
          );
        if (result.changes !== 1) denyTenant();
      }),
    revokeSupport: (id: string, expectedVersion: string) =>
      run(() => {
        inTransaction();
        supportText(id);
        revision(expectedVersion);
        const result = db
          .prepare(`UPDATE ${member} SET status = 'revoked', version = ?
        WHERE id = ? COLLATE BINARY AND kind = 'support' AND status = 'active' AND version = ?`)
          .run(nextRevision(expectedVersion), id, expectedVersion);
        if (result.changes !== 1) denyTenant();
      }),
  });
}
