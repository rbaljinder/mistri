/** Durable placed-public receipt and audit operations, separate from native membership journals. */
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Refusal, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { commandJournalValidation as rules } from './commandJournal.js';
import type { CommandAudit, CommandJournal, CommandReceiptScope, StoredCommandReceipt } from './commandJournalTypes.js';
import type { PublicPlacementAdmission, PublicPlacementOwner } from './publicPlacementTypes.js';
import { capturePublicPlacementOwner } from './publicPlacementTransaction.js';
import {
  PUBLIC_PLACEMENT_TABLES as tables,
  placementNamespaceColumns,
  placementReceiptColumns,
  placementTable,
  assertSqlitePublicPlacementJournal,
  assertPostgresPublicPlacementJournal,
} from './publicPlacementSchema.js';

export { provisionSqlitePublicPlacementJournal, provisionPostgresPublicPlacementJournal } from './publicPlacementSchema.js';

type Value = string | number;
type Query = (sql: string, params: readonly Value[]) => Promise<Record<string, unknown>[]>;
type Dialect = 'sqlite' | 'postgres';
const refuse = (): never => {
  throw new Refusal('Public placement receipt is unavailable.');
};
const text: (value: unknown, field: string, max: number) => void = rules.text;
const ownerOf = (admission: PublicPlacementAdmission): PublicPlacementOwner =>
  capturePublicPlacementOwner({
    issuerId: admission.issuerId,
    sourceIdentity: admission.sourceIdentity,
    appId: admission.appId,
    form: admission.form,
    tenant: admission.tenant,
    commandId: admission.commandId,
    commandVersion: admission.commandVersion,
  });
function namespace(owner: PublicPlacementOwner, submission: string): Value[] {
  text(submission, 'submission', 256);
  return [owner.issuerId, owner.sourceIdentity, owner.appId, owner.form, owner.tenant, owner.commandId, owner.commandVersion, submission];
}
function scopeValues(owner: PublicPlacementOwner, scope: CommandReceiptScope): Value[] {
  rules.record(scope, rules.receiptFields);
  rules.scopeValues(scope);
  if (
    scope.appId !== owner.appId ||
    scope.actorId !== `public:${owner.form}` ||
    scope.commandId !== owner.commandId ||
    scope.commandVersion !== owner.commandVersion
  )
    refuse();
  return namespace(owner, scope.idempotencyKey);
}
/* A JSON array of texts, as packTargets wrote it; anything else is not this journal's row. */
function texts(value: unknown): string[] {
  if (typeof value !== 'string') return refuse();
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return refuse();
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) refuse();
  return parsed as string[];
}
const placeholder = (dialect: Dialect, index: number) => (dialect === 'sqlite' ? '?' : `$${index + 1}`);
const where = (dialect: Dialect) =>
  placementNamespaceColumns.map((column, index) => `${column} = ${placeholder(dialect, index)}`).join(' AND ');

/** Shared validated storage lookup. Epoch is historical provenance only. No
 * policy re-resolution, handler lookup, input validation or business reads. */
async function lookup(
  query: Query,
  dialect: Dialect,
  owner: PublicPlacementOwner,
  submission: string,
): Promise<StoredCommandReceipt | undefined> {
  const values = namespace(owner, submission);
  const rows = await query(
    `SELECT ${placementReceiptColumns.join(', ')} FROM ${placementTable(dialect, tables.receipt)} WHERE ${where(dialect)}`,
    values,
  );
  if (!rows.length) return undefined;
  if (rows.length !== 1) refuse();
  const row = rows[0];
  if (placementNamespaceColumns.some((column, index) => row[column] !== values[index])) refuse();
  text(row.epoch, 'historical epoch', 256);
  const receipt: StoredCommandReceipt = {
    id: row.id as string,
    appId: owner.appId,
    actorId: `public:${owner.form}`,
    commandId: owner.commandId,
    commandVersion: owner.commandVersion,
    idempotencyKey: submission,
    fingerprint: row.fingerprint as string,
    resultJson: row.result_json as string,
    requestId: row.request_id as string,
    completedAt: row.completed_at as string,
  };
  rules.validateReceipt(receipt);
  const keys = texts(row.keys_json),
    changes = texts(row.changes_json);
  if (!keys.length || keys.length !== changes.length) refuse();
  rules.auditEntries(
    keys.map((keyJson, index) => ({ target: row.target, keyJson, changesJson: changes[index] }) as CommandAudit),
    undefined,
  );
  return Object.freeze(receipt);
}

