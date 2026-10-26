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
import type { PageDef } from '../packages/engine/src/shared/pageModel.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';

/**
 * A record's history over HTTP, as the page's history section asks for it.
 * Every write is recorded whichever door it came through, attributed to the
 * verified account and never to a body; the answer is the reader's: a field
 * their grant does not read, or one `audit.redact` names, says that it
 * changed and nothing else, and a record they cannot read has no history
 * for them at all.
 */
const appId = 'history-http';
const owner = 'history-http-db';

type Reply = { status: number; body: any };
async function fixture(
  run: (f: {
    post: (path: string, body: Record<string, unknown>) => Promise<Reply>;
    role: (role: string) => void;
    db: DatabaseSync;
  }) => Promise<void>,
  options: { provision?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-history-http-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO person VALUES (1, 'Ann'), (2, 'Bob');
    CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      salary INTEGER, secret TEXT, owner_id INTEGER REFERENCES person(id), version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO task (id, title, salary, secret, owner_id) VALUES (1, 'First', 100, 'a', 1);`);
  if (options.provision !== false) provisionSqliteRecordHistory(file);
  const registry = new Registry();
  registry.add({ id: owner, name: 'History', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'History',
      connection: owner,
      resources: {
        task: { access: 'write', audit: { redact: ['salary'] }, actions: { close: { label: 'Close', set: { status: 'closed' } } } },
        person: {},
      },
      auth: {
        roles: {
          lead: { read: true, write: true },
          clerk: {
            read: true,
            write: true,
            fields: { task: { read: ['id', 'title', 'status', 'salary', 'owner_id'], write: ['title', 'status', 'salary', 'owner_id'] } },
          },
          outsider: { read: ['person'] },
        },
      },
      views: { tasks: { kind: 'list', from: 'task', show: ['title', 'status'] } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'history fixture',
  );
  const pages: PageDef[] = [{ id: 'task', name: 'Task', base: 'task', sections: [{ kind: 'history' }] }];
  let currentRole = 'lead';
  const host: AppHost = {
    app: { path: 'history-fixture.ts', app: definition, pages, sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({
        id: `account-${currentRole}`,
        who: `${currentRole}@example.test`,
        role: currentRole,
        ...(currentRole === 'lead' ? { name: 'Lena Park' } : {}),
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
      db,
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
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const readHistory = (post: (path: string, body: Record<string, unknown>) => Promise<Reply>, id = 1) =>
  post('/api/record-history', { table: 'task', key: { id } });

test('a Save is recorded as the signed-in account, with the action it matched and each field from what to what', async () =>
  fixture(async ({ post, db }) => {
    const saved = await post('/api/update', {
      table: 'task',
      key: { id: 1 },
      values: { title: 'Renamed', owner_id: 2 },
      expected: { title: 'First', owner_id: 1 },
      // A body cannot say who made a write: the verified session does.
      actor: 'forged@example.test',
      via: 'agent',
      action: 'Forged',
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const closed = await post('/api/update', { table: 'task', key: { id: 1 }, values: { status: 'closed' }, expected: { status: 'open' } });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
    const reply = await readHistory(post);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const [close, edit] = reply.body.entries;
    assert.equal(reply.body.entries.length, 2);
    assert.deepEqual(
      { by: close.by, via: close.via, action: close.action, kind: close.kind },
      { by: 'Lena Park', via: 'app', action: 'Close', kind: 'update' },
    );
    assert.deepEqual(close.fields, [{ column: 'status', before: 'open', after: 'closed' }]);
    assert.equal(edit.by, 'Lena Park');
    assert.equal(edit.action, undefined);
    assert.deepEqual(
      edit.fields.find((f: any) => f.column === 'owner_id'),
      { column: 'owner_id', before: 1, after: 2 },
    );
    assert.doesNotMatch(JSON.stringify(reply.body), /forged|Forged/);
    // Who the write is attributed to is kept, as the account; a reader is told the name, never the email.
    assert.doesNotMatch(JSON.stringify(reply.body), /@example\.test/);
    assert.deepEqual(
      db
        .prepare('SELECT DISTINCT actor, actor_name FROM __mistri_history_change')
        .all()
        .map((row) => ({ ...row })),
      [{ actor: 'lead@example.test', actor_name: 'Lena Park' }],
    );
  }));

test('a writer the store keeps no name for is "someone" to every reader: the account\'s email is never answered', async () =>
  fixture(async ({ post, role }) => {
    role('clerk');
    const saved = await post('/api/update', {
      table: 'task',
      key: { id: 1 },
      values: { title: 'By the clerk' },
      expected: { title: 'First' },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    for (const reader of ['clerk', 'lead']) {
      role(reader);
      const reply = await readHistory(post);
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.entries[0].by, undefined);
      assert.equal(reply.body.entries[0].via, 'app');
      assert.doesNotMatch(JSON.stringify(reply.body), /@example\.test/);
    }
  }));

test('a redacted field and one the reader may not read say that they changed, never their values', async () =>
  fixture(async ({ post, db, role }) => {
    const saved = await post('/api/update', {
      table: 'task',
      key: { id: 1 },
      values: { salary: 150, secret: 'zebra-crossing' },
      expected: { salary: 100, secret: 'a' },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    // The store itself never held the redacted values.
    const stored = JSON.stringify(db.prepare('SELECT changes_json FROM __mistri_history_change').all());
    assert.doesNotMatch(stored, /150/);
    assert.match(stored, /zebra-crossing/);
    role('clerk');
    const reply = await readHistory(post);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const fields = reply.body.entries[0].fields;
    assert.deepEqual(
      fields.find((f: any) => f.column === 'salary'),
      { column: 'salary', redacted: true },
    );
    const secret = fields.find((f: any) => f.column === 'secret');
    assert.equal(secret.hidden, true);
    assert.ok(!('before' in secret) && !('after' in secret));
    assert.doesNotMatch(JSON.stringify(reply.body), /zebra-crossing|"a"/);
  }));

test('what is plumbing is not said: the revision column, and on a creation the columns the reader cannot read', async () =>
  fixture(async ({ post, role }) => {
    const created = await post('/api/insert', { table: 'task', values: { id: 2, title: 'Second', secret: 'kept', version: 0 } });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const bumped = await post('/api/update', {
      table: 'task',
      key: { id: 2 },
      values: { title: 'Second, renamed', secret: 'moved', version: 1 },
      expected: { title: 'Second', secret: 'kept', version: 0 },
    });
    assert.equal(bumped.status, 200, JSON.stringify(bumped.body));
    role('clerk');
    const reply = await readHistory(post, 2);
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const [edit, creation] = reply.body.entries;
    assert.equal(creation.kind, 'insert');
    assert.deepEqual(creation.fields.map((f: any) => f.column).sort(), ['status', 'title']);
    // An update still says that a field the reader cannot read changed; the revision it advanced, never.
    assert.deepEqual(
      edit.fields.map((f: any) => [f.column, f.hidden ?? false]),
      [
        ['title', false],
        ['secret', true],
      ],
    );
  }));

test('a record the reader cannot read has no history for them, and one never shown has none to read', async () =>
  fixture(async ({ post, role }) => {
    await post('/api/update', { table: 'task', key: { id: 1 }, values: { title: 'Renamed' }, expected: { title: 'First' } });
    role('outsider');
    const hidden = await readHistory(post);
    assert.ok(hidden.status >= 400, JSON.stringify(hidden.body));
    assert.doesNotMatch(JSON.stringify(hidden.body), /Renamed|First/);
    role('lead');
    const absent = await readHistory(post, 99);
    assert.ok(absent.status >= 400, JSON.stringify(absent.body));
    // A resource whose page shows no history keeps none, and reading it is refused alike.
    const person = await post('/api/record-history', { table: 'person', key: { id: 1 } });
    assert.ok(person.status >= 400, JSON.stringify(person.body));
    // A key that is not exactly the record's is refused, not widened.
    const loose = await post('/api/record-history', { table: 'task', key: { id: 1, title: 'x' } });
    assert.ok(loose.status >= 400, JSON.stringify(loose.body));
  }));

test('an App showing a history over a database without the store is refused, naming the call that provisions it', async () =>
  fixture(
    async ({ post }) => {
      const reply = await readHistory(post);
      assert.ok(reply.status >= 400, JSON.stringify(reply.body));
      assert.match(JSON.stringify(reply.body), /provisionStores\(\{ sqlite: .*only: \['record-history'\]/);
    },
    { provision: false },
  ));
