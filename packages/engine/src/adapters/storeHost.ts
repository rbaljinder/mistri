/**
 * The seam an App store stands on: what a dialect adapter lends the stores
 * that live in its database — the notification inbox, branding, the record
 * history, the command journal and a public placement's — without knowing
 * any of them.
 *
 * The stores are the App framework's (packages/mistri/src/server/stores/appStores.ts and
 * the store folders under src/adapters); the adapter is the engine's, and the
 * database browser opens the same adapter with no App framework installed.
 * So the adapter offers its clients, its write queue and the schema-epoch
 * cache it already keeps, and a store names its own meta row when it asks
 * for an attested read. The adapter learns no store's tables from here.
 *
 * A host is kept beside its adapter rather than on it: a facade or a proxy
 * that forwards an adapter's methods does not forward its host, so only the
 * adapter that was constructed can lend its writer.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { TransactionOperations, WriteTransaction } from './adapter.js';
import type { PostgresReadSnapshot, PostgresTransactionVerifier } from './postgres.js';
import type { PgQuery } from './postgresPool.js';
import type { PostgresScopeCatalog } from './scoped/postgresScopeCatalog.js';
import type { SqliteScopeCatalog } from './scoped/sqliteScopeCatalog.js';
import type { DatabaseSchema } from '../shared/schema.js';
import type { RowScope } from '../shared/rowScope.js';

/** A reserved store's meta row: the one row whose version says the layout, and the cache key its attestation is kept under. */
export interface StoreMeta {
  readonly name: string;
  readonly table: string;
  readonly version: number;
}

/**
 * A journal kept in a write transaction beside its records: the command
 * journal, or a public placement's. The adapter runs the transaction — its
 * BEGIN, the schema epoch, the scope, the drain, the COMMIT and the outcome —
 * and the journal is the App framework's: its tables, the SQL that attests
 * them and the object a command writes its receipt through.
 */
interface TransactionJournal<W, C, J> {
  /** The meta row read with the schema epoch, so the layout is attested once per epoch; without one, it is attested in every transaction. */
  readonly meta?: StoreMeta;
  /** The layout attested on the writer, after BEGIN and before the scope catalog is read: an unmigrated or altered layout refuses without a write. */
  attest(writer: W): void | Promise<void>;
  /** A scoped transaction's admission, after the scope catalog is read and verified, before the callback. */
  admit?(writer: W, catalog: C, scope: RowScope): void | Promise<void>;
  /** A journal that writes exactly fixed rows (a public intake's): its scoped records pass through this, and no new parent is counted into the principal's scope. */
  fixedRecords?(records: WriteTransaction): WriteTransaction;
  /** The journal over the writer and the operation queue its records share; `verified` is a verified scoped transaction's fence. */
  open(writer: W, operations: TransactionOperations, verified?: () => void): J;
  /** What a failed transaction throws, told whether it might have committed. */
  failure(error: unknown, outcome: 'unknown' | 'not_applied'): unknown;
  /**
   * The statements the journal's first lookup of `receipt` sends, exactly, so
   * they leave behind the transaction's BEGIN (writeAhead.ts): none for a
   * receipt it would refuse. Its shape is the journal's own.
   */
  ahead?(receipt: unknown): readonly (string | Readonly<{ text: string; values?: readonly unknown[] }>)[];
}

export type PostgresTransactionJournal<J> = TransactionJournal<PgQuery, PostgresScopeCatalog, J>;
export type SqliteTransactionJournal<J> = TransactionJournal<DatabaseSync, SqliteScopeCatalog, J>;

/** How a journal transaction is shaped: ordinary, or over a row scope. */
export interface JournalTransactionOptions<V> {
  /** A row-scoped transaction: the scope's records, with the catalog evidence handed to the callback. */
  readonly scope?: RowScope;
  /** The outer bound the scope sits inside (scopedTransaction.ts ScopeBound), over the same tables. */
  readonly bound?: RowScope;
  /** A verified scoped transaction's trusted host check; its failures are not the journal's. */
  readonly verify?: V;
  /** A verified ordinary transaction's trusted host check, after BEGIN and again before COMMIT. */
  readonly ordinaryVerify?: () => unknown;
}

