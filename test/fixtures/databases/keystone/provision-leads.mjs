/**
 * /leads' own provisioning, after the Keystone seed and before /leads first
 * starts (SUITE.md, "Provisioning"). /leads is the suite's tenant App: each
 * dealer a tenant, Keystone the platform realm.
 *
 *   MISTRI_AUDIT_KEY=<32+ bytes, kept apart from BETTER_AUTH_SECRET> \
 *   XDG_CONFIG_HOME=<where /leads keeps its sign-in store> \
 *   node --import tsx test/fixtures/databases/keystone/provision-leads.mjs <seeded-postgres-url> <new-directory>
 *
 * Every reserved store through the public maintenance steps, in the order
 * they require (startup only attests them, never creates one):
 *
 *   tenant store → administration journal → invitations → command journal
 *   → command events → jobs → support audit
 *
 * then the platform row and one tenant per dealer (Scranton Pre-Owned, on
 * hold, suspended; Allegheny Truck & Van, onboarding, suspended until it
 * trades), a native account and a membership for every active person at a
 * dealer (Maria Petrov at both Liberty Ford and Susquehanna Toyota), Keystone's
 * relationship managers as dealer support, and a random intake address for
 * every trading dealer. `dealer_user.account_id` learns each account, which
 * is how a command finds the person behind it.
 *
 * Passwords and intake links go to a 0600 `credentials.json` in the new
 * directory and are never printed. Run it once, on a database no /leads is
 * serving: DDL anywhere in the database refuses a running tenant App's
 * sources until it restarts.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
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
import commands from '../../apps/keystone/leads/server/commands.ts';
import jobs from '../../apps/keystone/leads/server/jobs.ts';

const APP = resolve(import.meta.dirname, '../../apps/keystone/leads');
const BINDING = { appId: 'leads', source: { id: 'keystone', connection: 'keystone' }, storeId: 'keystone-dealers' };
const OPERATOR = 'keystone-leads-provision';
const DAY = 24 * 60 * 60 * 1000;
/** A password nobody chose and nothing logs, written only to the 0600 file. */
const password = () => `${randomBytes(12).toString('base64url')}-Ks1`;
/** An intake address: 128 random bits. */
const intakeAddress = () => randomBytes(16).toString('hex');

