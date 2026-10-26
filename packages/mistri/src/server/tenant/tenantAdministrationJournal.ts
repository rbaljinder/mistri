import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isPromise, isProxy } from 'node:util/types';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { captureTenantData, denyTenant, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { assertSqliteTenantStore, type TenantStoreBinding } from './tenantStore.js';
import { denyAgain, denyLayout } from './tenantStoreContract.js';
import {
  ADMINISTRATION_JOURNAL_PREFIX,
  ADMINISTRATION_JOURNAL_TABLES,
  binding,
  receiptFields,
  scopeFields,
  scopeValues,
  validateAudit,
  validatePair,
  validateReceipt,
  type AdministrationAudit,
  type AdministrationReceiptScope,
  type StoredAdministrationReceipt,
  type TenantAdministrationJournal,
} from './tenantAdministrationJournalContract.js';

/* Names, shapes and validation are engine-neutral
   (tenantAdministrationJournalContract.ts), re-exported for existing importers. */
export { ADMINISTRATION_JOURNAL_TABLES } from './tenantAdministrationJournalContract.js';
export type {
  AdministrationAudit,
  AdministrationReceiptScope,
  StoredAdministrationReceipt,
  TenantAdministrationJournal,
} from './tenantAdministrationJournalContract.js';

const prefix = ADMINISTRATION_JOURNAL_PREFIX;
const tables = ADMINISTRATION_JOURNAL_TABLES;
const identifierColumn = (name: string, maximum = 256) =>
  `${name} TEXT COLLATE BINARY NOT NULL CHECK (typeof(${name}) = 'text' AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${maximum})`;
const definitions = new Map<string, string>([
  [
    tables.meta,
    `CREATE TABLE "${tables.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 1),
  ${identifierColumn('app_id', 1024)},
  ${identifierColumn('source_id')},
  ${identifierColumn('store_id', 1024)}
)`,
  ],
  [
    tables.receipt,
    `CREATE TABLE "${tables.receipt}" (
  ${identifierColumn('id', 1024)} PRIMARY KEY,
  ${identifierColumn('actor_id', 1024)},
  ${identifierColumn('tenant_id', 128)},
  ${identifierColumn('operation')},
  operation_version INTEGER NOT NULL CHECK (typeof(operation_version) = 'integer' AND operation_version BETWEEN 1 AND 9007199254740991),
  ${identifierColumn('idempotency_key')},
  ${identifierColumn('fingerprint')},
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 16384),
  ${identifierColumn('request_id', 1024)},
  ${identifierColumn('completed_at', 32)},
  ${identifierColumn('policy_id')},
  ${identifierColumn('policy_version')},
  ${identifierColumn('deployment')},
  ${identifierColumn('session_id', 1024)},
  change_json TEXT NOT NULL CHECK (json_valid(change_json) AND length(CAST(change_json AS BLOB)) <= 65536),
  UNIQUE (actor_id, tenant_id, operation, operation_version, idempotency_key)
)`,
  ],
]);

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
function attest(db: DatabaseSync, owner: TenantStoreBinding): void {
  assertSqliteTenantStore(db, owner);
  const entries = catalog(db, 'main');
  if (
    catalog(db, 'temp').length ||
    entries.filter((entry) => entry.type === 'table').length !== definitions.size ||
    entries.some((entry) =>
      entry.type === 'table'
        ? definitions.get(entry.name) !== entry.sql
        : entry.type !== 'index' || entry.sql !== null || !definitions.has(entry.tbl_name),
    )
  )
    return denyLayout(layoutRefusal('The tenant administration journal', sqliteLayoutVersion(db, tables.meta), 1));
  const rows = db.prepare(`SELECT singleton, version, app_id, source_id, store_id FROM main."${tables.meta}"`).all();
  if (
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    rows[0].version !== 1 ||
    rows[0].app_id !== owner.appId ||
    rows[0].source_id !== owner.source.id ||
    rows[0].store_id !== owner.storeId
  )
    denyLayout(layoutRefusal('The tenant administration journal', rows.length === 1 ? rows[0].version : undefined, 1));
}
export function assertSqliteTenantAdministrationJournal(db: DatabaseSync, input: TenantStoreBinding): void {
  try {
    attest(db, binding(input));
  } catch (error) {
    denyAgain(error);
  }
}

/** Explicit existing-file maintenance. Never upgrades, repairs or adopts a partial namespace. */
export function provisionSqliteTenantAdministrationJournal(
  existingPath: string,
  input: TenantStoreBinding,
): { version: 1; provisioned: boolean } {
  let db: DatabaseSync | undefined;
  try {
    const owner = binding(input);
    if (typeof existingPath !== 'string' || !statSync(existingPath).isFile()) return denyTenant();
    db = new DatabaseSync(existingPath);
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    assertSqliteTenantStore(db, owner);
    if (catalog(db, 'temp').length) return denyTenant();
    const provisioned = catalog(db, 'main').length === 0;
    if (provisioned) {
      for (const ddl of definitions.values()) db.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE main.'));
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
      /* The local handle is discarded. */
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

/** Owner-only composition on the existing writer and queue. The owner must
 * drain/retire that queue before ending the transaction; no handle escapes here. */
export function createSqliteTenantAdministrationJournal(
  db: DatabaseSync,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  assertActive?: () => void,
): TenantAdministrationJournal {
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
    // Preserve the queue's fire-and-forget behavior after sanitizing its errors.
    void pending.catch(() => {});
    return pending;
  };
  return Object.freeze({
    read: (scope: AdministrationReceiptScope) =>
      invoke(scope, (value) => {
        tenantRecord(value, scopeFields);
        const row = db
          .prepare(`SELECT id, actor_id AS actorId, tenant_id AS tenantId, operation,
        operation_version AS operationVersion, idempotency_key AS idempotencyKey, fingerprint,
        result_json AS resultJson, request_id AS requestId, completed_at AS completedAt,
        policy_id AS policyId, policy_version AS policyVersion, deployment, session_id AS sessionId, change_json AS changeJson
        FROM main."${tables.receipt}"
        WHERE actor_id = ? AND tenant_id = ? AND operation = ? AND operation_version = ? AND idempotency_key = ?`)
          .get(...scopeValues(value));
        if (!row) return null;
        const receipt = Object.fromEntries(receiptFields.map((field) => [field, row[field]])) as unknown as StoredAdministrationReceipt;
        validateReceipt(receipt);
        const audit = {
          policyId: row.policyId,
          policyVersion: row.policyVersion,
          deployment: row.deployment,
          sessionId: row.sessionId,
          changeJson: row.changeJson,
        } as AdministrationAudit;
        validateAudit(audit);
        validatePair(receipt, audit);
        return Object.freeze(receipt);
      }),
    commit: (receipt: StoredAdministrationReceipt, audit: AdministrationAudit) =>
      invoke({ receipt, audit }, ({ receipt, audit }) => {
        validateReceipt(receipt);
        validateAudit(audit);
        validatePair(receipt, audit);
        db.prepare(`INSERT INTO main."${tables.receipt}"
        (id, actor_id, tenant_id, operation, operation_version, idempotency_key, fingerprint, result_json, request_id, completed_at,
        policy_id, policy_version, deployment, session_id, change_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          receipt.id,
          ...scopeValues(receipt),
          receipt.fingerprint,
          receipt.resultJson,
          receipt.requestId,
          receipt.completedAt,
          audit.policyId,
          audit.policyVersion,
          audit.deployment,
          audit.sessionId,
          audit.changeJson,
        );
      }),
  });
}
