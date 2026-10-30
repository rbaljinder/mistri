/**
 * The support audit on PostgreSQL, beside the PostgreSQL tenant store and
 * administration journal: the same names, shapes, validation and MAC chain as
 * SQLite (tenantSupportAuditContract.ts), in the runtime schema as the
 * `support_` tables. Nothing on the request path opens it yet.
 *
 * Differences from SQLite, and why:
 * - Attestation is the store's: a pinned catalog description plus sole
 *   ownership by this role, with the tenant store attested first.
 * - Appends to one session are serialised by a row lock on the session
 *   (`FOR UPDATE`) — SQLite got that from `BEGIN IMMEDIATE`. The tip still
 *   moves by compare-and-set, as the backstop.
 * - `valid_until`, `head_seq` and `seq` are `bigint`, read back as `float8`
 *   (exact up to 2^53 - 1).
 */
import { isPromise, isProxy } from 'node:util/types';
import { Refusal, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../../adapters/commands/postgresCommandJournal.js';
import type { PgQuery, PgResult } from '@mistriwork/engine/adapters/postgresPool.js';
import { transactionView } from '@mistriwork/engine/adapters/postgresTransactionHandle.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import { identifier } from './tenantAdministrationJournalValidation.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import { denyAgain, denyLayout, type TenantStoreBinding } from './tenantStoreContract.js';
import { assertPostgresTenantStore, reservedTableOwnershipProblems } from './tenantStorePostgres.js';
import { attestOnce } from './postgresStoreFence.js';
import { SUPPORT_LOG_VISITS } from '../../shared/tenantSupportLog.js';
import {
  ENTRY_COLUMNS,
  ENTRY_SELECT,
  SESSION_COLUMNS,
  SESSION_SELECT,
  SUPPORT_AUDIT_PREFIX,
  SUPPORT_AUDIT_TABLES,
  type SupportLogRows,
  SUPPORT_AUDIT_VERSION,
  SUPPORT_DETAIL_BYTES,
  SUPPORT_END_REASONS,
  SUPPORT_ENTRY_KINDS,
  SUPPORT_KEY_BYTES,
  SUPPORT_NAME_BYTES,
  SUPPORT_REASON_BYTES,
  auditKeyDiffers,
  entryValues,
  keyId,
  SUPPORT_AUDIT_KEY_DIFFERS,
  planSupportAppend,
  planSupportOpen,
  sessionValues,
  supportAuditBinding as binding,
  supportAuditKey,
  captureSupportAuditHeader,
  verifySupportSession,
  type SupportAudit,
  type SupportAuditOwner,
  type SupportAuditKey,
  type SupportAuditReport,
  type SupportEntry,
  type SupportEntryRow,
  type SupportSession,
  type SupportSessionRow,
} from './tenantSupportAuditContract.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const tables = postgresRuntimeNames(SUPPORT_AUDIT_TABLES);
const q = (name: string) => runtimeTable('postgres', name);

import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';

export class SupportAuditUnavailable extends Refusal {
  constructor(
    message = 'The PostgreSQL support audit is missing, is not the layout this version expects ' +
      `(reserved "${SUPPORT_AUDIT_PREFIX}*" tables in "public", version ${SUPPORT_AUDIT_VERSION}), is bound to another App, source, ` +
      'store or audit key, or has no matching PostgreSQL tenant store. Run migratePostgresTenantStore(url, binding) and then ' +
      'migratePostgresSupportAudit(url, binding); an existing layout that differs is refused, not altered.',
  ) {
    super(message);
    this.name = 'SupportAuditUnavailable';
  }
}

/* The SQLite columns, byte-bounded the same way. */
const bounded = (name: string, maximum = 256) => `${name} text COLLATE "C" NOT NULL CHECK (octet_length(${name}) BETWEEN 1 AND ${maximum})`;
const optional = (name: string, maximum = 256) =>
  `${name} text COLLATE "C" CHECK (${name} IS NULL OR octet_length(${name}) BETWEEN 1 AND ${maximum})`;
const counter = (name: string) => `${name} bigint NOT NULL CHECK (${name} BETWEEN 0 AND 9007199254740991)`;
const digest = (name: string) => `${name} text COLLATE "C" NOT NULL CHECK (${name} ~ '^[0-9a-f]{64}$')`;
const oneOf = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const definitions: readonly string[] = [
  `CREATE TABLE ${q(tables.meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${SUPPORT_AUDIT_VERSION}),
  ${bounded('app_id', 1024)},
  ${bounded('source_id')},
  ${bounded('store_id', 1024)},
  ${bounded('key_id', 16)}
)`,
  `CREATE TABLE ${q(tables.session)} (
  ${bounded('id', 1024)} PRIMARY KEY,
  ${bounded('tenant_id', 128)},
  ${bounded('account_id', 1024)},
  ${bounded('operator_name', SUPPORT_NAME_BYTES)},
  ${bounded('dealer_role')},
  ${bounded('parent_membership_id', 1024)},
  ${bounded('parent_membership_version', 64)},
  ${bounded('platform_version', 64)},
  ${bounded('reason', SUPPORT_REASON_BYTES)},
  ${bounded('opened_at', 32)},
  ${counter('valid_until')},
  ${bounded('native_session_id', 1024)},
  ${bounded('deployment')},
  ${bounded('policy_id')},
  ${bounded('policy_version')},
  ${bounded('open_receipt_id', 1024)},
  ${optional('ended_at', 32)},
  end_reason text COLLATE "C" CHECK (end_reason IS NULL OR end_reason IN (${oneOf(SUPPORT_END_REASONS)})),
  ${counter('head_seq')},
  ${digest('head_mac')},
  CHECK ((ended_at IS NULL) = (end_reason IS NULL))
)`,
  `CREATE TABLE ${q(tables.entry)} (
  ${bounded('session_id', 1024)} REFERENCES ${q(tables.session)} (id) ON DELETE RESTRICT,
  ${counter('seq')},
  kind text COLLATE "C" NOT NULL CHECK (kind IN (${oneOf(SUPPORT_ENTRY_KINDS)})),
  ${bounded('at', 32)},
  ${bounded('request_id', 1024)},
  ${bounded('actor_id', 1024)},
  ${bounded('tenant_id', 128)},
  ${bounded('tenant_version', 64)},
  realm text COLLATE "C" NOT NULL CHECK (realm = 'tenant'),
  ${bounded('support_membership_version', 64)},
  ${bounded('parent_membership_version', 64)},
  ${bounded('platform_version', 64)},
  ${optional('resource')},
  ${optional('operation', 64)},
  key_json text CHECK (key_json IS NULL OR (octet_length(key_json) <= ${SUPPORT_KEY_BYTES} AND key_json::json IS NOT NULL)),
  detail_json text NOT NULL CHECK (octet_length(detail_json) <= ${SUPPORT_DETAIL_BYTES.read} AND detail_json::json IS NOT NULL),
  ${optional('command_receipt_id', 1024)},
  ${digest('prev_mac')},
  ${digest('mac')},
  PRIMARY KEY (session_id, seq)
)`,
  // A dealer's log is read by its tenant, newest first (readPostgresSupportLog).
  `CREATE INDEX "${tables.session}_tenant" ON ${q(tables.session)} (tenant_id, opened_at, id)`,
];

/* ---------- catalog description (pinned) ---------- */

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Column = PostgresRelationDescription['columns'][number];
const column = (name: string, type: string, collation: string | null, notnull = true): Column => ({
  name,
  type,
  notnull,
  collation,
  default: null,
});
const table = (name: string, columns: Column[], constraints: string[], indexes: string[]): PostgresRelationDescription => ({
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
/* The description the DDL above produces, read back from PostgreSQL 16.
   Pinned rather than derived, so the attestation is of this layout and not
   of whatever is there. */
const layout: readonly PostgresRelationDescription[] = [
  table(
    tables.entry,
    [
      column('session_id', 'text', 'C'),
      column('seq', 'bigint', null),
      column('kind', 'text', 'C'),
      column('at', 'text', 'C'),
      column('request_id', 'text', 'C'),
      column('actor_id', 'text', 'C'),
      column('tenant_id', 'text', 'C'),
      column('tenant_version', 'text', 'C'),
      column('realm', 'text', 'C'),
      column('support_membership_version', 'text', 'C'),
      column('parent_membership_version', 'text', 'C'),
      column('platform_version', 'text', 'C'),
      column('resource', 'text', 'C', false),
      column('operation', 'text', 'C', false),
      column('key_json', 'text', 'default', false),
      column('detail_json', 'text', 'default'),
      column('command_receipt_id', 'text', 'C', false),
      column('prev_mac', 'text', 'C'),
      column('mac', 'text', 'C'),
    ],
    [
      'CHECK (((command_receipt_id IS NULL) OR ((octet_length(command_receipt_id) >= 1) AND (octet_length(command_receipt_id) <= 1024))))',
      'CHECK (((key_json IS NULL) OR ((octet_length(key_json) <= 8192) AND ((key_json)::json IS NOT NULL))))',
      'CHECK (((octet_length(actor_id) >= 1) AND (octet_length(actor_id) <= 1024)))',
      'CHECK (((octet_length(at) >= 1) AND (octet_length(at) <= 32)))',
      'CHECK (((octet_length(detail_json) <= 262144) AND ((detail_json)::json IS NOT NULL)))',
      'CHECK (((octet_length(parent_membership_version) >= 1) AND (octet_length(parent_membership_version) <= 64)))',
      'CHECK (((octet_length(platform_version) >= 1) AND (octet_length(platform_version) <= 64)))',
      'CHECK (((octet_length(request_id) >= 1) AND (octet_length(request_id) <= 1024)))',
      'CHECK (((octet_length(session_id) >= 1) AND (octet_length(session_id) <= 1024)))',
      'CHECK (((octet_length(support_membership_version) >= 1) AND (octet_length(support_membership_version) <= 64)))',
      'CHECK (((octet_length(tenant_id) >= 1) AND (octet_length(tenant_id) <= 128)))',
      'CHECK (((octet_length(tenant_version) >= 1) AND (octet_length(tenant_version) <= 64)))',
      'CHECK (((operation IS NULL) OR ((octet_length(operation) >= 1) AND (octet_length(operation) <= 64))))',
      'CHECK (((resource IS NULL) OR ((octet_length(resource) >= 1) AND (octet_length(resource) <= 256))))',
      "CHECK (((seq >= 0) AND (seq <= '9007199254740991'::bigint)))",
      "CHECK ((kind = ANY (ARRAY['open'::text, 'read'::text, 'write'::text, 'undo'::text, 'command'::text, 'exit'::text])))",
      "CHECK ((mac ~ '^[0-9a-f]{64}$'::text))",
      "CHECK ((prev_mac ~ '^[0-9a-f]{64}$'::text))",
      "CHECK ((realm = 'tenant'::text))",
      'FOREIGN KEY (session_id) REFERENCES support_session(id) ON DELETE RESTRICT',
      'PRIMARY KEY (session_id, seq)',
    ],
    [`CREATE UNIQUE INDEX support_entry_pkey ON ${runtimeSchema('postgres')}.support_entry USING btree (session_id, seq)`],
  ),
  table(
    tables.meta,
    [
      column('singleton', 'integer', null),
      column('version', 'integer', null),
      column('app_id', 'text', 'C'),
      column('source_id', 'text', 'C'),
      column('store_id', 'text', 'C'),
      column('key_id', 'text', 'C'),
    ],
    [
      'CHECK (((octet_length(app_id) >= 1) AND (octet_length(app_id) <= 1024)))',
      'CHECK (((octet_length(key_id) >= 1) AND (octet_length(key_id) <= 16)))',
      'CHECK (((octet_length(source_id) >= 1) AND (octet_length(source_id) <= 256)))',
      'CHECK (((octet_length(store_id) >= 1) AND (octet_length(store_id) <= 1024)))',
      'CHECK ((singleton = 1))',
      `CHECK ((version = ${SUPPORT_AUDIT_VERSION}))`,
      'PRIMARY KEY (singleton)',
    ],
    [`CREATE UNIQUE INDEX support_meta_pkey ON ${runtimeSchema('postgres')}.support_meta USING btree (singleton)`],
  ),
  table(
    tables.session,
    [
      column('id', 'text', 'C'),
      column('tenant_id', 'text', 'C'),
      column('account_id', 'text', 'C'),
      column('operator_name', 'text', 'C'),
      column('dealer_role', 'text', 'C'),
      column('parent_membership_id', 'text', 'C'),
      column('parent_membership_version', 'text', 'C'),
      column('platform_version', 'text', 'C'),
      column('reason', 'text', 'C'),
      column('opened_at', 'text', 'C'),
      column('valid_until', 'bigint', null),
      column('native_session_id', 'text', 'C'),
      column('deployment', 'text', 'C'),
      column('policy_id', 'text', 'C'),
      column('policy_version', 'text', 'C'),
      column('open_receipt_id', 'text', 'C'),
      column('ended_at', 'text', 'C', false),
      column('end_reason', 'text', 'C', false),
      column('head_seq', 'bigint', null),
      column('head_mac', 'text', 'C'),
    ],
    [
      "CHECK (((end_reason IS NULL) OR (end_reason = ANY (ARRAY['exit'::text, 'expired'::text, 'revoked'::text, 'parent_revoked'::text, 'tenant_inactive'::text, 'superseded'::text]))))",
      'CHECK (((ended_at IS NULL) = (end_reason IS NULL)))',
      'CHECK (((ended_at IS NULL) OR ((octet_length(ended_at) >= 1) AND (octet_length(ended_at) <= 32))))',
      "CHECK (((head_seq >= 0) AND (head_seq <= '9007199254740991'::bigint)))",
      'CHECK (((octet_length(account_id) >= 1) AND (octet_length(account_id) <= 1024)))',
      'CHECK (((octet_length(dealer_role) >= 1) AND (octet_length(dealer_role) <= 256)))',
      'CHECK (((octet_length(deployment) >= 1) AND (octet_length(deployment) <= 256)))',
      'CHECK (((octet_length(id) >= 1) AND (octet_length(id) <= 1024)))',
      'CHECK (((octet_length(native_session_id) >= 1) AND (octet_length(native_session_id) <= 1024)))',
      'CHECK (((octet_length(open_receipt_id) >= 1) AND (octet_length(open_receipt_id) <= 1024)))',
      'CHECK (((octet_length(opened_at) >= 1) AND (octet_length(opened_at) <= 32)))',
      `CHECK (((octet_length(operator_name) >= 1) AND (octet_length(operator_name) <= ${SUPPORT_NAME_BYTES})))`,
      'CHECK (((octet_length(parent_membership_id) >= 1) AND (octet_length(parent_membership_id) <= 1024)))',
      'CHECK (((octet_length(parent_membership_version) >= 1) AND (octet_length(parent_membership_version) <= 64)))',
      'CHECK (((octet_length(platform_version) >= 1) AND (octet_length(platform_version) <= 64)))',
      'CHECK (((octet_length(policy_id) >= 1) AND (octet_length(policy_id) <= 256)))',
      'CHECK (((octet_length(policy_version) >= 1) AND (octet_length(policy_version) <= 256)))',
      'CHECK (((octet_length(reason) >= 1) AND (octet_length(reason) <= 500)))',
      'CHECK (((octet_length(tenant_id) >= 1) AND (octet_length(tenant_id) <= 128)))',
      "CHECK (((valid_until >= 0) AND (valid_until <= '9007199254740991'::bigint)))",
      "CHECK ((head_mac ~ '^[0-9a-f]{64}$'::text))",
      'PRIMARY KEY (id)',
    ],
    [
      `CREATE UNIQUE INDEX support_session_pkey ON ${runtimeSchema('postgres')}.support_session USING btree (id)`,
      `CREATE INDEX support_session_tenant ON ${runtimeSchema('postgres')}.support_session USING btree (tenant_id, opened_at, id)`,
    ],
  ),
].sort((a, b) => byCodeUnit(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`));

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);
const float = (select: string, columns: readonly string[]) =>
  columns.reduce((text, column) => text.replace(new RegExp(`(^|, )${column} AS`), `$1${column}::float8 AS`), select);
const sessionSelect = float(SESSION_SELECT, ['valid_until', 'head_seq']);
const entrySelect = float(ENTRY_SELECT, ['seq']);

const bound = (owner: TenantStoreBinding, key: SupportAuditKey) => (row: Record<string, unknown>) =>
  row.singleton === 1 &&
  row.version === SUPPORT_AUDIT_VERSION &&
  row.app_id === owner.appId &&
  row.source_id === owner.source.id &&
  row.store_id === owner.storeId &&
  row.key_id === keyId(key);
/* The layout is this version's and bound to this App, source and store, under another key (auditKeyDiffers). */
async function keyDiffers(client: PgQuery, owner: TenantStoreBinding, key: SupportAuditKey): Promise<boolean> {
  if (canonical(await describePostgresRelations(client, SUPPORT_AUDIT_PREFIX)) !== canonical(layout)) return false;
  const rows = (await client.query(`SELECT singleton, version, app_id, source_id, store_id, key_id FROM ${q(tables.meta)}`)).rows;
  return rows.length === 1 && auditKeyDiffers(rows[0], owner, key, SUPPORT_AUDIT_VERSION);
}
async function isLayout(client: PgQuery, owner: TenantStoreBinding, key: SupportAuditKey): Promise<boolean> {
  if (canonical(await describePostgresRelations(client, SUPPORT_AUDIT_PREFIX)) !== canonical(layout)) return false;
  return binds(client, owner, key);
}
/** Whether the meta row binds the audit to `owner` and `key`: read in every attestation, a shared one too (postgresStoreFence.ts). */
async function binds(client: PgQuery, owner: TenantStoreBinding, key: SupportAuditKey): Promise<boolean> {
  const rows = (await client.query(`SELECT singleton, version, app_id, source_id, store_id, key_id FROM ${q(tables.meta)}`)).rows;
  return rows.length === 1 && bound(owner, key)(rows[0]);
}
/* Attested in full when an adapter first uses it, after its tenant store (postgresStoreFence.ts). */
async function attest(client: PgQuery, owner: TenantStoreBinding, key: SupportAuditKey): Promise<void> {
  await assertPostgresTenantStore(client, owner);
  await attestOnce(
    client,
    SUPPORT_AUDIT_PREFIX,
    canonical([owner, keyId(key)]),
    async () => {
      if (!(await isLayout(client, owner, key)))
        return denyLayout(
          (await keyDiffers(client, owner, key))
            ? SUPPORT_AUDIT_KEY_DIFFERS
            : layoutRefusal('The PostgreSQL support audit', await postgresLayoutVersion(client, q(tables.meta)), SUPPORT_AUDIT_VERSION),
        );
      if ((await reservedTableOwnershipProblems(client, SUPPORT_AUDIT_PREFIX)).length) denyTenant();
    },
    () => binds(client, owner, key),
  );
}
/* What a deleted row leaves behind, as on SQLite: an entry whose session is
   gone, or a session with no opening entry. */
async function broken(client: PgQuery): Promise<string[]> {
  return (
    (
      await client.query(`SELECT DISTINCT e.session_id AS id FROM ${q(tables.entry)} e
      LEFT JOIN ${q(tables.session)} s ON s.id = e.session_id WHERE s.id IS NULL
    UNION SELECT s.id FROM ${q(tables.session)} s WHERE NOT EXISTS
      (SELECT 1 FROM ${q(tables.entry)} e WHERE e.session_id = s.id AND e.seq = 0 AND e.kind = 'open')
    ORDER BY 1`)
    ).rows as { id: string }[]
  ).map((row) => row.id);
}
/** The PostgreSQL twin of `readSqliteSupportLog`: one tenant's stored support
 * history, filtered in SQL on the stored column so another dealer's session is
 * never loaded. Verifies nothing and admits nobody. */
export async function readPostgresSupportLog(client: PgQuery, tenantId: string | null): Promise<SupportLogRows> {
  const where = tenantId === null ? '' : ' WHERE tenant_id = $1';
  const parameters: unknown[] = tenantId === null ? [] : [tenantId];
  // The newest visits, and one more to say whether older ones exist.
  const found = (
    await client.query(
      `SELECT ${sessionSelect} FROM ${q(tables.session)}${where}
    ORDER BY opened_at DESC, id DESC LIMIT $${parameters.length + 1}`,
      [...parameters, SUPPORT_LOG_VISITS + 1],
    )
  ).rows;
  const sessions = found.slice(0, SUPPORT_LOG_VISITS).map((row) => ({ ...row }) as unknown as SupportSessionRow);
  // Those visits' own entries, by their key; still filtered on the tenant.
  const entries = sessions.length
    ? (
        await client.query(
          `SELECT ${entrySelect} FROM ${q(tables.entry)}` +
            `${where ? `${where} AND` : ' WHERE'} session_id = ANY($${parameters.length + 1}::text[]) ORDER BY session_id, seq`,
          [...parameters, sessions.map((session) => session.id)],
        )
      ).rows
    : [];
  return {
    sessions,
    entries: entries.map((row) => ({ ...row }) as unknown as SupportEntryRow),
    more: found.length > SUPPORT_LOG_VISITS,
  };
}

async function readSession(
  client: PgQuery,
  id: string,
  lock: boolean,
): Promise<{ session: SupportSessionRow; entries: SupportEntryRow[] } | null> {
  const sessions = (await client.query(`SELECT ${sessionSelect} FROM ${q(tables.session)} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]))
    .rows;
  if (sessions.length !== 1) return null;
  const entries = (await client.query(`SELECT ${entrySelect} FROM ${q(tables.entry)} WHERE session_id = $1 ORDER BY seq`, [id])).rows;
  return {
    session: { ...sessions[0] } as unknown as SupportSessionRow,
    entries: entries.map((entry) => ({ ...entry }) as unknown as SupportEntryRow),
  };
}

/** Attest the audit (and its tenant store) inside the caller's transaction. */
export async function assertPostgresSupportAudit(client: PgQuery, input: TenantStoreBinding, key: SupportAuditKey): Promise<void> {
  try {
    await attest(client, binding(input), key);
  } catch (error) {
    denyAgain(error);
  }
}

/** Explicit maintenance after `migratePostgresTenantStore`: creates the audit
 * once under the given key (by default `MISTRI_AUDIT_KEY`), is idempotent
 * on the exact layout, binding and key, and refuses anything else unchanged,
 * under the shared maintenance lock. */
export async function migratePostgresSupportAudit(
  url: string,
  input: TenantStoreBinding,
  key: SupportAuditKey = supportAuditKey(),
): Promise<{ version: 1; migrated: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Support audit migration requires a postgres:// URL.');
  let owner: TenantStoreBinding;
  try {
    owner = binding(input);
    keyId(key);
  } catch {
    throw new Refusal('Support audit migration requires a binding: { appId, source: { id, connection }, storeId }, and the audit key.');
  }
  return withPostgresMaintenanceTransaction(url, async (client) => {
    try {
      await assertPostgresTenantStore(client, owner);
    } catch {
      throw new SupportAuditUnavailable();
    }
    const migrated = (await describePostgresRelations(client, SUPPORT_AUDIT_PREFIX)).length === 0;
    if (migrated) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(
        `INSERT INTO ${q(tables.meta)} (singleton, version, app_id, source_id, store_id, key_id) VALUES (1, $1, $2, $3, $4, $5)`,
        [SUPPORT_AUDIT_VERSION, owner.appId, owner.source.id, owner.storeId, keyId(key)],
      );
    }
    if (await keyDiffers(client, owner, key)) throw new SupportAuditUnavailable(SUPPORT_AUDIT_KEY_DIFFERS);
    if (!(await isLayout(client, owner, key)) || (await broken(client)).length)
      throw new SupportAuditUnavailable(
        layoutRefusal('The PostgreSQL support audit', await postgresLayoutVersion(client, q(tables.meta)), SUPPORT_AUDIT_VERSION),
      );
    const problems = await reservedTableOwnershipProblems(client, SUPPORT_AUDIT_PREFIX);
    if (problems.length) {
      throw new SupportAuditUnavailable(
        `The PostgreSQL support audit is refused, not altered: ${problems.join('; ')}. ` +
          'Its tables must be owned by the connecting role, or a role whose privileges it inherits, and no other role, PUBLIC included, may hold a privilege on them.',
      );
    }
    return { version: 1, migrated };
  });
}

