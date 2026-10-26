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
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { PageDef } from '../packages/engine/src/shared/pageModel.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';

/**
 * An App has no Undo (WR1). Its writes run side by side on a writer pool
 * (packages/engine/src/adapters/writeLanes.ts), so "the last write" is not one thing to take
 * back, and a save is corrected by another save. Over HTTP: a creation, an
 * edit and a deletion carry no undo id, nothing is journaled, /api/revert
 * answers that there is no Undo, and the record's own history still keeps
 * every change. What protects an edit instead is its expected values: a save
 * on a row someone changed since is refused, not written over theirs.
 *
 * The database browser keeps its Undo: record-write-operations-http and
 * record-write-inverse hold it.
 */
const appId = 'no-undo';
const owner = 'no-undo-db';

type Reply = { status: number; body: any };
type Post = (path: string, body: Record<string, unknown>) => Promise<Reply>;
async function fixture(
  run: (f: { post: Post; as: (account: string, role?: string) => void; db: DatabaseSync }) => Promise<void>,
  options: { declareStep?: boolean; signIn?: boolean } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-record-undo-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    INSERT INTO task (id, title) VALUES (1, 'First'), (2, 'Second');
    CREATE TABLE step (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE, title TEXT NOT NULL);
    INSERT INTO step VALUES (1, 2, 'Only step');`);
  provisionSqliteRecordHistory(file);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Undo', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Undo',
      connection: owner,
      resources: { task: { access: 'write', delete: true }, ...(options.declareStep === false ? {} : { step: { access: 'write' } }) },
      ...(options.signIn === false ? {} : { auth: { roles: { lead: { read: true, write: true }, reader: { read: true } } } }),
      views: { tasks: { kind: 'list', from: 'task', show: ['title', 'status'] } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'undo fixture',
  );
  const pages: PageDef[] = [{ id: 'task', name: 'Task', base: 'task', sections: [{ kind: 'history' }] }];
  let account = 'ann',
    role = 'lead';
  const host: AppHost = {
    app: { path: 'undo-fixture.ts', app: definition, pages, sources: {} },
    pages: [],
    ...(options.signIn === false
      ? {}
      : {
          auth: {
            spec: definition.auth!,
            store: 'not-used',
            handler: async () => {},
            close: async () => {},
            session: async () => ({ id: `account-${account}`, who: `${account}@example.test`, role, name: account }),
          },
        }),
  } as AppHost;
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
      as: (who, as = 'lead') => {
        account = who;
        role = as;
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

test("an App's creation, edit and deletion carry no Undo and journal nothing; the record's history keeps each", async () =>
  fixture(async ({ post, db }) => {
    const added = await post('/api/insert', { table: 'task', values: { title: 'Fresh' } });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.undoId, undefined);
    const id = added.body.key.id;
    const edited = await post('/api/update', {
      table: 'task',
      key: { id: String(id) },
      values: { title: 'Renamed' },
      expected: { title: 'Fresh' },
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.undoId, undefined);
    assert.equal(db.prepare('SELECT title FROM task WHERE id = ?').get(id)!.title, 'Renamed');
    const deleted = await post('/api/delete', { table: 'task', key: { id: 1 }, confirm: true });
    assert.equal(deleted.body.deleted, true, JSON.stringify(deleted.body));
    assert.equal(deleted.body.undoId, undefined);
    assert.deepEqual(history(owner, 50), []);

    const record = await post('/api/record-history', { table: 'task', key: { id } });
    assert.equal(record.status, 200, JSON.stringify(record.body));
    assert.deepEqual(
      record.body.entries.map((entry: { by: string; via: string }) => [entry.by, entry.via]),
      [
        ['ann', 'app'],
        ['ann', 'app'],
      ],
    );
  }));

test('/api/revert says an App has no Undo, previewed or confirmed', async () =>
  fixture(async ({ post, db }) => {
    await post('/api/delete', { table: 'task', key: { id: 1 }, confirm: true });
    for (const body of [{}, { confirm: true, expectedId: 1 }]) {
      const reply = await post('/api/revert', body);
      assert.equal(reply.status, 404, JSON.stringify(reply.body));
      assert.equal(reply.body.error, 'An App has no Undo.');
    }
    assert.equal(db.prepare('SELECT count(*) AS n FROM task WHERE id = 1').get()!.n, 0);
  }));

test('a save on a row someone changed since is refused, not written over theirs', async () =>
  fixture(async ({ post, db }) => {
    db.prepare('UPDATE task SET title = ? WHERE id = 2').run('Changed elsewhere');
    const stale = await post('/api/update', { table: 'task', key: { id: 2 }, values: { title: 'Mine' }, expected: { title: 'Second' } });
    assert.equal(stale.status, 409, JSON.stringify(stale.body));
    assert.equal(db.prepare('SELECT title FROM task WHERE id = 2').get()!.title, 'Changed elsewhere');
    const fresh = await post('/api/update', {
      table: 'task',
      key: { id: 2 },
      values: { title: 'Mine' },
      expected: { title: 'Changed elsewhere' },
    });
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal(db.prepare('SELECT title FROM task WHERE id = 2').get()!.title, 'Mine');
  }));

/* An App's catalog is its declared tables; the database's cascade reaches
   further. The access layer judges a deletion on the connection's whole
   catalog and refuses one that would reach an undeclared table before it
   runs, whatever rows the reference holds. */
for (const signIn of [true, false]) {
  test(`a deletion that would cascade into a table the App does not declare is refused before it runs and names nothing (sign-in ${signIn})`, async () =>
    fixture(
      async ({ post, db }) => {
        const deleted = await post('/api/delete', { table: 'task', key: { id: 2 }, confirm: true });
        assert.notEqual(deleted.body.deleted, true, JSON.stringify(deleted.body));
        assert.equal(db.prepare('SELECT count(*) AS n FROM step').get()!.n, 1);
        assert.equal(db.prepare('SELECT count(*) AS n FROM task WHERE id = 2').get()!.n, 1);
        assert.doesNotMatch(JSON.stringify(deleted.body), /step/i);
        // The reference, not its count, is what refuses: a task nothing points at is not deleted either.
        const alone = await post('/api/delete', { table: 'task', key: { id: 1 }, confirm: true });
        assert.notEqual(alone.body.deleted, true, JSON.stringify(alone.body));
        assert.equal(db.prepare('SELECT count(*) AS n FROM task WHERE id = 1').get()!.n, 1);
      },
      { declareStep: false, signIn },
    ));
}
