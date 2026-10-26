/**
 * The pruner: one generic way to forget old rows from a runtime table. A store
 * registers a rule (its table, the column that dates a row, which of the
 * App's retention windows governs it, and any extra predicate), and a daily
 * built-in job (server/retention.ts) runs every registered rule against the
 * database its table lives in.
 *
 * Bounded by construction. A rule deletes at most `PRUNE_BATCH` rows per
 * statement, each statement its own transaction, with a short pause between
 * them, so a table that has grown for two years is trimmed over minutes
 * without holding a lock, a long transaction or the pool: the writes of the
 * App keep their turn between batches. A statement that deletes fewer rows
 * than a full batch ends the rule.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { PgWriteClientSource } from '@mistriwork/engine/adapters/postgresPool.js';
import { runtimeRelation, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

/** Rows deleted per statement. */
export const PRUNE_BATCH = 5_000;
/** The rest between two statements of one rule. */
const PRUNE_PAUSE_MS = 250;

/** The App's retention windows a rule may be governed by (`retention` in the App, shared/appRetention.ts). */
type PruneWindow = 'history' | 'commands' | 'attempts';

/** How the column that dates a row holds its time. */
type PruneClock =
  /** An integer of milliseconds since the epoch (the job and delivery stores). */
  | 'epoch-ms'
  /** Text in `toISOString()` form, which orders as time does (SQLite's record history). */
  | 'iso-text'
  /** A native timestamp: `timestamptz` on PostgreSQL, `datetime(3)` in UTC on MySQL. */
  | 'timestamp';

export interface PruneRule {
  /** Unique: the store's id for it (`record-history`, `job-attempts`). */
  readonly id: string;
  readonly window: PruneWindow;
  /** The runtime table, as its store names it (`__mistri_…`); `runtimeTable` places it per engine. */
  readonly table: string;
  /** The column that dates a row; a row is old when this is before the cutoff. */
  readonly time: string;
  /**
   * Columns that name a group of rows kept as one thing (the tries of one job):
   * a row goes only when every row of its group is old, so a group is never
   * left holding its newest tries and none of its first. A row whose time is
   * null (a try still under way) is not old, so its group stays.
   */
  readonly group?: readonly string[];
  /** How the column holds a time: one way on every engine, or per engine where the layouts differ. */
  readonly clock: PruneClock | Readonly<Record<PruneDb['dialect'], PruneClock>>;
  /**
   * Which rows may go besides being old: a SQL condition over the table's own
   * columns, with no parameters, given the way to name another runtime table on
   * this engine. A rule for a table that holds work in flight uses it to say
   * what is finished, so a pending row is never pruned however old. Absent,
   * every old row goes.
   */
  readonly where?: (table: (name: string) => string) => string;
  /**
   * Other runtime tables whose rows point at this one's by `column` = its `id`:
   * a row one of them still names stays, however old, so a foreign key never
   * refuses the batch. A store that may not be provisioned beside this one is
   * named here rather than in `where`, because only a table this database
   * holds is asked.
   */
  readonly referencedBy?: readonly Readonly<{ table: string; column: string }>[];
}

const rules = new Map<string, PruneRule>();

/** A store's rule, registered once when its module loads. Registering the same rule again changes nothing. */
export function registerPrune(rule: PruneRule): PruneRule {
  const held = rules.get(rule.id);
  if (held) {
    if (JSON.stringify(held) !== JSON.stringify(rule)) throw new Error(`The prune rule "${rule.id}" is registered twice, differently.`);
    return held;
  }
  const named = [rule.table, rule.time, ...(rule.group ?? []), ...(rule.referencedBy ?? []).flatMap((ref) => [ref.table, ref.column])];
  if (!named.every((name) => /^[A-Za-z0-9_$]+$/.test(name)))
    throw new Error(`The prune rule "${rule.id}" names a table or column that is not a plain identifier.`);
  const frozen = Object.freeze({ ...rule });
  rules.set(rule.id, frozen);
  return frozen;
}

/** Every registered rule, in the order they were registered. */
export const prunes = (): readonly PruneRule[] => [...rules.values()];

/** One database a rule runs against: a statement, and how many rows it deleted. */
interface PruneDb {
  readonly dialect: 'sqlite' | 'postgres' | 'mysql';
  /** `?` placeholders, the statement committed on its own. */
  delete(sql: string, params: unknown[]): Promise<number>;
  /** Whether this database holds the table: a store not provisioned here has nothing to prune. */
  has(table: string): Promise<boolean>;
}

/** Retention in milliseconds per window; null keeps for ever. */
type RetentionMs = Readonly<Record<PruneWindow, number | null>>;

const quote = (dialect: PruneDb['dialect'], name: string) => (dialect === 'mysql' ? `\`${name}\`` : `"${name}"`);
const mysqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '');

/** The cutoff as the rule's column holds a time. */
const clockOn = (db: Pick<PruneDb, 'dialect'>, rule: PruneRule): PruneClock =>
  typeof rule.clock === 'string' ? rule.clock : rule.clock[db.dialect];
function cutoff(db: PruneDb, rule: PruneRule, at: number): number | string {
  const clock = clockOn(db, rule);
  if (clock === 'epoch-ms') return at;
  if (clock === 'iso-text') return new Date(at).toISOString();
  return db.dialect === 'mysql' ? mysqlTime(at) : new Date(at).toISOString();
}

