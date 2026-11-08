/**
 * The revocation contract of a relationship row scope (`via`), end to end on a real `mistri --app` process:
 * a grant held in rows is gone at the next statement. The rider reads `job` through `bench_access`, a
 * membership table their role cannot read; moving that row away is the revocation, and the very next
 * read, write and live-sync notification already reflect it (resolveRows runs on every request; the via
 * reads the table at statement time). SQLite always; PostgreSQL when `TABLEWALK_TEST_PG` names a server.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { LIVE_PG, policyServer } from './support/policyServer.js';
import { pgClient } from './support/tenantDialects.js';

const APP = {
  id: 'spoke',
  name: 'Spoke',
  live: true,
  auth: {
    signUp: 'open',
    defaultRole: 'rider',
    rows: 'policy',
    roles: {
      admin: { label: 'Owner', read: true, write: true },
      // Not bench_access: the membership table stays private to the reader.
      rider: { label: 'Rider', read: ['job', 'bench'], write: ['job'], fields: { job: { write: ['title'] } } },
    },
  },
  resources: { job: { access: 'write' }, bench: { access: 'write' }, bench_access: { access: 'write' } },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
const POLICY = `export default { appId: 'spoke', resolveRows(principal) {
  if (principal.roles.includes('admin')) return { job: true, bench: true, bench_access: true };
  const held = { resource: 'bench_access', column: 'bench_id' };
  return {
    bench_access: true,
    bench: { groups: [[{ column: 'id', op: 'in', via: held }]] },
    job: { groups: [[{ column: 'bench_id', op: 'in', via: held }]] },
  };
} };`;
const SQL = `CREATE TABLE bench(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE bench_access(id INTEGER PRIMARY KEY, bench_id INTEGER NOT NULL);
  CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, bench_id INTEGER REFERENCES bench(id));
  INSERT INTO bench VALUES (1, 'Front'), (2, 'Back');
  INSERT INTO bench_access VALUES (1, 1);
  INSERT INTO job(id, title, bench_id) VALUES (1, 'Tune', 1), (2, 'Hidden', 2), (3, 'Other', 1);`;

const SETTLE = 900;

async function setup(t: TestContext, postgres: boolean) {
  const server = await policyServer(t, { app: APP, policy: POLICY, sql: SQL, live: true, postgres });
  const owner = await server.owner();
  const rider = await server.signUp('rider');
  const titles = async () => {
    const read = await server.api('run', { q: 'job', limit: 50, offset: 0 }, rider);
    assert.equal(read.status, 200, JSON.stringify(read.body) + server.log());
    return (read.body.rows as { title: string }[]).map((row) => row.title).sort();
  };
  const revoke = async () =>
    assert.equal((await server.api('update', { table: 'bench_access', key: { id: 1 }, values: { bench_id: 99 } }, owner)).status, 200);
  const stored = async (id: number) => {
    if (!postgres) {
      const db = new DatabaseSync(server.url, { readOnly: true });
      try {
        return (db.prepare('SELECT title FROM job WHERE id = ?').get(id) as { title: string }).title;
      } finally {
        db.close();
      }
    }
    const client = await pgClient(server.url);
    try {
      return (await client.query('SELECT title FROM job WHERE id = $1', [id])).rows[0].title as string;
    } finally {
      await client.end();
    }
  };
  return { server, owner, rider, titles, revoke, stored };
}

async function readAndWrite(t: TestContext, postgres: boolean) {
  const { server, rider, titles, revoke, stored } = await setup(t, postgres);
  assert.deepEqual(await titles(), ['Other', 'Tune']);
  // Slow, not wrong: the operator is told once that nothing indexes the membership table's key.
  assert.match(server.log(), /bench_access\.bench_id/);
  assert.equal((await server.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Tuned' } }, rider)).status, 200);
  assert.equal((await server.api('update', { table: 'job', key: { id: 2 }, values: { title: 'Nope' } }, rider)).status !== 200, true);
  assert.equal(await stored(2), 'Hidden', 'a row the grant never reached was never writable');

  await revoke();
  // The next statement of the same session: nothing cached, nothing to wait for.
  assert.deepEqual(await titles(), []);
  const refused = await server.api('update', { table: 'job', key: { id: 1 }, values: { title: 'After revoke' } }, rider);
  assert.notEqual(refused.status, 200, JSON.stringify(refused.body));
  assert.equal(await stored(1), 'Tuned', 'the revoked row was not written');
}

async function liveSync(t: TestContext, postgres: boolean) {
  const { server, owner, rider, revoke } = await setup(t, postgres);
  const controller = new AbortController();
  const response = await fetch(`${server.origin}/api/live?app=spoke`, {
    headers: { origin: server.origin, cookie: rider },
    signal: controller.signal,
  });
  let text = '';
  const done = (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body!) text += decoder.decode(chunk as Uint8Array, { stream: true });
    } catch {
      /* aborted */
    }
  })();
  t.after(async () => {
    controller.abort();
    await done;
  });
  const changes = () => (text.match(/event: change/g) ?? []).length;
  const until = async (ok: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!ok() && Date.now() < deadline) await delay(20);
    assert.ok(ok(), `timed out; the stream said: ${text}`);
  };
  await until(() => text.includes('event: hello'));

  // While the grant stands, a change to a row it reaches is told, by key.
  assert.equal((await server.api('update', { table: 'job', key: { id: 3 }, values: { title: 'Seen' } }, owner)).status, 200);
  await until(() => changes() === 1);
  assert.match(text, /"id":3/);

  // After it is revoked, the same open stream is told nothing of the rows it reached.
  await revoke();
  await delay(SETTLE);
  const told = changes();
  assert.equal((await server.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Quiet one' } }, owner)).status, 200);
  assert.equal((await server.api('update', { table: 'job', key: { id: 3 }, values: { title: 'Quiet two' } }, owner)).status, 200);
  await delay(SETTLE);
  assert.equal(changes(), told, text);
  assert.doesNotMatch(text, /Quiet/);
}

test('a via grant held in rows is gone at the next read and write', { timeout: 90_000 }, (t) => readAndWrite(t, false));
test('a via grant held in rows is gone for an open live-sync stream', { timeout: 90_000 }, (t) => liveSync(t, false));
test(
  'a via grant held in rows is gone at the next read and write (PostgreSQL)',
  { timeout: 90_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => readAndWrite(t, true),
);
test(
  'a via grant held in rows is gone for an open live-sync stream (PostgreSQL)',
  { timeout: 90_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => liveSync(t, true),
);

/* The membership table is private: the grant reads it only through the via. A write in scope lands, a write that moves
   a row under a parent outside the reader's membership is refused (the new row is checked against the scope too),
   and a direct read of the membership table is refused. */
async function privateTarget(t: TestContext, postgres: boolean) {
  const app = {
    ...APP,
    auth: {
      ...APP.auth,
      roles: { ...APP.auth.roles, rider: { ...APP.auth.roles.rider, fields: { job: { write: ['title', 'bench_id'] } } } },
    },
  };
  const server = await policyServer(t, { app, policy: POLICY, sql: SQL, live: true, postgres });
  const rider = await server.signUp('rider');
  const bench = async (id: number) => {
    const read = await server.api('run', { q: 'job', limit: 50, offset: 0 }, rider);
    return (read.body.rows as { id: number; bench_id: number }[]).find((row) => row.id === id)?.bench_id;
  };
  assert.equal((await server.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Tuned' } }, rider)).status, 200);
  const away = await server.api('update', { table: 'job', key: { id: 1 }, values: { bench_id: 2 } }, rider);
  assert.notEqual(away.status, 200, JSON.stringify(away.body));
  assert.equal(await bench(1), 1, 'the row stayed under the parent the reader reaches');
  const direct = await server.api('run', { q: 'bench_access', limit: 50, offset: 0 }, rider);
  // Refused as a read: the table is not one this role can name, whatever it holds.
  const refusal = direct.body as { rows?: unknown[]; errors?: unknown[] };
  assert.ok(direct.status !== 200 || (refusal.errors?.length && !refusal.rows?.length), JSON.stringify(direct.body));
}

test('a via target the role cannot read still decides a write, and stays unreadable directly', { timeout: 90_000 }, (t) =>
  privateTarget(t, false),
);
test(
  'a via target the role cannot read still decides a write, and stays unreadable directly (PostgreSQL)',
  { timeout: 90_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => privateTarget(t, true),
);
