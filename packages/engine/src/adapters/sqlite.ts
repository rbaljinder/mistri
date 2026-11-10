/**
 * SQLite adapter, on Node's built-in `node:sqlite`.
 *
 * SQLite comes first because it needs no server, which means the tool has a
 * demo you can run in one command and a test target that does not depend on
 * anything being installed. It is also the dialect that proves the model is
 * general: its catalog is nothing like `information_schema`, so anything that
 * works for both is unlikely to be accidentally Postgres-shaped.
 */
import { statSync } from 'node:fs';
import {
  waitForLocks,
  assertIndependentWrite,
  writeToFile,
  prepareGuarded,
  transactionEpoch,
  storeEpoch,
  schemaFingerprint,
} from './sqliteHandles.js';
/* The tenant sources keep their catalog and store-layout checks by these (tenantReadSource.ts, tenantStore.ts). */
export { cachedStatement, schemaFingerprint } from './sqliteHandles.js';
import { captureScopeCatalog, mapScopeCatalog } from '../shared/scopeCatalog.js';
import { inlineRows } from '../shared/anyRows.js';
import { asksAboutRows } from '../shared/filter.js';
import { qualifiedTable } from '../shared/sqlRelation.js';
import type { SqlFragment } from '../shared/filter.js';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { isPromise, isProxy } from 'node:util/types';
import {
  ANSI_STYLE,
  buildWhere,
  type Adapter,
  type ScopedReads,
  type Filter,
  type QueryRequest,
  type QueryResult,
  clampLimit,
  clampOffset,
  boundStatement,
  looksWrappable,
  dedupe,
  refuseStacked,
  trimStatement,
  type SqlRequest,
  type SqlResult,
  type DeleteRequest,
  type DeleteResult,
  type TellRequest,
  type UpdateRequest,
  type UpdateResult,
  type ViewResult,
  type BreakdownResult,
  Refusal,
  WriteConflict,
  TransactionOutcomeUnknown,
  Serial,
  TransactionOperations,
  queueRecordLock,
  recordLockFilter,
  type WriteTransaction,
  type InsertRequest,
  type InsertResult,
  type ExplainRequest,
  type ExplainResult,
  type ColumnProfile,
  type ProfileLimits,
  type ProfileResult,
  refuseAnalyze,
  countStatement,
  countEachStatement,
  countEachRows,
  countsTogether,
  orderClause,
  lanesStatement,
  withoutLaneRow,
  type CountItem,
  type AggregateRequest,
  type AggregateResult,
  batchedRows,
  chunked,
  gathered,
  refuseUpdateMatches,
  runsOfColumns,
  sameTable,
} from './adapter.js';
import { compileAggregate } from '../shared/aggregate.js';
import { readExactly, summed } from '../shared/decimals.js';
import { buildUpdateGuard } from './scoped/updateGuard.js';
import { createScopedReads } from './scoped/scopedReads.js';
import { scopedCommandInvoker } from './scoped/scopedCommandOperations.js';
import {
  createScopedTransaction,
  foreignKeyRefusal,
  isForeignKeyViolation,
  referencesStatement,
  wholeWithin,
} from './scoped/scopedTransaction.js';
import type { TriggerAcceptance, TriggerChange } from './scoped/triggerProof.js';
import type { TriggerWitness } from './scoped/sqliteTriggerSession.js';
import { readSqliteScopeCatalog, sqliteBlockedTables, sqliteKeyFacts, type SqliteScopeCatalog } from './scoped/sqliteScopeCatalog.js';
import { readSqliteTrigger } from './scoped/sqliteTriggers.js';
import type { ScopeTrigger } from './scoped/scopeTriggers.js';
import type { TriggerKeyFacts } from './scoped/triggerEffects.js';
import { EpochCache } from './epochCache.js';
import { captureRowScope, type RowScope } from '../shared/rowScope.js';
import { isRuntimeTable } from '../shared/runtimeTables.js';
import { beginWriteCapture, capturesWrites, committedWriteCapture, finishWriteCapture, type CaptureSource } from './writeCapture.js';
import {
  lendStoreHost,
  type JournalRun,
  type JournalTransactionOptions,
  type SqliteTransactionJournal,
  type StoreMeta,
} from './storeHost.js';
import { cancellation, statementCap, throwIfCancelled } from './statementControl.js';
import { refuseReservedText, reservedRefusal } from './reservedSql.js';
import { runInStatementProcess } from './sqliteStatementProcess.js';
import { heavyRelations, readInProcess, stalls } from './sqliteCostlyReads.js';
import { scaleArrays, scaleRows, scalesOf } from './sqliteDecimals.js';
import { compileView, compileViewCount, type ViewDef } from '../shared/view.js';
import { roundTrip } from './dbLatency.js';
import { compileBreakdown, compileBreakdownCount, type BreakdownDef } from '../shared/breakdown.js';
import { flagsFromDDL, vocabularyFromDDL } from '../shared/vocabulary.js';
import {
  coerceForColumn,
  columnKind,
  deleteRuleOf,
  type ColumnMeta,
  type DatabaseSchema,
  type ForeignKey,
  type TableMeta,
} from '../shared/schema.js';

interface SqliteTableRow {
  name: string;
  type: string;
  /** The original `CREATE TABLE`/`CREATE VIEW` text, kept verbatim. */
  sql: string | null;
}
interface SqliteColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  /** `table_xinfo`'s: 0 a plain column, 1 a virtual table's hidden one, 2 and 3 generated (virtual, stored). */
  hidden: number;
}
/** A generated column, virtual (2) or stored (3): the database writes it from its expression. */
const generated = (column: SqliteColumnRow) => column.hidden === 2 || column.hidden === 3;
interface SqliteFkRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
  on_delete: string;
}
interface SqliteIndexRow {
  name: string;
  origin: string;
  unique?: number;
  partial?: number;
}

/* The catalog answers a write transaction trusts outlive the adapter that read them: a writer reopened, or a second
   one on the file, starts warm. Kept per file, by the identity of the file the handle opened (device, inode and birth
   time, so a new file at a reused inode is a new key) and never across files; a file with no birth time to tell it
   from its inode's next tenant, and an in-memory database, keep their own. Every entry is still served only under the
   epoch the reader holds (epochCache.ts), and frozen, since another adapter reads the same value. */
const sharedCatalogs = new Map<string, EpochCache<unknown>>();
function catalogCacheOf(identity: string | undefined): EpochCache<unknown> {
  if (identity === undefined) return new EpochCache();
  const cache = sharedCatalogs.get(identity) ?? new EpochCache();
  sharedCatalogs.delete(identity);
  sharedCatalogs.set(identity, cache);
  while (sharedCatalogs.size > 32) sharedCatalogs.delete(sharedCatalogs.keys().next().value!);
  return cache;
}
function frozen<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  if (value instanceof Map)
    for (const [key, each] of value) {
      frozen(key);
      frozen(each);
    }
  else if (value instanceof Set) for (const each of value) frozen(each);
  else for (const each of Object.values(value)) frozen(each);
  return Object.freeze(value);
}
/* What the scope catalog was resolved with is part of its key: a caller judging trigger effects reads another
   catalog than one that does not. */
const resolverIds = new WeakMap<object, number>();
let resolvers = 0;
const resolverKey = (resolve: object | undefined) => {
  if (!resolve) return 'scope';
  if (!resolverIds.has(resolve)) resolverIds.set(resolve, ++resolvers);
  return `scope:${resolverIds.get(resolve)}`;
};

const verifiedCommandAdapters = new WeakSet<object>();
/** Identity-only native provenance; no caller can register a lookalike. */
export const isSqliteVerifiedCommandSource = (value: unknown): value is SqliteAdapter =>
  !!value && typeof value === 'object' && !isProxy(value) && verifiedCommandAdapters.has(value);

export class SqliteAdapter implements Adapter {
  readonly dialect = 'sqlite' as const;
  private db: DatabaseSync;

  /** Opened lazily, only when an edit is actually applied. */
  private writeDb: DatabaseSync | null = null;
  private closed = false;
  /* Every write on that handle, one at a time. See `Serial`. */
  private writes = new Serial();
  private readonly writeIdentity: string | symbol;
  private readonly introspectedVersions = new WeakMap<DatabaseSchema, number>();
  /* Catalog answers a write transaction trusts — the journal's layout, the
     scope catalog, a table's existence and its columns — kept under the
     schema epoch the transaction read (transactionEpoch), so a warm command
     asks the catalog nothing (epochCache.ts). Shared by every adapter on the file (catalogCacheOf). */
  private readonly catalogCache: EpochCache<unknown>;
  /** The epoch the open write transaction read, on the handle it read it on. */
  private txEpoch?: { handle: DatabaseSync; epoch: string };

