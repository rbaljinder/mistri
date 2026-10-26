/**
 * Ignition's own databases for a suite that needs a real deployment of the
 * sample: the lending database on SQLite or on a live PostgreSQL database this
 * fixture owns (named by a UUID and dropped with the test), and the applicant
 * directory beside it as the platform-only source.
 *
 * Both engines are seeded from `examples/databases/ignition/schema.mjs` — the
 * same DDL the public seed applies on PostgreSQL, and the SQLite mirror of it
 * that `ignitionTenantFixture.ts` already holds — with that module's own §5.17
 * rows through `lendingRows()`. So the sample's schema and its fixture rows have
 * one definition, and a suite cannot drift from what an operator would deploy.
 *
 * What it provisions, in the order the public steps require: the tenant store,
 * the administration journal, invitations, the command journal, and — when a
 * caller asks — the command event store, the job stores and the support audit.
 * Nothing here serves: no HTTP host, no tenant host, no policy. A caller opens
 * those on `source` with the App and policy it is testing.
 *
 * It creates no accounts, and needs none. A membership names an account id and
 * nothing dereferences it, so the realm, the four dealerships and their people
 * are granted against synthetic ids (`accountOf`) with no authentication store
 * in play at all. That keeps a suite to one database per engine and keeps it out
 * of the native auth store, which is a per-machine location a test has no
 * business writing to.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { provisionStores, type ProvisionStoresOptions, type StoresApp, type StoresProvisioned } from '@mistriwork/mistri/maintenance';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { provisionSqliteTenantAdministrationJournal } from '../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { migratePostgresTenantAdministrationJournal } from '../../packages/mistri/src/server/tenant/tenantAdministrationJournalPostgres.js';
import { provisionSqliteTenantInvitations } from '../../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import { migratePostgresTenantInvitations } from '../../packages/mistri/src/server/tenant/tenantInvitationStorePostgres.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../../packages/mistri/src/server/tenant/tenantStore.js';
import {
  createPostgresTenantAdministration,
  migratePostgresTenantStore,
} from '../../packages/mistri/src/server/tenant/tenantStorePostgres.js';
import { provisionSqliteSupportAudit } from '../../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import { SUPPORT_AUDIT_KEY_VARIABLE, supportAuditKey } from '../../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { migratePostgresSupportAudit } from '../../packages/mistri/src/server/tenant/tenantSupportAuditPostgres.js';
import {
  APPLICANTS_INSERT_ORDER,
  APPLICANTS_SCHEMA,
  applicantRows,
  DEALER_PEOPLE,
  DEALERS,
  LENDER_STAFF,
  LENDING_INDEXES,
  LENDING_INSERT_ORDER,
  LENDING_SCHEMA,
  lendingRows,
} from '../../examples/databases/ignition/schema.mjs';
import { SQLITE_LENDING_SCHEMA } from './ignitionTenantFixture.js';
import { pgClient, uuidPostgresDatabase, type Control } from './tenantDialects.js';
import { postgresRuntimeSql } from './runtimeSql.js';

/** The App, its source and the tenant policy's store, as Ignition declares them. */
export const BINDING = { appId: 'ignition', source: { id: 'lending', connection: 'loans' }, storeId: 'ignition-tenants' };
/** The applicants source, as the App declares it. */
export const APPLICANTS_SOURCE = { id: 'applicants', connection: 'applicants' };
/** This fixture's own audit secret: synthetic, and named here so a run that
 * provisions the support audit and a run that attests it use one key. */
export const SUPPORT_SECRET = 'ignition-lending-fixture-support-audit-secret-32';
/**
 * How long every membership this fixture grants stays valid, from real time.
 *
 * Wider than a suite needs, on purpose. A membership is admitted against the
 * *deployment's* clock (tenantMembership.ts), and Ignition's own dates span more
 * than an hour: a conversion sets the lender's deadline seven days out and the
 * review clock falls due the day after, so a suite that drives those dates runs
 * a clock days from real time in one direction or the other. A window narrower
 * than that horizon refuses every command with `temporarily_unavailable`, which
 * says nothing about what was actually wrong. Ninety days covers the sample's
 * longest journey with room to spare, and a leaked grant is still no grant: the
 * accounts are synthetic and the databases are the run's own.
 */