const [url, directory] = process.argv.slice(2);
if (!url || !directory) {
  console.error('Usage: node --import tsx test/fixtures/databases/keystone/provision-leads.mjs <seeded-postgres-url> <new-directory>');
  process.exit(1);
}
if (!process.env.MISTRI_AUDIT_KEY || process.env.MISTRI_AUDIT_KEY.length < 32) {
  throw new Error('MISTRI_AUDIT_KEY must be set to at least 32 characters, kept apart from BETTER_AUTH_SECRET.');
}
const target = resolve(directory);
if (existsSync(target)) throw new Error(`Refusing to replace ${target}. Choose a new directory.`);
mkdirSync(target, { recursive: true, mode: 0o700 });

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  const dealers = (await db.query('SELECT id, name, status FROM dealer ORDER BY id')).rows;
  const dealerPeople = (
    await db.query("SELECT id, dealer_id, name, email, role FROM dealer_user WHERE status = 'active' ORDER BY dealer_id, role, name")
  ).rows;
  const support = (await db.query("SELECT id, name, email FROM lender_user WHERE role = 'relationship_manager' AND active ORDER BY id"))
    .rows;

  /* ---------- every reserved store, in the order the steps require ---------- */
  await migratePostgresTenantStore(url, BINDING);
  await migratePostgresTenantAdministrationJournal(url, BINDING);
  await migratePostgresTenantInvitations(url, BINDING);
  await migratePostgresCommandJournal(url);
  await provisionStores({ postgres: url }, { app: { tenant: BINDING } });
  await provisionStores({ postgres: url }, { app: { tenant: BINDING, commands }, jobs });
  await migratePostgresSupportAudit(url, BINDING);

  /* ---------- the realm and the tenants ---------- */
  const where = { postgres: url };
  await setPlatformStatus(where, BINDING, { status: 'active', expectedVersion: null, operator: OPERATOR });
  const anchors = new Map();
  for (const dealer of dealers) {
    anchors.set(
      dealer.id,
      await putTenant(where, BINDING, { tenantId: dealer.id, status: 'active', expectedVersion: null, operator: OPERATOR }),
    );
  }

  /* ---------- the people: one account per email, a membership per dealer ---------- */
  const byEmail = new Map();
  for (const row of dealerPeople) {
    const person = byEmail.get(row.email) ?? { name: row.name, email: row.email, password: password(), realm: 'tenant', memberships: [] };
    person.memberships.push({ tenant: row.dealer_id, role: row.role, dealerUserId: row.id });
    byEmail.set(row.email, person);
  }
  for (const row of support) {
    byEmail.set(row.email, { name: row.name, email: row.email, password: password(), realm: 'platform', roles: ['dealer_support'] });
  }
  const people = [...byEmail.values()];
  const ids = await createAppAccounts(
    APP,
    people.map(({ email, name, password: secret }) => ({ email, name, password: secret })),
  );
  people.forEach((person, index) => {
    person.accountId = ids[index];
  });

  const validUntil = Date.now() + 365 * DAY;
  for (const person of people) {
    if (person.realm === 'platform') {
      await grantPlatformMembership(where, BINDING, {
        app: APP,
        accountId: person.accountId,
        roles: person.roles,
        validUntil,
        operator: OPERATOR,
      });
      continue;
    }
    for (const membership of person.memberships) {
      await grantTenantMembership(where, BINDING, {
        app: APP,
        tenantId: membership.tenant,
        accountId: person.accountId,
        roles: [membership.role],
        validUntil,
        operator: OPERATOR,
      });
      await db.query('UPDATE dealer_user SET account_id = $1 WHERE id = $2', [person.accountId, membership.dealerUserId]);
    }
  }

  /* A new tenant starts active, and a membership is granted only in an active
     one; so a dealer on hold, or one still onboarding, is suspended last,
     its people's memberships already in place for the day it trades again. */
  for (const dealer of dealers.filter((d) => d.status !== 'active')) {
    await putTenant(where, BINDING, {
      tenantId: dealer.id,
      status: 'suspended',
      expectedVersion: anchors.get(dealer.id).version,
      operator: OPERATOR,
    });
  }

  /* ---------- each trading dealer's apply link ---------- */
  const links = [];
  for (const dealer of dealers.filter((d) => d.status === 'active')) {
    const address = intakeAddress();
    await db.query('UPDATE dealer SET intake_address = $1 WHERE id = $2', [address, dealer.id]);
    links.push({ dealer: dealer.name, path: `/leads/form/apply?via=${address}` });
  }

  writeFileSync(
    join(target, 'credentials.json'),
    `${JSON.stringify(
      {
        note: 'Synthetic demonstration credentials. Never commit this file or paste its contents.',
        accounts: people.map((person) => ({
          name: person.name,
          email: person.email,
          password: person.password,
          ...(person.realm === 'platform'
            ? { realm: 'platform', roles: person.roles }
            : { realm: 'tenant', memberships: person.memberships.map(({ tenant, role }) => ({ tenant, role })) }),
        })),
        intakeLinks: links,
      },
      null,
      2,
    )}\n`,
    { flag: 'wx', mode: 0o600 },
  );

  // Counts and paths only: never a password or an address.
  console.log(
    JSON.stringify(
      {
        credentials: join(target, 'credentials.json'),
        tenants: dealers.length,
        accounts: people.length,
        memberships: dealerPeople.length,
        support: support.length,
        intakeLinks: links.length,
      },
      null,
      2,
    ),
  );
} finally {
  await db.end();
}
