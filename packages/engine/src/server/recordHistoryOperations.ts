import { TransactionOutcomeUnknown } from '../adapters/adapter.js';
import { snapshotScopedData } from '../adapters/scoped/scopedReads.js';
import type { JournalEntry } from './journal.js';

export type HistoryDraft = Omit<JournalEntry, 'id' | 'at' | 'connection'>;
export type UnknownHistoryDraft = HistoryDraft & { revertible: false; undoState: 'unknown' };
export interface PreparedWrite<R> {
  result: R;
  entry: HistoryDraft;
}
interface OwnedHistory {
  publish(entry: HistoryDraft): JournalEntry;
  /** Captured, synchronous, non-throwing quarantine. No clock or publication. */
  quarantine(): void;
}
type Transaction<Tx, R> = (work: (tx: Tx) => Promise<R>) => Promise<R>;
interface Preview<Tx, R> {
  mode: 'preview';
  transaction: Transaction<Tx, R>;
  work(tx: Tx): Promise<R>;
}
interface Write<Tx, R> {
  mode: 'write';
  transaction: Transaction<Tx, PreparedWrite<R>>;
  work(tx: Tx): Promise<PreparedWrite<R>>;
  history: OwnedHistory;
  uncertainty: UnknownHistoryDraft;
  /** Trusted operation-specific rejection classification, never request data.
   * It cannot classify unknown transaction acknowledgement as rejection. */
  isRejection(error: unknown): boolean;
}

export function runRecordedTransaction<Tx, R>(options: Preview<Tx, R>): Promise<{ result: R }>;
export function runRecordedTransaction<Tx, R>(options: Write<Tx, R>): Promise<{ result: R; undoId?: number }>;
/** Owns completion/publication only. The supplied transaction and work retain
 * their original authorization, record fences and image-capture contracts.
 * No registry, fallback writer or way to upgrade a scoped capability exists. */
export async function runRecordedTransaction<Tx, R>(options: Preview<Tx, R> | Write<Tx, R>) {
  if (options.mode === 'preview') {
    const transaction = options.transaction.bind(options),
      work = options.work.bind(options);
    return { result: await transaction(work) };
  }
  const transaction = options.transaction.bind(options),
    work = options.work.bind(options);
  const history = options.history;
  const publish = history.publish.bind(history),
    quarantine = history.quarantine.bind(history);
  const isRejection = options.isRejection.bind(options);
  // Validate without accessors/prototypes, then retain the journal's ordinary
  // data-object shape while detaching every nested value.
  const uncertainty = structuredClone(snapshotScopedData(options.uncertainty));
  let committed = false;
  try {
    const stored = await transaction(async (tx) => {
      const prepared = await work(tx);
      // Malformed evidence must fail inside the transaction, not after COMMIT.
      // Detach before the writer's completion wait so retained callback objects
      // cannot rewrite the history that will be published after commit.
      return { result: prepared.result, entry: structuredClone(snapshotScopedData(prepared.entry)) };
    });
    committed = true;
    const entry = publish(stored.entry);
    return { result: stored.result, ...(entry.revertible ? { undoId: entry.id } : {}) };
  } catch (error) {
    if (committed || error instanceof TransactionOutcomeUnknown || !isRejection(error)) {
      try {
        publish(uncertainty);
      } catch {
        quarantine();
      }
      throw error instanceof TransactionOutcomeUnknown ? error : new TransactionOutcomeUnknown(error);
    }
    throw error;
  }
}