const LIFETIME = 90 * 86_400_000;

export type IgnitionDialect = 'sqlite' | 'postgres';
type Row = Readonly<Record<string, unknown>>;
type Seeded = Readonly<Record<string, readonly Row[]>>;

/** The synthetic account id for one of the sample's people, by email. Nothing
 * dereferences it: a membership records an account id, and this fixture opens no
 * authentication store. */
export const accountOf = (email: string) => `account-${email.split('@')[0].replaceAll('.', '-')}`;

/**
 * The applicant directory on SQLite: `APPLICANTS_SCHEMA` translated, the same
 * way the lending mirror is. Only the types change — `text` is `TEXT`, a
 * `numeric(n, 2)` amount is `REAL`, a `boolean` is 0/1 — and the opaque text
 * keys, the CHECKs and the three references to `applicant` are carried as they
 * stand, because a platform-only source's catalog is what the suite reads.
 */
const SQLITE_APPLICANTS_SCHEMA = `PRAGMA foreign_keys=ON;
CREATE TABLE applicant (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  preferred_name TEXT NOT NULL,
  created_on DATE NOT NULL,
  verification_status TEXT NOT NULL CHECK (verification_status IN ('pending', 'verified', 'needs_review'))
);
CREATE TABLE residence (
  id TEXT PRIMARY KEY NOT NULL,
  applicant_id TEXT NOT NULL REFERENCES applicant(id),
  name TEXT NOT NULL,
  address_line TEXT NOT NULL,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  tenure TEXT NOT NULL CHECK (tenure IN ('rent', 'own', 'family')),
  months_at_address INTEGER NOT NULL CHECK (months_at_address >= 0),
  monthly_housing_cost REAL NOT NULL CHECK (monthly_housing_cost >= 0),
  current BOOLEAN NOT NULL
);
CREATE TABLE contact (
  id TEXT PRIMARY KEY NOT NULL,
  applicant_id TEXT NOT NULL REFERENCES applicant(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'phone')),
  value TEXT NOT NULL,
  verified BOOLEAN NOT NULL,
  preferred BOOLEAN NOT NULL,
  UNIQUE (applicant_id, kind)
);
CREATE TABLE employment (
  id TEXT PRIMARY KEY NOT NULL,
  applicant_id TEXT NOT NULL REFERENCES applicant(id),
  name TEXT NOT NULL,
  employer TEXT NOT NULL,
  job_title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('employed', 'self_employed', 'contract')),
  months_employed INTEGER NOT NULL CHECK (months_employed >= 0),
  stated_annual_income REAL NOT NULL CHECK (stated_annual_income >= 0),
  verification_status TEXT NOT NULL CHECK (verification_status IN ('pending', 'verified', 'needs_review'))
);`;

/** What a caller wants provisioned beyond the store, journal and invitations. */
export interface IgnitionLendingOptions {
  /** The tenant event store, for a registry whose commands emit facts. */
  readonly events?: boolean;
  /** The event store, one delivery destination per job, and the job store: the
   * registry holding at least every command its jobs start on and run, and the
   * jobs module, exactly as the public provisioning step takes them.
   *
   * Provisioned bound to the tenant store, deliberately: a tenant App's stores
   * are bound to its store id and source as well as its App id, so the
   * provisioning takes the binding as `app.tenant`; without it, the stores
   * provisioned are the ones a single-tenant App's job host attests, and this
   * deployment's enrollment would refuse them. */
  readonly jobs?: Readonly<{
    commands: NonNullable<StoresApp['commands']>;
    jobs: NonNullable<ProvisionStoresOptions['jobs']>;
  }>;
  /** The support audit store. Provisioned unless this says `false`: Ignition's
   * policy declares `support`, so an enrollment attests it either way. */
  readonly support?: boolean;
}

