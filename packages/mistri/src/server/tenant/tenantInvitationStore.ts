import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isPromise, isProxy } from 'node:util/types';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { assertSqliteTenantAdministrationJournal } from './tenantAdministrationJournal.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { captureTenantData, denyTenant, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import type { TenantStoreBinding } from './tenantStore.js';
import { denyAgain, denyLayout } from './tenantStoreContract.js';
import { invitationUuid as uuid, invitationRevision as revision, planInvitationTransition } from './tenantInvitationTransition.js';
import {
  captureStoredTenantInvitation,
  invitationBinding as binding,
  invitationFields as fields,
  invitationColumns as columns,
  decodeInvitationRow,
  invitationRowValues,
  type StoredTenantInvitation,
} from './tenantInvitationStoreContract.js';
export { captureStoredTenantInvitation, type StoredTenantInvitation } from './tenantInvitationStoreContract.js';

const prefix = '__mistri_invitation_';
export const INVITATION_TABLES = Object.freeze({ meta: `${prefix}meta`, invitation: `${prefix}invitation` });
const tables = INVITATION_TABLES;
const textColumns = columns.filter((column) => !['created_at', 'redeem_until', 'valid_until'].includes(column));
const textColumn = (name: string, maximum: number) =>
  `${name} TEXT COLLATE BINARY NOT NULL CHECK (typeof(${name}) = 'text' AND instr(${name}, char(0)) = 0 AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${maximum})`;
const revisionColumn = (name: string) => `${textColumn(name, 128)} CHECK (${name} GLOB '[1-9]*' AND ${name} NOT GLOB '*[^0-9]*')`;
const timeColumn = (name: string) =>
  `${name} INTEGER NOT NULL CHECK (typeof(${name}) = 'integer' AND ${name} BETWEEN 0 AND 9007199254740991)`;
const definitions = new Map<string, string>([
  [
    tables.meta,
    `CREATE TABLE "${tables.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  ${textColumn('app_id', 1024)},
  ${textColumn('source_id', 256)},
  ${textColumn('store_id', 1024)}
)`,
  ],
  [
    tables.invitation,
    `CREATE TABLE "${tables.invitation}" (
  ${textColumn('invitation_id', 36)} PRIMARY KEY,
  ${revisionColumn('version')},
  ${textColumn('tenant_id', 128)},
  ${textColumn('membership_id', 36)} UNIQUE,
  ${textColumn('account_id', 1024)},
  ${textColumn('inviter_id', 1024)},
  ${textColumn('issuance_operation', 17)} CHECK (issuance_operation IN ('issueInvitation', 'reissueInvitation')),
  ${textColumn('roles_json', 262144)} CHECK (json_valid(roles_json) AND json_type(roles_json) = 'array' AND json_array_length(roles_json) BETWEEN 1 AND 256),
  ${revisionColumn('expected_tenant_version')},
  ${textColumn('policy_id', 256)},
  ${textColumn('policy_version', 256)},
  ${timeColumn('created_at')},
  ${timeColumn('redeem_until')},
  ${timeColumn('valid_until')},
  ${textColumn('status', 8)} CHECK (status IN ('pending', 'accepted', 'revoked')),
  ${textColumn('digest', 64)} CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (created_at < redeem_until AND redeem_until <= valid_until)
)`,
  ],
]);

/* A tenant's pending invitations, in id order, are what listing and the
   pending ceiling read: the one index this layout creates beyond its keys. */
const indexes = new Map<string, string>([
  [
    `${tables.invitation}_tenant`,
    `CREATE INDEX "${tables.invitation}_tenant" ON "${tables.invitation}" (tenant_id, status, invitation_id)`,
  ],
]);

