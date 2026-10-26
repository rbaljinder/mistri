/**
 * MySQL adapter, on `mysql2`.
 *
 * The catalog is `information_schema`, so introspection is four queries no
 * matter how many tables exist — the same trade the Postgres adapter makes,
 * and for the same reason: a schema with four hundred tables should cost one
 * round trip per *kind* of fact, not one per table.
 *
 * Two things about MySQL shape everything below.
 *
 * The first is that a database *is* a schema. There is no second level of
 * namespacing, so `TABLE_SCHEMA` in the catalog is what `USE` selects and what
 * a connection URL's path names. That makes the Postgres mapping exact rather
 * than approximate: a table's `schema` is its database and its `id` is
 * `database.table`, qualified in every statement as `` `shop`.`invoice` ``.
 * Naming the database in the statement is also what keeps a browsing session
 * honest when the connection's default database is not the one being read —
 * `USE` is a mutable, per-connection setting and nothing here relies on it.
 *
 * The second is that a MySQL connection has no read-only mode of its own, the
 * way a SQLite handle does. `SET SESSION TRANSACTION READ ONLY` is the closest
 * equivalent and it is a real one: with autocommit on, every statement is its
 * own transaction and inherits the session's access mode, so INSERT, UPDATE,
 * DELETE, TRUNCATE, CREATE and DROP all come back as error 1792 rather than
 * running. See `open` for what that does and does not cover.
 */
import {
  driver,
  type MysqlConnection,
  type FieldPacket,
  type OkPacket,
  type TableRow,
  type ColumnRow,
  type IndexRow,
  type KeyRow,
} from './mysqlDriver.js';
import {
  MYSQL_STYLE,
  buildWhere,
  clampLimit,
  boundStatement,
  dedupe,
  looksWrappable,
  refuseStacked,
  trimStatement,
  type DeleteRequest,
  type DeleteResult,
  type SqlRequest,
  type SqlResult,
  clampOffset,
  type Adapter,
  type Filter,
  type QueryRequest,
  type QueryResult,
  type ScopedReads,
  type TellRequest,
  type UpdateRequest,
  type UpdateResult,
  type InsertRequest,
  type InsertResult,
  type ExplainRequest,
  type ExplainResult,
  type ColumnProfile,
  type ProfileLimits,
  type ProfileResult,
  type ViewResult,
  type BreakdownResult,
  Refusal,
  WriteConflict,
  TransactionOperations,
  queueRecordLock,
  recordLockFilter,
  TransactionOutcomeUnknown,
  type WriteTransaction,
  refuseAnalyze,
  countStatement,
  countEachStatement,
  countEachRows,
  countsTogether,
  orderClause,
  type CountItem,
  type RolePrivileges,
} from './adapter.js';
import { mysqlPrivileges } from './rolePrivileges.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { WriteLanes, keyedLane, lockTimeoutMs, writerPoolSize, inBackgroundWork, type LaneKeys } from './writeLanes.js';
import { buildUpdateGuard } from './scoped/updateGuard.js';
import { compileView, compileViewCount, type ViewDef } from '../shared/view.js';
import { compileBreakdown, compileBreakdownCount, type BreakdownDef } from '../shared/breakdown.js';
import { typeVocabulary } from '../shared/vocabulary.js';
import { captureRowScope, type RowScope } from '../shared/rowScope.js';
import { createScopedReads } from './scoped/scopedReads.js';
import { refuseReservedText } from './reservedSql.js';
import { beginWriteCapture, capturesWrites, committedWriteCapture, finishWriteCapture } from './writeCapture.js';
import { lendStoreHost } from './storeHost.js';
import {
  cancellation,
  onCancel,
  STATEMENT_TIMEOUT_MS,
  statementCap,
  StatementStopped,
  stoppedReason,
  throwIfCancelled,
} from './statementControl.js';
import { coerceForColumn, deleteRuleOf, type ColumnMeta, type DatabaseSchema, type ForeignKey, type TableMeta } from '../shared/schema.js';
import { bindRowCounts, qualify, redact, rowCount, toJsonSafe, valueSafe, withBytes, type Located } from './mysqlValues.js';
import { mysqlSchemaEpochOf, mysqlSchemaEpochStatement } from './mysqlSchemaEpoch.js';
import { MAX_REPLICAS, noteWrite, primaryReads, ReplicaSet } from './replicas.js';
import { sealedMysqlOptions } from './net/untrustedDatabase.js';
import type { NetworkPolicy } from './net/networkPolicy.js';

/** The most read connections one MySQL database is read through at once:
 * the PostgreSQL pool's default, opened only as reads overlap. */
export const MYSQL_READERS = 4;

export class MysqlAdapter implements Adapter {
  readonly dialect = 'mysql' as const;
  private client: MysqlConnection | null = null;
  private openingPrimary: Promise<MysqlConnection> | undefined;
  /* The further read-only connections, opened only when reads overlap: a
     mysql2 connection runs one statement at a time, so a dashboard's dozen
     reads through one waited on each other. Each is opened by `open(true)`,
     read-only and capped exactly as the first. */
  private readers: MysqlConnection[] = [];
  private inFlight = new Map<MysqlConnection, number>();
  private openingReaders = 0;
  // Legacy reads may reconnect after close; already-bound scopes must expire.
  private scopeEpoch = 0;

  /* The writers, opened lazily, only when an edit is actually applied: up
     to `writerSize` at once, each leased for one write or transaction
     (withWriter). One for the database browser, whose writes run one at a
     time; an App's pool, with its writes ordered by record (writeLanes.ts). */
  private readonly writers = new Set<MysqlConnection>();
  private readonly foreground = { writers: new Set<MysqlConnection>(), idle: [] as MysqlConnection[], waiters: [] as Array<() => void> };
  private readonly background = { writers: new Set<MysqlConnection>(), idle: [] as MysqlConnection[], waiters: [] as Array<() => void> };
  private readonly writerGroups = new WeakMap<MysqlConnection, typeof this.foreground>();
  private readonly discarded = new WeakSet<MysqlConnection>();
  private readonly writerSize: number;
  /** The writer the current write holds: what writeHandle() answers inside withWriter. */
  private readonly leased = new AsyncLocalStorage<MysqlConnection>();
  private writes = new WriteLanes();
  /** This database's replicas, when the connection names any. */
  private readonly replicas?: ReplicaSet<MysqlAdapter>;

  /** Filled in on connect: the database the URL names, plus any extras. */
  private databases: string[] = [];

  constructor(
    private connectionString: string,
    private label = redact(connectionString),
    /**
     * Further databases to browse alongside the one the URL selects.
     *
     * Empty — the normal case — means just that one. A MySQL server hosts
     * every tenant's database side by side in one `information_schema`, so
     * introspecting the lot by default would hand someone browsing `shop`
     * four hundred tables belonging to people who are not them.
     */
    private extraDatabases: string[] = [],
    /** Writers held at once where an App writes; `--write-pool` (balanced to the cores) when absent. */
    writers?: number,
    /** Read replicas by URL: lag-tolerant reads go to them in turn (replicas.ts). */
    replicas: readonly string[] = [],
    /** Set when an untrusted client typed the address: its socket resolves through this policy (untrustedDatabase.ts). */
    private readonly network?: NetworkPolicy,
  ) {
    this.writerSize = this.writes.order === 'serial' ? 1 : (writers ?? writerPoolSize());
    if (replicas.length > MAX_REPLICAS)
      throw new RangeError(`A connection names at most ${MAX_REPLICAS} replicas; this one names ${replicas.length}.`);
    /* Each replica is an adapter of its own that only ever reads: its
       readers open as this one's do, read-only and capped, up to the same
       MYSQL_READERS. Its writers are never opened. */
    if (replicas.length) this.replicas = new ReplicaSet(replicas.map((url) => new MysqlAdapter(url, label, extraDatabases)));
    /* The App stores this database may hold read and write through these (stores/appStores.ts). */
    lendStoreHost(this, {
      dialect: 'mysql',
      database: () => this.databases[0] ?? '',
      withReader: async (work) => work(await this.conn()),
      withWriter: (work) => this.withWriter([], work),
    });
  }

  /** One statement on this adapter's own readers: what a primary asks of it as its replica. */
  private async replicaRead<T>(text: string, params: unknown[]): Promise<{ rows: T[]; fields: FieldPacket[] }> {
    return this.read<T>(await this.conn(), text, params);
  }

