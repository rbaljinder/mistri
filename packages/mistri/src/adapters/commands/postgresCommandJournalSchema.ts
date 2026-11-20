// The journal's layout and its attestation, apart from the journal that
// writes receipts: the event store attests the journal before it provisions,
// and the journal appends to the event store, so one file made them a loop.
// postgresCommandJournal.ts re-exports what callers import.

import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  COMMAND_JOURNAL_TABLES,
  COMMAND_TARGET_BOUNDS,
  CommandJournalUnavailable,
  MAKER_KINDS,
  PROPOSAL_BOUNDS,
  PROPOSAL_STATES,
  RECEIPT_ACTOR_KINDS,
} from './commandJournalSchema.js';
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
   discovery walks batches by transaction (postgresEventDeliveryStore.ts).
   Version 2 adds the audit-part table, version 3 the link table and version 4
   the empty event batch and a link's row stamp, version 5 a receipt's actor
   kind and proposal and the proposal and provenance tables (see the SQLite
   journal). A link's, a proposal's and a mark's times are epoch milliseconds
   in both engines. */
export const JOURNAL_VERSION = 6;
const B = COMMAND_TARGET_BOUNDS;
const COMPLETED_INDEX = `${tables.receipt}_completed`;
const XACT_INDEX = `${tables.receipt}_xact`;
/** The completion time as the receipt says it, `toISOString()` text. */
export const COMPLETED_AT = `to_char(completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
/* The audit-part table as version 2 lays it out: the upgrade from version 1 creates exactly this text. */
const AUDIT_PART_DDL = `CREATE TABLE ${q(tables.auditPart)} (
  receipt_id text COLLATE "C" NOT NULL REFERENCES ${q(tables.receipt)} (id) ON DELETE CASCADE,
  target_index integer NOT NULL CHECK (target_index >= 0),
  part integer NOT NULL CHECK (part >= 1),
  changes_json text NOT NULL CHECK (octet_length(changes_json) <= ${B.changes} AND json_typeof(changes_json::json) = 'array'),
  PRIMARY KEY (receipt_id, target_index, part)
)`;
const LINK_INDEX = `${tables.link}_row`;
const ROW_STAMP = `row_stamp text COLLATE "C" CHECK (octet_length(row_stamp) BETWEEN 1 AND 512)`;
/* The link table as version 3 lays it out (the upgrade from version 2 creates exactly this text) and as version 4
   does, where the upgrade from version 3 adds the row stamp as the last column. */
const linkDdl = (version: 3 | 4) => [
  `CREATE TABLE ${q(tables.link)} (
  id text COLLATE "C" PRIMARY KEY,
  app_id text COLLATE "C" NOT NULL,
  tenant_id text COLLATE "C" NOT NULL,
  resource text COLLATE "C" NOT NULL,
  row_key text COLLATE "C" NOT NULL,
  name text COLLATE "C" NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > 0),
  uses_left integer CHECK (uses_left >= 0),
  revoked_at bigint,
  created_at bigint NOT NULL,
  created_by text COLLATE "C" NOT NULL,
  command text COLLATE "C" NOT NULL,
  receipt text COLLATE "C" NOT NULL,
  opens integer NOT NULL CHECK (opens >= 0),
  last_opened_at bigint${
    version === 3
      ? ''
      : `,
  ${ROW_STAMP}`
  }
)`,
  `CREATE INDEX "${LINK_INDEX}" ON ${q(tables.link)} (app_id, resource, row_key)`,
];
const listed = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const ACTOR_KIND = `actor_kind text COLLATE "C" NOT NULL CHECK (actor_kind IN (${listed(RECEIPT_ACTOR_KINDS)}))`;
const PROPOSAL_ID = `proposal_id text COLLATE "C" CHECK (octet_length(proposal_id) BETWEEN 1 AND 128)`;
const PROPOSAL_INDEX = `${tables.proposal}_state`;
const PROVENANCE_INDEX = `${tables.provenance}_row`;
const EVIDENCE = `evidence text NOT NULL CHECK (octet_length(evidence) <= ${PROPOSAL_BOUNDS.evidence} AND json_typeof(evidence::json) = 'array')`;
/* The proposal and provenance tables (see the SQLite journal), as version 5 lays them out and its upgrade creates them. */
const proposalDdl = (): readonly string[] => [
  `CREATE TABLE ${q(tables.proposal)} (
  id text COLLATE "C" PRIMARY KEY,
  app_id text COLLATE "C" NOT NULL,
  tenant_id text COLLATE "C" NOT NULL,
  command text COLLATE "C" NOT NULL,
  target text COLLATE "C",
  input text NOT NULL CHECK (octet_length(input) <= ${PROPOSAL_BOUNDS.input} AND json_typeof(input::json) = 'object'),
  actor_kind text COLLATE "C" NOT NULL CHECK (actor_kind IN (${listed(MAKER_KINDS)})),
  actor text COLLATE "C" NOT NULL,
  model text,
  model_version text,
  cost_micros bigint CHECK (cost_micros >= 0),
  ${EVIDENCE},
  reason text NOT NULL CHECK (octet_length(reason) <= ${PROPOSAL_BOUNDS.reason}),
  state text COLLATE "C" NOT NULL CHECK (state IN (${listed(PROPOSAL_STATES)})),
  decided_by text COLLATE "C",
  decided_at bigint,
  receipt_id text COLLATE "C",
  created_at bigint NOT NULL,
  expires_at bigint NOT NULL CHECK (expires_at > created_at),
  CHECK ((state = 'proposed') = (decided_at IS NULL))
)`,
  `CREATE INDEX "${PROPOSAL_INDEX}" ON ${q(tables.proposal)} (app_id, tenant_id, state, created_at)`,
  `CREATE TABLE ${q(tables.provenance)} (
  id text COLLATE "C" PRIMARY KEY,
  app_id text COLLATE "C" NOT NULL,
  tenant_id text COLLATE "C" NOT NULL,
  resource text COLLATE "C" NOT NULL,
  row_key text COLLATE "C" NOT NULL,
  field text COLLATE "C",
  actor_kind text COLLATE "C" NOT NULL CHECK (actor_kind IN (${listed(MAKER_KINDS)})),
  actor text COLLATE "C" NOT NULL,
  ${EVIDENCE},
  created_at bigint NOT NULL,
  confirmed_by text COLLATE "C",
  confirmed_at bigint,
  CHECK ((confirmed_by IS NULL) = (confirmed_at IS NULL))
)`,
  `CREATE INDEX "${PROVENANCE_INDEX}" ON ${q(tables.provenance)} (app_id, tenant_id, resource, row_key)`,
];
const LINK_EXPIRES_INDEX = `${tables.link}_expires`;
const LINK_EXPIRES_INDEX_DDL = `CREATE INDEX "${LINK_EXPIRES_INDEX}" ON ${q(tables.link)} (expires_at)`;
const PROPOSAL_CREATED_INDEX = `${tables.proposal}_created`;
const PROPOSAL_CREATED_INDEX_DDL = `CREATE INDEX "${PROPOSAL_CREATED_INDEX}" ON ${q(tables.proposal)} (created_at)`;

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
  event_count integer CHECK (event_count BETWEEN 0 AND 32),
  digest text COLLATE "C" CHECK (digest ~ '^[0-9a-f]{64}$'),
  xact_id xid8,
  ${ACTOR_KIND},
  ${PROPOSAL_ID},
  CHECK (realm = 'tenant' OR tenant_id = ''),
  CHECK ((manifest_json IS NULL) = (event_count IS NULL) AND (manifest_json IS NULL) = (digest IS NULL) AND (manifest_json IS NULL) = (xact_id IS NULL)),
  UNIQUE (app_id, store_id, source_id, realm, tenant_id, actor_id, command_id, command_version, idempotency_key)
)`,
  `CREATE INDEX "${COMPLETED_INDEX}" ON ${q(tables.receipt)} (completed_at)`,
  `CREATE INDEX "${XACT_INDEX}" ON ${q(tables.receipt)} (xact_id) WHERE xact_id IS NOT NULL`,
  AUDIT_PART_DDL,
  ...linkDdl(4),
  LINK_EXPIRES_INDEX_DDL,
  ...proposalDdl(),
  PROPOSAL_CREATED_INDEX_DDL,
];

