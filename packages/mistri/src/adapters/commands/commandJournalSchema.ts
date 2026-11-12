// The journal's layout and its attestation, apart from the journal that writes
// receipts: the event store's own attestation asks whether the journal is
// intact, and the journal appends to the event store, so keeping both in one
// file made them a loop. commandJournal.ts re-exports what callers import.

import type { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { cachedStatement } from '@mistriwork/engine/adapters/sqlite.js';
import { registerPrune } from '../retention/pruner.js';

export class CommandJournalUnavailable extends Refusal {
  constructor(
    message = `The command journal requires schema version ${JOURNAL_VERSION}. Run the explicit journal migration where no journal exists, or upgrade the App's stores where an older one does; neither changes anything else.`,
  ) {
    super(message);
    this.name = 'CommandJournalUnavailable';
  }
}

const PREFIX = '__mistri_command_';
export const COMMAND_JOURNAL_TABLES = Object.freeze({
  meta: `${PREFIX}meta`,
  receipt: `${PREFIX}receipt`,
  auditPart: `${PREFIX}audit_part`,
  link: `${PREFIX}link`,
});
/** Pass the unqualified catalog table name, never a SQL fragment or resource alias. */
export const isCommandJournalTable = (name: string): boolean => name.toLowerCase().startsWith(PREFIX);

/** The bounds of a receipt's per-target columns, over all its targets: a command's
 * changes are kept whole or not at all, so a bulk command past them is refused. */
export const COMMAND_TARGET_BOUNDS = Object.freeze({ owners: 65_536, keys: 2_097_152, changes: 4_194_304 });

/** How many changes one target's audit keeps in all, and how many of them sit in one stored piece: the receipt row
 * holds a target's first AUDIT_PART_ENTRIES, exactly as it always did, and the rest go to continuation rows of
 * AUDIT_PART_ENTRIES each (the audit-part table). The bytes of a target stay bounded by COMMAND_TARGET_BOUNDS. */
export const AUDIT_PART_ENTRIES = 256;
export const AUDIT_TARGET_ENTRIES = 4096;

/* One row per command: its receipt, the provenance it ran under, the
   resource it wrote and, per target in request order, the tenant owning the
   target row, its key and its changes (each a JSON array of the exact texts
   given), and its event batch when it recorded one. A receipt's realm joins
   its namespace (the platform realm's has no tenant); each owner is read
   from the stored row: its own tenant in a tenant's realm, '' for a
   platform-owned target. An unbound journal writes the tenant realm with
   the empty namespace. `completed_at` dates the row for retention.

   Version 2 adds the audit-part table: a target's changes past the first
   AUDIT_PART_ENTRIES, in pieces of that many, numbered from 1 under the
   receipt, the target's position in it and the piece. They are written in the
   receipt's own transaction and go with it when it is forgotten.

   Version 3 adds the link table: one row per capability link a command minted
   (server/links/), written in that command's own transaction. It holds the
   link's scope (App, tenant, resource, row key, declared name), its expiry,
   uses left and revocation, never its secret: the secret is derived from the
   form key and the row's id, so nothing that opens a row is at rest. It names
   the minting receipt without a key to it, so a receipt is forgotten on its
   own window while the link lives to its expiry. */
export const JOURNAL_VERSION = 3;
const meta = (version: number) => `CREATE TABLE "${COMMAND_JOURNAL_TABLES.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${version})
)`;
const array = (name: string, max: number) =>
  `${name} TEXT NOT NULL CHECK (json_valid(${name}) AND json_type(${name}) = 'array' AND length(CAST(${name} AS BLOB)) <= ${max})`;
const B = COMMAND_TARGET_BOUNDS;
const COMPLETED_INDEX = `${COMMAND_JOURNAL_TABLES.receipt}_completed`;
/* The audit-part table as version 2 lays it out: the upgrade from version 1 (storeLayouts.ts) creates exactly this text. */
const AUDIT_PART_DDL = `CREATE TABLE "${COMMAND_JOURNAL_TABLES.auditPart}" (
  receipt_id TEXT COLLATE BINARY NOT NULL REFERENCES "${COMMAND_JOURNAL_TABLES.receipt}" (id) ON DELETE CASCADE,
  target_index INTEGER NOT NULL CHECK (target_index >= 0),
  part INTEGER NOT NULL CHECK (part >= 1),
  ${array('changes_json', B.changes)},
  PRIMARY KEY (receipt_id, target_index, part)
)`;
/** What the upgrade from version 1 runs: the new table and the version row, which the meta table's own check pins. */
export const sqliteJournalUpgradeFrom1 = (): readonly string[] => [
  AUDIT_PART_DDL,
  `DROP TABLE "${COMMAND_JOURNAL_TABLES.meta}"`,
  meta(2),
  `INSERT INTO "${COMMAND_JOURNAL_TABLES.meta}" (singleton, version) VALUES (1, 2)`,
];
const LINK_INDEX = `${COMMAND_JOURNAL_TABLES.link}_row`;
/* The link table as version 3 lays it out: the upgrade from version 2 creates exactly this text. */
const LINK_DDL = `CREATE TABLE "${COMMAND_JOURNAL_TABLES.link}" (
  id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  app_id TEXT COLLATE BINARY NOT NULL,
  tenant_id TEXT COLLATE BINARY NOT NULL,
  resource TEXT COLLATE BINARY NOT NULL,
  row_key TEXT COLLATE BINARY NOT NULL,
  name TEXT COLLATE BINARY NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  uses_left INTEGER CHECK (uses_left IS NULL OR (typeof(uses_left) = 'integer' AND uses_left >= 0)),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  created_by TEXT COLLATE BINARY NOT NULL,
  command TEXT COLLATE BINARY NOT NULL,
  receipt TEXT COLLATE BINARY NOT NULL,
  opens INTEGER NOT NULL CHECK (opens >= 0),
  last_opened_at INTEGER
)`;
const LINK_INDEX_DDL = `CREATE INDEX "${LINK_INDEX}" ON "${COMMAND_JOURNAL_TABLES.link}" (app_id, resource, row_key)`;
/** What the upgrade from version 2 runs: the link table, its index and the version row. */
export const sqliteJournalUpgradeFrom2 = (): readonly string[] => [
  LINK_DDL,
  LINK_INDEX_DDL,
  `DROP TABLE "${COMMAND_JOURNAL_TABLES.meta}"`,
  meta(3),
  `INSERT INTO "${COMMAND_JOURNAL_TABLES.meta}" (singleton, version) VALUES (1, 3)`,
];

/* Old receipts are forgotten under the App's `commands` window
   (server/retention.ts). A receipt exists only once its command committed, so
   none is pending; one that carries an event batch stays while its events do,
   and one an event destination has taken up stays while its marker does. The
   tables are named, not imported: the event and delivery schemas import this
   file. */
registerPrune({
  id: 'command-receipts',
  window: 'commands',
  table: COMMAND_JOURNAL_TABLES.receipt,
  time: 'completed_at',
  clock: { sqlite: 'iso-text', postgres: 'timestamp' },
  where: () => 'manifest_json IS NULL',
  referencedBy: [
    { table: '__mistri_event_event', column: 'receipt_id' },
    { table: '__mistri_delivery_receipt', column: 'receipt_id' },
    { table: '__mistri_delivery_delivery', column: 'receipt_id' },
  ],
});
/* A link past its expiry opens nothing, whatever the App keeps of anything else: gone with the daily run. */
registerPrune({ id: 'command-links', window: 'expired', table: COMMAND_JOURNAL_TABLES.link, time: 'expires_at', clock: 'epoch-ms' });
export const definitions = new Map<string, string>([
  [COMMAND_JOURNAL_TABLES.meta, meta(JOURNAL_VERSION)],
  [
    COMMAND_JOURNAL_TABLES.receipt,
    `CREATE TABLE "${COMMAND_JOURNAL_TABLES.receipt}" (
  id TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
  app_id TEXT COLLATE BINARY NOT NULL,
  store_id TEXT COLLATE BINARY NOT NULL,
  source_id TEXT COLLATE BINARY NOT NULL,
  realm TEXT COLLATE BINARY NOT NULL CHECK (realm IN ('tenant', 'platform')),
  tenant_id TEXT COLLATE BINARY NOT NULL,
  actor_id TEXT COLLATE BINARY NOT NULL,
  command_id TEXT COLLATE BINARY NOT NULL,
  command_version INTEGER NOT NULL CHECK (command_version > 0),
  idempotency_key TEXT COLLATE BINARY NOT NULL,
  fingerprint TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 16384),
  request_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  membership_id TEXT COLLATE BINARY NOT NULL,
  membership_version TEXT COLLATE BINARY NOT NULL,
  realm_version TEXT COLLATE BINARY NOT NULL,
  roles_json TEXT NOT NULL CHECK (json_valid(roles_json) AND length(CAST(roles_json AS BLOB)) <= 65536),
  deployment TEXT COLLATE BINARY NOT NULL,
  target TEXT NOT NULL,
  ${array('owners_json', B.owners)},
  ${array('keys_json', B.keys)},
  ${array('changes_json', B.changes)},
  manifest_json TEXT CHECK (manifest_json IS NULL OR (typeof(manifest_json) = 'text' AND json_valid(manifest_json) AND json_type(manifest_json) = 'array' AND length(CAST(manifest_json AS BLOB)) BETWEEN 1 AND 65536)),
  event_count INTEGER CHECK (event_count IS NULL OR (typeof(event_count) = 'integer' AND event_count BETWEEN 1 AND 32)),
  digest TEXT CHECK (digest IS NULL OR (typeof(digest) = 'text' AND length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*')),
  CHECK (realm = 'tenant' OR tenant_id = ''),
  CHECK ((manifest_json IS NULL) = (event_count IS NULL) AND (manifest_json IS NULL) = (digest IS NULL)),
  UNIQUE (app_id, store_id, source_id, realm, tenant_id, actor_id, command_id, command_version, idempotency_key)
)`,
  ],
  [COMPLETED_INDEX, `CREATE INDEX "${COMPLETED_INDEX}" ON "${COMMAND_JOURNAL_TABLES.receipt}" (completed_at)`],
  [COMMAND_JOURNAL_TABLES.auditPart, AUDIT_PART_DDL],
  [COMMAND_JOURNAL_TABLES.link, LINK_DDL],
  [LINK_INDEX, LINK_INDEX_DDL],
]);
interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
export function catalog(db: DatabaseSync): CatalogEntry[] {
  return cachedStatement(
    db,
    `SELECT type, name, tbl_name, sql FROM main.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`,
  ).all(PREFIX.length, PREFIX, PREFIX.length, PREFIX) as unknown as CatalogEntry[];
}

/** Whether the reserved tables are exactly this layout at this version: every
 * table and named index by its stored text, and nothing else but the indexes
 * SQLite makes for a table's own keys. */
function isLayout(db: DatabaseSync, layout: ReadonlyMap<string, string>, version: number): boolean {
  // TEMP triggers can attach to main tables even without a reserved name.
  if (
    cachedStatement(
      db,
      `SELECT 1 FROM temp.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE LIMIT 1`,
    ).get(PREFIX.length, PREFIX, PREFIX.length, PREFIX)
  )
    return false;
  const entries = catalog(db);
  const named = entries.filter((entry) => entry.sql !== null);
  if (
    named.length !== layout.size ||
    named.some((entry) => layout.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.sql === null && !(entry.type === 'index' && layout.has(entry.tbl_name)))
  ) {
    return false;
  }
  const rows = cachedStatement(db, `SELECT singleton, version FROM main."${COMMAND_JOURNAL_TABLES.meta}"`).all();
  return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === version;
}

/** Exact schema attestation rejects unrelated tables, altered constraints, triggers and an older version. */
export function assertSqliteCommandJournal(db: DatabaseSync): void {
  /* Asked on every command a tenant writer runs (tenantWriteSource.ts): its statements are kept per handle, as a
     catalog scan's are (sqliteHandles.ts `cachedStatement`), and answer afresh each time. */
  if (!isLayout(db, definitions, JOURNAL_VERSION) || cachedStatement(db, 'PRAGMA foreign_keys').get()?.foreign_keys !== 1)
    throw new CommandJournalUnavailable(
      layoutRefusal('The command journal', sqliteLayoutVersion(db, COMMAND_JOURNAL_TABLES.meta), JOURNAL_VERSION),
    );
}
