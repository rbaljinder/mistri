/**
 * What the store-layout fixtures and their test share (test/store-upgrades.test.ts,
 * scripts/store-layouts.mjs): how each store is provisioned on each engine
 * with a test binding, a normalized reading of a database's layout, and the
 * fixture files themselves.
 *
 * A fixture is the SQL of a database holding one store at one version: its
 * DDL and the rows that mark it (the version, the binding). A store that
 * stands on another (an event delivery store needs the journal and the event
 * store; API tokens need the accounts) includes what it stands on, because
 * that is what its provisioning leaves. `test/fixtures/store-layouts/<store>/<engine>/v<N>.sql`
 * for the version this build expects is written by `node --import tsx
 * scripts/store-layouts.mjs --write` and then kept: a fixture is a record of
 * what a build left, so it is never regenerated.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { openMigrationDb, type MigrationDb } from '../../packages/engine/src/server/migrate/database.js';
import { STORES } from '../../packages/mistri/src/server/storeLayouts.js';
import { pgClient, uuidPostgresDatabase } from './tenantDialects.js';
import { foldConstraint } from '../../packages/mistri/src/adapters/commands/postgresRelations.js';

export type Engine = 'sqlite' | 'postgres';
export const ENGINES: readonly Engine[] = ['sqlite', 'postgres'];
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'store-layouts');
export const LIVE = process.env.TABLEWALK_TEST_PG;

/** A database one case owns, empty. */
export interface Scratch {
  readonly url: string;
  drop(): Promise<void>;
}
export async function scratch(engine: Engine, label: string): Promise<Scratch> {
  if (engine === 'postgres') {
    const database = await uuidPostgresDatabase(label.replaceAll('-', '_').slice(0, 20));
    return { url: database.url, drop: database.drop };
  }
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-layout-'));
  const path = join(directory, 'store.db');
  new DatabaseSync(path).close();
  return {
    url: path,
    drop: async () => {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/* ---------- provisioning, per store and engine ---------- */

export const tenant = { appId: 'layout', source: { id: 'business', connection: 'main' }, storeId: 'layout-tenants' } as const;
export const eventSource = { appId: 'layout', storeId: 'layout-events', sourceId: 'business' } as const;
export const delivery = {
  source: eventSource,
  serviceId: 'layout-service',
  destinationId: 'layout-destination',
  routes: [{ scope: 'app' as const, commandId: 'assign', commandVersion: 1, manifest: [{ name: 'layout.event', version: 1 }] }],
  limits: { maxAttempts: 3, leaseMs: 100, timeoutMs: 20, backoffMs: 10, maxBackoffMs: 20, maxRetained: 64, scanBatch: 8 },
};
export const tokenStore = '36c77f92-cf69-412d-ade3-3971490fb83a';
export const auditKey = () =>
  import('../../packages/mistri/src/server/tenant/tenantSupportAuditContract.js').then((m) =>
    m.supportAuditKey('layout-fixture-audit-key-of-at-least-32-bytes'),
  );
export const suite = { suiteId: 'layout-suite', deploymentId: 'layout-deployment' };

/** Better Auth creates its SQLite tables itself, on first start; the runtime it starts also reads the store. */
export async function sqliteAuthRuntime(path: string) {
  const { createAppAuth } = await import('../../packages/mistri/src/server/auth/auth.js');
  const { parseAppConfig } = await import('../../packages/mistri/src/shared/app.js');
  const names = ['BETTER_AUTH_SECRET', 'MISTRI_AUTH_ADMIN_EMAIL', 'MISTRI_AUTH_ADMIN_PASSWORD'] as const;
  const prior = names.map((name) => [name, process.env[name]] as const);
  process.env.BETTER_AUTH_SECRET = 'synthetic-layout-fixture-secret-at-least-thirty-two-characters';
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
  try {
    const directory = dirname(path);
    const loaded = {
      path: join(directory, 'app.ts'),
      dir: directory,
      pages: [],
      sources: {},
      app: parseAppConfig(
        {
          id: 'layout',
          name: 'Layout',
          auth: { store: path, signUp: 'open' },
          resources: { item: {} },
          views: { items: { kind: 'list', from: 'item' } },
          home: 'items',
        },
        'fixture',
      ),
    };
    return await createAppAuth(loaded, { baseURL: 'http://127.0.0.1:4799', trustedOrigins: ['http://127.0.0.1:4799'] });
  } finally {
    for (const [name, value] of prior) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function sqliteAuth(path: string): Promise<void> {
  (await sqliteAuthRuntime(path)).close();
}

type Provision = (where: string) => Promise<void>;
type Provisioners = Readonly<Partial<Record<Engine, Provision>>>;

/** Each store's current layout, on a database that holds nothing yet. */
export const PROVISION: Readonly<Record<string, Provisioners>> = {
  auth: {
    sqlite: sqliteAuth,
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/auth/postgresAuthStore.js')).migratePostgresAuthStore(url);
    },
  },
  'api-tokens': {
    sqlite: async (path) => {
      await sqliteAuth(path);
      await (
        await import('../../packages/mistri/src/server/auth/provisionSqliteApiTokenStore.js')
      ).provisionSqliteApiTokenStore(path, { appId: 'layout', storeId: tokenStore, exclusions: [] });
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/auth/postgresAuthStore.js')).migratePostgresAuthStore(url);
      await (
        await import('../../packages/mistri/src/server/auth/provisionPostgresApiTokenStore.js')
      ).provisionPostgresApiTokenStore(url, { appId: 'layout', storeId: tokenStore, excludeConnections: [] });
    },
  },
  'record-history': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/history/sqliteRecordHistory.js')).provisionSqliteRecordHistory(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/history/postgresRecordHistory.js')).provisionPostgresRecordHistory(url);
    },
  },
  'live-change': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/live/sqliteLiveChange.js')).provisionSqliteLiveChange(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/live/postgresLiveChange.js')).provisionPostgresLiveChange(url);
    },
  },
  inbox: {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/inbox/sqliteInbox.js')).provisionSqliteInbox(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/inbox/postgresInbox.js')).provisionPostgresInbox(url);
    },
  },
  branding: {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/branding/sqliteBranding.js')).provisionSqliteBranding(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/branding/postgresBranding.js')).provisionPostgresBranding(url);
    },
  },
  mail: {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/mail/mailStore.js')).provisionSqliteMailStore(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/mail/mailStore.js')).migratePostgresMailStore(url);
    },
  },
  integrations: {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/integrations/integrationStore.js')).provisionSqliteIntegrations(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/integrations/integrationStore.js')).provisionPostgresIntegrations(url);
    },
  },
  'tenant-switch': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/switch/sqliteTenantSwitch.js')).provisionSqliteTenantSwitchAt(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/switch/postgresTenantSwitch.js')).provisionPostgresTenantSwitchAt(url);
    },
  },
  assistant: {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/assistant/sqliteAssistant.js')).provisionSqliteAssistant(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/assistant/postgresAssistant.js')).provisionPostgresAssistant(url);
    },
  },
  decisions: {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/decide/sqliteDecisions.js')).provisionSqliteDecisions(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/decide/postgresDecisions.js')).provisionPostgresDecisions(url);
    },
  },
  'command-journal': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/commands/commandJournal.js')).migrateSqliteCommandJournal(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/commands/postgresCommandJournal.js')).migratePostgresCommandJournal(url);
    },
  },
  'command-sequences': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/commands/commandJournal.js')).migrateSqliteCommandJournal(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/commands/postgresCommandJournal.js')).migratePostgresCommandJournal(url);
    },
  },
  'public-placement': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/commands/publicPlacementSchema.js')).provisionSqlitePublicPlacementJournal(path);
    },
    postgres: async (url) => {
      await (
        await import('../../packages/mistri/src/adapters/commands/publicPlacementSchema.js')
      ).provisionPostgresPublicPlacementJournal(url);
    },
  },
  'command-events': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/commands/commandJournal.js')).migrateSqliteCommandJournal(path);
      (await import('../../packages/mistri/src/adapters/events/commandEventSchema.js')).provisionSqliteCommandEventStore(path, eventSource);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/commands/postgresCommandJournal.js')).migratePostgresCommandJournal(url);
      await (
        await import('../../packages/mistri/src/adapters/events/postgresCommandEventStore.js')
      ).provisionPostgresCommandEventStore(url, eventSource);
    },
  },
  'event-delivery': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/commands/commandJournal.js')).migrateSqliteCommandJournal(path);
      (await import('../../packages/mistri/src/adapters/events/commandEventSchema.js')).provisionSqliteCommandEventStore(path, eventSource);
      (await import('../../packages/mistri/src/adapters/events/eventDeliverySchema.js')).provisionSqliteEventDeliveryStore(path, delivery, {
        stopped: true,
      });
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/adapters/commands/postgresCommandJournal.js')).migratePostgresCommandJournal(url);
      await (
        await import('../../packages/mistri/src/adapters/events/postgresCommandEventStore.js')
      ).provisionPostgresCommandEventStore(url, eventSource);
      await (
        await import('../../packages/mistri/src/adapters/events/postgresEventDeliveryStore.js')
      ).provisionPostgresEventDeliveryStore(url, delivery);
    },
  },
  jobs: {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/jobs/jobStoreSchema.js')).provisionSqliteJobStore(path, { namespace: 'layout' });
    },
    postgres: async (url) => {
      await (
        await import('../../packages/mistri/src/adapters/jobs/postgresJobStore.js')
      ).migratePostgresJobStore(url, { namespace: 'layout' });
    },
  },
  workflows: {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/adapters/workflows/workflowStoreSchema.js')).provisionSqliteWorkflowStore(path);
    },
    // It stands on the App's job store, whose namespace is its owner.
    postgres: async (url) => {
      await (
        await import('../../packages/mistri/src/adapters/jobs/postgresJobStore.js')
      ).migratePostgresJobStore(url, { namespace: 'layout' });
      await (
        await import('../../packages/mistri/src/adapters/workflows/workflowStoreSchema.js')
      ).migratePostgresWorkflowStore(url, 'layout');
    },
  },
  'tenant-store': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/server/tenant/tenantStore.js')).provisionSqliteTenantStore(path, tenant);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/server/tenant/tenantStorePostgres.js')).migratePostgresTenantStore(url, tenant);
    },
  },
  'tenant-administration': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/server/tenant/tenantStore.js')).provisionSqliteTenantStore(path, tenant);
      (await import('../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js')).provisionSqliteTenantAdministrationJournal(
        path,
        tenant,
      );
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/server/tenant/tenantStorePostgres.js')).migratePostgresTenantStore(url, tenant);
      await (
        await import('../../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js')
      ).migratePostgresTenantAdministrationJournal(url, tenant);
    },
  },
  'tenant-invitations': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/server/tenant/tenantStore.js')).provisionSqliteTenantStore(path, tenant);
      (await import('../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js')).provisionSqliteTenantAdministrationJournal(
        path,
        tenant,
      );
      (await import('../../packages/mistri/src/server/tenant/tenantInvitationStore.js')).provisionSqliteTenantInvitations(path, tenant);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/server/tenant/tenantStorePostgres.js')).migratePostgresTenantStore(url, tenant);
      await (
        await import('../../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js')
      ).migratePostgresTenantAdministrationJournal(url, tenant);
      await (
        await import('../../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js')
      ).migratePostgresTenantInvitations(url, tenant);
    },
  },
  'tenant-support-audit': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/server/tenant/tenantStore.js')).provisionSqliteTenantStore(path, tenant);
      (await import('../../packages/mistri/src/server/tenant/tenantSupportAudit.js')).provisionSqliteSupportAudit(
        path,
        tenant,
        await auditKey(),
      );
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/server/tenant/tenantStorePostgres.js')).migratePostgresTenantStore(url, tenant);
      await (
        await import('../../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js')
      ).migratePostgresSupportAudit(url, tenant, await auditKey());
    },
  },
  'tenant-sandboxes': {
    sqlite: async (path) => {
      (await import('../../packages/mistri/src/server/tenant/tenantSandboxStore.js')).provisionSqliteTenantSandboxes(path);
    },
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/server/tenant/tenantSandboxStore.js')).provisionPostgresTenantSandboxes(url);
    },
  },
  // PostgreSQL only: a SQLite file has no catalog digest for a record to vouch for.
  'validation-record': {
    postgres: async (url) => {
      await (
        await import('../../packages/mistri/src/adapters/validation/postgresValidationRecord.js')
      ).provisionPostgresValidationRecordAt(url);
    },
  },
  'suite-grants': {
    sqlite: async (path) => {
      const db = new DatabaseSync(path);
      try {
        (await import('../../packages/mistri/src/server/auth/suiteGrantStore.js')).provisionSuiteGrantStore(db, suite.suiteId);
      } finally {
        db.close();
      }
    },
    postgres: async (url) => {
      const { provisionPostgresSuiteStore } = await import('../../packages/mistri/src/server/auth/suiteStoresPostgres.js');
      await provisionPostgresSuiteStore(url, 'suite_grant', suite.suiteId);
    },
  },
  'suite-preferences': {
    sqlite: async (path) => {
      const db = new DatabaseSync(path);
      try {
        (await import('../../packages/mistri/src/server/auth/suitePreferences.js')).provisionSuitePreferencesStore(db, suite.suiteId);
      } finally {
        db.close();
      }
    },
    postgres: async (url) => {
      const { provisionPostgresSuiteStore } = await import('../../packages/mistri/src/server/auth/suiteStoresPostgres.js');
      await provisionPostgresSuiteStore(url, 'suite_preference', suite.suiteId);
    },
  },
  'suite-authority': {
    sqlite: async (path) => {
      const db = new DatabaseSync(path);
      try {
        (await import('../../packages/mistri/src/server/auth/suiteAuthority.js')).provisionSuiteAuthorityStore(db, suite.suiteId);
      } finally {
        db.close();
      }
    },
    postgres: async (url) => {
      const { provisionPostgresSuiteStore } = await import('../../packages/mistri/src/server/auth/suiteStoresPostgres.js');
      await provisionPostgresSuiteStore(url, 'suite_authority', suite.suiteId);
    },
  },
  flags: {
    postgres: async (url) => {
      await (await import('../../packages/mistri/src/server/flags/storePostgres.js')).provisionPostgresFlagStore({ url, binding: suite });
    },
  },
  analytics: {
    sqlite: async (path) => {
      await (
        await import('../../packages/mistri/src/server/analytics/store.js')
      ).provisionAnalyticsStore({ url: path, binding: { appId: 'layout', deploymentId: suite.deploymentId } });
    },
    postgres: async (url) => {
      await (
        await import('../../packages/mistri/src/server/analytics/store.js')
      ).provisionAnalyticsStore({ url, binding: { appId: 'layout', deploymentId: suite.deploymentId } });
    },
  },
  experiments: {
    postgres: async (url) => {
      await (
        await import('../../packages/mistri/src/server/experiments/storePostgres.js')
      ).provisionPostgresExperimentStore({ url, binding: suite });
    },
  },
};

