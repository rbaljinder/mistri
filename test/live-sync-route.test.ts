/**
 * `GET /api/live` end to end, on a real `mistri --app` process: what one
 * reader's stream says of another's writes, asserted on the bytes that leave
 * the server (DESIGN-LIVE-SYNC §5).
 *
 *   - a table outside the reader's grants: nothing;
 *   - an update of only columns they cannot read: nothing;
 *   - under a row policy, a row outside their scope before and after: nothing,
 *     not even its key; one that left their scope or entered it: its key;
 *   - their own write: `self`;
 *   - more than eight streams of one account: 503.
 *
 * SQLite always; the row-policy case and two processes on one database on
 * PostgreSQL in a database the case owns when `TABLEWALK_TEST_PG` names a
 * server. The tenant cases are in tenant-live.test.ts.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { LIVE_CHANGE_TABLES } from '../packages/mistri/src/adapters/live/liveChange.js';
import { LIVE_PG, policyServer } from './support/policyServer.js';

type Server = Awaited<ReturnType<typeof policyServer>>;
interface Event {
  event: string;
  data: any;
}

/** A stream, read in the background: its raw bytes and the events parsed from them. */
async function follow(t: TestContext, server: Server, cookie: string, appId: string, after?: string) {
  const controller = new AbortController();
  const response = await fetch(`${server.origin}/api/live?app=${appId}${after ? `&after=${after}` : ''}`, {
    headers: { origin: server.origin, cookie },
    signal: controller.signal,
  });
  let text = '';
  const done = (async () => {
    if (response.status !== 200 || !response.body) return;
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) text += decoder.decode(chunk as Uint8Array, { stream: true });
    } catch {
      /* aborted */
    }
  })();
  const close = async () => {
    controller.abort();
    await done;
  };
  t.after(close);
  const events = (): Event[] =>
    text
      .split('\n\n')
      .filter((block) => block.startsWith('event: '))
      .map((block) => ({ event: block.slice(7, block.indexOf('\n')), data: JSON.parse(block.slice(block.indexOf('data: ') + 6)) }));
  const changes = () => events().filter((event) => event.event === 'change');
  const until = async (test: () => boolean, ms = 5000) => {
    const deadline = Date.now() + ms;
    while (!test() && Date.now() < deadline) await delay(20);
    assert.ok(test(), `timed out; the stream said: ${text}`);
  };
  if (response.status === 200) await until(() => events().some((event) => event.event === 'hello'));
  return { response, text: () => text, events, changes, until, close };
}

/* Long enough for the hub to wake, read and coalesce (250 ms): what was not said by then is not going to be. */
const SETTLE = 900;

