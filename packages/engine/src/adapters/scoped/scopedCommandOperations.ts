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
  return <A, R>(input: A, work: (input: A) => Promise<R>): Promise<R> => {
    let captured = input;
    let invalid: { error: unknown } | undefined;
    if (scoped) {
      try {
        captured = snapshotScopedData(input);
      } catch (error) {
        invalid = { error };
      }
    }
    return operations.run(async () => {
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
    });
  };
}
