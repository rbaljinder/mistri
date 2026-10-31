/**
 * Postgres adapter, on `pg`: connecting, querying, transactions and writes.
 *
 * Describing a database is the one job this file does not do itself. The
 * catalog queries and their reading live in `postgresCatalog.ts`, which holds
 * the ordering that makes two reads of one database agree; `describe` below is
 * the seam, and it is called on whichever handle is asking — the reader on
 * connect, or the leased writer inside a scoped transaction.
 */
import { isProxy } from 'node:util/types';
import {
  POSTGRES_STYLE,
  buildWhere,
  type Adapter,
  type Filter,
  type QueryRequest,
  type QueryResult,
  type ScopedReads,
  clampLimit,
  boundStatement,
  dedupe,
  looksWrappable,
  refuseStacked,
  trimStatement,
  type SqlRequest,
  type SqlResult,
  type SqlFragment,
  clampOffset,
  type ViewResult,
  type BreakdownResult,
  type ExplainRequest,
  type ExplainResult,
  type ColumnProfile,
  type ProfileResult,
  Refusal,
  WriteConflict,
  TransactionOperations,
  queueRecordLock,
  recordLockFilter,
  TransactionOutcomeUnknown,
  type WriteTransaction,
  type DeleteRequest,
  type DeleteResult,
  type InsertRequest,
  type InsertResult,
  type TellRequest,
  type UpdateRequest,
  type UpdateResult,
  refuseAnalyze,
  countStatement,
  countEachStatement,
  countEachRows,
  countsTogether,
  orderClause,
  type CountItem,
  type RolePrivileges,
  type SqlStyle,
} from './adapter.js';
import { coerceForColumn } from '../shared/schema.js';
import { buildUpdateGuard } from './scoped/updateGuard.js';
import { createScopedTransaction, wholeWithin } from './scoped/scopedTransaction.js';
import { readPostgresScopeCatalog, type PostgresScopeCatalog } from './scoped/postgresScopeCatalog.js';
import { captureScopeCatalog, mapScopeCatalog } from '../shared/scopeCatalog.js';
import { createPinnedPostgresReadOwner, type PinnedPostgresReadOwner, type PostgresReadDependency } from './postgresReadCatalog.js';
import { isRuntimeRelation, qualified, redact, valueSafe, withBytes, toJsonSafe } from './postgresValues.js';
import { beginWriteCapture, capturesWrites, committedWriteCapture, finishWriteCapture } from './writeCapture.js';
import {
  lendStoreHost,
  type JournalRun,
  type JournalTransactionOptions,
  type PostgresTransactionJournal,
  type StoreMeta,
} from './storeHost.js';
import type { DatabaseSchema, TableMeta } from '../shared/schema.js';
import { compileView, compileViewCount, type ViewDef } from '../shared/view.js';
import { compileBreakdown, compileBreakdownCount, type BreakdownDef } from '../shared/breakdown.js';
import { PgConnectionManager, sharedPgConnections, type PgConnectionOptions, type PgQuery, type SharedPoolShape } from './postgresPool.js';
import {
  aheadReport,
  behindWrite,
  generationOf,
  holdAhead,
  redoWithoutAhead,
  sendAhead,
  sendsAhead,
  waitsAhead,
  RolledBackAtCommit,
  transactionHandle,
  attestedOn,
  keepAttestedOn,
  forgetAttestations,
  noteCatalogVersion,
  readsCatalogVersion,
  suspectsStores,
  type AheadReport,
  type PipelinedStatement,
} from './postgresTransactionHandle.js';
import { withoutWriteAhead, writeAhead, type WriteAhead } from './writeAhead.js';
import { KeyRows } from './scoped/keyRows.js';
import type { PoolRoleStats } from './poolMetrics.js';
import { postgresRowEstimate } from './postgresCatalogRows.js';
import {
  describePostgresCatalog,
  postgresScopeStyle,
  SYSTEM_SCHEMAS,
  postgresColumnsOf,
  assertPostgresTable,
  type Located,
  type PgColumnRow,
} from './postgresCatalog.js';
import { postgresCatalogDigestOf, postgresCatalogDigestStatement } from './postgresCatalogDigest.js';
import { epochlessEpoch, SCHEMA_EPOCH_TABLE, schemaEpochOf, schemaEpochStatement, schemaMoved } from './postgresSchemaEpoch.js';
import { EpochCache } from './epochCache.js';
import { keepDatesAsText } from './postgresDates.js';
import { captureRowScope, snapshotRowScope, type RowScope } from '../shared/rowScope.js';
import { createScopedReads } from './scoped/scopedReads.js';
import { scopedCommandInvoker } from './scoped/scopedCommandOperations.js';
import { postgresPrivileges } from './rolePrivileges.js';
import { RESERVED_SCHEMAS, refusePostgresReserved, refuseReservedPlan, refuseReservedText } from './reservedSql.js';
import { statementCap } from './statementControl.js';
import { WriteLanes, keyedLane } from './writeLanes.js';
import { primaryReads } from './replicas.js';
import { readSnapshotOn, type PostgresReadSnapshot } from './postgresReadSnapshot.js';

const pinnedReaders = new WeakMap<object, PgConnectionManager>();
/** Constructor-issued source identity, checked without reading receiver data. */
export const isPostgresVerifiedCommandSource = (value: unknown): value is PostgresAdapter =>
  !!value && typeof value === 'object' && !isProxy(value) && pinnedReaders.has(value);

export type { PostgresReadSnapshot } from './postgresReadSnapshot.js';

const SCOPED_CATALOG_DIGEST = postgresCatalogDigestStatement(SYSTEM_SCHEMAS);

/* Every adapter of one database in this process describes the same catalog, and a tenant App's start made a dozen
   of them, each describing it afresh in a snapshot of its own: startup's two checks, its trial enrollment and the
   host's, each read source, the first scoped transaction, every platform source twice — sixteen descriptions of
   two databases, six round trips each, before the port opened. A description is kept here under the exact version
   it was read at — the catalog digest read in its own snapshot, or the schema epoch — and any adapter of the same
   database and schemas that reads the same version is handed a copy: the same version is the same catalog rows
   (postgresCatalogDigest.ts), so nothing is trusted that a fresh description would not have said. A time-filed
   version (epochlessEpoch) is never shared: it stands only for the adapter that took the risk.

   A write reads its version, then describes, each statement seeing what had committed when it ran (READ COMMITTED):
   it reads the version again and files the description only if that has not moved, so nothing is kept under a
   version its description never saw. A snapshot describes the catalog its digest was read in, and files at once.

   Two things a description carries move without the version: comments, and the planner's row estimates
   (`approxRows`, which ANALYZE and autovacuum change, and which decide whether a large table's count is estimated,
   resourceReadOperations.ts). A kept description is therefore served for a few minutes only, after which the next
   reader describes again: a table that grew is counted as large a few minutes later rather than never, and a start,
   whose readers come within seconds, still describes each catalog once. */
const sharedDescriptions = new EpochCache<Readonly<{ schema: DatabaseSchema; at: number }>>(32);
const SHARED_DESCRIPTION_MS = 5 * 60_000;
let descriptionsRead = 0,
  descriptionsKept = 0;

/** For the budget tests: how many times this process described a PostgreSQL catalog, and how many were found kept. */
export function postgresDescriptionCounts(): Readonly<{ described: number; kept: number }> {
  return { described: descriptionsRead, kept: descriptionsKept };
}

/**
 * An adapter on the manager every adapter of `url` with this `shape` shares (sharedPgConnections): its own catalog,
 * lanes and stores, the pools of its neighbors. Closing it lets its share go; the pools close with the last one.
 */
export function sharedPostgresAdapter(url: string, label: string, shape: SharedPoolShape = {}): PostgresAdapter {
  return new PostgresAdapter(url, label, [], sharedPgConnections(url, shape, keepDatesAsText));
}

export class PostgresAdapter implements Adapter {
  readonly dialect = 'postgres' as const;
  private connections: PgConnectionManager;
  /* The order writes run in (writeLanes.ts): one at a time for the database
     browser, by record for an App, each on a writer of its own. Raw SQL
     waits for everything before it, in either. */
  private writes = new WriteLanes();
  /* What a description is shared under (sharedDescriptions): the database, and the schemas this adapter describes. */
  private readonly describes: string;
  /* The database alone: what a store attestation is shared under (noteCatalogVersion), whatever schemas are described. */
  private readonly database: string;
  /* What a write transaction asks the catalog — the journal's layout, the
     scope catalog, a relation's kind, its columns and key — kept under the
     schema epoch the transaction read in the message that began it
     (openWrite, postgresSchemaEpoch.ts). A warm command asks nothing. */
  private readonly catalogCache = new EpochCache<unknown>();
  /** The epoch each open write transaction read, by the handle it runs on. */
  private readonly txEpochs = new WeakMap<object, string>();
  /* Whether the database holds the epoch store: learned from the first
     write transaction; absent, every transaction reads the digest as before. */
  private epochStore: boolean | undefined;

  /** `work`, forgetting the kept catalog if it dies on a table or column that is gone: what was kept is wrong. */
  private watched<T>(work: Promise<T>): Promise<T> {
    return work.catch((error) => {
      if (schemaMoved(error)) {
        this.catalogCache.clear();
        sharedDescriptions.forget(this.describes);
      }
      throw error;
    });
  }

  constructor(
    connectionString: string,
    private label = redact(connectionString),
    /** Restrict to these schemas. Empty means every non-system schema. */
    private schemas: string[] = [],
    connections?: PgConnectionManager,
    /** The reader count the connection's config names; the process defaults fill the rest. */
    pool?: PgConnectionOptions,
  ) {
    this.connections = connections ?? new PgConnectionManager(connectionString, keepDatesAsText, undefined, pool);
    this.describes = `${connectionString}\0${schemas.join('\0')}`;
    this.database = connectionString;
    readsCatalogVersion(this, connectionString, async (db) => `digest:${postgresCatalogDigestOf(await db.query(SCOPED_CATALOG_DIGEST))}`);
    if (this.connections instanceof PgConnectionManager) pinnedReaders.set(this, this.connections);
    /* The App stores this database may hold read and write through these (stores/appStores.ts). */
    lendStoreHost(this, {
      dialect: 'postgres',
      withReadClient: (work) => this.connections.withReadClient(work),
      withWriteClient: (work) => this.connections.withWriteClient(work),
      attestedStore: (client, store, read) => this.attestedStore(client, store, read),
      verifiedSource: () => this.verifiedSource(),
      journalTransaction: (journal, run, options) => this.journalTransaction(journal, run, options),
      readSnapshot: (run) => this.readSnapshot(run, true),
      onHealthyReplicas: (work) => this.connections.onHealthyReplicas(work),
    });
  }

  /* Constructor-issued, over the connections it was built with: what a verified transaction is allowed to run on. */
  private verifiedSource(): boolean {
    return isPostgresVerifiedCommandSource(this) && pinnedReaders.get(this) === this.connections;
  }

  /** The pools' meters, for the operator surface. */
  poolStats(): readonly PoolRoleStats[] {
    return this.connections.stats();
  }

  /** Each replica's state, when the connection names any (replicas.ts). */
  replicaHealth(): ReturnType<PgConnectionManager['replicaHealth']> {
    return this.connections.replicaHealth();
  }

  private conn(): Promise<PgQuery> {
    return this.connections.read();
  }