  /**
   * Run `work` in the lanes `keys` names (writeLanes.ts), holding a writer
   * of the pool for exactly its length. A writer a transaction discarded
   * (its outcome unknown, discardWriter) is never given to the next write.
   */
  private withWriter<T>(keys: LaneKeys, work: (write: MysqlConnection) => Promise<T>): Promise<T> {
    const epoch = this.scopeEpoch;
    const group = this.writes.order === 'keyed' && inBackgroundWork() ? this.background : this.foreground;
    return this.writes.run(keys, async () => {
      if (epoch !== this.scopeEpoch) throw new Refusal('This connection was closed.');
      // Resolve the allowed database set before any write names a table.
      await this.conn();
      const write = await this.leaseWriter(group, epoch);
      try {
        // A write's own reads are of the primary it writes.
        return await this.leased.run(write, () => primaryReads(() => work(write)));
      } finally {
        /* The person who wrote reads the primary for a while after (replicas.ts). */
        noteWrite();
        this.releaseWriter(write);
      }
    });
  }

  private async leaseWriter(group: typeof this.foreground, epoch: number): Promise<MysqlConnection> {
    for (;;) {
      if (epoch !== this.scopeEpoch) throw new Refusal('This connection was closed.');
      const idle = group.idle.pop();
      if (idle) return idle;
      if (group.writers.size < (group === this.background ? 1 : this.writerSize)) {
        // Reserve before opening: concurrent leases must respect the bound.
        const placeholder = {} as MysqlConnection;
        group.writers.add(placeholder);
        try {
          const write = await this.open(false);
          if (epoch !== this.scopeEpoch) {
            await write.end().catch(() => {});
            throw new Refusal('This connection was closed.');
          }
          group.writers.add(write);
          this.writers.add(write);
          this.writerGroups.set(write, group);
          return write;
        } finally {
          group.writers.delete(placeholder);
          group.waiters.shift()?.();
        }
      }
      await new Promise<void>((resolve) => group.waiters.push(resolve));
    }
  }

  private releaseWriter(write: MysqlConnection): void {
    const group = this.writerGroups.get(write)!;
    if (this.discarded.has(write) || !this.writers.has(write)) {
      this.writers.delete(write);
      group.writers.delete(write);
    } else group.idle.push(write);
    group.waiters.shift()?.();
  }

  private async conn(): Promise<MysqlConnection> {
    if (this.client) return this.client;
    if (this.openingPrimary) return this.openingPrimary;
    const epoch = this.scopeEpoch;
    const opening = this.openPrimary(epoch);
    this.openingPrimary = opening;
    try {
      return await opening;
    } finally {
      if (this.openingPrimary === opening) this.openingPrimary = undefined;
    }
  }

  private async openPrimary(epoch: number): Promise<MysqlConnection> {
    const client = await this.open(true);
    try {
      /* Asked of the server rather than parsed out of the URL, so a socket
         connection, a `?database=` parameter and a plain path all resolve the
         same way — and so the answer is the database the server actually put us
         in rather than the one we hoped for. */
      const [rows] = await client.query('SELECT DATABASE() AS db');
      const current = (rows as Array<{ db: string | null }>)[0]?.db ?? '';
      if (!current && !this.extraDatabases.length) {
        throw new Error('A MySQL URL has to name a database: mysql://user:password@host:3306/dbname');
      }
      if (epoch !== this.scopeEpoch) throw new Refusal('This connection was closed.');
      this.databases = [...new Set([current, ...this.extraDatabases].filter(Boolean))];
      this.client = client;
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      throw error;
    }
  }

  /**
   * Open a connection, read-only unless this is the write handle.
   *
   * The read-only part is enforced by the server, not by convention here:
   * `SET SESSION TRANSACTION READ ONLY` makes every subsequent statement on
   * this connection run in a read-only transaction, and MySQL answers a write
   * with ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION (1792). Verified against
   * MySQL 8.4 for INSERT, UPDATE, DELETE, TRUNCATE, CREATE TABLE, CREATE
   * TEMPORARY TABLE and DROP TABLE.
   *
   * What it does not cover: a user with SUPER could turn it off again by
   * running `SET SESSION TRANSACTION READ WRITE`, and nothing stops a stored
   * procedure called from a SELECT from writing. Neither is reachable through
   * this adapter — it only ever sends the statements it builds — but the
   * guarantee is "this connection refuses writes", not "this connection could
   * not write under any circumstances", and it is worth being exact about
   * which of those is true.
   */
  private async open(readOnly: boolean, capMs: number = STATEMENT_TIMEOUT_MS): Promise<MysqlConnection> {
    const createConnection = await driver();
    const client = await createConnection({
      uri: this.connectionString,
      ...(this.network ? sealedMysqlOptions(this.connectionString, this.network) : {}),
      /* A stacked `; DROP TABLE customer` has to be a syntax error rather than
         a second statement. It is mysql2's default; set explicitly because the
         entire safety argument here rests on one statement per call. */
      multipleStatements: false,
      /* DATETIME and TIMESTAMP arrive as the text the server stores. A JS Date
         would be read in the process's local zone and written back out as UTC,
         so `2025-03-14 00:00:00` would be shown as the 13th to anyone east of
         Greenwich — a browsing tool inventing an offset the column does not
         have. The query language's date windows are the same text format, so
         filters and displayed values also stay comparable. */
      dateStrings: true,
      /* A BIGINT past 2^53 becomes a string rather than a silently wrong
         number. Losing the last digits of an id is the kind of error that
         looks fine on screen and matches nothing when clicked. */
      supportBigNumbers: true,
      connectTimeout: 15_000,
    });
    if (!readOnly) {
      /* A writer stops waiting for a row lock after the process's lock
         timeout (writeLanes.ts), in whole seconds, the unit InnoDB takes:
         the statement fails with 1205 and its transaction is rolled back,
         rather than holding this writer for InnoDB's default fifty. */
      await client.query(`SET SESSION innodb_lock_wait_timeout = ${Math.max(1, Math.ceil(lockTimeoutMs() / 1000))}`).catch(() => {});
      return client;
    }

    await client.query('SET SESSION TRANSACTION READ ONLY');
    try {
      await client.query(`SET SESSION max_execution_time = ${capMs}`);
    } catch {
      /* MariaDB spells this `max_statement_time` and measures it in seconds.
         A missing statement timeout is worth a slow query, not a refusal to
         open the connection at all. */
      await client.query(`SET SESSION max_statement_time = ${capMs / 1000}`).catch(() => {});
    }
    return client;
  }

  /** The account's reach, from its grants (rolePrivileges.ts). */
  async privileges(): Promise<RolePrivileges> {
    const [rows] = await (await this.conn()).query('SHOW GRANTS');
    return mysqlPrivileges(
      (rows as Array<Record<string, unknown>>).map((row) => String(Object.values(row)[0] ?? '')),
      this.databases,
    );
  }

  /* The catalog is the primary's: a replica a migration has not reached would describe the old one. */
  introspect(): Promise<DatabaseSchema> {
    return primaryReads(() => this.introspectNow());
  }

