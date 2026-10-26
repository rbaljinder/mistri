import { statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isProxy } from 'node:util/types';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { assertSqliteCommandJournal, COMMAND_JOURNAL_TABLES } from '../commands/commandJournalSchema.js';

/** Stable private source identity, not a filename or request-selected tenant. */
export interface CommandEventStoreBinding {
  readonly appId: string;
  readonly storeId: string;
  readonly sourceId: string;
}

export class CommandEventStoreUnavailable extends Refusal {
  constructor(message = 'The command event store could not be verified. Explicit provisioning or operator review is required.') {
    super(message);
    this.name = 'CommandEventStoreUnavailable';
  }
}
const fail = (message?: string): never => {
  throw new CommandEventStoreUnavailable(message);
};
const prefix = '__mistri_event_';
/* Envelopes name their scope, 'app' or 'tenant', and carry a
   tenant only in tenant scope. */
const COMMAND_EVENT_STORE_VERSION = 1;
export const COMMAND_EVENT_TABLES = Object.freeze({
  meta: `${prefix}meta`,
  event: `${prefix}event`,
});
const tables = COMMAND_EVENT_TABLES;
const textColumn = (name: string, maximum: number) =>
  `${name} TEXT COLLATE BINARY NOT NULL CHECK (typeof(${name}) = 'text' AND instr(${name}, char(0)) = 0 AND length(CAST(${name} AS BLOB)) BETWEEN 1 AND ${maximum})`;
/* A batch's manifest, count and digest are its receipt's own columns
   (commandJournalSchema.ts): the events here hang off that row. */
const definitions = new Map<string, string>([
  [
    tables.meta,
    `CREATE TABLE "${tables.meta}" (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = ${COMMAND_EVENT_STORE_VERSION}),
  ${textColumn('app_id', 128)},
  ${textColumn('store_id', 256)},
  ${textColumn('source_id', 128)}
)`,
  ],
  [
    tables.event,
    `CREATE TABLE "${tables.event}" (
  ${textColumn('event_id', 36)} PRIMARY KEY,
  ${textColumn('receipt_id', 128)} REFERENCES "${COMMAND_JOURNAL_TABLES.receipt}" (id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (typeof(ordinal) = 'integer' AND ordinal BETWEEN 0 AND 31),
  ${textColumn('envelope_json', 131072)} CHECK (json_valid(envelope_json) AND json_type(envelope_json) = 'object'),
  UNIQUE (receipt_id, ordinal)
)`,
  ],
]);

/** Capture this small scalar contract without evaluating configuration hooks. */
export function captureCommandEventStoreBinding(input: CommandEventStoreBinding): CommandEventStoreBinding {
  if (!input || typeof input !== 'object' || Array.isArray(input) || isProxy(input)) return fail();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) return fail();
  const names = ['appId', 'storeId', 'sourceId'] as const;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== names.length || keys.some((key) => typeof key !== 'string' || !names.includes(key as (typeof names)[number])))
    return fail();
  const result: Record<string, string> = Object.create(null);
  for (const [index, name] of names.entries()) {
    const descriptor = Object.getOwnPropertyDescriptor(input, name);
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
    const value: unknown = descriptor.value;
    if (
      typeof value !== 'string' ||
      !value.length ||
      value !== value.trim() ||
      Buffer.byteLength(value, 'utf8') > [128, 256, 128][index] ||
      /\p{Cc}|[\uD800-\uDFFF]/u.test(value)
    )
      return fail();
    result[name] = value;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result.sourceId)) return fail();
  return Object.freeze({ appId: result.appId, storeId: result.storeId, sourceId: result.sourceId });
}
interface CatalogEntry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
function catalog(db: DatabaseSync, schema: 'main' | 'temp'): CatalogEntry[] {
  return db
    .prepare(`SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`)
    .all(prefix.length, prefix, prefix.length, prefix) as unknown as CatalogEntry[];
}

/** Presence is not attestation: any collision, including TEMP, counts as present. */
export function hasSqliteCommandEventStore(db: DatabaseSync): boolean {
  return catalog(db, 'main').length !== 0 || catalog(db, 'temp').length !== 0;
}

/** Structural/source attestation only; batch association is checked on reads. */
export function assertSqliteCommandEventStore(db: DatabaseSync, input: CommandEventStoreBinding): void {
  try {
    const owner = captureCommandEventStoreBinding(input);
    assertSqliteCommandJournal(db);
    const entries = catalog(db, 'main');
    if (
      catalog(db, 'temp').length ||
      entries.filter((entry) => entry.type === 'table').length !== definitions.size ||
      entries.some((entry) =>
        entry.type === 'table'
          ? definitions.get(entry.name) !== entry.sql
          : entry.type !== 'index' || entry.sql !== null || !definitions.has(entry.tbl_name),
      )
    )
      return fail(layoutRefusal('The command event store', sqliteLayoutVersion(db, tables.meta), COMMAND_EVENT_STORE_VERSION));
    const rows = db
      .prepare(`SELECT singleton, version, app_id, store_id, source_id,
      (typeof(app_id) = 'text' AND instr(app_id, char(0)) = 0
       AND typeof(store_id) = 'text' AND instr(store_id, char(0)) = 0
       AND typeof(source_id) = 'text' AND instr(source_id, char(0)) = 0) AS intact_text
      FROM main."${tables.meta}"`)
      .all();
    if (
      rows.length !== 1 ||
      rows[0].singleton !== 1 ||
      rows[0].version !== COMMAND_EVENT_STORE_VERSION ||
      rows[0].intact_text !== 1 ||
      rows[0].app_id !== owner.appId ||
      rows[0].store_id !== owner.storeId ||
      rows[0].source_id !== owner.sourceId
    )
      return fail(layoutRefusal('The command event store', rows.length === 1 ? rows[0].version : undefined, COMMAND_EVENT_STORE_VERSION));
  } catch (error) {
    if (error instanceof CommandEventStoreUnavailable) throw error;
    return fail();
  }
}

/** Explicit stopped-file maintenance; never creates a source or upgrades a namespace. */
export function provisionSqliteCommandEventStore(
  existingPath: string,
  input: CommandEventStoreBinding,
): { version: 1; provisioned: boolean } {
  let db: DatabaseSync | undefined;
  try {
    const owner = captureCommandEventStoreBinding(input);
    if (typeof existingPath !== 'string' || !statSync(existingPath).isFile()) return fail();
    db = new DatabaseSync(existingPath, { enableForeignKeyConstraints: true });
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    assertSqliteCommandJournal(db);
    const provisioned = !hasSqliteCommandEventStore(db);
    if (provisioned) {
      for (const ddl of definitions.values()) db.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE main.'));
      db.prepare(`INSERT INTO main."${tables.meta}" (singleton, version, app_id, store_id, source_id) VALUES (1, ?, ?, ?, ?)`).run(
        COMMAND_EVENT_STORE_VERSION,
        owner.appId,
        owner.storeId,
        owner.sourceId,
      );
    }
    assertSqliteCommandEventStore(db, owner);
    db.exec('COMMIT');
    return { version: COMMAND_EVENT_STORE_VERSION, provisioned };
  } catch {
    try {
      if (db?.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* Preserve refusal; discard the private handle. */
    }
    return fail();
  } finally {
    try {
      db?.close();
    } catch {
      fail();
    }
  }
}
