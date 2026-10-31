/**
 * Field report TR7 and R7: a refused write under a row policy said "The change
 * is unavailable under the current permissions or record state" whatever the
 * cause, and named it only with diagnostics on; its code sat only in errors[]
 * while a command's sat at the top. Now each refusal says which rule refused,
 * naming only what the request named — the role's grant of the table or the
 * column, the row policy, a column the database computes — in the answer and
 * on the server's terminal, and every refusal body carries `code` and
 * `message` at the top.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { policyServer, type Reply } from './support/policyServer.js';

const APP = {
  id: 'spoke',
  name: 'Spoke',
  auth: {
    signUp: 'open',
    defaultRole: 'rider',
    rows: 'policy',
    roles: {
      admin: { label: 'Owner', read: true, write: true },
      rider: { label: 'Rider', read: true, write: ['job'], fields: { job: { write: ['title', 'bench_id'] } } },
    },
  },
  resources: { job: { access: 'write' }, bench: { access: 'write' } },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
const POLICY = `export default { appId: 'spoke', resolveRows() {
  return { job: { groups: [[{ column: 'bench_id', op: '=', value: 1 }]] }, bench: true };
} };`;
const SQL = `CREATE TABLE bench(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT, hours REAL NOT NULL DEFAULT 1,
    total REAL GENERATED ALWAYS AS (hours * 50) STORED, bench_id INTEGER REFERENCES bench(id));
  INSERT INTO bench VALUES (1, 'Front'), (2, 'Back');
  INSERT INTO job(id, title, bench_id) VALUES (1, 'Tune', 1), (2, 'Hidden', 2);`;

function refusedWith(reply: Reply, status: number, code: string, message: RegExp) {
  assert.equal(reply.status, status, JSON.stringify(reply.body));
  assert.equal(reply.body.code, code, JSON.stringify(reply.body));
  assert.match(reply.body.message, message);
  assert.equal(reply.body.error, reply.body.message);
  assert.deepEqual(reply.body.errors, [{ code, message: reply.body.message }]);
  assert.equal(reply.body.outcome, 'rejected');
  assert.equal(reply.body.cause, undefined, 'the operator-only cause is still not said to an ordinary account');
}

test('a refused write under a row policy names its rule, to the caller and on the terminal', { timeout: 60_000 }, async (t) => {
  const server = await policyServer(t, { app: APP, policy: POLICY, sql: SQL });
  const rider = await server.signUp('rider');

  refusedWith(
    await server.api('insert', { table: 'bench', values: { name: 'Side' } }, rider),
    403,
    'forbidden',
    /^This account's role does not write "bench"\.$/,
  );
  refusedWith(
    await server.api('update', { table: 'job', key: { id: 1 }, values: { note: 'x' } }, rider),
    403,
    'forbidden',
    /^This account's role does not write "note" of "job"\.$/,
  );
  refusedWith(
    await server.api('update', { table: 'job', key: { id: 2 }, values: { title: 'Mine now' } }, rider),
    403,
    'forbidden',
    /^The App's row policy does not let this account change this "job" record\.$/,
  );
  refusedWith(
    await server.api('insert', { table: 'job', values: { title: 'Elsewhere', bench_id: 2 } }, rider),
    400,
    'validation_failed',
    /^The App's row policy does not let this account create this "job" record, or point it at a record it cannot read\.$/,
  );

  // Said where the server runs, with diagnostics off (the fixture's MISTRI_DIAGNOSTICS is empty).
  const log = server.log();
  assert.match(log, /POST \/api\/insert refused \(403 forbidden\): This account's role does not write "bench"\./);
  assert.match(
    log,
    /POST \/api\/update refused \(403 forbidden\): The App's row policy does not let this account change this "job" record\./,
  );
});

/* A key the database refused under a row policy was a 400 `validation_failed` saying "unavailable under the current
   permissions" — a rule the person could do nothing about, at a status that read as the request's shape. It is a 409
   `duplicate_value` in the fixed sentence (a live load test), and the same, word for word, whether the id it met is a
   row the policy shows this account or one it hides: the code alone picks the answer, so it says nothing of the row. */
test('a key the database refused under a row policy is a 409, the same for a row the policy hides', { timeout: 60_000 }, async (t) => {
  const rider = { label: 'Rider', read: true, write: ['job'], fields: { job: { write: ['id', 'title', 'bench_id'] } } };
  const server = await policyServer(t, {
    app: { ...APP, auth: { ...APP.auth, roles: { ...APP.auth.roles, rider } } },
    policy: POLICY,
    sql: SQL,
  });
  const account = await server.signUp('rider');
  const seen = await server.api('insert', { table: 'job', values: { id: 1, title: 'Again', bench_id: 1 } }, account);
  const hidden = await server.api('insert', { table: 'job', values: { id: 2, title: 'Again', bench_id: 1 } }, account);
  for (const reply of [seen, hidden])
    refusedWith(reply, 409, 'duplicate_value', /^A record with these unique values already exists\. Use different values and try again\.$/);
  assert.deepEqual(hidden.body, seen.body);
});
