/**
 * Record history on PostgreSQL: the SQLite layout, in the runtime schema
 * beside the command journal (runtimeTables.ts says why a schema). Attestation compares
 * the catalog description the journal's attestation reads (columns, types,
 * collations, constraints, indexes, and no trigger, rule or policy) with the
 * one provisioning produces; the identity column's own sequence is left out
 * of it, since its settings change no row a write appends.
 *
 * The append runs on the business write's leased client inside its
 * transaction; the read runs on a reader, like any other read.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { beforeCommit } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import {
  RECORD_HISTORY_AT_INDEX,
  RECORD_HISTORY_INDEX,
  RECORD_HISTORY_LIMITS,
  RECORD_HISTORY_PREFIX,
  RECORD_HISTORY_TABLES,
  RECORD_HISTORY_VERSION,
  RecordHistoryUnavailable,
  assertActivityQuery,
  assertChangeRow,
  assertHistoryQuery,
  parseStoredChanges,
  type RecordActivityQuery,
  type RecordChangeRow,
  type RecordHistoryQuery,
  type StoredRecordChange,
} from './recordHistory.js';
import type { WriteVia } from '@mistriwork/engine/adapters/writeAttribution.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const { meta, change } = postgresRuntimeNames(RECORD_HISTORY_TABLES);
const q = (name: string) => runtimeTable('postgres', name);
/** Why the layout was refused, when the version row says: a newer or an older store (see layoutRefusal.ts). */
const layoutMessage = async (client: PgQuery) =>
  layoutRefusal('The record history store', await postgresLayoutVersion(client, q(meta)), RECORD_HISTORY_VERSION);

const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${RECORD_HISTORY_VERSION})
)`,
  `CREATE TABLE ${q(change)} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  write_id text COLLATE "C" NOT NULL,
  at timestamptz NOT NULL,
  resource text COLLATE "C" NOT NULL CHECK (octet_length(resource) <= ${RECORD_HISTORY_LIMITS.resource}),
  key_json text COLLATE "C" NOT NULL CHECK (octet_length(key_json) <= ${RECORD_HISTORY_LIMITS.key} AND key_json::json IS NOT NULL),
  kind text NOT NULL CHECK (kind IN ('insert', 'update', 'delete')),
  changes_json text NOT NULL CHECK (octet_length(changes_json) <= ${RECORD_HISTORY_LIMITS.changes} AND changes_json::json IS NOT NULL),
  actor text COLLATE "C" NOT NULL,
  actor_name text NOT NULL,
  via text NOT NULL CHECK (via IN ('app', 'workbench', 'agent', 'api', 'form', 'system')),
  action text NOT NULL
)`,
  `CREATE INDEX "${RECORD_HISTORY_INDEX}" ON ${q(change)} (resource, key_json, id)`,
  `CREATE INDEX "${RECORD_HISTORY_AT_INDEX}" ON ${q(change)} (at)`,
];

/** `at` as the store speaks it everywhere else: the instant in `toISOString()` form, whatever zone the session is in. */
const AT_ISO = `to_char(c.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const column = (name: string, type: string, collation: string | null = null): PostgresRelationDescription['columns'][number] => ({
  name,
  type,
  notnull: true,
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
   layout and not of whatever is there. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    change,
    [
      column('id', 'bigint'),
      column('write_id', 'text', 'C'),
      column('at', 'timestamp with time zone'),
      column('resource', 'text', 'C'),
      column('key_json', 'text', 'C'),
      column('kind', 'text', 'default'),
      column('changes_json', 'text', 'default'),
      column('actor', 'text', 'C'),
      column('actor_name', 'text', 'default'),
      column('via', 'text', 'default'),
      column('action', 'text', 'default'),
    ],
    [
      `CHECK ((kind = ANY (ARRAY['insert'::text, 'update'::text, 'delete'::text])))`,
      `CHECK (((octet_length(changes_json) <= ${RECORD_HISTORY_LIMITS.changes}) AND ((changes_json)::json IS NOT NULL)))`,
      `CHECK (((octet_length(key_json) <= ${RECORD_HISTORY_LIMITS.key}) AND ((key_json)::json IS NOT NULL)))`,
      `CHECK ((octet_length(resource) <= ${RECORD_HISTORY_LIMITS.resource}))`,
      `CHECK ((via = ANY (ARRAY['app'::text, 'workbench'::text, 'agent'::text, 'api'::text, 'form'::text, 'system'::text])))`,
      'PRIMARY KEY (id)',
    ],
    [
      `CREATE INDEX ${RECORD_HISTORY_AT_INDEX} ON ${runtimeSchema('postgres')}.${change} USING btree (at)`,
      `CREATE INDEX ${RECORD_HISTORY_INDEX} ON ${runtimeSchema('postgres')}.${change} USING btree (resource, key_json, id)`,
      `CREATE UNIQUE INDEX ${change}_pkey ON ${runtimeSchema('postgres')}.${change} USING btree (id)`,
    ],
  ),
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${RECORD_HISTORY_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
];

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

/** Whether the reserved relations are exactly this version's layout. */
export async function postgresRecordHistoryReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = (await describePostgresRelations(client, RECORD_HISTORY_PREFIX)).filter(
      (relation) => !(relation.kind === 'S' && relation.schema === runtimeSchema('postgres') && relation.name === `${change}_id_seq`),
    );
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === RECORD_HISTORY_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version
 * where no store exists, changes nothing where it does, refuses anything else. */
export async function provisionPostgresRecordHistory(
  url: string,
): Promise<{ version: typeof RECORD_HISTORY_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Record history provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await describePostgresRelations(client, RECORD_HISTORY_PREFIX)).length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [RECORD_HISTORY_VERSION]);
      provisioned = true;
    }
    if (!(await postgresRecordHistoryReady(client))) throw new RecordHistoryUnavailable(await layoutMessage(client));
    return { version: RECORD_HISTORY_VERSION, provisioned };
  });
}