function journal(query: Query, dialect: Dialect, operations: TransactionOperations, admission: PublicPlacementAdmission): CommandJournal {
  const owner = ownerOf(admission);
  const invoke = <A, R>(input: A, work: (input: A) => Promise<R>): Promise<R> => {
    let captured: A;
    try {
      captured = rules.capture(input);
    } catch (error) {
      return operations.run(async () => {
        throw error;
      });
    }
    return operations.run(() => work(captured));
  };
  return Object.freeze({
    find: (scope, manifest) =>
      invoke({ scope, manifest }, async ({ scope, manifest }) => {
        if (manifest !== undefined) refuse();
        const values = scopeValues(owner, scope);
        if (dialect === 'postgres') {
          const key = createHash('sha256')
            .update(JSON.stringify(['public-placement', ...values]))
            .digest()
            .readBigInt64BE()
            .toString();
          await query('SELECT pg_advisory_xact_lock($1::bigint)', [key]);
        }
        return lookup(query, dialect, owner, scope.idempotencyKey);
      }),
    commit: (receipt, audit, events) =>
      invoke({ receipt, audit, events }, async ({ receipt, audit, events }) => {
        if (events !== undefined) refuse();
        rules.validateReceipt(receipt);
        const values = scopeValues(owner, receipt),
          entries = rules.auditEntries(audit, undefined);
        if (entries.some((entry) => entry.owner !== undefined && entry.owner !== owner.tenant)) refuse();
        const [target, , keysJson, changesJson] = rules.packTargets(
          entries,
          entries.map(() => owner.tenant),
        );
        await query(
          `INSERT INTO ${placementTable(dialect, tables.receipt)} (${placementReceiptColumns.join(', ')}) VALUES (${placementReceiptColumns.map((_, index) => placeholder(dialect, index)).join(', ')})`,
          [
            receipt.id,
            ...values,
            receipt.fingerprint,
            receipt.resultJson,
            receipt.requestId,
            receipt.completedAt,
            admission.epoch,
            target,
            keysJson,
            changesJson,
          ],
        );
      }),
  } satisfies CommandJournal);
}

const sqliteQuery =
  (db: DatabaseSync): Query =>
  async (sql, params) =>
    db.prepare(sql).all(...params) as Record<string, unknown>[];
const postgresQuery =
  (db: PgQuery): Query =>
  async (sql, params) =>
    (await db.query(sql, [...params])).rows;

/** Caller has attested the separate layout on this transaction's writer. */
export function createSqlitePublicPlacementJournal(
  db: DatabaseSync,
  operations: TransactionOperations,
  admission: PublicPlacementAdmission,
): CommandJournal {
  return journal(sqliteQuery(db), 'sqlite', operations, admission);
}
export function createPostgresPublicPlacementJournal(
  db: PgQuery,
  operations: TransactionOperations,
  admission: PublicPlacementAdmission,
): CommandJournal {
  return journal(postgresQuery(db), 'postgres', operations, admission);
}

/** Owner-only, on the adapter's read-only snapshot, with original stable owner.
 * Internal receipt data still needs the existing bounded public projection. */
async function recoverSqlitePublicPlacementReceipt(
  db: DatabaseSync,
  input: PublicPlacementOwner,
  submission: string,
): Promise<StoredCommandReceipt | undefined> {
  const owner = capturePublicPlacementOwner(input);
  namespace(owner, submission);
  assertSqlitePublicPlacementJournal(db);
  return lookup(sqliteQuery(db), 'sqlite', owner, submission);
}

/** An independent read-only handle avoids sharing snapshot state with pooled
 * browsing calls. The pinned adapter verifies file continuity around open. */
export async function readSqlitePublicPlacementReceipt(
  file: string,
  input: PublicPlacementOwner,
  submission: string,
  assertCurrent: () => void,
): Promise<StoredCommandReceipt | undefined> {
  const owner = capturePublicPlacementOwner(input);
  namespace(owner, submission);
  assertCurrent();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    assertCurrent();
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN');
    try {
      const receipt = await recoverSqlitePublicPlacementReceipt(db, owner, submission);
      assertCurrent();
      db.exec('COMMIT');
      return receipt;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Preserve cause. */
      }
      throw error;
    }
  } finally {
    db.close();
  }
}
export async function recoverPostgresPublicPlacementReceipt(
  db: PgQuery,
  input: PublicPlacementOwner,
  submission: string,
): Promise<StoredCommandReceipt | undefined> {
  const owner = capturePublicPlacementOwner(input);
  namespace(owner, submission);
  // ACCESS SHARE is permitted in a read-only transaction and pins the layout.
  await db.query(
    `LOCK TABLE ${placementTable('postgres', tables.meta)}, ${placementTable('postgres', tables.receipt)} IN ACCESS SHARE MODE`,
  );
  await assertPostgresPublicPlacementJournal(db);
  return lookup(postgresQuery(db), 'postgres', owner, submission);
}
