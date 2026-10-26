/**
 * Numbers a command hands out: LD-1001 for a dealer's next lead, PMT-7 for a
 * loan's seventh payment. A handler under a row policy or in a tenant cannot
 * find the last number by reading — the rows of other dealers, other loans
 * and other tenants are not there for it to read — and a `max() + 1` of the
 * rows it can see collides with the ones it cannot. So the count is kept in a
 * reserved table beside the command journal, one row per sequence, and
 * advanced in the command's own transaction: the row stays locked until that
 * transaction ends, so two commands never take the same number, and a
 * command that is refused or rolls back takes none.
 *
 * A sequence is named within its App and, in a tenant App, within its
 * tenant's realm: a tenant's numbers never show how many another has taken.
 * `per` splits it further by a value the handler supplies (a dealer's id).
 * Gaps are possible (a number is never reused, and nothing promises the next
 * one is the last plus one), so a number identifies and never counts.
 *
 * Rows written outside commands — a seed, an import, the rows before the App
 * — never advanced the count, so its next number can be one they hold. The
 * store cannot look (it reads no rows, above, and does not know which column
 * a number lands in), so the handler says the highest it holds as `after` and
 * the number taken is past both: `max(count + 1, after + 1)`, in the same
 * locked upsert, so two commands that read the same `after` still take two
 * numbers.
 *
 * Added by `mistri migrate stores up` (or the journal's own explicit migration), never on startup, and
 * attested before each use: a missing or foreign layout refuses the command.
 */
import type { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import type { CommandJournal } from './commandJournalTypes.js';

export const COMMAND_SEQUENCE_TABLE = '__mistri_sequence_number';
/** The store's version row. */
export const COMMAND_SEQUENCE_META_TABLE = '__mistri_sequence_meta';
export const COMMAND_SEQUENCE_VERSION = 1;

export class CommandSequenceUnavailable extends Refusal {
  constructor(
    message = 'The command sequence store is missing or is not the layout this version expects. It is made with the command ' +
      'journal; a foreign layout is refused, not altered.',
  ) {
    super(message);
    this.name = 'CommandSequenceUnavailable';
  }
}

/** Which sequence, in whose namespace: the App, the journal's store, source,
 * realm and tenant, the handler's name for it and its `per` value. */
export interface CommandSequenceKey {
  readonly appId: string;
  readonly namespace: readonly [string, string, 'tenant' | 'platform', string];
  readonly name: string;
  readonly per: string;
}

const NAME = /^[a-z][a-z0-9_-]{0,62}$/;
/** The largest number either engine keeps exactly as a JavaScript number. */
const LIMIT = Number.MAX_SAFE_INTEGER;

/** The handler's request, checked: a name, a `per` of text or a number (one
 * sequence each, 7 and '7' alike, as a key read back through two drivers
 * is), a first number, and the highest number rows already hold. The last
 * two fold into one floor, the least number this call may take. */
function commandSequenceRequest(name: unknown, options: unknown): { name: string; per: string; start: number } {
  const refuse = (why: string): never => {
    throw new Refusal(`nextNumber: ${why}`);
  };
  if (typeof name !== 'string' || !NAME.test(name)) refuse('name the sequence in lower case: letters, digits, "-" and "_", 63 at most.');
  if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options)))
    refuse('options are { per, start, after }.');
  const given = (options ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(given))
    if (key !== 'per' && key !== 'start' && key !== 'after') refuse(`"${key}" is not an option; say per, start or after.`);
  const per = given.per;
  if (
    per !== undefined &&
    !(typeof per === 'string' && per.length <= 256 && !per.includes('\0')) &&
    !(typeof per === 'number' && Number.isFinite(per))
  ) {
    refuse("per is text or a number, the value the sequence is counted within (a dealer's id); it is never null.");
  }
  const start = given.start ?? 1;
  if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1) refuse('start is a whole number, 1 or more.');
  // null is "no rows yet": what a max over an empty table reads.
  const after = given.after ?? 0;
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 || after >= LIMIT) {
    refuse('after is the highest number rows already hold: a whole number, 0 or more.');
  }
  return { name: name as string, per: per === undefined ? '' : String(per), start: Math.max(start as number, (after as number) + 1) };
}

/** The allocated number, refused past what a JavaScript number holds exactly. */
export function sequenceNumber(value: unknown): number {
  const number = typeof value === 'bigint' ? Number(value) : typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1 || number >= LIMIT) throw new CommandSequenceUnavailable();
  return number;
}

/* ---------- SQLite ---------- */

const SQLITE_SEQUENCE_DDL = `CREATE TABLE "${COMMAND_SEQUENCE_TABLE}" (
  app_id TEXT COLLATE BINARY NOT NULL,
  store_id TEXT COLLATE BINARY NOT NULL,
  source_id TEXT COLLATE BINARY NOT NULL,
  realm TEXT COLLATE BINARY NOT NULL CHECK (realm IN ('tenant', 'platform')),
  tenant_id TEXT COLLATE BINARY NOT NULL,
  name TEXT COLLATE BINARY NOT NULL,
  per TEXT COLLATE BINARY NOT NULL,
  value INTEGER NOT NULL CHECK (value > 0),
  PRIMARY KEY (app_id, store_id, source_id, realm, tenant_id, name, per)
)`;

