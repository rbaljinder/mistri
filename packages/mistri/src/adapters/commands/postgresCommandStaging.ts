/**
 * The store of files held for commands on PostgreSQL: the SQLite store's
 * table (see commandStaging.ts), in the runtime schema, attested the way the
 * journal is — against the catalog description its DDL produces. A take
 * deletes the rows in the command's transaction, so a second command sent
 * the same id waits for the first and then finds nothing.
 */
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import {
  COMMAND_STAGED_META_TABLE as STAGED_META_TABLE,
  COMMAND_STAGED_TABLE as STAGED_TABLE,
  COMMAND_STAGED_VERSION,
  CommandStagingUnavailable,
  STAGED_SWEEP,
  StagedFileRefused,
  StagedFilesFull,
  checkStagedRow,
  checkStagedTake,
  type StagedFileRow,
  type StagedLimits,
  type StagedNamespace,
  type StagedTake,
  type TakenFile,
} from './commandStaging.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { describePostgresRelations, type PostgresRelationDescription } from './postgresRelations.js';
import { runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const COMMAND_STAGED_TABLE = runtimeName('postgres', STAGED_TABLE);
const COMMAND_STAGED_META_TABLE = runtimeName('postgres', STAGED_META_TABLE);
const schema = runtimeSchema('postgres');

const q = runtimeTable('postgres', COMMAND_STAGED_TABLE);
/* The place's own count (commandStaging.ts PLACE): $2..$5 are the namespace. */
const PLACE = 'store_id = $2 AND source_id = $3 AND realm = $4 AND tenant_id = $5';
const POSTGRES_STAGED_DDL = `CREATE TABLE ${q} (
  id_hash text COLLATE "C" PRIMARY KEY CHECK (length(id_hash) = 64),
  app_id text COLLATE "C" NOT NULL,
  store_id text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  realm text COLLATE "C" NOT NULL CHECK (realm IN ('tenant', 'platform')),
  tenant_id text COLLATE "C" NOT NULL,
  owner text COLLATE "C" NOT NULL,
  command_id text COLLATE "C" NOT NULL,
  field text COLLATE "C" NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  size bigint NOT NULL CHECK (size >= 0),
  data bytea NOT NULL,
  expires_at bigint NOT NULL
)`;
const POSTGRES_STAGED_INDEX_DDL = `CREATE INDEX ${COMMAND_STAGED_TABLE}_owner ON ${q} (app_id, owner, expires_at)`;

const qMeta = runtimeTable('postgres', COMMAND_STAGED_META_TABLE);
const POSTGRES_STAGED_META_DDL = `CREATE TABLE ${qMeta} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${COMMAND_STAGED_VERSION})
)`;

const column = (name: string, type: string, collation: string | null = null) => ({ name, type, notnull: true, collation, default: null });
const id = (name: string) => column(name, 'text', 'C');
/* The description the DDL produces, read back from the catalog; pinned so the attestation is of this layout. */
const FILE_LAYOUT: PostgresRelationDescription = {
  schema,
  name: COMMAND_STAGED_TABLE,
  kind: 'r',
  rls: false,
  columns: [
    id('id_hash'),
    id('app_id'),
    id('store_id'),
    id('source_id'),
    id('realm'),
    id('tenant_id'),
    id('owner'),
    id('command_id'),
    id('field'),
    column('name', 'text', 'default'),
    column('type', 'text', 'default'),
    column('size', 'bigint'),
    column('data', 'bytea'),
    column('expires_at', 'bigint'),
  ],
  constraints: [
    'CHECK ((length(id_hash) = 64))',
    `CHECK ((realm = ANY (ARRAY['tenant'::text, 'platform'::text])))`,
    'CHECK ((size >= 0))',
    'PRIMARY KEY (id_hash)',
  ],
  indexes: [
    `CREATE INDEX ${COMMAND_STAGED_TABLE}_owner ON ${schema}.${COMMAND_STAGED_TABLE} USING btree (app_id, owner, expires_at)`,
    `CREATE UNIQUE INDEX ${COMMAND_STAGED_TABLE}_pkey ON ${schema}.${COMMAND_STAGED_TABLE} USING btree (id_hash)`,
  ],
  triggers: 0,
  rules: 0,
  policies: 0,
};
const META_LAYOUT: PostgresRelationDescription = {
  schema,
  name: COMMAND_STAGED_META_TABLE,
  kind: 'r',
  rls: false,
  columns: [column('singleton', 'integer'), column('version', 'integer')],
  constraints: ['CHECK ((singleton = 1))', `CHECK ((version = ${COMMAND_STAGED_VERSION}))`, 'PRIMARY KEY (singleton)'],
  indexes: [`CREATE UNIQUE INDEX ${COMMAND_STAGED_META_TABLE}_pkey ON ${schema}.${COMMAND_STAGED_META_TABLE} USING btree (singleton)`],
  triggers: 0,
  rules: 0,
  policies: 0,
};
/* The relations sort by name: `staged_file` before `staged_meta`. */
const LAYOUT: readonly PostgresRelationDescription[] = [FILE_LAYOUT, META_LAYOUT];

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

async function assertPostgresCommandStaging(client: PgQuery): Promise<void> {
  try {
    const actual = await describePostgresRelations(client, '__mistri_staged_');
    if (canonical(actual) !== canonical(LAYOUT)) throw new Error('layout');
    const rows = (await client.query(`SELECT singleton, version FROM ${qMeta}`)).rows;
    if (rows.length !== 1 || rows[0].singleton !== 1 || rows[0].version !== COMMAND_STAGED_VERSION) throw new Error('version');
  } catch {
    throw new CommandStagingUnavailable(
      layoutRefusal('The store of files held for commands', await postgresLayoutVersion(client, qMeta), COMMAND_STAGED_VERSION),
    );
  }
}

/** Inside the journal migration's transaction and lock: create where missing, then attest. */
export async function provisionPostgresCommandStaging(client: PgQuery): Promise<boolean> {
  const present = (await describePostgresRelations(client, '__mistri_staged_')).length > 0;
  if (!present) {
    await client.query(POSTGRES_STAGED_DDL);
    await client.query(POSTGRES_STAGED_INDEX_DDL);
    await client.query(POSTGRES_STAGED_META_DDL);
    await client.query(`INSERT INTO ${qMeta} (singleton, version) VALUES (1, $1)`, [COMMAND_STAGED_VERSION]);
  }
  await assertPostgresCommandStaging(client);
  return !present;
}

/**
 * Holds one file in the caller's open transaction, unless its sender holds enough already. The sender's rows are
 * counted under a transaction lock on the sender, so two uploads at once cannot both slip under the cap; a public
 * form's whole share is counted under one lock for the App's visitors.
 */
export async function stagePostgresFile(
  client: PgQuery,
  appId: string,
  namespace: StagedNamespace,
  row: StagedFileRow,
  most: StagedLimits,
  now: number,
): Promise<void> {
  await assertPostgresCommandStaging(client);
  checkStagedRow(row);
  const lock = 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))';
  if (most.shared) await client.query(lock, [`mistri.staged:${appId}:${most.shared.prefix}`]);
  await client.query(lock, [`mistri.staged:${appId}:${row.owner}`]);
  await client.query(`DELETE FROM ${q} WHERE app_id = $1 AND owner = $2 AND expires_at <= $3`, [appId, row.owner, now]);
  // A few of anyone's lapsed files too (commandStaging.ts STAGED_SWEEP); one another sender holds is skipped, not waited on.
  await client.query(
    `DELETE FROM ${q} WHERE id_hash IN (SELECT id_hash FROM ${q} WHERE app_id = $1 AND expires_at <= $2 LIMIT ${STAGED_SWEEP} FOR UPDATE SKIP LOCKED)`,
    [appId, now],
  );
  const held = (
    await client.query(
      `SELECT count(*)::bigint AS files, coalesce(sum(size), 0)::bigint AS bytes FROM ${q} WHERE app_id = $1 AND ${PLACE} AND owner = $6 AND expires_at > $7`,
      [appId, ...namespace, row.owner, now],
    )
  ).rows[0] as { files: string | number; bytes: string | number };
  if (Number(held.files) + 1 > most.files || Number(held.bytes) + row.size > most.bytes) throw new StagedFilesFull();
  if (most.shared) {
    const all = (
      await client.query(
        `SELECT coalesce(sum(size), 0)::bigint AS bytes FROM ${q} WHERE app_id = $1 AND ${PLACE} AND starts_with(owner, $6) AND expires_at > $7`,
        [appId, ...namespace, most.shared.prefix, now],
      )
    ).rows[0] as { bytes: string | number };
    if (Number(all.bytes) + row.size > most.shared.bytes) throw new StagedFilesFull(true);
  }
  await client.query(
    `INSERT INTO ${q} (id_hash, app_id, store_id, source_id, realm, tenant_id, owner, command_id, field, name, type, size, data, expires_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      row.idHash,
      appId,
      ...namespace,
      row.owner,
      row.command,
      row.field,
      row.name,
      row.type,
      row.size,
      Buffer.from(row.data),
      row.expiresAt,
    ],
  );
}

/** Takes the files in the caller's open transaction: every one, deleted as it is read, or none and refused. */
export async function takePostgresStaged(
  client: PgQuery,
  appId: string,
  namespace: StagedNamespace,
  take: StagedTake,
): Promise<TakenFile[]> {
  await assertPostgresCommandStaging(client);
  checkStagedTake(take);
  const taken: TakenFile[] = [];
  for (const hash of take.hashes) {
    const row = (
      await client.query(
        `DELETE FROM ${q}
        WHERE id_hash = $1 AND app_id = $2 AND store_id = $3 AND source_id = $4 AND realm = $5 AND tenant_id = $6
          AND owner = $7 AND command_id = $8 AND field = $9 AND expires_at > $10
        RETURNING name, type, size, data`,
        [hash, appId, ...namespace, take.owner, take.command, take.field, take.now],
      )
    ).rows[0] as { name: string; type: string; size: string | number; data: Uint8Array } | undefined;
    // The transaction rolls back with the refusal, so a file taken before this one is held again.
    if (!row) throw new StagedFileRefused(take.field);
    taken.push({ name: row.name, type: row.type, size: Number(row.size), data: new Uint8Array(row.data) });
  }
  return taken;
}
