/** Dedicated placement storage. No native journal migration or
 * synthetic membership namespace. Provisioning is an explicit owner action. */
import { statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, postgresLayoutVersion, sqliteLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { describePostgresRelations, type PostgresRelationDescription } from './postgresRelations.js';
import { withPostgresMaintenanceTransaction } from './postgresCommandJournal.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

export const PUBLIC_PLACEMENT_PREFIX = '__mistri_public_placement_';
export const PUBLIC_PLACEMENT_TABLES = Object.freeze({
  receipt: `${PUBLIC_PLACEMENT_PREFIX}receipt`,
  meta: `${PUBLIC_PLACEMENT_PREFIX}meta`,
});
const { receipt, meta } = PUBLIC_PLACEMENT_TABLES;
const FORMAT_OWNER = 'mistri.public-placement';
const VERSION = 1;
const metaColumns = ['singleton', 'version', 'format_owner', 'schema_fingerprint'] as const;
export const placementNamespaceColumns = [
  'issuer_id',
  'source_identity',
  'app_id',
  'form',
  'tenant',
  'command_id',
  'command_version',
  'submission',
] as const;
export const placementReceiptColumns = [
  'id',
  ...placementNamespaceColumns,
  'fingerprint',
  'result_json',
  'request_id',
  'completed_at',
  'epoch',
  /* The submission's audit, in the receipt's own row as the command journal
     keeps it: the resource it wrote, and per target its key and its changes,
     each a JSON array of the exact texts given. */
  'target',
  'keys_json',
  'changes_json',
] as const;
const integer = (name: string) => ['command_version', 'ordinal', 'singleton', 'version'].includes(name);
const q = (name: string) => `"${name}"`;
export const placementTable = (dialect: 'sqlite' | 'postgres', name: string) => runtimeTable(dialect, name);
const fail = (message?: string): never => {
  throw new Refusal(message ?? 'Public placement journal requires explicit v1 provisioning and an intact layout.');
};

function definitions(dialect: 'sqlite' | 'postgres'): ReadonlyMap<string, string> {
  const pg = dialect === 'postgres';
  const column = (name: string) => `${name} ${integer(name) ? 'INTEGER' : `TEXT COLLATE ${pg ? '"C"' : 'BINARY'}`} NOT NULL`;
  const at = (name: string) => (pg ? placementTable(dialect, name) : q(name));
  return new Map([
    [
      receipt,
      `CREATE TABLE ${at(receipt)} (\n  ${placementReceiptColumns.map(column).join(',\n  ')},\n  CONSTRAINT tw_pp_receipt_pk PRIMARY KEY (id),\n  CONSTRAINT tw_pp_receipt_scope UNIQUE (${placementNamespaceColumns.join(', ')})\n)`,
    ],
    [
      meta,
      `CREATE TABLE ${at(meta)} (\n  ${metaColumns.map(column).join(',\n  ')},\n  CONSTRAINT tw_pp_meta_pk PRIMARY KEY (singleton)\n)`,
    ],
  ]);
}

// Stable format ownership, not an issuer, tenant membership, connection alias
// or deployment epoch. Only explicit provisioning writes this durable marker.
const fingerprintOf = (dialect: 'sqlite' | 'postgres', entries: unknown[]) =>
  createHash('sha256')
    .update(canonicalCommandJson([FORMAT_OWNER, VERSION, dialect, entries], 1_048_576))
    .digest('hex');
const fingerprints = Object.fromEntries(
  (['sqlite', 'postgres'] as const).map((dialect) => [dialect, fingerprintOf(dialect, [...definitions(dialect)])]),
);
const layoutMessage = (found: unknown) => layoutRefusal('The public placement journal', found, VERSION);
function attestMarker(rows: Record<string, unknown>[], dialect: 'sqlite' | 'postgres'): void {
  if (
    rows.length !== 1 ||
    rows[0].singleton !== 1 ||
    rows[0].version !== VERSION ||
    rows[0].format_owner !== FORMAT_OWNER ||
    rows[0].schema_fingerprint !== fingerprints[dialect]
  )
    fail(layoutMessage(rows.length === 1 ? rows[0].version : undefined));
}

interface Entry {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
function sqliteEntries(db: DatabaseSync, schema: 'main' | 'temp'): Entry[] {
  return db
    .prepare(
      `SELECT type, name, tbl_name, sql FROM ${schema}.sqlite_schema
    WHERE substr(name, 1, ?) = ? COLLATE NOCASE OR substr(tbl_name, 1, ?) = ? COLLATE NOCASE`,
    )
    .all(
      PUBLIC_PLACEMENT_PREFIX.length,
      PUBLIC_PLACEMENT_PREFIX,
      PUBLIC_PLACEMENT_PREFIX.length,
      PUBLIC_PLACEMENT_PREFIX,
    ) as unknown as Entry[];
}

/** Introspection only: never creates tables on serve or recovery. */
export function assertSqlitePublicPlacementJournal(db: DatabaseSync): void {
  const layout = definitions('sqlite'),
    entries = sqliteEntries(db, 'main');
  const tables = entries.filter((entry) => entry.type === 'table');
  if (
    db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1 ||
    sqliteEntries(db, 'temp').length ||
    tables.length !== layout.size ||
    tables.some((entry) => layout.get(entry.name) !== entry.sql) ||
    entries.some((entry) => entry.type !== 'table' && !(entry.type === 'index' && entry.sql === null && layout.has(entry.tbl_name)))
  )
    fail(layoutMessage(sqliteLayoutVersion(db, meta)));
  attestMarker(db.prepare(`SELECT ${metaColumns.join(', ')} FROM ${placementTable('sqlite', meta)}`).all(), 'sqlite');
}

export function provisionSqlitePublicPlacementJournal(path: string): {
  version: 1;
  provisioned: boolean;
} {
  if (!statSync(path).isFile()) fail();
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    try {
      const provisioned = sqliteEntries(db, 'main').length === 0;
      if (provisioned) {
        for (const ddl of definitions('sqlite').values()) db.exec(ddl.replace('CREATE TABLE ', 'CREATE TABLE main.'));
        db.prepare(`INSERT INTO ${placementTable('sqlite', meta)} (${metaColumns.join(', ')}) VALUES (?, ?, ?, ?)`).run(
          1,
          VERSION,
          FORMAT_OWNER,
          fingerprints.sqlite,
        );
      }
      assertSqlitePublicPlacementJournal(db);
      db.exec('COMMIT');
      return { version: 1, provisioned };
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* Preserve cause. */
      }
      throw error;
    }
  } finally {
    db.close();
  }
}

