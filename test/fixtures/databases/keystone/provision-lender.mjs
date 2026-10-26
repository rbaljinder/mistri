/**
 * Accounts for the lender App (test/fixtures/apps/keystone/lender): one for each
 * active member of Keystone's staff, with the role their `lender_user` row
 * says. Run once against a running lender server whose first start
 * bootstrapped the administrator (MISTRI_AUTH_ADMIN_EMAIL and
 * MISTRI_AUTH_ADMIN_PASSWORD, set to the admin staff row's email).
 *
 *   KEYSTONE_DATABASE_URL=postgres://localhost/keystone \
 *   LENDER_URL=http://127.0.0.1:4801 LENDER_ADMIN_PASSWORD=… LENDER_STAFF_PASSWORD=… \
 *   node test/fixtures/databases/keystone/provision-lender.mjs
 *
 * It signs in as the administrator and adds the accounts through Manage
 * accounts' own endpoint (POST /api/accounts), because an account's roles are
 * set there: `createAppAccounts` makes accounts with the App's default role
 * only. Passwords come from the environment and are never printed. An address
 * that already has an account is left as it is, so a second run adds only the
 * staff hired since.
 */
import pg from 'pg';

const base = (process.env.LENDER_URL ?? 'http://127.0.0.1:4801').replace(/\/$/, '');
const database = process.env.KEYSTONE_DATABASE_URL;
const adminPassword = process.env.LENDER_ADMIN_PASSWORD;
const staffPassword = process.env.LENDER_STAFF_PASSWORD;
if (!database || !adminPassword || !staffPassword) {
  console.error('Set KEYSTONE_DATABASE_URL, LENDER_ADMIN_PASSWORD and LENDER_STAFF_PASSWORD.');
  process.exit(2);
}

const client = new pg.Client({ connectionString: database });
await client.connect();
const { rows: staff } = await client.query('SELECT name, email, role FROM lender_user WHERE active ORDER BY id');
await client.end();
const admin = staff.find((person) => person.role === 'admin');
if (!admin) throw new Error('No active admin in lender_user.');

const origin = { origin: new URL(base).origin };
const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...origin },
  body: JSON.stringify({ email: admin.email, password: adminPassword }),
});
if (!signIn.ok) throw new Error(`Signing in as ${admin.email} answered ${signIn.status}.`);
const cookie = signIn.headers
  .getSetCookie()
  .map((line) => line.split(';')[0])
  .join('; ');

const existing = await fetch(`${base}/api/accounts?app=lender`, { headers: { cookie, ...origin } });
const known = new Set(existing.ok ? ((await existing.json()).accounts?.map((account) => account.email) ?? []) : []);

let made = 0;
for (const person of staff) {
  if (person.role === 'admin' || known.has(person.email)) continue;
  const answer = await fetch(`${base}/api/accounts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, ...origin },
    body: JSON.stringify({
      app: 'lender',
      operation: 'create',
      email: person.email,
      name: person.name,
      roles: [person.role],
      password: staffPassword,
    }),
  });
  if (!answer.ok) throw new Error(`Adding ${person.email} answered ${answer.status}: ${await answer.text()}`);
  made++;
  console.log(`${person.email}  ${person.role}`);
}
console.log(`${made} account${made === 1 ? '' : 's'} added.`);
