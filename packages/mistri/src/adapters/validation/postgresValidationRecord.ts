/**
 * The validation record on PostgreSQL: its layout, its provisioning, and the
 * two statements a production start spends on it — one read before it decides
 * how much to check, one write once it has served.
 *
 * The read is the record and the catalog digest (postgresCatalogDigest.ts) in
 * one statement, so the digest is the catalog as it stood before anything the
 * start goes on to read: a record written with it can only match a later
 * catalog that no DDL has touched since, because every catalog change moves a
 * row's xmin and no change moves it back.
 *
 * Provisioned like every store (`mistri migrate stores up --app … --policy …`,
 * or `provisionStores`), never by a start: a database without it is simply
 * checked in full, as it always was.
 */
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { postgresCatalogDigestOf, postgresCatalogDigestStatement } from '@mistriwork/engine/adapters/postgresCatalogDigest.js';
import { SYSTEM_SCHEMAS } from '@mistriwork/engine/adapters/postgresCatalog.js';
import { withPostgresClient } from '@mistriwork/engine/adapters/postgresMaintenance.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import {
  VALIDATION_RECORD_LIMITS,
  VALIDATION_RECORD_PREFIX,
  VALIDATION_RECORD_TABLES,
  VALIDATION_RECORD_VERSION,
} from './validationRecord.js';

const { meta, record } = postgresRuntimeNames(VALIDATION_RECORD_TABLES);
const q = (name: string) => runtimeTable('postgres', name);
const L = VALIDATION_RECORD_LIMITS;