  /**
   * Run a statement the user wrote.
   *
   * The session already carries `default_transaction_read_only = on`, and for
   * everything else in this adapter that is enough, because every statement is
   * one this file built. It is **not** enough here: `SET
   * default_transaction_read_only = off` is itself a statement, and a user who
   * typed it followed by a `DELETE` would get both.
   *
   * `BEGIN READ ONLY` is the version that holds. A transaction opened read-only
   * cannot be promoted from inside it — Postgres refuses `SET TRANSACTION READ
   * WRITE` once the transaction has begun — so the guarantee stops depending on
   * what the statement does or does not contain. The `ROLLBACK` afterwards also
   * discards any session state the statement set, so one run cannot change what
   * the next one means.
   *
   * The rollback runs in a `finally`: a statement that errors has still opened
   * a transaction, and leaving it open would leave the connection in an aborted
   * state where every later query fails with "current transaction is aborted".
   *
   * `write: true` is the other half, and it is a different request rather than
   * a relaxation of this one: a separate handle, no READ ONLY transaction, and
   * a decision made further up about whether this connection may write at all.
   * The two paths share the statement text and nothing else.
   */
  async runSql(request: SqlRequest): Promise<SqlResult> {
    const stacked = refuseStacked(request.text);
    if (stacked) throw new Error(stacked);
    if (request.refuseReserved) refusePostgresReserved(request.text, request.write);
    const limit = clampLimit(request.limit);
    /* A write is never wrapped in a bounding subquery: `UPDATE … RETURNING`
       inside `SELECT * FROM (…)` is a different statement, and one Postgres
       refuses outright. The caller asked for this text; it runs as typed. */
    const bounded = !request.write && looksWrappable(request.text);
    const text = bounded ? boundStatement(request.text, limit) : trimStatement(request.text);

    if (request.write) {
      /* On the write handle, and outside the READ ONLY transaction every other
         statement here gets — which is the whole difference. Whether this is
         allowed at all was decided before the request arrived: the connection
         has to be marked writable in the config, and that check does not live
         in the adapter.

         No wrapper transaction of our own. One statement is already atomic in
         Postgres, and a BEGIN/COMMIT around it would only add a way to leave a
         transaction open on a connection that outlives the request. */
      return this.writes.run('all', () =>
        this.connections.withWriteClient(async (write) => {
          const started = performance.now();
          const result = await write.query(text, []);
          return {
            /* A write that returns rows — `RETURNING` — is worth showing, and one
             that does not returns an empty grid rather than a fabricated one. */
            columns: dedupe(result.fields?.map((f) => f.name) ?? []),
            rows: (result.rows ?? []).map((row) => Object.values(toJsonSafe(row)).map(valueSafe)),
            ms: Math.round(performance.now() - started),
            truncated: false,
            bounded: false,
            affected: Number(result.rowCount ?? 0),
            sql: { text, params: [] },
          };
        }, true),
      );
    }

    return this.connections.withReadClient(async (db) => {
      const started = performance.now();
      /* The statement's cap, set where it dies with the transaction, so the
         session's own is untouched — and statementCap's floor stops a caller
         asking for a timeout so low that even the fast path loses races to it. */
      const cap = statementCap(request.timeoutMs);
      const begin = () => db.query('BEGIN READ ONLY').then(() => db.query(`SET LOCAL statement_timeout = ${cap}`));
      await begin();
      try {
        if (request.refuseReserved) await refuseReservedPlan(db, request.text, []);
        /* `rowMode: 'array'` so two output columns of the same name keep both
           values; the default object rows would let the second overwrite the
           first. `values: []` keeps this on the extended protocol, which carries
           exactly one statement — a second line of defence behind the stacking
           check above. */
        let wrapped = bounded;
        const result = await db.query({ text, values: [], rowMode: 'array' }).catch(async (err: Error) => {
          /* The wrap is an optimisation that is allowed to fail — not every
               legal statement survives being made a derived table. Run as
               written and reported as unbounded. The transaction has to be
               restarted: a failed statement aborts it, and every later query in
               it would fail with "current transaction is aborted". A statement
               that was stopped — cancelled, or past its cap (57014) — is not a
               wrap that failed, and running it again would spend the cap twice. */
          if (!bounded || (err as { code?: string }).code === '57014') throw err;
          wrapped = false;
          await db.query('ROLLBACK');
          await begin();
          return db.query({ text: trimStatement(request.text), values: [], rowMode: 'array' });
        });
        const truncated = result.rows.length > limit;
        return {
          columns: dedupe(result.fields.map((f) => f.name)),
          rows: (truncated ? result.rows.slice(0, limit) : result.rows).map((row) => row.map(valueSafe)),
          ms: Math.round(performance.now() - started),
          truncated,
          bounded: wrapped,
          sql: { text: wrapped ? text : trimStatement(request.text), params: [] },
        };
      } finally {
        await db.query('ROLLBACK').catch(() => {
          /* The connection is already unusable if this fails; the original error
             is the one worth reporting. */
        });
      }
    }, true);
  }

  /**
   * EXPLAIN, plain — never the analysing variant that executes to time.
   *
   * `runSql`'s bounding wrap is precisely wrong here: a statement made a
   * derived table is a different statement, with a different plan. The text
   * goes to the planner as written, inside the same READ ONLY transaction
   * every user statement gets — so even a smuggled write is only ever
   * planned, and an execution attempt is the transaction's to refuse, not a
   * string check's.
   */
  async explainSql(request: ExplainRequest): Promise<ExplainResult> {
    const stacked = refuseStacked(request.text);
    if (stacked) throw new Error(stacked);
    const analyze = refuseAnalyze(request.text);
    if (analyze) throw new Error(analyze);
    if (request.refuseReserved) refuseReservedText(request.text, 'postgres');
    return this.connections.withReadClient(async (db) => {
      const started = performance.now();
      await db.query('BEGIN READ ONLY');
      try {
        /* Planning runs nothing, but planning a wide join still takes time. */
        await db.query(`SET LOCAL statement_timeout = ${statementCap()}`);
        if (request.refuseReserved) await refuseReservedPlan(db, request.text, (request.params ?? []) as unknown[]);
        const result = await db.query({
          text: `EXPLAIN ${trimStatement(request.text)}`,
          values: (request.params ?? []) as unknown[],
          rowMode: 'array',
        });
        return {
          plan: result.rows.map((r) => String(r[0])),
          ms: Math.round(performance.now() - started),
        };
      } finally {
        await db.query('ROLLBACK').catch(() => {});
      }
    }, true);
  }

