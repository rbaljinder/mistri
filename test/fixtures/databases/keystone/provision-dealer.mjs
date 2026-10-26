/**
 * Provision the Keystone `dealer` App (dealer settings) over a seeded
 * Keystone database: sign-in accounts for three dealership managers, and
 * each one's dealer_user seat linked to the account it came back with.
 *
 *   node --import tsx test/fixtures/databases/keystone/provision-dealer.mjs <keystone-postgres-url> <new-credentials.json>
 *
 * The accounts go into the App's own sign-in store (auth/dealer.db under the
 * tablewalk config directory, so XDG_CONFIG_HOME picks it). Passwords are
 * random and written only to the credentials file, mode 0600; nothing secret
 * is printed. The command journal and record history the App uses are the
 * seed's, shared by every Keystone App.
 *
 * Why link dealer_user.dealer_account_id: the App's row policy (apps/keystone/dealer/
 * policy.ts) finds a person's seats only by the exact verified account id.
 * Unlinked seats grant nothing, even when the email matches, so changing
 * the email on a seat cannot hand a dealership to whoever holds that address.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createAppAccounts } from '@mistriwork/mistri/maintenance';

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/keystone/dealer');

/* Three people the App should be seen through: an owner who manages the
   whole team, a sales manager at the same dealership (who may add only
   salespeople and viewers), and the owner of the dealership Keystone has on
   hold. Picked by email from the deterministic fixture. */
const MANAGERS = [
  { email: 'carlos.campbell@liberty-ford.example', shows: 'owner, Liberty Ford of Harrisburg' },
  { email: 'andrew.fitzgerald@liberty-ford.example', shows: 'sales manager, Liberty Ford of Harrisburg' },
  { email: 'melissa.hill@scranton-preowned.example', shows: 'owner, Scranton Pre-Owned (on hold with Keystone)' },
];

const [url, out] = process.argv.slice(2);
if (!url || !out) {
  console.error(
    'Usage: node --import tsx test/fixtures/databases/keystone/provision-dealer.mjs <keystone-postgres-url> <new-credentials.json>',
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
  for (const manager of MANAGERS) {
    const { rows } = await db.query(
      "SELECT id, name, dealer_account_id FROM dealer_user WHERE email = $1 AND status = 'active' AND role IN ('owner', 'sales_manager')",
      [manager.email],
    );
    if (!rows.length) throw new Error(`No active manager ${manager.email}: is this a seeded Keystone database?`);
    if (rows.some((row) => row.dealer_account_id))
      throw new Error(`${manager.email} already has an account linked; this database was provisioned before.`);
    people.push({ ...manager, seats: rows.map((row) => row.id), name: rows[0].name, password: randomBytes(9).toString('base64url') });
  }
  const ids = await createAppAccounts(
    APP,
    people.map(({ email, name, password }) => ({ email, name, password })),
  );
  for (const [index, person] of people.entries()) {
    await db.query('UPDATE dealer_user SET dealer_account_id = $1, version = version + 1 WHERE id = ANY($2)', [ids[index], person.seats]);
  }
  writeFileSync(
    out,
    `${JSON.stringify(
      {
        app: 'dealer',
        accounts: people.map(({ email, name, password, shows }) => ({ email, name, password, role: 'manager', shows })),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  console.log(`Provisioned ${people.length} manager accounts for the dealer App; credentials in ${join(resolve(out))}.`);
} finally {
  await db.end();
}