  constructor(
    private file: string,
    private label = file,
  ) {
    // Read-only by intent as well as by API: this is a browsing tool, and a
    // browsing tool that can write is a browsing tool that can destroy.
    this.db = new DatabaseSync(file, { readOnly: true });
    try {
      // SQLite reports its resolved main filename; in-memory databases have
      // no file and must not share a global ':memory:' queue.
      const filename = this.db.prepare('PRAGMA database_list').get()?.file;
      if (typeof filename === 'string' && filename) {
        const info = statSync(filename, { bigint: true });
        this.writeIdentity = `${info.dev}:${info.ino}`;
        this.catalogCache = catalogCacheOf(info.birthtimeNs > 0n ? `${info.dev}:${info.ino}:${info.birthtimeNs}` : undefined);
      } else {
        this.writeIdentity = Symbol('sqlite-memory');
        this.catalogCache = catalogCacheOf(undefined);
      }
      waitForLocks(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
    verifiedCommandAdapters.add(this);
    /* The App stores this file may hold read and write through these (stores/appStores.ts). */
    lendStoreHost(this, {
      dialect: 'sqlite',
      reader: () => this.db,
      queueWrite: (work) => this.queueWrite(async () => work(this.writeHandle())),
      attestedStore: (store, read, db) => this.attestedStore(store, read, db),
      file: () => this.file,
      closed: () => this.closed,
      assertWriteIdentity: () => this.assertWriteIdentity(),
      assertIndependentWrite: () => assertIndependentWrite(),
      journalTransaction: (journal, run, options) => this.journalTransaction(journal, run, options),
    });
  }

  private queueWrite<T>(work: () => Promise<T>): Promise<T> {
    // Check before even the handle-local queue: awaiting our own outer
    // transaction would otherwise deadlock rather than yield to a sibling.
    assertIndependentWrite();
    this.assertWriteIdentity();
    return this.writes.run(() =>
      writeToFile(this.writeIdentity, async () => {
        this.assertWriteIdentity();
        return work();
      }),
    );
  }

  private assertWriteIdentity(): void {
    if (typeof this.writeIdentity !== 'string') return;
    try {
      const info = statSync(this.file, { bigint: true });
      if (`${info.dev}:${info.ino}` === this.writeIdentity) return;
    } catch {
      /* Removed/replaced paths cannot silently acquire a new writer. */
    }
    throw new Refusal('The SQLite file changed. Reopen the connection before writing.');
  }

  private schemaVersion(): number {
    if (this.closed) throw new Refusal('This adapter is closed.');
    this.assertWriteIdentity();
    const version = this.db.prepare('PRAGMA main.schema_version').get()?.schema_version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0 || version > 2147483647) {
      throw new Refusal('The SQLite schema version is unavailable.');
    }
    return version;
  }

  /** Opt-in physical-schema lifetime fence. No logical clone or another
   * adapter's schema is accepted. Ordinary DDL invalidates it synchronously;
   * malicious manual schema_version resets are outside this contract. */
  captureSchemaLifetime(schema: DatabaseSchema): () => void {
    const version = this.introspectedVersions.get(schema);
    const current = () => {
      if (version === undefined || this.introspectedVersions.get(schema) !== version || this.schemaVersion() !== version) {
        throw new Refusal('The SQLite schema changed. Reopen the connection before reading.');
      }
    };
    current();
    return current;
  }

  /** Each table's triggers, read on the reader as a scoped write reads them on its writer (sqliteTriggers.ts). A TEMP
   * trigger is its own connection's, which this reader cannot see; the writer reads those too. */
  async triggers(): Promise<ReadonlyMap<string, readonly ScopeTrigger[]>> {
    const fold = (name: string) => name.replace(/[A-Z]/g, (char) => char.toLowerCase());
    const tables = new Map((await this.introspect()).tables.filter((table) => !table.isView).map((table) => [fold(table.name), table]));
    const found = new Map<string, ScopeTrigger[]>();
    const rows = this.db.prepare("SELECT tbl_name, name, sql FROM main.sqlite_schema WHERE type = 'trigger' ORDER BY name").all();
    for (const row of rows) {
      const table = tables.get(fold(String(row.tbl_name)));
      if (!table) continue;
      const generated = this.db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden IN (2, 3)').all(table.name);
      const trigger = readSqliteTrigger(String(row.name), row.sql, new Set(generated.map((column) => fold(String(column.name)))));
      found.set(table.id, [...(found.get(table.id) ?? []), trigger]);
    }
    return found;
  }

  /** What a write reads to judge a trigger's effects (sqliteScopeCatalog.ts): every table's keys, the conflict clauses
   * its schema declares, and the tables a scoped write cannot target, on the reader. */
  async triggerKeys(): Promise<TriggerKeyFacts> {
    return { ...sqliteKeyFacts(this.db), blocked: sqliteBlockedTables(this.db) };
  }

  async introspect(): Promise<DatabaseSchema> {
    const version = this.schemaVersion();
    const tableRows = this.db
      .prepare(
        `SELECT name, type, sql FROM sqlite_master
          WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%'
          ORDER BY name`,
      )
      .all() as unknown as SqliteTableRow[];

    const tables: TableMeta[] = [];
    const foreignKeys: ForeignKey[] = [];

    /* Approximate rows, the way SQLite can afford them: sqlite_stat1 where
       ANALYZE has run — free, and as current as the last ANALYZE — and a
       COUNT(*) otherwise, which on a local file is a b-tree scan the once-
       per-open introspection can absorb. Views stay uncounted: counting one
       runs its query, and a view is allowed to be expensive. */
    const analyzed = new Map<string, number>();
    try {
      const stats = this.db.prepare('SELECT tbl, stat FROM sqlite_stat1 WHERE stat IS NOT NULL').all() as unknown as Array<{
        tbl: string;
        stat: string;
      }>;
      for (const s of stats) {
        // The first number of `stat` is the row estimate; a partial index
        // reports fewer, so the largest claim across indexes wins.
        const n = Number(String(s.stat).split(' ')[0]);
        if (Number.isFinite(n)) analyzed.set(s.tbl, Math.max(analyzed.get(s.tbl) ?? 0, n));
      }
    } catch {
      /* No sqlite_stat1 means no ANALYZE yet, not an error. */
    }
    /* A COUNT(*) per table is a full scan per table, on the synchronous
       driver, at connect and at every refresh: on a multi-gigabyte file that
       was seconds of the whole server frozen for a number the sidebar shows
       in grey. Above a quarter gigabyte the count is left unknown unless
       ANALYZE has run — sqlite_stat1 is read above and costs nothing. */
    let bigFile = false;
    try {
      bigFile = statSync(this.file).size > 256 * 1024 * 1024;
    } catch {
      /* An in-memory or unusual path: count as before. */
    }
    const approxRowsOf = (name: string, type: string): number | undefined => {
      if (type !== 'table') return undefined;
      const known = analyzed.get(name);
      if (known !== undefined) return known;
      if (bigFile) return undefined;
      try {
        const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${ANSI_STYLE.quote(name)}`).get() as { n: number };
        return row.n;
      } catch {
        // A table the catalog lists can still refuse a scan (a broken
        // virtual table, say); no count beats no schema.
        return undefined;
      }
    };

    for (const t of tableRows) {
      /* table_xinfo, not table_info: table_info leaves out generated columns,
         so a table's computed figures were missing from every list and form.
         A virtual table's hidden columns (1) are its module's plumbing. */
      const cols = (this.db.prepare(`PRAGMA table_xinfo(${ANSI_STYLE.quote(t.name)})`).all() as unknown as SqliteColumnRow[]).filter(
        (c) => c.hidden !== 1,
      );
      const indexes = this.indexesOf(t.name);
      const pk = cols.filter((c) => c.pk > 0);
      // Rowid aliases have no primary-key index. This excludes WITHOUT ROWID
      // and the inline INTEGER PRIMARY KEY DESC exception without parsing DDL.
      const identity =
        t.type === 'table' && indexes && !indexes.some((i) => i.origin === 'pk') && pk.length === 1 && /^INTEGER$/i.test(pk[0].type.trim())
          ? pk[0].name
          : undefined;

      const fks = this.db.prepare(`PRAGMA foreign_key_list(${ANSI_STYLE.quote(t.name)})`).all() as unknown as SqliteFkRow[];

      /* PRAGMA returns one row per column of a composite key, grouped by `id`.
         Collapsing them here means the model never has to know that. */
      const byId = new Map<number, SqliteFkRow[]>();
      for (const fk of fks) {
        const list = byId.get(fk.id) ?? [];
        list.push(fk);
        byId.set(fk.id, list);
      }
      for (const [id, group] of byId) {
        const ordered = [...group].sort((a, b) => a.seq - b.seq);
        foreignKeys.push({
          name: `${t.name}_fk_${id}`,
          onDelete: deleteRuleOf(ordered[0].on_delete),
          from: { table: t.name, columns: ordered.map((f) => f.from) },
          // A null `to` means the FK targets the referenced table's primary
          // key implicitly, which SQLite allows and reports as null.
          to: {
            table: ordered[0].table,
            columns: ordered.map((f) => f.to ?? 'rowid'),
          },
        });
      }

      const refByColumn = new Map<string, { table: string; column: string }>();
      for (const [, group] of byId) {
        for (const f of group) {
          refByColumn.set(f.from, { table: f.table, column: f.to ?? 'rowid' });
        }
      }

      /* SQLite keeps the `CREATE TABLE` text it was given, checks and all, so
         the vocabulary is right there in the statement — no second query. */
      const vocabulary = t.sql
        ? vocabularyFromDDL(
            t.sql,
            cols.map((c) => c.name),
          )
        : new Map<string, string[]>();
      /* An integer a CHECK pins to 0 and 1 is SQLite's boolean. */
      const flags = t.sql
        ? flagsFromDDL(
            t.sql,
            cols.map((c) => c.name),
          )
        : new Set<string>();

      /* An untyped column of a *table* really does have BLOB affinity —
         `CREATE TABLE t (a)` is a column SQLite will happily store anything
         in, and saying BLOB is saying what the database will do with it.

         A *view* is a different question. `PRAGMA table_info` reports no type
         for a computed column because there is no declaration to report, not
         because the values are blobs: `COUNT(*)` came back as BLOB and so did
         `SUM(total)`, which is a wrong answer to "what does this column hold"
         rather than an unhelpful one. Left empty instead — `columnKind`
         already reads that as unknown, exactly as it read BLOB, so nothing
         renders differently; the tool simply stops claiming a type it was
         never told. */
      const untyped = t.type === 'view' ? '' : 'BLOB';
      const columns: ColumnMeta[] = cols.map((c) => ({
        name: c.name,
        type: c.type || untyped,
        nullable: c.notnull === 0 && c.name !== identity,
        primaryKey: c.pk > 0,
        references: refByColumn.get(c.name),
        default: c.dflt_value ?? undefined,
        identity: c.name === identity ? 'by-default' : undefined,
        // The database computes a generated column; nothing may write it.
        ...(generated(c) ? { writable: false } : {}),
        allowed: vocabulary.get(c.name),
        ...(flags.has(c.name) && columnKind(c.type) === 'number' ? { flag: true as const } : {}),
      }));

      tables.push({
        name: t.name,
        schema: '',
        id: t.name,
        columns,
        approxRows: approxRowsOf(t.name, t.type),
        isView: t.type === 'view',
        indexed: t.type === 'view' ? [] : this.leadingIndexColumns(columns, indexes),
        ...(() => {
          const unique = t.type === 'view' ? [] : this.uniqueColumns(indexes);
          return unique.length ? { unique } : {};
        })(),
        ...(() => {
          const pairs = t.type === 'view' ? [] : this.uniquePairs(indexes);
          return pairs.length ? { uniquePairs: pairs } : {};
        })(),
      });
    }

    const schema: DatabaseSchema = {
      label: this.label,
      dialect: this.dialect,
      tables,
      foreignKeys,
      readAt: new Date().toISOString(),
    };
    if (this.schemaVersion() !== version) throw new Refusal('The SQLite schema changed during introspection.');
    this.introspectedVersions.set(schema, version);
    /* The registry introspects on connect and keeps what it read; the view,
       breakdown and read paths below resolve against `cachedSchema`. Seeding
       it here is what stops the first of them from reading the whole catalog
       a second time — on a wide file that was a statement per table and
       index, on the synchronous driver, with the server frozen for it. */
    this.cachedSchema = schema;
    return schema;
  }

  private indexesOf(table: string): SqliteIndexRow[] | undefined {
    try {
      return this.db.prepare(`PRAGMA index_list(${ANSI_STYLE.quote(table)})`).all() as unknown as SqliteIndexRow[];
    } catch {
      return undefined;
    }
  }

  /**
   * The columns a unique index makes unique alone. `PRAGMA index_list`
   * reports UNIQUE constraints as the indexes SQLite made for them, so one
   * reading covers both; a partial index proves nothing about the rows it
   * leaves out, and an expression column has no name.
   */
  private uniqueColumns(indexes: SqliteIndexRow[] | undefined): string[] {
    const unique = new Set<string>();
    try {
      for (const index of indexes ?? []) {
        if (!index.unique || index.partial) continue;
        const info = this.db.prepare(`PRAGMA index_info(${ANSI_STYLE.quote(index.name)})`).all() as unknown as Array<{
          name: string | null;
        }>;
        if (info.length === 1 && info[0].name) unique.add(info[0].name);
      }
    } catch {
      // As leadingIndexColumns: nothing proven is the safe answer.
    }
    return [...unique];
  }

  /** The column pairs a unique index of exactly two named columns keeps
   * unique together, read as uniqueColumns reads one alone. */
  private uniquePairs(indexes: SqliteIndexRow[] | undefined): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    try {
      for (const index of indexes ?? []) {
        if (!index.unique || index.partial) continue;
        const info = this.db.prepare(`PRAGMA index_info(${ANSI_STYLE.quote(index.name)})`).all() as unknown as Array<{
          name: string | null;
        }>;
        if (info.length === 2 && info[0].name && info[1].name) pairs.push([info[0].name, info[1].name]);
      }
    } catch {
      return [];
    }
    return pairs;
  }

  /**
   * The columns an ORDER BY can lean on.
   *
   * `PRAGMA index_list` reports every index including the implicit ones
   * SQLite creates for UNIQUE and for a non-integer primary key; `index_info`
   * gives their columns in order and only the first of each is useful for
   * sorting.
   *
   * `INTEGER PRIMARY KEY` is special and has no index at all — it *is* the
   * rowid, so ordering by it is free — which is exactly the case a naive
   * index scan would report as unindexed and then refuse to sort by.
   */
  private leadingIndexColumns(columns: ColumnMeta[], indexes: SqliteIndexRow[] | undefined): string[] {
    const leading = new Set<string>();

    const rowidAlias = columns.find((c) => c.identity);
    if (rowidAlias) leading.add(rowidAlias.name);

    try {
      for (const index of indexes ?? []) {
        const info = this.db.prepare(`PRAGMA index_info(${ANSI_STYLE.quote(index.name)})`).all() as unknown as Array<{
          seqno: number;
          name: string | null;
        }>;
        const first = info.find((c) => c.seqno === 0)?.name;
        if (first) leading.add(first);
      }
    } catch {
      /* A virtual table, or one that vanished between listing and reading.
         Reporting no indexes is the safe answer: it only ever costs a
         default sort falling back to the key. */
    }

    return [...leading];
  }

  async query(request: QueryRequest): Promise<QueryResult> {
    const result = await this.queryOn(request, this.db, true);
    await this.turn();
    return result;
  }

  async scopeReads(input: RowScope): Promise<ScopedReads> {
    const scope = captureRowScope(input);
    const schema = await this.schema();
    return createScopedReads(schema, scope, ANSI_STYLE, async (compiled, hint) => {
      await roundTrip();
      const started = performance.now();
      const statement = this.db.prepare(compiled.text);
      statement.setReadBigInts(true);
      const described = statement.columns();
      const rows = scaleRows(
        statement.all(...sqliteParams(compiled.params)) as Array<Record<string, unknown>>,
        described.map((c) => c.name),
        scalesOf(described),
      );
      return {
        columns: described.map((column) => column.name),
        rows: rows.map(hint?.binary ? withBytes : toJsonSafe),
        ms: Math.round(performance.now() - started),
        sql: { text: compiled.text, params: compiled.params },
      };
    });
  }

  /* A read's filter. Rows that point at the one read (`any`/`no`) are asked as an EXISTS over the child's own table, read
     as the parent is: no scope sits between, so the caller's declaration of what it may read is the only bound
     (commandDb.ts). The catalog is read only when the filter asks, and a filter that asks of a catalog this handle
     cannot read is refused, as one nothing resolves is. */
  private async whereOf(id: string, relation: string, filter: Filter | undefined): Promise<SqlFragment> {
    if (!asksAboutRows(filter)) return buildWhere(filter, ANSI_STYLE);
    const schema = await this.schema().catch(() => undefined);
    const inline =
      schema && inlineRows(schema, id, ANSI_STYLE.quote(relation), ANSI_STYLE, (child) => qualifiedTable(schema, child.id, ANSI_STYLE));
    return buildWhere(filter, ANSI_STYLE, 1, undefined, undefined, undefined, undefined, false, undefined, false, inline);
  }

  private async queryOn(request: QueryRequest, db: DatabaseSync, read = false): Promise<QueryResult> {
    const table = read ? this.readTable(request.table) : this.assertTable(request.table, db);
    const cols = request.columns?.length ? request.columns.map((c) => ANSI_STYLE.quote(c)).join(', ') : '*';
    /* Every read is bounded. There is no code path that reaches the database
       without a LIMIT, including one that forgot to ask for one. Limit and
       offset are read before the first await: a scoped transaction snapshots
       its operation input, and the schema wait below must not outlive it. */
    const limit = clampLimit(request.limit);
    const offset = clampOffset(request.offset);
    const where = asksAboutRows(request.filter)
      ? await this.whereOf(request.table, table, request.filter)
      : buildWhere(request.filter, ANSI_STYLE);
    /* A sort by declared vocabulary needs the catalog, but an ordinary read must
       not depend on the whole catalog introspecting on this handle (a view over
       a function only the writer registered cannot be prepared here). Without
       it the column sorts by its value. */
    const orderBy = request.orderBy;
    const meta = orderBy?.length ? (await this.schema().catch(() => undefined))?.tables.find((t) => t.id === request.table) : undefined;
    const order = orderClause(orderBy, meta, ANSI_STYLE, 1);

    const lanes = request.lanes;
    const text = lanes
      ? lanesStatement(
          ANSI_STYLE,
          { columns: cols, source: `${ANSI_STYLE.quote(table)}${where.text}`, lane: ANSI_STYLE.quote(lanes.by), order: order.text },
          0,
        )
      : `SELECT ${cols} FROM ${ANSI_STYLE.quote(table)}${where.text}${order.text} LIMIT ? OFFSET ?`;
    const params = [...where.params, ...order.params, ...(lanes ? [clampLimit(lanes.limit)] : []), limit, offset];

    const started = performance.now();
    /* Integers past 2^53 are read as BigInt rather than throwing; valueSafe
       turns the safe ones back into numbers and keeps the rest as strings. */
    const rows = await this.readRows(text, params, false, db);
    const ms = Math.round(performance.now() - started);

    const result = {
      columns: rows.length ? Object.keys(rows[0]) : (request.columns ?? []),
      rows: rows.map(request.binary ? withBytes : toJsonSafe),
      ms,
      sql: { text, params },
    };
    return lanes ? withoutLaneRow(result) : result;
  }

  /**
   * Run a compiled view.
   *
   * Everything hard happened in `compileView`: paths resolved against the
   * catalog, joins planned with collision-free aliases, values reduced to
   * bound parameters. What is left here is picking the dialect's style and
   * handing the statement to the driver — which is the point. An adapter that
   * built its own joins would be an adapter that could get LEFT wrong on its
   * own.
   */
  async runView(view: ViewDef, offset = 0): Promise<ViewResult> {
    const schema = await this.schema();
    /* Every read is bounded, views included: `compileView` runs the limit
       through `clampLimit` and emits LIMIT unconditionally, so there is no
       shape of ViewDef that reaches the database without one. */
    const compiled = compileView(schema, view, ANSI_STYLE, offset);

    const started = performance.now();
    const rows = await this.readRows(compiled.text, compiled.params);
    const ms = Math.round(performance.now() - started);
    await this.turn();

    return {
      // From the compiled column list, not the first row: an empty result
      // still has to render its headers rather than collapsing to nothing.
      columns: compiled.columns.map((c) => c.name),
      rows: rows.map(toJsonSafe),
      ms,
      sql: { text: compiled.text, params: compiled.params },
      resolved: compiled.columns,
      joins: compiled.joins,
    };
  }

  async runBreakdown(breakdown: BreakdownDef, offset = 0): Promise<BreakdownResult> {
    const schema = await this.schema();
    const compiled = compileBreakdown(schema, breakdown, ANSI_STYLE, offset);

    const started = performance.now();
    const { rows } = await readExactly(
      async () => ({ rows: await this.readRows(compiled.text, compiled.params, true) }),
      summed(breakdown.measures),
    );
    await this.turn();
    return {
      columns: compiled.columns.map((c) => c.name),
      rows: rows.map(toJsonSafe),
      ms: Math.round(performance.now() - started),
      sql: { text: compiled.text, params: compiled.params },
      resolved: compiled.columns,
    };
  }

  async countBreakdown(breakdown: BreakdownDef, limit?: number): Promise<number> {
    const compiled = compileBreakdownCount(await this.schema(), breakdown, ANSI_STYLE, undefined, limit);
    const [row] = await this.readRows(compiled.text, compiled.params, true);
    await this.turn();
    return Number(row?.n ?? 0);
  }

  async countView(view: ViewDef, limit?: number): Promise<number> {
    const compiled = compileViewCount(await this.schema(), view, ANSI_STYLE, undefined, limit);
    const [row] = await this.readRows(compiled.text, compiled.params, true);
    await this.turn();
    return Number(row?.n ?? 0);
  }

  /**
   * EXPLAIN QUERY PLAN, indented the way the tree nests.
   *
   * Prepared and read, never executed: the rows come from the EXPLAIN
   * statement itself, so even a write handed here is only ever planned — on
   * the read-only handle, at that.
   */
  async explainSql(request: ExplainRequest): Promise<ExplainResult> {
    const stacked = refuseStacked(request.text, 'sqlite');
    if (stacked) throw new Error(stacked);
    const analyze = refuseAnalyze(request.text);
    if (analyze) throw new Error(analyze);
    if (request.refuseReserved) refuseReservedText(request.text, 'sqlite');
    const started = performance.now();
    const planned = `EXPLAIN QUERY PLAN ${trimStatement(request.text)}`;
    const rows = (request.refuseReserved ? prepareGuarded(this.db, planned) : this.db.prepare(planned)).all(
      ...sqliteParams(request.params ?? []),
    ) as unknown as Array<{ id: number; parent: number; detail: string }>;
    /* The driver hands back a flat list with parent pointers; the indentation
       is the tree, said in text. */
    const depth = new Map<number, number>();
    const plan = rows.map((r) => {
      const d = (depth.get(r.parent) ?? 0) + 1;
      depth.set(r.id, d);
      return `${'  '.repeat(d - 1)}${r.detail}`;
    });
    await this.turn();
    return { plan, ms: Math.round(performance.now() - started) };
  }

  /**
   * SQLite keeps no column statistics worth reading — sqlite_stat1 knows
   * index selectivity, not null shares — so this looks: one aggregate pass
   * for counts and edges, then one small GROUP BY per column that provably
   * repeats. `source` tells the caller what the look cost.
   *
   * Above `scanAtMost` rows it stops scanning and samples, because
   * node:sqlite is synchronous and a full pass over a ten-million-row table
   * holds the whole process for seconds. Every k-th rowid rather than the
   * first N: insertion order is not a sample, it is a history, and a min
   * taken from the first month of data would be presented as the table's.
   * A view — or a WITHOUT ROWID table, which refuses the arithmetic — falls
   * back to the first N with the same honest label, because running a view
   * twice to randomise it would cost what sampling exists to avoid.
   */
  async profile(table: string, limits?: ProfileLimits): Promise<ProfileResult> {
    const name = this.readTable(table);
    const meta = (await this.schema()).tables.find((t) => t.id === name);
    if (!meta) throw new Error(`No table or view called "${name}" in this database.`);
    const q = (c: string) => ANSI_STYLE.quote(c);
    const scanAtMost = limits?.scanAtMost ?? 200_000;
    const sampleSize = limits?.sampleSize ?? 100_000;
    const started = performance.now();

    /* COUNT(*) walks an index, not the data pages — cheap enough to decide
       with, and the number the answer reports either way. */
    const total = Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${q(name)}`).get() as { n: number }).n ?? 0);

    let from = q(name);
    let source: ProfileResult['source'] = 'scan';
    if (total > scanAtMost) {
      source = 'sample';
      const k = Math.max(2, Math.ceil(total / sampleSize));
      try {
        this.db.prepare(`SELECT rowid FROM ${q(name)} LIMIT 1`).get();
        /* Hashed, not bare `rowid % k`: data is allowed to be periodic —
           every tenth row null is a perfectly ordinary import — and a bare
           modulo resonates with exactly that, sampling only the pattern.
           Knuth's multiplicative constant scatters the rowids first, so the
           stride cannot alias with anything the rows themselves repeat. */
        from = `(SELECT * FROM ${q(name)} WHERE ((rowid * 2654435761) & 0x7fffffff) % ${k} = 0)`;
      } catch {
        from = `(SELECT * FROM ${q(name)} LIMIT ${sampleSize})`;
      }
    }

    const aggs = meta.columns.map(
      (c, i) =>
        `COUNT(${q(c.name)}) AS n${i}, COUNT(DISTINCT ${q(c.name)}) AS d${i}, ` +
        `MIN(${q(c.name)}) AS mn${i}, MAX(${q(c.name)}) AS mx${i}`,
    );
    const profileStmt = this.db.prepare(`SELECT COUNT(*) AS total${aggs.length ? `, ${aggs.join(', ')}` : ''} FROM ${from}`);
    /* MIN/MAX over a 64-bit id column would throw on read without this;
       valueSafe normalises what comes back. */
    profileStmt.setReadBigInts(true);
    const row = profileStmt.get() as Record<string, unknown>;
    /* The denominator the fractions are honest against: the rows actually
       read, which is the whole table only when nothing was skipped. */
    const basis = Number(row.total ?? 0);

    const columns: ColumnProfile[] = meta.columns.map((c, i) => {
      const nonNull = Number(row[`n${i}`] ?? 0);
      const distinct = Number(row[`d${i}`] ?? 0);
      const profiled: ColumnProfile = {
        column: c.name,
        type: c.type,
        nullFrac: basis ? (basis - nonNull) / basis : 0,
        distinct,
        min: valueSafe(row[`mn${i}`]) ?? undefined,
        max: valueSafe(row[`mx${i}`]) ?? undefined,
      };
      // Only where a value provably repeats; a unique column's most common
      // value is noise.
      if (nonNull > 0 && distinct < nonNull) {
        const topStmt = this.db.prepare(
          `SELECT ${q(c.name)} AS v, COUNT(*) AS n FROM ${from} ` +
            `WHERE ${q(c.name)} IS NOT NULL GROUP BY ${q(c.name)} ORDER BY n DESC, v LIMIT 5`,
        );
        topStmt.setReadBigInts(true);
        const top = topStmt.all() as unknown as Array<{ v: unknown; n: number }>;
        profiled.common = top.map((t) => ({ value: valueSafe(t.v), frac: Number(t.n) / basis }));
      }
      return profiled;
    });
    await this.turn();

    return {
      table: name,
      rows: total,
      columns,
      source,
      ...(source === 'sample' ? { sampled: basis } : {}),
      ms: Math.round(performance.now() - started),
    };
  }

