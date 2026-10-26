/**
 * Every store mistri keeps in a database of its own, defined once: where
 * its tables are, how it is provisioned and attested, and the one way to bring
 * an older one forward (`mistri migrate stores status | up`). Every store is
 * at layout version 1; a later layout adds its steps here.
 *
 * A store is provisioned explicitly (`provisionStores` in @mistriwork/mistri/maintenance,
 * or `mistri migrate stores up --app`), attested at open and never changed
 * by serving. What was missing was a
 * single place that says which version each store is at and how to take it
 * to the next, so each upgrade had a command of its own. Here a store
 * registers the version it expects per dialect, how to read the version a
 * database holds, and one step per version it can leave: a step takes
 * version n to n+1 in one transaction (PostgreSQL: under an advisory lock
 * named for the store, so two operators never run it at once). `up` applies
 * the steps a database is behind by, in order, and is idempotent; a store
 * with no step from the version it holds is refused unchanged ("reseed"),
 * which is what every store said before, now said in one place.
 *
 * `up` upgrades what is there. It creates a store only where the binding is
 * given: with `--app`, the journal and event store the App's commands need
 * (storesCli.ts). A bare database carries no binding (an App, a source, a
 * suite), and a database without a store is not behind it.
 *
 * Tables are found by their reserved names, so a database needs no
 * configuration to be read: the marker is the store's own version row.
 */
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { quoteIdent, type Dialect, type MigrationDb } from '@mistriwork/engine/server/migrate/database.js';
import { runtimeRelation } from '@mistriwork/engine/shared/runtimeTables.js';
import type { MysqlConnection } from '@mistriwork/engine/adapters/mysqlDriver.js';
import { postgresPoolDefaults, type PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { TenantStoreBinding } from './tenant/tenantStoreContract.js';

/** What a step is given. `url` is the database's own address, for the
 * steps that open a connection of their own. */
interface StepContext {
  readonly db: MigrationDb;
  readonly url: string;
}

interface StoreStep {
  /** One line for `up`: what this step does. */
  readonly says: string;
  /** Opens its own connection and transaction (flags, experiments), so the runner does not wrap it in its
   * transaction; it still runs under the store's lock, held by the runner's connection for the step's length. */
  readonly own?: boolean;
  run(context: StepContext): Promise<void>;
}

/** What a provisioning did: the version it left, where the store keeps one, and whether this call created it. */
export type StoreProvisioned = Readonly<{ version?: number; provisioned: boolean }>;

/**
 * Where a store's tables are: the names under its reserved prefix, in the
 * business database (shared/runtimeTables.ts) — inside the runtime schema on
 * PostgreSQL, where the prefix loses its `__mistri_` (`__mistri_flag_` is
 * `mistri.flag_*`), and as named elsewhere. `own`: they are kept in a database
 * of their own instead (a suite's, a sign-in file, a flag control database).
 */
type StoreTables = Readonly<{ prefix: string; own?: true }>;

export interface StoreDef {
  readonly id: string;
  readonly title: string;
  readonly tables: StoreTables;
  /** The version this build expects, per dialect it supports. A store kept without a version row (the schema epoch) has none. */
  readonly current: Readonly<Partial<Record<Dialect, number>>>;
  /** The version the database holds, or null when it holds none of this store. Throws when the marker is not a version. */
  read(db: MigrationDb): Promise<number | null>;
  /** Per dialect, the step that takes version `from` to `from + 1`. */
  readonly upgrades: Readonly<Partial<Record<Dialect, Readonly<Record<number, StoreStep>>>>>;
  /**
   * Per dialect, provisioning it where it needs no binding: given the database's
   * address (a SQLite path, a PostgreSQL or MySQL URL). A store bound to an
   * App, a tenant or a job module has none here: provisionStores derives it
   * from that binding, as the server does.
   */
  readonly provision?: Readonly<Partial<Record<Dialect, (address: string) => Promise<StoreProvisioned>>>>;
  /**
   * Per dialect, provisioning a store a tenant App's binding owns: given the
   * database's address and that binding (`provisionStores`' `app.tenant`).
   * Their order is the stores' own: the journal needs the tenant store and the
   * invitations need the journal, so provisionStores runs them by `TENANT_ORDER`.
   */
  readonly provisionTenant?: Readonly<
    Partial<Record<'sqlite' | 'postgres', (address: string, binding: TenantStoreBinding) => Promise<StoreProvisioned>>>
  >;
  /** Per dialect, whether a database holds this build's layout, as a start asks before it serves the store. */
  readonly attest?: Readonly<{
    sqlite?: (db: DatabaseSync) => Promise<boolean>;
    postgres?: (client: PgQuery) => Promise<boolean>;
    mysql?: (db: MysqlConnection, database: string) => Promise<boolean>;
  }>;
}

/** The order a tenant App's stores are provisioned in, whatever order they are asked for. */
export const TENANT_ORDER: readonly string[] = ['tenant-store', 'tenant-administration', 'tenant-invitations', 'tenant-support-audit'];

/** A marker the database holds that is not a version this registry can read. */
class StoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StoreRefused';
  }
}

