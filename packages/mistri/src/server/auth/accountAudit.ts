/**
 * The account-administration trail: one row for every change an
 * administrator makes from the accounts screen (accountAdministration.ts),
 * kept in the App's own auth store beside the accounts it describes.
 *
 * Declared as a Better Auth plugin schema so the row is written through
 * Better Auth's own adapter, inside the same transaction as the change it
 * records: Better Auth's admin endpoints write through whichever adapter the
 * current transaction put in its context, and so does this. A change whose
 * row cannot be written is rolled back with it.
 *
 * The file store gets the table from Better Auth's own migration and the two
 * triggers that make it append-only from `provisionSqliteAccountAudit`; the
 * PostgreSQL store's table and rules are postgresAuthStore.ts's pinned
 * layout. Both layout checks count them, so neither store accepts a table it
 * does not expect.
 *
 * What a row holds: who (the account and its email), when, the action, the
 * account changed, the fields it changed as they were and became, and the
 * request's principal (a session of the actor's own, or one an administrator
 * is impersonating). Never a password, a hash, a session token or anything
 * that signs one in; a new password is recorded as having been set, nothing
 * more. Nothing prunes it: mistri keeps every row for as long as the
 * store exists (SECURITY.md).
 */
import type { DatabaseSync } from 'node:sqlite';
import { SQLITE_ACCOUNT_AUDIT_TRIGGERS } from '../../adapters/auth/sqliteAuthStoreLayout.js';
import { ACCOUNT_AUDIT_PAGE, type AccountAuditEntry, type AccountAuditPage } from '../../shared/accountAdministration.js';

const ACCOUNT_AUDIT_MODEL = 'accountAudit';

/* Every field required but the two snapshots: a create has no "before". */
const required = (type: 'string' | 'date', index = false) => ({ type, required: true, input: false, ...(index ? { index: true } : {}) });
const snapshot = { type: 'string', required: false, input: false } as const;

const ACCOUNT_AUDIT_SCHEMA = Object.freeze({
  [ACCOUNT_AUDIT_MODEL]: {
    fields: {
      createdAt: required('date', true),
      action: required('string'),
      actorId: required('string'),
      actorEmail: required('string'),
      principal: required('string'),
      targetId: required('string', true),
      targetEmail: required('string'),
      before: snapshot,
      after: snapshot,
    },
  },
});

/** The Better Auth plugin that declares the table. It adds no endpoint and no hook. */
export const accountAuditPlugin = () => ({ id: 'mistri-account-audit', schema: ACCOUNT_AUDIT_SCHEMA });

/** After Better Auth's migration of the file: the triggers, once. */
export function provisionSqliteAccountAudit(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [name, ddl] of SQLITE_ACCOUNT_AUDIT_TRIGGERS) {
      const found = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type = 'trigger' AND name = ? COLLATE BINARY").get(name);
      if (!found) db.exec(ddl);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

type Where = { field: string; value: string }[];
/** The slice of Better Auth's database adapter the trail uses. */
export interface AuditAdapter {
  create(input: { model: string; data: Record<string, unknown> }): Promise<unknown>;
  findMany(input: {
    model: string;
    where?: Where;
    limit: number;
    offset: number;
    sortBy: { field: string; direction: 'desc' };
  }): Promise<unknown[]>;
  count(input: { model: string; where?: Where }): Promise<number>;
  update(input: { model: string; where: Where; update: Record<string, unknown> }): Promise<unknown>;
}
/** Better Auth's transaction context (`@better-auth/core/context`): the adapter the current transaction holds. */
export interface AuditTransactions {
  runWithTransaction<T>(adapter: unknown, work: () => Promise<T>): Promise<T>;
  getCurrentAdapter(fallback: unknown): Promise<unknown>;
}

/** A row to write: everything but its id and time, which the store gives it. */
export type AccountAuditWrite = Omit<AccountAuditEntry, 'id' | 'at'>;

export interface AccountAuditStore {
  /** One transaction for a change and its row: Better Auth's writes inside `work` join it. */
  transaction<T>(work: () => Promise<T>): Promise<T>;
  /** Inside `transaction` only, so the row commits or rolls back with the change. */
  write(row: AccountAuditWrite): Promise<void>;
  /** Inside `transaction` only: take the accounts' rows (touching them), so a concurrent change to the same accounts waits for this one's commit. Pass the ids in one fixed order. */
  lock(accountIds: readonly string[]): Promise<void>;
  /** Newest first; one account's rows when `accountId` is given. */
  read(options: { offset: number; accountId?: string }): Promise<AccountAuditPage>;
}

const snapshotText = (value: Record<string, unknown> | null) => (value === null ? null : JSON.stringify(value));
function snapshotOf(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const OPERATIONS: readonly string[] = ['create', 'setRoles', 'deactivate', 'reactivate', 'setPassword'];
function entryOf(value: unknown): AccountAuditEntry {
  const row = (value ?? {}) as Record<string, unknown>;
  const at = row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt ?? '');
  const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  const action = text('action');
  if (!text('id') || !OPERATIONS.includes(action)) throw new Error('Invalid account audit row');
  return {
    id: text('id'),
    at,
    action: action as AccountAuditEntry['action'],
    actorId: text('actorId'),
    actorEmail: text('actorEmail'),
    principal: text('principal'),
    targetId: text('targetId'),
    targetEmail: text('targetEmail'),
    before: snapshotOf(row.before),
    after: snapshotOf(row.after),
  };
}

export function createAccountAuditStore(base: AuditAdapter, context: AuditTransactions): AccountAuditStore {
  return Object.freeze({
    transaction: <T>(work: () => Promise<T>) => context.runWithTransaction(base, work),
    async write(row: AccountAuditWrite) {
      const adapter = (await context.getCurrentAdapter(base)) as AuditAdapter;
      // The context adapter is the transaction's only inside one: a write outside it would commit alone.
      if (adapter === base) throw new Error("An account audit row is written inside its change's transaction.");
      await adapter.create({
        model: ACCOUNT_AUDIT_MODEL,
        data: {
          createdAt: new Date(),
          action: row.action,
          actorId: row.actorId,
          actorEmail: row.actorEmail,
          principal: row.principal,
          targetId: row.targetId,
          targetEmail: row.targetEmail,
          before: snapshotText(row.before),
          after: snapshotText(row.after),
        },
      });
    },
    async lock(accountIds: readonly string[]) {
      const adapter = (await context.getCurrentAdapter(base)) as AuditAdapter;
      if (adapter === base) throw new Error("Accounts are locked inside their change's transaction.");
      for (const id of accountIds)
        await adapter.update({ model: 'user', where: [{ field: 'id', value: id }], update: { updatedAt: new Date() } });
    },
    async read({ offset, accountId }: { offset: number; accountId?: string }) {
      const where = accountId ? [{ field: 'targetId', value: accountId }] : undefined;
      const [rows, total] = await Promise.all([
        base.findMany({
          model: ACCOUNT_AUDIT_MODEL,
          ...(where ? { where } : {}),
          limit: ACCOUNT_AUDIT_PAGE,
          offset,
          sortBy: { field: 'createdAt', direction: 'desc' },
        }),
        base.count({ model: ACCOUNT_AUDIT_MODEL, ...(where ? { where } : {}) }),
      ]);
      return { entries: rows.map(entryOf), total, offset };
    },
  });
}
