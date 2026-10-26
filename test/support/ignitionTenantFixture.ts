/**
 * Ignition's lending file on SQLite: the reshaped PostgreSQL schema of
 * `examples/databases/ignition/schema.mjs`, table for table, with that
 * module's own §5.17 rows. The public sample is PostgreSQL only — a dealer's
 * ownership column, the composite tenant keys and the tenant-local uniques
 * are the sample's subject, and PostgreSQL is where it is deployed — so this
 * exists for the node suites and the browser fixtures alone, which want the
 * same shape in a disposable file.
 *
 * The rows come from `lendingRows()` rather than a second copy of them, so the
 * two seeds cannot drift. Only the types are translated: `numeric(12, 2)` is
 * `REAL`, `boolean` is 0/1, `timestamptz` is `TEXT` — but `TIMESTAMP` where a
 * page orders by it (`assigned_on`, the lender's timeline), which is how SQLite
 * declares a date the catalog reads as one; the stored value is the same ISO
 * text. Everything ownership
 * decides is carried as it stands — the opaque text keys, `tenant_id` on the
 * four dealer-owned tables, `(tenant_id, x_id) -> x(tenant_id, id)` and the
 * `UNIQUE (tenant_id, id)` each one lands on, `UNIQUE (tenant_id, reference)`,
 * and every CHECK — because those are what a tenant suite is testing.
 *
 * It provisions the stores a deployment provisions, in that order, and grants
 * the dealers' and the lender's memberships through the store's own
 * administration capability. What it deliberately does not do: serve. There is
 * no HTTP server, no tenant host and no policy here — a caller starts those on
 * `path` with the App and policy it is testing. It does not load the public
 * App either: the stand-in manifest below exists only to open an auth store,
 * which is where the accounts a membership names have to be.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TestContext } from 'node:test';
import { provisionStores, type ProvisionStoresOptions, type StoresApp } from '@mistriwork/mistri/maintenance';
import { TransactionOperations } from '../../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../../packages/mistri/src/adapters/commands/commandJournal.js';
import type { LoadedApp } from '../../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../../packages/mistri/src/server/auth/auth.js';
import { createNativeAccount } from '../../packages/mistri/src/server/auth/authAccounts.js';
import { provisionSqliteTenantAdministrationJournal } from '../../packages/mistri/src/server/tenant/tenantAdministrationJournal.js';
import { provisionSqliteSupportAudit } from '../../packages/mistri/src/server/tenant/tenantSupportAudit.js';
import { SUPPORT_AUDIT_KEY_VARIABLE, supportAuditKey } from '../../packages/mistri/src/server/tenant/tenantSupportAuditContract.js';
import { provisionSqliteTenantInvitations } from '../../packages/mistri/src/server/tenant/tenantInvitationStore.js';
import {
  createSqliteTenantAdministration,
  provisionSqliteTenantStore,
  type TenantStoreAdministration,
} from '../../packages/mistri/src/server/tenant/tenantStore.js';
import { parseAppConfig } from '../../packages/mistri/src/shared/app.js';
import { DEALERS, DEALER_PEOPLE, LENDER_STAFF, lendingRows } from '../../examples/databases/ignition/schema.mjs';

/** The App, its source and the tenant policy's store, as Ignition declares them. */
export const binding = { appId: 'ignition', source: { id: 'lending', connection: 'loans' }, storeId: 'ignition-tenants' };

/**
 * This fixture's own support audit secret.
 *
 * Ignition's policy declares `support`, so every enrollment attests the support
 * audit store under the key the runtime derives from `MISTRI_AUDIT_KEY` —
 * and a store provisioned under a different key refuses just as a missing one
 * does. So the fixture provisions under this secret and puts the same secret in
 * the environment while the test runs. A suite that starts a server in a child
 * process must pass this same value, or the child derives a key the file was
 * never written under.
 */
export const SUPPORT_SECRET = 'ignition-tenant-fixture-support-audit-secret-32';

/** An hour is longer than any suite, and short enough that a leaked store is no grant. */
const LIFETIME = 3_600_000;