export interface IgnitionLending {
  readonly dialect: IgnitionDialect;
  /** What `createTenantEnrollment` takes as the App's own source. */
  readonly source: Readonly<{ id: string; connection: string; existingPath?: string; url?: string }>;
  /** Its one platform-only source, in the App's order. */
  readonly platformSources: readonly Readonly<{ id: string; connection: string; existingPath?: string; url?: string }>[];
  /** Where the command, event, delivery and job stores live. */
  readonly target: Readonly<{ sqlite: string }> | Readonly<{ postgres: string }>;
  /** The §5.17 rows this fixture seeded, by table, as schema.mjs built them. */
  readonly seeded: Seeded;
  /** Every membership's expiry, so a caller comparing them compares one number. */
  readonly validUntil: number;
  /** Read the lending database on the control connection. `?` placeholders. */
  rows(sql: string, params?: readonly unknown[]): Promise<Record<string, unknown>[]>;
  /** Write on the control connection: fixture DDL and outside edits. */
  exec(sql: string, params?: readonly unknown[]): Promise<void>;
  /** One store transaction, as a maintenance step runs one. */
  maintenance(run: (admin: TenantStoreAdministration) => Promise<void>): Promise<void>;
}

/** `?` → `$n`, for fixture SQL that never puts a question mark in a literal. */
const numbered = (sql: string) => {
  let n = 0;
  return sql.replace(/\?/g, () => `$${++n}`);
};

