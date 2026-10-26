/**
 * Field report R2: where anyone may sign up (`signUp: 'open'`), an address is
 * only what someone typed until its link is followed, so it names nobody's
 * row. An account an administrator makes on the accounts screen is not that:
 * the administrator named the address, as the operator names the first
 * account's (MISTRI_AUTH_ADMIN_EMAIL), and nothing else could ever prove
 * it — no link is sent for an account nobody signed up for. So it is made
 * verified, and a mechanic the owner adds is matched to their staff row at
 * their first sign-in: their bench, their notifications.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyServer } from './support/policyServer.js';

const APP = {
  id: 'spoke',
  name: 'Spoke',
  auth: {
    signUp: 'open',
    defaultRole: 'rider',
    rows: 'policy',
    me: { from: 'staff', column: 'email' },
    roles: {
      admin: { label: 'Owner', read: true, write: true },
      mechanic: { label: 'Mechanic', read: true, write: ['job'] },
      rider: { label: 'Rider', read: ['job'] },
    },
  },
  resources: { job: { access: 'write', notify: [{ on: 'insert', to: 'filed_by', title: 'Filed' }] }, staff: {} },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
/* A mechanic reads the jobs on their own bench: the staff row whose email is the account's. */
const POLICY = `export default { appId: 'spoke', async resolveRows(principal, { db }) {
  if (principal.roles.includes('admin')) return { job: true, staff: true };
  const found = principal.email ? await db.staff.where({ email: principal.email.toLowerCase() }).limit(2) : [];
  if (found.length !== 1) return { job: false, staff: false };
  return { job: { groups: [[{ column: 'mechanic_id', op: '=', value: found[0].id }]] }, staff: true };
} };`;
const SQL = `CREATE TABLE staff(id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
  CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, mechanic_id INTEGER REFERENCES staff(id), filed_by TEXT);
  INSERT INTO staff VALUES (1, 'Mo', 'mo@example.org'), (2, 'Ida', 'ida@example.org');
  INSERT INTO job VALUES (1, 'Tune', 1, NULL), (2, 'Brakes', 2, NULL), (3, 'Chain', 1, NULL);`;

test('an account the owner makes under open sign-up is matched to its staff row at once', { timeout: 60_000 }, async (t) => {
  const server = await policyServer(t, { app: APP, policy: POLICY, sql: SQL, inbox: true });
  const owner = await server.owner();
  const made = await server.call(
    '/api/accounts',
    { app: 'spoke', operation: 'create', name: 'Mo', email: 'mo@example.org', roles: ['mechanic'], password: 'mo-fixture-password-1' },
    owner,
  );
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const mo = await server.signIn('mo@example.org', 'mo-fixture-password-1');

  const bench = await server.api('run', { q: 'job', exactCount: true }, mo);
  assert.equal(bench.status, 200, JSON.stringify(bench.body));
  assert.deepEqual(bench.body.rows.map((row: { title: string }) => row.title).sort(), ['Chain', 'Tune']);
  assert.equal((await server.api('whoami', undefined, mo)).body.inbox, true);
  assert.equal((await server.call('/api/inbox', { app: 'spoke' }, mo)).status, 200);

  // Someone who signs themselves up with a staff address is still nobody until the link is followed.
  const claimed = await server.call('/api/auth/sign-up/email', {
    name: 'Ida?',
    email: 'ida@example.org',
    password: 'fixture-password-123',
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const unproven = await server.api('run', { q: 'job', exactCount: true }, claimed.cookie);
  assert.deepEqual(unproven.body.rows ?? [], []);
});