/**
 * The lending schema, translated. `dealer` and the desks come first because
 * the dealers' tables reference the profile row; `review_file` and the rest of
 * the lender's tables come last because they reference `loan_application`,
 * which is a dealer's. That is the same two passes schema.mjs makes.
 */
export const SQLITE_LENDING_SCHEMA = `PRAGMA foreign_keys=ON;
CREATE TABLE dealer (
  id TEXT PRIMARY KEY NOT NULL,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('franchise', 'independent')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  intake_address TEXT UNIQUE,
  joined_on DATE NOT NULL,
  brand_color TEXT,
  opens_at TIME,
  target_attainment INTEGER CHECK (target_attainment BETWEEN 0 AND 100),
  dms_settings TEXT,
  renewal_month TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
);
CREATE TABLE review_desk (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  coverage TEXT NOT NULL
);
CREATE TABLE lender_staff (
  id TEXT PRIMARY KEY NOT NULL,
  desk_id TEXT REFERENCES review_desk(id),
  account_id TEXT UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('platform_admin', 'manager', 'reviewer')),
  active BOOLEAN NOT NULL
);
CREATE TABLE vehicle_model (
  id TEXT PRIMARY KEY NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  model_year INTEGER NOT NULL
);
CREATE TABLE vehicle (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES dealer(id),
  stock_reference TEXT NOT NULL,
  model_id TEXT NOT NULL REFERENCES vehicle_model(id),
  condition TEXT NOT NULL CHECK (condition IN ('new', 'used')),
  mileage INTEGER NOT NULL CHECK (mileage >= 0),
  price REAL NOT NULL CHECK (price > 0),
  status TEXT NOT NULL CHECK (status IN ('available', 'financed', 'sold')),
  UNIQUE (tenant_id, stock_reference),
  UNIQUE (tenant_id, id)
);
CREATE TABLE lead (
  -- A command inserts without naming a key and nothing invents one, so every
  -- table a command writes defaults its own, as the PostgreSQL schema does with
  -- gen_random_uuid(). Without this the public form and the lead commands fail
  -- on NOT NULL.
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  tenant_id TEXT NOT NULL REFERENCES dealer(id),
  reference TEXT,
  applicant_name TEXT NOT NULL,
  applicant_email TEXT NOT NULL,
  applicant_phone TEXT,
  address_line TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  employer TEXT,
  annual_income REAL CHECK (annual_income >= 0),
  vehicle_stock TEXT,
  requested_amount REAL CHECK (requested_amount > 0),
  down_payment REAL CHECK (down_payment >= 0),
  term_months INTEGER CHECK (term_months IN (36, 48, 60)),
  submitted_on DATE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'new', 'qualified', 'converted', 'disqualified')),
  resume_token_hash TEXT,
  resume_expires_at TEXT,
  resume_progress TEXT,
  qualified_by TEXT,
  qualified_on DATE,
  disqualified_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, id),
  CHECK (status NOT IN ('qualified', 'converted') OR (qualified_by IS NOT NULL AND qualified_on IS NOT NULL)),
  CHECK ((status = 'disqualified') = (disqualified_reason IS NOT NULL)),
  CHECK (status = 'draft' OR (reference IS NOT NULL AND vehicle_stock IS NOT NULL AND requested_amount IS NOT NULL
    AND down_payment IS NOT NULL AND term_months IS NOT NULL AND submitted_on IS NOT NULL))
);
CREATE TABLE lead_co_applicant (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  tenant_id TEXT NOT NULL REFERENCES dealer(id),
  lead_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 2),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  UNIQUE (tenant_id, lead_id, position),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES lead(tenant_id, id),
  FOREIGN KEY (lead_id) REFERENCES lead(id)
);
CREATE TABLE loan_application (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  tenant_id TEXT NOT NULL REFERENCES dealer(id),
  reference TEXT NOT NULL,
  lead_id TEXT,
  vehicle_id TEXT NOT NULL,
  applicant_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('submitted', 'documents_pending', 'in_review',
    'manager_review', 'approved', 'declined', 'withdrawn')),
  requested_amount REAL NOT NULL CHECK (requested_amount > 0),
  down_payment REAL NOT NULL CHECK (down_payment >= 0),
  term_months INTEGER NOT NULL CHECK (term_months IN (36, 48, 60)),
  submitted_on DATE NOT NULL,
  document_status TEXT NOT NULL CHECK (document_status IN ('not_started', 'incomplete', 'complete')),
  withdrawn_reason TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK (withdrawn_reason IS NULL OR status = 'withdrawn'),
  UNIQUE (tenant_id, reference),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES lead(tenant_id, id),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicle(tenant_id, id),
  FOREIGN KEY (lead_id) REFERENCES lead(id),
  FOREIGN KEY (vehicle_id) REFERENCES vehicle(id)
);
CREATE TABLE application_document (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES dealer(id),
  application_id TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('identity', 'income', 'vehicle')),
  status TEXT NOT NULL CHECK (status IN ('requested', 'received', 'reviewed', 'needs_revision')),
  received_on DATE,
  notes TEXT NOT NULL,
  UNIQUE (tenant_id, application_id, category),
  FOREIGN KEY (tenant_id, application_id) REFERENCES loan_application(tenant_id, id),
  FOREIGN KEY (application_id) REFERENCES loan_application(id)
);
CREATE TABLE review_file (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  application_id TEXT NOT NULL UNIQUE REFERENCES loan_application(id),
  dealer_id TEXT NOT NULL REFERENCES dealer(id),
  desk_id TEXT NOT NULL REFERENCES review_desk(id),
  reviewer_id TEXT REFERENCES lender_staff(id),
  manager_id TEXT REFERENCES lender_staff(id),
  review_due_on DATE NOT NULL,
  review_context TEXT NOT NULL,
  opened_on DATE NOT NULL
);
CREATE TABLE application_review (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  application_id TEXT NOT NULL REFERENCES loan_application(id),
  reviewer_id TEXT NOT NULL REFERENCES lender_staff(id),
  kind TEXT NOT NULL CHECK (kind IN ('initial', 'manager')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'in_progress', 'complete', 'canceled')),
  opened_on DATE NOT NULL,
  completed_on DATE,
  summary TEXT NOT NULL,
  CHECK (completed_on IS NULL OR completed_on >= opened_on)
);
CREATE TABLE loan_decision (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  application_id TEXT NOT NULL UNIQUE REFERENCES loan_application(id),
  decided_by TEXT NOT NULL REFERENCES lender_staff(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('approved', 'declined')),
  recorded_on DATE NOT NULL,
  record_note TEXT NOT NULL
);
CREATE TABLE assignment_history (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  application_id TEXT NOT NULL REFERENCES loan_application(id),
  assigned_to TEXT NOT NULL REFERENCES lender_staff(id),
  assigned_by TEXT NOT NULL REFERENCES lender_staff(id),
  assigned_on TIMESTAMP NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE review_alert (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  application_id TEXT NOT NULL UNIQUE REFERENCES loan_application(id),
  due_on DATE NOT NULL,
  raised_on DATE NOT NULL,
  CHECK (raised_on > due_on)
);
CREATE TABLE intake_submission (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  reference TEXT UNIQUE,
  applicant_name TEXT NOT NULL,
  applicant_email TEXT NOT NULL,
  applicant_phone TEXT,
  address_line TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  employer TEXT,
  annual_income REAL CHECK (annual_income >= 0),
  dealer_hint TEXT,
  vehicle_stock TEXT,
  requested_amount REAL CHECK (requested_amount > 0),
  down_payment REAL CHECK (down_payment >= 0),
  term_months INTEGER CHECK (term_months IN (36, 48, 60)),
  submitted_on DATE,
  status TEXT NOT NULL CHECK (status IN ('draft', 'triage', 'closed')),
  outcome_note TEXT,
  resume_token_hash TEXT,
  resume_expires_at TEXT,
  resume_progress TEXT,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  CHECK (status = 'draft' OR (reference IS NOT NULL AND requested_amount IS NOT NULL
    AND term_months IS NOT NULL AND submitted_on IS NOT NULL))
);
CREATE TABLE intake_co_applicant (
  id TEXT PRIMARY KEY NOT NULL DEFAULT(lower(hex(randomblob(16)))),
  submission_id TEXT NOT NULL REFERENCES intake_submission(id),
  position INTEGER NOT NULL CHECK (position BETWEEN 1 AND 2),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  UNIQUE (submission_id, position)
);
CREATE INDEX lead_tenant_status ON lead (tenant_id, status);
CREATE INDEX application_tenant_status ON loan_application (tenant_id, status);
CREATE INDEX vehicle_tenant_status ON vehicle (tenant_id, status);
CREATE INDEX document_application ON application_document (tenant_id, application_id);
CREATE INDEX review_file_desk ON review_file (desk_id, review_due_on);
CREATE INDEX review_file_reviewer ON review_file (reviewer_id);
CREATE INDEX review_alert_due ON review_alert (due_on);
CREATE INDEX intake_submission_status ON intake_submission (status, submitted_on);
CREATE INDEX lead_co_applicant_lead ON lead_co_applicant (lead_id);
CREATE INDEX intake_co_applicant_submission ON intake_co_applicant (submission_id);
CREATE INDEX application_lead ON loan_application (lead_id);
CREATE INDEX application_vehicle ON loan_application (vehicle_id);
CREATE INDEX document_application_id ON application_document (application_id);
CREATE INDEX review_file_dealer ON review_file (dealer_id);
CREATE INDEX review_reviewer ON application_review (reviewer_id);
CREATE INDEX decision_decided_by ON loan_decision (decided_by);
CREATE INDEX staff_desk ON lender_staff (desk_id);`;