function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  tenantRecord(value, keys);
  if (keys.some((key) => !Object.hasOwn(value, key))) denyTenant();
}
interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
function catalog(db: DatabaseSync, schema: 'main' | 'temp'): CatalogEntry[] {
  return db
    .prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`)
    .all(prefix.length, prefix, prefix.length, prefix) as unknown as CatalogEntry[];
}
// node:sqlite can truncate returned TEXT at NUL. Check the stored values in SQL
// as well as validating JS values, including when CHECK constraints were bypassed.
const intactText = (names: readonly string[]) =>
  names.map((name) => `(typeof(${name}) = 'text' AND instr(${name}, char(0)) = 0)`).join(' AND ');
function attest(db: DatabaseSync, owner: TenantStoreBinding): void {
  assertSqliteTenantAdministrationJournal(db, owner);
  const entries = catalog(db, 'main');
  if (
    catalog(db, 'temp').length ||
    entries.filter((entry) => entry.type === 'table').length !== definitions.size ||
    entries.filter((entry) => entry.type === 'index' && entry.sql !== null).length !== indexes.size ||
    entries.some((entry) =>
      entry.type === 'table'
        ? definitions.get(entry.name) !== entry.sql
        : entry.type !== 'index' || (entry.sql === null ? !definitions.has(entry.tbl_name) : indexes.get(entry.name) !== entry.sql),
    )
  )
    return denyLayout(layoutRefusal('The tenant invitation store', sqliteLayoutVersion(db, tables.meta), 1));
  const rows = db
    .prepare(`SELECT singleton, version, app_id, source_id, store_id,
    ${intactText(['app_id', 'source_id', 'store_id'])} AS intact_text FROM main."${tables.meta}"`)
    .all();
  if (
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    rows[0].version !== 1 ||
    rows[0].intact_text !== 1 ||
    rows[0].app_id !== owner.appId ||
    rows[0].source_id !== owner.source.id ||
    rows[0].store_id !== owner.storeId
  )
    denyLayout(layoutRefusal('The tenant invitation store', rows.length === 1 ? rows[0].version : undefined, 1));
  // Linked invitation/member consistency belongs to the owner's entry/final
  // fences. Checking it here would reject the midpoint of an atomic transition.
}
export function assertSqliteTenantInvitations(db: DatabaseSync, input: TenantStoreBinding): void {
  try {
    attest(db, binding(input));
  } catch (error) {
    denyAgain(error);
  }
}

/** Explicit stopped-file maintenance only. Does not migrate any existing namespace. */
export function provisionSqliteTenantInvitations(existingPath: string, input: TenantStoreBinding): { version: 1; provisioned: boolean } {
  let db: DatabaseSync | undefined;
  try {
    const owner = binding(input);
    if (typeof existingPath !== 'string' || !statSync(existingPath).isFile()) return denyTenant();
    db = new DatabaseSync(existingPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    assertSqliteTenantAdministrationJournal(db, owner);
    if (catalog(db, 'temp').length) return denyTenant();
    const provisioned = catalog(db, 'main').length === 0;
    if (provisioned) {
      for (const ddl of definitions.values()) db.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE main.'));
      for (const [name, ddl] of indexes) db.exec(ddl.replace(`CREATE INDEX "${name}"`, `CREATE INDEX main."${name}"`));
      db.prepare(`INSERT INTO main."${tables.meta}" (singleton, version, app_id, source_id, store_id) VALUES (1, 1, ?, ?, ?)`).run(
        owner.appId,
        owner.source.id,
        owner.storeId,
      );
    }
    attest(db, owner);
    db.exec('COMMIT');
    return { version: 1, provisioned };
  } catch {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* Discard the private maintenance handle. */
    }
    return denyTenant();
  } finally {
    try {
      db?.close();
    } catch {
      denyTenant();
    }
  }
}

function read(db: DatabaseSync, column: 'invitation_id' | 'membership_id', id: string): StoredTenantInvitation | null {
  uuid(id);
  const row = db
    .prepare(`SELECT ${columns.map((name, index) => `${name} AS "${fields[index]}"`).join(', ')},
    ${intactText(textColumns)} AS intact_text FROM main."${tables.invitation}" WHERE ${column} = ? COLLATE BINARY`)
    .get(id);
  if (!row) return null;
  if (row.intact_text !== 1) return denyTenant();
  const { intact_text: _intact, ...meaning } = row;
  return decodeInvitationRow(meaning);
}

/** Compose on the owner's existing queue; drain/retirement remains its responsibility. */
export function createSqliteTenantInvitations(
  db: DatabaseSync,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  assertActive?: () => void,
) {
  const owner = binding(input);
  if (assertActive !== undefined && (typeof assertActive !== 'function' || isProxy(assertActive))) return denyTenant();
  const verified = () => {
    if (!db.isTransaction) return denyTenant();
    attest(db, owner);
    if (assertActive) {
      const result = assertActive();
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined) return denyTenant();
    }
    if (!db.isTransaction) return denyTenant();
    attest(db, owner);
  };
  const invoke = <A, R>(input: A, work: (captured: A) => R): Promise<R> => {
    let captured: A,
      invalid = false;
    try {
      captured = captureTenantData(input);
    } catch {
      invalid = true;
    }
    const pending = operations
      .run(async () => {
        try {
          if (invalid) return denyTenant();
          verified();
          const result = work(captured!);
          verified();
          return result;
        } catch (error) {
          return denyAgain(error);
        }
      })
      .catch((error) => denyAgain(error));
    void pending.catch(() => {});
    return pending;
  };
  return Object.freeze({
    read: (invitationId: string): Promise<StoredTenantInvitation | null> => invoke(invitationId, (id) => read(db, 'invitation_id', id)),
    forMembership: (membershipId: string): Promise<StoredTenantInvitation | null> =>
      invoke(membershipId, (id) => read(db, 'membership_id', id)),
    insert: (input: StoredTenantInvitation): Promise<void> =>
      invoke(input, (value) => {
        const row = captureStoredTenantInvitation(value);
        if (row.status !== 'pending' || row.version !== '1') return denyTenant();
        db.prepare(`INSERT INTO main."${tables.invitation}" (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
          ...invitationRowValues(row),
        );
      }),
    transition: (input: { invitationId: string; expectedVersion: string; status: 'accepted' | 'revoked' }): Promise<void> =>
      invoke(input, (value) => {
        exact(value, ['invitationId', 'expectedVersion', 'status']);
        uuid(value.invitationId);
        revision(value.expectedVersion);
        if (value.status !== 'accepted' && value.status !== 'revoked') return denyTenant();
        const current = read(db, 'invitation_id', value.invitationId);
        const plan = planInvitationTransition(
          current && { invitationId: current.invitationId, version: current.version, status: current.status },
          value,
        );
        if (
          db
            .prepare(`UPDATE main."${tables.invitation}" SET status = ?, version = ?
        WHERE invitation_id = ? COLLATE BINARY AND version = ? COLLATE BINARY AND status = 'pending'`)
            .run(plan.status, plan.nextVersion, plan.invitationId, plan.expectedVersion).changes !== 1
        )
          denyTenant();
      }),
  });
}