  private async introspectNow(): Promise<DatabaseSchema> {
    const db = await this.conn();
    /* Read before anything it describes, never after (epochCache.ts): a change
       landing between the two leaves this copy under an epoch no later read
       matches, so it is derived again rather than trusted past a change. */
    const epoch = await this.catalogEpoch(db);
    const holes = this.databases.map(() => '?').join(', ');

    const tableRows = await this.read<TableRow>(
      db,
      `SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT
         FROM information_schema.TABLES
        WHERE TABLE_SCHEMA IN (${holes})
        ORDER BY TABLE_SCHEMA, TABLE_NAME`,
      this.databases,
    );
    const wanted = new Set(tableRows.rows.map((r) => `${r.TABLE_SCHEMA}.${r.TABLE_NAME}`));

    const columnRows = await this.read<ColumnRow>(
      db,
      `SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE,
              COLUMN_DEFAULT, COLUMN_KEY, COLUMN_COMMENT, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA IN (${holes})
        ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION`,
      this.databases,
    );

    /* Only the leading column of each index, which is the only one an ORDER BY
       can be satisfied by: an index on (customer_id, opened_at) makes
       `ORDER BY customer_id` free and `ORDER BY opened_at` a full sort. The
       primary key is in here too, because MySQL reports it as an index named
       PRIMARY and it is the default order's last resort.

       A functional index (8.0.13 and later) has a NULL COLUMN_NAME and an
       EXPRESSION instead; it is dropped, as it should be, since there is no
       bare column for a sort to lean on. */
    const indexRows = await this.read<IndexRow>(
      db,
      `SELECT TABLE_SCHEMA, TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, NON_UNIQUE, COLUMN_NAME
         FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA IN (${holes})`,
      this.databases,
    );

    /* KEY_COLUMN_USAGE carries one row per column of a key, so a two-column
       foreign key is two rows to be collapsed by ORDINAL_POSITION — the same
       shape SQLite's PRAGMA returns. The join to REFERENTIAL_CONSTRAINTS is
       what makes these foreign keys specifically: KEY_COLUMN_USAGE also lists
       primary and unique keys, which have no referenced table and would
       otherwise have to be filtered by a NULL check standing in for a fact the
       catalog states directly. */
    const keyRows = await this.read<KeyRow>(
      db,
      `SELECT k.CONSTRAINT_NAME, k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME,
              k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
              r.DELETE_RULE
         FROM information_schema.KEY_COLUMN_USAGE k
         JOIN information_schema.REFERENTIAL_CONSTRAINTS r
           ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
          AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
          AND r.TABLE_NAME = k.TABLE_NAME
        WHERE k.TABLE_SCHEMA IN (${holes})
        ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      this.databases,
    );

    const foreignKeys: ForeignKey[] = [];
    /* A column-level reference map, so the table view can show "this column
       points there" without searching the whole key list per cell. */
    const refByColumn = new Map<string, { table: string; column: string }>();
    const byConstraint = new Map<string, KeyRow[]>();
    for (const row of keyRows.rows) {
      /* Keyed by table as well as constraint name: MySQL only requires a
         foreign key name to be unique within its database, so two tables may
         each have an `fk_customer` and grouping by name alone would weld them
         into one four-column key pointing at the wrong thing. */
      const id = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}.${row.CONSTRAINT_NAME}`;
      const list = byConstraint.get(id) ?? [];
      list.push(row);
      byConstraint.set(id, list);
    }
    for (const group of byConstraint.values()) {
      const from = `${group[0].TABLE_SCHEMA}.${group[0].TABLE_NAME}`;
      const to = `${group[0].REFERENCED_TABLE_SCHEMA}.${group[0].REFERENCED_TABLE_NAME}`;
      // A key can point at a database this session is not browsing. Those
      // edges lead nowhere the user can click, so they are dropped rather
      // than drawn broken.
      if (!wanted.has(from) || !wanted.has(to)) continue;
      foreignKeys.push({
        name: group[0].CONSTRAINT_NAME,
        from: { table: from, columns: group.map((r) => r.COLUMN_NAME) },
        to: { table: to, columns: group.map((r) => r.REFERENCED_COLUMN_NAME) },
        onDelete: deleteRuleOf(group[0].DELETE_RULE),
      });
      for (const row of group) {
        refByColumn.set(`${from}.${row.COLUMN_NAME}`, {
          table: to,
          column: row.REFERENCED_COLUMN_NAME,
        });
      }
    }

    const indexedByTable = new Map<string, Set<string>>();
    /* Every column of every index is read, so an index's width is known: a
       unique index of one named column makes that column unique alone (an
       App's natural-key address). MySQL has no partial indexes. */
    const parts = new Map<string, IndexRow[]>();
    for (const row of indexRows.rows) {
      const id = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      const index = `${id}\u0000${row.INDEX_NAME}`;
      parts.set(index, [...(parts.get(index) ?? []), row]);
      if (Number(row.SEQ_IN_INDEX) !== 1 || row.COLUMN_NAME === null) continue;
      const set = indexedByTable.get(id) ?? new Set<string>();
      set.add(row.COLUMN_NAME);
      indexedByTable.set(id, set);
    }
    const uniqueByTable = new Map<string, Set<string>>();
    const pairsByTable = new Map<string, Array<[string, string]>>();
    for (const rows of parts.values()) {
      // Two named columns unique together: a natural key within a tenant.
      if (rows.length === 2 && rows.every((row) => Number(row.NON_UNIQUE) === 0 && row.COLUMN_NAME !== null)) {
        const [first, second] = [...rows].sort((a, b) => Number(a.SEQ_IN_INDEX) - Number(b.SEQ_IN_INDEX));
        const id = `${first.TABLE_SCHEMA}.${first.TABLE_NAME}`;
        pairsByTable.set(id, [...(pairsByTable.get(id) ?? []), [first.COLUMN_NAME!, second.COLUMN_NAME!]]);
      }
      if (rows.length !== 1 || Number(rows[0].NON_UNIQUE) !== 0 || rows[0].COLUMN_NAME === null) continue;
      const id = `${rows[0].TABLE_SCHEMA}.${rows[0].TABLE_NAME}`;
      uniqueByTable.set(id, (uniqueByTable.get(id) ?? new Set<string>()).add(rows[0].COLUMN_NAME));
    }

    const columnsByTable = new Map<string, ColumnRow[]>();
    for (const row of columnRows.rows) {
      const id = `${row.TABLE_SCHEMA}.${row.TABLE_NAME}`;
      if (!wanted.has(id)) continue;
      const list = columnsByTable.get(id) ?? [];
      list.push(row);
      columnsByTable.set(id, list);
    }

    const tables: TableMeta[] = tableRows.rows.map((t) => {
      const id = `${t.TABLE_SCHEMA}.${t.TABLE_NAME}`;
      const isView = t.TABLE_TYPE !== 'BASE TABLE';
      const columns: ColumnMeta[] = (columnsByTable.get(id) ?? []).map((c) => ({
        name: c.COLUMN_NAME,
        /* The declared type verbatim, `tinyint(1)` included. MySQL has no
           boolean: BOOL and BOOLEAN are spellings of TINYINT(1), and the
           values really are 0 and 1. Rewriting the type to "boolean" would
           make `active = true` coerce to a JavaScript true and read as a
           promise the column does not make; left as declared, the same filter
           coerces to 1, which is what is stored. */
        type: c.COLUMN_TYPE,
        nullable: c.IS_NULLABLE === 'YES',
        primaryKey: c.COLUMN_KEY === 'PRI',
        references: refByColumn.get(`${id}.${c.COLUMN_NAME}`),
        default: c.COLUMN_DEFAULT ?? undefined,
        identity: /\bauto_increment\b/i.test(c.EXTRA ?? '') ? 'by-default' : undefined,
        comment: c.COLUMN_COMMENT || undefined,
        /* MySQL writes the vocabulary into the type itself — `enum('draft',
           'open')` — so the declared type already carries it. */
        allowed: typeVocabulary(c.COLUMN_TYPE),
      }));
      return {
        name: t.TABLE_NAME,
        schema: t.TABLE_SCHEMA,
        id,
        columns,
        /* InnoDB's TABLE_ROWS comes from a handful of random index dives, not
           a count: it is routinely out by a factor of two and can be out by an
           order of magnitude on a table with a long update history. Fine for
           "roughly how big is this" in a sidebar, wrong for anything a user
           would act on — which is why `count()` exists and this never feeds
           it. A view reports NULL, and stays undefined rather than becoming a
           confident zero. */
        approxRows: t.TABLE_ROWS === null ? undefined : Math.max(0, Number(t.TABLE_ROWS) || 0),
        /* MySQL puts the literal word VIEW in a view's TABLE_COMMENT rather
           than leaving it empty, so passing it through would caption every
           view in the sidebar with its own kind. */
        comment: isView && t.TABLE_COMMENT === 'VIEW' ? undefined : t.TABLE_COMMENT || undefined,
        isView,
        // Always an array, because this always looked. Absent would mean the
        // adapter did not, and the default order reads the difference.
        indexed: [...(indexedByTable.get(id) ?? [])],
        ...(uniqueByTable.get(id)?.size ? { unique: [...uniqueByTable.get(id)!] } : {}),
        ...(pairsByTable.get(id)?.length ? { uniquePairs: pairsByTable.get(id)! } : {}),
      };
    });

    const schema: DatabaseSchema = {
      label: this.label,
      dialect: this.dialect,
      tables,
      foreignKeys,
      readAt: new Date().toISOString(),
    };
    /* Seeded, not only returned: the registry introspects on connect, and the
       view, breakdown and read paths resolve against this copy. */
    this.cachedSchema = schema;
    this.cachedEpoch = epoch;
    return schema;
  }

