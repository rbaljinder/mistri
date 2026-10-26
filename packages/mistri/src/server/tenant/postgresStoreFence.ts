/**
 * A reserved PostgreSQL store, attested in full when an adapter first uses it.
 *
 * The tenant store (tenantStorePostgres.ts), the administration journal
 * (tenantAdministrationJournalPostgres.ts), the support audit
 * (tenantSupportAuditPostgres.ts) and the invitation store are attested
 * inside the transaction that first uses them: described against the pinned
 * layout, their meta row compared with the binding, and their tables required
 * to be this role's alone. On a transaction handle made by an adapter, that
 * is kept for the adapter (attestOnce, postgresTransactionHandle.ts), so a
 * process attests a store when it opens it, and again only after a statement
 * fails the way a moved catalog fails one. Off a handle (maintenance, a test's
 * own client) every use attests in full.
 *
 * What this gave up: a writer transaction used to take LOCK TABLE pins on the
 * store and read its catalog again at every fence, before COMMIT included, so
 * a trigger, an index or a GRANT made on another connection mid-transaction
 * refused that very COMMIT. Now such a change is seen at the next start, or
 * at the first statement it breaks. The database role is the boundary
 * (reservedSql.ts): a role that may alter runtime tables could already
 * change what any check reads. The membership fence is row locks, data
 * concurrency rather than attestation, and is unchanged.
 */
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { attestOnce as attestOnAdapter } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';

/**
 * Attest the store under `prefix` for `bound` inside the caller's transaction:
 * in full (`full`, which refuses) unless the adapter this transaction runs on
 * attested it for the same binding already.
 */
export function attestOnce(client: PgQuery, prefix: string, bound: string, full: () => Promise<void>): Promise<void> {
  return attestOnAdapter(client, `${prefix}\u0000${bound}`, full);
}
