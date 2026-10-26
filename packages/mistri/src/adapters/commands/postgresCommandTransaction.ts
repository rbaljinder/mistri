/** Ordinary same-source command ownership. This is not a bearer capability:
 * the adapter supplies its real writer and record methods
 * (PostgresAdapter.journalTransaction); only trusted host code installs
 * verification, captured here. Journal namespaces and event ownership do not
 * derive from the verifier. */
import { isProxy } from 'node:util/types';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure } from './commandJournal.js';

export function capturePostgresCommandVerifier(verify: () => unknown): () => Promise<void> {
  if (typeof verify !== 'function' || isProxy(verify)) {
    throw new CommandTransactionFailure(new Refusal('The command owner is unavailable.'), 'not_applied');
  }
  return async () => {
    if ((await verify()) !== undefined) throw new Refusal('The command owner is unavailable.');
  };
}