  /**
   * After each statement a call runs: a turn of the event loop — a cancel
   * can only be read when there is one, and node:sqlite gives none while a
   * statement runs — then a stop if the call was cancelled, before its next
   * statement starts. After, not before, so a read takes its arguments as it
   * is called. A read nobody can cancel does not pay for it.
   */
  private async turn(): Promise<void> {
    const signal = cancellation();
    if (!signal) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    throwIfCancelled(signal);
  }

  /** Introspection is cheap here but not free; the view path re-uses it. */
  private cachedSchema: DatabaseSchema | null = null;

  private async schema(): Promise<DatabaseSchema> {
    if (!this.cachedSchema) this.cachedSchema = await this.introspect();
    return this.cachedSchema;
  }

  async count(table: string, filter?: Filter, limit?: number): Promise<number> {
    const counted = await this.countOn(table, filter, this.db, limit, true);
    await this.turn();
    return counted;
  }

  async aggregate(request: AggregateRequest): Promise<AggregateResult> {
    const answered = await this.aggregateOn(request, this.db);
    await this.turn();
    return answered;
  }

  async countEach(items: readonly CountItem[], limit?: number): Promise<number[]> {
    const relations = items.map((item) => ({ relation: ANSI_STYLE.quote(this.readTable(item.table)), filter: item.filter }));
    const statement = countEachStatement(relations, ANSI_STYLE, { limit, together: countsTogether(this.cachedSchema, items, limit) });
    const rows = await this.readRows(statement.text, statement.params, true);
    await this.turn();
    return countEachRows(rows, items.length);
  }

