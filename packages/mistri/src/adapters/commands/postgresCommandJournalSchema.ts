// The journal's layout and its attestation, apart from the journal that
// writes receipts: the event store attests the journal before it provisions,
// and the journal appends to the event store, so one file made them a loop.
// postgresCommandJournal.ts re-exports what callers import.

import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { COMMAND_JOURNAL_TABLES, COMMAND_TARGET_BOUNDS, CommandJournalUnavailable } from './commandJournalSchema.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';

export const PREFIX = '__mistri_command_';
export const tables = postgresRuntimeNames(COMMAND_JOURNAL_TABLES);
export const q = (name: string) => runtimeTable('postgres', name);

/* One row per command: receipt, provenance, targets and event batch (see
   the SQLite journal). `completed_at` is a timestamp here, read back as
   `toISOString()` text (COMPLETED_AT), and dates the row for retention.
   `xact_id` is the writing transaction's id where the row carries an event
   batch: PostgreSQL assigns ids at insert, not at commit, so delivery
   discovery walks batches by transaction (postgresEventDeliveryStore.ts). */
export const JOURNAL_VERSION = 1;
const B = COMMAND_TARGET_BOUNDS;
const COMPLETED_INDEX = `${tables.receipt}_completed`;
const XACT_INDEX = `${tables.receipt}_xact`;
/** The completion time as the receipt says it, `toISOString()` text. */
export const COMPLETED_AT = `to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const definitions: readonly string[] = [
  `CREATE TABLE ${q(tables.meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${JOURNAL_VERSION})
)`,
  `CREATE TABLE ${q(tables.receipt)} (
  id text COLLATE "C" PRIMARY KEY,
  app_id text COLLATE "C" NOT NULL,
  store_id text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  realm text COLLATE "C" NOT NULL CHECK (realm IN ('tenant', 'platform')),
  tenant_id text COLLATE "C" NOT NULL,
  actor_id text COLLATE "C" NOT NULL,
  command_id text COLLATE "C" NOT NULL,
  command_version integer NOT NULL CHECK (command_version > 0),
  idempotency_key text COLLATE "C" NOT NULL,
  fingerprint text NOT NULL,
  result_json text NOT NULL CHECK (octet_length(result_json) <= 16384 AND result_json::json IS NOT NULL),
  request_id text NOT NULL,
  completed_at timestamptz NOT NULL,
  membership_id text COLLATE "C" NOT NULL,
  membership_version text COLLATE "C" NOT NULL,
  realm_version text COLLATE "C" NOT NULL,
  roles_json text NOT NULL CHECK (octet_length(roles_json) <= 65536 AND json_typeof(roles_json::json) = 'array'),
  deployment text COLLATE "C" NOT NULL,
  target text NOT NULL,
  owners_json text NOT NULL CHECK (octet_length(owners_json) <= ${B.owners} AND json_typeof(owners_json::json) = 'array'),
  keys_json text NOT NULL CHECK (octet_length(keys_json) <= ${B.keys} AND json_typeof(keys_json::json) = 'array'),
  changes_json text NOT NULL CHECK (octet_length(changes_json) <= ${B.changes} AND json_typeof(changes_json::json) = 'array'),
  manifest_json text COLLATE "C" CHECK (octet_length(manifest_json) BETWEEN 1 AND 65536 AND json_typeof(manifest_json::json) = 'array'),
  event_count integer CHECK (event_count BETWEEN 1 AND 32),
  digest text COLLATE "C" CHECK (digest ~ '^[0-9a-f]{64}$'),
  xact_id xid8,
  CHECK (realm = 'tenant' OR tenant_id = ''),
  CHECK ((manifest_json IS NULL) = (event_count IS NULL) AND (manifest_json IS NULL) = (digest IS NULL) AND (manifest_json IS NULL) = (xact_id IS NULL)),
  UNIQUE (app_id, store_id, source_id, realm, tenant_id, actor_id, command_id, command_version, idempotency_key)
)`,
  `CREATE INDEX "${COMPLETED_INDEX}" ON ${q(tables.receipt)} (completed_at)`,
  `CREATE INDEX "${XACT_INDEX}" ON ${q(tables.receipt)} (xact_id) WHERE xact_id IS NOT NULL`,
];

/* ---------- catalog description ---------- */

import { describePostgresRelations, type LayoutTrust, type PostgresRelationDescription } from './postgresRelations.js';
export { describePostgresRelations, type PostgresRelationDescription } from './postgresRelations.js';

// Sorted by code unit: the server would sort by its locale, which orders
// punctuation differently and would make the pinned lists depend on the
// database's collation rather than on the layout.
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
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
const c = (
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
const id = (name: string) => c(name, 'text', 'C');
const text = (name: string) => c(name, 'text', 'default');

/* The description the DDL above produces, read back from a PostgreSQL 18
   catalog. Pinned rather than derived at runtime so the attestation is of
   this layout and not of whatever is there. */
const REALM = `CHECK ((realm = ANY (ARRAY['tenant'::text, 'platform'::text])))`;
const PLATFORM_TENANTLESS = `CHECK (((realm = 'tenant'::text) OR (tenant_id = ''::text)))`;
const on = (index: string) => index.replace(' ON ', ` ON ${runtimeSchema('postgres')}.`);
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    tables.meta,
    [c('singleton', 'integer'), c('version', 'integer')],
    [`CHECK ((singleton = 1))`, `CHECK ((version = ${JOURNAL_VERSION}))`, `PRIMARY KEY (singleton)`],
    [on(`CREATE UNIQUE INDEX ${tables.meta}_pkey ON ${tables.meta} USING btree (singleton)`)],
  ),
  table(
    tables.receipt,
    [
      id('id'),
      id('app_id'),
      id('store_id'),
      id('source_id'),
      id('realm'),
      id('tenant_id'),
      id('actor_id'),
      id('command_id'),
      c('command_version', 'integer'),
      id('idempotency_key'),
      text('fingerprint'),
      text('result_json'),
      text('request_id'),
      c('completed_at', 'timestamp with time zone'),
      id('membership_id'),
      id('membership_version'),
      id('realm_version'),
      text('roles_json'),
      id('deployment'),
      text('target'),
      text('owners_json'),
      text('keys_json'),
      text('changes_json'),
      c('manifest_json', 'text', 'C', false),
      c('event_count', 'integer', null, false),
      c('digest', 'text', 'C', false),
      c('xact_id', 'xid8', null, false),
    ],
    [
      'CHECK ((((manifest_json IS NULL) = (event_count IS NULL)) AND ((manifest_json IS NULL) = (digest IS NULL)) AND ((manifest_json IS NULL) = (xact_id IS NULL))))',
      'CHECK (((event_count >= 1) AND (event_count <= 32)))',
      `CHECK (((octet_length(changes_json) <= ${B.changes}) AND (json_typeof((changes_json)::json) = 'array'::text)))`,
      `CHECK (((octet_length(keys_json) <= ${B.keys}) AND (json_typeof((keys_json)::json) = 'array'::text)))`,
      "CHECK (((octet_length(manifest_json) >= 1) AND (octet_length(manifest_json) <= 65536) AND (json_typeof((manifest_json)::json) = 'array'::text)))",
      `CHECK (((octet_length(owners_json) <= ${B.owners}) AND (json_typeof((owners_json)::json) = 'array'::text)))`,
      `CHECK (((octet_length(result_json) <= 16384) AND ((result_json)::json IS NOT NULL)))`,
      `CHECK (((octet_length(roles_json) <= 65536) AND (json_typeof((roles_json)::json) = 'array'::text)))`,
      PLATFORM_TENANTLESS,
      `CHECK ((command_version > 0))`,
      "CHECK ((digest ~ '^[0-9a-f]{64}$'::text))",
      REALM,
      `PRIMARY KEY (id)`,
      `UNIQUE (app_id, store_id, source_id, realm, tenant_id, actor_id, command_id, command_version, idempotency_key)`,
    ],
    [
      on(`CREATE INDEX ${COMPLETED_INDEX} ON ${tables.receipt} USING btree (completed_at)`),
      on(`CREATE INDEX ${XACT_INDEX} ON ${tables.receipt} USING btree (xact_id) WHERE (xact_id IS NOT NULL)`),
      on(
        `CREATE UNIQUE INDEX ${tables.receipt}_app_id_store_id_source_id_realm_tenant_id_a_key ON ${tables.receipt} USING btree (app_id, store_id, source_id, realm, tenant_id, actor_id, command_id, command_version, idempotency_key)`,
      ),
      on(`CREATE UNIQUE INDEX ${tables.receipt}_pkey ON ${tables.receipt} USING btree (id)`),
    ],
  ),
];

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

/** Whether the reserved relations are exactly this version's layout. */
async function isLayout(client: PgQuery, trust?: LayoutTrust): Promise<boolean> {
  try {
    const described = async () => {
      if (canonical(await describePostgresRelations(client, PREFIX)) !== canonical(LAYOUT)) throw new Error('layout');
    };
    await (trust ? trust.through(PREFIX, described) : described());
    const rows = (await client.query(`SELECT singleton, version FROM ${q(tables.meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === JOURNAL_VERSION;
  } catch {
    return false;
  }
}

/** Exact layout attestation: unrelated relations under the prefix, an altered
 * column or constraint, an added index, trigger, rule or policy, and an older
 * version all refuse. */
export async function assertPostgresCommandJournal(client: PgQuery, trust?: LayoutTrust): Promise<void> {
  if (!(await isLayout(client, trust)))
    throw new CommandJournalUnavailable(
      layoutRefusal('The command journal', await postgresLayoutVersion(client, q(tables.meta)), JOURNAL_VERSION),
    );
}

/* The maintenance transaction is the engine's (../postgresMaintenance.ts):
   the schema epoch's provisioning takes the same lock. Re-exported for the
   stores that import it from here. */
export { MIGRATION_LOCK, withPostgresMaintenanceTransaction } from '@mistriwork/engine/adapters/postgresMaintenance.js';
