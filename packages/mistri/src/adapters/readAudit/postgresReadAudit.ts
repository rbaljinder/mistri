/**
 * The read audit on PostgreSQL: the SQLite layout, in the runtime schema
 * beside record history. Attestation compares the catalog description with
 * the pinned one, the identity column's sequence left out (see record
 * history), and counts the two rules that make the log append-only: rules
 * rather than triggers, as the account audit trail does (postgresAuthStore.ts),
 * so an UPDATE or DELETE by the App's own role does nothing instead of failing
 * a request that never meant to touch it.
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
  READ_AUDIT_AT_INDEX,
  READ_AUDIT_LIMITS,
  READ_AUDIT_PREFIX,
  READ_AUDIT_RECORD_INDEX,
  READ_AUDIT_TABLES,
  READ_AUDIT_VERSION,
  READ_ROUTES,
  ReadAuditUnavailable,
  assertReadAuditQuery,
  assertReadAuditRow,
  readAuditFilters,
  storedReadAudit,
  type ReadAuditQuery,
  type ReadAuditRow,
  type StoredReadAudit,
} from './readAudit.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const { meta, row: log } = postgresRuntimeNames(READ_AUDIT_TABLES);
const q = (name: string) => runtimeTable('postgres', name);
const layoutMessage = async (client: PgQuery) =>
  layoutRefusal('The read audit store', await postgresLayoutVersion(client, q(meta)), READ_AUDIT_VERSION);

const routes = READ_ROUTES.map((route) => `'${route}'`).join(', ');
const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${READ_AUDIT_VERSION})
)`,
  `CREATE TABLE ${q(log)} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL,
  app text COLLATE "C" NOT NULL CHECK (octet_length(app) <= ${READ_AUDIT_LIMITS.app}),
  tenant text COLLATE "C" NOT NULL CHECK (octet_length(tenant) <= ${READ_AUDIT_LIMITS.tenant}),
  actor text COLLATE "C" NOT NULL CHECK (octet_length(actor) <= ${READ_AUDIT_LIMITS.actor}),
  visit text COLLATE "C" CHECK (octet_length(visit) <= ${READ_AUDIT_LIMITS.visit}),
  resource text COLLATE "C" NOT NULL CHECK (octet_length(resource) <= ${READ_AUDIT_LIMITS.resource}),
  route text NOT NULL CHECK (route IN (${routes})),
  record_key text COLLATE "C" CHECK (octet_length(record_key) <= ${READ_AUDIT_LIMITS.record}),
  query_json text CHECK (octet_length(query_json) <= ${READ_AUDIT_LIMITS.query}),
  row_count integer CHECK (row_count >= 0),
  ids_json text CHECK (octet_length(ids_json) <= ${READ_AUDIT_LIMITS.ids})
)`,
  `CREATE INDEX "${READ_AUDIT_RECORD_INDEX}" ON ${q(log)} (resource, record_key, id)`,
  `CREATE INDEX "${READ_AUDIT_AT_INDEX}" ON ${q(log)} (at)`,
  `CREATE RULE "${log}_no_update" AS ON UPDATE TO ${q(log)} DO INSTEAD NOTHING`,
  `CREATE RULE "${log}_no_delete" AS ON DELETE TO ${q(log)} DO INSTEAD NOTHING`,
];

const AT_ISO = `to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

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
  rules = 0,
): PostgresRelationDescription => ({
  schema: runtimeSchema('postgres'),
  name,
  kind: 'r',
  rls: false,
  columns,
  constraints: [...constraints].sort(byCodeUnit),
  indexes: [...indexes].sort(byCodeUnit),
  triggers: 0,
  rules,
  policies: 0,
});
const bytes = (name: string, limit: number) => `CHECK ((octet_length(${name}) <= ${limit}))`;

/* What the DDL above reads back as, pinned so the attestation is of this layout. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${READ_AUDIT_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
  table(
    log,
    [
      column('id', 'bigint'),
      column('at', 'timestamp with time zone'),
      column('app', 'text', 'C'),
      column('tenant', 'text', 'C'),
      column('actor', 'text', 'C'),
      column('visit', 'text', 'C', false),
      column('resource', 'text', 'C'),
      column('route', 'text', 'default'),
      column('record_key', 'text', 'C', false),
      column('query_json', 'text', 'default', false),
      column('row_count', 'integer', null, false),
      column('ids_json', 'text', 'default', false),
    ],
    [
      bytes('app', READ_AUDIT_LIMITS.app),
      bytes('tenant', READ_AUDIT_LIMITS.tenant),
      bytes('actor', READ_AUDIT_LIMITS.actor),
      bytes('visit', READ_AUDIT_LIMITS.visit),
      bytes('resource', READ_AUDIT_LIMITS.resource),
      bytes('record_key', READ_AUDIT_LIMITS.record),
      bytes('query_json', READ_AUDIT_LIMITS.query),
      bytes('ids_json', READ_AUDIT_LIMITS.ids),
      `CHECK ((route = ANY (ARRAY[${READ_ROUTES.map((route) => `'${route}'::text`).join(', ')}])))`,
      'CHECK ((row_count >= 0))',
      'PRIMARY KEY (id)',
    ],
    [
      `CREATE INDEX ${READ_AUDIT_AT_INDEX} ON ${runtimeSchema('postgres')}.${log} USING btree (at)`,
      `CREATE INDEX ${READ_AUDIT_RECORD_INDEX} ON ${runtimeSchema('postgres')}.${log} USING btree (resource, record_key, id)`,
      `CREATE UNIQUE INDEX ${log}_pkey ON ${runtimeSchema('postgres')}.${log} USING btree (id)`,
    ],
    2,
  ),
];

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

/** Whether the reserved relations are exactly this version's layout, rules included. */
export async function postgresReadAuditReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = (await describePostgresRelations(client, READ_AUDIT_PREFIX)).filter(
      (relation) => !(relation.kind === 'S' && relation.schema === runtimeSchema('postgres') && relation.name === `${log}_id_seq`),
    );
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === READ_AUDIT_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version
 * where no store exists, changes nothing where it does, refuses anything else. */