/** Maintenance: verify every session's chain in one read-only transaction.
 * Refuses a store that is not this layout, binding and key; reports, rather
 * than refuses, the sessions whose rows were altered, by id. */
export async function verifyPostgresSupportAudit(
  url: string,
  input: TenantStoreBinding,
  key: SupportAuditKey = supportAuditKey(),
): Promise<SupportAuditReport> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Support audit verification requires a postgres:// URL.');
  const owner = binding(input);
  return withPostgresMaintenanceTransaction(url, async (client) => {
    try {
      await client.query('SET TRANSACTION READ ONLY');
      await attest(client, owner, key);
      const failed = new Set(await broken(client));
      const ids = ((await client.query(`SELECT id FROM ${q(tables.session)} ORDER BY id`)).rows as { id: string }[]).map((row) => row.id);
      for (const id of ids) {
        const read = (await readSession(client, id, false))!;
        if (!verifySupportSession(key, owner, read.session, read.entries)) failed.add(id);
      }
      const entries = Number((await client.query(`SELECT count(*)::float8 AS n FROM ${q(tables.entry)}`)).rows[0].n);
      return {
        version: 1 as const,
        sessions: ids.length,
        entries,
        failed: [...failed].sort(),
      };
    } catch {
      return denyTenant();
    }
  });
}