export async function openIgnitionLending(
  t: TestContext,
  dialect: IgnitionDialect,
  options: IgnitionLendingOptions = {},
): Promise<IgnitionLending> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-ignition-lending-'));
  const seeded = lendingRows() as unknown as Seeded;
  const applicants = applicantRows(seeded.loan_application.length) as unknown as Seeded;
  /* Ignition's policy always declares `support`, and every enrollment attests
     the audit store under the key the *runtime* derives — `supportAuditKey()`
     with no argument, which reads MISTRI_AUDIT_KEY. So the fixture provisions
     that store under this secret and puts the same secret in the environment for
     the test's lifetime: a fingerprint mismatch, or a missing variable, denies
     the enrollment with nothing to say why. Restored after, so one suite cannot
     leak a key into the next. */
  const key = supportAuditKey(SUPPORT_SECRET);
  const previousKey = process.env[SUPPORT_AUDIT_KEY_VARIABLE];
  process.env[SUPPORT_AUDIT_KEY_VARIABLE] = SUPPORT_SECRET;
  t.after(() => {
    if (previousKey === undefined) delete process.env[SUPPORT_AUDIT_KEY_VARIABLE];
    else process.env[SUPPORT_AUDIT_KEY_VARIABLE] = previousKey;
  });

  let db: DatabaseSync | undefined, applicantDb: DatabaseSync | undefined;
  let control: Control | undefined, applicantControl: Control | undefined;
  let owned: { url: string; drop: () => Promise<void> } | undefined;
  let ownedApplicants: { url: string; drop: () => Promise<void> } | undefined;
  t.after(async () => {
    /* Raised after the cleanup block rather than inside it: a throw from a
       `finally` would discard whatever the body was already failing with. */
    let refused: PromiseRejectedResult | undefined;
    try {
      db?.close();
      applicantDb?.close();
    } finally {
      await control?.end().catch(() => {});
      await applicantControl?.end().catch(() => {});
      /* Both drops are attempted even when one throws. They are two separate
         databases, and awaiting them in sequence meant a failed lending drop
         returned from the hook before the applicants database was dropped at
         all — one leak became two, and the second had no failure of its own to
         explain it. The rejection is still raised once both have been tried, so
         a drop that cannot happen is a red test rather than a quiet leak. */
      const drops = await Promise.allSettled([owned?.drop(), ownedApplicants?.drop()]);
      rmSync(directory, { recursive: true, force: true });
      refused = drops.find((drop) => drop.status === 'rejected');
    }
    if (refused) throw refused.reason;
  });

  /* Each engine: the two databases, their schemas, and the §5.17 rows in
     dependency order — a parent before anything that points at it, or an
     ownership key refuses the row. */
  let lending: IgnitionLending['source'], outside: IgnitionLending['source'];
  let target: IgnitionLending['target'];
  if (dialect === 'sqlite') {
    const path = join(directory, 'loans.db'),
      applicantPath = join(directory, 'applicants.db');
    db = new DatabaseSync(path);
    db.exec(SQLITE_LENDING_SCHEMA);
    sqliteSeed(db, seeded, LENDING_INSERT_ORDER);
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('The seeded lending file breaks its own keys.');
    applicantDb = new DatabaseSync(applicantPath);
    applicantDb.exec(SQLITE_APPLICANTS_SCHEMA);
    sqliteSeed(applicantDb, applicants, APPLICANTS_INSERT_ORDER);
    applicantDb.close();
    applicantDb = undefined;

    provisionSqliteTenantStore(path, BINDING);
    provisionSqliteTenantAdministrationJournal(path, BINDING);
    provisionSqliteTenantInvitations(path, BINDING);
    migrateSqliteCommandJournal(path);
    if (options.events) await provisionStores({ sqlite: path }, { app: { tenant: BINDING } });
    if (options.jobs)
      assertProvisioned(
        await provisionStores({ sqlite: path }, { app: { tenant: BINDING, commands: options.jobs.commands }, jobs: options.jobs.jobs }),
      );
    if (options.support !== false) provisionSqliteSupportAudit(path, BINDING, key);

    lending = { ...BINDING.source, existingPath: path };
    outside = { ...APPLICANTS_SOURCE, existingPath: applicantPath };
    target = { sqlite: path };
  } else {
    owned = await uuidPostgresDatabase('ign_lending');
    ownedApplicants = await uuidPostgresDatabase('ign_applicants');
    control = await pgClient(owned.url);
    applicantControl = await pgClient(ownedApplicants.url);
    await control.query(LENDING_SCHEMA);
    await control.query(LENDING_INDEXES);
    await postgresSeed(control, seeded, LENDING_INSERT_ORDER);
    await applicantControl.query(APPLICANTS_SCHEMA);
    await postgresSeed(applicantControl, applicants, APPLICANTS_INSERT_ORDER);

    await migratePostgresTenantStore(owned.url, BINDING);
    await migratePostgresTenantAdministrationJournal(owned.url, BINDING);
    await migratePostgresTenantInvitations(owned.url, BINDING);
    await migratePostgresCommandJournal(owned.url);
    if (options.events) await provisionStores({ postgres: owned.url }, { app: { tenant: BINDING } });
    if (options.jobs)
      assertProvisioned(
        await provisionStores(
          { postgres: owned.url },
          { app: { tenant: BINDING, commands: options.jobs.commands }, jobs: options.jobs.jobs },
        ),
      );
    if (options.support !== false) await migratePostgresSupportAudit(owned.url, BINDING, key);

    lending = { ...BINDING.source, url: owned.url };
    outside = { ...APPLICANTS_SOURCE, url: ownedApplicants.url };
    target = { postgres: owned.url };
  }

  const rows = async (sql: string, params: readonly unknown[] = []): Promise<Record<string, unknown>[]> =>
    dialect === 'sqlite'
      ? db!
          .prepare(sql)
          .all(...(params as never[]))
          .map((row) => ({ ...row }))
      : (await control!.query(postgresRuntimeSql(params.length ? numbered(sql) : sql), [...params])).rows.map((row) => ({ ...row }));
  const exec = async (sql: string, params: readonly unknown[] = []): Promise<void> => {
    if (dialect === 'sqlite') {
      db!.prepare(sql).run(...(params as never[]));
      return;
    }
    await control!.query(postgresRuntimeSql(params.length ? numbered(sql) : sql), [...params]);
  };
  /** One store transaction on the fixture's own handle, as maintenance runs one. */
  const maintenance = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
    const operations = new TransactionOperations();
    if (dialect === 'sqlite') {
      db!.exec('BEGIN IMMEDIATE');
      try {
        await run(createSqliteTenantAdministration(db!, operations, BINDING));
        await operations.finish();
        db!.exec('COMMIT');
      } catch (error) {
        await operations.finish().catch(() => {});
        if (db!.isTransaction) db!.exec('ROLLBACK');
        throw error;
      }
      return;
    }
    await control!.query('BEGIN');
    try {
      await run(createPostgresTenantAdministration(control!, operations, BINDING));
      await operations.finish();
      await control!.query('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      await control!.query('ROLLBACK').catch(() => {});
      throw error;
    }
  };

  /* The realm above the dealerships first: without an active `@platform` row no
     platform membership may be granted and no public submission is accepted.
     Then the four dealerships — parkside suspended, as the sample holds it — and
     each person's memberships, one of them in two dealerships. */
  const validUntil = Date.now() + LIFETIME;
  await maintenance(async (admin) => {
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    for (const dealer of DEALERS) {
      await admin.putTenant({ tenantId: dealer.id, status: 'active', expectedVersion: null });
      /* A tenant starts active, so a suspended dealership is a second step
         against the version the first one left. These steps return nothing —
         there is no version to read back — and a created row is at 1. */
      if (dealer.status !== 'active') {
        await admin.putTenant({ tenantId: dealer.id, status: 'suspended', expectedVersion: '1' });
      }
    }
    for (const person of DEALER_PEOPLE) {
      for (const membership of person.memberships) {
        await admin.putMembership({
          tenantId: membership.tenant,
          accountId: accountOf(person.email),
          membershipId: `${membership.tenant}:${accountOf(person.email)}`,
          roles: [membership.role],
          status: 'active',
          validUntil,
          expectedVersion: null,
        });
      }
    }
    for (const staff of LENDER_STAFF) {
      await admin.putPlatformMembership({
        membershipId: `platform:${accountOf(staff.email)}`,
        accountId: accountOf(staff.email),
        roles: [staff.role],
        status: 'active',
        validUntil,
        expectedVersion: null,
      });
    }
  });

  // A platform command resolves its author through `lender_staff.account_id`, so
  // the lender's people are only staff once their accounts are named on the row.
  for (const staff of LENDER_STAFF) {
    await exec('UPDATE lender_staff SET account_id = ? WHERE id = ?', [accountOf(staff.email), staff.id]);
  }

  return { dialect, source: lending, platformSources: [outside], target, seeded, validUntil, rows, exec, maintenance };
}