/** One row, on the business write's leased client, inside its transaction. */
export async function appendPostgresRecordChange(client: PgQuery, row: RecordChangeRow): Promise<void> {
  const changes = assertChangeRow(row);
  const append = {
    text: `INSERT INTO ${q(change)} (write_id, at, resource, key_json, kind, changes_json, actor, actor_name, via, action)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    values: [row.writeId, row.at, row.resource, row.key, row.kind, changes, row.actor, row.actorName, row.via, row.action],
  };
  /* Nothing in the transaction reads the row back: on a writer that pipelines it
     leaves with the COMMIT, in that flight, the way the receipt does. The before
     image it was made from was read under the row's lock in the first flight
     (postgres.ts sendWriteAhead). A refused row fails the COMMIT. */
  if (beforeCommit(client, [append])) return;
  await client.query(append.text, append.values);
}

/** One record's rows, newest first, since its key was last deleted (see the SQLite read). */
/* `attested`: the adapter holds an attestation under the schema epoch it just read (postgres.ts, storeAttested). */
export async function readPostgresRecordHistory(
  client: PgQuery,
  query: RecordHistoryQuery,
  attested = false,
): Promise<StoredRecordChange[]> {
  assertHistoryQuery(query);
  if (!attested && !(await postgresRecordHistoryReady(client))) throw new RecordHistoryUnavailable(await layoutMessage(client));
  const params: unknown[] = [query.resource, query.key, query.limit];
  if (query.before !== undefined) params.push(query.before);
  const result = await client.query(
    `SELECT c.id::text AS id, c.write_id, ${AT_ISO} AS at, c.resource, c.key_json, c.kind, c.changes_json, c.actor, c.actor_name, c.via, c.action
    FROM ${q(change)} c
    WHERE resource = $1 AND key_json = $2
      AND id > COALESCE((SELECT max(id) FROM ${q(change)} WHERE resource = $1 AND key_json = $2 AND kind = 'delete'), 0)
      ${query.before === undefined ? '' : 'AND id < $4'}
    ORDER BY c.id DESC LIMIT $3`,
    params,
  );
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    writeId: String(row.write_id),
    at: String(row.at),
    resource: String(row.resource),
    key: String(row.key_json),
    kind: row.kind as StoredRecordChange['kind'],
    changes: parseStoredChanges(row.changes_json),
    actor: String(row.actor),
    actorName: String(row.actor_name),
    via: row.via as WriteVia,
    action: String(row.action),
  }));
}

/** A feed's rows across resources, newest first (see the SQLite read). */
export async function readPostgresRecordActivity(
  client: PgQuery,
  query: RecordActivityQuery,
  attested = false,
): Promise<StoredRecordChange[]> {
  assertActivityQuery(query);
  if (!attested && !(await postgresRecordHistoryReady(client))) throw new RecordHistoryUnavailable(await layoutMessage(client));
  const params: unknown[] = [[...query.resources], query.limit];
  const bound = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  // One tenant's feed: each tenant-owned resource's rows by the owner its stored key names (historyKey).
  const owned = Object.entries(query.owners?.columns ?? {});
  const result = await client.query(
    `SELECT c.id::text AS id, c.write_id, ${AT_ISO} AS at, c.resource, c.key_json, c.kind, c.changes_json, c.actor, c.actor_name, c.via, c.action
    FROM ${q(change)} c
    WHERE c.resource = ANY($1::text[]) AND c.kind <> 'delete'
      ${query.from === undefined ? '' : `AND c.at >= ${bound(query.from)}::timestamptz`} ${query.to === undefined ? '' : `AND c.at < ${bound(query.to)}::timestamptz`} ${query.after === undefined ? '' : `AND c.id > ${bound(query.after)}`}
      ${
        owned.length
          ? `AND (NOT (c.resource = ANY(${bound(owned.map(([resource]) => resource))}::text[]))${owned
              .map(
                ([resource, column]) =>
                  ` OR (c.resource = ${bound(resource)} AND (c.key_json::jsonb ->> ${bound(column)}) = ${bound(query.owners!.tenant)})`,
              )
              .join('')})`
          : ''
      }
      AND NOT EXISTS (SELECT 1 FROM ${q(change)} d WHERE d.resource = c.resource AND d.key_json = c.key_json AND d.kind = 'delete' AND d.id > c.id)
    ORDER BY c.id ${query.after === undefined ? 'DESC' : 'ASC'} LIMIT $2`,
    params,
  );
  return (result.rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    writeId: String(row.write_id),
    at: String(row.at),
    resource: String(row.resource),
    key: String(row.key_json),
    kind: row.kind as StoredRecordChange['kind'],
    changes: parseStoredChanges(row.changes_json),
    actor: String(row.actor),
    actorName: String(row.actor_name),
    via: row.via as WriteVia,
    action: String(row.action),
  }));
}
