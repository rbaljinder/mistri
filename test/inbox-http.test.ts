import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import { INBOX_TABLES } from '../packages/mistri/src/adapters/inbox/inbox.js';

/**
 * A person's inbox over HTTP. A notice is written with the write that sends
 * it, whichever door the write came through, to the people the App's rules
 * name off the record — never the person who made the write — and read by
 * its recipient alone: the session says whose inbox it is, a record the
 * reader cannot read now hides its notice, and words filled from a column
 * they may not read are not said.
 */
const appId = 'inbox-http';
const owner = 'inbox-http-db';

type Reply = { status: number; body: any };
type Person = 'ann' | 'bob' | 'cat' | 'outsider' | 'clerk';
const people: Record<Person, { id: string; who: string; role: string; name?: string }> = {
  ann: { id: 'account-ann', who: 'ann@example.test', role: 'member', name: 'Ann Lee' },
  bob: { id: 'account-bob', who: 'Bob@Example.test', role: 'member', name: 'Bob Diaz' },
  cat: { id: 'account-cat', who: 'cat@example.test', role: 'member' },
  outsider: { id: 'account-out', who: 'ann@example.test', role: 'outsider' },
  clerk: { id: 'account-clerk', who: 'ann@example.test', role: 'clerk' },
};

async function fixture(
  run: (f: {
    post: (path: string, body: Record<string, unknown>) => Promise<Reply>;
    as: (person: Person | null) => void;
    db: DatabaseSync;
  }) => Promise<void>,
  options: { provision?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-inbox-http-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
    INSERT INTO person VALUES (1, 'Ann', 'ann@example.test'), (2, 'Bob', 'bob@example.test'), (3, 'Cat', NULL);
    CREATE TABLE thread (id INTEGER PRIMARY KEY, title TEXT NOT NULL, author_id INTEGER NOT NULL REFERENCES person(id), status TEXT NOT NULL DEFAULT 'open');
    INSERT INTO thread VALUES (1, 'Solder fumes', 1, 'open'), (2, 'Bench power', 2, 'hidden');
    CREATE TABLE post (id INTEGER PRIMARY KEY, thread_id INTEGER NOT NULL REFERENCES thread(id), author_id INTEGER NOT NULL REFERENCES person(id),
      body TEXT NOT NULL CHECK (length(body) > 0));
    CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, assignee TEXT, status TEXT NOT NULL DEFAULT 'open');
    INSERT INTO task VALUES (1, 'Order flux', NULL, 'open');
    CREATE TABLE job (id INTEGER PRIMARY KEY, title TEXT NOT NULL, owner TEXT, status TEXT NOT NULL DEFAULT 'open',
      CHECK (status IN ('open', 'done', 'dropped')));
    INSERT INTO job VALUES (1, 'Reflow oven', 'bob@example.test', 'open'), (2, 'Hot plate', 'bob@example.test', 'open');`);
  if (options.provision !== false) provisionSqliteInbox(file);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Inbox', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Inbox',
      connection: owner,
      resources: {
        person: {},
        thread: { access: 'write' },
        post: {
          access: 'write',
          notify: [{ on: 'insert', to: 'thread_id.author_id', title: 'New reply in {thread_id.title}', opens: 'thread_id' }],
        },
        task: {
          access: 'write',
          actions: { close: { label: 'Close', set: { status: 'closed' } } },
          notify: [
            { on: { changes: 'assignee' }, to: 'assignee', title: 'Assigned to you: {title}' },
            { on: { action: 'close' }, to: 'assignee', title: '{title} was closed' },
          ],
        },
        /* A machine's edges are told by the verb that takes them or by the column they move, as any write is. */
        job: {
          access: 'write',
          machine: {
            column: 'status',
            states: { open: { on: { finish: { to: 'done' }, drop: { to: 'dropped' } } }, done: { final: true }, dropped: { final: true } },
          },
          notify: [
            { on: { action: 'finish' }, to: 'owner', title: '{title} is done' },
            { on: { changes: 'status' }, when: 'status = dropped', to: 'owner', title: '{title} was dropped' },
          ],
        },
      },
      auth: {
        me: { from: 'person', column: 'email' },
        roles: {
          member: { read: true, write: true },
          outsider: { read: ['person'] },
          // Reads threads but never a task's title.
          clerk: { read: true, write: true, fields: { task: { read: ['id', 'assignee', 'status'], write: ['assignee', 'status'] } } },
        },
      },
      views: { tasks: { kind: 'list', from: 'task' } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'inbox fixture',
  );
  let current: Person | null = 'ann';
  const host: AppHost = {
    app: { path: 'inbox-fixture.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => (current ? { ...people[current] } : null),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run({
      db,
      as: (person) => {
        current = person;
      },
      post: async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: appId, ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(owner);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const stored = (db: DatabaseSync) =>
  db
    .prepare(`SELECT recipient, resource, key_json, title, actor, actor_name, action, read_at FROM "${INBOX_TABLES.notice}" ORDER BY id`)
    .all()
    .map((row) => ({ ...row }));

test("a reply tells the thread's author, by the person row auth.me names, and never the person who wrote it", async () =>
  fixture(async ({ post, as, db }) => {
    as('bob');
    const reply = await post('/api/insert', {
      table: 'post',
      values: { thread_id: 1, author_id: 2, body: 'Use a fan.' },
      // A body cannot say who is told, or who wrote it.
      recipient: 'mallory@example.test',
      actor: 'mallory@example.test',
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.deepEqual(stored(db), [
      {
        recipient: 'ann@example.test',
        resource: 'thread',
        key_json: '{"id":1}',
        title: 'New reply in Solder fumes',
        actor: 'Bob@Example.test',
        actor_name: 'Bob Diaz',
        action: '',
        read_at: null,
      },
    ]);
    // Ann replying in her own thread tells nobody: she wrote it.
    as('ann');
    assert.equal((await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 1, body: 'Thanks!' } })).status, 200);
    assert.equal(stored(db).length, 1);

    const inbox = await post('/api/inbox', {});
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    assert.equal(inbox.body.unread, 1);
    assert.equal(inbox.body.notices.length, 1);
    assert.deepEqual(
      { ...inbox.body.notices[0], id: undefined, at: undefined },
      { id: undefined, at: undefined, title: 'New reply in Solder fumes', resource: 'thread', key: { id: 1 }, by: 'Bob Diaz', read: false },
    );
    // Bob's inbox is his own, and holds nothing.
    as('bob');
    const bobs = await post('/api/inbox', {});
    assert.deepEqual({ notices: bobs.body.notices, unread: bobs.body.unread }, { notices: [], unread: 0 });
  }));

test('a notice from a writer with no name kept says nobody by name, never their email', async () =>
  fixture(async ({ post, as, db }) => {
    as('cat');
    assert.equal((await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 3, body: 'Try flux.' } })).status, 200);
    assert.equal(stored(db)[0].actor_name, '');
    as('ann');
    const inbox = await post('/api/inbox', {});
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    assert.equal(inbox.body.notices.length, 1);
    assert.equal(inbox.body.notices[0].by, undefined);
    assert.doesNotMatch(JSON.stringify(inbox.body), /cat@example\.test/);
  }));

test('a write the database refuses tells nobody', async () =>
  fixture(async ({ post, as, db }) => {
    as('bob');
    const failed = await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 2, body: '' } });
    assert.equal(failed.body.outcome, 'rejected', JSON.stringify(failed.body));
    assert.equal(stored(db).length, 0);
  }));

test('an assignment tells the assignee; the same value again, or a column no rule watches, does not', async () =>
  fixture(async ({ post, as, db }) => {
    as('ann');
    const assigned = await post('/api/update', {
      table: 'task',
      key: { id: 1 },
      values: { assignee: 'bob@example.test' },
      expected: { assignee: null },
    });
    assert.equal(assigned.status, 200, JSON.stringify(assigned.body));
    assert.equal(
      (
        await post('/api/update', {
          table: 'task',
          key: { id: 1 },
          values: { assignee: 'bob@example.test' },
          expected: { assignee: 'bob@example.test' },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await post('/api/update', {
          table: 'task',
          key: { id: 1 },
          values: { title: 'Order more flux' },
          expected: { title: 'Order flux' },
        })
      ).status,
      200,
    );
    assert.deepEqual(
      stored(db).map((row) => [row.recipient, row.title]),
      [['bob@example.test', 'Assigned to you: Order flux']],
    );
    // An action by its id: Close tells the assignee, and says so by its label.
    const closed = await post('/api/update', { table: 'task', key: { id: 1 }, values: { status: 'closed' }, expected: { status: 'open' } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    assert.deepEqual(
      stored(db).map((row) => [row.recipient, row.title, row.action]),
      [
        ['bob@example.test', 'Assigned to you: Order flux', ''],
        ['bob@example.test', 'Order more flux was closed', 'Close'],
      ],
    );
    // The session's email is compared without its case: Bob@Example.test reads bob@example.test's notices.
    as('bob');
    const inbox = await post('/api/inbox', { limit: 1 });
    assert.equal(inbox.status, 200, JSON.stringify(inbox.body));
    assert.equal(inbox.body.unread, 2);
    assert.equal(inbox.body.notices.length, 1);
    assert.equal(inbox.body.notices[0].title, 'Order more flux was closed');
    const older = await post('/api/inbox', { limit: 1, before: inbox.body.more });
    assert.equal(older.body.notices[0].title, 'Assigned to you: Order flux');
  }));

test("a machine's edge tells by its verb or by the state it lands in", async () =>
  fixture(async ({ post, as, db }) => {
    as('ann');
    const move = (id: number, status: string) =>
      post('/api/update', { table: 'job', key: { id }, values: { status }, expected: { status: 'open' } });
    const finished = await move(1, 'done');
    assert.equal(finished.status, 200, JSON.stringify(finished.body));
    const dropped = await move(2, 'dropped');
    assert.equal(dropped.status, 200, JSON.stringify(dropped.body));
    assert.deepEqual(
      stored(db).map((row) => [row.recipient, row.title]),
      [
        ['bob@example.test', 'Reflow oven is done'],
        ['bob@example.test', 'Hot plate was dropped'],
      ],
    );
  }));

test("marking read touches the reader's own notices only", async () =>
  fixture(async ({ post, as, db }) => {
    as('bob');
    await post('/api/insert', { table: 'post', values: { thread_id: 1, author_id: 2, body: 'One' } });
    as('ann');
    await post('/api/update', { table: 'task', key: { id: 1 }, values: { assignee: 'bob@example.test' }, expected: { assignee: null } });
    const [annsNotice] = (await post('/api/inbox', {})).body.notices;
    as('bob');
    const bobsNotice = (await post('/api/inbox', {})).body.notices[0];
    // Bob naming Ann's notice marks nothing of hers.
    const foreign = await post('/api/inbox/read', { ids: [annsNotice.id] });
    assert.equal(foreign.status, 200);
    assert.equal(foreign.body.unread, 1);
    assert.equal(stored(db).find((row) => row.recipient === 'ann@example.test')!.read_at, null);
    const own = await post('/api/inbox/read', { ids: [bobsNotice.id] });
    assert.equal(own.body.unread, 0);
    assert.equal((await post('/api/inbox', {})).body.notices[0].read, true);
    // All read is all of the reader's, and still only theirs.
    as('ann');
    assert.equal((await post('/api/inbox/read', { all: true })).body.unread, 0);
    assert.equal(stored(db).filter((row) => row.read_at === null).length, 0);
    for (const bad of [
      {},
      { ids: [] },
      { ids: ['1'] },
      { all: true, ids: [1] },
      { all: 'yes' },
      { recipient: 'bob@example.test', all: true },
    ]) {
      assert.equal((await post('/api/inbox/read', bad)).status, 400, JSON.stringify(bad));
    }
  }));

test("a notice is shown only while its record is the reader's to read, and its words only while every column they came from is", async () =>
  fixture(async ({ post, as, db }) => {
    // Assigning a task to yourself tells nobody.
    as('ann');
    await post('/api/update', { table: 'task', key: { id: 1 }, values: { assignee: 'ann@example.test' }, expected: { assignee: null } });
    assert.equal(stored(db).length, 0);
    as('bob');
    await post('/api/update', { table: 'task', key: { id: 1 }, values: { assignee: null }, expected: { assignee: 'ann@example.test' } });
    await post('/api/update', { table: 'task', key: { id: 1 }, values: { assignee: 'ann@example.test' }, expected: { assignee: null } });
    assert.equal(stored(db).length, 1);
    // Every role below is Ann's session: the rule names her, and the reader decides what she sees of it.
    as('ann');
    assert.equal((await post('/api/inbox', {})).body.notices[0].title, 'Assigned to you: Order flux');
    // The clerk role reads the task but not its title: the notice is there, its words are not.
    as('clerk');
    const clerk = await post('/api/inbox', {});
    assert.equal(clerk.status, 200, JSON.stringify(clerk.body));
    assert.equal(clerk.body.notices[0].title, 'Something changed on a task');
    assert.doesNotMatch(JSON.stringify(clerk.body), /Order flux/);
    // An outsider reads no tasks: the notice is not theirs to see at all.
    as('outsider');
    const outsider = await post('/api/inbox', {});
    assert.equal(outsider.status, 200, JSON.stringify(outsider.body));
    assert.deepEqual({ notices: outsider.body.notices, unread: outsider.body.unread }, { notices: [], unread: 0 });
  }));

test('signed out there is no inbox, and a body naming a recipient is refused', async () =>
  fixture(async ({ post, as }) => {
    as('ann');
    for (const body of [
      { recipient: 'bob@example.test' },
      { who: 'bob@example.test' },
      { limit: 0 },
      { limit: 101 },
      { before: -1 },
      { unread: 'yes' },
    ]) {
      assert.equal((await post('/api/inbox', body)).status, 400, JSON.stringify(body));
    }
    as(null);
    assert.equal((await post('/api/inbox', {})).status, 401);
    assert.equal((await post('/api/inbox/read', { all: true })).status, 401);
  }));

test('an App that notifies over a database without the store is refused, naming the call that provisions it', async () =>
  fixture(
    async ({ post }) => {
      const reply = await post('/api/inbox', {});
      assert.ok(reply.status >= 400, JSON.stringify(reply.body));
      assert.match(JSON.stringify(reply.body), /provisionStores\(\{ sqlite: .*only: \['inbox'\]/);
    },
    { provision: false },
  ));