const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${VALIDATION_RECORD_VERSION})
)`,
  `CREATE TABLE ${q(record)} (
  app text COLLATE "C" NOT NULL CHECK (octet_length(app) <= ${L.app}),
  source text COLLATE "C" NOT NULL CHECK (octet_length(source) <= ${L.source}),
  build text NOT NULL CHECK (octet_length(build) = ${L.digest}),
  declarations text NOT NULL CHECK (octet_length(declarations) = ${L.digest}),
  schema text NOT NULL CHECK (octet_length(schema) <= ${L.schema}),
  migration text CHECK (octet_length(migration) <= ${L.migration}),
  tables jsonb NOT NULL CHECK (jsonb_typeof(tables) = 'object'),
  stores jsonb NOT NULL CHECK (jsonb_typeof(stores) = 'array'),
  mistri text NOT NULL CHECK (octet_length(mistri) <= ${L.mistri}),
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (app, source)
)`,
];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const column = (
  name: string,
  type: string,
  notnull = true,
  collation: string | null = null,
): PostgresRelationDescription['columns'][number] => ({
  name,
  type,
  notnull,
  collation,
  default: null,
});
const table = (
  name: string,
  columns: PostgresRelationDescription['columns'],
  constraints: string[],
  indexes: string[],
): PostgresRelationDescription => ({
  schema: runtimeSchema('postgres'),
  name,
  kind: 'r',
  rls: false,
  columns,
  constraints: [...constraints].sort(byCodeUnit),
  indexes: [...indexes].sort(byCodeUnit),
  triggers: 0,
  rules: 0,
  policies: 0,
});

/* What the DDL above reads back as, pinned so the attestation is of this layout, in the catalog's name order. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${VALIDATION_RECORD_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
  table(
    record,
    [
      column('app', 'text', true, 'C'),
      column('source', 'text', true, 'C'),
      column('build', 'text', true, 'default'),
      column('declarations', 'text', true, 'default'),
      column('schema', 'text', true, 'default'),
      column('migration', 'text', false, 'default'),
      column('tables', 'jsonb'),
      column('stores', 'jsonb'),
      column('mistri', 'text', true, 'default'),
      column('checked_at', 'timestamp with time zone'),
    ],
    [
      `CHECK ((octet_length(app) <= ${L.app}))`,
      `CHECK ((octet_length(source) <= ${L.source}))`,
      `CHECK ((octet_length(build) = ${L.digest}))`,
      `CHECK ((octet_length(declarations) = ${L.digest}))`,
      `CHECK ((octet_length(schema) <= ${L.schema}))`,
      `CHECK ((octet_length(migration) <= ${L.migration}))`,
      "CHECK ((jsonb_typeof(tables) = 'object'::text))",
      "CHECK ((jsonb_typeof(stores) = 'array'::text))",
      `CHECK ((octet_length(mistri) <= ${L.mistri}))`,
      'PRIMARY KEY (app, source)',
    ],
    [`CREATE UNIQUE INDEX ${record}_pkey ON ${runtimeSchema('postgres')}.${record} USING btree (app, source)`],
  ),
].sort((a, b) => byCodeUnit(a.name, b.name));

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);
const sortedDescription = (relations: PostgresRelationDescription[]) =>
  relations
    .map((relation) => ({
      ...relation,
      constraints: [...relation.constraints].sort(byCodeUnit),
      indexes: [...relation.indexes].sort(byCodeUnit),
    }))
    .sort((a, b) => byCodeUnit(a.name, b.name));

/** Whether the reserved relations are exactly this version's layout. */
export async function postgresValidationRecordReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = sortedDescription(await describePostgresRelations(client, VALIDATION_RECORD_PREFIX));
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === VALIDATION_RECORD_VERSION;
  } catch {
    return false;
  }
}

/**
 * Inside the caller's maintenance transaction: creates the store where none
 * is there, changes nothing where it is, and refuses anything else. Returns
 * whether this call made it.
 */
async function provisionPostgresValidationRecord(client: PgQuery): Promise<boolean> {
  let provisioned = false;
  if (!(await describePostgresRelations(client, VALIDATION_RECORD_PREFIX)).length) {
    for (const ddl of definitions) await client.query(ddl);
    await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [VALIDATION_RECORD_VERSION]);
    provisioned = true;
  }
  if (!(await postgresValidationRecordReady(client)))
    throw new Refusal(
      layoutRefusal('The validation record', await postgresLayoutVersion(client, q(meta)), VALIDATION_RECORD_VERSION) ??
        'The validation record is not the layout this version expects.',
    );
  return provisioned;
}

/** Explicit maintenance for the store on its own, under the shared migration lock. */
export async function provisionPostgresValidationRecordAt(
  url: string,
): Promise<{ version: typeof VALIDATION_RECORD_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Validation record provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => ({
    version: VALIDATION_RECORD_VERSION,
    provisioned: await provisionPostgresValidationRecord(client),
  }));
}

/** One App and source's record, as the store holds it. */
export interface StoredValidation {
  readonly build: string;
  readonly declarations: string;
  readonly schema: string;
  readonly migration: string | null;
  /** The per-table checked set: each resource's declaration digest, as the start that wrote it validated it. */
  readonly tables: Readonly<Record<string, string>>;
  /** The stores the deployment's enrollment attested, by their id in the store list. */
  readonly stores: readonly string[];
  readonly mistri: string;
  readonly checkedAt: string;
}

const DIGEST = postgresCatalogDigestStatement(SYSTEM_SCHEMAS);

/* A row is read as the layout holds it; anything else is no record. */
function storedOf(row: Record<string, unknown> | undefined): StoredValidation | undefined {
  if (!row || typeof row.build !== 'string') return undefined;
  const tables = row.tables,
    stores = row.stores;
  if (!tables || typeof tables !== 'object' || Array.isArray(tables) || Object.values(tables).some((value) => typeof value !== 'string'))
    return undefined;
  if (!Array.isArray(stores) || stores.some((value) => typeof value !== 'string')) return undefined;
  if (typeof row.declarations !== 'string' || typeof row.schema !== 'string' || typeof row.mistri !== 'string') return undefined;
  const at = row.checked_at instanceof Date ? row.checked_at.toISOString() : String(row.checked_at);
  return Object.freeze({
    build: row.build,
    declarations: row.declarations,
    schema: row.schema,
    migration: typeof row.migration === 'string' ? row.migration : null,
    tables: Object.freeze({ ...(tables as Record<string, string>) }),
    stores: Object.freeze([...(stores as string[])]),
    mistri: row.mistri,
    checkedAt: at,
  });
}

/**
 * The catalog digest and this App and source's record, in one statement. It
 * throws where the store is not there or cannot be read; the caller then
 * checks in full.
 */
export async function readPostgresValidationRecord(
  url: string,
  key: { readonly app: string; readonly source: string },
): Promise<{ digest: string; stored?: StoredValidation }> {
  return withPostgresClient(url, async (client) => {
    const result = await client.query(
      `SELECT d.fingerprint, r.build, r.declarations, r.schema, r.migration, r.tables, r.stores, r.mistri, r.checked_at
         FROM (${DIGEST}) d LEFT JOIN ${q(record)} r ON r.app = $1 AND r.source = $2`,
      [key.app, key.source],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    const stored = storedOf(row);
    return { digest: postgresCatalogDigestOf(result), ...(stored ? { stored } : {}) };
  });
}

/** A platform-only source's catalog digest: what its part of the schema fingerprint is. */
export async function readPostgresCatalogDigest(url: string): Promise<string> {
  return withPostgresClient(url, async (client) => postgresCatalogDigestOf(await client.query(DIGEST)));
}

/**
 * Keep what a start validated. One upsert keyed by App and source: two starts
 * that validated at once each write a record that is true, and the later one
 * stands. The latest applied migration rides along for the reader of the row,
 * read where the default history table is on the search path; the digest, not
 * it, is what a start compares, since a hand-run ALTER moves the one and not
 * the other.
 */
export async function writePostgresValidationRecord(
  url: string,
  key: { readonly app: string; readonly source: string },
  value: Omit<StoredValidation, 'migration' | 'checkedAt'>,
): Promise<void> {
  await withPostgresClient(url, async (client) => {
    await client.query(
      `INSERT INTO ${q(record)} (app, source, build, declarations, schema, migration, tables, stores, mistri, checked_at)
       SELECT $1, $2, $3, $4, $5,
              CASE WHEN to_regclass('__mistri_schema_history') IS NULL THEN NULL
                   ELSE (xpath('/row/v/text()', query_to_xml(
                     'SELECT version AS v FROM __mistri_schema_history WHERE success AND version IS NOT NULL ORDER BY installed_rank DESC LIMIT 1',
                     false, true, '')))[1]::text END,
              $6::jsonb, $7::jsonb, $8, now()
       ON CONFLICT (app, source) DO UPDATE SET build = EXCLUDED.build, declarations = EXCLUDED.declarations,
         schema = EXCLUDED.schema, migration = EXCLUDED.migration, tables = EXCLUDED.tables, stores = EXCLUDED.stores,
         mistri = EXCLUDED.mistri, checked_at = EXCLUDED.checked_at`,
      [
        key.app,
        key.source,
        value.build,
        value.declarations,
        value.schema,
        JSON.stringify(value.tables),
        JSON.stringify(value.stores),
        value.mistri,
      ],
    );
  });
}
