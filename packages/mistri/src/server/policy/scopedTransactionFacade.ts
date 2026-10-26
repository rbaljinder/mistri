import { AppValidationDenied } from '../app/appValidationDenied.js';
import {
  Refusal,
  TransactionOperations,
  type DeleteRequest,
  type TellRequest,
  type Filter,
  type InsertRequest,
  type QueryRequest,
  type UpdateRequest,
  type WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';

/** Run INSIDE an already scoped physical transaction. Facade checks can fail
 * before calling the physical handle, so its queue alone cannot observe them.
 * Drain and poison this layer before allowing the physical callback to finish. */
export async function runScopedTransactionFacade<T>(records: WriteTransaction, run: (tx: WriteTransaction) => Promise<T>): Promise<T> {
  const operations = new TransactionOperations();
  let failed = false;
  const invoke = <A, R>(input: A, work: (input: A) => Promise<R>): Promise<R> => {
    let captured: A;
    let invalid: { error: unknown } | undefined;
    try {
      captured = snapshotScopedData(input);
    } catch (error) {
      invalid = { error };
    }
    return operations.run(async () => {
      if (failed) throw new Refusal('This scoped transaction has failed.');
      try {
        if (invalid) throw invalid.error;
        return await work(captured!);
      } catch (error) {
        failed = true;
        throw error;
      }
    });
  };
  /* A refusal the callback restated — a record's line named by its place (recordWriteOperations.ts writeLines) —
     is the same refusal, said where the person can find it, so it stands over the one the operations kept. Any
     other failure of finish() stands over the callback's. */
  const finish = async (thrown?: unknown) => {
    try {
      await operations.finish();
    } catch (error) {
      if (!(error instanceof AppValidationDenied && thrown instanceof AppValidationDenied)) throw error;
    }
  };
  let result: T;
  try {
    result = await run(
      Object.freeze({
        ...(records.lockRecord ? { lockRecord: (r: DeleteRequest) => invoke(r, (request) => records.lockRecord!(request)) } : {}),
        query: (r: QueryRequest) => invoke(r, (request) => records.query(request)),
        count: (table: string, filter?: Filter) => invoke({ table, filter }, (request) => records.count(request.table, request.filter)),
        insert: (r: InsertRequest) => invoke(r, (request) => records.insert(request)),
        update: (r: UpdateRequest) => invoke(r, (request) => records.update(request)),
        remove: (r: DeleteRequest) => invoke(r, (request) => records.remove(request)),
        ...(records.tell ? { tell: (r: TellRequest) => invoke(r, (request) => records.tell!(request)) } : {}),
      }),
    );
  } catch (error) {
    failed = true;
    await finish(error);
    throw error;
  }
  await finish();
  return result;
}
