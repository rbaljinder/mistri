/**
 * Ignition's seed: two dedicated PostgreSQL databases, every reserved store, and
 * the §5.17 fixture — a lender with four dealerships on it.
 *
 *   IGNITION_LENDING_SEED_URL=postgres://… \
 *   IGNITION_APPLICANTS_SEED_URL=postgres://… \
 *   MISTRI_AUDIT_KEY=<32+ bytes> \
 *   node --import tsx examples/databases/ignition/seed-postgres.mjs <new-directory>
 *
 * Both databases must exist and their `public` schema must be empty; the seed
 * refuses anything else and never drops, truncates or replaces an object. The
 * sample is PostgreSQL only — SQLite lives on in `test/support/` for tests.
 *
 * Everything reserved is provisioned through the **public** maintenance steps of
 * `@mistriwork/mistri/maintenance`, in the order those steps
 * require, because startup only ever attests these stores and never creates one:
 *
 *   tenant store → administration journal → invitations → command journal
 *   → command events → jobs → support audit
 *
 * The tenants, the platform row, the memberships and the native accounts come
 * from the same public steps (`putTenant`, `setPlatformStatus`,
 * `grantPlatformMembership`, `grantTenantMembership`, `createAppAccounts`), each
 * one its own journaled transaction under `maintenance:<operator>`. There is no
 * private identity file any more: a platform command finds its author through
 * `lender_staff.account_id`, which this seed fills in with the account ids the
 * accounts step returns.
 *
 * Credentials are written to a 0600 file in the new directory and are **never
 * printed**, so a terminal transcript or CI log cannot carry them.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
// The package entries, as a deployment writes them; in this checkout the root
// tsconfig's `paths` send them to src/ under tsx.
import {
  migratePostgresCommandJournal,
  migratePostgresSupportAudit,
  migratePostgresTenantAdministrationJournal,
  migratePostgresTenantInvitations,
  migratePostgresTenantStore,
} from '@mistriwork/mistri/maintenance';
import {
  createAppAccounts,
  grantPlatformMembership,
  grantTenantMembership,
  provisionStores,
  putTenant,
  setPlatformStatus,
} from '@mistriwork/mistri/maintenance';
import commands from '../../../test/fixtures/apps/ignition/commands.ts';
import jobs from '../../../test/fixtures/apps/ignition/jobs.ts';
import {
  ACTIVE_DEALERS,
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
} from './schema.mjs';

const APP = resolve(import.meta.dirname, '../../../test/fixtures/apps/ignition');
const BINDING = { appId: 'ignition', source: { id: 'lending', connection: 'loans' }, storeId: 'ignition-tenants' };
const OPERATOR = 'ignition-seed';
const DAY = 24 * 60 * 60 * 1000;
const ident = (value) => `"${String(value).replaceAll('"', '""')}"`;

/** A password nobody chose and nothing logs: 128 bits, written only to the 0600 file. */
const password = () => `${randomBytes(18).toString('base64url')}-Aa1`;
/** An intake address: 128 bits in the alphabet the address column takes. */
const intakeAddress = () => randomBytes(24).toString('base64url').slice(0, 32);

