/**
 * A signed-out visitor at a public table's record address (`/jobs/1`, `job` in
 * `auth.public`) was drawn the whole sign-in screen: the record page is the
 * table's suggested page, and `GET /api/pages/suggested` was not among the
 * reads a visitor may make, so its 401 took the App away. It is a public read
 * now, built from the visitor's catalog, which holds only what `auth.public`
 * names: a table outside it is asked to sign in, alike for a private table and
 * for none, and the public table's page names nothing private beside it.
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
    roles: { admin: { read: true, write: true }, rider: { read: ['job'] } },
    public: { read: ['job'] },
  },
  resources: { job: {}, ledger: {} },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
/* The ledger points at the job: a member's job page lists its ledger rows, which a visitor's must not name. */
const SQL = `CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE ledger(id INTEGER PRIMARY KEY, job_id INTEGER REFERENCES job(id), secret_amount INTEGER NOT NULL);
  INSERT INTO job VALUES (1, 'Tune'); INSERT INTO ledger VALUES (1, 1, 900);`;

test(
  'a signed-out visitor opens a public table record page, and a table outside auth.public asks to sign in',
  { timeout: 60_000 },
  async (t) => {
    const server = await policyServer(t, { app: APP, sql: SQL });

    const page = await server.api('pages/suggested?table=job');
    assert.equal(page.status, 200, JSON.stringify(page.body));
    assert.equal(page.body.page.base, 'job');
    const text = JSON.stringify(page.body);
    for (const secret of ['ledger', 'secret_amount']) assert.equal(text.includes(secret), false, `${secret} in ${text}`);

    // The record the page shows is read as the visitor: the compose answers with the job, and nothing of the ledger.
    const composed = await server.api('pages/compose', { page: page.body.page.id ?? 'suggested:job', key: { id: '1' }, rows: 5 });
    assert.equal(composed.status, 200, JSON.stringify(composed.body));
    assert.match(JSON.stringify(composed.body), /Tune/);
    assert.equal(JSON.stringify(composed.body).includes('900'), false);

    const refused = [];
    for (const table of ['ledger', 'nowhere']) {
      const reply = await server.api(`pages/suggested?table=${table}`);
      assert.equal(reply.status, 401, `${table}: ${JSON.stringify(reply.body)}`);
      assert.equal(reply.body.code, 'members_only');
      assert.equal(reply.body.signIn.app, 'Spoke');
      refused.push(reply.body);
    }
    // The private table and the missing one are one answer: nothing says which exists.
    assert.deepEqual(refused[0], refused[1]);

    // A signed-in reader is answered as before: a role that does not read the ledger is refused it, not asked to sign in.
    const rider = await server.signUp('rider');
    assert.equal((await server.api('pages/suggested?table=job', undefined, rider)).status, 200);
    const riderLedger = await server.api('pages/suggested?table=ledger', undefined, rider);
    assert.equal(riderLedger.status, 403, JSON.stringify(riderLedger.body));
  },
);