export async function provisionPostgresReadAudit(url: string): Promise<{ version: typeof READ_AUDIT_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Read audit provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await describePostgresRelations(client, READ_AUDIT_PREFIX)).length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [READ_AUDIT_VERSION]);
      provisioned = true;
    }
    if (!(await postgresReadAuditReady(client))) throw new ReadAuditUnavailable(await layoutMessage(client));
    return { version: READ_AUDIT_VERSION, provisioned };
  });
}

const COLUMNS = 11;

/**
 * Rows gathered by a group commit (groupCommit.ts), in one INSERT: one
 * statement, so they are written together or not at all, and every read they
 * name is answered alike.
 */
export async function appendPostgresReadAudits(client: PgQuery, rows: readonly ReadAuditRow[], attested = false): Promise<void> {
  for (const row of rows) assertReadAuditRow(row);
  if (!rows.length) return;
  if (!attested && !(await postgresReadAuditReady(client))) throw new ReadAuditUnavailable(await layoutMessage(client));
  const places = rows.map((_, at) => `(${Array.from({ length: COLUMNS }, (_, column) => `$${at * COLUMNS + column + 1}`).join(', ')})`);
  await client.query(
    `INSERT INTO ${q(log)} (at, app, tenant, actor, visit, resource, route, record_key, query_json, row_count, ids_json)
    VALUES ${places.join(', ')}`,
    rows.flatMap((row) => [
      row.at,
      row.app,
      row.tenant,
      row.actor,
      row.visit ?? null,
      row.resource,
      row.route,
      row.record ?? null,
      row.query ?? null,
      row.count ?? null,
      row.ids ?? null,
    ]),
  );
}

/* `attested`: the adapter holds an attestation under the schema epoch it just read (postgres.ts, storeAttested). */
export async function readPostgresReadAudit(client: PgQuery, query: ReadAuditQuery, attested = false): Promise<StoredReadAudit[]> {
  assertReadAuditQuery(query);
  if (!attested && !(await postgresReadAuditReady(client))) throw new ReadAuditUnavailable(await layoutMessage(client));
  const filters = readAuditFilters(query);
  const values = filters.map(([, , value]) => value);
  const result = await client.query(
    `SELECT id::text AS id, ${AT_ISO} AS at, app, tenant, actor, visit, resource, route, record_key, query_json, row_count, ids_json
    FROM ${q(log)} ${filters.length ? `WHERE ${filters.map(([name, op], index) => `${name} ${op} $${index + 1}`).join(' AND ')}` : ''}
    ORDER BY id DESC LIMIT $${values.length + 1}`,
    [...values, query.limit],
  );
  return (result.rows as Array<Record<string, unknown>>).map(storedReadAudit);
}
