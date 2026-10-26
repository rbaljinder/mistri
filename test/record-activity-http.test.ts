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
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';
import { activityBounds } from '../packages/mistri/src/server/recordActivity.js';

/**
 * A dashboard's activity feed over HTTP (`/api/record-activity`): the newest
 * changes across the resources one `activity()` section names, answered for
 * the reader asking. Naming a resource in a feed turns its history on; a
 * change is said only about a record the reader can read now, a field their
 * grant leaves out or `audit.redact` names says only that it changed, and
 * what the feed reads is the section's list, never a list the request names.
 */
const appId = 'activity-http';
const owner = 'activity-http-db';

type Reply = { status: number; body: any };
async function fixture(
  run: (f: { post: (path: string, body: Record<string, unknown>) => Promise<Reply>; role: (role: string) => void }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-activity-http-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO person VALUES (1, 'Ann'), (2, 'Bob');
    CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      salary INTEGER, secret TEXT, owner_id INTEGER REFERENCES person(id));
    INSERT INTO task (id, title, salary, secret, owner_id) VALUES (1, 'First', 100, 'a', 1), (2, 'Second', 50, 'b', 2);
    CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
    INSERT INTO note VALUES (1, 'Kept apart');`);
  db.close();
  provisionSqliteRecordHistory(file);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Activity', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Activity',
      connection: owner,
      resources: {
        task: {
          access: 'write',
          recordLabel: 'title',
          audit: { redact: ['salary'] },
          actions: { close: { label: 'Close', set: { status: 'closed' } } },
        },
        person: { access: 'write', recordLabel: 'name' },
        note: { access: 'write' },
      },
      auth: {
        roles: {
          lead: { read: true, write: true },
          clerk: {
            read: true,
            write: true,
            fields: { task: { read: ['id', 'title', 'status', 'salary', 'owner_id'], write: ['title', 'status', 'salary', 'owner_id'] } },
          },
          outsider: { read: ['person'], write: false },
        },
      },
      views: {
        tasks: { kind: 'list', from: 'task', show: ['title', 'status'] },
        overview: {
          kind: 'dashboard',
          label: 'Overview',
          sections: [
            { kind: 'metric', title: 'Tasks', from: 'task' },
            { kind: 'activity', title: 'Latest', resources: { task: { icon: 'check-circle' }, person: { icon: 'user' } } },
          ],
        },
      },
      home: 'tasks',
      nav: ['tasks', 'overview'],
    },
    'activity fixture',
  );
  let currentRole = 'lead';
  const host: AppHost = {
    app: { path: 'activity-fixture.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      // The lead's account has a name; the clerk's is its address, which is never said as one.
      session: async () => ({
        id: `account-${currentRole}`,
        who: `${currentRole}@example.test`,
        role: currentRole,
        ...(currentRole === 'lead' ? { name: 'Lena Park' } : currentRole === 'clerk' ? { name: 'clerk@example.test' } : {}),
      }),
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
      role: (role) => {
        currentRole = role;
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
    rmSync(directory, { recursive: true, force: true });
  }
}

const feed = (post: (path: string, body: Record<string, unknown>) => Promise<Reply>, extra: Record<string, unknown> = {}) =>
  post('/api/record-activity', { view: 'overview', section: 1, period: 'today', ...extra });

test('a feed says the newest changes across its resources, each record by its name, who and what', async () =>
  fixture(async ({ post }) => {
    assert.equal(
      (await post('/api/update', { table: 'task', key: { id: 1 }, values: { status: 'closed' }, expected: { status: 'open' } })).status,
      200,
    );
    assert.equal(
      (await post('/api/update', { table: 'person', key: { id: 2 }, values: { name: 'Robert' }, expected: { name: 'Bob' } })).status,
      200,
    );
    // A resource no feed or page names keeps no history, whatever is written to it.
    assert.equal(
      (await post('/api/update', { table: 'note', key: { id: 1 }, values: { body: 'Changed' }, expected: { body: 'Kept apart' } })).status,
      200,
    );
    const reply = await feed(post);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const [person, task] = reply.body.entries;
    assert.equal(reply.body.entries.length, 2);
    assert.deepEqual(
      { table: person.table, label: person.label, by: person.by, kind: person.kind },
      { table: 'person', label: 'Robert', by: 'Lena Park', kind: 'update' },
    );
    assert.deepEqual(person.fields, [{ column: 'name', before: 'Bob', after: 'Robert' }]);
    assert.deepEqual({ label: task.label, action: task.action, key: task.key }, { label: 'First', action: 'Close', key: { id: 1 } });
    assert.doesNotMatch(JSON.stringify(reply.body), /Kept apart|Changed/);
    // The feed names the writer; the account's email never leaves the server.
    assert.doesNotMatch(JSON.stringify(reply.body), /@example\.test/);
  }));

test('a writer whose name is an address, or who has none, is nobody by name in the feed: never an email', async () =>
  fixture(async ({ post, role }) => {
    role('clerk');
    assert.equal(
      (await post('/api/update', { table: 'person', key: { id: 2 }, values: { name: 'Robert' }, expected: { name: 'Bob' } })).status,
      200,
    );
    role('lead');
    const reply = await feed(post);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.entries.length, 1);
    assert.equal(reply.body.entries[0].by, undefined);
    assert.equal(reply.body.entries[0].via, 'app');
    assert.doesNotMatch(JSON.stringify(reply.body), /@/);
  }));

test('a record the reader cannot read is not in their feed, and a field they may not read says only that it changed', async () =>
  fixture(async ({ post, role }) => {
    await post('/api/update', {
      table: 'task',
      key: { id: 1 },
      values: { salary: 150, secret: 'zebra-crossing' },
      expected: { salary: 100, secret: 'a' },
    });
    await post('/api/update', { table: 'person', key: { id: 1 }, values: { name: 'Anne' }, expected: { name: 'Ann' } });
    role('clerk');
    const clerk = await feed(post);
    assert.equal(clerk.status, 200, JSON.stringify(clerk.body));
    const task = clerk.body.entries.find((entry: any) => entry.table === 'task');
    assert.deepEqual(
      task.fields.find((f: any) => f.column === 'salary'),
      { column: 'salary', redacted: true },
    );
    const secret = task.fields.find((f: any) => f.column === 'secret');
    assert.equal(secret.hidden, true);
    assert.ok(!('before' in secret) && !('after' in secret));
    assert.doesNotMatch(JSON.stringify(clerk.body), /zebra-crossing|150/);
    // An outsider reads people and nothing of tasks: the task's change, its name and that it happened stay on the server.
    role('outsider');
    const outsider = await feed(post);
    assert.equal(outsider.status, 200, JSON.stringify(outsider.body));
    assert.deepEqual(
      outsider.body.entries.map((entry: any) => entry.table),
      ['person'],
    );
    assert.doesNotMatch(JSON.stringify(outsider.body), /First|zebra/);
  }));

test('the feed reads the section it names and nothing else: another section, view or list of resources is refused or ignored', async () =>
  fixture(async ({ post }) => {
    await post('/api/update', { table: 'note', key: { id: 1 }, values: { body: 'Changed' }, expected: { body: 'Kept apart' } });
    for (const wrong of [{ section: 0 }, { section: 7 }, { section: '1' }, { view: 'tasks' }, { view: 'nope' }, { view: '__proto__' }]) {
      const reply = await feed(post, wrong);
      assert.ok(reply.status >= 400, `${JSON.stringify(wrong)} ${JSON.stringify(reply.body)}`);
    }
    // Resources the request names are not the section's: the section says what it reads.
    const asked = await feed(post, { resources: ['note'], table: 'note' });
    assert.equal(asked.status, 200);
    assert.doesNotMatch(JSON.stringify(asked.body), /note|Kept apart|Changed/);
    // A period it does not offer is refused, not widened to all time.
    assert.equal((await feed(post, { period: 'forever' })).status, 400);
    assert.equal((await feed(post, { period: undefined })).status, 400);
  }));

test("a period is the App's own day: today from its midnight, yesterday the day before, this week from its first day", () => {
  // 2026-09-23 is a Wednesday; 17:00 UTC is 10:00 in Los Angeles.
  const now = new Date('2026-09-23T17:00:00.000Z');
  const ui = { timezone: 'America/Los_Angeles', locale: 'en-US' };
  assert.deepEqual(activityBounds('today', ui, now), { from: '2026-09-23T07:00:00.000Z' });
  assert.deepEqual(activityBounds('yesterday', ui, now), { from: '2026-09-22T07:00:00.000Z', to: '2026-09-23T07:00:00.000Z' });
  // A US week starts on Sunday; a British one on Monday.
  assert.deepEqual(activityBounds('week', ui, now), { from: '2026-09-20T07:00:00.000Z' });
  assert.deepEqual(activityBounds('week', { timezone: 'Europe/London', locale: 'en-GB' }, now), { from: '2026-09-20T23:00:00.000Z' });
  // Past a change of clocks the day still starts at its own midnight.
  assert.deepEqual(activityBounds('yesterday', ui, new Date('2026-11-02T17:00:00.000Z')), {
    from: '2026-11-01T07:00:00.000Z',
    to: '2026-11-02T08:00:00.000Z',
  });
  assert.throws(() => activityBounds('month', ui, now), /today, yesterday, week/);
});

test('the store leaves out deletes, and every change of a key made before that key was deleted', async () => {
  const { appendSqliteRecordChange, readSqliteRecordActivity } =
    await import('../packages/mistri/src/adapters/history/sqliteRecordHistory.js');
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-activity-store-'));
  const file = join(directory, 'store.db');
  new DatabaseSync(file).close();
  provisionSqliteRecordHistory(file);
  const db = new DatabaseSync(file);
  try {
    const row = (id: string, at: string, kind: 'insert' | 'update' | 'delete', resource = 'task') =>
      appendSqliteRecordChange(db, {
        writeId: `${resource}-${id}-${at}`,
        at,
        resource,
        key: JSON.stringify({ id }),
        kind,
        changes: [],
        actor: '',
        actorName: '',
        via: 'app',
        action: '',
      });
    row('1', '2026-09-20T10:00:00.000Z', 'insert');
    row('1', '2026-09-21T10:00:00.000Z', 'delete');
    row('1', '2026-09-22T10:00:00.000Z', 'insert');
    row('2', '2026-09-22T11:00:00.000Z', 'update');
    row('3', '2026-09-22T12:00:00.000Z', 'update', 'secret');
    const read = readSqliteRecordActivity(db, { resources: ['task'], limit: 10 });
    assert.deepEqual(
      read.map((each) => [each.key, each.at]),
      [
        ['{"id":"2"}', '2026-09-22T11:00:00.000Z'],
        ['{"id":"1"}', '2026-09-22T10:00:00.000Z'],
      ],
    );
    const bounded = readSqliteRecordActivity(db, {
      resources: ['task'],
      limit: 10,
      from: '2026-09-22T10:30:00.000Z',
      to: '2026-09-23T00:00:00.000Z',
    });
    assert.deepEqual(
      bounded.map((each) => each.key),
      ['{"id":"2"}'],
    );
    assert.throws(
      () => readSqliteRecordActivity(db, { resources: ['task'], limit: 10, from: "2026-09-22' OR 1=1" }),
      /Invalid record activity read/,
    );
    assert.throws(() => readSqliteRecordActivity(db, { resources: [], limit: 10 }), /Invalid record activity read/);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
