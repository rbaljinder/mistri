/** Adapter-owned command queue capture and failure accounting within a scoped transaction. */
import { Refusal, type TransactionOperations } from '../adapter.js';
import { snapshotScopedData } from './scopedReads.js';

/** Shared adapter queue boundary: capture before waiting; caught malformed or
 * failed operations still poison the transaction. No writer escapes here. */
export function scopedCommandInvoker(
  operations: TransactionOperations,
  scoped: boolean,
  command: boolean,
  runtime: (table: string) => boolean,
  verify: () => void = () => {},
) {
  let failed = false;
  /* `read`: the work only reads, so on a transaction that sends together it may start beside reads in flight
     (TransactionOperations.read); a failure still poisons every operation after it, in the order asked. */
  return <A, R>(input: A, work: (input: A) => Promise<R>, read = false): Promise<R> => {
    let captured = input;
    let invalid: { error: unknown } | undefined;
    if (scoped) {
      try {
        captured = snapshotScopedData(input);
      } catch (error) {
        invalid = { error };
      }
    }
    const job = async (): Promise<R> => {
      if (scoped && failed) throw new Refusal('This scoped transaction has failed.');
      try {
        if (invalid) throw invalid.error;
        verify();
        if (
          command &&
          scoped &&
          captured &&
          typeof captured === 'object' &&
          'table' in captured &&
          typeof captured.table === 'string' &&
          runtime(captured.table)
        ) {
          throw new Refusal('Reserved resources are runtime-only.');
        }
        const result = await work(captured);
        verify();
        return result;
      } catch (error) {
        failed = true;
        throw error;
      }
    };
    return read ? operations.read(job) : operations.run(job);
  };
}