  private async countOn(table: string, filter: Filter | undefined, db: DatabaseSync, limit?: number, read = false): Promise<number> {
    const name = read ? this.readTable(table) : this.assertTable(table, db);
    const where = asksAboutRows(filter) ? await this.whereOf(table, name, filter) : buildWhere(filter, ANSI_STYLE);
    const text = countStatement(`${ANSI_STYLE.quote(name)}${where.text}`, limit);
    const [row] = await this.readRows(text, where.params, true, db);
    return Number(row?.n ?? 0);
  }

  /* A command's aggregate on its own transaction's handle (shared/aggregate.ts): one statement, its table's own
     columns, its integers past 2^53 kept as their digits. */
  private async aggregateOn(request: AggregateRequest, db: DatabaseSync): Promise<AggregateResult> {
    this.assertTable(request.table, db);
    const schema = await this.schema();
    const compiled = compileAggregate(schema, request, ANSI_STYLE);
    const { rows } = await readExactly(
      async () => ({ rows: await this.readRows(compiled.text, compiled.params, true, db) }),
      summed(request.measures),
    );
    return { rows: rows.map(toJsonSafe) };
  }

  /**
   * One compiled read's rows, BigInts and all. A read that could hold the
   * server's one thread — a count, a filter or a sort over a large table —
   * runs in the statement process instead (sqliteCostlyReads.ts); one on the
   * write handle, inside a transaction, stays where its transaction is.
   */
  private async readRows(
    text: string,
    params: readonly unknown[],
    aggregate = false,
    db = this.db,
  ): Promise<Array<Record<string, unknown>>> {
    await roundTrip();
    const bound = sqliteParams(params);
    if (db === this.db && typeof this.writeIdentity === 'string' && stalls(db, text, bound, heavyRelations(this.cachedSchema), aggregate))
      return readInProcess(this.file, text, bound);
    const statement = db.prepare(text);
    statement.setReadBigInts(true);
    const described = statement.columns();
    return scaleRows(
      statement.all(...bound) as Array<Record<string, unknown>>,
      described.map((c) => c.name),
      scalesOf(described),
    );
  }