/* ---------- reading ---------- */

/* The table that holds the version, as SQLite and MySQL name it; PostgreSQL reads it in the runtime schema. */
interface Marker {
  readonly table: string;
  readonly column?: string;
}

async function tableExists(db: MigrationDb, marker: Marker): Promise<boolean> {
  if (db.dialect === 'sqlite')
    return (await db.all(`SELECT 1 AS found FROM sqlite_schema WHERE type = 'table' AND name = ?`, [marker.table])).length > 0;
  /* The catalog rows, not to_regclass: that resolves a name through a cache
     that can still say "no such table" for a table another session created
     and committed while this one waited for its lock. */
  if (db.dialect === 'postgres') {
    return (
      (
        await db.all(
          `SELECT 1 AS found FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ? AND c.relname = ? AND c.relkind IN ('r', 'p')`,
          [runtimeRelation('postgres', marker.table).schema, runtimeRelation('postgres', marker.table).relname],
        )
      ).length > 0
    );
  }
  return (
    (await db.all('SELECT 1 AS found FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [marker.table]))
      .length > 0
  );
}

async function versionOf(db: MigrationDb, marker: Marker): Promise<number> {
  const name =
    db.dialect === 'postgres'
      ? `${quoteIdent(db.dialect, runtimeRelation('postgres', marker.table).schema!)}.${quoteIdent(db.dialect, runtimeRelation('postgres', marker.table).relname)}`
      : quoteIdent(db.dialect, marker.table);
  const rows = await db.all<Record<string, unknown>>(
    `SELECT ${quoteIdent(db.dialect, marker.column ?? 'version')} AS version FROM ${name}`,
  );
  const versions = [...new Set(rows.map((row) => Number(row.version)))];
  if (versions.length !== 1 || !Number.isInteger(versions[0])) throw new StoreRefused(`${marker.table} does not hold one version`);
  return versions[0];
}

const marked =
  (markers: Readonly<Partial<Record<Dialect, Marker>>>) =>
  async (db: MigrationDb): Promise<number | null> => {
    const marker = markers[db.dialect];
    if (!marker || !(await tableExists(db, marker))) return null;
    return versionOf(db, marker);
  };

/** The same table name on every engine a store runs on; PostgreSQL's in the runtime schema. */
const everywhere = (table: string, column = 'version'): Readonly<Record<Dialect, Marker>> => ({
  sqlite: { table, column },
  postgres: { table, column },
  mysql: { table, column },
});
const both = (version: number): Readonly<Partial<Record<Dialect, number>>> => ({ sqlite: version, postgres: version });
const sqliteOnly = (table: string, column = 'version'): Readonly<Partial<Record<Dialect, Marker>>> => ({ sqlite: { table, column } });

/* ---------- the registry ---------- */

export const STORES: readonly StoreDef[] = Object.freeze<StoreDef[]>([
  {
    id: 'auth',
    title: 'sign-in accounts and the account trail (Better Auth)',
    tables: { prefix: '__mistri_auth_', own: true },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_auth_meta' }, postgres: { table: 'auth_meta' } }),
    upgrades: {},
  },
  {
    id: 'api-tokens',
    title: 'API tokens, beside the accounts',
    tables: { prefix: '__mistri_auth_', own: true },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_api_token_meta' }, postgres: { table: 'auth_api_token_meta' } }),
    upgrades: {},
  },
  {
    id: 'record-history',
    title: 'record history',
    tables: { prefix: '__mistri_history_' },
    current: { sqlite: 1, postgres: 1, mysql: 1 },
    read: marked(everywhere('__mistri_history_meta')),
    upgrades: {},
    provision: {
      sqlite: async (path) => (await import('../adapters/history/sqliteRecordHistory.js')).provisionSqliteRecordHistory(path),
      postgres: async (url) => (await import('../adapters/history/postgresRecordHistory.js')).provisionPostgresRecordHistory(url),
      mysql: async (url) => (await import('../adapters/history/mysqlRecordHistory.js')).provisionMysqlRecordHistory(url),
    },
    attest: {
      sqlite: async (db) => (await import('../adapters/history/sqliteRecordHistory.js')).sqliteRecordHistoryReady(db),
      postgres: async (client) => (await import('../adapters/history/postgresRecordHistory.js')).postgresRecordHistoryReady(client),
      mysql: async (db, database) => (await import('../adapters/history/mysqlRecordHistory.js')).mysqlRecordHistoryReady(db, database),
    },
  },
  {
    id: 'live-change',
    title: 'live sync: what each write transaction changed, kept fifteen minutes',
    tables: { prefix: '__mistri_live_' },
    current: { sqlite: 1, postgres: 1, mysql: 1 },
    read: marked(everywhere('__mistri_live_meta')),
    upgrades: {},
    provision: {
      sqlite: async (path) => (await import('../adapters/live/sqliteLiveChange.js')).provisionSqliteLiveChange(path),
      postgres: async (url) => (await import('../adapters/live/postgresLiveChange.js')).provisionPostgresLiveChange(url),
      mysql: async (url) => (await import('../adapters/live/mysqlLiveChange.js')).provisionMysqlLiveChange(url),
    },
    attest: {
      sqlite: async (db) => (await import('../adapters/live/sqliteLiveChange.js')).sqliteLiveChangeReady(db),
      postgres: async (client) => (await import('../adapters/live/postgresLiveChange.js')).postgresLiveChangeReady(client),
      mysql: async (db, database) => (await import('../adapters/live/mysqlLiveChange.js')).mysqlLiveChangeReady(db, database),
    },
  },
  {
    id: 'inbox',
    title: 'notices, mail and opt-outs',
    tables: { prefix: '__mistri_inbox_' },
    current: { sqlite: 1, postgres: 1, mysql: 1 },
    read: marked(everywhere('__mistri_inbox_meta')),
    upgrades: {},
    provision: {
      sqlite: async (path) => (await import('../adapters/inbox/sqliteInbox.js')).provisionSqliteInbox(path),
      postgres: async (url) => (await import('../adapters/inbox/postgresInbox.js')).provisionPostgresInbox(url),
      mysql: async (url) => (await import('../adapters/inbox/mysqlInbox.js')).provisionMysqlInbox(url),
    },
    attest: {
      sqlite: async (db) => (await import('../adapters/inbox/sqliteInbox.js')).sqliteInboxReady(db),
      postgres: async (client) => (await import('../adapters/inbox/postgresInbox.js')).postgresInboxReady(client),
      mysql: async (db, database) => (await import('../adapters/inbox/mysqlInbox.js')).mysqlInboxReady(db, database),
    },
  },
  {
    id: 'branding',
    title: "tenants' branding and logos",
    tables: { prefix: '__mistri_branding_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_branding_meta' }, postgres: { table: '__mistri_branding_meta' } }),
    upgrades: {},
    provision: {
      sqlite: async (path) => (await import('../adapters/branding/sqliteBranding.js')).provisionSqliteBranding(path),
      postgres: async (url) => (await import('../adapters/branding/postgresBranding.js')).provisionPostgresBranding(url),
    },
    attest: {
      sqlite: async (db) => (await import('../adapters/branding/sqliteBranding.js')).sqliteBrandingReady(db),
      postgres: async (client) => (await import('../adapters/branding/postgresBranding.js')).postgresBrandingReady(client),
    },
  },
  {
    id: 'tenant-switch',
    title: "the platform owner's per-tenant switches (assistant, decision providers)",
    tables: { prefix: '__mistri_switch_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_switch_meta' }, postgres: { table: '__mistri_switch_meta' } }),
    upgrades: {},
    provision: {
      sqlite: async (path) => (await import('../adapters/switch/sqliteTenantSwitch.js')).provisionSqliteTenantSwitchAt(path),
      postgres: async (url) => (await import('../adapters/switch/postgresTenantSwitch.js')).provisionPostgresTenantSwitchAt(url),
    },
    attest: {
      sqlite: async (db) => (await import('../adapters/switch/sqliteTenantSwitch.js')).sqliteTenantSwitchReady(db),
      postgres: async (client) => (await import('../adapters/switch/postgresTenantSwitch.js')).postgresTenantSwitchReady(client),
    },
  },
  {
    id: 'assistant',
    title: "the assistant's conversations and token counts",
    tables: { prefix: '__mistri_assistant_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_assistant_meta' }, postgres: { table: '__mistri_assistant_meta' } }),
    upgrades: {},
    provision: {
      sqlite: async (path) => (await import('../adapters/assistant/sqliteAssistant.js')).provisionSqliteAssistant(path),
      postgres: async (url) => (await import('../adapters/assistant/postgresAssistant.js')).provisionPostgresAssistant(url),
    },
  },
  {
    id: 'decisions',
    title: 'decisions made, their outcomes and usage',
    tables: { prefix: '__mistri_decision_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_decision_meta' }, postgres: { table: '__mistri_decision_meta' } }),
    upgrades: {},
    provision: {
      sqlite: async (path) => (await import('../adapters/decide/sqliteDecisions.js')).provisionSqliteDecisions(path),
      postgres: async (url) => (await import('../adapters/decide/postgresDecisions.js')).provisionPostgresDecisions(url),
    },
    attest: {
      sqlite: async (db) => (await import('../adapters/decide/sqliteDecisions.js')).sqliteDecisionsReady(db),
      postgres: async (client) => (await import('../adapters/decide/postgresDecisions.js')).postgresDecisionsReady(client),
    },
  },
  {
    id: 'command-journal',
    title: 'command receipts and audit',
    tables: { prefix: '__mistri_command_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_command_meta' }, postgres: { table: '__mistri_command_meta' } }),
    upgrades: {},
  },
  {
    id: 'command-sequences',
    title: 'numbers a command hands out',
    tables: { prefix: '__mistri_sequence_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_sequence_meta' }, postgres: { table: '__mistri_sequence_meta' } }),
    upgrades: {},
  },
  {
    id: 'public-placement',
    title: 'public form placement receipts',
    tables: { prefix: '__mistri_public_placement_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_public_placement_meta' }, postgres: { table: '__mistri_public_placement_meta' } }),
    upgrades: {},
  },
  {
    id: 'command-events',
    title: 'events a command emits',
    tables: { prefix: '__mistri_event_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_event_meta' }, postgres: { table: '__mistri_event_meta' } }),
    upgrades: {},
  },
  {
    id: 'event-delivery',
    title: 'event deliveries and attempts',
    tables: { prefix: '__mistri_delivery_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_delivery_meta' }, postgres: { table: '__mistri_delivery_meta' } }),
    upgrades: {},
  },
  {
    id: 'jobs',
    title: 'durable jobs',
    tables: { prefix: '__mistri_job_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_job_policy' }, postgres: { table: '__mistri_job_policy' } }),
    upgrades: {},
  },
  {
    id: 'workflows',
    title: 'durable workflow instances and steps',
    tables: { prefix: '__mistri_workflow_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_workflow_meta' }, postgres: { table: '__mistri_workflow_meta' } }),
    upgrades: {},
  },
  {
    id: 'mail',
    title: "a tenant App's mail log and signed links",
    tables: { prefix: '__mistri_mail_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_mail_meta' }, postgres: { table: '__mistri_mail_meta' } }),
    upgrades: {},
  },
  {
    id: 'integrations',
    title: "integrations' secrets, calls, webhook deliveries and channel messages",
    tables: { prefix: '__mistri_integration_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_integration_meta' }, postgres: { table: '__mistri_integration_meta' } }),
    upgrades: {},
    provision: {
      sqlite: async (path) => (await import('../adapters/integrations/integrationStore.js')).provisionSqliteIntegrations(path),
      postgres: async (url) => (await import('../adapters/integrations/integrationStore.js')).provisionPostgresIntegrations(url),
    },
  },
  {
    id: 'tenant-store',
    title: 'tenants and memberships',
    tables: { prefix: '__mistri_tenant_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_tenant_meta' }, postgres: { table: '__mistri_tenant_meta' } }),
    upgrades: {},
    provisionTenant: {
      sqlite: async (path, binding) => ({ ...(await import('./tenant/tenantStore.js')).provisionSqliteTenantStore(path, binding) }),
      postgres: async (url, binding) => {
        const { migrated, ...made } = await (await import('./tenant/tenantStorePostgres.js')).migratePostgresTenantStore(url, binding);
        return { ...made, provisioned: migrated };
      },
    },
  },
  {
    id: 'tenant-invitations',
    title: 'tenant invitations',
    tables: { prefix: '__mistri_invitation_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_invitation_meta' }, postgres: { table: '__mistri_invitation_meta' } }),
    upgrades: {},
    provisionTenant: {
      sqlite: async (path, binding) => ({
        ...(await import('./tenant/tenantInvitationStore.js')).provisionSqliteTenantInvitations(path, binding),
      }),
      postgres: async (url, binding) => {
        const { migrated, ...made } = await (
          await import('./tenant/tenantInvitationStorePostgres.js')
        ).migratePostgresTenantInvitations(url, binding);
        return { ...made, provisioned: migrated };
      },
    },
  },
  {
    id: 'tenant-administration',
    title: 'tenant administration journal',
    tables: { prefix: '__mistri_admin_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_admin_meta' }, postgres: { table: '__mistri_admin_meta' } }),
    upgrades: {},
    provisionTenant: {
      sqlite: async (path, binding) => ({
        ...(await import('./tenant/tenantAdministrationJournal.js')).provisionSqliteTenantAdministrationJournal(path, binding),
      }),
      postgres: async (url, binding) => {
        const { migrated, ...made } = await (
          await import('./tenant/tenantAdministrationJournalPostgres.js')
        ).migratePostgresTenantAdministrationJournal(url, binding);
        return { ...made, provisioned: migrated };
      },
    },
  },
  {
    id: 'tenant-support-audit',
    title: 'support sessions and their audit',
    tables: { prefix: '__mistri_support_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_support_meta' }, postgres: { table: '__mistri_support_meta' } }),
    upgrades: {},
    provisionTenant: {
      sqlite: async (path, binding) => ({ ...(await import('./tenant/tenantSupportAudit.js')).provisionSqliteSupportAudit(path, binding) }),
      postgres: async (url, binding) => {
        const { migrated, ...made } = await (
          await import('./tenant/tenantSupportAuditPostgres.js')
        ).migratePostgresSupportAudit(url, binding);
        return { ...made, provisioned: migrated };
      },
    },
  },
  {
    id: 'tenant-sandboxes',
    title: "a tenant App's sandboxes, their dev clocks and their copied rows' bases",
    tables: { prefix: '__mistri_sandbox_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_sandbox_meta' }, postgres: { table: '__mistri_sandbox_meta' } }),
    upgrades: {},
    provision: {
      /* The store keeps one layout, so the version it is made at is that one. */
      sqlite: async (path) => ({ version: 1, ...(await import('./tenant/tenantSandboxStore.js')).provisionSqliteTenantSandboxes(path) }),
      postgres: async (url) => ({
        version: 1,
        ...(await (await import('./tenant/tenantSandboxStore.js')).provisionPostgresTenantSandboxes(url)),
      }),
    },
  },
  /* A suite's stores are bound to it, as the flag control is to its deployment: a suite's start provisions them
     (all three together in the runtime schema on PostgreSQL, suiteStoresPostgres.ts), so none has a `provision` here. */
  {
    id: 'suite-grants',
    title: 'suite administrator grants',
    tables: { prefix: '__mistri_suite_grant', own: true },
    current: both(1),
    read: marked({ ...sqliteOnly('suite_binding'), postgres: { table: 'suite_grant_binding' } }),
    upgrades: {},
  },
  {
    id: 'suite-preferences',
    title: 'suite account preferences',
    tables: { prefix: '__mistri_suite_preference', own: true },
    current: { sqlite: 1, postgres: 1 },
    read: marked({ ...sqliteOnly('suite_preferences_binding'), postgres: { table: 'suite_preference_binding' } }),
    upgrades: {},
  },
  {
    id: 'suite-authority',
    title: 'suite authority history',
    tables: { prefix: '__mistri_suite_authority', own: true },
    current: { sqlite: 1, postgres: 1 },
    read: marked({ ...sqliteOnly('suite_authority_binding'), postgres: { table: 'suite_authority_binding' } }),
    upgrades: {},
  },
  {
    id: 'flags',
    title: 'flag control',
    tables: { prefix: '__mistri_flag_', own: true },
    current: { postgres: 1 },
    read: marked({ postgres: { table: 'flag_binding' } }),
    upgrades: {},
  },
  {
    id: 'analytics',
    title: 'behavior events and sink positions',
    tables: { prefix: '__mistri_analytics_' },
    current: both(1),
    read: marked({ sqlite: { table: '__mistri_analytics_meta' }, postgres: { table: 'analytics_meta' } }),
    upgrades: {},
  },
  {
    id: 'experiments',
    title: 'experiment evidence',
    tables: { prefix: '__mistri_experiment_', own: true },
    current: { postgres: 1 },
    read: marked({ postgres: { table: 'experiment_binding' } }),
    upgrades: {},
  },
  {
    /* One row that moves with every DDL (adapters/postgresSchemaEpoch.ts). It keeps no version: a start that finds
       it reads the epoch, and one that does not reads the catalog, only slower. */
    id: 'schema-epoch',
    title: "PostgreSQL's schema epoch",
    tables: { prefix: '__mistri_schema_epoch' },
    current: {},
    read: async () => null,
    upgrades: {},
    provision: {
      postgres: async (url) => (await import('@mistriwork/engine/adapters/postgresSchemaEpoch.js')).provisionPostgresSchemaEpoch(url),
    },
  },
]);