/** The callback: the records, the journal, and a scoped transaction's catalog evidence (absent in an ordinary one). */
export type JournalRun<J, T> = (records: WriteTransaction, journal: J, catalog?: DatabaseSchema) => Promise<T>;

export interface PostgresStoreHost {
  readonly dialect: 'postgres';
  withReadClient<T>(work: (client: PgQuery) => Promise<T>): Promise<T>;
  withWriteClient<T>(work: (client: PgQuery) => Promise<T>): Promise<T>;
  /** `read`, told whether the store's layout stands attested under the schema epoch read first on `client`. */
  attestedStore<T>(client: PgQuery, store: StoreMeta, read: (attested: boolean) => Promise<T>): Promise<T>;
  /** Whether this is the constructed adapter over the connections it was built with: the only one a verified transaction runs on. */
  verifiedSource(): boolean;
  /** Records and a journal in one transaction (PostgresAdapter.journalTransaction). */
  journalTransaction<J, T>(
    journal: PostgresTransactionJournal<J>,
    run: JournalRun<J, T>,
    options?: JournalTransactionOptions<PostgresTransactionVerifier>,
  ): Promise<T>;
  /** `work` on each healthy replica, failures left out; none where the connection names no replicas. */
  onHealthyReplicas<T>(work: (client: PgQuery) => Promise<T>): Promise<T[]>;
  /** One read-only snapshot on an observed reader (PostgresAdapter.readSnapshot). */
  readSnapshot<T>(run: (snapshot: PostgresReadSnapshot) => Promise<T>): Promise<T>;
}

export interface SqliteStoreHost {
  readonly dialect: 'sqlite';
  /** The read-only handle. */
  reader(): DatabaseSync;
  /** `work` in the write queue, on the writer. */
  queueWrite<T>(work: (write: DatabaseSync) => T | Promise<T>): Promise<T>;
  /** As PostgresStoreHost's, synchronous, on `db` (the reader unless a writer is named). */
  attestedStore<T>(store: StoreMeta, read: (attested: boolean) => T, db?: DatabaseSync): T;
  /** The file, for a reader of its own (a receipt's recovery). */
  file(): string;
  closed(): boolean;
  /** Refuses once the path names another file than the one opened. */
  assertWriteIdentity(): void;
  /** Records and a journal in one transaction (SqliteAdapter.transact). */
  journalTransaction<J, T>(
    journal: SqliteTransactionJournal<J>,
    run: JournalRun<J, T>,
    options?: JournalTransactionOptions<(db: DatabaseSync, catalog: SqliteScopeCatalog) => void>,
  ): Promise<T>;
}

export type StoreHost = PostgresStoreHost | SqliteStoreHost;

const hosts = new WeakMap<object, StoreHost>();

/** The adapter's constructor only: the host it lends its stores. */
export function lendStoreHost(adapter: object, host: StoreHost): void {
  hosts.set(adapter, Object.freeze(host));
}

/** The host a constructed adapter lent, or undefined for anything else (a facade, a proxy, an HTTP source). */
export const storeHostOf = (adapter: unknown): StoreHost | undefined =>
  typeof adapter === 'object' && adapter !== null ? hosts.get(adapter) : undefined;

/**
 * An engine wrapper that narrows what an adapter's writes may touch (hidden
 * columns) lends the view here, so a store that runs work in its own
 * transactions — the command journal — hands that work the narrowed records
 * and catalog and never the adapter's own. The wrapper cannot carry the
 * store's members itself: the engine does not name the stores.
 */
interface WriteView {
  readonly over: object;
  records(records: WriteTransaction): WriteTransaction;
  catalog(catalog: DatabaseSchema): DatabaseSchema;
}

const views = new WeakMap<object, WriteView>();

/** The wrapper's constructor only. */
export function lendWriteView(wrapped: object, view: WriteView): void {
  views.set(wrapped, Object.freeze(view));
}

export const writeViewOf = (wrapped: unknown): WriteView | undefined =>
  typeof wrapped === 'object' && wrapped !== null ? views.get(wrapped) : undefined;
