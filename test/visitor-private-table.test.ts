/**
 * A signed-out visitor at an App with `auth.public` (field report CX9) asked
 * for a table outside it was answered 200 "No table called …": a private
 * table and one that does not exist alike, which is right, but as a mistake
 * in the question rather than the sign-in it is. Every read of one table now
 * answers 401 with the sign-in card for a table the visitor's catalog does not
 * hold, the same for one that exists and one that does not; a batch answers
 * each of its items.
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
const SQL = `CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL);
  CREATE TABLE ledger(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL);
  INSERT INTO job VALUES (1, 'Tune'); INSERT INTO ledger VALUES (1, 900);`;

const asks = (table: string): [string, Record<string, unknown>][] => [
  ['run', { q: `${table} id > 0`, limit: 5, offset: 0 }],
  ['query', { table, limit: 5, offset: 0 }],
  ['count', { table }],
  ['view/run', { view: { id: 'v', name: table, base: table, columns: [{ path: 'id' }], limit: 5 } }],
  ['breakdown', { text: `${table} by id` }],
];

test(
  'a signed-out visitor asking for a table outside auth.public is asked to sign in, whether or not it exists',
  { timeout: 60_000 },
  async (t) => {
    const server = await policyServer(t, { app: APP, sql: SQL });

    const open = await server.api('run', { q: 'job', limit: 5, offset: 0 });
    assert.equal(open.status, 200, JSON.stringify(open.body));
    assert.deepEqual(
      open.body.rows.map((row: { title: string }) => row.title),
      ['Tune'],
    );

    const answers: Record<string, unknown[]> = {};
    for (const table of ['ledger', 'nowhere']) {
      for (const [route, body] of asks(table)) {
        const reply = await server.api(route, body);
        assert.equal(reply.status, 401, `${route} ${table}: ${JSON.stringify(reply.body)}`);
        assert.equal(reply.body.error, 'Sign in to continue.');
        assert.equal(reply.body.code, 'members_only');
        assert.equal(reply.body.signIn.app, 'Spoke');
        (answers[route] ??= []).push(reply.body);
      }
    }
    // The private table and the missing one are one answer: nothing says which exists.
    for (const [route, [ledger, nowhere]] of Object.entries(answers)) assert.deepEqual(ledger, nowhere, route);

    // A batch answers each item: a public list's badges beside a member's, and the member's refused without a count.
    const counts = await server.api('counts', { items: ['job', 'ledger', 'nowhere'] });
    assert.equal(counts.status, 200, JSON.stringify(counts.body));
    const [jobs, ledger, nowhere] = counts.body.results;
    assert.equal(jobs.total, 1);
    for (const refused of [ledger, nowhere]) assert.ok(refused.total === undefined && refused.errors?.length, JSON.stringify(refused));

    // A signed-in reader whose role does not read the table is still told as before: the catalog it reads has none.
    const rider = await server.signUp('rider');
    const mine = await server.api('run', { q: 'ledger', limit: 5, offset: 0 }, rider);
    assert.equal(mine.status, 200);
    assert.match(mine.body.errors[0].message, /^No table called "ledger"/);
  },
);