/** The App's own directory, as a suite passes it to `loadApp`. */
export const IGNITION_DIR = resolve('test/fixtures/apps/ignition');

/** What `openIgnitionLending`'s `jobs` option takes: the App's own registry and
 * jobs module, so a fixture provisions exactly what its deployment will attest. */
export async function ignitionJobs(): Promise<NonNullable<IgnitionLendingOptions['jobs']>> {
  const commands = (await import('../../test/fixtures/apps/ignition/commands.js')).default;
  const jobs = (await import('../../test/fixtures/apps/ignition/jobs.js')).default;
  return { commands, jobs } as NonNullable<IgnitionLendingOptions['jobs']>;
}

/**
 * Ignition enrolled on a fixture's databases: the App as its own loader reads
 * it (authority lock included), its server-only policy, and — when asked — its
 * command registry and jobs module. A request is `{ account }`, which the
 * session verifier answers with that account as the identity, so a suite acts
 * as one of the fixture's synthetic accounts (`accountOf`).
 *
 * A tenant command runs as `deployment.execute({ account }, [tenantId], value)`,
 * a platform one as `deployment.executePlatform({ account }, value)`: the
 * dealership is named by the selector, and the lender's realm names none.
 */
export async function enrollIgnition(
  t: TestContext,
  lending: IgnitionLending,
  options: { readonly commands?: boolean; readonly jobs?: boolean; readonly now?: () => number } = {},
) {
  const { loadApp } = await import('../../packages/mistri/src/server/app/apps.js');
  const { createTenantEnrollment } = await import('../../packages/mistri/src/server/tenant/tenantEnrollment.js');
  const loaded = await loadApp(IGNITION_DIR);
  const policy = (await import('../../test/fixtures/apps/ignition/tenant-policy.js')).default;
  const registry = options.commands === false ? undefined : (await import('../../test/fixtures/apps/ignition/commands.js')).default;
  const module = options.jobs ? (await import('../../test/fixtures/apps/ignition/jobs.js')).default : undefined;
  const enrollment = await createTenantEnrollment<{ account: string }>({
    app: loaded.app,
    pages: loaded.pages,
    policy,
    source: lending.source as never,
    platformSources: lending.platformSources as never,
    deployment: 'ignition-fixture',
    roles: Object.keys(loaded.app.auth!.roles!),
    maxLifetimeMs: 60_000,
    ...(options.now ? { now: options.now } : {}),
    verifySession: (request) => ({ id: request.account, who: request.account }),
    ...(registry ? { commands: { registry } } : {}),
    ...(module ? { jobs: { module } } : {}),
  });
  t.after(() => enrollment.retire());
  return { enrollment, app: loaded.app, pages: loaded.pages };
}

