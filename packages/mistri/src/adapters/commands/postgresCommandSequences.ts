/**
 * The command sequence store on PostgreSQL: the SQLite store's table (see
 * commandSequences.ts), in `public` under the reserved prefix, attested the
 * way the journal is — against the catalog description its DDL produces.
 * The upsert takes the sequence row's lock until the command's transaction
 * ends, so a second command asking for the same sequence waits for the first
 * to commit or roll back, and then takes the next number or the same one.
 */
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  COMMAND_SEQUENCE_META_TABLE as SEQUENCE_META_TABLE,
  COMMAND_SEQUENCE_TABLE as SEQUENCE_TABLE,
  COMMAND_SEQUENCE_VERSION,
  CommandSequenceUnavailable,
  sequenceNumber,
  type CommandSequenceKey,
} from './commandSequences.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { describePostgresRelations, type PostgresRelationDescription } from './postgresRelations.js';
import { runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const COMMAND_SEQUENCE_TABLE = runtimeName('postgres', SEQUENCE_TABLE);
const COMMAND_SEQUENCE_META_TABLE = runtimeName('postgres', SEQUENCE_META_TABLE);

const q = runtimeTable('postgres', COMMAND_SEQUENCE_TABLE);
const POSTGRES_SEQUENCE_DDL = `CREATE TABLE ${q} (
  app_id text COLLATE "C" NOT NULL,
  store_id text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  realm text COLLATE "C" NOT NULL CHECK (realm IN ('tenant', 'platform')),
  tenant_id text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL,
  per text COLLATE "C" NOT NULL,
  value bigint NOT NULL CHECK (value > 0),
  PRIMARY KEY (app_id, store_id, source_id, realm, tenant_id, name, per)
)`;

const qMeta = runtimeTable('postgres', COMMAND_SEQUENCE_META_TABLE);
const POSTGRES_SEQUENCE_META_DDL = `CREATE TABLE ${qMeta} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${COMMAND_SEQUENCE_VERSION})
)`;

const id = (name: string) => ({
  name,
  type: 'text',
  notnull: true,
  collation: 'C',
  default: null,
});
/* The description the DDL produces, read back from the catalog; pinned so
   the attestation is of this layout and not of whatever is there. */
const NUMBER_LAYOUT: readonly PostgresRelationDescription[] = [
  {
    schema: runtimeSchema('postgres'),
    name: COMMAND_SEQUENCE_TABLE,
    kind: 'r',
    rls: false,
    columns: [
      id('app_id'),
      id('store_id'),
      id('source_id'),
      id('realm'),
      id('tenant_id'),
      id('name'),
      id('per'),
      {
        name: 'value',
        type: 'bigint',
        notnull: true,
        collation: null,
        default: null,
      },
    ],
    constraints: [
      `CHECK ((realm = ANY (ARRAY['tenant'::text, 'platform'::text])))`,
      'CHECK ((value > 0))',
      'PRIMARY KEY (app_id, store_id, source_id, realm, tenant_id, name, per)',
    ],
    indexes: [
      `CREATE UNIQUE INDEX ${COMMAND_SEQUENCE_TABLE}_pkey ON ${runtimeSchema('postgres')}.${COMMAND_SEQUENCE_TABLE} USING btree (app_id, store_id, source_id, realm, tenant_id, name, per)`,
    ],
    triggers: 0,
    rules: 0,
    policies: 0,
  },
];
const META_LAYOUT: readonly PostgresRelationDescription[] = [
  {
    schema: runtimeSchema('postgres'),
    name: COMMAND_SEQUENCE_META_TABLE,
    kind: 'r',
    rls: false,
    columns: [
      {
        name: 'singleton',
        type: 'integer',
        notnull: true,
        collation: null,
        default: null,
      },
      {
        name: 'version',
        type: 'integer',
        notnull: true,
        collation: null,
        default: null,
      },
    ],
    constraints: ['CHECK ((singleton = 1))', `CHECK ((version = ${COMMAND_SEQUENCE_VERSION}))`, 'PRIMARY KEY (singleton)'],
    indexes: [
      `CREATE UNIQUE INDEX ${COMMAND_SEQUENCE_META_TABLE}_pkey ON ${runtimeSchema('postgres')}.${COMMAND_SEQUENCE_META_TABLE} USING btree (singleton)`,
    ],
    triggers: 0,
    rules: 0,
    policies: 0,
  },
];
/* The relations sort by name, so the meta table comes first. */
const LAYOUT: readonly PostgresRelationDescription[] = [...META_LAYOUT, ...NUMBER_LAYOUT];

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

/** The store: both relations and the version row. */
async function assertPostgresCommandSequences(client: PgQuery): Promise<void> {
  try {
    const actual = await describePostgresRelations(client, '__mistri_sequence_');
    if (canonical(actual) !== canonical(LAYOUT)) throw new Error('layout');
    const rows = (await client.query(`SELECT singleton, version FROM ${qMeta}`)).rows;
    if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].version !== COMMAND_SEQUENCE_VERSION) throw new Error('version');
  } catch {
    throw new CommandSequenceUnavailable(
      layoutRefusal('The command sequence store', await postgresLayoutVersion(client, qMeta), COMMAND_SEQUENCE_VERSION),
    );
  }
}

/** Inside the journal migration's transaction and lock: create where missing, then attest. */
export async function provisionPostgresCommandSequences(client: PgQuery): Promise<boolean> {
  const present = (await describePostgresRelations(client, '__mistri_sequence_')).length > 0;
  if (!present) {
    await client.query(POSTGRES_SEQUENCE_DDL);
    await client.query(POSTGRES_SEQUENCE_META_DDL);
    await client.query(`INSERT INTO ${qMeta} (singleton, version) VALUES (1, $1)`, [COMMAND_SEQUENCE_VERSION]);
  }
  await assertPostgresCommandSequences(client);
  return !present;
}

/** The next number, in the caller's open transaction: one past the count, and never below `least` (see commandSequences.ts). */
export async function nextPostgresCommandNumber(client: PgQuery, key: CommandSequenceKey, least: number): Promise<number> {
  await assertPostgresCommandSequences(client);
  const result = await client.query(
    `INSERT INTO ${q} AS s (app_id, store_id, source_id, realm, tenant_id, name, per, value)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT (app_id, store_id, source_id, realm, tenant_id, name, per) DO UPDATE SET value = GREATEST(s.value + 1, EXCLUDED.value)
    RETURNING value`,
    [key.appId, ...key.namespace, key.name, key.per, least],
  );
  return sequenceNumber(result.rows[0]?.value);
}