  /**
   * SQLite stores the original statement text, so this is the real thing —
   * whitespace, comments, check constraints and all — not a reconstruction.
   * Indexes are appended because they are separate statements in
   * `sqlite_master` and are usually the first thing you want after the shape.
   */
  async ddl(table: string): Promise<string | undefined> {
    const name = this.assertTable(table);
    const row = this.db.prepare(`SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table','view')`).get(name) as
      | { sql?: string }
      | undefined;
    if (!row?.sql) return undefined;

    const indexes = this.db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
          ORDER BY name`,
      )
      .all(name) as unknown as Array<{ sql: string }>;

    const parts = [`${row.sql.trim()};`];
    if (indexes.length) parts.push('', ...indexes.map((i) => `${i.sql.trim()};`));
    return parts.join('\n');
  }

  /**
   * The write path, on its own handle.
   *
   * `this.db` is opened read-only and stays that way for the life of the
   * process, so browsing can never write no matter what the UI believes. A
   * second handle is opened the first time an edit is actually applied.
   */
  async update(request: UpdateRequest): Promise<UpdateResult> {
    // A table that keeps a history is written with its row, or not at all.
    if (this.recordsHistory(request)) return this.transaction((tx) => tx.update(request));
    return this.queueWrite(() => this.updateNow(request));
  }

  private async updateNow(request: UpdateRequest, read = this.db, scoped = false): Promise<UpdateResult> {
    const { table, meta, pk, applied } = this.updatePlan(request, read);

    const filter: Filter = {
      groups: [pk.map((column) => ({ column, op: '=' as const, value: request.key[column] }))],
    };

    /* Outside a transaction the count runs first, on the read handle, so the
       check that decides whether to write cannot itself write. Inside one it
       is the UPDATE's own count: the key is the whole primary key, so it
       matches one row or none, and a refusal rolls the transaction back. */
    const transactional = read !== this.db;
    const matches = transactional ? 1 : await this.count(table, filter);
    if (matches !== 1) refuseUpdateMatches(request, matches);

    const where = buildWhere(filter, ANSI_STYLE);
    const assignments = Object.keys(applied)
      .map((c) => `${ANSI_STYLE.quote(c)} = ?`)
      .join(', ');
    const guard = buildUpdateGuard(request, Object.fromEntries(meta.map((column) => [column.name, column.type])), ANSI_STYLE, 'sqlite', 1);
    const text = `UPDATE ${scoped ? 'OR ABORT ' : ''}${ANSI_STYLE.quote(table)} SET ${assignments}${where.text}${guard.text}`;
    const params = [...Object.values(applied), ...where.params, ...guard.params];

    const write = read === this.db ? this.writeHandle() : read;
    const result = write.prepare(text).run(...sqliteParams(params));
    if (request.expected !== undefined && Number(result.changes) === 0) throw new WriteConflict();
    if (transactional && Number(result.changes) !== 1) refuseUpdateMatches(request, Number(result.changes));
    return { affected: Number(result.changes), applied, sql: { text, params } };
  }

  /**
   * Several rows of one table changed by one statement inside a transaction, each as `updateNow` changes one: the
   * same refusals before it, each row's own values and `expected`, one row a key. A `CASE` a column picks each
   * row's value, the WHERE matches each key with its own guard, and RETURNING says which requests matched, so a
   * row whose key or guard missed refuses the batch as it would have refused alone.
   */
  private updateManyNow(requests: readonly UpdateRequest[], handle: DatabaseSync): UpdateResult[] {
    const plans = requests.map((request) => ({ request, ...this.updatePlan(request, handle) }));
    const table = sameTable(plans.map((plan) => plan.table));
    const pk = plans[0]!.pk;
    const types = Object.fromEntries(plans[0]!.meta.map((column) => [column.name, column.type]));
    const keys = new Set<string>();
    for (const { request } of plans) {
      const key = JSON.stringify(pk.map((column) => String(request.key[column])));
      if (keys.has(key)) throw new Refusal(`A batch changes each row of ${table} once; that key appears twice.`);
      keys.add(key);
    }
    const results: UpdateResult[] = [];
    for (const chunk of chunked(
      plans,
      (plan) => pk.length * (Object.keys(plan.applied).length + 3) + 2 * Object.keys(plan.applied).length,
    )) {
      const match = (request: UpdateRequest) => {
        const where = buildWhere({ groups: [pk.map((column) => ({ column, op: '=' as const, value: request.key[column] }))] }, ANSI_STYLE);
        return { text: where.text.replace(/^ WHERE /, ''), params: where.params };
      };
      const params: unknown[] = [];
      const columns = [...new Set(chunk.flatMap((plan) => Object.keys(plan.applied)))];
      const assignments = columns.map((column) => {
        const cases = chunk
          .filter((plan) => Object.hasOwn(plan.applied, column))
          .map((plan) => {
            const key = match(plan.request);
            params.push(...key.params, plan.applied[column]);
            return `WHEN ${key.text} THEN ?`;
          });
        const quoted = ANSI_STYLE.quote(column);
        return `${quoted} = CASE ${cases.join(' ')} ELSE ${quoted} END`;
      });
      const wheres = chunk.map((plan) => {
        const key = match(plan.request);
        const guard = buildUpdateGuard(plan.request, types, ANSI_STYLE, 'sqlite', 1);
        params.push(...key.params, ...guard.params);
        return `(${key.text}${guard.text})`;
      });
      const which = chunk.map((plan, index) => {
        const key = match(plan.request);
        params.push(...key.params);
        return `WHEN ${key.text} THEN ${index}`;
      });
      const text =
        `UPDATE ${ANSI_STYLE.quote(table)} SET ${assignments.join(', ')} WHERE ${wheres.join(' OR ')}` +
        ` RETURNING CASE ${which.join(' ')} END AS ${ANSI_STYLE.quote('mistri_batch_row')}`;
      const matched = new Set(
        (handle.prepare(text).all(...sqliteParams(params)) as Array<Record<string, unknown>>).map((row) => Number(row.mistri_batch_row)),
      );
      chunk.forEach((plan, index) => {
        if (!matched.has(index)) {
          if (plan.request.expected !== undefined) throw new WriteConflict();
          refuseUpdateMatches(plan.request, 0);
        }
        results.push({ affected: 1, applied: plan.applied, sql: { text, params } });
      });
    }
    return results;
  }

  /** What `update` refuses before it writes, and the values it writes, coerced to their columns. */
  private updatePlan(request: UpdateRequest, read: DatabaseSync) {
    const table = this.assertTable(request.table, read);
    /* A view with an INSTEAD OF trigger takes an UPDATE, and the trigger
       decides what changes. Refused as the other dialects refuse it: what the
       editor showed and what changed are then two different objects. Its
       columns carry no key either, but that refusal named the wrong reason. */
    if (this.isView(table, read)) throw new Refusal(`${table} is a view, so no single row can be identified.`);
    const meta = this.tableInfo(table, read);

    const pk = meta.filter((c) => c.pk > 0).map((c) => c.name);
    if (!pk.length) throw new Refusal(`${table} has no primary key, so no single row can be identified.`);

    const keyColumns = Object.keys(request.key);
    /* The key must be the whole primary key and nothing else. Accepting a
       partial key would let a two-column key match a whole group of rows,
       and accepting extra columns would let the caller widen the match. */
    const same = keyColumns.length === pk.length && pk.every((c) => keyColumns.includes(c));
    if (!same) {
      throw new Refusal(`Updating ${table} needs exactly its primary key (${pk.join(', ')}).`);
    }

    const entries = Object.entries(request.values ?? {});
    if (!entries.length) throw new Refusal('Nothing to update.');

    const applied: Record<string, string | number | boolean | null> = {};
    for (const [column, raw] of entries) {
      const declared = meta.find((c) => c.name === column);
      if (!declared) throw new Refusal(`${table} has no column called "${column}".`);
      if (pk.includes(column)) {
        // Editing a key in place silently repoints every row that referenced
        // it, or fails on the constraint. Neither belongs behind an editor.
        throw new Refusal(`"${column}" is part of the primary key and cannot be edited here.`);
      }
      if (generated(declared)) throw new Refusal(`"${column}" is generated by the database and cannot be written.`);
      /* Coerced against the declared type, because everything typed into a
         text box arrives as a string — including "17901" for a REAL column. */
      applied[column] = coerceForColumn(declared.type || '', raw);
      if (applied[column] === null && declared.notnull === 1) {
        throw new Refusal(`"${column}" is NOT NULL and cannot be emptied.`);
      }
    }

    return { table, meta, pk, applied };
  }

  /**
   * Add one row.
   *
   * The guards are `update`'s where they apply — real columns, coerced
   * values, a NOT NULL that cannot be handed null — but the key rules
   * invert: a primary key may be supplied (currency.code is one somebody
   * types) or left for the database to assign. What is deliberately *not*
   * pre-checked is completeness: a missing NOT NULL column with no default
   * is the database's refusal to make, and its message names the column
   * better than a paraphrase would.
   *
   * `RETURNING *` rather than last_insert_rowid plus a re-read: one
   * statement returns the row as stored — defaults filled, the assigned key
   * included — with no window for another write to land in between.
   */
  async insert(request: InsertRequest): Promise<InsertResult> {
    if (this.recordsHistory(request)) return this.transaction((tx) => tx.insert(request));
    return this.queueWrite(() => this.insertNow(request));
  }

  private async insertNow(request: InsertRequest, read = this.db, scoped = false): Promise<InsertResult> {
    const { table, meta, applied } = this.insertPlan(request, read);

    const columns = Object.keys(applied);
    // A schema-level ON CONFLICT REPLACE must never turn creation/restoration
    // into deletion of an existing row. This statement overrides that policy.
    const text =
      `INSERT OR ABORT INTO ${ANSI_STYLE.quote(table)}` +
      (columns.length
        ? ` (${columns.map((c) => ANSI_STYLE.quote(c)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        : ' DEFAULT VALUES') +
      ' RETURNING *';
    const params = Object.values(applied);

    const write = read === this.db ? this.writeHandle() : read;
    const inserted = write.prepare(text);
    /* The RETURNING row can carry a 64-bit id — most often exactly here, on a
       table whose key is one — so it is read as BigInt rather than throwing,
       and normalised on the way out like every other read. */
    inserted.setReadBigInts(true);
    const described = inserted.columns();
    const stored = inserted.get(...sqliteParams(params)) as Record<string, unknown>;
    // The key as stored (a scoped write reads its row back by it); the row as a person reads it, a decimal with its scale.
    const raw = toJsonSafe(stored);
    const row = scaleRows(
      [{ ...stored }],
      described.map((c) => c.name),
      scalesOf(described),
    )[0];

    const safe = toJsonSafe(row);
    const pk = meta.filter((c) => c.pk > 0).map((c) => c.name);
    if (
      scoped &&
      pk.some((column) => {
        const value = stored[column];
        return !(
          typeof value === 'string' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'bigint' && value >= -9007199254740991n && value <= 9007199254740991n)
        );
      })
    )
      throw new Refusal('The stored key cannot be checked in this row scope.');
    const key = Object.fromEntries(pk.map((c) => [c, (scoped ? raw : safe)[c] as string | number]));
    return { key, row: safe, applied, sql: { text, params } };
  }

  /** What `insert` refuses before it writes, and the values it writes, coerced to their columns. */
  private insertPlan(request: InsertRequest, read: DatabaseSync) {
    const table = this.assertTable(request.table, read);
    const meta = this.tableInfo(table, read);
    const applied: Record<string, string | number | boolean | null> = {};
    for (const [column, raw] of Object.entries(request.values ?? {})) {
      const declared = meta.find((c) => c.name === column);
      if (!declared) throw new Refusal(`${table} has no column called "${column}".`);
      if (generated(declared)) throw new Refusal(`"${column}" is generated by the database and cannot be written.`);
      applied[column] = coerceForColumn(declared.type || '', raw);
      if (applied[column] === null && declared.notnull === 1) {
        throw new Refusal(`"${column}" is NOT NULL and cannot be null. Leave it out to use its default, if it has one.`);
      }
    }
    return { table, meta, applied };
  }

  /**
   * Several rows of one table added by one statement inside a transaction, each as `insertNow` adds one: one
   * multi-row `INSERT OR ABORT … RETURNING *` for each run of rows naming the same columns. SQLite does not promise
   * the order RETURNING answers in, so each row is matched back to the request whose values it holds (batchedRows).
   */
  private insertManyNow(requests: readonly InsertRequest[], handle: DatabaseSync): InsertResult[] {
    const plans = requests.map((request) => this.insertPlan(request, handle));
    const table = sameTable(plans.map((plan) => plan.table));
    const pk = plans[0]!.meta.filter((c) => c.pk > 0).map((c) => c.name);
    const results: InsertResult[] = [];
    for (const run of runsOfColumns(plans)) {
      const columns = Object.keys(run[0]!.applied);
      for (const chunk of chunked(run, () => Math.max(1, columns.length))) {
        const params = chunk.flatMap((plan) => Object.values(plan.applied));
        const text =
          `INSERT OR ABORT INTO ${ANSI_STYLE.quote(table)}` +
          (columns.length
            ? ` (${columns.map((c) => ANSI_STYLE.quote(c)).join(', ')}) VALUES ${chunk.map(() => `(${columns.map(() => '?').join(', ')})`).join(', ')}`
            : ` DEFAULT VALUES`) +
          ' RETURNING *';
        if (!columns.length && chunk.length > 1) {
          /* DEFAULT VALUES is one row; rows that name no column are added one statement each. */
          for (const plan of chunk) results.push(this.insertOne(pk, text, [], plan.applied, handle));
          continue;
        }
        const inserted = handle.prepare(text);
        inserted.setReadBigInts(true);
        const described = inserted.columns();
        const stored = inserted.all(...sqliteParams(params)) as Array<Record<string, unknown>>;
        const rows = batchedRows(
          chunk.map((plan) => plan.applied),
          stored,
        );
        rows.forEach((row, index) => {
          const safe = toJsonSafe(
            scaleRows(
              [{ ...row }],
              described.map((c) => c.name),
              scalesOf(described),
            )[0],
          );
          const key = Object.fromEntries(pk.map((c) => [c, (safe as Record<string, unknown>)[c] as string | number]));
          results.push({ key, row: safe, applied: chunk[index]!.applied, sql: { text, params } });
        });
      }
    }
    return results;
  }

  private insertOne(pk: string[], text: string, params: unknown[], applied: InsertResult['applied'], handle: DatabaseSync): InsertResult {
    const inserted = handle.prepare(text);
    inserted.setReadBigInts(true);
    const described = inserted.columns();
    const stored = inserted.get(...sqliteParams(params)) as Record<string, unknown>;
    const safe = toJsonSafe(
      scaleRows(
        [{ ...stored }],
        described.map((c) => c.name),
        scalesOf(described),
      )[0],
    );
    const key = Object.fromEntries(pk.map((c) => [c, (safe as Record<string, unknown>)[c] as string | number]));
    return { key, row: safe, applied, sql: { text, params } };
  }

  /**
   * Run a statement the user wrote.
   *
   * The read handle is opened `readOnly: true` at the file level, which SQLite
   * enforces in the engine — there is no session setting for a statement to
   * reset, so unlike the other two adapters no transaction wrapper is needed
   * to make the guarantee real.
   *
   * What SQLite does not have is a statement timeout, and `node:sqlite` is
   * synchronous with no interrupt, so a pathological statement on this handle
   * blocks the whole process rather than one request. The LIMIT wrap covers
   * the ordinary case — a streaming SELECT stops once it has enough rows — but
   * not an aggregate over a cross join, which has to finish before it returns
   * anything. So a read whose caller can stop it — one run inside
   * `withCancellation`, as every MCP tool call is — runs in a process of its
   * own instead, which its cap or a cancel kills (sqliteStatementProcess.ts).
   * The browser's SQL editor runs its reads that way too (dataWriteRoutes.ts);
   * only an in-memory database, which has no second handle, and a caller with
   * no signal keep the in-process handle and its limit.
   */
  async runSql(request: SqlRequest): Promise<SqlResult> {
    const captured = { ...request };
    return captured.write ? this.queueWrite(() => this.runSqlNow(captured)) : this.runSqlNow(captured);
  }

  private async runSqlNow(request: SqlRequest): Promise<SqlResult> {
    await roundTrip();
    const stacked = refuseStacked(request.text, 'sqlite');
    if (stacked) throw new Error(stacked);
    if (!request.write) {
      const outside = refuseOutsideTheFile(request.text);
      if (outside) throw new Refusal(outside);
    }
    if (request.refuseReserved) refuseReservedText(request.text, 'sqlite');

    const limit = clampLimit(request.limit);
    const bounded = !request.write && looksWrappable(request.text);
    const text = bounded ? boundStatement(request.text, limit) : trimStatement(request.text);

    /* A file, that is: an in-memory database has no second handle to open. */
    const signal = cancellation();
    if (!request.write && signal && typeof this.writeIdentity === 'string') {
      const started = performance.now();
      const answer = await runInStatementProcess(
        {
          file: this.file,
          text,
          fallback: trimStatement(request.text),
          bounded,
          limit,
          refuseReserved: request.refuseReserved === true,
        },
        statementCap(request.timeoutMs),
        signal,
      );
      if (answer.reserved !== undefined) throw reservedRefusal(answer.reserved);
      const truncated = answer.rows.length > limit;
      return {
        columns: dedupe(answer.columns),
        rows: scaleArrays(truncated ? answer.rows.slice(0, limit) : answer.rows, scalesOf(answer.types.map((type) => ({ type })))).map(
          (row) => row.map(valueSafe),
        ),
        ms: Math.round(performance.now() - started),
        truncated,
        bounded: answer.wrapped,
        sql: { text: answer.wrapped ? text : trimStatement(request.text), params: [] },
      };
    }

    const db = request.write ? this.writeHandle() : this.db;
    const prepare = (sql: string) => (request.refuseReserved ? prepareGuarded(db, sql) : db.prepare(sql));
    const started = performance.now();

    /* The wrap is an optimisation that is allowed to fail. Not every legal
       statement survives being made a derived table, and rather than enumerate
       which, a statement that will not compile wrapped is run as written and
       reported as unbounded. Safe to prepare twice because this handle cannot
       write. */
    let wrapped = bounded;
    let statement;
    try {
      statement = prepare(text);
    } catch (err) {
      if (!bounded) throw err;
      wrapped = false;
      statement = prepare(trimStatement(request.text));
    }

    if (request.write) {
      const info = statement.run();
      return {
        columns: [],
        rows: [],
        ms: Math.round(performance.now() - started),
        truncated: false,
        bounded: false,
        affected: Number(info.changes ?? 0),
        sql: { text, params: [] },
      };
    }

    /* Arrays and a real column list, both from the driver.

       `columns()` reports every output column including two of the same name,
       and `setReturnArrays` makes the rows positional so both values survive —
       an object keyed by name can only hold one of them. Deriving names from
       the first row's keys, which is what `query()` does, loses the duplicate
       and returns nothing at all for an empty result. */
    statement.setReturnArrays(true);
    /* Same reason as the table reads: a raw `SELECT` can return a 64-bit id,
       and without this the driver throws on the first one past 2^53. */
    statement.setReadBigInts(true);
    const described = statement.columns();
    const columns = dedupe(described.map((c) => c.name ?? c.column ?? '?'));
    /* Stepped, and stopped one past the limit: a statement the wrap could not bound (one that starts with a
       parenthesis SQLite will not take as a derived table, or one the wrap made invalid) used to be read whole
       with all() and sliced after, every row in memory first. */
    const stepped: unknown[][] = [];
    for (const row of statement.iterate() as Iterable<unknown[]>) {
      stepped.push(row);
      if (stepped.length > limit) break;
    }
    const raw = scaleArrays(stepped, scalesOf(described));

    /* Capped whether or not the wrap applied. `bounded` says who did the
       limiting — the database, or us after it had already done the work — and
       the caller shows that difference. What it never means is that more rows
       than asked for reach the client. */
    const truncated = raw.length > limit;
    const kept = truncated ? raw.slice(0, limit) : raw;

    return {
      columns,
      rows: kept.map((row) => row.map(valueSafe)),
      ms: Math.round(performance.now() - started),
      truncated,
      bounded: wrapped,
      sql: { text: wrapped ? text : trimStatement(request.text), params: [] },
    };
  }

  /**
   * Delete one row.
   *
   * The guards are `update`'s, for the same reason they are `update`'s: the
   * danger in an editor is never injection, it is a statement whose WHERE is
   * broader than the author believed. A delete has the sharper version of that
   * problem, so nothing here is relaxed.
   *
   * Foreign keys are the database's business. `node:sqlite` enables
   * `foreign_keys` by default — checked, not assumed — so a RESTRICT fires and
   * a CASCADE cascades exactly as the schema says, and the error the user sees
   * is SQLite's own.
   */
  async remove(request: DeleteRequest): Promise<DeleteResult> {
    if (this.recordsHistory(request)) return this.transaction((tx) => tx.remove(request));
    return this.queueWrite(() => this.removeNow(request));
  }

  private recordsHistory(request: { table?: unknown }): boolean {
    return capturesWrites(this, request?.table);
  }

  /**
   * A store's layout attested once per schema epoch rather than on every
   * read: its three catalog reads were two of every room's statements in an
   * App that keeps notices. The epoch — the schema versions, and the store's
   * meta row, a data fact — is one statement read first; the layout is
   * described again whenever it has moved.
   */
  private attestedStore<T>(store: StoreMeta, read: (attested: boolean) => T, db = this.db): T {
    const epoch = storeEpoch(db, { table: store.table, version: store.version });
    const attested = this.catalogCache.get(epoch, `store:${store.name}`) === true;
    const result = read(attested);
    // Unattested, `read` attested the layout itself, and threw if it was not this version's.
    if (!attested) this.catalogCache.set(epoch, `store:${store.name}`, true);
    return result;
  }

  /** A write capture's reads on a transaction's own handle (writeCapture.ts). */
  private captureSource(handle: DatabaseSync): CaptureSource {
    return {
      writer: { dialect: 'sqlite', db: handle },
      read: async (table, key, columns) => {
        const result = await this.queryOn(
          {
            table,
            ...(columns ? { columns } : {}),
            limit: 2,
            offset: 0,
            filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
          },
          handle,
        );
        return result.rows.length === 1 ? result.rows[0] : undefined;
      },
      rows: async (table, where, columns, limit) =>
        (
          await this.queryOn(
            {
              table,
              columns,
              limit,
              offset: 0,
              filter: { groups: [Object.entries(where).map(([column, value]) => ({ column, op: '=' as const, value }))] },
            },
            handle,
          )
        ).rows,
    };
  }

  private async lockRecordNow(request: DeleteRequest, write: DatabaseSync): Promise<void> {
    // BEGIN IMMEDIATE already fences every other writer, including absent keys.
    // Still validate the exact main-catalog table and complete scalar primary key.
    const table = this.assertTable(request.table, write);
    const meta = this.tableInfo(table, write);
    recordLockFilter(
      request,
      meta.filter((column) => column.pk > 0).map((column) => column.name),
    );
  }

  private async removeNow(request: DeleteRequest, read = this.db): Promise<DeleteResult> {
    const table = this.assertTable(request.table, read);
    const meta = this.tableInfo(table, read);

    const pk = meta.filter((c) => c.pk > 0).map((c) => c.name);
    if (!pk.length) throw new Refusal(`${table} has no primary key, so no single row can be identified.`);

    const keyColumns = Object.keys(request.key);
    const same = keyColumns.length === pk.length && pk.every((c) => keyColumns.includes(c));
    if (!same) {
      throw new Refusal(`Deleting from ${table} needs exactly its primary key (${pk.join(', ')}).`);
    }

    const filter: Filter = {
      groups: [pk.map((column) => ({ column, op: '=' as const, value: request.key[column] }))],
    };

    // As an update's: inside a transaction the DELETE's own count is the check.
    const transactional = read !== this.db;
    const refuseMatches = (count: number): never => {
      throw new Refusal(
        `Refused: that key matches ${count} rows, not 1. A delete is only allowed when it is certain which row it removes.`,
      );
    };
    const matches = transactional ? 1 : await this.count(table, filter);
    if (matches !== 1) refuseMatches(matches);

    const where = buildWhere(filter, ANSI_STYLE);
    const text = `DELETE FROM ${ANSI_STYLE.quote(table)}${where.text}`;
    const write = read === this.db ? this.writeHandle() : read;
    const result = write.prepare(text).run(...sqliteParams(where.params));
    if (transactional && Number(result.changes) !== 1) refuseMatches(Number(result.changes));
    return { affected: Number(result.changes), sql: { text, params: where.params } };
  }

  private writeHandle(): DatabaseSync {
    if (this.closed) throw new Refusal('This adapter is closed.');
    this.assertWriteIdentity();
    if (!this.writeDb) {
      const write = new DatabaseSync(this.file);
      try {
        this.assertWriteIdentity();
        waitForLocks(write);
        this.writeDb = write;
      } catch (error) {
        write.close();
        throw error;
      }
    }
    return this.writeDb;
  }

  /**
   * Several writes as one, or none of them.
   *
   * `BEGIN IMMEDIATE` serializes writers across processes, not just this queue.
   * Reads and mutation preflights inside the callback share its write handle.
   * Ordinary browsing remains on the separate read-only handle.
   *
   * `node:sqlite` is synchronous, so nothing can interleave *within* one
   * statement; the queue is what stops another request's write interleaving
   * *between* two of these.
   */
  async transaction<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    return this.transact((tx) => run(tx), undefined);
  }

