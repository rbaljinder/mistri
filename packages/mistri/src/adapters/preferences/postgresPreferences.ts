/**
 * The preferences store on PostgreSQL: the SQLite layout, in the runtime schema without the prefix, attested as the
 * assistant's is — the catalog description (columns, types, collations, constraints, indexes, and no trigger, rule or
 * policy) compared with the one provisioning produces.
 *
 * The runtime runs on the server stores' shared pool (RUNTIME_STORE_POOL): a preference is never written inside a
 * business write, and the App's pools stay the App's.
 */
import { RUNTIME_STORE_POOL } from '@mistriwork/engine/adapters/connectionBudget.js';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { sharedPgConnections, type PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import {
  PREFERENCES_LIMITS,
  PREFERENCES_PREFIX,
  PREFERENCES_TABLES,
  PREFERENCES_VERSION,
  PreferencesUnavailable,
  createPreferencesStore,
  type Db,
  type PreferencesStore,
  type Row,
} from './preferences.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const { meta, value } = postgresRuntimeNames(PREFERENCES_TABLES);
const q = (name: string) => runtimeTable('postgres', name);

const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${PREFERENCES_VERSION})
)`,
  `CREATE TABLE ${q(value)} (
  app text COLLATE "C" NOT NULL CHECK (octet_length(app) <= ${PREFERENCES_LIMITS.app}),
  subject_id text COLLATE "C" NOT NULL CHECK (octet_length(subject_id) <= ${PREFERENCES_LIMITS.subject}),
  scope text COLLATE "C" NOT NULL CHECK (octet_length(scope) <= ${PREFERENCES_LIMITS.scope}),
  pref_key text COLLATE "C" NOT NULL CHECK (octet_length(pref_key) <= ${PREFERENCES_LIMITS.key}),
  pref_value text NOT NULL CHECK (octet_length(pref_value) <= ${PREFERENCES_LIMITS.value}),
  revision integer NOT NULL CHECK (revision > 0),
  PRIMARY KEY (app, subject_id, scope, pref_key)
)`,
];

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

/* What the DDL above reads back as, pinned so the attestation is of this layout, kept in the catalog's name order. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${PREFERENCES_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
  table(
    value,
    [
      column('app', 'text', 'C'),
      column('subject_id', 'text', 'C'),
      column('scope', 'text', 'C'),
      column('pref_key', 'text', 'C'),
      column('pref_value', 'text', 'default'),
      column('revision', 'integer'),
    ],
    [
      `CHECK ((octet_length(app) <= ${PREFERENCES_LIMITS.app}))`,
      `CHECK ((octet_length(pref_key) <= ${PREFERENCES_LIMITS.key}))`,
      `CHECK ((octet_length(pref_value) <= ${PREFERENCES_LIMITS.value}))`,
      `CHECK ((octet_length(scope) <= ${PREFERENCES_LIMITS.scope}))`,
      `CHECK ((octet_length(subject_id) <= ${PREFERENCES_LIMITS.subject}))`,
      'CHECK ((revision > 0))',
      'PRIMARY KEY (app, subject_id, scope, pref_key)',
    ],
    [`CREATE UNIQUE INDEX ${value}_pkey ON ${runtimeSchema('postgres')}.${value} USING btree (app, subject_id, scope, pref_key)`],
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
export async function postgresPreferencesReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = sortedDescription(await describePostgresRelations(client, PREFERENCES_PREFIX));
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === PREFERENCES_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version where no store exists, changes nothing
 * where it does, refuses anything else. */
export async function provisionPostgresPreferences(url: string): Promise<{ version: typeof PREFERENCES_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Preferences store provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await describePostgresRelations(client, PREFERENCES_PREFIX)).length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [PREFERENCES_VERSION]);
      provisioned = true;
    }
    if (!(await postgresPreferencesReady(client)))
      throw new PreferencesUnavailable(
        layoutRefusal('The preferences store', await postgresLayoutVersion(client, q(meta)), PREFERENCES_VERSION),
      );
    return { version: PREFERENCES_VERSION, provisioned };
  });
}

/** `?` placeholders, numbered. The statements carry no `?` in a literal. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

/** The store over the server stores' shared pool; opening attests, and a store that cannot be is not returned. */
export async function openPostgresPreferences(url: string): Promise<PreferencesStore> {
  const connections = sharedPgConnections(url, RUNTIME_STORE_POOL);
  const ready = await connections.withWriteClient((client) => postgresPreferencesReady(client)).catch(() => false);
  if (!ready) {
    const message = await connections
      .withWriteClient(async (client) =>
        layoutRefusal('The preferences store', await postgresLayoutVersion(client, q(meta)), PREFERENCES_VERSION),
      )
      .catch(() => undefined);
    await connections.close();
    throw new PreferencesUnavailable(message);
  }
  const transaction = <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    connections.withWriteClient(async (client) => {
      const driver: Db = {
        all: async (sql, ...params) => (await client.query(numbered(sql), params)).rows as Row[],
        run: async (sql, ...params) => (await client.query(numbered(sql), params)).rowCount ?? 0,
      };
      await client.query('BEGIN');
      try {
        const result = await work(driver);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  const read = <T>(work: (db: Db) => Promise<T>): Promise<T> =>
    connections.withReadClient((client) =>
      work({
        all: async (sql, ...params) => (await client.query(numbered(sql), params)).rows as Row[],
        run: async () => {
          throw new Error('Preferences store read client cannot execute writes.');
        },
      }),
    );
  return createPreferencesStore(transaction, q, () => connections.close(), read);
}
