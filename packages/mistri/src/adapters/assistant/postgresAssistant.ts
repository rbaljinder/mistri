/**
 * The assistant store on PostgreSQL: the SQLite layout, in the runtime schema
 * without the prefix, attested as the branding store's is — the catalog
 * description (columns, types, collations, constraints, indexes, and no
 * trigger, rule or policy) compared with the one provisioning produces.
 *
 * The runtime runs on the server stores' shared pool (RUNTIME_STORE_POOL): a conversation is
 * never written inside a business write, and the App's pools stay the App's.
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
  ASSISTANT_INDEX,
  ASSISTANT_LIMITS,
  ASSISTANT_PREFIX,
  ASSISTANT_STORE_VERSION,
  ASSISTANT_TABLES,
  AssistantStoreUnavailable,
  createAssistantStore,
  type AssistantStore,
  type Db,
  type Row,
} from './assistantStore.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { postgresTenantSwitchReady, provisionPostgresTenantSwitch } from '../switch/postgresTenantSwitch.js';

const { meta, conversation, event, usage } = postgresRuntimeNames(ASSISTANT_TABLES);
const q = (name: string) => runtimeTable('postgres', name);

/** The version row's table, which pins this version: the upgrade (storeLayouts.ts) rebuilds it to pin the next. */
const ASSISTANT_META_POSTGRES = `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${ASSISTANT_STORE_VERSION})
)`;
const definitions: readonly string[] = [
  ASSISTANT_META_POSTGRES,
  `CREATE TABLE ${q(conversation)} (
  id text COLLATE "C" PRIMARY KEY,
  app text COLLATE "C" NOT NULL CHECK (octet_length(app) <= ${ASSISTANT_LIMITS.app}),
  tenant text COLLATE "C" NOT NULL CHECK (octet_length(tenant) <= ${ASSISTANT_LIMITS.tenant}),
  account text COLLATE "C" NOT NULL CHECK (octet_length(account) <= ${ASSISTANT_LIMITS.account}),
  title text NOT NULL CHECK (octet_length(title) <= ${ASSISTANT_LIMITS.title}),
  state text NOT NULL CHECK (state IN ('idle', 'awaiting')),
  created_at text NOT NULL,
  updated_at text NOT NULL
)`,
  `CREATE TABLE ${q(event)} (
  conversation text COLLATE "C" NOT NULL,
  seq integer NOT NULL,
  kind text NOT NULL,
  body_json text NOT NULL CHECK (octet_length(body_json) <= ${ASSISTANT_LIMITS.body} AND body_json::json IS NOT NULL),
  at text NOT NULL,
  PRIMARY KEY (conversation, seq)
)`,
  `CREATE TABLE ${q(usage)} (
  app text COLLATE "C" NOT NULL,
  tenant text COLLATE "C" NOT NULL,
  account text COLLATE "C" NOT NULL,
  day text NOT NULL,
  tokens bigint NOT NULL,
  PRIMARY KEY (app, tenant, account, day)
)`,
  `CREATE INDEX "${ASSISTANT_INDEX}" ON ${q(conversation)} (app, tenant, account, updated_at)`,
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

/* What the DDL above reads back as, pinned so the attestation is of this
   layout, kept in the catalog's name order. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${ASSISTANT_STORE_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
  table(
    conversation,
    [
      column('id', 'text', 'C'),
      column('app', 'text', 'C'),
      column('tenant', 'text', 'C'),
      column('account', 'text', 'C'),
      column('title', 'text', 'default'),
      column('state', 'text', 'default'),
      column('created_at', 'text', 'default'),
      column('updated_at', 'text', 'default'),
    ],
    [
      `CHECK ((octet_length(account) <= ${ASSISTANT_LIMITS.account}))`,
      `CHECK ((octet_length(app) <= ${ASSISTANT_LIMITS.app}))`,
      `CHECK ((octet_length(tenant) <= ${ASSISTANT_LIMITS.tenant}))`,
      `CHECK ((octet_length(title) <= ${ASSISTANT_LIMITS.title}))`,
      "CHECK ((state = ANY (ARRAY['idle'::text, 'awaiting'::text])))",
      'PRIMARY KEY (id)',
    ],
    [
      `CREATE INDEX ${ASSISTANT_INDEX} ON ${runtimeSchema('postgres')}.${conversation} USING btree (app, tenant, account, updated_at)`,
      `CREATE UNIQUE INDEX ${conversation}_pkey ON ${runtimeSchema('postgres')}.${conversation} USING btree (id)`,
    ],
  ),
  table(
    event,
    [
      column('conversation', 'text', 'C'),
      column('seq', 'integer'),
      column('kind', 'text', 'default'),
      column('body_json', 'text', 'default'),
      column('at', 'text', 'default'),
    ],
    [
      `CHECK (((octet_length(body_json) <= ${ASSISTANT_LIMITS.body}) AND ((body_json)::json IS NOT NULL)))`,
      'PRIMARY KEY (conversation, seq)',
    ],
    [`CREATE UNIQUE INDEX ${event}_pkey ON ${runtimeSchema('postgres')}.${event} USING btree (conversation, seq)`],
  ),
  table(
    usage,
    [
      column('app', 'text', 'C'),
      column('tenant', 'text', 'C'),
      column('account', 'text', 'C'),
      column('day', 'text', 'default'),
      column('tokens', 'bigint'),
    ],
    ['PRIMARY KEY (app, tenant, account, day)'],
    [`CREATE UNIQUE INDEX ${usage}_pkey ON ${runtimeSchema('postgres')}.${usage} USING btree (app, tenant, account, day)`],
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
async function postgresAssistantReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = sortedDescription(await describePostgresRelations(client, ASSISTANT_PREFIX));
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    /* The tenants' switches are a store of their own that the decision store shares (adapters/switch). */
    if (!(await postgresTenantSwitchReady(client))) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === ASSISTANT_STORE_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version
 * where no store exists, changes nothing where it does, refuses anything else. */
export async function provisionPostgresAssistant(url: string): Promise<{ version: typeof ASSISTANT_STORE_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Assistant store provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await describePostgresRelations(client, ASSISTANT_PREFIX)).length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [ASSISTANT_STORE_VERSION]);
      provisioned = true;
    }
    if (await provisionPostgresTenantSwitch(client)) provisioned = true;
    if (!(await postgresAssistantReady(client)))
      throw new AssistantStoreUnavailable(
        layoutRefusal('The assistant store', await postgresLayoutVersion(client, q(meta)), ASSISTANT_STORE_VERSION),
      );
    return { version: ASSISTANT_STORE_VERSION, provisioned };
  });
}

/** `?` placeholders, numbered. The statements carry no `?` in a literal. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

/** The store over the server stores' shared pool; opening attests, and a store that cannot be is not returned. */
export async function openPostgresAssistant(url: string): Promise<AssistantStore> {
  const connections = sharedPgConnections(url, RUNTIME_STORE_POOL);
  const ready = await connections.withWriteClient((client) => postgresAssistantReady(client)).catch(() => false);
  if (!ready) {
    const message = await connections
      .withWriteClient(async (client) =>
        layoutRefusal('The assistant store', await postgresLayoutVersion(client, q(meta)), ASSISTANT_STORE_VERSION),
      )
      .catch(() => undefined);
    await connections.close();
    throw new AssistantStoreUnavailable(message);
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
  return createAssistantStore(transaction, q, () => connections.close());
}