/* Insertion order, not alphabetical: a dealer's tables need the profile row,
   and the lender's need the applications they are the other half of. */
const SEED_ORDER = [
  'dealer',
  'review_desk',
  'lender_staff',
  'vehicle_model',
  'vehicle',
  'lead',
  'lead_co_applicant',
  'loan_application',
  'application_document',
  'review_file',
  'application_review',
  'loan_decision',
  'assignment_history',
  'review_alert',
  'intake_submission',
  'intake_co_applicant',
] as const;

type Row = Readonly<Record<string, unknown>>;

/** A native account, and every membership this fixture granted it. */
export interface IgnitionAccount {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly accountId: string;
  /** The dealer a membership is in, or null for one in the platform realm. */
  readonly memberships: readonly Readonly<{ tenantId: string | null; membershipId: string; roles: readonly string[] }>[];
  /** The `lender_staff` row whose `account_id` this account is, for the lender's people. */
  readonly staffId?: string;
}
export interface IgnitionTenantOptions {
  /** The tenant event store, for a caller whose commands declare events. */
  readonly events?: boolean;
  /** The event store, one delivery destination per job and the job store. */
  readonly jobs?: Readonly<{
    commands: NonNullable<StoresApp['commands']>;
    jobs: NonNullable<ProvisionStoresOptions['jobs']>;
  }>;
}

