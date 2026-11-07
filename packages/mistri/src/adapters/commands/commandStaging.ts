/**
 * Files held for a command: what a form's `field.files` or `field.signature`
 * sends as it is picked, kept until the command runs (server/commands/
 * stagedFiles.ts). A row is one file, its bytes and what it was held for —
 * the App, the journal's namespace (a tenant's files are its own), the
 * person who sent it, the command and the field — under the hash of its id:
 * the id itself is the sender's alone, never kept, so a row read out of the
 * database names nothing a request could use.
 *
 * Taken in the command's own transaction: the rows are deleted as the handler
 * is handed their files, so a command refused or rolled back takes none and
 * they stay held for the next try, and a command that commits leaves nothing
 * to take again. A row past its time is never taken, and the daily retention
 * job deletes it (the prune rule below).
 *
 * Added with the command journal (`mistri migrate stores up`, or the
 * journal's own explicit migration), never on startup, and attested before
 * each use: a missing or foreign layout refuses the request.
 */
import type { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { registerPrune } from '../retention/pruner.js';

export const COMMAND_STAGED_TABLE = '__mistri_staged_file';
/** The store's version row. */
export const COMMAND_STAGED_META_TABLE = '__mistri_staged_meta';
export const COMMAND_STAGED_VERSION = 1;

/* Rows past their time, every day, whatever the App keeps of anything else: a held file is never history. */
registerPrune({ id: 'staged-files', window: 'expired', table: COMMAND_STAGED_TABLE, time: 'expires_at', clock: 'epoch-ms' });

export class CommandStagingUnavailable extends Refusal {
  constructor(
    message = 'The store of files held for commands is missing or is not the layout this version expects. It is made with the ' +
      'command journal; a foreign layout is refused, not altered.',
  ) {
    super(message);
    this.name = 'CommandStagingUnavailable';
  }
}

/** The sender holds as many files, or as many bytes, as they may: nothing more is held until some are used or expire. */
export class StagedFilesFull extends Refusal {
  constructor(readonly shared = false) {
    super(shared ? 'Too many files are held for this form just now.' : 'Too many files are held for you just now.');
    this.name = 'StagedFilesFull';
  }
}

/** A held file a command was sent that it may not take: none by that id, another person's, another field's, or expired. */
export class StagedFileRefused extends Refusal {
  constructor(readonly field: string) {
    super('A file sent with this command is not held for it.');
    this.name = 'StagedFileRefused';
  }
}

/** Where a held file is kept: the App and the journal's namespace (store, source, realm, tenant). */
export type StagedNamespace = readonly [string, string, 'tenant' | 'platform', string];

/** A file to hold, as the server checked it. */
export interface StagedFileRow {
  /** The SHA-256 of its id, hex. */
  readonly idHash: string;
  /** `actor:<id>` signed in; `visitor:<hash>` on a public form, from the visitor's own cookie. */
  readonly owner: string;
  readonly command: string;
  readonly field: string;
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly data: Uint8Array;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

/** How much one sender may hold at once, and, on a public form, every visitor together. */
export interface StagedLimits {
  readonly files: number;
  readonly bytes: number;
  /** Every owner under this prefix together (`visitor:`), in this App: a public form's whole share. */
  readonly shared?: Readonly<{ prefix: string; bytes: number }>;
}

/** What a command takes: these hashes, held for this owner, command and field, unexpired at `now`. */
export interface StagedTake {
  readonly owner: string;
  readonly command: string;
  readonly field: string;
  readonly hashes: readonly string[];
  readonly now: number;
}

/** A taken file, in the order its id was sent. */
export interface TakenFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly data: Uint8Array;
}

const HASH = /^[0-9a-f]{64}$/;
const OWNER = /^(?:actor|visitor):[^\0]{1,200}$/;
const WORD = /^[A-Za-z][\w.-]{0,63}$/;

/** The row as the store may keep it: every column inside its bounds, or nothing is written. */
export function checkStagedRow(row: StagedFileRow): void {
  if (
    !HASH.test(row.idHash) ||
    !OWNER.test(row.owner) ||
    !WORD.test(row.command) ||
    !WORD.test(row.field) ||
    typeof row.name !== 'string' ||
    !row.name ||
    row.name.length > 255 ||
    typeof row.type !== 'string' ||
    !row.type ||
    row.type.length > 127 ||
    !(row.data instanceof Uint8Array) ||
    row.size !== row.data.byteLength ||
    !Number.isSafeInteger(row.expiresAt)
  )
    throw new Refusal('A held file was malformed.');
}

/** The take as the store may run it. */
export function checkStagedTake(take: StagedTake): void {
  if (
    !OWNER.test(take.owner) ||
    !WORD.test(take.command) ||
    !WORD.test(take.field) ||
    !Array.isArray(take.hashes) ||
    !take.hashes.length ||
    take.hashes.length > 20 ||
    take.hashes.some((hash) => typeof hash !== 'string' || !HASH.test(hash)) ||
    new Set(take.hashes).size !== take.hashes.length ||
    !Number.isSafeInteger(take.now)
  )
    throw new StagedFileRefused(typeof take.field === 'string' ? take.field : '');
}

/* ---------- SQLite ---------- */

const SQLITE_STAGED_DDL = `CREATE TABLE "${COMMAND_STAGED_TABLE}" (
  id_hash TEXT COLLATE BINARY PRIMARY KEY CHECK (length(id_hash) = 64),
  app_id TEXT COLLATE BINARY NOT NULL,
  store_id TEXT COLLATE BINARY NOT NULL,
  source_id TEXT COLLATE BINARY NOT NULL,
  realm TEXT COLLATE BINARY NOT NULL CHECK (realm IN ('tenant', 'platform')),
  tenant_id TEXT COLLATE BINARY NOT NULL,
  owner TEXT COLLATE BINARY NOT NULL,
  command_id TEXT COLLATE BINARY NOT NULL,
  field TEXT COLLATE BINARY NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL CHECK (size >= 0),
  data BLOB NOT NULL,
  expires_at INTEGER NOT NULL
)`;

const SQLITE_STAGED_INDEX_DDL = `CREATE INDEX "${COMMAND_STAGED_TABLE}_owner" ON "${COMMAND_STAGED_TABLE}" (app_id, owner, expires_at)`;

const SQLITE_STAGED_META_DDL = `CREATE TABLE "${COMMAND_STAGED_META_TABLE}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${COMMAND_STAGED_VERSION})
)`;

/** Exactly the two tables and the one index this version creates, no trigger, and the one version row. */
function assertSqliteCommandStaging(db: DatabaseSync): void {
  const names = [COMMAND_STAGED_TABLE, COMMAND_STAGED_META_TABLE];
  const entries = db
    .prepare(
      `SELECT type, name, sql FROM main.sqlite_schema
      WHERE name COLLATE NOCASE IN (?, ?) OR tbl_name COLLATE NOCASE IN (?, ?)`,
    )
    .all(...names, ...names) as Array<{ type: string; name: string; sql: string | null }>;
  const ddl = new Map([
    [COMMAND_STAGED_TABLE, SQLITE_STAGED_DDL],
    [COMMAND_STAGED_META_TABLE, SQLITE_STAGED_META_DDL],
    [`${COMMAND_STAGED_TABLE}_owner`, SQLITE_STAGED_INDEX_DDL],
  ]);
  const made = entries.filter((entry) => entry.sql !== null);
  const rows = made.some((entry) => entry.name === COMMAND_STAGED_META_TABLE)
    ? (() => {
        try {
          return db.prepare(`SELECT singleton, version FROM main."${COMMAND_STAGED_META_TABLE}"`).all();
        } catch {
          return [];
        }
      })()
    : [];
  if (
    made.length !== ddl.size ||
    made.some((entry) => ddl.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.sql === null && entry.type !== 'index') ||
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    rows[0].version !== COMMAND_STAGED_VERSION ||
    db.prepare(`SELECT 1 FROM temp.sqlite_schema WHERE tbl_name COLLATE NOCASE IN (?, ?) LIMIT 1`).get(...names)
  ) {
    throw new CommandStagingUnavailable(
      layoutRefusal('The store of files held for commands', sqliteLayoutVersion(db, COMMAND_STAGED_META_TABLE), COMMAND_STAGED_VERSION),
    );
  }
}

/** Inside the journal migration's transaction: create the store where it is missing, then attest it. */
export function provisionSqliteCommandStaging(db: DatabaseSync): boolean {
  const names = [COMMAND_STAGED_TABLE, COMMAND_STAGED_META_TABLE];
  const present = db
    .prepare(`SELECT 1 FROM main.sqlite_schema WHERE name COLLATE NOCASE IN (?, ?) OR tbl_name COLLATE NOCASE IN (?, ?) LIMIT 1`)
    .get(...names, ...names);
  if (!present) {
    db.exec(SQLITE_STAGED_DDL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
    db.exec(SQLITE_STAGED_INDEX_DDL.replace('CREATE INDEX ', 'CREATE INDEX main.'));
    db.exec(SQLITE_STAGED_META_DDL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
    db.prepare(`INSERT INTO main."${COMMAND_STAGED_META_TABLE}" (singleton, version) VALUES (1, ?)`).run(COMMAND_STAGED_VERSION);
  }
  assertSqliteCommandStaging(db);
  return !present;
}

/**
 * How many lapsed files, anyone's, each new one clears. The retention job removes them daily, but an App that keeps
 * everything forever runs none, and a visitor who never came back would leave theirs: a store that only takes files
 * as it sweeps them never grows past what is held, whatever the App's retention.
 */
export const STAGED_SWEEP = 32;

/* Whose count it is: the place's own store (an App's, or a tenant's, or the platform's), so one tenant's visitors never
   spend another's share, and a flood of files into one place leaves the others' room alone. */
const PLACE = 'store_id = ? AND source_id = ? AND realm = ? AND tenant_id = ?';

/** Holds one file, in the caller's open transaction, unless its sender (or, on a public form, every visitor) holds enough already. */
export function stageSqliteFile(
  db: DatabaseSync,
  appId: string,
  namespace: StagedNamespace,
  row: StagedFileRow,
  most: StagedLimits,
  now: number,
): void {
  if (!db.isTransaction) throw new CommandStagingUnavailable();
  assertSqliteCommandStaging(db);
  checkStagedRow(row);
  const table = `main."${COMMAND_STAGED_TABLE}"`;
  // What this sender let lapse goes first, so it never counts against them; and a few of anyone's (sweepStaged).
  db.prepare(`DELETE FROM ${table} WHERE app_id = ? AND owner = ? AND expires_at <= ?`).run(appId, row.owner, now);
  db.prepare(
    `DELETE FROM ${table} WHERE id_hash IN (SELECT id_hash FROM ${table} WHERE app_id = ? AND expires_at <= ? LIMIT ${STAGED_SWEEP})`,
  ).run(appId, now);
  const held = db
    .prepare(
      `SELECT count(*) AS files, coalesce(sum(size), 0) AS bytes FROM ${table} WHERE app_id = ? AND ${PLACE} AND owner = ? AND expires_at > ?`,
    )
    .get(appId, ...namespace, row.owner, now) as { files: number; bytes: number };
  if (Number(held.files) + 1 > most.files || Number(held.bytes) + row.size > most.bytes) throw new StagedFilesFull();
  if (most.shared) {
    const all = db
      .prepare(
        `SELECT coalesce(sum(size), 0) AS bytes FROM ${table} WHERE app_id = ? AND ${PLACE} AND substr(owner, 1, ?) = ? AND expires_at > ?`,
      )
      .get(appId, ...namespace, most.shared.prefix.length, most.shared.prefix, now) as { bytes: number };
    if (Number(all.bytes) + row.size > most.shared.bytes) throw new StagedFilesFull(true);
  }
  db.prepare(`INSERT INTO ${table} (id_hash, app_id, store_id, source_id, realm, tenant_id, owner, command_id, field, name, type, size, data, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.idHash,
    appId,
    ...namespace,
    row.owner,
    row.command,
    row.field,
    row.name,
    row.type,
    row.size,
    row.data,
    row.expiresAt,
  );
}

/** Takes the files, in the caller's open transaction: every one, deleted as it is read, or none and refused. */
export function takeSqliteStaged(db: DatabaseSync, appId: string, namespace: StagedNamespace, take: StagedTake): TakenFile[] {
  if (!db.isTransaction) throw new CommandStagingUnavailable();
  assertSqliteCommandStaging(db);
  checkStagedTake(take);
  const statement = db.prepare(`DELETE FROM main."${COMMAND_STAGED_TABLE}"
    WHERE id_hash = ? AND app_id = ? AND store_id = ? AND source_id = ? AND realm = ? AND tenant_id = ?
      AND owner = ? AND command_id = ? AND field = ? AND expires_at > ?
    RETURNING name, type, size, data`);
  return take.hashes.map((hash) => {
    const row = statement.get(hash, appId, ...namespace, take.owner, take.command, take.field, take.now) as
      | { name: string; type: string; size: number | bigint; data: Uint8Array }
      | undefined;
    // The transaction rolls back with the refusal, so a file taken before this one is held again.
    if (!row) throw new StagedFileRefused(take.field);
    return { name: row.name, type: row.type, size: Number(row.size), data: new Uint8Array(row.data) };
  });
}