  /*
   * Why there is no `ddl()` here.
   *
   * MySQL has SHOW CREATE TABLE, and it is tempting: it includes indexes,
   * foreign keys, the engine and the charset, all of which the catalog
   * reconstruction leaves out. But it is the server re-rendering the data
   * dictionary, not the statement its author wrote — comments are gone,
   * type spellings are normalised, defaults are re-quoted — and the interface
   * labels an adapter-supplied definition "the statement the database itself
   * keeps, verbatim". Offering a faithful reconstruction under a promise of
   * verbatim text would be a worse lie than the honest "Reconstructed" label
   * the fallback already carries.
   */

  async query(request: QueryRequest): Promise<QueryResult> {
    return this.queryOn(request, await this.conn(), true);
  }

  private async queryOn(request: QueryRequest, db: MysqlConnection, read = false): Promise<QueryResult> {
    const table = read ? await this.readTable(request.table, db) : await this.assertTable(request.table, db);
    const where = buildWhere(request.filter, MYSQL_STYLE);
    const cols = request.columns?.length ? request.columns.map((c) => MYSQL_STYLE.quote(c)).join(', ') : '*';
    const order = orderClause(
      request.orderBy,
      request.orderBy?.length ? (await this.schema()).tables.find((t) => t.id === request.table) : undefined,
      MYSQL_STYLE,
      1,
    );
    /* Every read is bounded. There is no code path that reaches the database
       without a LIMIT, including one that forgot to ask for one. */
    const limit = clampLimit(request.limit);

    const text = `SELECT ${cols} FROM ${qualify(table)}${where.text}${order.text} LIMIT ? OFFSET ?`;
    const params = [...where.params, ...order.params, rowCount(limit), rowCount(clampOffset(request.offset))];

    const started = performance.now();
    const result = await this.read<Record<string, unknown>>(db, text, params);
    const ms = Math.round(performance.now() - started);

    return {
      // From the field list rather than the first row, so an empty result
      // still renders its headers instead of collapsing to nothing.
      columns: result.fields.map((f) => f.name),
      rows: result.rows.map(request.binary ? withBytes : toJsonSafe),
      ms,
      sql: { text, params },
    };
  }

  async scopeReads(input: RowScope): Promise<ScopedReads> {
    const epoch = this.scopeEpoch;
    // Capture before metadata I/O: callers cannot change an in-flight policy.
    const scope = captureRowScope(input);
    const assertActive = () => {
      if (epoch !== this.scopeEpoch) throw new Refusal('This scoped reader is no longer active.');
    };
    const schema = await this.schema();
    assertActive();
    return createScopedReads(schema, scope, MYSQL_STYLE, async (compiled) => {
      assertActive();
      const db = await this.conn();
      assertActive();
      const params = bindRowCounts(compiled.text, compiled.params);
      const started = performance.now();
      const result = await this.read<Record<string, unknown>>(db, compiled.text, params);
      return {
        columns: result.fields.map((field) => field.name),
        rows: result.rows.map(toJsonSafe),
        ms: Math.round(performance.now() - started),
        sql: { text: compiled.text, params },
      };
    });
  }

  /**
   * Run a compiled view.
   *
   * As in the other adapters, everything hard happened in `compileView`:
   * paths resolved against the catalog, joins planned, values reduced to bound
   * parameters. Nothing here needs to check that the tables exist, because the
   * only identifiers that reach the quoting step are ones the catalog
   * produced.
   */
  async runView(view: ViewDef, offset = 0): Promise<ViewResult> {
    const db = await this.conn();
    const schema = await this.schema();
    /* Every read is bounded, views included: `compileView` runs the limit
       through `clampLimit` and emits LIMIT unconditionally. */
    const compiled = compileView(schema, view, MYSQL_STYLE, offset);
    const params = bindRowCounts(compiled.text, compiled.params);

    const started = performance.now();
    const result = await this.read<Record<string, unknown>>(db, compiled.text, params);
    const ms = Math.round(performance.now() - started);

    return {
      columns: compiled.columns.map((c) => c.name),
      rows: result.rows.map(toJsonSafe),
      ms,
      sql: { text: compiled.text, params },
      resolved: compiled.columns,
      joins: compiled.joins,
    };
  }

  async runBreakdown(breakdown: BreakdownDef, offset = 0): Promise<BreakdownResult> {
    const db = await this.conn();
    const compiled = compileBreakdown(await this.schema(), breakdown, MYSQL_STYLE, offset);
    /* The same treatment a view's LIMIT gets: mysql2 binds a number as a
       string over the prepared protocol, and `LIMIT '20'` is a syntax error. */
    const params = bindRowCounts(compiled.text, compiled.params);

    const started = performance.now();
    const result = await this.read<Record<string, unknown>>(db, compiled.text, params);
    return {
      columns: compiled.columns.map((c) => c.name),
      rows: result.rows.map(toJsonSafe),
      ms: Math.round(performance.now() - started),
      sql: { text: compiled.text, params },
      resolved: compiled.columns,
    };
  }

  async countBreakdown(breakdown: BreakdownDef, limit?: number): Promise<number> {
    const db = await this.conn();
    const compiled = compileBreakdownCount(await this.schema(), breakdown, MYSQL_STYLE, undefined, limit);
    const result = await this.read<{ n: number | string }>(db, compiled.text, compiled.params);
    return Number(result.rows[0]?.n ?? 0);
  }

  async countView(view: ViewDef, limit?: number): Promise<number> {
    const db = await this.conn();
    const compiled = compileViewCount(await this.schema(), view, MYSQL_STYLE, undefined, limit);
    const result = await this.read<{ n: number | string }>(db, compiled.text, compiled.params);
    return Number(result.rows[0]?.n ?? 0);
  }

  /* Introspection is four catalog queries; a view preview runs on every
     keystroke. The copy is kept under the catalog's epoch
     (mysqlSchemaEpoch.ts) and served only to a caller that reads the same
     epoch now: one cheap statement per request instead of a cache that
     outlived a migration until someone pressed reload. An epoch that cannot
     be read is a miss, never an answer. */
  private cachedSchema: DatabaseSchema | null = null;
  private cachedEpoch: string | undefined;

  private async catalogEpoch(db: MysqlConnection): Promise<string | undefined> {
    try {
      const { text, params } = mysqlSchemaEpochStatement(this.databases);
      return mysqlSchemaEpochOf((await this.read<Record<string, unknown>>(db, text, params)).rows);
    } catch (error) {
      if (error instanceof StatementStopped) throw error;
      return undefined;
    }
  }

  private async schema(): Promise<DatabaseSchema> {
    if (this.cachedSchema && this.cachedEpoch !== undefined && this.cachedEpoch === (await this.catalogEpoch(await this.conn())))
      return this.cachedSchema;
    return this.introspect();
  }

