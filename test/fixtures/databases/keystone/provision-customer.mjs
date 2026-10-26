/**
 * Provision the Keystone `customer` App (loan servicing) over a seeded
 * Keystone database: three borrowers' sign-in accounts, and each borrower's
 * customer row linked to the account it came back with.
 *
 *   node --import tsx test/fixtures/databases/keystone/provision-customer.mjs <keystone-postgres-url> <new-credentials.json>
 *
 * The accounts go into the App's own sign-in store (auth/customer.db under
 * the tablewalk config directory, so XDG_CONFIG_HOME picks it). Passwords
 * are random and written only to the credentials file, mode 0600; nothing
 * secret is printed. The command journal the App's commands need is the
 * seed's, shared by every Keystone App.
 *
 * Why link customer.account_id: the App's row policy (apps/keystone/customer/
 * policy.ts) finds a borrower only by the exact verified account id.
 * Unlinked or ambiguous accounts grant nothing, even when the email matches,
 * so changing the customer's email cannot hand their loans to whoever holds
 * that address.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAppAccounts } from '@mistriwork/mistri/maintenance';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/keystone/customer');

/* Three borrowers the App should be seen through: one loan on autopay, two
   loans (the chooser on Home), and a loan that is past due (the gentle
   warning). Picked by email from the deterministic fixture. */
const BORROWERS = [
  { email: 'sarah.campbell@example.com', shows: 'one loan, on autopay' },
  { email: 'aaliyah.johnson@example.com', shows: 'two loans' },
  { email: 'james.lee@example.com', shows: 'a loan past due' },
];

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error(
    'Usage: node --import tsx test/fixtures/databases/keystone/provision-customer.mjs <keystone-postgres-url> <new-credentials.json>',
  );
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`${out} exists; provisioning writes a new credentials file and never replaces one.`);
  process.exit(1);
}

const db = new pg.Client({ connectionString: url });
await db.connect();
try {
  const people = [];
  for (const borrower of BORROWERS) {
    const { rows } = await db.query('SELECT id, first_name, last_name, account_id FROM customer WHERE email = $1', [borrower.email]);
    if (!rows.length) throw new Error(`No customer ${borrower.email}: is this a seeded Keystone database?`);
    if (rows[0].account_id) throw new Error(`${borrower.email} already has an account linked; this database was provisioned before.`);
    people.push({
      ...borrower,
      customerId: rows[0].id,
      name: `${rows[0].first_name} ${rows[0].last_name}`,
      password: randomBytes(9).toString('base64url'),
    });
  }
  const ids = await createAppAccounts(
    APP,
    people.map(({ email, name, password }) => ({ email, name, password })),
  );
  for (const [index, person] of people.entries()) {
    await db.query('UPDATE customer SET account_id = $1, version = version + 1 WHERE id = $2', [ids[index], person.customerId]);
  }
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        app: 'customer',
        accounts: people.map(({ email, name, password, shows }) => ({ email, name, password, role: 'borrower', shows })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(`Provisioned ${people.length} borrower accounts for the customer App; credentials in ${join(resolve(out))}.`);
} finally {
  await db.end();
}