  /**
   * Records and a durable journal in one transaction, the journal lent by
   * the App framework (storeHost.ts TransactionJournal): the command journal,
   * or a public placement's. Lent through the store host, never on the
   * class, so the database browser has no journal path at all. A verified
   * ordinary transaction's check is trusted host code, never a
   * handler/request: it runs after BEGIN and journal attestation and after
   * the operations drain, before COMMIT, and infers no tenant namespace, row
   * scope or bearer authority.
   */
  private async journalTransaction<J, T>(
    journal: SqliteTransactionJournal<J>,
    run: JournalRun<J, T>,
    options: JournalTransactionOptions<(db: DatabaseSync, catalog: SqliteScopeCatalog) => void> = {},
  ): Promise<T> {
    const { scope, verify, ordinaryVerify, bound, triggers } = options;
    if (ordinaryVerify !== undefined) {
      if (!isSqliteVerifiedCommandSource(this)) throw new Refusal('This verified command transaction is unavailable.');
      if (typeof ordinaryVerify !== 'function' || isProxy(ordinaryVerify) || typeof run !== 'function' || isProxy(run) || this.closed)
        throw new Refusal('This verified command transaction is unavailable.');
    }
    return this.transact(
      run as JournalRun<J | undefined, T>,
      journal,
      scope,
      verify,
      undefined,
      ordinaryVerify as (() => void) | undefined,
      bound,
      triggers,
    );
  }

