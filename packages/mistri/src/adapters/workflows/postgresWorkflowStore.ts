/**
 * The workflow store on PostgreSQL: the rules of workflowStoreCore.ts over a
 * leased writer client. Rows that an instance's run and a signal's arrival
 * both touch are locked `FOR UPDATE`, so the lost wake-up the SQLite single
 * writer rules out is ruled out here by the lock. Every transaction attests the
 * layout and returns its client before the call resolves; never across a step.
 * The store is one App's: `namespace` is its job namespace, and nothing of
 * another namespace on the same database is read, changed or woken.
 */
import type { PgQuery, PgWriteClientSource } from '@mistriwork/engine/adapters/postgresPool.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import type { WorkflowStore } from './workflowStoreContract.js';
import { assertPostgresWorkflowStore, captureWorkflowNamespace } from './workflowStoreSchema.js';
import { createWorkflowStore, type Db, type Row, type Transaction } from './workflowStoreCore.js';
import { WorkflowRefusal, WorkflowStoreUnavailable, workflowFail } from './workflowStoreTypes.js';

/** `?` placeholders, numbered. The statements carry no `?` in a literal. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

export async function openPostgresWorkflowStore(connection: PgWriteClientSource, namespace: string): Promise<WorkflowStore> {
  if (!connection || typeof connection.withWriteClient !== 'function') return workflowFail();
  const ns = captureWorkflowNamespace(namespace);
  let closed = false;
  const transaction: Transaction = async (_write, work) => {
    if (closed) return workflowFail();
    let refusal: WorkflowRefusal | undefined;
    try {
      const result = await connection.withWriteClient(async (client: PgQuery) => {
        const driver: Db = {
          all: async (sql, ...params) => (await client.query(numbered(sql), params)).rows as Row[],
          run: async (sql, ...params) => (await client.query(numbered(sql), params)).rowCount ?? 0,
        };
        await client.query('BEGIN');
        try {
          await assertPostgresWorkflowStore(client, ns);
          const value = await work(driver);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          try {
            await client.query('ROLLBACK');
          } catch {
            throw new WorkflowStoreUnavailable();
          }
          if (error instanceof WorkflowRefusal) {
            refusal = error;
            return undefined as never;
          }
          throw error;
        }
      });
      if (refusal) throw refusal;
      return result;
    } catch (error) {
      if (error instanceof WorkflowRefusal || error instanceof WorkflowStoreUnavailable) throw error;
      return workflowFail();
    }
  };
  await transaction(false, async () => {});
  return createWorkflowStore(
    transaction,
    ' FOR UPDATE',
    async () => {
      closed = true;
    },
    ns,
    (name) => runtimeTable('postgres', name),
  );
}