  /**
   * `TABLE_ROWS` from `information_schema`.
   *
   * InnoDB computes this from a handful of index dives, so it can be out by a
   * large factor — the manual says up to 50%, and in practice worse on a table
   * with skewed key distribution. That is tolerable for "is this table big",
   * which is the only question being asked of it, and it is why the number is
   * labelled an estimate wherever it appears.
   *
   * NULL for a view, where it means "not applicable" rather than zero.
   */
  async estimateCount(table: string): Promise<number | undefined> {
    const db = await this.conn();
    const { schema, name } = await this.readTable(table, db);
    const { rows } = await this.read<{ TABLE_ROWS: number | null }>(
      db,
      `SELECT TABLE_ROWS FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, name],
    );
    const n = rows[0]?.TABLE_ROWS;
    return n === null || n === undefined ? undefined : Math.max(0, Number(n));
  }

  async count(table: string, filter?: Filter, limit?: number): Promise<number> {
    return this.countOn(table, filter, await this.conn(), limit, true);
  }

  async countEach(items: readonly CountItem[], limit?: number): Promise<number[]> {
    const db = await this.conn();
    const relations: Array<{ relation: string; filter?: Filter }> = [];
    for (const item of items) relations.push({ relation: qualify(await this.readTable(item.table, db)), filter: item.filter });
    const statement = countEachStatement(relations, MYSQL_STYLE, { limit, together: countsTogether(this.cachedSchema, items, limit) });
    const result = await this.read<Record<string, unknown>>(db, statement.text, statement.params);
    return countEachRows(result.rows, items.length);
  }

  private async countOn(table: string, filter: Filter | undefined, db: MysqlConnection, limit?: number, read = false): Promise<number> {
    const found = read ? await this.readTable(table, db) : await this.assertTable(table, db);
    const where = buildWhere(filter, MYSQL_STYLE);
    const text = countStatement(`${qualify(found)}${where.text}`, limit);
    const result = await this.read<{ n: number | string }>(db, text, where.params);
    return Number(result.rows[0]?.n ?? 0);
  }

  /**
   * The write path, on its own handle.
   *
   * `this.client` refuses writes for the life of the process, so browsing can
   * never write no matter what the UI believes. A second connection — without
   * the read-only session setting — is opened the first time an edit is
   * actually applied.
   *
   * The guards are the SQLite adapter's, one for one, because an edit refused
   * on SQLite and allowed on MySQL would mean the safety of a cell editor
   * depended on which database it was pointed at.
   */
  async update(request: UpdateRequest): Promise<UpdateResult> {
    // A table that keeps a history is written with its row, or not at all.
    const lane = keyedLane(request);
    if (this.recordsHistory(request)) return this.transact(lane, (tx) => tx.update(request));
    return this.withWriter(lane, () => this.updateNow(request));
  }

  private async updateNow(request: UpdateRequest, db?: MysqlConnection): Promise<UpdateResult> {
    const transactional = db !== undefined;
    db ??= await this.conn();
    const table = await this.assertTable(request.table, db);
    const id = `${table.schema}.${table.name}`;
    /* MySQL will happily update through a simple view, and the update lands on
       the table underneath. Refused here: what the editor showed and what
       changed are then two different objects, and `isView` already tells the
       interface this is read-only. */
    if (table.isView) {
      throw new Refusal(`${id} is a view, so no single row can be identified.`);
    }

    const meta = await this.read<ColumnRow>(
      db,
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table.schema, table.name],
    );

    /* COLUMN_KEY is 'PRI' for primary key columns only — a unique index reads
       'UNI' and a non-unique one 'MUL' — so this is the declared primary key
       and not merely something unique-looking. An InnoDB table without one has
       a hidden clustered key that cannot be named in a WHERE clause, which is
       exactly the case this refuses. */
    const pk = meta.rows.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME);
    if (!pk.length) throw new Refusal(`${id} has no primary key, so no single row can be identified.`);

    const keyColumns = Object.keys(request.key);
    /* The key must be the whole primary key and nothing else. Accepting a
       partial key would let a two-column key match a whole group of rows,
       and accepting extra columns would let the caller widen the match. */
    const same = keyColumns.length === pk.length && pk.every((c) => keyColumns.includes(c));
    if (!same) {
      throw new Refusal(`Updating ${id} needs exactly its primary key (${pk.join(', ')}).`);
    }

    const entries = Object.entries(request.values ?? {});
    if (!entries.length) throw new Refusal('Nothing to update.');

    const applied: Record<string, string | number | boolean | null> = {};
    for (const [column, raw] of entries) {
      const declared = meta.rows.find((c) => c.COLUMN_NAME === column);
      if (!declared) throw new Refusal(`${id} has no column called "${column}".`);
      if (pk.includes(column)) {
        // Editing a key in place silently repoints every row that referenced
        // it, or fails on the constraint. Neither belongs behind an editor.
        throw new Refusal(`"${column}" is part of the primary key and cannot be edited here.`);
      }
      /* Coerced against the declared type, because everything typed into a
         text box arrives as a string — including "17901" for a DECIMAL. */
      applied[column] = coerceForColumn(declared.COLUMN_TYPE || '', raw);
      if (applied[column] === null && declared.IS_NULLABLE === 'NO') {
        throw new Refusal(`"${column}" is NOT NULL and cannot be emptied.`);
      }
    }

    const filter: Filter = {
      groups: [pk.map((column) => ({ column, op: '=' as const, value: request.key[column] }))],
    };

    /* Transaction preflights see earlier writes on their own connection. */
    const matches = await (db === this.client ? this.count(id, filter) : this.countOn(id, filter, db));
    if (matches !== 1) {
      if (request.expected !== undefined && matches === 0) throw new WriteConflict();
      throw new Refusal(
        `Refused: that key matches ${matches} rows, not 1. An update is only allowed when it is certain which row it changes.`,
      );
    }

    const where = buildWhere(filter, MYSQL_STYLE);
    const assignments = Object.keys(applied)
      .map((c) => `${MYSQL_STYLE.quote(c)} = ?`)
      .join(', ');
    const guard = buildUpdateGuard(
      request,
      Object.fromEntries(meta.rows.map((column) => [column.COLUMN_NAME, column.COLUMN_TYPE])),
      MYSQL_STYLE,
      'mysql',
      1,
    );
    const text = `UPDATE ${qualify(table)} SET ${assignments}${where.text}${guard.text}`;
    const params = [...Object.values(applied), ...where.params, ...guard.params];

    const write = transactional ? db : await this.writeHandle();
    const [result] = await write.execute(text, params);
    if (request.expected !== undefined && Number((result as OkPacket)?.affectedRows ?? 0) === 0) throw new WriteConflict();
    /* mysql2 connects with CLIENT_FOUND_ROWS, so `affectedRows` counts the
       rows matched rather than the rows whose bytes changed. Without it,
       saving a cell without changing its value would report zero rows and the
       editor would tell the user the write failed. */
    return {
      affected: Number((result as OkPacket)?.affectedRows ?? 0),
      applied,
      sql: { text, params },
    };
  }

  /**
   * Add one row.
   *
   * The guards are `update`'s where they apply, with the key rules inverted:
   * a primary key may be supplied or left for AUTO_INCREMENT to assign.
   * MySQL 8 has no RETURNING, so the stored row is read back by its key —
   * `insertId` for an auto-assigned one, the supplied values otherwise. A
   * table where neither identifies the row (a composite key only partly
   * supplied) still inserts; it just cannot be read back, and the result
   * says so by carrying no row rather than guessing at one.
   */
  async insert(request: InsertRequest): Promise<InsertResult> {
    // A new row has no lane of its own: nothing earlier can be writing it.
    if (this.recordsHistory(request)) return this.transact([], (tx) => tx.insert(request));
    return this.withWriter([], () => this.insertNow(request));
  }

  private async insertNow(request: InsertRequest, db?: MysqlConnection): Promise<InsertResult> {
    const transactional = db !== undefined;
    db ??= await this.conn();
    const table = await this.assertTable(request.table, db);
    const id = `${table.schema}.${table.name}`;
    if (table.isView) {
      throw new Refusal(`${id} is a view. Insert into the table underneath it.`);
    }
    // A successful ROLLBACK cannot undo a MyISAM/MEMORY insert. Validate on
    // the captured writer before DML, within the transaction's failure queue.
    if (transactional) await this.assertInnoDB(table, db);

    const meta = await this.read<ColumnRow>(
      db,
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, EXTRA
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
        ORDER BY ORDINAL_POSITION`,
      [table.schema, table.name],
    );

    const entries = Object.entries(request.values ?? {});

    const applied: Record<string, string | number | boolean | null> = {};
    for (const [column, raw] of entries) {
      const declared = meta.rows.find((c) => c.COLUMN_NAME === column);
      if (!declared) throw new Refusal(`${id} has no column called "${column}".`);
      applied[column] = coerceForColumn(declared.COLUMN_TYPE || '', raw);
      if (applied[column] === null && declared.IS_NULLABLE === 'NO') {
        throw new Refusal(`"${column}" is NOT NULL and cannot be null. Leave it out to use its default, if it has one.`);
      }
    }

    const columns = Object.keys(applied);
    const text =
      `INSERT INTO ${qualify(table)} (${columns.map((c) => MYSQL_STYLE.quote(c)).join(', ')})` +
      ` VALUES (${columns.map(() => '?').join(', ')})`;
    const params = Object.values(applied);

    const write = transactional ? db : await this.writeHandle();
    const [result] = await write.execute(text, params);

    const pk = meta.rows.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME);
    const assigned = (result as OkPacket)?.insertId ?? 0;
    const hasAssigned = typeof assigned === 'string' ? /^[1-9]\d*$/.test(assigned) : Number.isSafeInteger(assigned) && assigned > 0;
    const generated = meta.rows.find((c) => /\bauto_increment\b/i.test(c.EXTRA ?? ''))?.COLUMN_NAME;
    // insertId belongs to the AUTO_INCREMENT column, which need not be the
    // whole primary key (or any part of it). Never attribute it to another key.
    const parts = pk.map((c) => [c, c === generated && hasAssigned ? assigned : applied[c]] as const);
    const key: Record<string, string | number> = parts.every(([, value]) => value !== undefined && value !== null)
      ? (Object.fromEntries(parts) as Record<string, string | number>)
      : {};

