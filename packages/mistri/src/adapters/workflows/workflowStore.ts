// The SQLite workflow store: instances, steps and waits behind the WorkflowStore contract, every change in one transaction.
import type { SQLInputValue } from 'node:sqlite';
import type { WorkflowStore } from './workflowStoreContract.js';
import { assertSqliteWorkflowStore, openWorkflowStoreFile } from './workflowStoreSchema.js';
import { createWorkflowStore, type Db, type Row } from './workflowStoreCore.js';
import { WorkflowRefusal, WorkflowStoreUnavailable, workflowFail } from './workflowStoreTypes.js';

/** One private connection over one existing, provisioned database file. Each
 * method is one synchronous transaction behind the contract's promise: SQLite
 * has one writer, so the epoch fence and the signal re-check are serialized
 * by it, and no handler, step or network call ever runs inside one. */
export function openSqliteWorkflowStore(existingPath: string): WorkflowStore {
  const db = openWorkflowStoreFile(existingPath);
  let closed = false;
  const driver: Db = {
    all: async (sql, ...params) => db.prepare(sql).all(...(params as SQLInputValue[])) as Row[],
    run: async (sql, ...params) => Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes),
  };
  const transaction = async <T>(write: boolean, work: (db: Db) => Promise<T>): Promise<T> => {
    try {
      if (closed || db.isTransaction) return workflowFail();
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      assertSqliteWorkflowStore(db);
      const result = await work(driver);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        if (db.isTransaction) db.exec('ROLLBACK');
      } catch {
        closed = true;
        try {
          db.close();
        } catch {
          /* Discard an uncertain connection. */
        }
        return workflowFail();
      }
      if (error instanceof WorkflowRefusal || error instanceof WorkflowStoreUnavailable) throw error;
      return workflowFail();
    }
  };
  // Opening attests; a store that cannot be verified is not returned.
  try {
    db.exec('BEGIN');
    assertSqliteWorkflowStore(db);
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.close();
    } catch {
      /* Already gone. */
    }
    throw error;
  }
  return createWorkflowStore(transaction, '', async () => {
    if (!closed) {
      closed = true;
      db.close();
    }
  });
}