  /**
   * The planner's own statistics, read rather than computed.
   *
   * `pg_stats` already holds the null share, the distinct estimate, the most
   * common values with their frequencies, and the histogram — ANALYZE paid
   * for them, reading them touches no user table. The numbers are
   * sample-based and stale until the next ANALYZE, which is what
   * `source: 'statistics'` tells the caller; a column ANALYZE has never
   * visited simply has no numbers, which beats invented ones.
   */
  async profile(table: string): Promise<ProfileResult> {
    const { schema, name } = await this.readTable(table);
    const db = await this.conn();
    const started = performance.now();

    const rel = await db.query(
      `SELECT CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples END AS approx_rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, name],
    );
    const approx = rel.rows[0]?.approx_rows;
    const rows = postgresRowEstimate(approx);

    /* Every live column, with its stats row where ANALYZE has made one.
       `most_common_vals` and `histogram_bounds` are `anyarray`, which the
       driver has no parser for; the ::text::text[] two-step turns them into
       the text array it can parse. */
    const stats = await db.query(
      `SELECT a.attname::text AS column,
              format_type(a.atttypid, a.atttypmod) AS type,
              s.null_frac,
              s.n_distinct,
              s.most_common_vals::text::text[] AS common_values,
              s.most_common_freqs AS common_freqs,
              s.histogram_bounds::text::text[] AS bounds
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_stats s ON s.schemaname = n.nspname AND s.tablename = c.relname AND s.attname = a.attname
        WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum`,
      [schema, name],
    );

    const columns: ColumnProfile[] = (
      stats.rows as Array<{
        column: string;
        type: string;
        null_frac: number | null;
        n_distinct: number | null;
        common_values: string[] | null;
        common_freqs: number[] | null;
        bounds: string[] | null;
      }>
    ).map((r) => {
      /* Negative n_distinct is a ratio — "-0.3 of the rows are distinct" —
         which only converts when a row estimate exists to multiply by. */
      const distinct =
        r.n_distinct == null
          ? undefined
          : Number(r.n_distinct) >= 0
            ? Math.round(Number(r.n_distinct))
            : rows === undefined
              ? undefined
              : Math.round(-Number(r.n_distinct) * rows);
      const common =
        r.common_values?.length && r.common_freqs?.length
          ? r.common_values.map((v, i) => ({ value: v, frac: Number(r.common_freqs?.[i] ?? 0) }))
          : undefined;
      return {
        column: r.column,
        type: r.type,
        nullFrac: r.null_frac == null ? undefined : Number(r.null_frac),
        distinct,
        /* The histogram's outer edges, as text from the sample. A column too
           uniform to earn a histogram gets no min/max — its common values
           sorted lexically would call 9 larger than 10. */
        min: r.bounds?.length ? r.bounds[0] : undefined,
        max: r.bounds?.length ? r.bounds[r.bounds.length - 1] : undefined,
        common,
      };
    });

    return { table, rows, columns, source: 'statistics', ms: Math.round(performance.now() - started) };
  }

  /* The catalog is the primary's, whatever route asks for it first: a
     replica a migration has not reached yet would describe the old one, and
     every read after compiles against this copy. */
  introspect(): Promise<DatabaseSchema> {
    return primaryReads(() => this.introspectNow());
  }

  private async introspectNow(): Promise<DatabaseSchema> {
    const db = await this.conn();
    const schema = await this.describe(db);
    /* The server's version, read with the catalog it goes with, so a row
       scope compiles for it (scopeReads) without a statement of its own. */
    this.scopeStyleRead = postgresScopeStyle(db).catch(() => POSTGRES_STYLE);
    await this.scopeStyleRead;
    /* Seeded, not only returned: the registry introspects on connect, and the
       view, breakdown and read paths resolve against this copy. Without it the
       first of them described the whole catalog again. */
    this.cachedSchema = schema;
    return schema;
  }

  private scopeStyleRead?: Promise<SqlStyle>;

  /**
   * The style a row-scoped read compiles with on this server: its CTEs
   * inlined from Postgres 12 on (POSTGRES_INLINE_STYLE). Asked once per
   * adapter; a failed ask is not remembered, and that read compiles as
   * before — the hint is a plan, never a rule about rows.
   */
  scopeStyle(): Promise<SqlStyle> {
    this.scopeStyleRead ??= primaryReads(() => this.conn().then(postgresScopeStyle)).catch(() => {
      this.scopeStyleRead = undefined;
      return POSTGRES_STYLE;
    });
    return this.scopeStyleRead;
  }

  /** The role's reach, asked of the catalog on the reader (rolePrivileges.ts). */
  async privileges(): Promise<RolePrivileges> {
    return primaryReads(async () => postgresPrivileges(await this.conn(), this.schemas, SYSTEM_SCHEMAS));
  }

  /** The catalog as one handle sees it, read by postgresCatalog.ts: the
   * reader on connect, or the leased writer inside a scoped transaction,
   * where the same description is the evidence the deployed permissions are
   * attested against. */
  /* Still `async`: a caller holding this as a value gets a rejected promise
     rather than a synchronous throw, exactly as the method it replaced did. */
  private async describe(db: PgQuery): Promise<DatabaseSchema> {
    descriptionsRead++;
    return describePostgresCatalog(db, { schemas: this.schemas, label: this.label, dialect: this.dialect });
  }

  /** The catalog as `db` sees it at `version`, read there before: a copy of the one kept under it (sharedDescriptions),
   * or described now and kept. Another adapter's copy carries this one's label. */
  private async describedAt(version: string, db: PgQuery, reread?: () => Promise<string | undefined>): Promise<DatabaseSchema> {
    const shared = !version.startsWith('ttl:');
    const found = shared ? sharedDescriptions.get(version, this.describes) : undefined;
    const kept =
      found && Date.now() - found.at < SHARED_DESCRIPTION_MS
        ? found.schema
        : shared
          ? undefined
          : (this.catalogCache.get(version, 'describe') as DatabaseSchema | undefined);
    if (kept) {
      if (shared) descriptionsKept++;
      return { ...structuredClone(kept), label: this.label };
    }
    const schema = await this.describe(db);
    // A write's version is read again: a description that saw DDL committed after it is not kept under it.
    if (shared) {
      if (!reread || (await reread()) === version)
        sharedDescriptions.set(version, this.describes, Object.freeze({ schema: Object.freeze(structuredClone(schema)), at: Date.now() }));
    } else this.catalogCache.set(version, 'describe', Object.freeze(structuredClone(schema)));
    return schema;
  }

  /** A snapshot's description: the digest first, in the same snapshot, then the description kept under it or a new one. */
  private async describeSnapshot(db: PgQuery, committed = false): Promise<DatabaseSchema> {
    const version = `digest:${postgresCatalogDigestOf(await db.query(SCOPED_CATALOG_DIGEST))}`;
    const reread = committed ? this.rereadOf(db, version) : undefined;
    return this.describedAt(this.versionRead(db, version, reread), db, reread);
  }

  /** `version`, the exact one `db`'s transaction just read, said for what it attests next (noteCatalogVersion); a time-filed one is not said. */
  private versionRead(db: PgQuery, version: string, reread?: () => Promise<string | undefined>): string {
    if (!version.startsWith('ttl:')) noteCatalogVersion(db, this.database, version, reread);
    return version;
  }

  /** How a write (READ COMMITTED) reads `version` again, the digest or the epoch as it read it; a time-filed one is not read. */
  private rereadOf(db: PgQuery, version: string): (() => Promise<string | undefined>) | undefined {
    if (version.startsWith('ttl:')) return undefined;
    if (version.startsWith('digest:')) return async () => `digest:${postgresCatalogDigestOf(await db.query(SCOPED_CATALOG_DIGEST))}`;
    return async () => schemaEpochOf(await db.query(schemaEpochStatement()));
  }

  /**
   * The catalog as a scoped transaction's writer sees it, described again
   * only when it has moved. Every transaction reads the catalog digest
   * (postgresCatalogDigest.ts) — one statement where a description is six —
   * and reuses a description read just after the same digest was, by this
   * adapter or another of the same database (sharedDescriptions). Read
   * before, never after: DDL committing
   * between the two then leaves a digest no later read can match, so the
   * description is taken again rather than trusted on a digest it postdates.
   * The digest covers every schema but the system's, a superset of what
   * this adapter describes, and moves with privileges and roles too. What it
   * does not see, comments and the planner's row estimates, is display and
   * never authority.
   */
  private async describeScoped(db: PgQuery): Promise<DatabaseSchema> {
    // Under an epoch this transaction read, a description kept under it, by any adapter of this database, is exact.
    const epoch = this.txEpochs.get(db);
    return epoch !== undefined ? this.describedAt(epoch, db, this.rereadOf(db, epoch)) : this.describeSnapshot(db, true);
  }

  /**
   * Begin a write transaction and read the schema epoch in the same message:
   * `BEGIN`, the LOCK a scope pinned last time under the epoch it expects,
   * and the epoch statement, in one round trip (the simple protocol carries
   * several statements when none has parameters). The LOCK comes first, so
   * DDL on a pinned table after the epoch was read has to wait for this
   * transaction; whether the lock was the right one is then decided by the
   * epoch alone. A message that fails — the store gone, a pinned table
   * dropped, a privilege revoked — is only a miss: rolled back, begun again
   * plainly, and the transaction describes what it needs as before.
   */
  private async openWrite(
    write: PgQuery,
    options: { lock?: readonly string[]; pin?: string; digest?: boolean; sent?: () => void },
    began: () => void,
  ): Promise<{ epoch?: string }> {
    // Begun again on the same handle (a scope's retry), what the last transaction read is not this one's.
    noteCatalogVersion(write, this.database, undefined);
    if (this.epochStore === false) {
      if (options.digest) return this.openWithDigest(write, options, began);
      const opening = write.query('BEGIN');
      options.sent?.();
      await opening;
      began();
      const epoch = epochlessEpoch();
      this.txEpochs.set(write, epoch);
      return { epoch };
    }
    const statement = schemaEpochStatement();
    let answered: unknown;
    try {
      const opening = write.query(
        `BEGIN;${options.lock?.length ? ` LOCK TABLE ${options.lock.join(', ')} IN ROW EXCLUSIVE MODE;` : ''}${options.pin ? ` ${options.pin};` : ''} ${statement}`,
      );
      // Behind it, in the same flight: what the transaction opens with (sendWriteAhead).
      options.sent?.();
      answered = await opening;
    } catch (error) {
      const failure = error as { code?: unknown; message?: unknown };
      if ((failure.code === '42P01' || failure.code === '42501') && String(failure.message).includes(SCHEMA_EPOCH_TABLE))
        this.epochStore = false;
      try {
        await write.query('ROLLBACK');
      } catch {
        /* The BEGIN below says whether this client can go on. */
      }
      if (this.epochStore === false && options.digest) return this.openWithDigest(write, options, began);
      await write.query('BEGIN');
      began();
      return {};
    }
    began();
    this.epochStore = true;
    const results = (Array.isArray(answered) ? answered : [answered]) as Array<{ rows: Record<string, unknown>[] }>;
    const last = results.at(-1);
    const epoch = schemaEpochOf(last);
    if (epoch !== undefined) this.txEpochs.set(write, this.versionRead(write, epoch, this.rereadOf(write, epoch)));
    // The store is there but not whole (its trigger disabled): the digest stands in, read after the LOCK above.
    else if (options.digest) {
      const read = `digest:${postgresCatalogDigestOf(await write.query(SCOPED_CATALOG_DIGEST))}`;
      const digest = this.versionRead(write, read, this.rereadOf(write, read));
      this.txEpochs.set(write, digest);
      return { epoch: digest };
    }
    return { epoch };
  }

  /**
   * Without the epoch store, a scoped transaction reads the catalog digest
   * (postgresCatalogDigest.ts) — it always did, to describe the scope — and
   * the digest is then its epoch: one statement that moves with every catalog
   * row the scope, a relation's kind and columns, and the journal's layout
   * depend on, role membership, and (for a command) the journal's meta row.
   * Read in the message that begins the transaction, after the LOCK the scope
   * pinned last time, as the epoch is. Slower than the epoch store's one row,
   * never less exact; a message that fails begins again the long way.
   */
  private async openWithDigest(
    write: PgQuery,
    options: { lock?: readonly string[]; pin?: string; sent?: () => void },
    began: () => void,
  ): Promise<{ epoch?: string }> {
    let answered: unknown;
    try {
      const opening = write.query(
        `BEGIN;${options.lock?.length ? ` LOCK TABLE ${options.lock.join(', ')} IN ROW EXCLUSIVE MODE;` : ''}${options.pin ? ` ${options.pin};` : ''} ${SCOPED_CATALOG_DIGEST}`,
      );
      options.sent?.();
      answered = await opening;
    } catch {
      try {
        await write.query('ROLLBACK');
      } catch {
        /* The BEGIN below says whether this client can go on. */
      }
      await write.query('BEGIN');
      began();
      return {};
    }
    began();
    const results = (Array.isArray(answered) ? answered : [answered]) as Array<{ rows: Record<string, unknown>[] }>;
    const read = `digest:${postgresCatalogDigestOf(results.at(-1))}`;
    const epoch = this.versionRead(write, read, this.rereadOf(write, read));
    this.txEpochs.set(write, epoch);
    return { epoch };
  }

  /**
   * A reserved store's layout, attested the first time this adapter reads it
   * and not again (attestOnce, postgresTransactionHandle.ts): told whether it
   * stands attested. A read that fails the way a moved catalog fails one
   * forgets it, and the next read attests in full.
   */
  private async attestedStore<T>(client: PgQuery, store: StoreMeta, read: (attested: boolean) => Promise<T>): Promise<T> {
    const key = `store:${store.name}`,
      attested = attestedOn(this, key);
    try {
      const result = await read(attested);
      if (!attested) keepAttestedOn(this, key);
      return result;
    } catch (error) {
      if (suspectsStores(error)) forgetAttestations(this, client);
      throw error;
    }
  }

  /** A journal's layout and meta row, attested the first time this adapter opens a transaction with it (a journal
      that names no meta row, in every transaction). */
  private async attestJournal(write: PgQuery, journal: PostgresTransactionJournal<unknown>): Promise<void> {
    if (!journal.meta) return void (await journal.attest(write));
    const key = `journal:${journal.meta.name}`;
    if (attestedOn(this, key)) return;
    await journal.attest(write);
    keepAttestedOn(this, key);
  }

  async query(request: QueryRequest): Promise<QueryResult> {
    return this.queryOn(request, await this.conn(), true);
  }

  async scopeReads(input: RowScope): Promise<ScopedReads> {
    // Capture before metadata I/O: callers cannot change an in-flight policy.
    const scope = captureRowScope(input);
    const schema = await this.schema();
    /* Inlined only where the catalog read at connect said the server can;
       otherwise as before. Never a statement here: a scoped read's I/O is
       its own reads (tenant sources ask scopeStyle() once, at construction). */
    const style = this.scopeStyleRead ? await this.scopeStyleRead : POSTGRES_STYLE;
    return createScopedReads(schema, scope, style, async (compiled, hint) => {
      // Resolve the reader per operation so capabilities cannot bypass shutdown.
      const db = await this.conn();
      const started = performance.now();
      const result = await db.query(compiled.text, compiled.params);
      return {
        columns: result.fields.map((field) => field.name),
        rows: result.rows.map(hint?.binary ? withBytes : toJsonSafe),
        ms: Math.round(performance.now() - started),
        sql: { text: compiled.text, params: compiled.params },
      };
    });
  }

  private async queryOn(request: QueryRequest, db: PgQuery, read = false): Promise<QueryResult> {
    const { schema, name } = read ? await this.readTable(request.table) : await this.assertTable(request.table, db);
    const qualified = `${POSTGRES_STYLE.quote(schema)}.${POSTGRES_STYLE.quote(name)}`;
    const where = buildWhere(request.filter, POSTGRES_STYLE);
    const cols = request.columns?.length ? request.columns.map((c) => POSTGRES_STYLE.quote(c)).join(', ') : '*';
    const order = orderClause(
      request.orderBy,
      request.orderBy?.length ? (await this.schema()).tables.find((t) => t.id === request.table) : undefined,
      POSTGRES_STYLE,
      where.params.length + 1,
    );
    /* Every read is bounded. There is no code path that reaches the database
       without a LIMIT, including one that forgot to ask for one. */
    const limit = clampLimit(request.limit);
    /* LIMIT and OFFSET continue the placeholder numbering the WHERE clause
       started, which is the one thing Postgres needs that SQLite does not. */
    const n = where.params.length + order.params.length;
    const text = `SELECT ${cols} FROM ${qualified}${where.text}${order.text} LIMIT $${n + 1} OFFSET $${n + 2}`;
    const params = [...where.params, ...order.params, limit, clampOffset(request.offset)];

    const started = performance.now();
    const result = await db.query(text, params);
    const ms = Math.round(performance.now() - started);

    return {
      // Taking columns from `fields` rather than the first row means an empty
      // result still renders its headers instead of collapsing to nothing.
      columns: result.fields.map((f) => f.name),
      rows: result.rows.map(request.binary ? withBytes : toJsonSafe),
      ms,
      sql: { text, params },
    };
  }

  /**
   * Run a compiled view.
   *
   * Note what is *not* here: any check that the tables named in the view
   * exist. `compileView` resolves the base table and every hop against the
   * introspected catalog and refuses anything it cannot find, so the only
   * identifiers that reach the quoting step are ones the catalog produced.
   * The user's contribution — the values — never leaves the parameter array.
   *
   * The dialect difference this exercises is placeholder numbering:
   * `POSTGRES_STYLE` counts $1..$n across the whole statement, and the joins
   * sitting between the SELECT list and the WHERE clause are exactly what
   * makes an off-by-one here easy and invisible.
   */
  async runView(view: ViewDef, offset = 0): Promise<ViewResult> {
    const db = await this.conn();
    const schema = await this.schema();
    const compiled = compileView(schema, view, POSTGRES_STYLE, offset);

    const started = performance.now();
    const result = await db.query(compiled.text, compiled.params);
    const ms = Math.round(performance.now() - started);

    return {
      columns: compiled.columns.map((c) => c.name),
      rows: result.rows.map(toJsonSafe),
      ms,
      sql: { text: compiled.text, params: compiled.params },
      resolved: compiled.columns,
      joins: compiled.joins,
    };
  }

  async runBreakdown(breakdown: BreakdownDef, offset = 0): Promise<BreakdownResult> {
    const db = await this.conn();
    const compiled = compileBreakdown(await this.schema(), breakdown, POSTGRES_STYLE, offset);

    const started = performance.now();
    const result = await db.query(compiled.text, compiled.params);
    return {
      columns: compiled.columns.map((c) => c.name),
      rows: result.rows.map(toJsonSafe),
      ms: Math.round(performance.now() - started),
      sql: { text: compiled.text, params: compiled.params },
      resolved: compiled.columns,
    };
  }

  async countBreakdown(breakdown: BreakdownDef, limit?: number): Promise<number> {
    const db = await this.conn();
    const compiled = compileBreakdownCount(await this.schema(), breakdown, POSTGRES_STYLE, undefined, limit);
    const result = await db.query(compiled.text, compiled.params);
    return Number((result.rows[0] as { n?: string })?.n ?? 0);
  }

  async countView(view: ViewDef, limit?: number): Promise<number> {
    const db = await this.conn();
    const compiled = compileViewCount(await this.schema(), view, POSTGRES_STYLE, undefined, limit);
    const result = await db.query(compiled.text, compiled.params);
    return Number((result.rows[0] as { n?: string })?.n ?? 0);
  }

  /* Introspection here is three catalog queries; a view preview runs on every
     keystroke. Caching it is the difference between a live preview and a
     stutter. The registry refreshes by discarding the adapter, so a stale
     cache cannot outlive an explicit reload. */
  private cachedSchema: DatabaseSchema | null = null;

  private async schema(): Promise<DatabaseSchema> {
    if (!this.cachedSchema) this.cachedSchema = await this.introspect();
    return this.cachedSchema;
  }

  /**
   * The planner's row estimate, straight from `pg_class`.
   *
   * `reltuples` is what the planner itself uses to decide how to run a query,
   * so it is the number Postgres is already trusting. It is -1 on a table that
   * has never been analysed, which is a "do not know" rather than a zero —
   * returning undefined there gets an exact count instead of confidently
   * reporting an empty table that is not empty.
   */
  async estimateCount(table: string): Promise<number | undefined> {
    const db = await this.conn();
    const { schema, name } = await this.readTable(table);
    const result = await db.query(
      `SELECT c.reltuples AS n
         FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = $1 AND c.relname = $2`,
      [schema, name],
    );
    return postgresRowEstimate((result.rows[0] as { n?: unknown } | undefined)?.n);
  }

  async count(table: string, filter?: Filter, limit?: number): Promise<number> {
    return this.countOn(table, filter, await this.conn(), limit, true);
  }

  async countEach(items: readonly CountItem[], limit?: number): Promise<number[]> {
    const relations = await Promise.all(
      items.map(async (item) => {
        const { schema, name } = await this.readTable(item.table);
        return { relation: `${POSTGRES_STYLE.quote(schema)}.${POSTGRES_STYLE.quote(name)}`, filter: item.filter };
      }),
    );
    const statement = countEachStatement(relations, POSTGRES_STYLE, { limit, together: countsTogether(this.cachedSchema, items, limit) });
    const result = await (await this.conn()).query(statement.text, statement.params);
    return countEachRows(result.rows as Array<Record<string, unknown>>, items.length);
  }

  private async countOn(table: string, filter: Filter | undefined, db: PgQuery, limit?: number, read = false): Promise<number> {
    const { schema, name } = read ? await this.readTable(table) : await this.assertTable(table, db);
    const where = buildWhere(filter, POSTGRES_STYLE);
    const text = countStatement(`${POSTGRES_STYLE.quote(schema)}.${POSTGRES_STYLE.quote(name)}${where.text}`, limit);
    const result = await db.query(text, where.params);
    return Number((result.rows[0] as { n?: string })?.n ?? 0);
  }

  private async columnsOf(schema: string, name: string, db?: PgQuery): Promise<PgColumnRow[]> {
    return postgresColumnsOf(schema, name, db, this.epochOf(db), this.catalogCache, () => this.conn());
  }

  /**
   * Update one row, having proved it is one row.
   *
   * The pre-flight count runs on the *read* handle, so the check that decides
   * whether to write cannot itself write. A key that matches anything other
   * than exactly one row stops here rather than at the UPDATE — the danger in
   * a cell editor was never injection, it is a WHERE broader than its author
   * believed.
   */
  async update(request: UpdateRequest): Promise<UpdateResult> {
    // A table that keeps a history is written with its row, or not at all.
    const lane = keyedLane(request);
    if (this.recordsHistory(request)) return this.transact(lane, (tx) => tx.update(request));
    return this.watched(this.writes.run(lane, () => this.connections.withWriteClient((write) => this.updateNow(request, write))));
  }

  private async updateNow(request: UpdateRequest, write: PgQuery, read?: PgQuery): Promise<UpdateResult> {
    const transactional = read !== undefined;
    read ??= await this.conn();
    const found = await this.assertTable(request.table, read);
    const id = `${found.schema}.${found.name}`;
    /* Postgres updates through a simple view, and the update lands on the
       table underneath. Refused: what the editor showed and what changed are
       then two different objects. */
    if (found.isView) throw new Refusal(`${id} is a view, so no single row can be identified.`);

    const meta = await this.columnsOf(found.schema, found.name, read);
    const pk = meta.filter((c) => c.is_pk).map((c) => c.name);
    if (!pk.length) throw new Refusal(`${id} has no primary key, so no single row can be identified.`);

    const keyColumns = Object.keys(request.key);
    /* The key must be the whole primary key and nothing else. A partial key
       would let a two-column key match a whole group of rows, and extra
       columns would let the caller widen the match. */
    const same = keyColumns.length === pk.length && pk.every((c) => keyColumns.includes(c));
    if (!same) throw new Refusal(`Updating ${id} needs exactly its primary key (${pk.join(', ')}).`);

    const entries = Object.entries(request.values ?? {});
    if (!entries.length) throw new Refusal('Nothing to update.');

    const applied: Record<string, string | number | boolean | null> = {};
    for (const [column, raw] of entries) {
      const declared = meta.find((c) => c.name === column);
      if (!declared) throw new Refusal(`${id} has no column called "${column}".`);
      if (pk.includes(column)) {
        // Editing a key in place silently repoints every row that referenced
        // it, or fails on the constraint. Neither belongs behind an editor.
        throw new Refusal(`"${column}" is part of the primary key and cannot be edited here.`);
      }
      /* Coerced against the declared type, because everything typed into a
         text box arrives as a string — and Postgres, unlike SQLite, rejects
         "17901" for a numeric column rather than quietly taking it. */
      applied[column] = coerceForColumn(declared.type || '', raw);
      if (applied[column] === null && declared.notnull) {
        throw new Refusal(`"${column}" is NOT NULL and cannot be emptied.`);
      }
    }

    const filter: Filter = {
      groups: [pk.map((column) => ({ column, op: '=' as const, value: request.key[column] }))],
    };
    /* Outside a transaction the count runs first, on the read handle. Inside
       one the UPDATE's own row count is the check: the key is the whole
       primary key, so it matches one row or none, and a refusal rolls the
       transaction back. */
    const refuseMatches = (matches: number): never => {
      if (request.expected !== undefined && matches === 0) throw new WriteConflict();
      throw new Refusal(
        `Refused: that key matches ${matches} rows, not 1. An update is only allowed when it is certain which row it changes.`,
      );
    };
    const matches = transactional ? 1 : await this.count(id, filter);
    if (matches !== 1) refuseMatches(matches);

    /* The WHERE is built after the SET, so its placeholders continue the same
       numbering — `$1, $2` for the assignments, `$3…` for the key. Postgres
       numbers parameters rather than taking them in order, which is the one
       place this differs from the other two adapters. */
    const columns = Object.keys(applied);
    const assignments = columns.map((c, i) => `${POSTGRES_STYLE.quote(c)} = ${POSTGRES_STYLE.placeholder(i + 1)}`).join(', ');
    const where = buildWhere(filter, POSTGRES_STYLE, columns.length + 1);
    const guard = buildUpdateGuard(
      request,
      Object.fromEntries(meta.map((column) => [column.name, column.type])),
      POSTGRES_STYLE,
      'postgres',
      columns.length + where.params.length + 1,
    );
    const text = `UPDATE ${qualified(found)} SET ${assignments}${where.text}${guard.text}`;
    const params = [...Object.values(applied), ...where.params, ...guard.params];

    const result = await write.query(text, params);
    if (request.expected !== undefined && Number(result.rowCount ?? 0) === 0) throw new WriteConflict();
    if (transactional && Number(result.rowCount ?? 0) !== 1) refuseMatches(Number(result.rowCount ?? 0));
    /* Postgres counts rows matched, not rows whose bytes changed, so saving a
       cell without changing its value still reports 1 — the editor would
       otherwise tell the user a successful write failed. */
    return { affected: Number(result.rowCount ?? 0), applied, sql: { text, params } };
  }

  /**
   * Add one row.
   *
   * `update`'s guards where they apply, with the key rules inverted: a primary
   * key may be supplied (a country code somebody types) or left for the
   * database to assign. What is deliberately *not* pre-checked is
   * completeness — a missing NOT NULL column with no default is the database's
   * refusal to make, and its message names the column better than a paraphrase
   * would.
   *
   * `RETURNING *` rather than a re-read by key: one statement gives back the
   * row as stored, defaults filled and the assigned key included, with no
   * window for another write to land in between.
   */
  async insert(request: InsertRequest): Promise<InsertResult> {
    // A new row has no lane of its own: nothing earlier can be writing it.
    if (this.recordsHistory(request)) return this.transact([], (tx) => tx.insert(request));
    return this.watched(this.writes.run([], () => this.connections.withWriteClient((write) => this.insertNow(request, write))));
  }

  private async insertNow(request: InsertRequest, write: PgQuery, read?: PgQuery, scoped = false): Promise<InsertResult> {
    read ??= await this.conn();
    const found = await this.assertTable(request.table, read);
    const id = `${found.schema}.${found.name}`;
    if (found.isView) throw new Refusal(`${id} is a view. Insert into the table underneath it.`);

    const meta = await this.columnsOf(found.schema, found.name, read);
    const entries = Object.entries(request.values ?? {});

    const applied: Record<string, string | number | boolean | null> = {};
    for (const [column, raw] of entries) {
      const declared = meta.find((c) => c.name === column);
      if (!declared) throw new Refusal(`${id} has no column called "${column}".`);
      applied[column] = coerceForColumn(declared.type || '', raw);
      if (applied[column] === null && declared.notnull) {
        throw new Refusal(`"${column}" is NOT NULL and cannot be null. Leave it out to use its default, if it has one.`);
      }
    }

    const columns = Object.keys(applied);
    const text =
      `INSERT INTO ${qualified(found)}` +
      (columns.length
        ? ` (${columns.map((c) => POSTGRES_STYLE.quote(c)).join(', ')}) VALUES (${columns.map((_, i) => POSTGRES_STYLE.placeholder(i + 1)).join(', ')})`
        : ' DEFAULT VALUES') +
      ' RETURNING *';
    const params = Object.values(applied);

    const result = await write.query(text, params);
    const row = result.rows[0] ? toJsonSafe(result.rows[0]) : undefined;

    const pk = meta.filter((c) => c.is_pk).map((c) => c.name);
    /* A scope re-reads the stored row by this key. A bytea key would come
       back as its "<n bytes>" label, which matches nothing and proves
       nothing; refuse rather than let a label stand in for the value. */
    if (
      scoped &&
      pk.some((column) => {
        const value = result.rows[0]?.[column];
        return !(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)));
      })
    )
      throw new Refusal('The stored key cannot be checked in this row scope.');
    /* Read off the returned row rather than off what was sent: a key the
       database assigned is only knowable from what came back, and a key that
       was supplied comes back identical. */
    const key: Record<string, string | number> = {};
    if (row) for (const c of pk) key[c] = row[c] as string | number;

    return { key, row, applied, sql: { text, params } };
  }

  /**
   * Remove one row, having proved it is one row.
   *
   * What is *not* checked here is whether the row should go: what references
   * it, and what the database will do to those references, is answered above
   * this layer where the schema is in hand. A `RESTRICT` that fires is the
   * correct outcome in the engine's own words.
   */
  async remove(request: DeleteRequest): Promise<DeleteResult> {
    const lane = keyedLane(request);
    if (this.recordsHistory(request)) return this.transact(lane, (tx) => tx.remove(request));
    return this.watched(this.writes.run(lane, () => this.connections.withWriteClient((write) => this.removeNow(request, write))));
  }

  private recordsHistory(request: { table?: unknown }): boolean {
    return capturesWrites(this, request?.table);
  }

  /* What rides beneath one transaction's writes on its leased writer, beneath
     every facade (writeCapture.ts): the App's record history and notices. The
     before image is read under the row's lock, so it is the one the write
     replaces. */
  private historyWrites(
    write: PgQuery,
    base: Pick<WriteTransaction, 'insert' | 'update' | 'remove'>,
    /* The capture's read of the row it keeps a before image of: an unscoped transaction's reads by key, which a row
       sent ahead may answer (plainReads). */
    query: (request: QueryRequest) => Promise<QueryResult> = (request) => this.queryOn(request, write),
  ): Pick<WriteTransaction, 'insert' | 'update' | 'remove' | 'tell'> & { finish(): Promise<void>; committed(): void } {
    const history = beginWriteCapture(this, {
      writer: { dialect: 'postgres', client: write },
      read: async (table, key, columns, lock) => {
        if (lock) await this.lockRecordNow({ table, key }, write);
        const result = await query({
          table,
          ...(columns ? { columns } : {}),
          limit: 2,
          offset: 0,
          filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
        });
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
            write,
          )
        ).rows,
      behind: (table, ride) => {
        // The table as updateNow names it: assertPostgresTable reads a bare name in the public schema.
        const update = `UPDATE ${qualified(plainTable(table))} SET `;
        return behindWrite(write, (text) => text.startsWith(update), ride);
      },
    });
    if (!history) return { ...base, finish: async () => {}, committed: () => {} };
    return {
      insert: (r) => history.insert(r, base.insert),
      update: (r) => history.update(r, base.update),
      remove: (r) => history.remove(r, base.remove),
      tell: (r) => history.tell(r),
      finish: () => finishWriteCapture(history),
      committed: () => committedWriteCapture(history),
    };
  }

  private async removeNow(request: DeleteRequest, write: PgQuery, read?: PgQuery): Promise<DeleteResult> {
    const transactional = read !== undefined;
    read ??= await this.conn();
    const found = await this.assertTable(request.table, read);
    const id = `${found.schema}.${found.name}`;
    if (found.isView) throw new Refusal(`${id} is a view, so no single row can be identified.`);

    const meta = await this.columnsOf(found.schema, found.name, read);
    const pk = meta.filter((c) => c.is_pk).map((c) => c.name);
    if (!pk.length) throw new Refusal(`${id} has no primary key, so no single row can be identified.`);

    const keyColumns = Object.keys(request.key);
    const same = keyColumns.length === pk.length && pk.every((c) => keyColumns.includes(c));
    if (!same) throw new Refusal(`Deleting from ${id} needs exactly its primary key (${pk.join(', ')}).`);

    const filter: Filter = {
      groups: [pk.map((column) => ({ column, op: '=' as const, value: request.key[column] }))],
    };
    // As an update's: inside a transaction the DELETE's own count is the check.
    const refuseMatches = (matches: number): never => {
      throw new Refusal(
        `Refused: that key matches ${matches} rows, not 1. A delete is only allowed when it is certain which row it removes.`,
      );
    };
    const matches = transactional ? 1 : await this.count(id, filter);
    if (matches !== 1) refuseMatches(matches);

    const where = buildWhere(filter, POSTGRES_STYLE);
    const text = `DELETE FROM ${qualified(found)}${where.text}`;
    const result = await write.query(text, where.params);
    if (transactional && Number(result.rowCount ?? 0) !== 1) refuseMatches(Number(result.rowCount ?? 0));
    return { affected: Number(result.rowCount ?? 0), sql: { text, params: where.params } };
  }

  /**
   * Several writes as one, or none of them.
   *
   * Plain `BEGIN` / `COMMIT` on the write connection. The callback is handed
   * the same write bodies the public methods call, so every guard — the whole
   * key, the pre-flight count, the type coercion — applies inside a
   * transaction exactly as it does outside one.
   *
   * Reads, metadata checks, and preflight counts use the same leased client.
   * This preserves read-after-write visibility; it does not promise serializable
   * isolation. Call lockRecord explicitly before capturing protected originals:
   * where an App writes, other transactions of this process run beside this
   * one (writeLanes.ts), and a row read without its lock may change before
   * the write that depends on it, as a row read in another pod always could.
   */
  async transaction<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    return this.transact([], run);
  }

  /* A transaction in the lanes `lane` names: a single record's write that
     keeps a history names its record, so it keeps its place behind that
     record's earlier writes. */
  private async transact<T>(lane: readonly string[], run: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    const hint = writeAhead();
    const schema = hint ? await this.schema().catch(() => undefined) : undefined;
    return this.watched(
      this.writes.run(lane, () =>
        this.connections.withWriteClient(async (leased) => {
          // Its own handle, as a journal's: what it was told leaves behind its BEGIN, and writes nothing reads with its COMMIT.
          // A writer that pipelines sends reads asked together in one flight (TransactionOperations.read).
          const write = transactionHandle(leased, this),
            operations = new TransactionOperations(sendsAhead(write));
          let began = false;
          let commitAttempted = false;
          let committed = false;
          try {
            const reads = await this.openPlain(write, schema, undefined, hint, () => {
              began = true;
            });
            const writes = this.historyWrites(
              write,
              {
                insert: (r) => this.insertNow(r, write, write),
                remove: (r) => this.removeNow(r, write, write),
                update: (r) => this.updateNow(r, write, write),
              },
              reads,
            );
            // The transaction's own work runs without the hint: a transaction it opens is not this one.
            const out = await withoutWriteAhead(() =>
              run({
                lockRecord: (r) => queueRecordLock(operations, r, (request) => this.lockRecordNow(request, write)),
                query: (r) => operations.read(() => reads(r)),
                count: (table, filter) => operations.read(() => this.countOn(table, filter, write)),
                insert: (r) => operations.run(() => writes.insert(r)),
                remove: (r) => operations.run(() => writes.remove(r)),
                update: (r) => operations.run(() => writes.update(r)),
                ...(writes.tell ? { tell: (r: TellRequest) => operations.run(() => writes.tell!(r)) } : {}),
              }),
            );
            await operations.finish();
            await writes.finish();
            commitAttempted = true;
            await write.query('COMMIT');
            committed = true;
            writes.committed();
            return out;
          } catch (err) {
            await operations.finish().catch(() => {});
            let rolledBack = false;
            if (began) {
              try {
                await write.query('ROLLBACK');
                rolledBack = true;
              } catch {
                /* A failed acknowledgement cannot establish the outcome. */
              }
            }
            // A write sent with the COMMIT failed and the server answered it as a ROLLBACK: nothing committed.
            if (err instanceof RolledBackAtCommit) throw err.cause;
            // withWriteClient destroys on any callback error, including a failed
            // BEGIN and a lost COMMIT acknowledgement followed by successful rollback.
            if (commitAttempted || (began && !rolledBack)) throw new TransactionOutcomeUnknown(err);
            throw err;
          } finally {
            this.txEpochs.delete(write);
            reportWriteAhead(aheadReport(write), committed);
          }
        }),
      ),
    );
  }

  /**
   * Begin an unscoped write transaction with what it was told it opens with
   * (writeAhead.ts) behind its BEGIN, as a scoped one does (sendWriteAhead):
   * the journal's receipt lookup, and for each target its lock and its whole
   * row, kept to answer the transaction's reads of it by key (keyRows.ts) —
   * the command's own read of its target, its handler's, the history
   * capture's before image. The lock goes first, so the row is read under it
   * and cannot move until this transaction ends; its own writes move the
   * statement generation and are read again. One that fails aborts the
   * opening, which begins again without them. Answers the transaction's
   * reader: by key from the kept rows where they answer, else in its turn.
   */
  private async openPlain(
    write: PgQuery,
    schema: DatabaseSchema | undefined,
    journal: PostgresTransactionJournal<unknown> | undefined,
    hint: WriteAhead | undefined,
    began: () => void,
  ): Promise<(request: QueryRequest) => Promise<QueryResult>> {
    const keyRows = new KeyRows(() => generationOf(write));
    let aheads: Promise<unknown>[] = [];
    await this.openWrite(
      write,
      schema && hint ? { sent: () => void (aheads = this.sendPlainAhead(write, schema, keyRows, journal, hint)) } : {},
      began,
    );
    if (aheads.length && (await Promise.allSettled(aheads)).some((outcome) => outcome.status === 'rejected')) {
      redoWithoutAhead(write);
      keyRows.forget();
      // Its ROLLBACK lets go of every lock it held.
      heldLocks.delete(write);
      heldRows.delete(write);
      await write.query('ROLLBACK');
      await this.openWrite(write, {}, began);
    }
    const plain = (request: QueryRequest) => this.queryOn(request, write);
    if (!schema || !aheads.length) return plain;
    /* A table is asked for bare (`task`) or by its id (`public.task`), as assertPostgresTable reads either: the kept
       rows are filed under the id, and a read asked in its turn is sent as it was asked. */
    const asked = new WeakMap<QueryRequest, QueryRequest>();
    const kept = keyRows.over(
      { query: (request) => plain(asked.get(request) ?? request) },
      PLAIN_SCOPE,
      schema,
      (request) => plainStatement(request),
      (row, request) => (request.binary ? withBytes : toJsonSafe)(row),
      false,
      /* A row the opening locked FOR UPDATE cannot move until this transaction ends: read by key after a write of
         the transaction's own has dropped what was kept of it, it is read whole once, and the reads of it that follow
         (the machine's columns, the history capture's before image) are answered from that read, as a scoped
         transaction's are (keyRows.ts, `widen`). The driver's own rows, formatted as each read asks. */
      {
        held: (table, key) => heldRows.get(write)?.has(lockKey(...rowLockStatement(table, key))) === true,
        reads: {
          query: async (request) => {
            const sql = plainStatement(request)!;
            const result = await write.query(sql.text, sql.params);
            return { columns: result.fields.map((field) => field.name), rows: result.rows, ms: 0, sql };
          },
        },
      },
    ).query;
    return (request) => {
      const id = typeof request?.table === 'string' ? catalogId(request.table) : request?.table;
      if (id === request?.table) return kept(request);
      const named = { ...request, table: id };
      asked.set(named, request);
      return kept(named);
    };
  }

  /** The statements openPlain sends behind the BEGIN; each exactly what the transaction sends in its turn (lockRecordNow, queryOn). */
  private sendPlainAhead(
    write: PgQuery,
    schema: DatabaseSchema,
    keyRows: KeyRows,
    journal: PostgresTransactionJournal<unknown> | undefined,
    hint: WriteAhead,
  ): Promise<unknown>[] {
    if (!sendsAhead(write)) return [];
    const opening: PipelinedStatement[] = [];
    try {
      if (hint.receipt !== undefined && journal?.ahead) opening.push(...journal.ahead(hint.receipt));
    } catch {
      /* Asked in its turn. */
    }
    const answers = sendAhead(write, opening);
    for (const target of hint.targets) {
      const table = schema.tables.find((candidate) => candidate.id === catalogId(target.table));
      if (!table || table.isView || isRuntimeRelation(table.id)) continue;
      const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
      const key = target.key;
      if (
        !pk.length ||
        Object.keys(key).length !== pk.length ||
        !pk.every((column) => Object.hasOwn(key, column) && (typeof key[column] === 'string' || typeof key[column] === 'number'))
      )
        continue;
      const filter: Filter = { groups: [pk.map((column) => ({ column, op: '=' as const, value: key[column] }))] };
      if (!hint.readOnly && (hint.locks || (hint.writes && capturesWrites(this, table.id)))) {
        /* lockRecordNow's statement, where the transaction will send it (the save's own lock, the history capture's). Held rather than answered once: the row stays locked until the transaction ends,
           so each later lock of it in this transaction (the command's, the history capture's) is answered by it, even
           after a write to another record has moved the statement generation. */
        const [text, values] = rowLockStatement(table, key as Readonly<Record<string, string | number>>);
        const lock = holdAhead(write, { text, values });
        if (lock) {
          answers.push(lock.answer);
          const locks = heldLocks.get(write) ?? new Map<string, () => void>();
          heldLocks.set(write, locks);
          const rows = heldRows.get(write) ?? new Set<string>();
          heldRows.set(write, rows);
          void lock.answer.then(
            (result) => {
              if (result.rows.length <= 1) locks.set(lockKey(text, values), lock.take);
              // Only a row that is there is held: one that is not could be inserted by another transaction meanwhile.
              if (result.rows.length === 1) rows.add(lockKey(text, values));
            },
            () => {},
          );
        }
      }
      const read = plainStatement({ table: table.id, filter, limit: 2, offset: 0 });
      const row = read && holdAhead(write, { text: read.text, values: read.params });
      if (row) {
        answers.push(row.answer);
        keyRows.keep(
          PLAIN_SCOPE,
          table,
          filter,
          row.answer.then((result) => result.rows),
          row.take,
        );
      }
    }
    return answers;
  }

  /**
   * Same-source records and a durable journal in one transaction, the
   * journal lent by the App framework (storeHost.ts TransactionJournal): the
   * command journal, or a public placement's. Lent through the store host,
   * never on the class, so the database browser has no journal path at all.
   *
   * The SQLite version opens `BEGIN IMMEDIATE`, which serialises every writer
   * in the file; here the transaction is plain `BEGIN` at the server's
   * default READ COMMITTED, and the journal's per-scope advisory lock does
   * the one piece of that serialisation a command needs — two deliveries of
   * the same command cannot both execute. SERIALIZABLE was the alternative
   * and was refused: it would turn unrelated concurrent commands into 40001
   * retries the SQLite path never has, and a conditional `expected` update
   * already refuses a stale row in the write itself.
   *
   * The journal is attested inside the transaction and before the callback,
   * so an unmigrated or altered layout refuses without a write. The outcome
   * contract is SQLite's: a failure after COMMIT was sent, or a rollback that
   * was not acknowledged, is `unknown`; everything else is `not_applied`.
   * `withWriteClient` destroys the client on any failure, so a connection in
   * an uncertain state is never handed to the next write.
   */
  private async journalTransaction<J, T>(
    journal: PostgresTransactionJournal<J>,
    run: JournalRun<J, T>,
    options: JournalTransactionOptions<PostgresTransactionVerifier> = {},
  ): Promise<T> {
    if (options.scope === undefined) {
      /* The verifier supplies current authority, never actor/receipt scope or record filtering. */
      if (options.ordinaryVerify !== undefined && !this.verifiedSource())
        throw new Refusal('This verified command transaction is unavailable.');
      const verify = options.ordinaryVerify;
      return this.ordinaryJournalTransaction(journal, run, verify && (async () => void (await verify())));
    }
    return this.scopedTransact(options.scope, journal, run as JournalRun<J | undefined, T>, options.verify, options.bound);
  }

  private async ordinaryJournalTransaction<J, T>(
    journal: PostgresTransactionJournal<J>,
    run: JournalRun<J, T>,
    verify?: () => Promise<void>,
  ): Promise<T> {
    /* The command host supplies target and receipt lanes through inWriteLanes.
       Extra records discovered inside the handler still rely on row locks and
       compare-and-set, as they do across processes. */
    const hint = writeAhead();
    const schema = hint ? await this.schema().catch(() => undefined) : undefined;
    return this.watched(
      this.writes.run([], () =>
        this.connections.withWriteClient(async (leased) => {
          // Its own handle, as a scoped transaction's: writes nothing reads leave with its COMMIT (beforeCommit).
          // A writer that pipelines sends reads asked together in one flight (TransactionOperations.read).
          const write = transactionHandle(leased, this),
            operations = new TransactionOperations(sendsAhead(write));
          let began = false;
          let commitAttempted = false;
          let committed = false;
          try {
            const reads = await this.openPlain(write, schema, journal as PostgresTransactionJournal<unknown>, hint, () => {
              began = true;
            });
            await this.attestJournal(write, journal);
            if (verify) await verify();
            const writes = this.historyWrites(
              write,
              {
                insert: (r) => this.insertNow(r, write, write),
                remove: (r) => this.removeNow(r, write, write),
                update: (r) => this.updateNow(r, write, write),
              },
              reads,
            );
            const records: WriteTransaction = {
              lockRecord: (r) => queueRecordLock(operations, r, (request) => this.lockRecordNow(request, write)),
              query: (r) => operations.read(() => reads(r)),
              count: (table, filter) => operations.read(() => this.countOn(table, filter, write)),
              insert: (r) => operations.run(() => writes.insert(r)),
              remove: (r) => operations.run(() => writes.remove(r)),
              update: (r) => operations.run(() => writes.update(r)),
              ...(writes.tell ? { tell: (r: TellRequest) => operations.run(() => writes.tell!(r)) } : {}),
            };
            // The transaction's own work runs without the hint: a transaction it opens is not this one.
            const out = await withoutWriteAhead(() => run(Object.freeze(records), journal.open(write, operations)));
            await operations.finish();
            await writes.finish();
            if (verify) {
              // All storage work precedes the final native observation. No further
              // asynchronous work is allowed here except the COMMIT itself. Separate
              // auth/business databases still do not provide atomic revocation.
              await verify();
            }
            commitAttempted = true;
            await write.query('COMMIT');
            committed = true;
            writes.committed();
            return out;
          } catch (error) {
            await operations.finish().catch(() => {});
            let rolledBack = false;
            if (began) {
              try {
                await write.query('ROLLBACK');
                rolledBack = true;
              } catch {
                /* A failed acknowledgement cannot establish the outcome. */
              }
            }
            // A write sent with the COMMIT failed and the COMMIT rolled back: nothing committed, and its failure is what is said.
            if (error instanceof RolledBackAtCommit) throw journal.failure(error.cause, 'not_applied');
            throw journal.failure(error, commitAttempted || (began && !rolledBack) ? 'unknown' : 'not_applied');
          } finally {
            this.txEpochs.delete(write);
            reportWriteAhead(aheadReport(write), committed);
          }
        }),
      ),
    );
  }

  /**
   * Private same-source row enforcement, with the SQLite guarantees.
   *
   * SQLite gets "the row the scope checked is the row the write changes"
   * from `BEGIN IMMEDIATE`, which excludes every other writer for the whole
   * transaction. Here the transaction is plain `BEGIN` at the server's
   * default READ COMMITTED, and the guarantee is made per row instead: before
   * a target is scope-checked its row is taken `FOR UPDATE`, and before a
   * parent is checked its row is taken `FOR SHARE`. A lock waits for any
   * in-flight writer of that row to finish, and the guard read that follows
   * takes a fresh snapshot — READ COMMITTED gives one per statement — so it
   * sees the version that writer committed and nobody can commit another
   * until this transaction ends. A row a concurrent writer moved out of scope
   * is therefore refused, whether it moved before the check or while the
   * check waited. SERIALIZABLE would prove the same thing by aborting one of
   * the two with 40001, which the SQLite path never does and every handler
   * would have to learn to retry; the explicit locks make the refusal an
   * ordinary one.
   *
   * The catalog is read on the writer inside the transaction after the
   * scope's tables are pinned against DDL (`postgresScopeCatalog.ts`), and
   * handed out as detached evidence for the caller to attest. Outcomes are
   * the transaction contract's: a failure after COMMIT was sent, or a
   * rollback that was not acknowledged, is unknown, and the client is
   * discarded rather than reused. Everything else did not commit.
   */
  async scopeTransaction<T>(input: RowScope, run: (tx: WriteTransaction, catalog: DatabaseSchema) => Promise<T>): Promise<T> {
    const scope = captureRowScope(input);
    return this.scopedTransact(scope, undefined, (tx, _journal, catalog) => run(tx, catalog!));
  }

  /**
   * Private source-owner boundary, deliberately absent from Adapter: the
   * PostgreSQL counterpart of `SqliteAdapter.scopeVerifiedTransaction`. The
   * verifier is trusted host code — the tenant write source's attestation and
   * the store's membership fence (`assertPostgresTenantMembershipFence`) —
   * never a business callback or a wire value, and must not retain the
   * client. It runs on the leased writer inside the transaction twice: after
   * the scope's tables are pinned and the catalog read, before the callback;
   * and after the callback's operations drain, before COMMIT. It is handed the
   * catalog evidence and the adapter's own introspection on the writer, for
   * anything it pins itself. SQLite also re-verifies around every operation,
   * because its fence is a snapshot check; here the fence is row locks held
   * to the end of the transaction, so the two checks bound its lifetime.
   */
  async scopeVerifiedTransaction<T>(
    input: RowScope,
    verify: PostgresTransactionVerifier,
    run: (tx: WriteTransaction, catalog: DatabaseSchema) => Promise<T>,
  ): Promise<T> {
    const scope = captureRowScope(input);
    if (typeof verify !== 'function' || typeof run !== 'function' || Object.keys(scope).some(isRuntimeRelation))
      throw new Refusal('This verified transaction is unavailable.');
    return this.scopedTransact(scope, undefined, (tx, _journal, catalog) => run(tx, catalog!), verify);
  }

  /**
   * Private source-owner boundary, deliberately absent from Adapter: one
   * `REPEATABLE READ, READ ONLY` transaction on a leased reader, for trusted
   * host code that pins, attests and reads inside a single snapshot (the
   * PostgreSQL tenant read source). It is what a deferred `BEGIN` on its
   * read-only handle gives the SQLite tenant reader: every statement sees one
   * committed state. PostgreSQL takes that snapshot at the first query, not at
   * BEGIN, so an owner that takes its locks before its first query attests
   * what committed before them, and DDL after them waits. A ROLLBACK that
   * fails surfaces as TransactionOutcomeUnknown; any failure discards the
   * client rather than returning it to the pool.
   */
  async readSnapshot<T>(
    run: (snapshot: PostgresReadSnapshot) => Promise<T>,
    observeCheckout = false,
    prologue?: string,
    ahead = false,
    /* The prologue is the snapshot's whole question (a membership fence): BEGIN, the prologue and COMMIT in one
       round trip where they were two. `run` is handed its answers and nothing it can ask. */
    whole = false,
  ): Promise<T> {
    return readSnapshotOn(
      this.connections,
      (db, checkout) => (checkout ? PostgresAdapter.prototype.describe.call(this, db) : this.describeSnapshot(db)),
      run,
      observeCheckout,
      prologue,
      ahead,
      whole,
    );
  }

  /** Private source-shape owner, not an authorization proof or generic Adapter
   * capability. Only this actual adapter's native snapshot runner is used. */
  capturePinnedReadSnapshot(dependencies: readonly PostgresReadDependency[], assertCurrent: () => void): Promise<PinnedPostgresReadOwner> {
    if (typeof assertCurrent !== 'function' || isProxy(assertCurrent)) {
      throw new Refusal('The pinned PostgreSQL read snapshot is unavailable.');
    }
    const connections = pinnedReaders.get(this);
    const nativeCurrent = () => {
      if (!connections) throw new Refusal('The pinned PostgreSQL read snapshot is unavailable.');
      const descriptor = Object.getOwnPropertyDescriptor(this, 'connections');
      if (!descriptor || !('value' in descriptor) || descriptor.value !== connections) {
        throw new Refusal('The pinned PostgreSQL read snapshot is unavailable.');
      }
    };
    nativeCurrent();
    return createPinnedPostgresReadOwner(
      <T>(run: (snapshot: PostgresReadSnapshot) => Promise<T>) => {
        nativeCurrent();
        return (PostgresAdapter.prototype.readSnapshot<T>).call(this, run, true);
      },
      dependencies,
      () => {
        nativeCurrent();
        assertCurrent();
        nativeCurrent();
      },
    );
  }

  /* Scoped records and, for a command, the durable journal and fresh catalog
     evidence in one transaction. The journal is attested before the catalog
     is read, so an unmigrated layout refuses before any lock is taken. */
  private async scopedTransact<J, T>(
    scope: RowScope,
    journal: PostgresTransactionJournal<J> | undefined,
    run: JournalRun<J | undefined, T>,
    verify?: PostgresTransactionVerifier,
    bound?: RowScope,
  ): Promise<T> {
    // This transaction's own handle: what its verifier learns is kept on it, never on the pooled client.
    /* No lane: every target is taken FOR UPDATE and every parent FOR SHARE
       before it is checked (below), which is what orders two of these
       across connections, in this process as across pods. */
    const hint = writeAhead();
    return this.writes.run([], () =>
      this.connections.withWriteClient(async (leased) => {
        // A writer that pipelines sends reads asked together in one flight (TransactionOperations.read).
        const write = transactionHandle(leased, this),
          operations = new TransactionOperations(sendsAhead(write));
        let began = false;
        let commitAttempted = false;
        let committed = false;
        try {
          /* The scope catalog is kept per set of scoped tables under the epoch;
           the tables it pinned last time are pinned in the message that reads
           the epoch, so a hit asks the catalog nothing (openWrite). */
          const scopeKey = `scope:${Object.keys(scope).sort().join('\u0000')}`;
          const peeked = this.catalogCache.peek(scopeKey)?.value as PostgresScopeCatalog | undefined;
          const pinned = peeked?.pinned;
          const pin = verifierPin(verify);
          /* What the transaction opens with leaves behind its BEGIN, in the
             same round trip (writeAhead.ts): the verifier's fence, the
             journal's receipt lookup, each target's lock and row. Each answers
             the identical statement once when the transaction asks it, and a
             target's row answers its reads by key (keyRows.ts). */
          const keyRows = new KeyRows(() => generationOf(write));
          // The rows whose locks were sent ahead, held from the moment their answers came back (sendWriteAhead).
          const lockedAhead = new Set<string>();
          let aheads: Promise<unknown>[] = [];
          const opening = { lock: pinned, pin, digest: true };
          let opened = await this.openWrite(
            write,
            {
              ...opening,
              sent: () => void (aheads = this.sendWriteAhead(write, scope, peeked, keyRows, journal, verify, hint, lockedAhead)),
            },
            () => {
              began = true;
            },
          );
          if (aheads.length && (await Promise.allSettled(aheads)).some((outcome) => outcome.status === 'rejected')) {
            /* One failed, which aborted the transaction before anything took
               an answer: it begins again without them. Rare, and counted. */
            lockedAhead.clear();
            redoWithoutAhead(write);
            began = false;
            await write.query('ROLLBACK');
            opened = await this.openWrite(write, opening, () => {
              began = true;
            });
          }
          if (journal) await this.attestJournal(write, journal);
          const catalog =
            (this.catalogCache.get(opened.epoch, scopeKey) as PostgresScopeCatalog | undefined) ??
            this.catalogCache.set(opened.epoch, scopeKey, await readPostgresScopeCatalog(write, scope, (db) => this.describeScoped(db)));
          // Rows read under another epoch's catalog answer nothing: the statements sent ahead were built from it.
          if (catalog !== peeked) {
            keyRows.forget();
            lockedAhead.clear();
          }
          const described = () => this.describeScoped(write);
          // The epoch is passed only when it was read after the verifier's own pin: then it vouches for what that pin holds.
          if (verify) await verify(write, catalog, described, pin !== undefined ? this.txEpochs.get(write) : undefined);
          if (journal?.admit) await journal.admit(write, catalog, scope);
          // Runtime state is not command-handler evidence; the complete graph
          // stays behind for row/FK enforcement exactly as on SQLite.
          const evidence = journal
            ? mapScopeCatalog(
                catalog.schema,
                new Map(catalog.schema.tables.filter((table) => !isRuntimeRelation(table.id)).map((table) => [table.id, table.id])),
              )
            : captureScopeCatalog(catalog.schema);
          // Guards keep the stored scalars: a bytea's byte-count label is
          // not a key, and a numeric's text is exactly its value.
          const formatted = (guard: boolean, binary: boolean | undefined) => (row: Record<string, unknown>) =>
            guard ? { ...row } : binary ? withBytes(row) : toJsonSafe(row);
          // Row locks this transaction holds: a lock is held to its end, so a row taken once is not taken again.
          const held = new Map<string, 'UPDATE' | 'SHARE'>();
          /* Whether this transaction holds a row FOR UPDATE: taken in its turn, or sent ahead behind the BEGIN. Such a
             row cannot move until the transaction ends, so a read of it by key may be kept to answer the reads after
             it (keyRows.ts, `widen`) until the transaction changes something of its own. */
          const holds = (table: TableMeta, key: Readonly<Record<string, string | number>>) => {
            const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
            const at = rowLockKey(table, { groups: [pk.map((column) => ({ column, op: '=' as const, value: key[column] }))] });
            return held.get(at) === 'UPDATE' || lockedAhead.has(at);
          };
          const executor = (guard: boolean) => async (sql: SqlFragment, hint?: { binary?: true }) => {
            const started = performance.now();
            const result = await write.query(sql.text, sql.params);
            return {
              columns: result.fields.map((field) => field.name),
              rows: result.rows.map(formatted(guard, hint?.binary)),
              ms: Math.round(performance.now() - started),
              sql,
            };
          };
          /* Each scope this transaction reads under, checked against its catalog once. A command's scope arrives as
             a copy (captureRowScope), which no check has seen, and every scoped reader and statement checked it
             again in full: eleven times in one prepare. Checked here, each finds it checked (rowScope.ts). The rows
             kept by key are kept under the scope as given, the one the statements sent ahead were keyed by
             (keyRows.ts names a scope by its object), so that is the one they are asked under. */
          const checkedScopes = new WeakMap<RowScope, RowScope>();
          const checkedScope = (given: RowScope) => {
            let checked = checkedScopes.get(given);
            if (!checked) checkedScopes.set(given, (checked = snapshotRowScope(catalog.schema, given)));
            return checked;
          };
          const scopedReads = (guard: boolean, given: RowScope = scope, within = checkedScope(given)) =>
            keyRows.over(
              createScopedReads(catalog.schema, within, POSTGRES_STYLE, executor(guard)),
              given,
              catalog.schema,
              (request) => scopedStatement(catalog.schema, within, request),
              (row, request) => formatted(guard, request.binary)(row),
              guard,
              guard ? undefined : { held: holds, reads: createScopedReads(catalog.schema, within, POSTGRES_STYLE, executor(true)) },
            );
          const lock = (mode: 'UPDATE' | 'SHARE') => async (table: TableMeta, filter: Filter) => {
            // A parent the role cannot update cannot be held; its FK's own KEY
            // SHARE still stops deletion, and the visibility check is one read.
            if (!catalog.lockable.has(table.id)) {
              if (mode === 'UPDATE') throw new Refusal('This operation is not available in the current row scope.');
              return;
            }
            const at = rowLockKey(table, filter);
            const had = held.get(at);
            if (had === 'UPDATE' || had === mode) return;
            const where = buildWhere(filter, POSTGRES_STYLE);
            const text = `SELECT 1 FROM ${qualified(table)}${where.text} FOR ${mode}`;
            /* Sent ahead behind the BEGIN and granted, its answer since dropped by a write of the transaction's own:
               the row is held all the same, to the transaction's end. While that answer still waits, asking takes it. */
            if (lockedAhead.has(at) && !waitsAhead(write, { text, values: where.params })) {
              held.set(at, 'UPDATE');
              return;
            }
            await write.query(text, where.params);
            held.set(at, mode);
          };
          const writes = this.historyWrites(write, {
            insert: (r) => this.insertNow(r, write, write, true),
            remove: (r) => this.removeNow(r, write, write),
            update: (r) => this.updateNow(r, write, write),
          });
          let records = createScopedTransaction(
            catalog,
            {
              query: (r) => this.queryOn(r, write),
              count: (table, filter) => this.countOn(table, filter, write),
              insert: writes.insert,
              remove: writes.remove,
              update: writes.update,
            },
            scopedReads(false),
            scopedReads(true),
            {
              target: lock('UPDATE'),
              parent: lock('SHARE'),
              behind: (table, ride) => {
                const update = `UPDATE ${qualified(table)} SET `;
                return behindWrite(write, (text) => text.startsWith(update), ride);
              },
              together: sendsAhead(write),
            },
            bound && { reads: scopedReads(true, bound), whole: wholeWithin(scope, bound) },
            // A public intake writes exactly its fixed rows; only a principal's own transaction counts its new parents in.
            journal?.fixedRecords ? undefined : { scope, reads: (within, guard) => scopedReads(guard, within) },
          );
          if (journal?.fixedRecords) records = journal.fixedRecords(records);
          const invoke = scopedCommandInvoker(operations, true, journal !== undefined, isRuntimeRelation);
          // The transaction's own work runs without the hint: a transaction it opens is not this one.
          const out = await withoutWriteAhead(() =>
            run(
              Object.freeze({
                // The scoped policy facade deliberately has no generic lock capability.
                query: (r: QueryRequest) => invoke(r, (r) => records.query(r), true),
                count: (table: string, filter?: Filter) => invoke({ table, filter }, (r) => records.count(r.table, r.filter), true),
                insert: (r: InsertRequest) => invoke(r, (r) => records.insert(r)),
                remove: (r: DeleteRequest) => invoke(r, (r) => records.remove(r)),
                update: (r: UpdateRequest) => invoke(r, (r) => records.update(r)),
                // Beneath the row scope: the flows' command tells only of its own target, which it read through the scope.
                ...(writes.tell ? { tell: (r: TellRequest) => invoke(r, (r) => writes.tell!(r)) } : {}),
              }),
              journal?.open(write, operations),
              evidence,
            ),
          );
          await operations.finish();
          await writes.finish();
          if (verify) await verify(write, catalog, described);
          commitAttempted = true;
          await write.query('COMMIT');
          committed = true;
          writes.committed();
          return out;
        } catch (err) {
          await operations.finish().catch(() => {});
          let rolledBack = false;
          if (began) {
            try {
              await write.query('ROLLBACK');
              rolledBack = true;
            } catch {
              /* A failed acknowledgement cannot establish the outcome. */
            }
          }
          /* A write sent with the COMMIT failed, and the server answered the
             COMMIT as a ROLLBACK: nothing committed, and that write's failure is
             what is said. */
          const refused = err instanceof RolledBackAtCommit;
          const failure = refused ? err.cause : err;
          // withWriteClient destroys the client on any failure, so a connection
          // in an uncertain state is never handed to the next write.
          const unknown = !refused && (commitAttempted || (began && !rolledBack));
          // The verified owner composes native outcomes itself, as on SQLite.
          if (journal && !verify) throw journal.failure(failure, unknown ? 'unknown' : 'not_applied');
          if (unknown) throw new TransactionOutcomeUnknown(failure);
          throw failure;
        } finally {
          reportWriteAhead(aheadReport(write), committed);
        }
      }),
    );
  }

  /**
   * The statements a scoped transaction opens with, sent behind its BEGIN
   * (openWrite's `sent`), from what it was told (writeAhead.ts) and the scope
   * catalog read last time: the verifier's own (its fence), the journal's
   * receipt lookup, and for each target its row lock, its row read in full
   * through the scope (kept to answer its reads by key, keyRows.ts), and,
   * where the write is captured for history, the capture's own lock and read
   * (historyWrites). Each is exactly the statement the transaction sends in
   * its turn, built by the same rules; one it never sends is left, counted,
   * and changes nothing. None where the client does not pipeline.
   */
  private sendWriteAhead(
    write: PgQuery,
    scope: RowScope,
    peeked: PostgresScopeCatalog | undefined,
    keyRows: KeyRows,
    journal: PostgresTransactionJournal<unknown> | undefined,
    verify: PostgresTransactionVerifier | undefined,
    hint: WriteAhead | undefined,
    locked: Set<string>,
  ): Promise<unknown>[] {
    if (!sendsAhead(write) || (!hint && !verify?.ahead)) return [];
    const opening: PipelinedStatement[] = [];
    try {
      opening.push(...(verify?.ahead?.() ?? []));
      if (hint?.receipt !== undefined && journal?.ahead) opening.push(...journal.ahead(hint.receipt));
    } catch {
      /* Asked in its turn. */
    }
    const answers = sendAhead(write, opening);
    for (const target of (peeked && hint?.targets) || []) {
      const table = peeked!.schema.tables.find((candidate) => candidate.id === catalogId(target.table));
      if (!table || !peeked!.lockable.has(table.id)) continue;
      const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
      const key = target.key;
      if (
        !pk.length ||
        Object.keys(key).length !== pk.length ||
        !pk.every((column) => Object.hasOwn(key, column) && (typeof key[column] === 'string' || typeof key[column] === 'number'))
      )
        continue;
      // The scoped transaction's own key filter and lock (scopedTransaction.ts keyFilter, `lock` above).
      const filter: Filter = { groups: [pk.map((column) => ({ column, op: '=' as const, value: key[column] }))] };
      const where = buildWhere(filter, POSTGRES_STYLE);
      if (!hint!.readOnly) {
        answers.push(...sendAhead(write, [{ text: `SELECT 1 FROM ${qualified(table)}${where.text} FOR UPDATE`, values: where.params }]));
        locked.add(rowLockKey(table, filter));
      }
      const read = scopedStatement(peeked!.schema, scope, { table: table.id, filter, limit: 2, offset: 0 });
      const row = read && holdAhead(write, { text: read.text, values: read.params });
      if (row) {
        answers.push(row.answer);
        keyRows.keep(
          scope,
          table,
          filter,
          row.answer.then((result) => result.rows),
          row.take,
        );
      }
      if (hint!.writes && !hint!.readOnly && capturesWrites(this, table.id)) {
        // historyWrites' read: lockRecordNow, then queryOn of the whole row by the key as given.
        const given = buildWhere(
          { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
          POSTGRES_STYLE,
        );
        const n = given.params.length;
        answers.push(
          ...sendAhead(write, [
            {
              text: `SELECT ${pk.map(POSTGRES_STYLE.quote).join(', ')} FROM ${qualified(table)}${where.text} FOR UPDATE`,
              values: where.params,
            },
            { text: `SELECT * FROM ${qualified(table)}${given.text} LIMIT $${n + 1} OFFSET $${n + 2}`, values: [...given.params, 2, 0] },
          ]),
        );
      }
    }
    return answers;
  }

  /**
   * Internal runtime-owner composition, deliberately absent from Adapter: the
   * PostgreSQL counterpart of `SqliteAdapter.runtimeMaintenanceTransaction`,
   * for trusted runtime code (tenant administration) that composes its own
   * bounded maintenance facades on the leased writer and the ordinary write
   * queue. `verify` runs after BEGIN and again after the work's operations
   * drain, before COMMIT; the synchronous `assertCurrent` handed to the work
   * refuses once the transaction has ended. Raw handles must never reach
   * business handlers, policies or request callbacks. Outcomes are the
   * transaction contract's: unknown after COMMIT was sent or an unacknowledged
   * ROLLBACK, and the client is discarded rather than reused.
   */
  async runtimeMaintenanceTransaction<T>(
    verify: (client: PgQuery) => Promise<void>,
    run: (client: PgQuery, operations: TransactionOperations, assertCurrent: () => void) => Promise<T>,
  ): Promise<T> {
    if (typeof verify !== 'function' || typeof run !== 'function') throw new Refusal('Runtime maintenance is unavailable.');
    // No lane: `verify` fences what the work depends on, twice, on the writer (tenantAdministration.ts).
    return this.writes.run([], () =>
      this.connections.withWriteClient(async (leased) => {
        const write = transactionHandle(leased, this),
          operations = new TransactionOperations();
        let began = false,
          commitAttempted = false,
          open = true;
        const assertCurrent = () => {
          if (!open) throw new Refusal('The maintenance transaction is no longer active.');
        };
        try {
          await write.query('BEGIN');
          began = true;
          await verify(write);
          const out = await run(write, operations, assertCurrent);
          await operations.finish();
          await verify(write);
          commitAttempted = true;
          await write.query('COMMIT');
          return out;
        } catch (err) {
          await operations.finish().catch(() => {});
          let rolledBack = false;
          if (began) {
            try {
              await write.query('ROLLBACK');
              rolledBack = true;
            } catch {
              /* A failed acknowledgement cannot establish the outcome. */
            }
          }
          if (commitAttempted || (began && !rolledBack)) throw new TransactionOutcomeUnknown(err);
          throw err;
        } finally {
          open = false;
        }
      }),
    );
  }

  async close(): Promise<void> {
    await this.writes.run('all', () => this.connections.close());
  }

  private async lockRecordNow(request: DeleteRequest, write: PgQuery): Promise<void> {
    const found = await this.assertTable(request.table, write);
    if (found.isView || !['r', 'p'].includes(found.kind)) throw new Refusal('Record locks require a local keyed table.');
    const meta = await this.columnsOf(found.schema, found.name, write);
    const pk = meta.filter((column) => column.is_pk).map((column) => column.name);
    const where = buildWhere(recordLockFilter(request, pk), POSTGRES_STYLE);
    const text = `SELECT ${pk.map(POSTGRES_STYLE.quote).join(', ')} FROM ${qualified(found)}${where.text} FOR UPDATE`;
    // Locked already, behind this transaction's BEGIN (openPlain): it holds the lock until it ends.
    const held = heldLocks.get(write)?.get(lockKey(text, where.params));
    if (held) return held();
    const result = await write.query(text, where.params);
    if (result.rows.length > 1) throw new Refusal('That primary key does not identify a single record.');
  }

  /**
   * Identifiers cannot be bound, so a table name is checked against the
   * catalog before it is quoted into a statement. The check is a parameterised
   * query, which means the untrusted string never reaches SQL as syntax.
   */
  /**
   * The same check for a read, answered from the catalog read on connect when
   * it holds the name. That probe was a round trip before every list and
   * every count — two per page of rows, one per reference counted — to learn
   * what the catalog already said. A name the catalog does not hold (made
   * since) is still asked of the server; writes always are (assertTable),
   * because a view created since connecting must still refuse one.
   */
  private async readTable(id: string): Promise<Located> {
    const dot = id.indexOf('.');
    const schema = dot === -1 ? 'public' : id.slice(0, dot);
    if (RESERVED_SCHEMAS.includes(schema)) throw new Refusal('Reserved resources are runtime-only.');
    const known = this.cachedSchema?.tables.find((table) => table.id === id);
    if (known?.schema && !RESERVED_SCHEMAS.includes(known.schema)) {
      return { schema: known.schema, name: known.name, kind: known.isView ? 'v' : 'r', isView: known.isView };
    }
    return this.assertTable(id);
  }

  private epochOf = (db: PgQuery | undefined): string | undefined =>
    (db ? this.txEpochs.get(db) : undefined) ?? (this.epochStore === false ? epochlessEpoch() : undefined);

  private async assertTable(id: string, db?: PgQuery): Promise<Located> {
    return assertPostgresTable(id, db, this.epochOf(db), this.catalogCache, () => this.conn());
  }
}

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
function verifierPin(verify: PostgresTransactionVerifier | undefined): string | undefined {
  const pin = verify?.pin;
  return typeof pin === 'string' && /^LOCK TABLE [^;$]+ IN [A-Z ]+ MODE(; LOCK TABLE [^;$]+ IN [A-Z ]+ MODE)*$/.test(pin) ? pin : undefined;
}

/* The row scope an unscoped transaction's kept rows are filed under (keyRows.ts): none, the same object every time. */
const PLAIN_SCOPE: RowScope = Object.freeze({});

/* The record locks a transaction took behind its BEGIN (openPlain), by statement, each with what marks it taken.
   Only those: a lock taken later could be let go by a ROLLBACK TO SAVEPOINT, one taken at the opening cannot. */
const heldLocks = new WeakMap<PgQuery, Map<string, () => void>>();
/* Of those, the ones that found their row: it is the transaction's, unmoving, until it ends (openPlain's `widen`). */
const heldRows = new WeakMap<PgQuery, Set<string>>();
const lockKey = (text: string, values: readonly unknown[]) => JSON.stringify([text, values]);
/* lockRecordNow's statement for a row named by its whole primary key, and its values. */
function rowLockStatement(table: TableMeta, key: Readonly<Record<string, string | number>>): [string, unknown[]] {
  const pk = table.columns.filter((column) => column.primaryKey).map((column) => column.name);
  const where = buildWhere({ groups: [pk.map((column) => ({ column, op: '=' as const, value: key[column] }))] }, POSTGRES_STYLE);
  return [`SELECT ${pk.map(POSTGRES_STYLE.quote).join(', ')} FROM ${qualified(table)}${where.text} FOR UPDATE`, where.params];
}

/* A table's schema and name from the name a request gives it, as assertPostgresTable reads it. */
function plainTable(table: string): { schema: string; name: string } {
  const dot = table.indexOf('.');
  return dot === -1 ? { schema: 'public', name: table } : { schema: table.slice(0, dot), name: table.slice(dot + 1) };
}

/* A table's catalog id from the name a request gives it: a bare name is in the public schema, as assertPostgresTable reads it. */
const catalogId = (table: string) => (table.includes('.') ? table : `public.${table}`);

/* The statement queryOn sends for an unordered read, without sending it: the table as its id names it
   (assertPostgresTable), the read bounded as every read is. */
function plainStatement(request: QueryRequest): SqlFragment | undefined {
  if (request.orderBy?.length) return undefined;
  const at = plainTable(request.table);
  const where = buildWhere(request.filter, POSTGRES_STYLE);
  const cols = request.columns?.length ? request.columns.map((column) => POSTGRES_STYLE.quote(column)).join(', ') : '*';
  const n = where.params.length;
  return {
    text: `SELECT ${cols} FROM ${qualified(at)}${where.text} LIMIT $${n + 1} OFFSET $${n + 2}`,
    params: [...where.params, clampLimit(request.limit), clampOffset(request.offset)],
  };
}

/* A statement a scoped read would send, without sending it: createScopedReads
   compiles before it executes, so the executor is reached synchronously and
   says what it was handed. */
/** A row lock as a scoped transaction keeps it: its table and the filter that names the row. */
const rowLockKey = (table: TableMeta, filter: Filter) => `${table.id}\u0000${JSON.stringify(filter)}`;

function scopedStatement(schema: DatabaseSchema, within: RowScope, request: QueryRequest): SqlFragment | undefined {
  let said: SqlFragment | undefined;
  void createScopedReads(schema, within, POSTGRES_STYLE, async (sql) => {
    said = sql;
    return { columns: [], rows: [], ms: 0, sql };
  })
    .query(request)
    .catch(() => {});
  return said;
}

/* Statements sent ahead that a committed transaction never asked: a hint
   that no longer says what the transaction does. Warned once per statement
   outside production; a refused transaction stops early, and leaves some by
   design. With MISTRI_AHEAD_REPORT set, every transaction's account is a line
   on stderr (e2e/write-storm.spec.ts reads it). */
const warnedAhead = new Set<string>();
function reportWriteAhead(report: AheadReport | undefined, committed: boolean): void {
  if (!report || (!report.sent && !report.missed)) return;
  const said = (key: string) => {
    try {
      return String((JSON.parse(key) as unknown[])[0]).slice(0, 160);
    } catch {
      return key.slice(0, 160);
    }
  };
  if (process.env.MISTRI_AHEAD_REPORT)
    process.stderr.write(
      `mistri-ahead ${JSON.stringify({ at: Date.now(), committed, sent: report.sent, taken: report.taken, answered: report.answered, missed: report.missed, left: report.left.map(said), redone: report.redone, asked: report.asked })}\n`,
    );
  if (!committed || process.env.NODE_ENV === 'production') return;
  for (const statement of report.left.map(said)) {
    if (warnedAhead.has(statement)) continue;
    warnedAhead.add(statement);
    process.emitWarning(`A statement sent ahead was never asked by the transaction it was sent for: ${statement}`, 'MistriWriteAhead');
  }
}
