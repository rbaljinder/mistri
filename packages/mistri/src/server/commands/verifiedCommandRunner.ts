/** Native ordinary command selection only; not actor or API authorization.
 * Mapping wrappers issue their runners privately, without a registration API. */
import { isProxy } from 'node:util/types';
import type { Adapter, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { isSqliteVerifiedCommandSource } from '@mistriwork/engine/adapters/sqlite.js';
import { isPostgresVerifiedCommandSource } from '@mistriwork/engine/adapters/postgres.js';
import { nativeCommandsOf } from '../stores/commandStores.js';
import type { CommandJournal, CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';

export type VerifiedCommandRunner = <T>(
  verify: () => unknown,
  run: (records: WriteTransaction, journal: CommandJournal) => Promise<T>,
  events?: CommandJournalAppScope,
) => Promise<T>;

/* The runner is the constructed adapter's own, over the host it lent at
   construction (storeHost.ts): a forged, copied or proxied receiver lends
   none, and nothing on the receiver — its prototype, its methods, its
   fields — is read to reach the writer. */
export function nativeVerifiedCommandRunner(adapter: Adapter): VerifiedCommandRunner | undefined {
  if (!isSqliteVerifiedCommandSource(adapter) && !isPostgresVerifiedCommandSource(adapter)) return undefined;
  // Kept from the method-lookup runner: a receiver dressed in a proxied
  // prototype is refused at selection, though the host no longer reads it.
  if (isProxy(Object.getPrototypeOf(adapter))) return undefined;
  const commands = nativeCommandsOf(adapter);
  if (!commands) return undefined;
  // Native journals retain constructor provenance, writer lifetime, queue,
  // journal checks and synchronous/async verifier rules for their engine.
  return <T>(
    verify: () => unknown,
    run: (records: WriteTransaction, journal: CommandJournal) => Promise<T>,
    events?: CommandJournalAppScope,
  ): Promise<T> => commands.verifiedCommandTransaction(verify, run, events);
}