  async scopeTransaction<T>(
    input: RowScope,
    run: (tx: WriteTransaction, catalog: DatabaseSchema) => Promise<T>,
    triggers?: TriggerAcceptance,
  ): Promise<T> {
    const scope = captureRowScope(input);
    if (this.closed) throw new Refusal('This adapter is closed.');
    return this.transact(
      (tx, _journal, catalog) => run(tx, catalog!),
      undefined,
      scope,
      undefined,
      undefined,
      undefined,
      undefined,
      triggers,
    );
  }

  /** Private source-owner boundary, deliberately absent from Adapter. The
   * verifier is trusted host code, never a business callback or wire value.
   * It must be synchronous and may not retain the raw handle. */
  async scopeVerifiedTransaction<T>(
    input: RowScope,
    verify: (db: DatabaseSync, catalog: SqliteScopeCatalog) => void,
    run: (tx: WriteTransaction, catalog: DatabaseSchema) => Promise<T>,
  ): Promise<T> {
    const scope = captureRowScope(input);
    if (typeof verify !== 'function' || typeof run !== 'function' || this.closed || Object.keys(scope).some(isRuntimeTable))
      throw new Refusal('This verified transaction is unavailable.');
    return this.transact((tx, _journal, catalog) => run(tx, catalog!), undefined, scope, verify);
  }

  /** Internal runtime-owner composition, deliberately absent from Adapter.
   * Only trusted runtime code may create bounded maintenance facades here; raw
   * handles must never reach business handlers, policies or request callbacks.
   * Runtime edits share the ordinary writer queue, drain and outcome handling. */
  async runtimeMaintenanceTransaction<T>(
    verify: (db: DatabaseSync) => void,
    run: (db: DatabaseSync, operations: TransactionOperations, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.closed || typeof verify !== 'function' || typeof run !== 'function') throw new Refusal('Runtime maintenance is unavailable.');
    return this.transact<unknown, T>(
      async () => {
        throw new Refusal('Runtime maintenance is unavailable.');
      },
      undefined,
      {},
      verify,
      run,
    );
  }