const insertSession = `INSERT INTO ${q(tables.session)} (${SESSION_COLUMNS.join(', ')}) VALUES (${SESSION_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`;
const insertEntry = `INSERT INTO ${q(tables.entry)} (${ENTRY_COLUMNS.join(', ')}) VALUES (${ENTRY_COLUMNS.map((_, i) => `$${i + 1}`).join(', ')})`;

/** Owner-only composition on the owner's open transaction and queue, the
 * PostgreSQL counterpart of `createSqliteSupportAudit`. */
export function createPostgresSupportAudit(
  client: PgQuery,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  key: SupportAuditKey,
  assertActive?: () => void,
): SupportAudit {
  return composePostgresSupportAudit(client, operations, input, key, assertActive).audit;
}

/** Borrow the owner's native writer and queue. Call only after receipt,
 * platform, parent, dealer and support-row locks; this is not admission. */
export function createPostgresSupportAuditOwner(
  client: PgQuery,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  key: SupportAuditKey,
  assertActive?: () => void,
): SupportAuditOwner {
  return composePostgresSupportAudit(client, operations, input, key, assertActive, true);
}

function composePostgresSupportAudit(
  client: PgQuery,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  key: SupportAuditKey,
  assertActive?: () => void,
  checkpointQueries = false,
): SupportAuditOwner {
  const owner = binding(input);
  keyId(key);
  if (
    !client ||
    typeof client.query !== 'function' ||
    isProxy(client) ||
    (assertActive !== undefined && (typeof assertActive !== 'function' || isProxy(assertActive)))
  )
    return denyTenant();
  if (checkpointQueries) {
    // Private owner path fences every actual await, including attestor queries.
    // The captured client is trusted composition, not a structural auth proof.
    const native = client;
    const checkpoint = () => {
      if (!assertActive) return;
      const result = assertActive() as unknown;
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined) denyTenant();
    };
    function query(text: string, params?: unknown[]): Promise<PgResult<Record<string, unknown>>>;
    function query(config: { text: string; values?: unknown[]; rowMode?: string }): Promise<PgResult<unknown[]>>;
    async function query(text: string | { text: string; values?: unknown[]; rowMode?: string }, params?: unknown[]) {
      checkpoint();
      const result = typeof text === 'string' ? await native.query(text, params) : await native.query(text);
      checkpoint();
      return result;
    }
    // A view of the same transaction: what it has attested is still its own.
    client = transactionView(native, query);
  }
  const verified = async () => {
    await attest(client, owner, key);
    if (assertActive) {
      const result = assertActive() as unknown;
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined) return denyTenant();
    }
  };
  const invoke = <A, R>(value: A, work: (captured: A) => Promise<R>): Promise<R> => {
    let captured: A,
      invalid = false;
    try {
      captured = captureTenantData(value);
    } catch {
      invalid = true;
    }
    const pending = operations
      .run(async () => {
        try {
          if (invalid) return denyTenant();
          await verified();
          const result = await work(captured!);
          await verified();
          return result;
        } catch (error) {
          return denyAgain(error);
        }
      })
      .catch((error) => denyAgain(error));
    void pending.catch(() => {});
    return pending;
  };
  const audit: SupportAudit = Object.freeze({
    open: (session: SupportSession, entry: SupportEntry) =>
      invoke({ session, entry }, async (value) => {
        const plan = planSupportOpen(key, owner, value.session, value.entry);
        const opened = await client.query(insertSession, sessionValues(plan.session));
        const first = await client.query(insertEntry, entryValues(plan.entry));
        if (opened.rowCount !== 1 || first.rowCount !== 1) denyTenant();
      }),
    append: (sessionId: string, entry: SupportEntry) =>
      invoke({ sessionId, entry }, async (value) => {
        const read = typeof value.sessionId === 'string' ? await readSession(client, value.sessionId, true) : null;
        if (!read) return denyTenant();
        const plan = planSupportAppend(key, owner, read.session, read.entries, value.entry);
        const written = await client.query(insertEntry, entryValues(plan.entry));
        const moved = await client.query(
          `UPDATE ${q(tables.session)} SET head_seq = $1, head_mac = $2, ended_at = $3, end_reason = $4
        WHERE id = $5 AND head_seq = $6 AND head_mac = $7 AND ended_at IS NULL`,
          [
            plan.headSeq,
            plan.headMac,
            plan.end?.endedAt ?? null,
            plan.end?.endReason ?? null,
            read.session.id,
            read.session.headSeq,
            read.session.headMac,
          ],
        );
        if (written.rowCount !== 1 || moved.rowCount !== 1) denyTenant();
        return { seq: plan.headSeq };
      }),
    verify: (sessionId: string) =>
      invoke(sessionId, async (id) => {
        const read = typeof id === 'string' ? await readSession(client, id, false) : null;
        return read ? verifySupportSession(key, owner, read.session, read.entries) : null;
      }),
  });
  return Object.freeze({
    audit,
    readHeader: (sessionId: string) =>
      invoke(sessionId, async (id) => {
        // One queue operation: awaiting audit.verify() here would deadlock.
        identifier(id, 1024);
        const read = await readSession(client, id, true);
        if (!read) return null;
        if (!verifySupportSession(key, owner, read.session, read.entries)) return denyTenant();
        return captureSupportAuditHeader(owner, read.session);
      }),
  });
}