/* ---------- reading a layout ---------- */

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();
/* A restored database prints an AND group folded where a fresh one nests it; both are folded the way the build's own
   attestation folds them (foldConstraint), and nothing else about the text is forgiven. */
const bare = (text: string) => foldConstraint(squash(text));

/**
 * A database's layout as normalized lines, equal exactly when two databases
 * hold the same tables, columns, constraints, indexes, triggers, functions
 * and rules. Names a database generates for itself (a constraint added with
 * ALTER TABLE) are compared by their definition, not their name.
 */
export async function describeLayout(db: MigrationDb): Promise<string[]> {
  if (db.dialect === 'sqlite') {
    const rows = await db.all<{ type: string; name: string; tbl_name: string; sql: string | null }>(
      `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
    );
    return rows.map((row) => `${row.type} ${row.name} on ${row.tbl_name}: ${squash(row.sql ?? '')}`);
  }
  const lines: string[] = [];
  const schemas = `n.nspname NOT IN ('pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_%'`;
  for (const row of await db.all<{ name: string; acl: string | null }>(
    `SELECT n.nspname AS name, COALESCE(n.nspacl, acldefault('n', n.nspowner))::text AS acl FROM pg_namespace n WHERE ${schemas} ORDER BY 1`,
  ))
    lines.push(`schema ${row.name} acl ${row.acl ?? '-'}`);
  for (const row of await db.all<{ schema: string; name: string; kind: string; oid: number }>(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind, c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE ${schemas} AND c.relkind IN ('r', 'v', 'm', 'S', 'i') ORDER BY 1, 2`,
  )) {
    const at = `${row.schema}.${row.name}`;
    lines.push(`${row.kind === 'i' ? 'index' : 'relation'} ${at}`);
    if (row.kind === 'i') {
      lines.push(`  ${squash((await db.all<{ d: string }>('SELECT pg_get_indexdef(?::oid) AS d', [row.oid]))[0].d)}`);
      continue;
    }
    for (const column of await db.all<{ n: string; t: string; nn: boolean; co: string | null; d: string | null }>(
      `SELECT a.attname AS n, format_type(a.atttypid, a.atttypmod) AS t, a.attnotnull AS nn, co.collname AS co, pg_get_expr(d.adbin, d.adrelid) AS d
       FROM pg_attribute a LEFT JOIN pg_collation co ON co.oid = a.attcollation LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = ?::oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [row.oid],
    )) {
      lines.push(
        `  column ${column.n} ${column.t}${column.nn ? ' not null' : ''}${column.co ? ` collate ${column.co}` : ''}${column.d ? ` default ${column.d}` : ''}`,
      );
    }
    const constraints = (
      await db.all<{ d: string }>('SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conrelid = ?::oid', [row.oid])
    )
      .map((each) => bare(each.d))
      .sort();
    for (const definition of constraints) lines.push(`  constraint ${definition}`);
    for (const trigger of (
      await db.all<{ d: string }>('SELECT pg_get_triggerdef(oid) AS d FROM pg_trigger WHERE tgrelid = ?::oid AND NOT tgisinternal', [
        row.oid,
      ])
    )
      .map((each) => squash(each.d))
      .sort())
      lines.push(`  trigger ${trigger}`);
    for (const rule of (
      await db.all<{ d: string }>(`SELECT pg_get_ruledef(oid) AS d FROM pg_rewrite WHERE ev_class = ?::oid AND rulename <> '_RETURN'`, [
        row.oid,
      ])
    )
      .map((each) => squash(each.d))
      .sort())
      lines.push(`  rule ${rule}`);
  }
  for (const row of await db.all<{ d: string }>(
    `SELECT pg_get_functiondef(p.oid) AS d FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE ${schemas} ORDER BY p.proname`,
  ))
    lines.push(`function ${squash(row.d)}`);
  return lines;
}

export const describeUrl = async (url: string): Promise<string[]> => {
  const db = await openMigrationDb(url, [], false);
  try {
    return await describeLayout(db);
  } finally {
    await db.close();
  }
};

/* ---------- fixtures ---------- */

export interface FixtureFile {
  readonly version: number;
  readonly path: string;
}
export function fixtureFiles(store: string, engine: Engine): FixtureFile[] {
  const directory = join(FIXTURES, store, engine);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .flatMap((name) =>
      /^v(\d+)\.sql$/.exec(name) ? [{ version: Number(/^v(\d+)\.sql$/.exec(name)![1]), path: join(directory, name) }] : [],
    )
    .sort((a, b) => a.version - b.version);
}
export const fixturePath = (store: string, engine: Engine, version: number) => join(FIXTURES, store, engine, `v${version}.sql`);

/** Create the fixture's database: its DDL, then its marker rows. */
export async function applyFixture(engine: Engine, url: string, text: string): Promise<void> {
  if (engine === 'sqlite') {
    const db = new DatabaseSync(url);
    try {
      db.exec(text);
    } finally {
      db.close();
    }
    return;
  }
  const client = await pgClient(url);
  try {
    await client.query(text);
  } finally {
    await client.end();
  }
}

/* ---------- what a store owns ---------- */

/** The stores a fixture holds only because its store stands on them, and which of their objects. The store beneath is
 * held by its own fixtures and version, so a comparison with this store's fixture leaves its objects out of both sides. */
const BENEATH: Readonly<Record<string, { readonly store: string; readonly only?: RegExp }>> = {
  'api-tokens': { store: 'auth' },
  // Provisioning a journal also leaves its sequences, which have a version of their own; the fixture of the journal's
  // store does not change when the sequences' do.
  'command-journal': { store: 'command-sequences', only: /^(\w+\.)?(__mistri_)?sequence_/ },
  'command-events': { store: 'command-sequences', only: /^(\w+\.)?(__mistri_)?sequence_/ },
  'event-delivery': { store: 'command-sequences', only: /^(\w+\.)?(__mistri_)?sequence_/ },
};

/** The tables a fixture creates, as the lines of `describeLayout` name them: bare on SQLite, schema-qualified on PostgreSQL. */
const tablesOf = (text: string, engine: Engine): string[] =>
  [...text.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?(\S+?) \(/gm)].map((match) => {
    const name = match[1].replaceAll('"', '');
    return engine === 'postgres' ? name : name.replace(/^\w+\./, '');
  });

/** `lines` of a layout without the objects `store` only stands on. */
export function withoutBeneath(store: string, engine: Engine, lines: readonly string[]): string[] {
  const beneath = BENEATH[store];
  const current = beneath && currentOf(beneath.store, engine);
  const file = current === undefined ? undefined : fixtureFiles(beneath!.store, engine).find((each) => each.version === current);
  if (!beneath || !file) return [...lines];
  const tables = new Set(tablesOf(readFileSync(file.path, 'utf8'), engine).filter((name) => !beneath.only || beneath.only.test(name)));
  const kept: string[] = [];
  let dropping = false;
  for (const [index, line] of lines.entries()) {
    if (engine === 'sqlite') {
      const on = /^\w+ \S+ on (\S+):/.exec(line);
      if (!on || !tables.has(on[1])) kept.push(line);
      continue;
    }
    if (!line.startsWith(' ')) {
      const header = /^(relation|index) (\S+)/.exec(line);
      // An index is listed under its own name; its definition, on the next line, names the table (quoted when it must be).
      const table = header?.[1] === 'index' ? /\bON (\S+)/.exec(lines[index + 1] ?? '')?.[1]?.replaceAll('"', '') : header?.[2];
      dropping = table !== undefined && tables.has(table);
    }
    if (!dropping) kept.push(line);
  }
  return kept;
}

const pgDump = () => process.env.PG_DUMP ?? 'pg_dump';
const psql = () => process.env.PSQL ?? (process.env.PG_DUMP ? join(dirname(process.env.PG_DUMP), 'psql') : 'psql');

/** A database as an operator restores a backup: a plain `pg_dump` of `from`, played into the empty `to` by `psql`. */
export async function restoreWithPsql(from: string, to: string): Promise<void> {
  const { spawnSync } = await import('node:child_process');
  const dump = spawnSync(pgDump(), ['--no-owner', '--dbname', from], { encoding: 'utf8', maxBuffer: 1 << 28 });
  if (dump.status !== 0) throw new Error(`pg_dump failed (set PG_DUMP to its path): ${dump.stderr.slice(0, 400)}`);
  const played = spawnSync(psql(), ['--quiet', '--set', 'ON_ERROR_STOP=1', '--dbname', to], {
    input: dump.stdout,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  });
  if (played.status !== 0) throw new Error(`psql failed (set PSQL to its path): ${played.stderr.slice(0, 400)}`);
}

/** The SQL of a database as it stands: what `--write` keeps. */
export async function dumpFixture(engine: Engine, url: string, header: string): Promise<string> {
  const head = `-- ${header}\n`;
  if (engine === 'sqlite') {
    const db = new DatabaseSync(url);
    try {
      const objects = db
        .prepare(`SELECT type, name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`)
        .all() as Array<{ type: string; name: string; sql: string }>;
      const out = objects.map((object) => `${object.sql};`);
      for (const object of objects.filter((each) => each.type === 'table')) {
        const columns = (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(object.name) as Array<{ name: string }>).map(
          (column) => column.name,
        );
        const rows = db
          .prepare(`SELECT ${columns.map((column) => `quote("${column}") AS "${column}"`).join(', ')} FROM "${object.name}"`)
          .all() as Array<Record<string, string>>;
        for (const row of rows)
          out.push(
            `INSERT INTO "${object.name}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map((column) => row[column]).join(', ')});`,
          );
      }
      return `${head}${out.join('\n')}\n`;
    } finally {
      db.close();
    }
  }
  const { spawnSync } = await import('node:child_process');
  const done = spawnSync(pgDump(), ['--no-owner', '--column-inserts', '--dbname', url], { encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`pg_dump failed (set PG_DUMP to its path): ${done.stderr.slice(0, 400)}`);
  // psql meta-commands and comments are for a terminal; a client sends the SQL alone.
  const sql = done.stdout
    .split('\n')
    .filter((line) => !line.startsWith('\\') && !line.startsWith('--') && line.trim())
    .join('\n');
  return `${head}${sql}\n`;
}

/** What a version's header says, so a reader knows what the file holds. */
export const headerOf = (store: string, engine: Engine, version: number) =>
  `mistri store layout: ${store}, ${engine}, version ${version}. Generated by scripts/store-layouts.mjs; never edit by hand.`;

/** The version a fresh provisioning is expected to leave: the registry's. */
export const currentOf = (store: string, engine: Engine): number | undefined =>
  STORES.find((layout) => layout.id === store)?.current[engine];