/** The store the list names `id`. */
export function storeDef(id: string): StoreDef {
  const def = STORES.find((each) => each.id === id);
  if (!def) throw new TypeError(`No store is called "${id}".`);
  return def;
}

/* ---------- status ---------- */

export interface StoreStatus {
  readonly id: string;
  readonly title: string;
  /** What the database holds: null when it holds none of this store. */
  readonly found: number | null;
  readonly current: number;
  /** The `from` of each step still to run, in order. */
  readonly pending: readonly number[];
  /** Why the store cannot be read or brought forward; nothing was changed. */
  readonly refused?: string;
}

const upToDate = (status: StoreStatus) => status.found !== null && !status.pending.length && !status.refused;

/** One line per store this dialect can hold, in registry order. */
export async function storeStatuses(db: MigrationDb, layouts: readonly StoreDef[] = STORES): Promise<StoreStatus[]> {
  const statuses: StoreStatus[] = [];
  for (const layout of layouts) {
    const current = layout.current[db.dialect];
    if (current === undefined) continue;
    const base = { id: layout.id, title: layout.title, current };
    let found: number | null;
    try {
      found = await layout.read(db);
    } catch (error) {
      statuses.push({ ...base, found: null, pending: [], refused: `its version cannot be read: ${(error as Error).message}` });
      continue;
    }
    if (found === null) {
      statuses.push({ ...base, found, pending: [] });
      continue;
    }
    if (found > current) {
      statuses.push({ ...base, found, pending: [], refused: `version ${found} is newer than this mistri's ${current}` });
      continue;
    }
    const pending: number[] = [];
    let refused: string | undefined;
    for (let from = found; from < current; from++) {
      if (!layout.upgrades[db.dialect]?.[from]) {
        refused = `no upgrade from version ${from}: it is refused, not altered`;
        break;
      }
      pending.push(from);
    }
    statuses.push({ ...base, found, pending, ...(refused ? { refused } : {}) });
  }
  return statuses;
}

