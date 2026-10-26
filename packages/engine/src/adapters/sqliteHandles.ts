/** SQLite handle guards, per-file write coordination, and schema epoch probes. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { Refusal, Serial } from './adapter.js';
import { isRuntimeTable } from '../shared/runtimeTables.js';
import { reservedRefusal } from './reservedSql.js';

/**
 * Wait rather than fail when someone else holds the file.
 *
 * A SQLite database is usually a file another process is also using — the
 * application whose data this is, a migration, a test — and one writer at a
 * time is the whole locking model. Without a busy timeout the very next read
 * during someone else's write comes back "database is locked", which reads
 * as a broken tool rather than as a lock that would have cleared in
 * milliseconds. Five seconds is long enough to outlast an ordinary write and
 * short enough that a genuinely stuck writer still surfaces.
 */
export function waitForLocks(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA busy_timeout = 5000');
  } catch {
    /* An old build without the pragma is not a reason to refuse the
       database; it is a reason to be no worse than before. */
  }
}

// Native busy_timeout cannot yield to another owner in this JS isolate. While
// its transaction awaits verification, a second synchronous BEGIN would block
// the first owner's continuation until timeout. Serialize by actual file, not
// connection alias. SQLite still owns cross-process locking and atomicity.
const fileWrites = new Map<string | symbol, { queue: Serial; pending: number }>();
interface FileWriteContext {
  identity: string | symbol;
  active: boolean;
  parent?: FileWriteContext;
}
const fileWriteContext = new AsyncLocalStorage<FileWriteContext>();
export function assertIndependentWrite(): void {
  for (let context = fileWriteContext.getStore(); context; context = context.parent) {
    if (context.active) {
      // Independent A->B and B->A transactions can deadlock even when neither
      // repeats its own ancestry. Cross-source nesting is not a transaction
      // capability: callbacks must use their supplied writer, not an adapter.
      throw new Refusal('Use the active transaction writer; nested SQLite adapter writes are unavailable.');
    }
  }
}
export function writeToFile<T>(identity: string | symbol, work: () => Promise<T>): Promise<T> {
  let entry = fileWrites.get(identity);
  if (!entry) {
    entry = { queue: new Serial(), pending: 0 };
    fileWrites.set(identity, entry);
  }
  const owned = entry;
  owned.pending++;
  return owned.queue
    .run(async () => {
      const context = { identity, active: true, parent: fileWriteContext.getStore() };
      try {
        return await fileWriteContext.run(context, work);
      } finally {
        context.active = false;
      }
    })
    .finally(() => {
      if (--owned.pending === 0) fileWrites.delete(identity);
    });
}

/* SQLite's authorizer action codes, from its C API: @types/node does not
   declare node:sqlite's `constants` or `setAuthorizer` yet. */
const SQLITE_OK = 0;
const SQLITE_READ = 20;
type Authorizer = ((action: number, table: string | null) => number) | null;

/**
 * Prepare with SQLite's authorizer listening: preparing names every table the
 * statement reads — views expanded, CTEs and subqueries included — which is
 * the engine's half of the reserved-relation guard (reservedSql.ts). A build
 * without the authorizer keeps the lexical half alone.
 */
export function prepareGuarded(db: DatabaseSync, sql: string): StatementSync {
  const listen = (db as DatabaseSync & { setAuthorizer?: (callback: Authorizer) => void }).setAuthorizer?.bind(db);
  if (!listen) return db.prepare(sql);
  let reserved: string | undefined;
  listen((action, table) => {
    if (action === SQLITE_READ && typeof table === 'string' && isRuntimeTable(table)) reserved ??= table;
    return SQLITE_OK;
  });
  let statement: StatementSync;
  try {
    statement = db.prepare(sql);
  } finally {
    listen(null);
  }
  if (reserved !== undefined) throw reservedRefusal(reserved);
  return statement;
}

/*
 * The schema a connection sees, as one statement's columns: the main file's
 * `schema_version`, which SQLite bumps on every schema change from any
 * connection, and the connection's own TEMP schema, word for word. The TEMP
 * schema has no version a query can read — `temp.pragma_schema_version`
 * answers main's — so its definitions are the version: a TEMP table, view,
 * trigger or index that shadows or hooks a reserved store changes them. It
 * is empty on nearly every connection, so reading it costs nothing.
 */
const SCHEMA_EPOCH = `(SELECT schema_version FROM main.pragma_schema_version) AS main,
        (SELECT coalesce(group_concat(type || ':' || name || ':' || tbl_name || ':' || coalesce(sql, ''), char(10)), '') FROM temp.sqlite_schema) AS temp`;

/**
 * The epoch a SQLite write transaction trusts, in one statement: the schema
 * (SCHEMA_EPOCH) and the handle's foreign-key switch, which the scope catalog
 * requires. `journal` also asks whether a journal's meta row says its
 * version (a data fact: deleting the row changes no schema); the store that
 * rides in the transaction names its row, so the engine knows no store's
 * tables. A statement that cannot run — no journal table — is a miss, and the
 * full attestation then says why.
 */
export function transactionEpoch(db: DatabaseSync, journal?: { table: string; version: number }): { epoch?: string; journal: boolean } {
  try {
    const row = db
      .prepare(
        `SELECT ${SCHEMA_EPOCH}, (SELECT foreign_keys FROM pragma_foreign_keys) AS fk${
          journal
            ? `, (SELECT count(*) FROM main."${journal.table}" WHERE singleton = 1 AND version = ${Number(journal.version)}) AS journal`
            : ''
        }`,
      )
      .get();
    if (!row || typeof row.main !== 'number' || typeof row.temp !== 'string') return { journal: false };
    return { epoch: `${row.main}.${row.fk}\n${row.temp}`, journal: row.journal === 1 };
  } catch {
    return { journal: false };
  }
}

/** The schema and whether a store's meta row says its version, in one statement; undefined when the store is not there. */
export function storeEpoch(db: DatabaseSync, meta: { table: string; version: number }): string | undefined {
  try {
    const row = db
      .prepare(`SELECT ${SCHEMA_EPOCH},
        (SELECT count(*) FROM main."${meta.table}" WHERE singleton = 1 AND version = ?) AS meta`)
      .get(meta.version);
    return row && row.meta === 1 && typeof row.main === 'number' && typeof row.temp === 'string' ? `${row.main}\n${row.temp}` : undefined;
  } catch {
    return undefined;
  }
}