/**
 * A stand-in manifest, parsed but never served: `createAppAuth` needs an App
 * to open an auth store, and the accounts a membership names must exist in
 * one. The roles are Ignition's, so a caller granting further memberships has
 * the same two realms to name; the resources are the fewest the parse accepts.
 */
function authManifest(store: string) {
  return {
    id: binding.appId,
    name: 'Ignition tenant fixture',
    sources: { [binding.source.id]: { connection: binding.source.connection } },
    resources: { dealer: { owner: 'platform' }, lead: { access: 'write', owner: 'tenant' } },
    auth: {
      store,
      providers: ['email'],
      signUp: 'invite',
      rows: 'tenant',
      tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
      roles: {
        dealer_admin: { realm: 'tenant', read: true, write: ['lead'] },
        dealer_staff: { realm: 'tenant', read: true, write: ['lead'] },
        dealer_viewer: { realm: 'tenant', read: true },
        platform_admin: { realm: 'platform', read: true },
        manager: { realm: 'platform', read: true },
        reviewer: { realm: 'platform', read: true },
        automation: { realm: 'platform', read: true },
      },
    },
    views: { leads: { kind: 'list', from: 'lead' }, dealers: { kind: 'list', from: 'dealer' } },
    nav: [
      { id: 'desk', label: 'Desk', realm: 'tenant', children: ['leads'] },
      { id: 'lender', label: 'Lender', realm: 'platform', children: ['dealers'] },
    ],
    home: 'leads',
  };
}