const ORDINARY = {
  id: 'spoke',
  name: 'Spoke',
  live: true,
  auth: {
    signUp: 'open',
    defaultRole: 'rider',
    roles: {
      admin: { read: true, write: true },
      rider: { read: ['job'], write: ['job'], fields: { job: { read: ['id', 'title'], write: ['title'] } } },
    },
  },
  resources: { job: { access: 'write' }, ledger: { access: 'write' } },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
const ORDINARY_SQL = `CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, note TEXT);
  CREATE TABLE ledger(id INTEGER PRIMARY KEY, amount INTEGER NOT NULL);
  INSERT INTO job VALUES (1, 'Tune', 'quiet'); INSERT INTO ledger VALUES (1, 900);`;

test(
  'an ordinary App tells a reader only of tables and columns their grants read, and marks their own writes',
  { timeout: 90_000 },
  async (t) => {
    const server = await policyServer(t, { app: ORDINARY, sql: ORDINARY_SQL, live: true });
    const owner = await server.owner();
    const rider = await server.signUp('rider');
    const riding = await follow(t, server, rider, 'spoke');
    const owning = await follow(t, server, owner, 'spoke');
    assert.equal(riding.response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.equal(riding.response.headers.get('cache-control'), 'no-store');

    // A table the rider does not read, and a column of one they do that they cannot read: nothing at all.
    assert.equal((await server.api('update', { table: 'ledger', key: { id: 1 }, values: { amount: 1200 } }, owner)).status, 200);
    assert.equal((await server.api('update', { table: 'job', key: { id: 1 }, values: { note: 'secret plan' } }, owner)).status, 200);
    await owning.until(() => owning.changes().length >= 1);
    await delay(SETTLE);
    assert.deepEqual(riding.changes(), [], riding.text());
    assert.doesNotMatch(riding.text(), /ledger|note|secret/);

    // The owner reads everything, and was told both as their own.
    const owned = owning.changes();
    assert.ok(
      owned.every((event) => event.data.self === true),
      JSON.stringify(owned),
    );
    assert.deepEqual(Object.assign({}, ...owned.map((event) => event.data.tables)), {
      ledger: { keys: [{ id: 1 }], kinds: ['update'] },
      job: { keys: [{ id: 1 }], kinds: ['update'] },
    });

    // A column they read: told, by key, not as their own; and the owner is told of the rider's write, not as theirs.
    assert.equal((await server.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Tuned' } }, owner)).status, 200);
    await riding.until(() => riding.changes().length === 1);
    const [told] = riding.changes();
    assert.deepEqual(told.data.tables, { job: { keys: [{ id: 1 }], kinds: ['update'] } });
    assert.equal(told.data.self, undefined);
    assert.match(told.data.cursor, /^[1-9][0-9]*$/);
    // The owner's own copy of that write can arrive after the rider's; counted before it lands, it would be
    // mistaken for the rider's write below (a loaded gate saw exactly that).
    await owning.until(() => owning.changes().some((event) => event.data.cursor === told.data.cursor));
    const before = owning.changes().length;
    assert.equal((await server.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Mine' } }, rider)).status, 200);
    await riding.until(() => riding.changes().length === 2);
    assert.equal(riding.changes()[1].data.self, true);
    await owning.until(() => owning.changes().length > before);
    assert.equal(owning.changes().at(-1)!.data.self, undefined);

    // A reconnect from a cursor says hello, then what was missed as one change, at the newest position.
    const cursor = told.data.cursor;
    const again = await follow(t, server, rider, 'spoke', cursor);
    await again.until(() => again.changes().length === 1);
    const [hello, replayed] = again.events();
    assert.equal(hello.event, 'hello');
    assert.equal(hello.data.cursor, cursor, 'hello holds the cursor asked for until the replay is told');
    assert.deepEqual(replayed.data.tables, { job: { keys: [{ id: 1 }], kinds: ['update'] } });
    assert.equal(replayed.data.self, true, "the one change missed was the rider's own");
    assert.equal(replayed.data.cursor, riding.changes()[1].data.cursor);
    await again.close();

    // Eight streams an account; the ninth waits.
    const more = [];
    for (let n = 0; n < 7; n++) more.push(await follow(t, server, rider, 'spoke'));
    const refused = await follow(t, server, rider, 'spoke');
    assert.equal(refused.response.status, 503);
    assert.equal(refused.response.headers.get('retry-after'), '30');
    for (const one of more) await one.close();

    // Every read says the tables it answered from, and only ones the reader is served.
    const reads = async (cookie: string, q: string) =>
      (
        await fetch(`${server.origin}/api/run?app=spoke`, {
          method: 'POST',
          headers: { origin: server.origin, cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ q, limit: 5, offset: 0 }),
        })
      ).headers.get('mistri-reads');
    assert.equal(await reads(rider, 'job'), 'job');
    assert.equal(await reads(owner, 'ledger'), 'ledger');
    assert.equal(await reads(rider, 'ledger'), null, 'an unserved table is no read to name');

    // Not a GET; not signed in to a members-only App.
    assert.equal((await server.call('/api/live?app=spoke', {}, owner)).status, 405);
    assert.equal((await server.call('/api/live?app=spoke')).status, 401);
  },
);

const POLICY_APP = {
  id: 'spoke',
  name: 'Spoke',
  live: true,
  auth: {
    signUp: 'open',
    defaultRole: 'rider',
    rows: 'policy',
    roles: {
      admin: { label: 'Owner', read: true, write: true },
      rider: { label: 'Rider', read: true, write: ['job'], fields: { job: { write: ['title'] } } },
    },
  },
  resources: { job: { access: 'write' }, bench: { access: 'write' } },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
const POLICY = `export default { appId: 'spoke', resolveRows(principal) {
  if (principal.roles.includes('admin')) return { job: true, bench: true };
  return { job: { groups: [[{ column: 'bench_id', op: '=', value: 1 }]] }, bench: true };
} };`;
const POLICY_SQL = (postgres: boolean) => `CREATE TABLE bench(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, bench_id INTEGER REFERENCES bench(id));
  INSERT INTO bench VALUES (1, 'Front'), (2, 'Back');
  INSERT INTO job(id, title, bench_id) VALUES (1, 'Tune', 1), (2, 'Hidden', 2), (3, 'Leaving', 1)${postgres ? '' : ''};`;

async function rowPolicyCase(t: TestContext, postgres: boolean) {
  const server = await policyServer(t, { app: POLICY_APP, policy: POLICY, sql: POLICY_SQL(postgres), live: true, postgres });
  const owner = await server.owner();
  const rider = await server.signUp('rider');
  const riding = await follow(t, server, rider, 'spoke');

  // A row outside the rider's scope before and after the change: no event, and no byte names it.
  assert.equal((await server.api('update', { table: 'job', key: { id: 2 }, values: { title: 'Still hidden' } }, owner)).status, 200);
  await delay(SETTLE);
  assert.deepEqual(riding.changes(), []);
  assert.doesNotMatch(riding.text(), /"id":2|Hidden|Still hidden/);

  // A row that leaves their scope: told (from the row as it stood), so the page drops it.
  assert.equal((await server.api('update', { table: 'job', key: { id: 3 }, values: { bench_id: 2 } }, owner)).status, 200);
  await riding.until(() => riding.changes().length === 1);
  assert.deepEqual(riding.changes()[0].data.tables, { job: { keys: [{ id: 3 }], kinds: ['update'] } });

  // A row that enters it: told (asked of the database, as the rider).
  assert.equal((await server.api('update', { table: 'job', key: { id: 2 }, values: { bench_id: 1 } }, owner)).status, 200);
  await riding.until(() => riding.changes().length === 2);
  assert.deepEqual(riding.changes()[1].data.tables, { job: { keys: [{ id: 2 }], kinds: ['update'] } });

  // Outside again, then changed while outside: told of the leaving, not of the change after it.
  assert.equal((await server.api('update', { table: 'job', key: { id: 3 }, values: { title: 'Gone' } }, owner)).status, 200);
  await delay(SETTLE);
  assert.equal(riding.changes().length, 2, riding.text());
  assert.doesNotMatch(riding.text(), /Gone/);
  return server;
}

test(
  'under a row policy a reader is told of rows in their scope before or after a change, and of no other',
  { timeout: 90_000 },
  async (t) => {
    await rowPolicyCase(t, false);
  },
);

test(
  'under a row policy on PostgreSQL, the same',
  { timeout: 90_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  async (t) => {
    await rowPolicyCase(t, true);
  },
);

test(
  'two processes on one PostgreSQL: a write through one is told to a reader of the other',
  { timeout: 120_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  async (t) => {
    const first = await policyServer(t, { app: ORDINARY, sql: ORDINARY_SQL, live: true, postgres: true });
    const second = await policyServer(t, { app: ORDINARY, sql: '', url: first.url });
    const owner = await first.owner();
    const reader = await second.owner();
    const reading = await follow(t, second, reader, 'spoke');
    assert.equal((await first.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Across' } }, owner)).status, 200);
    await reading.until(() => reading.changes().length === 1);
    assert.deepEqual(reading.changes()[0].data.tables, { job: { keys: [{ id: 1 }], kinds: ['update'] } });
    // The same account on both processes: its own write elsewhere is still its own.
    assert.equal(reading.changes()[0].data.self, true);
  },
);

test('switched off, or without its store, live sync is not served and nothing is captured', { timeout: 90_000 }, async (t) => {
  const off = await policyServer(t, { app: ORDINARY, sql: ORDINARY_SQL, live: true, args: ['--no-live'] });
  assert.match(off.log(), /live sync is off for "Spoke" \(--no-live\)/);
  const owner = await off.owner();
  assert.equal((await off.call('/api/live?app=spoke', undefined, owner)).status, 204);
  assert.equal((await off.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Quiet' } }, owner)).status, 200);
  const db = new DatabaseSync(off.url, { readOnly: true });
  try {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM "${LIVE_CHANGE_TABLES.change}"`).get()!.n, 0, 'no change row written');
  } finally {
    db.close();
  }

  const missing = await policyServer(t, { app: ORDINARY, sql: ORDINARY_SQL });
  const owns = await missing.owner();
  assert.equal((await missing.call('/api/live?app=spoke', undefined, owns)).status, 204);
  assert.match(missing.log(), /live sync is asked for by "Spoke", but its store is not provisioned on "ops"/);
  // The App serves on as before.
  assert.equal((await missing.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Still saves' } }, owns)).status, 200);

  // An App that does not ask, over a database whose store is provisioned: not served, nothing captured.
  const { live: _asked, ...unasked } = ORDINARY;
  const quiet = await policyServer(t, { app: unasked, sql: ORDINARY_SQL, live: true });
  assert.match(quiet.log(), /live sync is off for "Spoke": the App does not ask for it/);
  const own = await quiet.owner();
  assert.equal((await quiet.call('/api/live?app=spoke', undefined, own)).status, 204);
  assert.equal((await quiet.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Unasked' } }, own)).status, 200);
  const unread = new DatabaseSync(quiet.url, { readOnly: true });
  try {
    assert.equal(unread.prepare(`SELECT count(*) AS n FROM "${LIVE_CHANGE_TABLES.change}"`).get()!.n, 0, 'no change row written');
  } finally {
    unread.close();
  }
});

test('a resource left out with live: false is never told, and writes no change row of its own', { timeout: 90_000 }, async (t) => {
  const app = { ...ORDINARY, resources: { job: { access: 'write' }, ledger: { access: 'write', live: false } } };
  const server = await policyServer(t, { app, sql: ORDINARY_SQL, live: true });
  const owner = await server.owner();
  const owning = await follow(t, server, owner, 'spoke');
  const [hello] = owning.events();
  assert.deepEqual(hello.data.off, ['ledger'], 'hello names the table the page must not wait on');
  assert.equal((await server.api('update', { table: 'ledger', key: { id: 1 }, values: { amount: 1300 } }, owner)).status, 200);
  await delay(SETTLE);
  assert.deepEqual(owning.changes(), [], owning.text());
  const rows = () => {
    const db = new DatabaseSync(server.url, { readOnly: true });
    try {
      return Number(db.prepare(`SELECT count(*) AS n FROM "${LIVE_CHANGE_TABLES.change}"`).get()!.n);
    } finally {
      db.close();
    }
  };
  assert.equal(rows(), 0, 'a write to an excluded table alone writes no change row');
  assert.equal((await server.api('update', { table: 'job', key: { id: 1 }, values: { title: 'Told' } }, owner)).status, 200);
  await owning.until(() => owning.changes().length === 1);
  assert.deepEqual(owning.changes()[0].data.tables, { job: { keys: [{ id: 1 }], kinds: ['update'] } });
  assert.equal(rows(), 1);
});

test(
  'signed-out visitors behind a proxy each have their own streams, counted by the client the proxy names',
  { timeout: 90_000 },
  async (t) => {
    /* An App that signs no one in: every reader is a visitor. From this machine, a proxy beside the server (trust.ts
       trustedProxyPeer), each request names its client in X-Forwarded-For, as a load balancer's or Cloudflare's would. */
    const server = await policyServer(t, {
      app: { id: 'board', name: 'Board', live: true, resources: { job: {} }, views: { jobs: { kind: 'list', from: 'job' } }, home: 'jobs' },
      sql: "CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL); INSERT INTO job VALUES (1, 'Tune');",
      live: true,
    });
    const open = async (client: string) => {
      const controller = new AbortController();
      const response = await fetch(`${server.origin}/api/live?app=board`, {
        headers: { origin: server.origin, 'x-forwarded-for': client },
        signal: controller.signal,
      });
      t.after(() => controller.abort());
      return response.status;
    };
    // Nine visitors, one stream each: nine streams, where the proxy's one address used to hold eight of them.
    const visitors = [];
    for (let i = 1; i <= 9; i++) visitors.push(await open(`203.0.113.${i}`));
    assert.deepEqual(visitors, Array(9).fill(200));
    // One visitor is still held to eight.
    const one = [];
    for (let i = 0; i < 9; i++) one.push(await open('198.51.100.20'));
    assert.deepEqual(one, [...Array(8).fill(200), 503]);
  },
);