async function client(url, name) {
  const { Client } = await import('pg');
  const created = new Client({
    connectionString: url,
    application_name: `mistri-ignition-seed-${name}`,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  await created.connect();
  return created;
}

/** Refuse anything already in `public`: this seed adds, and never replaces. */
async function assertEmpty(pg, which) {
  const namespace = await pg.query("SELECT oid FROM pg_namespace WHERE nspname = 'public'");
  if (!namespace.rows.length) throw new Error(`The ${which} database needs a public schema.`);
  const existing = await pg.query(
    `SELECT 1 FROM pg_class WHERE relnamespace = $1
    UNION ALL SELECT 1 FROM pg_proc WHERE pronamespace = $1
    UNION ALL SELECT 1 FROM pg_type WHERE typnamespace = $1 LIMIT 1`,
    [namespace.rows[0].oid],
  );
  if (existing.rows.length) throw new Error(`Refusing to seed: the ${which} database's public schema is not empty.`);
}

/** One multi-row INSERT per table, every value bound. */
async function insert(pg, table, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  const values = rows.map((_, row) => `(${columns.map((__, column) => `$${row * columns.length + column + 1}`).join(', ')})`);
  await pg.query(
    `INSERT INTO "public".${ident(table)} (${columns.map(ident).join(', ')}) VALUES ${values.join(', ')}`,
    rows.flatMap((row) => columns.map((column) => row[column])),
  );
}

async function countsMatch(pg, rows) {
  for (const [table, expected] of Object.entries(rows)) {
    const {
      rows: [found],
    } = await pg.query(`SELECT count(*)::integer AS total FROM "public".${ident(table)}`);
    if (found.total !== expected.length) throw new Error(`Seeded ${found.total} ${table} rows, expected ${expected.length}.`);
  }
}

export async function seedIgnition({ lendingUrl, applicantsUrl, directory }) {
  if (!lendingUrl || !applicantsUrl) {
    throw new Error(
      'IGNITION_LENDING_SEED_URL and IGNITION_APPLICANTS_SEED_URL are required; use two new, dedicated PostgreSQL databases.',
    );
  }
  if (!process.env.MISTRI_AUDIT_KEY || process.env.MISTRI_AUDIT_KEY.length < 32) {
    throw new Error('MISTRI_AUDIT_KEY must be set to at least 32 characters, kept apart from BETTER_AUTH_SECRET.');
  }
  const target = resolve(directory);
  if (existsSync(target)) throw new Error(`Refusing to replace ${target}. Choose a new directory.`);

  const rows = lendingRows();
  // Every active dealership publishes its own intake link; a suspended one has
  // no address, so a link to it resolves to the lender's triage.
  const addresses = new Map();
  for (const dealer of rows.dealer) {
    if (dealer.status !== 'active') continue;
    dealer.intake_address = intakeAddress();
    addresses.set(dealer.id, dealer.intake_address);
  }
  const applicants = applicantRows(rows.loan_application.length);

  mkdirSync(dirname(target), { recursive: true });
  mkdirSync(target, { mode: 0o700 });

  /* ---------- the two databases' own tables ---------- */
  const lending = await client(lendingUrl, 'lending');
  try {
    await assertEmpty(lending, 'lending');
    await lending.query('BEGIN');
    await lending.query('SET LOCAL search_path = pg_catalog, public');
    await lending.query(LENDING_SCHEMA);
    await lending.query(LENDING_INDEXES);
    // In dependency order, not the sorted set: a parent before anything that
    // points at it, or an ownership key refuses the row.
    for (const table of LENDING_INSERT_ORDER) await insert(lending, table, rows[table] ?? []);
    await countsMatch(lending, rows);
    await lending.query('COMMIT');
  } catch (error) {
    await lending.query('ROLLBACK').catch(() => {});
    await lending.end().catch(() => {});
    throw error;
  }

  const applicantDb = await client(applicantsUrl, 'applicants');
  try {
    await assertEmpty(applicantDb, 'applicants');
    await applicantDb.query('BEGIN');
    await applicantDb.query('SET LOCAL search_path = pg_catalog, public');
    await applicantDb.query(APPLICANTS_SCHEMA);
    for (const table of APPLICANTS_INSERT_ORDER) await insert(applicantDb, table, applicants[table]);
    await countsMatch(applicantDb, applicants);
    await applicantDb.query('COMMIT');
  } catch (error) {
    await applicantDb.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await applicantDb.end().catch(() => {});
  }

  try {
    /* ---------- every reserved store, in the order the steps require ---------- */
    const provisioned = {
      store: await migratePostgresTenantStore(lendingUrl, BINDING),
      administration: await migratePostgresTenantAdministrationJournal(lendingUrl, BINDING),
      invitations: await migratePostgresTenantInvitations(lendingUrl, BINDING),
      journal: await migratePostgresCommandJournal(lendingUrl),
      events: await provisionStores({ postgres: lendingUrl }, { app: { tenant: BINDING } }),
      jobs: await provisionStores({ postgres: lendingUrl }, { app: { tenant: BINDING, commands }, jobs }),
      // The key argument is a derived one, and its default derives it from
      // MISTRI_AUDIT_KEY — which this seed has already insisted on — so the
      // secret is never passed around as a string.
      support: await migratePostgresSupportAudit(lendingUrl, BINDING),
    };

    /* ---------- the people, and what each of them may be ---------- */
    const people = [
      ...LENDER_STAFF.map((staff) => ({ ...staff, kind: 'lender' })),
      ...DEALER_PEOPLE.map((person) => ({ ...person, kind: 'dealer' })),
    ].map((person) => ({ ...person, password: password() }));
    const ids = await createAppAccounts(
      APP,
      people.map((person) => ({
        email: person.email,
        name: person.name,
        password: person.password,
      })),
    );
    people.forEach((person, index) => {
      person.accountId = ids[index];
    });

    // The lender's staff rows learn their accounts: this column is how a
    // platform command resolves its author, and it replaces the old staff map.
    const update = 'UPDATE "public"."lender_staff" SET account_id = $1 WHERE id = $2';
    for (const person of people.filter((entry) => entry.kind === 'lender')) {
      await lending.query(update, [person.accountId, person.id]);
    }

    /* ---------- the realm, the tenants and the memberships ---------- */
    const validUntil = Date.now() + 180 * DAY;
    await setPlatformStatus({ postgres: lendingUrl }, BINDING, { status: 'active', expectedVersion: null, operator: OPERATOR });
    for (const dealer of DEALERS) {
      const created = await putTenant({ postgres: lendingUrl }, BINDING, {
        tenantId: dealer.id,
        status: 'active',
        expectedVersion: null,
        operator: OPERATOR,
      });
      // A new tenant starts active, so a suspended dealership is a second step.
      // Parkside exists and is suspended on purpose: the sample holds one.
      if (dealer.status === 'suspended') {
        await putTenant({ postgres: lendingUrl }, BINDING, {
          tenantId: dealer.id,
          status: 'suspended',
          expectedVersion: created.version,
          operator: OPERATOR,
        });
      }
    }
    for (const person of people.filter((entry) => entry.kind === 'lender')) {
      await grantPlatformMembership({ postgres: lendingUrl }, BINDING, {
        app: APP,
        accountId: person.accountId,
        roles: [person.role],
        validUntil,
        operator: OPERATOR,
      });
    }
    for (const person of people.filter((entry) => entry.kind === 'dealer')) {
      // One person holds memberships at two dealerships, which is what makes
      // per-tab switching something the sample can actually show.
      for (const membership of person.memberships) {
        await grantTenantMembership({ postgres: lendingUrl }, BINDING, {
          app: APP,
          tenantId: membership.tenant,
          accountId: person.accountId,
          roles: [membership.role],
          validUntil,
          operator: OPERATOR,
        });
      }
    }

    /* ---------- what the operator needs, and nothing on the terminal ---------- */
    const config = join(target, 'server.json');
    writeFileSync(
      config,
      `${JSON.stringify(
        {
          connections: [
            { name: 'loans', url: '${IGNITION_LENDING_DATABASE_URL}', writable: true },
            // A platform-only source is read only: its connection must never say writable.
            { name: 'applicants', url: '${IGNITION_APPLICANTS_DATABASE_URL}', writable: false },
          ],
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    const credentials = join(target, 'credentials.json');
    writeFileSync(
      credentials,
      `${JSON.stringify(
        {
          note: 'Synthetic sample credentials. Never commit this file or paste its contents.',
          accounts: people.map((person) => ({
            name: person.name,
            email: person.email,
            password: person.password,
            realm: person.kind === 'lender' ? 'platform' : 'tenant',
            roles: person.kind === 'lender' ? [person.role] : person.memberships,
          })),
          intakeLinks: [...addresses].map(([dealer, address]) => ({ dealer, path: `/form/finance?via=${address}` })),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    return { config, credentials, provisioned, accounts: people.length, tenants: DEALERS.length, active: ACTIVE_DEALERS.length };
  } finally {
    await lending.end().catch(() => {});
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = process.argv[2] ?? join(import.meta.dirname, 'data');
  try {
    const result = await seedIgnition({
      lendingUrl: process.env.IGNITION_LENDING_SEED_URL,
      applicantsUrl: process.env.IGNITION_APPLICANTS_SEED_URL,
      directory,
    });
    // The paths and the counts, deliberately never a password or an address.
    console.log(
      JSON.stringify(
        {
          config: result.config,
          credentials: result.credentials,
          accounts: result.accounts,
          tenants: result.tenants,
          active: result.active,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