    let row: Record<string, unknown> | undefined;
    if (pk.length && pk.every((c) => key[c] !== undefined)) {
      const where = buildWhere({ groups: [pk.map((column) => ({ column, op: '=' as const, value: key[column] }))] }, MYSQL_STYLE);
      /* On the *write* connection. Inside `transaction()` the row is not
         yet committed, and the read connection — REPEATABLE READ, its own
         snapshot — cannot see it: `row` came back undefined and a graph's
         `{ref, column}` reference then had no row to point at. The handle
         that wrote it is the one that can read it. */
      const back = await this.read<Record<string, unknown>>(write, `SELECT * FROM ${qualify(table)}${where.text}`, where.params as never[]);
      row = back.rows[0];
    }

    return { key, row, applied, sql: { text, params } };
  }

  /**
   * EXPLAIN, tabular, one line per row.
   *
   * Plain EXPLAIN rather than FORMAT=TREE, because MariaDB does not speak
   * TREE and this adapter serves both. Each row becomes its columns said as
   * `name=value` pairs with the empties dropped — not as pretty as the tree,
   * and the same words on every engine this connects to. EXPLAIN plans and
   * never executes, on the ordinary read connection.
   */
  async explainSql(request: ExplainRequest): Promise<ExplainResult> {
    const stacked = refuseStacked(request.text);
    if (stacked) throw new Error(stacked);
    const analyze = refuseAnalyze(request.text);
    if (analyze) throw new Error(analyze);
    if (request.refuseReserved) refuseReservedText(request.text, 'mysql');
    const db = await this.conn();
    const started = performance.now();
    const { rows } = await this.read<Record<string, unknown>>(
      db,
      `EXPLAIN ${trimStatement(request.text)}`,
      (request.params ?? []) as never[],
    );
    const plan = rows.map((r) =>
      Object.entries(r)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `${k}=${v}`)
        .join('  '),
    );
    return { plan, ms: Math.round(performance.now() - started) };
  }

  /**
   * What the columns hold, by looking.
   *
   * MySQL keeps index cardinality, not null shares — histograms exist but
   * only where someone ran ANALYZE ... UPDATE HISTOGRAM — so this reads the
   * table the way the SQLite adapter does, with the same escape hatch:
   * above `scanAtMost` rows it samples every k-th row of a single integer
   * key, or the first N where the key does not allow the arithmetic, and
   * `source` says which happened.
   */
  async profile(table: string, limits?: ProfileLimits): Promise<ProfileResult> {
    const db = await this.conn();
    const found = await this.assertTable(table);
    const id = `${found.schema}.${found.name}`;
    const schema = await this.schema();
    const meta = schema.tables.find((t) => t.id === id);
    if (!meta) throw new Error(`No table or view called "${id}" on this connection.`);
    const q = (c: string) => MYSQL_STYLE.quote(c);
    const scanAtMost = limits?.scanAtMost ?? 200_000;
    const sampleSize = limits?.sampleSize ?? 100_000;
    const started = performance.now();

    const counted = await this.read<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${qualify(found)}`, []);
    const total = Number(counted.rows[0]?.n ?? 0);

    let from = qualify(found);
    let source: ProfileResult['source'] = 'scan';
    if (total > scanAtMost) {
      source = 'sample';
      const k = Math.max(2, Math.ceil(total / sampleSize));
      const pk = meta.columns.filter((c) => c.primaryKey);
      // Hashed before the stride, for the reason the SQLite adapter gives:
      // periodic data and a bare modulo sample each other.
      from =
        pk.length === 1 && /int/i.test(pk[0].type)
          ? `(SELECT * FROM ${qualify(found)} WHERE ((${q(pk[0].name)} * 2654435761) & 0x7fffffff) % ${k} = 0) AS sampled`
          : `(SELECT * FROM ${qualify(found)} LIMIT ${sampleSize}) AS sampled`;
    }

    const aggs = meta.columns.map(
      (c, i) =>
        `COUNT(${q(c.name)}) AS n${i}, COUNT(DISTINCT ${q(c.name)}) AS d${i}, ` +
        `MIN(${q(c.name)}) AS mn${i}, MAX(${q(c.name)}) AS mx${i}`,
    );
    const row =
      (
        await this.read<Record<string, unknown>>(
          db,
          `SELECT COUNT(*) AS total${aggs.length ? `, ${aggs.join(', ')}` : ''} FROM ${from}`,
          [],
        )
      ).rows[0] ?? {};
    const basis = Number(row.total ?? 0);

    const columns: ColumnProfile[] = [];
    for (const [i, c] of meta.columns.entries()) {
      const nonNull = Number(row[`n${i}`] ?? 0);
      const distinct = Number(row[`d${i}`] ?? 0);
      const profiled: ColumnProfile = {
        column: c.name,
        type: c.type,
        nullFrac: basis ? (basis - nonNull) / basis : 0,
        distinct,
        min: row[`mn${i}`] ?? undefined,
        max: row[`mx${i}`] ?? undefined,
      };
      if (nonNull > 0 && distinct < nonNull) {
        const top = await this.read<{ v: unknown; n: number }>(
          db,
          `SELECT ${q(c.name)} AS v, COUNT(*) AS n FROM ${from} ` +
            `WHERE ${q(c.name)} IS NOT NULL GROUP BY ${q(c.name)} ORDER BY n DESC, v LIMIT 5`,
          [],
        );
        profiled.common = top.rows.map((t) => ({ value: t.v, frac: Number(t.n) / basis }));
      }
      columns.push(profiled);
    }

    return {
      table: id,
      rows: total,
      columns,
      source,
      ...(source === 'sample' ? { sampled: basis } : {}),
      ms: Math.round(performance.now() - started),
    };
  }

  /**
   * Run a statement the user wrote.
   *
   * On a **connection of its own, thrown away afterwards** — which is a
   * heavier answer than the other two adapters need, and MySQL earns it.
   *
   * The obvious approach was `START TRANSACTION READ ONLY`, the way the
   * Postgres adapter does it. Testing it against MySQL 8.4 showed it does not
   * hold, in two steps neither of which is exotic:
   *
   *   1. `SET SESSION TRANSACTION READ WRITE` succeeds and **persists**. MySQL
   *      session variables are not transactional, so the `ROLLBACK` that
   *      follows does not undo it — unlike Postgres, where a plain `SET` inside
   *      a transaction is rolled back with everything else.
   *   2. `DROP TABLE` then performs an *implicit commit*, ending the read-only
   *      transaction before the statement runs, so the DDL executes under the
   *      session mode the first step had just flipped.
   *
   * Two statements, two calls, and a dropped table — observed, not theorised.
   *
   * A connection per statement closes it without needing to know that story.
   * Session state cannot outlive the run that set it, so no statement can
   * arrange the conditions for the next one; and with autocommit and the
   * session opened read-only, DDL is refused by the session mode rather than by
   * a transaction that DDL can commit its way out of. The cost is a connection
   * per run, which for a statement someone typed and is waiting on is nothing.
   *
   * Writes are the other path and keep the persistent write handle: it exists
   * to write, and there is nothing to isolate it from.
   */
  async runSql(request: SqlRequest): Promise<SqlResult> {
    const captured = { ...request };
    // Raw statements share the writer with structured transactions. They must
    // wait for its lease, including COMMIT/DDL that could end another call's work.
    return captured.write ? this.withWriter('all', () => this.runSqlNow(captured)) : this.runSqlNow(captured);
  }

  private async runSqlNow(request: SqlRequest): Promise<SqlResult> {
    const stacked = refuseStacked(request.text);
    if (stacked) throw new Error(stacked);
    if (request.refuseReserved) refuseReservedText(request.text, 'mysql');

    const limit = clampLimit(request.limit);
    const bounded = !request.write && looksWrappable(request.text);
    const text = bounded ? boundStatement(request.text, limit) : trimStatement(request.text);
    const started = performance.now();

    if (request.write) {
      const db = await this.writeHandle();
      const [rows] = (await db.query({ sql: text })) as unknown as [{ affectedRows?: number }];
      return {
        columns: [],
        rows: [],
        ms: Math.round(performance.now() - started),
        truncated: false,
        bounded: false,
        affected: Number(rows?.affectedRows ?? 0),
        sql: { text, params: [] },
      };
    }

    const signal = cancellation();
    throwIfCancelled(signal);
    const db = await this.open(true, statementCap(request.timeoutMs));
    /* A cancel kills the statement from a connection of its own; this one is
       then dropped rather than asked to finish politely. */
    let cancelled = false;
    const disarm = onCancel(signal, () => {
      cancelled = true;
      void this.killQuery(db);
    });
    try {
      /* `rowsAsArray` so two output columns of the same name keep both values;
         the default object rows would let the second overwrite the first. */
      let wrapped = bounded;
      let [rows, fields] = (await db.query({ sql: text, rowsAsArray: true }).catch(async (err: Error) => {
        /* Not every legal statement survives being made a derived table.
             MySQL refuses one whose columns share a name — `select id, id` is
             fine on its own and not fine inside `FROM (…)` — and there are
             others. Rather than enumerate them, the wrap is treated as an
             optimisation that can fail: run the statement as written and say
             the limit was not applied.

             Safe to run twice because this connection cannot write, and the
             second error is the better one to report anyway: it is about the
             statement someone typed rather than about our wrapper. A statement
             that was stopped — cancelled, or past its cap — is not a wrap that
             failed, and running it again would spend the cap twice. */
        if (!bounded || cancelled || stoppedReason(err)) throw err;
        wrapped = false;
        return db.query({ sql: trimStatement(request.text), rowsAsArray: true });
      })) as unknown as [unknown, Array<{ name: string }> | undefined];
      throwIfCancelled(signal);
      const all = Array.isArray(rows) ? (rows as unknown[][]) : [];
      const truncated = all.length > limit;
      return {
        columns: dedupe((fields ?? []).map((f) => f.name)),
        rows: (truncated ? all.slice(0, limit) : all).map((row) => (Array.isArray(row) ? row : [row]).map(valueSafe)),
        ms: Math.round(performance.now() - started),
        truncated,
        bounded: wrapped,
        sql: { text: wrapped ? text : trimStatement(request.text), params: [] },
      };
    } catch (error) {
      if (cancelled) throw new StatementStopped('cancelled', undefined, { cause: error });
      throw error;
    } finally {
      disarm();
      // Whatever the statement did to this session dies here.
      if (cancelled) db.destroy?.();
      else await db.end().catch(() => {});
    }
  }

  /**
   * Delete one row. The guards are the SQLite adapter's, one for one.
   *
   * An edit refused on SQLite and allowed on MySQL would mean the safety of an
   * editor depended on which database it was pointed at. The extra check here
   * is the same one `update` carries: MySQL will delete *through* a simple view
   * onto the table underneath, which is not what someone looking at a view
   * expects to happen.
   */
  async remove(request: DeleteRequest): Promise<DeleteResult> {
    const lane = keyedLane(request);
    if (this.recordsHistory(request)) return this.transact(lane, (tx) => tx.remove(request));
    return this.withWriter(lane, () => this.removeNow(request));
  }

  private recordsHistory(request: { table?: unknown }): boolean {
    return capturesWrites(this, request?.table);
  }

  private async removeNow(request: DeleteRequest, db?: MysqlConnection): Promise<DeleteResult> {
    const transactional = db !== undefined;
    db ??= await this.conn();
    const found = await this.assertTable(request.table, db);
    const { schema, name, isView } = found;
    const id = `${schema}.${name}`;
    if (isView) throw new Refusal(`${id} is a view, so no single row can be identified.`);

    const { rows: cols } = await this.read<{ COLUMN_NAME: string; COLUMN_KEY: string }>(
      db,
      `SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, name],
    );
    const pk = cols.filter((c) => c.COLUMN_KEY === 'PRI').map((c) => c.COLUMN_NAME);
    if (!pk.length) throw new Refusal(`${id} has no primary key, so no single row can be identified.`);

    const keyColumns = Object.keys(request.key);
    const same = keyColumns.length === pk.length && pk.every((c) => keyColumns.includes(c));
    if (!same) {
      throw new Refusal(`Deleting from ${id} needs exactly its primary key (${pk.join(', ')}).`);
    }

    const filter: Filter = {
      groups: [pk.map((column) => ({ column, op: '=' as const, value: request.key[column] }))],
    };

    const matches = await (db === this.client ? this.count(request.table, filter) : this.countOn(request.table, filter, db));
    if (matches !== 1) {
      throw new Refusal(
        `Refused: that key matches ${matches} rows, not 1. A delete is only allowed when it is certain which row it removes.`,
      );
    }

    const where = buildWhere(filter, MYSQL_STYLE);
    const text = `DELETE FROM ${qualify(found)}${where.text}`;
    const write = transactional ? db : await this.writeHandle();
    const [result] = (await write.execute(text, where.params)) as unknown as [{ affectedRows?: number }];
    return { affected: Number(result?.affectedRows ?? 0), sql: { text, params: where.params } };
  }

  /** The writer this write leased (withWriter); a write outside one is a bug, refused. */
  private async writeHandle(): Promise<MysqlConnection> {
    const write = this.leased.getStore();
    if (!write) throw new Refusal('A write needs a writer.');
    return write;
  }

  private async lockRecordNow(request: DeleteRequest, write: MysqlConnection): Promise<void> {
    const found = await this.assertTable(request.table, write);
    if (found.isView) throw new Refusal('Record locks require a keyed table.');
    await this.assertInnoDB(found, write);
    const { rows: columns } = await this.read<{ COLUMN_NAME: string; COLUMN_KEY: string }>(
      write,
      'SELECT COLUMN_NAME, COLUMN_KEY FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [found.schema, found.name],
    );
    const pk = columns.filter((column) => column.COLUMN_KEY === 'PRI').map((column) => column.COLUMN_NAME);
    const where = buildWhere(recordLockFilter(request, pk), MYSQL_STYLE);
    const { rows } = await this.read(
      write,
      `SELECT ${pk.map(MYSQL_STYLE.quote).join(', ')} FROM ${qualify(found)}${where.text} FOR UPDATE`,
      where.params,
    );
    if (rows.length > 1) throw new Refusal('That primary key does not identify a single record.');
  }

  private async assertInnoDB(table: Located, write: MysqlConnection): Promise<void> {
    const { rows } = await this.read<{ ENGINE: unknown }>(
      write,
      'SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [table.schema, table.name],
    );
    if (rows.length !== 1 || typeof rows[0].ENGINE !== 'string' || rows[0].ENGINE.toLowerCase() !== 'innodb') {
      throw new Refusal('Transactional record operations require an InnoDB table.');
    }
  }

  private async discardWriter(write: MysqlConnection): Promise<void> {
    // Detach before disposal awaits: this session must never become a later
    // transaction's writer, even when shutdown itself fails.
    this.discarded.add(write);
    try {
      if (typeof write.destroy === 'function') {
        write.destroy();
        return;
      }
    } catch {
      /* Still try orderly close without replacing the outcome error. */
    }
    await write.end().catch(() => {});
  }

  /**
   * Several writes as one, or none of them.
   *
   * `BEGIN` / `COMMIT` on the write connection, through `query` rather than
   * `execute`: MySQL's prepared-statement protocol will not take a
   * transaction-control statement, and these carry no parameters to prepare.
   *
   * Worth naming what this cannot promise on this engine: MySQL commits DDL
   * implicitly, so a `CREATE TABLE` reached through raw SQL inside one of
   * these ends the transaction where it stands. Nothing here issues DDL, and
   * a caller who does through `sql` has left the guarantee behind.
   */
  async transaction<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    return this.transact([], run);
  }

  /* As PostgresAdapter.transact: a single record's write that keeps a history names its lane. */
  private transact<T>(lane: readonly string[], run: (tx: WriteTransaction) => Promise<T>): Promise<T> {
    return this.withWriter(lane, async (write) => {
      const operations = new TransactionOperations();
      let began = false;
      let commitAttempted = false;
      try {
        // A locking read uses the current image. Subsequent plain reads must
        // not reuse an older REPEATABLE READ snapshot for original/Undo capture.
        // No SESSION modifier: this applies only to the immediately next BEGIN.
        await write.query({ sql: 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' });
        await write.query({ sql: 'BEGIN' });
        began = true;
        /* Beneath every facade (writeCapture.ts); the before image is read
           under the row's lock, so it is the one the write replaces. */
        const databases = () => this.databases[0] ?? '';
        const history = beginWriteCapture(this, {
          writer: {
            dialect: 'mysql',
            connection: write,
            get database() {
              return databases();
            },
          },
          read: async (table, key, columns, lock) => {
            if (lock) await this.lockRecordNow({ table, key }, write);
            const result = await this.queryOn(
              {
                table,
                ...(columns ? { columns } : {}),
                limit: 2,
                offset: 0,
                filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
              },
              write,
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
                write,
              )
            ).rows,
        });
        const insert = (r: InsertRequest) => this.insertNow(r, write);
        const remove = (r: DeleteRequest) => this.removeNow(r, write);
        const update = (r: UpdateRequest) => this.updateNow(r, write);
        const out = await run({
          lockRecord: (r) => queueRecordLock(operations, r, (request) => this.lockRecordNow(request, write)),
          query: (r) => operations.run(() => this.queryOn(r, write)),
          count: (table, filter) => operations.run(() => this.countOn(table, filter, write)),
          insert: (r) => operations.run(() => (history ? history.insert(r, insert) : insert(r))),
          remove: (r) => operations.run(() => (history ? history.remove(r, remove) : remove(r))),
          update: (r) => operations.run(() => (history ? history.update(r, update) : update(r))),
          ...(history ? { tell: (r: TellRequest) => operations.run(() => history.tell(r)) } : {}),
        });
        await operations.finish();
        await finishWriteCapture(history);
        commitAttempted = true;
        await write.query({ sql: 'COMMIT' });
        committedWriteCapture(history);
        return out;
      } catch (err) {
        await operations.finish().catch(() => {});
        let rolledBack = false;
        if (began) {
          try {
            await write.query({ sql: 'ROLLBACK' });
            rolledBack = true;
          } catch {
            /* A failed acknowledgement cannot establish the outcome. */
          }
        }
        if (!began || commitAttempted || !rolledBack) await this.discardWriter(write);
        if (commitAttempted || (began && !rolledBack)) throw new TransactionOutcomeUnknown(err);
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    await Promise.allSettled((this.replicas?.pools ?? []).map((replica) => replica.close()));
    this.scopeEpoch++;
    this.openingPrimary = undefined;
    const open = [this.client, ...this.readers, ...this.writers].filter((c): c is MysqlConnection => typeof c?.end === 'function');
    this.client = null;
    this.readers = [];
    this.inFlight.clear();
    for (const write of this.writers) this.discarded.add(write);
    this.writers.clear();
    for (const group of [this.foreground, this.background]) {
      group.writers.clear();
      group.idle.length = 0;
      for (const wake of group.waiters.splice(0)) wake();
    }
    await Promise.allSettled(open.map((c) => c.end()));
  }

  /**
   * Identifiers cannot be bound, so a table name is checked against the
   * catalog before it is quoted into a statement. The check is a parameterised
   * query, which means the untrusted string never reaches SQL as syntax.
   *
   * An unqualified name means the database the connection is in, which is what
   * `USE shop; SELECT * FROM invoice` means to anyone who has used MySQL.
   */
  /**
   * The same check for a read, answered from the catalog read on connect when
   * it holds the name — a round trip per statement saved. A name it does not
   * hold is still asked of the server, and every write is (assertTable).
   */
  private async readTable(id: string, db?: MysqlConnection): Promise<Located> {
    const known = this.cachedSchema?.tables.find((table) => table.id === id);
    if (known?.schema && this.databases.includes(known.schema)) {
      return { schema: known.schema, name: known.name, isView: known.isView };
    }
    return this.assertTable(id, db);
  }

  private async assertTable(id: string, db?: MysqlConnection): Promise<Located> {
    db ??= await this.conn();
    const dot = id.indexOf('.');
    const schema = dot === -1 ? (this.databases[0] ?? '') : id.slice(0, dot);
    const name = dot === -1 ? id : id.slice(dot + 1);
    const found = await this.read<{ TABLE_TYPE: string }>(
      db,
      `SELECT TABLE_TYPE FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
      [schema, name],
    );
    /* Restricted to the browsed set as well as to what exists: a server hosts
       every database it has in one catalog, and a name typed into the URL bar
       must not become a way to read one this session never opened. */
    if (!found.rows.length || !this.databases.includes(schema)) {
      throw new Error(`No table or view called "${id}" in this database.`);
    }
    return { schema, name, isView: found.rows[0].TABLE_TYPE !== 'BASE TABLE' };
  }

  /** A read connection for one statement: an idle one, a new one while
   * fewer than MYSQL_READERS are open, else the least busy. Taken at once, so
   * reads started together spread rather than all picking the same idle one. */
  private async takeReader(primary: MysqlConnection): Promise<MysqlConnection> {
    const epoch = this.scopeEpoch;
    const open = [primary, ...this.readers];
    const busy = (c: MysqlConnection) => this.inFlight.get(c) ?? 0;
    let chosen = open.find((c) => busy(c) === 0);
    if (!chosen && open.length + this.openingReaders < MYSQL_READERS) {
      this.openingReaders++;
      try {
        const opened = await this.open(true);
        if (epoch !== this.scopeEpoch) {
          await opened.end().catch(() => {});
          throw new Refusal('This connection was closed.');
        }
        this.readers.push(opened);
        chosen = opened;
      } catch (error) {
        if (error instanceof Refusal) throw error;
        /* A reader that cannot be opened is a slower read, not a failed one. */
      } finally {
        this.openingReaders--;
      }
    }
    chosen ??= [primary, ...this.readers].reduce((least, c) => (busy(c) < busy(least) ? c : least));
    this.inFlight.set(chosen, busy(chosen) + 1);
    return chosen;
  }

  private giveBack(reader: MysqlConnection): void {
    const left = (this.inFlight.get(reader) ?? 1) - 1;
    if (left > 0) this.inFlight.set(reader, left);
    else this.inFlight.delete(reader);
  }

  /** Out of the pool for good: a read on it was stopped, or it failed. */
  private retire(reader: MysqlConnection): void {
    if (this.client === reader) this.client = this.readers.shift() ?? null;
    else this.readers = this.readers.filter((c) => c !== reader);
  }

  /**
   * One place that unwraps mysql2's `[rows, fields]` pair — and where a read
   * on the shared read connections is spread across them, and stopped when
   * its call is cancelled. Only there: a write that has started runs to its
   * end, on the connection it was given.
   */
  private async read<T>(given: MysqlConnection, text: string, params: unknown[] = []): Promise<{ rows: T[]; fields: FieldPacket[] }> {
    /* A read on the shared readers may go to a replica instead; one on a
       writer or a connection a caller holds is that connection's. */
    if (this.replicas && given === this.client) {
      const replicas = this.replicas;
      return replicas.read(
        (replica) => replica.replicaRead<T>(text, params),
        () => this.readHere<T>(given, text, params),
      );
    }
    return this.readHere<T>(given, text, params);
  }

  private async readHere<T>(given: MysqlConnection, text: string, params: unknown[] = []): Promise<{ rows: T[]; fields: FieldPacket[] }> {
    const pooled = given === this.client;
    const signal = pooled ? cancellation() : undefined;
    throwIfCancelled(signal);
    const db = pooled ? await this.takeReader(given) : given;
    let cancelled = false;
    const disarm = onCancel(signal, () => {
      cancelled = true;
      /* Retired as it is stopped: the kill travels on another connection and
         can land late, and it must not land on a later call's statement. */
      this.retire(db);
      void this.killQuery(db).finally(() => db.destroy?.());
    });
    try {
      throwIfCancelled(signal);
      const [rows, fields] = await db.execute(text, params);
      throwIfCancelled(signal);
      return {
        rows: (Array.isArray(rows) ? rows : []) as T[],
        fields: (Array.isArray(fields) ? fields : []) as FieldPacket[],
      };
    } catch (error) {
      if (cancelled) throw new StatementStopped('cancelled', undefined, { cause: error });
      /* A connection the server dropped is not handed out again. */
      if (pooled && (error as { fatal?: boolean }).fatal) {
        this.retire(db);
        db.destroy?.();
      }
      throw error;
    } finally {
      if (pooled) this.giveBack(db);
      disarm();
    }
  }

  /**
   * Stop the statement a connection is running, with KILL QUERY from a
   * connection of its own: the one running it is busy. Best effort — a kill
   * that cannot connect leaves the statement to its cap.
   */
  private async killQuery(db: MysqlConnection): Promise<void> {
    const thread = Number(db.threadId);
    if (!Number.isSafeInteger(thread) || thread <= 0) return;
    try {
      const killer = await this.open(false);
      try {
        await killer.query(`KILL QUERY ${thread}`);
      } finally {
        await killer.end().catch(() => {});
      }
    } catch {
      /* The statement's cap still stops it. */
    }
  }
}