export { upToDate as storeIsCurrent };

/* ---------- up ---------- */

interface StoreApplied {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly says: string;
}

const lockOf = (id: string) => createHash('sha256').update(`mistri.store.${id}`).digest().readBigInt64BE().toString();

/* A tenant App's stores are provisioned, cloned and imported under the server-wide maintenance lock
   (postgresCommandJournalSchema.ts). A step on one of them takes that lock too, after the store's own and never
   before it, so an upgrade and a provisioning or a `mistri tenant` transaction exclude each other. SQLite's
   BEGIN IMMEDIATE already is the one writer. */
const isTenantStore = (id: string) => id.startsWith('tenant-');

async function inTransaction(db: MigrationDb, id: string, work: () => Promise<void>): Promise<void> {
  await db.run(db.dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
  try {
    if (db.dialect === 'postgres') {
      await db.run('SELECT pg_advisory_xact_lock(?::bigint)', [lockOf(id)]);
      if (isTenantStore(id)) {
        const { MIGRATION_LOCK } = await import('../adapters/commands/postgresCommandJournalSchema.js');
        await db.run('SELECT pg_advisory_xact_lock(?::bigint)', [MIGRATION_LOCK]);
      }
    }
    await work();
    await db.run('COMMIT');
  } catch (error) {
    await db.run('ROLLBACK').catch(() => {
      /* Keep the step's own failure. */
    });
    throw error;
  }
}

/* A step with a connection of its own runs under the same lock, held by the
   runner's connection outside any transaction: a session lock, so the
   runner holds no table lock the step's own transaction could wait on, and
   two operators still never run one store's step at once. */
async function underLock(db: MigrationDb, id: string, work: () => Promise<void>): Promise<void> {
  if (db.dialect !== 'postgres') return work();
  /* A session lock behind a transaction-mode pooler is held by whichever
     server connection ran it, for the pooler's next client, and its unlock
     may run on another. */
  if (postgresPoolDefaults().pooler === 'transaction')
    throw new Error(
      'Store upgrades hold a session lock, which a transaction-mode pooler does not keep; run them on a URL that reaches PostgreSQL directly or through a session-mode pool.',
    );
  await db.run('SELECT pg_advisory_lock(?::bigint)', [lockOf(id)]);
  try {
    await work();
  } finally {
    await db.run('SELECT pg_advisory_unlock(?::bigint)', [lockOf(id)]).catch(() => {
      /* Ends with the connection. */
    });
  }
}

/**
 * Apply every pending step of every store the database holds, store by store.
 * A failed step rolls back and stops that store; the others still run. A
 * store with no step from its version is reported refused and left as it is.
 * `layouts` is the registry, which only a test replaces (to prove a step against the real runtime).
 */
export async function upgradeStores(
  db: MigrationDb,
  url: string,
  layouts: readonly StoreDef[] = STORES,
): Promise<{
  applied: StoreApplied[];
  failed: Array<{ id: string; from: number; message: string }>;
  refused: Array<{ id: string; message: string }>;
}> {
  const applied: StoreApplied[] = [],
    failed: Array<{ id: string; from: number; message: string }> = [],
    refused: Array<{ id: string; message: string }> = [];
  for (const status of await storeStatuses(db, layouts)) {
    if (status.refused) {
      refused.push({ id: status.id, message: status.refused });
      continue;
    }
    const layout = layouts.find((each) => each.id === status.id)!;
    for (const from of status.pending) {
      const step = layout.upgrades[db.dialect]![from];
      try {
        const run = async (): Promise<boolean> => {
          // Another operator may have taken this step between the status and the lock.
          if ((await layout.read(db)) !== from) return false;
          await step.run({ db, url });
          const now = await layout.read(db);
          if (now !== from + 1) throw new StoreRefused(`the store reads version ${now} after the step, not ${from + 1}`);
          return true;
        };
        let ran = false;
        if (step.own)
          await underLock(db, layout.id, async () => {
            ran = await run();
          });
        else
          await inTransaction(db, layout.id, async () => {
            ran = await run();
          });
        if (ran) applied.push({ id: layout.id, from, to: from + 1, says: step.says });
      } catch (error) {
        failed.push({ id: layout.id, from, message: (error as Error).message });
        break;
      }
    }
  }
  return { applied, failed, refused };
}