export async function ignitionTenantFixture(t: TestContext, options: IgnitionTenantOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-ignition-tenant-'));
  const path = join(directory, 'loans.db'),
    authPath = join(directory, 'auth.db');
  let db: DatabaseSync | undefined;
  t.after(() => {
    try {
      db?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  const previousKey = process.env[SUPPORT_AUDIT_KEY_VARIABLE];
  process.env[SUPPORT_AUDIT_KEY_VARIABLE] = SUPPORT_SECRET;
  t.after(() => {
    if (previousKey === undefined) delete process.env[SUPPORT_AUDIT_KEY_VARIABLE];
    else process.env[SUPPORT_AUDIT_KEY_VARIABLE] = previousKey;
  });

  db = new DatabaseSync(path);
  db.exec(SQLITE_LENDING_SCHEMA);
  const seeded = lendingRows() as unknown as Readonly<Record<string, readonly Row[]>>;
  const insert = (table: string, rows: readonly Row[]) => {
    if (!rows.length) return;
    const columns = Object.keys(rows[0]);
    const statement = db!.prepare(`INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
      VALUES (${columns.map(() => '?').join(', ')})`);
    // SQLite has no boolean; the rest of the values are text, numbers or null.
    for (const row of rows)
      statement.run(...columns.map((column) => (typeof row[column] === 'boolean' ? (row[column] ? 1 : 0) : (row[column] as never))));
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of SEED_ORDER) insert(table, seeded[table]);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('The seeded lending file breaks its own keys.');

  // The deployment's own order (docs/tenant-apps.md, "Provisioning"): the
  // store, then the journal both administration and invitations write to,
  // then the invitations, then the command journal and what a command needs.
  provisionSqliteTenantStore(path, binding);
  provisionSqliteTenantAdministrationJournal(path, binding);
  provisionSqliteTenantInvitations(path, binding);
  migrateSqliteCommandJournal(path);
  if (options.events) await provisionStores({ sqlite: path }, { app: { tenant: binding } });
  if (options.jobs)
    await provisionStores({ sqlite: path }, { app: { tenant: binding, commands: options.jobs.commands }, jobs: options.jobs.jobs });
  provisionSqliteSupportAudit(path, binding, supportAuditKey(SUPPORT_SECRET));

  const rows = (sql: string, params: readonly unknown[] = []): Record<string, unknown>[] =>
    db!
      .prepare(sql)
      .all(...(params as never[]))
      .map((row) => ({ ...row }));
  /** One store transaction on the fixture's own handle, as maintenance runs one. */
  const maintenance = async (run: (admin: TenantStoreAdministration) => Promise<void>) => {
    const operations = new TransactionOperations();
    db!.exec('BEGIN IMMEDIATE');
    try {
      await run(createSqliteTenantAdministration(db!, operations, binding));
      await operations.finish();
      db!.exec('COMMIT');
    } catch (error) {
      await operations.finish().catch(() => {});
      if (db!.isTransaction) db!.exec('ROLLBACK');
      throw error;
    }
  };

  // The realm above the dealers first: without an active `@platform` row no
  // platform membership may be granted and no public submission is accepted.
  await maintenance(async (admin) => {
    await admin.putPlatform({ status: 'active', expectedVersion: null });
    for (const dealer of DEALERS) await admin.putTenant({ tenantId: dealer.id, status: 'active', expectedVersion: null });
    for (const dealer of DEALERS) {
      /* Narrowed here rather than at the source: schema.mjs is plain JavaScript
         and the root tsconfig sets checkJs false, so a JSDoc type on DEALERS is
         never read and its `status` widens to string — and the anchor status
         union is private to tenantMaintenance.ts, so there is nothing public to
         import. The suspended dealership is the only one this reaches, and a
         dealership is only ever active or suspended in this fixture. */
      if (dealer.status !== 'active') {
        await admin.putTenant({ tenantId: dealer.id, status: 'suspended', expectedVersion: '1' });
      }
    }
  });

  // Accounts with no sign-in: `sessions: false` holds no session secret and
  // bootstraps no administrator, which is all an account-making step needs.
  const auth = await createAppAuth(
    {
      path: join(directory, 'app.ts'),
      dir: directory,
      pages: [],
      sources: {},
      app: parseAppConfig(authManifest(authPath), 'ignition tenant fixture'),
    } satisfies LoadedApp,
    { baseURL: 'http://127.0.0.1', trustedOrigins: [], sessions: false },
  );
  const handleOf = (email: string) => email.split('@')[0];
  // One instant for every grant, so a caller comparing expiries compares one number.
  const validUntil = Date.now() + LIFETIME;
  const made: IgnitionAccount[] = [];
  try {
    const account = async (name: string, email: string, staffId?: string) => {
      const password = `ignition-tenant-${handleOf(email)}-password-123`;
      const accountId = await createNativeAccount(auth, { email, name, password }, { by: 'maintenance' });
      const created: IgnitionAccount = { name, email, password, accountId, memberships: [], ...(staffId ? { staffId } : {}) };
      made.push(created);
      return created;
    };
    const dealers = new Map<IgnitionAccount, readonly Readonly<{ tenant: string; role: string }>[]>();
    for (const person of DEALER_PEOPLE) dealers.set(await account(person.name, person.email), person.memberships);
    const staff = new Map<IgnitionAccount, string>();
    for (const person of LENDER_STAFF) staff.set(await account(person.name, person.email, person.id), person.role);
    await maintenance(async (admin) => {
      for (const [who, memberships] of dealers) {
        for (const membership of memberships) {
          const granted = {
            tenantId: membership.tenant,
            membershipId: `${membership.tenant}:${handleOf(who.email)}`,
            roles: [membership.role],
          };
          await admin.putMembership({ ...granted, accountId: who.accountId, status: 'active', validUntil, expectedVersion: null });
          (who.memberships as (typeof granted)[]).push(granted);
        }
      }
      for (const [who, role] of staff) {
        const granted = { tenantId: null, membershipId: `platform:${handleOf(who.email)}`, roles: [role] };
        await admin.putPlatformMembership({
          membershipId: granted.membershipId,
          accountId: who.accountId,
          status: 'active',
          roles: granted.roles,
          validUntil,
          expectedVersion: null,
        });
        (who.memberships as (typeof granted)[]).push(granted);
      }
    });
    // A platform command resolves its author through `lender_staff.account_id`,
    // so the lender's people are only staff once their accounts exist.
    const claim = db.prepare('UPDATE lender_staff SET account_id = ? WHERE id = ?');
    for (const who of staff.keys()) {
      if (claim.run(who.accountId, who.staffId!).changes !== 1) throw new Error(`No lender_staff row ${who.staffId}`);
    }
  } finally {
    auth.close();
  }

  return {
    directory,
    path,
    authPath,
    binding,
    seeded,
    validUntil,
    /** Every account, in the order schema.mjs lists the dealers' people and then the lender's. */
    accounts: made as readonly IgnitionAccount[],
    account: (email: string) => {
      const found = made.find((who) => who.email === email);
      if (!found) throw new Error(`The fixture created no account for ${email}`);
      return found;
    },
    rows,
    maintenance,
    db: () => db!,
  };
}
export type IgnitionTenantFixture = Awaited<ReturnType<typeof ignitionTenantFixture>>;