/**
 * The job store and every delivery destination the request named, created by
 * this call on this run's own database. A fixture that quietly provisioned
 * nothing looks identical until an enrollment refuses with no reason given —
 * these stores are attested and never created — so the fixture reads its own
 * result rather than discarding it.
 *
 * The event store is not checked: each flag says whether *this* call
 * created that store, and a caller asking for `events` as well has already
 * created the event store a moment earlier, which makes `false` here the
 * correct answer rather than a failure.
 */
function assertProvisioned(provisioned: StoresProvisioned): void {
  const missing = [
    ...(provisioned.stores.jobs?.provisioned ? [] : ['the job store']),
    ...provisioned.destinations.filter((entry) => !entry.added).map((entry) => `the delivery destination ${entry.id}`),
  ];
  if (missing.length) throw new Error(`The fixture's database already held ${missing.join(', ')}.`);
}

/** SQLite has no boolean; every other value is text, a number or null. */
function sqliteSeed(db: DatabaseSync, tables: Seeded, order: readonly string[]): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of order) {
      const rows = tables[table] ?? [];
      if (!rows.length) continue;
      const columns = Object.keys(rows[0]);
      const statement = db.prepare(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
        VALUES (${columns.map(() => '?').join(', ')})`);
      for (const row of rows) {
        statement.run(...columns.map((column) => (typeof row[column] === 'boolean' ? (row[column] ? 1 : 0) : (row[column] as never))));
      }
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** The same rows on PostgreSQL, one statement per table, in 200-row batches. */
async function postgresSeed(client: Control, tables: Seeded, order: readonly string[]): Promise<void> {
  for (const table of order) {
    const rows = tables[table] ?? [];
    if (!rows.length) continue;
    const columns = Object.keys(rows[0]);
    for (let start = 0; start < rows.length; start += 200) {
      const batch = rows.slice(start, start + 200),
        values: unknown[] = [];
      const tuples = batch.map(
        (row) =>
          `(${columns
            .map((column) => {
              values.push(row[column]);
              return `$${values.length}`;
            })
            .join(', ')})`,
      );
      await client.query(
        `INSERT INTO public."${table}" (${columns.map((column) => `"${column}"`).join(', ')})
        VALUES ${tuples.join(', ')}`,
        values,
      );
    }
  }
}