/** The statement that deletes one batch of a rule's old rows; `referenced` is the part of `referencedBy` this database holds. */
export function pruneStatement(
  db: Pick<PruneDb, 'dialect'>,
  rule: PruneRule,
  batch = PRUNE_BATCH,
  database?: string,
  referenced: PruneRule['referencedBy'] = rule.referencedBy,
): string {
  const named = (name: string) => runtimeTable(db.dialect, name, database);
  const table = named(rule.table);
  const time = quote(db.dialect, rule.time);
  const stamp = clockOn(db, rule) === 'timestamp' && db.dialect === 'postgres' ? '?::timestamptz' : '?';
  // A column is qualified by the relation's own name where it sits, which on PostgreSQL drops the prefix.
  const column = (name: string) =>
    `${quote(db.dialect, runtimeRelation(db.dialect, rule.table, database).relname)}.${quote(db.dialect, name)}`;
  const whole = rule.group
    ? ` AND NOT EXISTS (SELECT 1 FROM ${table} g WHERE ${rule.group.map((name) => `g.${quote(db.dialect, name)} = ${column(name)}`).join(' AND ')}` +
      ` AND (g.${time} IS NULL OR g.${time} >= ${stamp}))`
    : '';
  const kept = (referenced ?? [])
    .map((ref) => ` AND NOT EXISTS (SELECT 1 FROM ${named(ref.table)} r WHERE r.${quote(db.dialect, ref.column)} = ${column('id')})`)
    .join('');
  const old = `${column(rule.time)} < ${stamp}${whole}${kept}${rule.where ? ` AND (${rule.where(named)})` : ''}`;
  // MySQL bounds a DELETE itself; the ORDER BY makes the oldest rows go first, so a half-finished run leaves a clean edge.
  if (db.dialect === 'mysql') return `DELETE FROM ${table} WHERE ${old} ORDER BY ${column(rule.time)} LIMIT ${batch}`;
  // A row is named by where it is, so a rule needs no key: ctid and rowid exist on every ordinary table.
  if (db.dialect === 'sqlite') return `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${old} LIMIT ${batch})`;
  // A row another transaction holds is left for the next day rather than waited for.
  return `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${old} LIMIT ${batch} FOR UPDATE SKIP LOCKED)`;
}

export interface PruneOptions {
  readonly batch?: number;
  readonly pauseMs?: number;
  readonly now?: () => number;
  /** Replaced by tests, which do not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Ends the run between batches. */
  readonly signal?: AbortSignal;
  /** The MySQL database the tables are in, where the connection does not select it. */
  readonly database?: string;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One rule on one database; the rows it deleted. 'forever' (a null window) deletes nothing. */
export async function prune(db: PruneDb, rule: PruneRule, windowMs: number | null, options: PruneOptions = {}): Promise<number> {
  if (windowMs === null) return 0;
  const batch = options.batch ?? PRUNE_BATCH;
  const pause = options.sleep ?? wait;
  const before = cutoff(db, rule, (options.now ?? Date.now)() - windowMs);
  const referenced = [];
  for (const ref of rule.referencedBy ?? []) if (await db.has(ref.table)) referenced.push(ref);
  const sql = pruneStatement(db, rule, batch, options.database, referenced);
  let total = 0;
  for (;;) {
    if (options.signal?.aborted) return total;
    const deleted = await db.delete(sql, rule.group ? [before, before] : [before]);
    total += deleted;
    if (deleted < batch) return total;
    await pause(options.pauseMs ?? PRUNE_PAUSE_MS);
  }
}

/** Every rule of these on this database, each under the window it names. */
export async function pruneAll(
  db: PruneDb,
  which: readonly PruneRule[],
  windows: RetentionMs,
  options: PruneOptions = {},
): Promise<readonly Readonly<{ id: string; deleted: number }>[]> {
  const out: Array<Readonly<{ id: string; deleted: number }>> = [];
  for (const rule of which) {
    if (windows[rule.window] === null || !(await db.has(rule.table))) continue;
    out.push({ id: rule.id, deleted: await prune(db, rule, windows[rule.window], options) });
  }
  return out;
}

/* ---------- the engines ---------- */

/** A SQLite file's statements, each its own transaction (the connection is in autocommit). */
export function sqlitePruneDb(db: DatabaseSync): PruneDb {
  return {
    dialect: 'sqlite',
    async delete(sql, params) {
      return Number(db.prepare(sql).run(...(params as SQLInputValue[])).changes);
    },
    async has(table) {
      return db.prepare(`SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = ? COLLATE BINARY`).get(table) !== undefined;
    },
  };
}

/** `?` numbered for PostgreSQL. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

/** A PostgreSQL pool's statements, each taking a client of its own and committing as it ends. */
export function postgresPruneDb(source: PgWriteClientSource): PruneDb {
  return {
    dialect: 'postgres',
    async delete(sql, params) {
      return source.withWriteClient(async (client) => (await client.query(numbered(sql), params)).rowCount ?? 0);
    },
    async has(table) {
      return source.withWriteClient(
        async (client) =>
          (await client.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [runtimeTable('postgres', table)])).rows[0]?.present ===
          true,
      );
    },
  };
}

/** The part of a mysql2 connection a prune speaks through. */
interface MysqlPruneConnection {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
}

/**
 * A MySQL connection's statements, in autocommit so each batch is its own transaction. The connection
 * selects the database (a URL that names none has no runtime tables to prune: `has` is false everywhere).
 * Text `query`, not `execute`: a prepared DELETE ... LIMIT is refused on some servers.
 */
export function mysqlPruneDb(db: MysqlPruneConnection): PruneDb {
  return {
    dialect: 'mysql',
    async delete(sql, params) {
      const [result] = await db.query(sql, params);
      return Number((result as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
    },
    async has(table) {
      const [rows] = await db.query(
        'SELECT 1 AS present FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
        [table],
      );
      return Array.isArray(rows) && rows.length > 0;
    },
  };
}
