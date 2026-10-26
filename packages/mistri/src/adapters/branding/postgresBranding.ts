/**
 * Tenant branding on PostgreSQL: the SQLite layout, in the runtime schema
 * without the prefix, attested as the inbox's is — the catalog description
 * (columns, types, collations, constraints, indexes, and no trigger, rule or
 * policy) compared with the one provisioning produces.
 *
 * A save runs on a writer's client inside the transaction its caller owns.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import {
  BRANDING_LIMITS,
  BRANDING_PREFIX,
  BRANDING_TABLES,
  BRANDING_VERSION,
  BrandingUnavailable,
  assertBrandingLogoQuery,
  assertBrandingQuery,
  assertBrandingWrite,
  type BrandingLogoQuery,
  type BrandingQuery,
  type BrandingWrite,
  type StoredBranding,
  type StoredBrandingLogo,
} from './branding.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const { meta, value, logo } = postgresRuntimeNames(BRANDING_TABLES);
const q = (name: string) => runtimeTable('postgres', name);
/** Why the layout was refused, when the version row says: a newer or an older store (see layoutRefusal.ts). */
const layoutMessage = async (client: PgQuery) =>
  layoutRefusal('The branding store', await postgresLayoutVersion(client, q(meta)), BRANDING_VERSION);

const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${BRANDING_VERSION})
)`,
  `CREATE TABLE ${q(value)} (
  app text COLLATE "C" NOT NULL CHECK (octet_length(app) <= ${BRANDING_LIMITS.app}),
  tenant text COLLATE "C" NOT NULL CHECK (octet_length(tenant) <= ${BRANDING_LIMITS.tenant}),
  value_json text NOT NULL CHECK (octet_length(value_json) <= ${BRANDING_LIMITS.value} AND value_json::json IS NOT NULL),
  logo_hash text COLLATE "C",
  revision integer NOT NULL,
  saved_by text NOT NULL,
  saved_at text NOT NULL,
  PRIMARY KEY (app, tenant)
)`,
  `CREATE TABLE ${q(logo)} (
  app text COLLATE "C" NOT NULL,
  hash text COLLATE "C" NOT NULL,
  type text NOT NULL,
  bytes bytea NOT NULL CHECK (octet_length(bytes) <= ${BRANDING_LIMITS.logo}),
  PRIMARY KEY (app, hash)
)`,
];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const column = (
  name: string,
  type: string,
  collation: string | null = null,
  notnull = true,
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

/* What the DDL above reads back as, pinned so the attestation is of this
   layout, kept in the catalog's name order. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${BRANDING_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
  table(
    value,
    [
      column('app', 'text', 'C'),
      column('tenant', 'text', 'C'),
      column('value_json', 'text', 'default'),
      column('logo_hash', 'text', 'C', false),
      column('revision', 'integer'),
      column('saved_by', 'text', 'default'),
      column('saved_at', 'text', 'default'),
    ],
    [
      `CHECK ((octet_length(app) <= ${BRANDING_LIMITS.app}))`,
      `CHECK ((octet_length(tenant) <= ${BRANDING_LIMITS.tenant}))`,
      `CHECK (((octet_length(value_json) <= ${BRANDING_LIMITS.value}) AND ((value_json)::json IS NOT NULL)))`,
      'PRIMARY KEY (app, tenant)',
    ],
    [`CREATE UNIQUE INDEX ${value}_pkey ON ${runtimeSchema('postgres')}.${value} USING btree (app, tenant)`],
  ),
  table(
    logo,
    [column('app', 'text', 'C'), column('hash', 'text', 'C'), column('type', 'text', 'default'), column('bytes', 'bytea')],
    [`CHECK ((octet_length(bytes) <= ${BRANDING_LIMITS.logo}))`, 'PRIMARY KEY (app, hash)'],
    [`CREATE UNIQUE INDEX ${logo}_pkey ON ${runtimeSchema('postgres')}.${logo} USING btree (app, hash)`],
  ),
].sort((a, b) => byCodeUnit(a.name, b.name));

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

/** Whether the reserved relations are exactly this version's layout. */
export async function postgresBrandingReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = await describePostgresRelations(client, BRANDING_PREFIX);
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === BRANDING_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version
 * where no store exists, changes nothing where it does, refuses anything else. */
export async function provisionPostgresBranding(url: string): Promise<{ version: typeof BRANDING_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Branding store provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await describePostgresRelations(client, BRANDING_PREFIX)).length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [BRANDING_VERSION]);
      provisioned = true;
    }
    if (!(await postgresBrandingReady(client))) throw new BrandingUnavailable(await layoutMessage(client));
    return { version: BRANDING_VERSION, provisioned };
  });
}

/** One tenant's saved branding in one App, or null when it has saved none. */
export async function readPostgresBranding(client: PgQuery, query: BrandingQuery, attested = false): Promise<StoredBranding | null> {
  assertBrandingQuery(query);
  if (!attested && !(await postgresBrandingReady(client))) throw new BrandingUnavailable(await layoutMessage(client));
  const row = (
    await client.query(`SELECT value_json, revision, saved_by, saved_at FROM ${q(value)} WHERE app = $1 AND tenant = $2`, [
      query.app,
      query.tenant,
    ])
  ).rows[0] as Record<string, unknown> | undefined;
  return row
    ? {
        value: String(row.value_json),
        revision: Number(row.revision),
        by: String(row.saved_by),
        at: String(row.saved_at),
      }
    : null;
}

/** A logo by the hash of its bytes. */
export async function readPostgresBrandingLogo(
  client: PgQuery,
  query: BrandingLogoQuery,
  attested = false,
): Promise<StoredBrandingLogo | null> {
  assertBrandingLogoQuery(query);
  if (!attested && !(await postgresBrandingReady(client))) throw new BrandingUnavailable(await layoutMessage(client));
  const row = (await client.query(`SELECT type, bytes FROM ${q(logo)} WHERE app = $1 AND hash = $2`, [query.app, query.hash])).rows[0] as
    | { type: string; bytes: Uint8Array }
    | undefined;
  return row ? { type: row.type, bytes: new Uint8Array(row.bytes) } : null;
}

/**
 * A save, on a writer's client inside a transaction the caller owns: the new
 * logo, the value at the next revision, and the removal of this App's logos
 * no tenant's value names any more. Returns the new revision.
 */
export async function writePostgresBranding(client: PgQuery, write: BrandingWrite, attested = false): Promise<number> {
  assertBrandingWrite(write);
  if (!attested && !(await postgresBrandingReady(client))) throw new BrandingUnavailable(await layoutMessage(client));
  if (write.logo) {
    await client.query(`INSERT INTO ${q(logo)} (app, hash, type, bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (app, hash) DO NOTHING`, [
      write.app,
      write.logo.hash,
      write.logo.type,
      Buffer.from(write.logo.bytes),
    ]);
  }
  if (write.darkLogo) {
    await client.query(`INSERT INTO ${q(logo)} (app, hash, type, bytes) VALUES ($1, $2, $3, $4) ON CONFLICT (app, hash) DO NOTHING`, [
      write.app,
      write.darkLogo.hash,
      write.darkLogo.type,
      Buffer.from(write.darkLogo.bytes),
    ]);
  }
  const darkHash = (JSON.parse(write.value) as { logoDark?: { hash?: string } }).logoDark?.hash;
  if (darkHash && !(await client.query(`SELECT 1 FROM ${q(logo)} WHERE app = $1 AND hash = $2`, [write.app, darkHash])).rows.length)
    throw new Refusal('Branding: the dark logo the value names is not stored.');
  if (
    write.logoHash !== null &&
    !(await client.query(`SELECT 1 FROM ${q(logo)} WHERE app = $1 AND hash = $2`, [write.app, write.logoHash])).rows.length
  )
    throw new Refusal('Branding: the logo the value names is not stored.');
  const saved = await client.query(
    `INSERT INTO ${q(value)} (app, tenant, value_json, logo_hash, revision, saved_by, saved_at)
    VALUES ($1, $2, $3, $4, 1, $5, $6)
    ON CONFLICT (app, tenant) DO UPDATE SET value_json = EXCLUDED.value_json, logo_hash = EXCLUDED.logo_hash,
      revision = ${q(value)}.revision + 1, saved_by = EXCLUDED.saved_by, saved_at = EXCLUDED.saved_at
    RETURNING revision`,
    [write.app, write.tenant, write.value, write.logoHash, write.by, write.at],
  );
  await client.query(
    `DELETE FROM ${q(logo)} WHERE app = $1 AND hash NOT IN (SELECT logo_hash FROM ${q(value)} WHERE app = $1 AND logo_hash IS NOT NULL)
    AND hash NOT IN (SELECT value_json::json #>> '{logoDark,hash}' FROM ${q(value)} WHERE app = $1 AND value_json::json #>> '{logoDark,hash}' IS NOT NULL)`,
    [write.app],
  );
  return Number(saved.rows[0].revision);
}
