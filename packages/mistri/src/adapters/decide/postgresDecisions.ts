/**
 * The decision store on PostgreSQL: the SQLite layout, in the runtime schema
 * without the prefix, attested as the assistant store's is — the catalog
 * description (columns, types, collations, constraints, indexes, and no
 * trigger, rule or policy) compared with the one provisioning produces.
 *
 * The runtime runs on a small pool of its own, one writer: a decision is
 * recorded outside any business write, and the App's pools stay the App's.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { PgConnectionManager, type PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import {
  createDecisionStore,
  DECISION_AGE_INDEX,
  DECISION_LIMITS,
  DECISION_PREFIX,
  DECISION_RECORD_INDEX,
  DECISION_STORE_VERSION,
  DECISION_TABLES,
  DecisionStoreUnavailable,
  type DecisionStore,
  type Db,
  type Row,
} from './decisionStore.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { postgresTenantSwitchReady, provisionPostgresTenantSwitch } from '../switch/postgresTenantSwitch.js';

const { meta, record, usage } = postgresRuntimeNames(DECISION_TABLES);
const q = (name: string) => runtimeTable('postgres', name);

const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${DECISION_STORE_VERSION})
)`,
  `CREATE TABLE ${q(record)} (
  id text COLLATE "C" PRIMARY KEY,
  app text COLLATE "C" NOT NULL CHECK (octet_length(app) <= ${DECISION_LIMITS.app}),
  tenant text COLLATE "C" NOT NULL CHECK (octet_length(tenant) <= ${DECISION_LIMITS.tenant}),
  decision text NOT NULL,
  contract_version integer NOT NULL,
  resource text NOT NULL,
  record_key text NOT NULL,
  field text NOT NULL,
  trigger text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  model_version text NOT NULL,
  inputs_digest text NOT NULL,
  input_fields text NOT NULL,
  choices_digest text NOT NULL,
  answer text CHECK (answer IS NULL OR octet_length(answer) <= ${DECISION_LIMITS.answer}),
  probability double precision CHECK (probability IS NULL OR (probability >= 0 AND probability <= 1)),
  outcome text NOT NULL CHECK (outcome IN ('applied', 'suggested', 'accepted', 'corrected', 'ignored', 'below', 'none')),
  outcome_reason text NOT NULL,
  corrected_to text,
  outcome_by text NOT NULL,
  outcome_at text NOT NULL,
  latency_ms integer NOT NULL,
  cost_micros bigint NOT NULL,
  units integer NOT NULL,
  created_at text NOT NULL
)`,
  `CREATE TABLE ${q(usage)} (
  app text COLLATE "C" NOT NULL,
  tenant text COLLATE "C" NOT NULL,
  day text NOT NULL,
  calls bigint NOT NULL,
  units bigint NOT NULL,
  cost_micros bigint NOT NULL,
  PRIMARY KEY (app, tenant, day)
)`,
  `CREATE INDEX "${DECISION_RECORD_INDEX}" ON ${q(record)} (app, tenant, resource, record_key, created_at)`,
  `CREATE INDEX "${DECISION_AGE_INDEX}" ON ${q(record)} (app, created_at)`,
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
const text = (name: string, notnull = true) => column(name, 'text', 'default', notnull);
const keyText = (name: string) => column(name, 'text', 'C');
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
    ['CHECK ((singleton = 1))', `CHECK ((version = ${DECISION_STORE_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
  table(
    record,
    [
      keyText('id'),
      keyText('app'),
      keyText('tenant'),
      text('decision'),
      column('contract_version', 'integer'),
      text('resource'),
      text('record_key'),
      text('field'),
      text('trigger'),
      text('provider'),
      text('model'),
      text('model_version'),
      text('inputs_digest'),
      text('input_fields'),
      text('choices_digest'),
      text('answer', false),
      column('probability', 'double precision', null, false),
      text('outcome'),
      text('outcome_reason'),
      text('corrected_to', false),
      text('outcome_by'),
      text('outcome_at'),
      column('latency_ms', 'integer'),
      column('cost_micros', 'bigint'),
      column('units', 'integer'),
      text('created_at'),
    ],
    [
      `CHECK (((answer IS NULL) OR (octet_length(answer) <= ${DECISION_LIMITS.answer})))`,
      `CHECK ((octet_length(app) <= ${DECISION_LIMITS.app}))`,
      `CHECK ((octet_length(tenant) <= ${DECISION_LIMITS.tenant}))`,
      "CHECK ((outcome = ANY (ARRAY['applied'::text, 'suggested'::text, 'accepted'::text, 'corrected'::text, 'ignored'::text, 'below'::text, 'none'::text])))",
      'CHECK (((probability IS NULL) OR ((probability >= (0)::double precision) AND (probability <= (1)::double precision))))',
      'PRIMARY KEY (id)',
    ],
    [
      `CREATE INDEX ${DECISION_AGE_INDEX} ON ${runtimeSchema('postgres')}.${record} USING btree (app, created_at)`,
      `CREATE INDEX ${DECISION_RECORD_INDEX} ON ${runtimeSchema('postgres')}.${record} USING btree (app, tenant, resource, record_key, created_at)`,
      `CREATE UNIQUE INDEX ${record}_pkey ON ${runtimeSchema('postgres')}.${record} USING btree (id)`,
    ],
  ),
  table(
    usage,
    [keyText('app'), keyText('tenant'), text('day'), column('calls', 'bigint'), column('units', 'bigint'), column('cost_micros', 'bigint')],
    ['PRIMARY KEY (app, tenant, day)'],
    [`CREATE UNIQUE INDEX ${usage}_pkey ON ${runtimeSchema('postgres')}.${usage} USING btree (app, tenant, day)`],
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
export async function postgresDecisionsReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = sortedDescription(await describePostgresRelations(client, DECISION_PREFIX));
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    /* The tenants' switches are a store of their own that the assistant store shares (adapters/switch). */
    if (!(await postgresTenantSwitchReady(client))) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === DECISION_STORE_VERSION;
  } catch {
    return false;
  }
}

/** Explicit maintenance, under the shared migration lock: creates this version
 * where no store exists, changes nothing where it does, refuses anything else. */
export async function provisionPostgresDecisions(url: string): Promise<{ version: typeof DECISION_STORE_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Decision store provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => {
    let provisioned = false;
    if (!(await describePostgresRelations(client, DECISION_PREFIX)).length) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [DECISION_STORE_VERSION]);
      provisioned = true;
    }
    if (await provisionPostgresTenantSwitch(client)) provisioned = true;
    if (!(await postgresDecisionsReady(client)))
      throw new DecisionStoreUnavailable(
        layoutRefusal('The decision store', await postgresLayoutVersion(client, q(meta)), DECISION_STORE_VERSION),
      );
    return { version: DECISION_STORE_VERSION, provisioned };
  });
}

/** `?` placeholders, numbered. The statements carry no `?` in a literal. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

/** The store over a pool of its own; opening attests, and a store that cannot be is not returned. */
export async function openPostgresDecisions(url: string): Promise<DecisionStore> {
  const connections = new PgConnectionManager(url, undefined, undefined, {
    readers: 1,
    writers: 1,
  });
  const ready = await connections.withWriteClient((client) => postgresDecisionsReady(client)).catch(() => false);
  if (!ready) {
    const message = await connections
      .withWriteClient(async (client) =>
        layoutRefusal('The decision store', await postgresLayoutVersion(client, q(meta)), DECISION_STORE_VERSION),
      )
      .catch(() => undefined);
    await connections.close();
    throw new DecisionStoreUnavailable(message);
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
  return createDecisionStore(transaction, q, () => connections.close());
}