/** What the upgrade from version 1 runs (storeLayouts.ts, in its one transaction under the store's lock): the new
 * table, and the version row's own check moved on. */
export const postgresJournalUpgradeFrom1 = (): readonly string[] => [
  AUDIT_PART_DDL,
  `ALTER TABLE ${q(tables.meta)} DROP CONSTRAINT ${tables.meta}_version_check`,
  `UPDATE ${q(tables.meta)} SET version = 2`,
  `ALTER TABLE ${q(tables.meta)} ADD CONSTRAINT ${tables.meta}_version_check CHECK (version = 2)`,
];
/** What the upgrade from version 2 runs: the link table and its index, and the version row moved on. */
export const postgresJournalUpgradeFrom2 = (): readonly string[] => [
  ...linkDdl(3),
  `ALTER TABLE ${q(tables.meta)} DROP CONSTRAINT ${tables.meta}_version_check`,
  `UPDATE ${q(tables.meta)} SET version = 3`,
  `ALTER TABLE ${q(tables.meta)} ADD CONSTRAINT ${tables.meta}_version_check CHECK (version = 3)`,
];
/** What the upgrade from version 3 runs: a receipt's event count may be 0 (an empty batch), a link gains its row's
 * stamp, and the version row moves on. The count's check is replaced under the name PostgreSQL gave it. */