  private async transact<J, T>(
    run: JournalRun<J | undefined, T>,
    journal: SqliteTransactionJournal<J> | undefined,
    scope?: RowScope,
    verify?: (db: DatabaseSync, catalog: SqliteScopeCatalog) => void,
    maintenance?: (db: DatabaseSync, operations: TransactionOperations, assertCurrent: () => void) => Promise<T>,
    ordinaryVerify?: () => void,
    bound?: RowScope,
    triggers?: TriggerAcceptance,
  ): Promise<T> {
    return this.queueWrite(async () => {
      /* Inside the queued step, not before it: an await ahead of queueWrite lets a write asked for later take its place in the
         queue, and a transaction asked for first must run first (row-scope-transaction.test.ts). */
      /* Loaded where a transaction uses them, not at startup: the keyed-effect judge for a scoped write (its database
         may hold keyed triggers), and the proof and its session witness where the App names triggers. */
      const effects = scope !== undefined ? await import('./scoped/triggerEffects.js') : undefined;
      const proving =
        scope !== undefined && triggers
          ? await Promise.all([import('./scoped/triggerProof.js'), import('./scoped/sqliteTriggerSession.js')])
          : undefined;
      const operations = new TransactionOperations();
      let write: DatabaseSync | undefined;
      let began = false;
      let commitAttempted = false;
      let witness: TriggerWitness | undefined;
      try {
        if (this.closed) throw new Refusal('This adapter is closed.');
        write = this.writeHandle();
        write.exec('BEGIN IMMEDIATE');
        began = true;
        const handle = write;
        /* One statement for the epoch the whole transaction trusts: BEGIN
           IMMEDIATE holds the file's write lock, so no connection can change
           the schema until COMMIT, and what is cached under this epoch is
           what the transaction will see. */
        const meta = journal?.meta;
        const read = transactionEpoch(handle, meta && { table: meta.table, version: meta.version });
        const epoch = read.epoch;
        /* A journal that names a meta row is attested once per epoch; one that does not, in every transaction. */
        if (journal && !meta) journal.attest(handle);
        if (meta && !(read.journal && this.catalogCache.get(epoch, `journal:${meta.name}`))) {
          journal!.attest(handle);
          this.catalogCache.set(epoch, `journal:${meta.name}`, true);
        }
        if (epoch !== undefined) this.txEpoch = { handle, epoch };
        // Separate from scoped verification: no physical scope catalog is
        // required, and ordinary CommandTransactionFailure outcomes remain.
        const verifyOrdinary = () => {
          if (!ordinaryVerify) return;
          if (!handle.isTransaction) throw new Refusal('The verified command transaction is no longer active.');
          const result = ordinaryVerify() as unknown;
          if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
          if (result !== undefined || !handle.isTransaction) throw new Refusal('Transaction verification must be synchronous.');
        };
        /* Beneath every facade, so a scoped writer, a command and an Undo
           record exactly as a Save does (history/recordHistory.ts). */
        const history = maintenance ? undefined : beginWriteCapture(this, this.captureSource(handle));
        const insert = (r: InsertRequest) => this.insertNow(r, handle, scope !== undefined);
        const remove = (r: DeleteRequest) => this.removeNow(r, handle);
        const update = (r: UpdateRequest) => this.updateNow(r, handle, scope !== undefined);
        let records: WriteTransaction = {
          query: (r) => this.queryOn(r, handle),
          count: (table, filter) => this.countOn(table, filter, handle),
          aggregate: (r) => this.aggregateOn(r, handle),
          insert: history ? (r) => history.insert(r, insert) : insert,
          remove: history ? (r) => history.remove(r, remove) : remove,
          update: history ? (r) => history.update(r, update) : update,
          /* A batch only beneath the plain facade: a row scope proves each row's statement on its own. History still
             records each row, around the one statement (gathered). */
          ...(scope === undefined
            ? {
                insertMany: (rs: readonly InsertRequest[]) => {
                  const many = async (rs: readonly InsertRequest[]) => this.insertManyNow(rs, handle);
                  return history ? gathered(rs, (r, write) => history.insert(r, write), many) : many(rs);
                },
                updateMany: (rs: readonly UpdateRequest[]) => {
                  const many = async (rs: readonly UpdateRequest[]) => this.updateManyNow(rs, handle);
                  return history ? gathered(rs, (r, write) => history.update(r, write), many) : many(rs);
                },
              }
            : {}),
        };
        let evidence: DatabaseSchema | undefined;
        let physicalCatalog: SqliteScopeCatalog | undefined;
        /* The schema the last whole verification saw (schemaFingerprint). Unset until one passes, and again while one
           runs, so a verification that threw is never taken as passed. */
        let settled: string | undefined;
        const fingerprint = verify ? schemaFingerprint(handle) : undefined;
        const verified = () => {
          if (!verify) return;
          if (!handle.isTransaction || !physicalCatalog) throw new Refusal('The verified transaction is no longer active.');
          settled = undefined;
          const result = verify(handle, physicalCatalog);
          if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
          if (result !== undefined || !handle.isTransaction) throw new Refusal('Transaction verification must be synchronous.');
          settled = fingerprint!();
        };
        /* Around each operation, the whole verification only when the schema moved since the last one passed. It runs
           whole when the transaction opens and again before COMMIT, which is what decides; between, nothing a handler can
           ask for changes what it attests. BEGIN IMMEDIATE holds the write lock, so no other connection changes the main
           schema; an operation runs no DDL; and the attested rows (a store's meta row, a membership) are runtime tables a
           handler cannot write. A schema change on this handle all the same (a TEMP shadow, an index, a trigger) moves the
           fingerprint, and the next operation verifies whole and refuses before anything reaches COMMIT. Verifying whole
           around every operation read the catalog twice a call: with forty tables, 100 to 150 ms of a command's every
           database call (a field report). */
        const verifiedStep = () => {
          if (!verify) return;
          if (!handle.isTransaction || !physicalCatalog) throw new Refusal('The verified transaction is no longer active.');
          if (settled !== undefined && fingerprint!() === settled) return;
          verified();
        };
        if (scope !== undefined) {
          /* Its schema captured once here, so the evidence mapping below is the same object every write and is
             made once per schema rather than copied and checked twice a command (mapScopeCatalog). */
          const catalog = this.catalogCache.throughSync(epoch, resolverKey(effects?.resolveTriggerEffects), () => {
            const read = readSqliteScopeCatalog(handle, effects?.resolveTriggerEffects);
            return frozen({ ...read, schema: captureScopeCatalog(read.schema) });
          }) as SqliteScopeCatalog;
          physicalCatalog = catalog;
          journal?.admit?.(handle, catalog, scope);
          // Keep the complete physical graph for row/FK enforcement. Runtime
          // state is not command-handler evidence, and an incident edge may
          // not disappear merely because its endpoint belongs to the runtime.
          evidence = journal
            ? mapScopeCatalog(
                catalog.schema,
                new Map(catalog.schema.tables.filter((table) => !isRuntimeTable(table.id)).map((table) => [table.id, table.id])),
              )
            : captureScopeCatalog(catalog.schema);
          const scopedReads = (guard: boolean, within: RowScope = scope) =>
            createScopedReads(catalog.schema, within, ANSI_STYLE, async (sql, hint) => {
              const started = performance.now();
              const statement = handle.prepare(sql.text);
              statement.setReadBigInts(true);
              const described = statement.columns();
              const read = statement.all(...sqliteParams(sql.params)) as Record<string, unknown>[];
              /* A guard's row is what a check names rows by: the value as stored, never said with a decimal's scale
                 (19.987 said as "19.99" named another row). Only what a person reads is said so. */
              const rows = guard
                ? read
                : scaleRows(
                    read,
                    described.map((c) => c.name),
                    scalesOf(described),
                  );
              return {
                columns: described.map((column) => column.name),
                rows: rows.map((row) =>
                  guard
                    ? Object.fromEntries(
                        Object.entries(row).map(([key, value]) => [
                          key,
                          typeof value === 'bigint' && value >= -9007199254740991n && value <= 9007199254740991n ? Number(value) : value,
                        ]),
                      )
                    : hint?.binary
                      ? withBytes(row)
                      : toJsonSafe(row),
                ),
                ms: Math.round(performance.now() - started),
                sql,
              };
            });
          /* What the triggers it accepts wrote is seen again by a session before COMMIT (sqliteTriggerSession.ts). */
          const seen = proving && !journal?.fixedRecords ? proving[1].sqliteTriggerWitness(handle, catalog.schema.tables) : undefined;
          witness = seen;
          const accepted = seen && {
            acceptance: {
              ...triggers!,
              changed: async (change: TriggerChange) => {
                seen.proven(change);
                // Kept and announced as the transaction's own writes are (writeCapture.ts).
                await history?.triggered?.(change);
                await triggers!.changed?.(change);
              },
            },
            scope,
            watch: seen.watch,
            prove: proving![0].createTriggerProof,
          };
          records = createScopedTransaction(
            catalog,
            records,
            scopedReads(false),
            scopedReads(true),
            undefined,
            bound && {
              reads: scopedReads(true, bound),
              whole: wholeWithin(scope, bound),
              references: async (fk, key) => {
                const statement = referencesStatement(catalog, fk, key, ANSI_STYLE);
                const [row] = await this.readRows(statement.text, statement.params, true, handle);
                return Number(row?.n ?? 0);
              },
            },
            // A public intake writes exactly its fixed rows; only a principal's own transaction counts its new parents in.
            journal?.fixedRecords ? undefined : { scope, reads: (within, guard) => scopedReads(guard, within) },
            // Triggers the App names, on a principal's own transaction: their effects proven per write (triggerProof.ts).
            accepted,
            scope,
            async (fk, key) => {
              const statement = referencesStatement(catalog, fk, key, ANSI_STYLE);
              const [row] = await this.readRows(statement.text, statement.params, true, handle);
              return Number(row?.n ?? 0);
            },
          );
          /* Each row the transaction's own statements write, told to the session after the statement and after the
             proof has said what its triggers reached: a trigger the proof did not reach that writes it again later is
             a change SQLite still calls direct. */
          if (seen) {
            const inner = records;
            records = {
              ...inner,
              insert: async (r) => {
                const result = await inner.insert(r);
                seen.wrote(r.table, result.key);
                return result;
              },
              update: async (r) => {
                const result = await inner.update(r);
                seen.wrote(r.table, r.key, r.values);
                return result;
              },
              remove: async (r) => {
                // Gone after the statement: its key as stored is read before it (sqliteTriggerSession.ts stored).
                const key = seen.stored(r.table, r.key);
                const result = await inner.remove(r);
                seen.wrote(r.table, key);
                return result;
              },
            };
          }
          if (journal?.fixedRecords) records = journal.fixedRecords(records);
        }
        verified();
        verifyOrdinary();
        const invoke = scopedCommandInvoker(operations, scope !== undefined, journal !== undefined, isRuntimeTable, verifiedStep);
        const out = maintenance
          ? await maintenance(handle, operations, verified)
          : await run(
              Object.freeze({
                // The scoped policy facade deliberately has no generic lock capability.
                ...(scope === undefined
                  ? { lockRecord: (r: DeleteRequest) => queueRecordLock(operations, r, (request) => this.lockRecordNow(request, handle)) }
                  : {}),
                query: (r: QueryRequest) => invoke(r, (r) => records.query(r)),
                count: (table: string, filter?: Filter) => invoke({ table, filter }, (r) => records.count(r.table, r.filter)),
                ...(records.aggregate ? { aggregate: (r: AggregateRequest) => invoke(r, (r) => records.aggregate!(r)) } : {}),
                insert: (r: InsertRequest) => invoke(r, (r) => records.insert(r)),
                remove: (r: DeleteRequest) => invoke(r, (r) => records.remove(r)),
                update: (r: UpdateRequest) => invoke(r, (r) => records.update(r)),
                ...(scope === undefined && records.insertMany && records.updateMany
                  ? {
                      insertMany: (rs: readonly InsertRequest[]) => invoke(rs, (rs) => records.insertMany!(rs)),
                      updateMany: (rs: readonly UpdateRequest[]) => invoke(rs, (rs) => records.updateMany!(rs)),
                    }
                  : {}),
                // Beneath the row scope: the flows' command tells only of its own target, which it read through the scope.
                ...(history ? { tell: (r: TellRequest) => invoke(r, (r) => history.tell(r)) } : {}),
              }),
              journal?.open(handle, operations, verify ? verifiedStep : undefined),
              evidence,
            );
        await operations.finish();
        witness?.settle();
        await finishWriteCapture(history);
        verified();
        verifyOrdinary();
        commitAttempted = true;
        try {
          write.exec('COMMIT');
        } catch (error) {
          /* A deferred foreign key the COMMIT found broken, in a scoped write: SQLite leaves the transaction open, so
             nothing committed (the ROLLBACK below ends it), and the refusal is a hidden parent's (foreignKeyRefusal). */
          if (scope === undefined || !isForeignKeyViolation(error) || !handle.isTransaction) throw error;
          commitAttempted = false;
          throw foreignKeyRefusal(error);
        }
        committedWriteCapture(history);
        return out;
      } catch (err) {
        await operations.finish().catch(() => {});
        witness?.close();
        let rolledBack = false;
        if (began) {
          try {
            write!.exec('ROLLBACK');
            rolledBack = true;
          } catch {
            /* A failed acknowledgement cannot establish the outcome. */
          }
        }
        const unknown = commitAttempted || (began && !rolledBack);
        if (write && (unknown || !began)) {
          // Never let queued writes inherit a transaction with an uncertain state.
          try {
            write!.close();
          } catch {
            /* Preserve the original failure. */
          }
          if (this.writeDb === write) this.writeDb = null;
        }
        // The private verified owner composes native transaction outcomes like
        // ordinary tenant writes. Do not wrap its existing unknown marker in a
        // legacy command refusal merely because the outer rollback succeeded.
        if (journal && !verify) throw journal.failure(err, unknown ? 'unknown' : 'not_applied');
        if (unknown) throw new TransactionOutcomeUnknown(err);
        throw err;
      } finally {
        if (this.txEpoch?.handle === write) this.txEpoch = undefined;
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.db.close();
    this.writeDb?.close();
    this.writeDb = null;
  }

  /**
   * Table names are the one identifier that cannot be a bound parameter, so
   * they are checked against the catalog rather than escaped and hoped for.
   * An unknown name is rejected before it reaches a statement.
   */
  /**
   * The same check for a read on the browsing handle, answered from the
   * catalog read on connect when it names the table: a name found there is
   * one the catalog gave, so the probe would only say so again, once per
   * statement. A name it does not hold — a table made since — still gets the
   * live probe, and so does every write (assertTable).
   */
  private readTable(name: string): string {
    if (this.cachedSchema?.tables.some((table) => table.id === name)) return name;
    return this.assertTable(name);
  }

  private assertTable(name: string, db = this.db): string {
    /* Inside a write transaction, every name at once, kept under its epoch:
       the first write of an epoch reads the list, and no later one asks. */
    const epoch = this.epochOf(db);
    if (epoch !== undefined) {
      const names = this.catalogCache.throughSync(epoch, 'tables', () =>
        frozen(
          new Set(
            (db.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`).all() as Array<{ name: string }>).map(
              (row) => row.name,
            ),
          ),
        ),
      );
      if (!(names as Set<string>).has(name)) throw new Error(`No table or view called "${name}" in this database.`);
      return name;
    }
    const exists = db.prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(name);
    if (!exists) throw new Error(`No table or view called "${name}" in this database.`);
    return name;
  }

  /** A table's columns, as a write reads them: from the catalog, or inside a
   * write transaction from what was read under the epoch it holds. */
  private tableInfo(table: string, db: DatabaseSync): SqliteColumnRow[] {
    return this.catalogCache.throughSync(this.epochOf(db), `columns:${table}`, () =>
      frozen(
        (db.prepare(`PRAGMA main.table_xinfo(${ANSI_STYLE.quote(table)})`).all() as unknown as SqliteColumnRow[]).filter(
          (c) => c.hidden !== 1,
        ),
      ),
    ) as SqliteColumnRow[];
  }

  /** Whether a relation is a view, as a write reads it: kept under the epoch, as its columns are. */
  private isView(table: string, db: DatabaseSync): boolean {
    return this.catalogCache.throughSync(
      this.epochOf(db),
      `view:${table}`,
      () => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = ?`).get(table) !== undefined,
    ) as boolean;
  }

  /** The epoch the open write transaction holds, when `db` is its handle and it is still open. */
  private epochOf(db: DatabaseSync): string | undefined {
    return this.txEpoch?.handle === db && db.isTransaction ? this.txEpoch.epoch : undefined;
  }
}

// SQL booleans remain portable in the compiler; node:sqlite binds them as 0/1.
export function sqliteParams(params: readonly unknown[]): SQLInputValue[] {
  return params.map((value) => (typeof value === 'boolean' ? Number(value) : (value as SQLInputValue)));
}

/**
 * One value from the database, made safe to send as JSON.
 *
 * Two things do not survive `JSON.stringify`, and one of them does not survive
 * being *read* by default. `node:sqlite` throws on any integer past 2^53
 * unless the statement is told to read big integers — so the data statements
 * ask for that (`setReadBigInts`), and everything comes back as `bigint`.
 *
 * A bigint inside the safe range is turned back into a plain number, because
 * the client formats numbers — thousands separators, right alignment — and a
 * string would lose all of that on the id column of every ordinary table. One
 * *past* the safe range is kept as a string, because that is the whole point:
 * a Postgres/Snowflake-style 64-bit id shown as `9007199254740992` when it is
 * really `...993` looks right and matches nothing when clicked. Passing it
 * through as a number would be the silent corruption this exists to prevent.
 *
 * Blobs become `<n bytes>`: the grid has no use for the bytes and every use
 * for the size.
 */
/**
 * The statements a read-only handle still runs that reach past its file.
 *
 * `readOnly: true` stops writes to this database, not to others: `VACUUM
 * INTO` writes a whole copy — runtime and sign-in tables included — to a path
 * the statement names, and `ATTACH` opens another file (and, on the shared
 * in-process handle, leaves it open for the next statement). SQLite's
 * authorizer is told about an ATTACH but not about a VACUUM, so all three are
 * refused here by their first keyword, the only place each can stand.
 */
function refuseOutsideTheFile(text: string): string | null {
  const first = trimStatement(text).replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)+/g, '');
  const verb = /^(attach|detach|vacuum)\b/i.exec(first)?.[1];
  if (!verb) return null;
  return `${verb.toUpperCase()} reaches past this database file, so a read-only connection refuses it.`;
}

function valueSafe(v: unknown): unknown {
  if (typeof v === 'bigint') {
    return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString();
  }
  if (v instanceof Uint8Array) return `<${v.byteLength} bytes>`;
  return v;
}

/** As toJsonSafe, but a blob stays its bytes: a file download asked for them (`QueryRequest.binary`). */
export function withBytes(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Uint8Array ? value : valueSafe(value)]));
}

export function toJsonSafe(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = valueSafe(v);
  return out;
}
