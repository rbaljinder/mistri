/**
 * Ignition's PostgreSQL seed: what it refuses, and what one successful run
 * leaves behind. PostgreSQL only, because the sample is.
 *
 * The seed is the sample's deployment story — two dedicated databases, every
 * reserved store through the public maintenance steps, the §5.17 fixture, and
 * the people who can sign in — so the things worth holding it to are the ones an
 * operator would find out the hard way: that it refuses a database with anything
 * in it rather than merging into it, that it will not write over a directory,
 * that it insists on its configuration, and that the secrets it generates go to
 * a 0600 file and never into what it returns.
 *
 * It creates native accounts, so each test gives itself a private
 * XDG_CONFIG_HOME: the auth store is otherwise one per machine, and a second run
 * would refuse every address as taken.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test, type TestContext } from 'node:test';
import { seedIgnition } from '../examples/databases/ignition/seed-postgres.mjs';
import { liveSkip } from './live.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE_PG = process.env.TABLEWALK_TEST_PG;
const skip = liveSkip('postgres', LIVE_PG);
const AUDIT_KEY = 'ignition-seed-suite-audit-key-at-least-32-bytes';

/** A run's own environment: its auth store, its secrets, restored after. */
function isolate(t: TestContext, directory: string): void {
  const names = [
    'XDG_CONFIG_HOME',
    'BETTER_AUTH_SECRET',
    'MISTRI_AUDIT_KEY',
    'MISTRI_AUTH_ADMIN_EMAIL',
    'MISTRI_AUTH_ADMIN_PASSWORD',
  ] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  t.after(() => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  process.env.XDG_CONFIG_HOME = join(directory, 'xdg');
  process.env.BETTER_AUTH_SECRET = 'ignition-seed-suite-better-auth-secret-32-bytes';
  process.env.MISTRI_AUDIT_KEY = AUDIT_KEY;
  delete process.env.MISTRI_AUTH_ADMIN_EMAIL;
  delete process.env.MISTRI_AUTH_ADMIN_PASSWORD;
}

/** A directory the seed may create: made, then removed, so it does not exist. */
function unused(t: TestContext): string {
  const parent = mkdtempSync(join(tmpdir(), 'tablewalk-ignition-seed-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return join(parent, 'fixture');
}

const owned: Array<() => Promise<void>> = [];
after(async () => {
  for (const drop of owned) await drop().catch(() => {});
});
async function databases(): Promise<{ lendingUrl: string; applicantsUrl: string }> {
  const lending = await uuidPostgresDatabase('ign_seed_lending');
  const applicants = await uuidPostgresDatabase('ign_seed_applicants');
  owned.push(lending.drop, applicants.drop);
  return { lendingUrl: lending.url, applicantsUrl: applicants.url };
}

test('the seed insists on its configuration', { skip }, async (t) => {
  const directory = unused(t);
  isolate(t, directory);
  const { lendingUrl, applicantsUrl } = await databases();

  await assert.rejects(
    seedIgnition({ lendingUrl: undefined, applicantsUrl, directory }),
    /IGNITION_LENDING_SEED_URL and IGNITION_APPLICANTS_SEED_URL are required/,
  );
  await assert.rejects(
    seedIgnition({ lendingUrl, applicantsUrl: undefined, directory }),
    /IGNITION_LENDING_SEED_URL and IGNITION_APPLICANTS_SEED_URL are required/,
  );

  // The audit key is the support audit's, kept apart from sign-in's secret.
  process.env.MISTRI_AUDIT_KEY = 'too-short';
  await assert.rejects(seedIgnition({ lendingUrl, applicantsUrl, directory }), /MISTRI_AUDIT_KEY must be set to at least 32 characters/);
  process.env.MISTRI_AUDIT_KEY = AUDIT_KEY;
  assert.equal(existsSync(directory), false, 'nothing was written while it was refusing');
});

test('the seed refuses a directory that exists, and a database that is not empty', { skip }, async (t) => {
  const directory = unused(t);
  isolate(t, directory);
  const { lendingUrl, applicantsUrl } = await databases();

  // A directory it would have to write into is never replaced.
  const taken = mkdtempSync(join(tmpdir(), 'tablewalk-ignition-seed-taken-'));
  t.after(() => rmSync(taken, { recursive: true, force: true }));
  await assert.rejects(seedIgnition({ lendingUrl, applicantsUrl, directory: taken }), /Refusing to replace/);

  // Nor is a database with anything already in its public schema.
  const control = await pgClient(lendingUrl);
  t.after(() => void control.end().catch(() => {}));
  await control.query('CREATE TABLE public.something_already_here (id text PRIMARY KEY)');
  await assert.rejects(
    seedIgnition({ lendingUrl, applicantsUrl, directory }),
    /Refusing to seed: the lending database's public schema is not empty/,
  );
  const still = await control.query("SELECT count(*)::int AS total FROM pg_tables WHERE schemaname = 'public'");
  assert.equal(still.rows[0].total, 1, 'it added nothing to the database it refused');
});

test(
  'one run seeds both databases, provisions every store, and keeps its secrets in a 0600 file',
  { skip, timeout: 180_000 },
  async (t) => {
    const directory = unused(t);
    isolate(t, directory);
    const { lendingUrl, applicantsUrl } = await databases();

    const result = await seedIgnition({ lendingUrl, applicantsUrl, directory });

    // What it says it did, and nothing that would be a secret.
    assert.deepEqual(Object.keys(result).sort(), ['accounts', 'active', 'config', 'credentials', 'provisioned', 'tenants']);
    assert.deepEqual([result.accounts, result.tenants, result.active], [14, 4, 3]);

    // The two files, and which of them holds what.
    for (const path of [result.config, result.credentials]) {
      assert.equal(statSync(path).mode & 0o777, 0o600, `${path} is readable only by its owner`);
    }
    const config = readFileSync(result.config, 'utf8');
    assert.match(config, /\$\{IGNITION_LENDING_DATABASE_URL\}/, 'the connection file names variables, never a URL');
    assert.doesNotMatch(config, /postgres(ql)?:\/\//, 'and so carries no connection string');
    const credentials = JSON.parse(readFileSync(result.credentials, 'utf8')) as {
      accounts: { email: string; password: string }[];
      intakeLinks: { dealer: string; path: string }[];
    };
    assert.equal(credentials.accounts.length, 14);
    assert.equal(credentials.intakeLinks.length, 3, 'one link per active dealership');
    assert.ok(credentials.accounts.every((account) => account.password.length >= 16));

    // The lending database: the sample's own shape, and the reserved stores.
    const lending = await pgClient(lendingUrl);
    t.after(() => void lending.end().catch(() => {}));
    const counts = await lending.query(`SELECT
      (SELECT count(*)::int FROM dealer) AS dealers,
      (SELECT count(*)::int FROM lead) AS leads,
      (SELECT count(*)::int FROM loan_application) AS applications,
      (SELECT count(*)::int FROM lender_staff WHERE account_id IS NOT NULL) AS claimed,
      (SELECT count(*)::int FROM intake_submission) AS triage`);
    assert.deepEqual(counts.rows[0], { dealers: 4, leads: 24, applications: 48, claimed: 6, triage: 2 });
    const stores = await lending.query(`SELECT count(*)::int AS total FROM pg_tables
      WHERE schemaname = 'mistri'`);
    const reserved = Number(stores.rows[0].total);
    assert.ok(reserved >= 20, `every reserved store was provisioned, found ${reserved}`);

    // Each active dealership publishes an address; the suspended one has none.
    const addresses = await lending.query('SELECT status, intake_address FROM dealer ORDER BY id');
    for (const row of addresses.rows as { status: string; intake_address: string | null }[]) {
      assert.equal(row.intake_address === null, row.status === 'suspended');
    }

    // The applicant directory: native types, and its own constraints.
    const applicants = await pgClient(applicantsUrl);
    t.after(() => void applicants.end().catch(() => {}));
    const flags = await applicants.query('SELECT verified, preferred FROM contact LIMIT 1');
    assert.equal(typeof flags.rows[0].verified, 'boolean', 'a boolean column is a boolean, not a translated 0/1');
    await assert.rejects(applicants.query("UPDATE applicant SET verification_status = 'invalid'"), { code: '23514' });
    /* One row, not every one: pointing them all at a single applicant collides
       on `UNIQUE (applicant_id, kind)` first, and the foreign key is what this
       line is about. */
    await assert.rejects(
      applicants.query("UPDATE contact SET applicant_id = 'nobody' WHERE id = (SELECT id FROM contact ORDER BY id LIMIT 1)"),
      { code: '23503' },
    );
  },
);