export const postgresJournalUpgradeFrom3 = (): readonly string[] => [
  `ALTER TABLE ${q(tables.receipt)} DROP CONSTRAINT ${tables.receipt}_event_count_check`,
  `ALTER TABLE ${q(tables.receipt)} ADD CONSTRAINT ${tables.receipt}_event_count_check CHECK (event_count BETWEEN 0 AND 32)`,
  `ALTER TABLE ${q(tables.link)} ADD COLUMN ${ROW_STAMP}`,
  `ALTER TABLE ${q(tables.meta)} DROP CONSTRAINT ${tables.meta}_version_check`,
  `UPDATE ${q(tables.meta)} SET version = 4`,
  `ALTER TABLE ${q(tables.meta)} ADD CONSTRAINT ${tables.meta}_version_check CHECK (version = 4)`,
];
/** What the upgrade from version 4 runs: a receipt's actor kind, every earlier receipt a person's (no other maker
 * wrote one under its own kind before), with the default dropped once filled so the column reads as created; its
 * proposal; the proposal and provenance tables; and the version row moved on. */
export const postgresJournalUpgradeFrom4 = (): readonly string[] => [
  `ALTER TABLE ${q(tables.receipt)} ADD COLUMN ${ACTOR_KIND.replace(' NOT NULL ', " NOT NULL DEFAULT 'person' ")}`,
  `ALTER TABLE ${q(tables.receipt)} ALTER COLUMN actor_kind DROP DEFAULT`,
  `ALTER TABLE ${q(tables.receipt)} ADD COLUMN ${PROPOSAL_ID}`,
  ...proposalDdl(),
  `ALTER TABLE ${q(tables.meta)} DROP CONSTRAINT ${tables.meta}_version_check`,
  `UPDATE ${q(tables.meta)} SET version = 5`,
  `ALTER TABLE ${q(tables.meta)} ADD CONSTRAINT ${tables.meta}_version_check CHECK (version = 5)`,
];
/** What the upgrade from version 5 runs: adds link expiry and proposal creation indexes for daily pruning and moves version to 6. */
export const postgresJournalUpgradeFrom5 = (): readonly string[] => [
  LINK_EXPIRES_INDEX_DDL,
  PROPOSAL_CREATED_INDEX_DDL,
  `ALTER TABLE ${q(tables.meta)} DROP CONSTRAINT ${tables.meta}_version_check`,
  `UPDATE ${q(tables.meta)} SET version = 6`,
  `ALTER TABLE ${q(tables.meta)} ADD CONSTRAINT ${tables.meta}_version_check CHECK (version = 6)`,
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
const anyOf = (column: string, values: readonly string[]) =>
  `CHECK ((${column} = ANY (ARRAY[${values.map((value) => `'${value}'::text`).join(', ')}])))`;
const EVIDENCE_CHECK = `CHECK (((octet_length(evidence) <= ${PROPOSAL_BOUNDS.evidence}) AND (json_typeof((evidence)::json) = 'array'::text)))`;
const LAYOUT: readonly PostgresRelationDescription[] = [
  // Sorted by name, as the description reads back.
  table(
    tables.auditPart,
    [id('receipt_id'), c('target_index', 'integer'), c('part', 'integer'), text('changes_json')],
    [
      `CHECK (((octet_length(changes_json) <= ${B.changes}) AND (json_typeof((changes_json)::json) = 'array'::text)))`,
      `CHECK ((part >= 1))`,
      `CHECK ((target_index >= 0))`,
      `FOREIGN KEY (receipt_id) REFERENCES ${tables.receipt}(id) ON DELETE CASCADE`,
      `PRIMARY KEY (receipt_id, target_index, part)`,
    ],
    [on(`CREATE UNIQUE INDEX ${tables.auditPart}_pkey ON ${tables.auditPart} USING btree (receipt_id, target_index, part)`)],
  ),
  table(
    tables.link,
    [
      id('id'),
      id('app_id'),
      id('tenant_id'),
      id('resource'),
      id('row_key'),
      id('name'),
      c('expires_at', 'bigint'),
      c('uses_left', 'integer', null, false),
      c('revoked_at', 'bigint', null, false),
      c('created_at', 'bigint'),
      id('created_by'),
      id('command'),
      id('receipt'),
      c('opens', 'integer'),
      c('last_opened_at', 'bigint', null, false),
      c('row_stamp', 'text', 'C', false),
    ],
    [
      `CHECK ((expires_at > 0))`,
      `CHECK ((opens >= 0))`,
      `CHECK ((uses_left >= 0))`,
      `CHECK (((octet_length(row_stamp) >= 1) AND (octet_length(row_stamp) <= 512)))`,
      `PRIMARY KEY (id)`,
    ],
    [
      on(`CREATE INDEX ${LINK_EXPIRES_INDEX} ON ${tables.link} USING btree (expires_at)`),
      on(`CREATE INDEX ${LINK_INDEX} ON ${tables.link} USING btree (app_id, resource, row_key)`),
      on(`CREATE UNIQUE INDEX ${tables.link}_pkey ON ${tables.link} USING btree (id)`),
    ],
  ),
  table(
    tables.meta,
    [c('singleton', 'integer'), c('version', 'integer')],
    [`CHECK ((singleton = 1))`, `CHECK ((version = ${JOURNAL_VERSION}))`, `PRIMARY KEY (singleton)`],
    [on(`CREATE UNIQUE INDEX ${tables.meta}_pkey ON ${tables.meta} USING btree (singleton)`)],
  ),
  table(
    tables.proposal,
    [
      id('id'),
      id('app_id'),
      id('tenant_id'),
      id('command'),
      c('target', 'text', 'C', false),
      text('input'),
      id('actor_kind'),
      id('actor'),
      c('model', 'text', 'default', false),
      c('model_version', 'text', 'default', false),
      c('cost_micros', 'bigint', null, false),
      text('evidence'),
      text('reason'),
      id('state'),
      c('decided_by', 'text', 'C', false),
      c('decided_at', 'bigint', null, false),
      c('receipt_id', 'text', 'C', false),
      c('created_at', 'bigint'),
      c('expires_at', 'bigint'),
    ],
    [
      `CHECK (((octet_length(input) <= ${PROPOSAL_BOUNDS.input}) AND (json_typeof((input)::json) = 'object'::text)))`,
      anyOf('actor_kind', MAKER_KINDS),
      `CHECK ((cost_micros >= 0))`,
      EVIDENCE_CHECK,
      `CHECK ((octet_length(reason) <= ${PROPOSAL_BOUNDS.reason}))`,
      anyOf('state', PROPOSAL_STATES),
      `CHECK ((expires_at > created_at))`,
      `CHECK (((state = 'proposed'::text) = (decided_at IS NULL)))`,
      `PRIMARY KEY (id)`,
    ],
    [
      on(`CREATE INDEX ${PROPOSAL_CREATED_INDEX} ON ${tables.proposal} USING btree (created_at)`),
      on(`CREATE INDEX ${PROPOSAL_INDEX} ON ${tables.proposal} USING btree (app_id, tenant_id, state, created_at)`),
      on(`CREATE UNIQUE INDEX ${tables.proposal}_pkey ON ${tables.proposal} USING btree (id)`),
    ],
  ),
  table(
    tables.provenance,
    [
      id('id'),
      id('app_id'),
      id('tenant_id'),
      id('resource'),
      id('row_key'),
      c('field', 'text', 'C', false),
      id('actor_kind'),
      id('actor'),
      text('evidence'),
      c('created_at', 'bigint'),
      c('confirmed_by', 'text', 'C', false),
      c('confirmed_at', 'bigint', null, false),
    ],
    [anyOf('actor_kind', MAKER_KINDS), EVIDENCE_CHECK, `CHECK (((confirmed_by IS NULL) = (confirmed_at IS NULL)))`, `PRIMARY KEY (id)`],
    [
      on(`CREATE INDEX ${PROVENANCE_INDEX} ON ${tables.provenance} USING btree (app_id, tenant_id, resource, row_key)`),
      on(`CREATE UNIQUE INDEX ${tables.provenance}_pkey ON ${tables.provenance} USING btree (id)`),
    ],
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
      id('actor_kind'),
      c('proposal_id', 'text', 'C', false),
    ],
    [
      'CHECK ((((manifest_json IS NULL) = (event_count IS NULL)) AND ((manifest_json IS NULL) = (digest IS NULL)) AND ((manifest_json IS NULL) = (xact_id IS NULL))))',
      'CHECK (((event_count >= 0) AND (event_count <= 32)))',
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
      anyOf('actor_kind', RECEIPT_ACTOR_KINDS),
      `CHECK (((octet_length(proposal_id) >= 1) AND (octet_length(proposal_id) <= 128)))`,
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
