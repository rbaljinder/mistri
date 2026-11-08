/**
 * How a Postgres scoped transaction opens: the verifier a trusted host hands it, the pin that rides in its BEGIN, the
 * isolation a snapshot read begins with, and the session text its BEGIN sets. Pure parts of the adapter's opening, kept
 * apart from the connection and the writes that use them (postgres.ts).
 */
import type { DatabaseSchema } from '../shared/schema.js';
import type { PgQuery } from './postgresPool.js';
import type { PostgresScopeCatalog } from './scoped/postgresScopeCatalog.js';
import type { PipelinedStatement } from './postgresTransactionHandle.js';

/** Trusted host verification on the writer of a verified scoped transaction:
 * the scope catalog it was pinned and read with, and the adapter's own
 * introspection on the same writer. */
export type PostgresTransactionVerifier = {
  (client: PgQuery, catalog: PostgresScopeCatalog, describe: () => Promise<DatabaseSchema>, epoch?: string): Promise<void>;
  /**
   * The verifier's own LOCK, without parameters, taken in the message that
   * begins the transaction, after the scope's pin and before the schema epoch
   * (or catalog digest) is read. The epoch then covers everything it pinned:
   * DDL committed before it is in the epoch, DDL after it waits for this
   * transaction. The verifier is handed that epoch as `epoch`, so a full
   * attestation it made under the same epoch stands without being read again
   * (tenantWriteSource.ts). A message that fails begins again plainly, and
   * the verifier is handed no epoch.
   */
  readonly pin?: string;
  /**
   * The statements the verifier's first pass sends, exactly, sent behind the
   * BEGIN with what else the transaction opens with (sendWriteAhead): each
   * answers the identical statement once when the verifier sends it. A
   * statement it does not send is left unread.
   */
  readonly ahead?: () => readonly PipelinedStatement[];
};

/** A verifier's pin, when it is only LOCK statements with no parameters (it rides in the simple-protocol message).
    Anything else is not taken: the transaction then runs as it would without one, and its verifier attests in full. */
export function verifierPin(verify: PostgresTransactionVerifier | undefined): string | undefined {
  const pin = verify?.pin;
  return typeof pin === 'string' && /^LOCK TABLE [^;$]+ IN [A-Z ]+ MODE(; LOCK TABLE [^;$]+ IN [A-Z ]+ MODE)*$/.test(pin) ? pin : undefined;
}

/* Handles whose transaction reads one snapshot (snapshotRead.ts): REPEATABLE READ from its BEGIN, so every statement
   reads as of its first. Kept on the handle, as its epoch is, so a retry of the opening begins the same way. */
export const snapshotHandles = new WeakSet<PgQuery>();
export const beginOf = (write: PgQuery) => (snapshotHandles.has(write) ? 'BEGIN ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');

/* What a scoped transaction's BEGIN also says, in its one message: the text a date is read as, whatever the role or
   database set. A check binds a key's stored text and the database reads it back (storedText.ts, keyTypes.ts); under
   `DateStyle = 'SQL, YMD'` a date said as 01/02/2026 reads back as another day. Only the output style is set: the
   field order, which decides how a person's own 01/02/2026 is read, stays the database's. The float and interval
   text, which no key is (keyTypes.ts), is pinned as well, so a value a trigger's proof compares reads as stored. */
export const SCOPED_SESSION = '; SET LOCAL DateStyle = ISO; SET LOCAL IntervalStyle = postgres; SET LOCAL extra_float_digits = 3';