const sorted = (items: string[]) => items.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
function pgTable(name: string, columns: readonly string[], constraints: string[], indexes: string[]): PostgresRelationDescription {
  return {
    schema: runtimeSchema('postgres'),
    name,
    kind: 'r',
    rls: false,
    triggers: 0,
    rules: 0,
    policies: 0,
    columns: columns.map((name) => ({
      name,
      type: integer(name) ? 'integer' : 'text',
      notnull: true,
      collation: integer(name) ? null : 'C',
      default: null,
    })),
    constraints: sorted(constraints),
    indexes: sorted(indexes),
  };
}
// Expected catalog shape derived from our fixed DDL, never learned from the
// installed database. Deliberately separate from parameterized receipt SQL.
const pgMeta = runtimeName('postgres', meta),
  pgReceipt = runtimeName('postgres', receipt);
const pgLayout = [
  pgTable(
    pgMeta,
    metaColumns,
    ['PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX tw_pp_meta_pk ON ${runtimeSchema('postgres')}.${pgMeta} USING btree (singleton)`],
  ),
  pgTable(
    pgReceipt,
    placementReceiptColumns,
    ['PRIMARY KEY (id)', `UNIQUE (${placementNamespaceColumns.join(', ')})`],
    [
      `CREATE UNIQUE INDEX tw_pp_receipt_pk ON ${runtimeSchema('postgres')}.${pgReceipt} USING btree (id)`,
      `CREATE UNIQUE INDEX tw_pp_receipt_scope ON ${runtimeSchema('postgres')}.${pgReceipt} USING btree (${placementNamespaceColumns.join(', ')})`,
    ],
  ),
];

export async function assertPostgresPublicPlacementJournal(db: PgQuery): Promise<void> {
  const actual = await describePostgresRelations(db, PUBLIC_PLACEMENT_PREFIX);
  if (canonicalCommandJson(actual, 1_048_576) !== canonicalCommandJson(pgLayout, 1_048_576))
    fail(layoutMessage(await postgresLayoutVersion(db, placementTable('postgres', meta))));
  attestMarker((await db.query(`SELECT ${metaColumns.join(', ')} FROM ${placementTable('postgres', meta)}`)).rows, 'postgres');
}

/** DDL pin before introspection, held through transaction completion. */
export async function pinPostgresPublicPlacementJournal(db: PgQuery): Promise<void> {
  await db.query(`LOCK TABLE ${placementTable('postgres', meta)}, ${placementTable('postgres', receipt)} IN ROW EXCLUSIVE MODE`);
  // A marker is a data fact too: hold it against UPDATE/DELETE through commit.
  await db.query(`SELECT singleton FROM ${placementTable('postgres', meta)} FOR SHARE`);
  await assertPostgresPublicPlacementJournal(db);
}

export function provisionPostgresPublicPlacementJournal(url: string): Promise<{ version: 1; provisioned: boolean }> {
  return withPostgresMaintenanceTransaction(url, async (db) => {
    const provisioned = (await describePostgresRelations(db, PUBLIC_PLACEMENT_PREFIX)).length === 0;
    if (provisioned) {
      for (const ddl of definitions('postgres').values()) await db.query(ddl);
      await db.query(`INSERT INTO ${placementTable('postgres', meta)} (${metaColumns.join(', ')}) VALUES ($1, $2, $3, $4)`, [
        1,
        VERSION,
        FORMAT_OWNER,
        fingerprints.postgres,
      ]);
    }
    await pinPostgresPublicPlacementJournal(db);
    return { version: 1, provisioned };
  });
}