const SQLITE_SEQUENCE_META_DDL = `CREATE TABLE "${COMMAND_SEQUENCE_META_TABLE}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${COMMAND_SEQUENCE_VERSION})
)`;

/** Exactly the two tables this version creates, with no trigger on either, and the one version row. */
function assertSqliteCommandSequences(db: DatabaseSync): void {
  const entries = db
    .prepare(
      `SELECT type, name, tbl_name AS tbl, sql FROM main.sqlite_schema
      WHERE name COLLATE NOCASE IN (?, ?) OR tbl_name COLLATE NOCASE IN (?, ?)`,
    )
    .all(COMMAND_SEQUENCE_TABLE, COMMAND_SEQUENCE_META_TABLE, COMMAND_SEQUENCE_TABLE, COMMAND_SEQUENCE_META_TABLE) as Array<{
    type: string;
    name: string;
    sql: string | null;
  }>;
  const tables = entries.filter((entry) => entry.type === 'table');
  const ddl = new Map([
    [COMMAND_SEQUENCE_TABLE, SQLITE_SEQUENCE_DDL],
    [COMMAND_SEQUENCE_META_TABLE, SQLITE_SEQUENCE_META_DDL],
  ]);
  const rows = tables.some((entry) => entry.name === COMMAND_SEQUENCE_META_TABLE)
    ? (() => {
        try {
          return db.prepare(`SELECT singleton, version FROM main."${COMMAND_SEQUENCE_META_TABLE}"`).all();
        } catch {
          return [];
        }
      })()
    : [];
  if (
    tables.length !== ddl.size ||
    tables.some((entry) => ddl.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.type !== 'table' && !(entry.type === 'index' && entry.sql === null)) ||
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    rows[0].version !== COMMAND_SEQUENCE_VERSION ||
    db
      .prepare(`SELECT 1 FROM temp.sqlite_schema WHERE tbl_name COLLATE NOCASE IN (?, ?) LIMIT 1`)
      .get(COMMAND_SEQUENCE_TABLE, COMMAND_SEQUENCE_META_TABLE)
  ) {
    throw new CommandSequenceUnavailable(
      layoutRefusal('The command sequence store', sqliteLayoutVersion(db, COMMAND_SEQUENCE_META_TABLE), COMMAND_SEQUENCE_VERSION),
    );
  }
}

/** Inside the journal migration's transaction: create the tables where they are missing, then attest them. */
export function provisionSqliteCommandSequences(db: DatabaseSync): boolean {
  const present = db
    .prepare(`SELECT 1 FROM main.sqlite_schema WHERE name COLLATE NOCASE IN (?, ?) OR tbl_name COLLATE NOCASE IN (?, ?) LIMIT 1`)
    .get(COMMAND_SEQUENCE_TABLE, COMMAND_SEQUENCE_META_TABLE, COMMAND_SEQUENCE_TABLE, COMMAND_SEQUENCE_META_TABLE);
  if (!present) {
    db.exec(SQLITE_SEQUENCE_DDL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
    db.exec(SQLITE_SEQUENCE_META_DDL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
    db.prepare(`INSERT INTO main."${COMMAND_SEQUENCE_META_TABLE}" (singleton, version) VALUES (1, ?)`).run(COMMAND_SEQUENCE_VERSION);
  }
  assertSqliteCommandSequences(db);
  return !present;
}

/** The next number, in the caller's open transaction: one past the count, and never below `least` (the start, or past what rows hold). */
export function nextSqliteCommandNumber(db: DatabaseSync, key: CommandSequenceKey, least: number): number {
  if (!db.isTransaction) throw new CommandSequenceUnavailable();
  assertSqliteCommandSequences(db);
  const row = db
    .prepare(`INSERT INTO main."${COMMAND_SEQUENCE_TABLE}" (app_id, store_id, source_id, realm, tenant_id, name, per, value)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (app_id, store_id, source_id, realm, tenant_id, name, per) DO UPDATE SET value = max(value + 1, excluded.value)
    RETURNING value`)
    .get(key.appId, ...key.namespace, key.name, key.per, least) as { value: unknown } | undefined;
  return sequenceNumber(row?.value);
}

/** A handler's `nextNumber`, over the journal its command's transaction holds. */
export function handlerNextNumber(
  journal: CommandJournal,
  appId: string,
): (name: string, options?: { per?: string | number; start?: number; after?: number | null }) => Promise<number> {
  return async (name, options) => {
    const request = commandSequenceRequest(name, options);
    if (typeof journal.nextNumber !== 'function') throw new CommandSequenceUnavailable();
    return journal.nextNumber(appId, request.name, request.per, request.start);
  };
}
