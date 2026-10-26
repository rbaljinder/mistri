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

/**
 * An editable list is a way of asking, never a permission. A cell's save and
 * each record of a "Set field…" are the request the grid sends —
 * `/api/update` with one value and what it replaces as `expected` — and the
 * server judges it as it judges a record form's Save: a field the reader's
 * grant does not write, a column the resource's machine gives to its
 * actions, and a value its validation refuses are each refused, and the row
 * keeps what it held. The same shape for a granted field lands.
 */
const appId = 'editable-grid';
const owner = 'editable-grid-db';
async function fixture(
  run: (f: {
    update: (values: Record<string, unknown>, expected: Record<string, unknown>, id?: number) => Promise<{ status: number; body: any }>;
    db: DatabaseSync;
    role: (role: string) => void;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-editable-http-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'open', note TEXT, owner TEXT);
    INSERT INTO task (id, title, note, owner) VALUES (1, 'First', 'kept', 'ann'), (2, 'Second', 'kept', 'ann');`);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Editable grid', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Editable grid',
      connection: owner,
      resources: {
        task: {
          access: 'write',
          machine: { column: 'state', states: { open: { on: { close: 'closed' } }, closed: { final: true } } },
          validation: [{ must: 'note is not empty', message: 'A task keeps a note.' }],
        },
      },
      auth: {
        roles: {
          clerk: {
            read: true,
            write: true,
            fields: { task: { read: ['id', 'title', 'state', 'note', 'owner'], write: ['title', 'note'] } },
          },
          lead: { read: true, write: true },
        },
      },
      views: { tasks: { kind: 'list', from: 'task', show: ['title', 'state', 'note', 'owner'], editable: true } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'editable fixture',
  );
  let currentRole = 'clerk';
  const host: AppHost = {
    app: { path: 'editable-fixture.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ id: 'account', who: 'person@example.test', role: currentRole }),
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
      update: async (values, expected, id = 1) => {
        const response = await fetch(`http://${bound.host}:${bound.port}/api/update`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          // Exactly the grid's shape (GridCellEditor.tsx, bulkActions.ts): one record, its values, what they replace.
          body: JSON.stringify({ app: appId, table: 'task', key: { id }, values, expected }),
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

const row = (db: DatabaseSync, id = 1) => ({ ...db.prepare('SELECT title, state, note, owner FROM task WHERE id = ?').get(id) });
const refused = (reply: { status: number; body: any }) =>
  reply.status >= 400 || reply.body?.outcome === 'rejected' || (Array.isArray(reply.body?.errors) && reply.body.errors.length > 0);

test('a granted cell lands as a record form save does', async () =>
  fixture(async ({ update, db }) => {
    const reply = await update({ title: 'Renamed' }, { title: 'First' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.affected, 1);
    assert.equal(row(db).title, 'Renamed');
  }));

test('a field the grant does not write is refused, and the row keeps it', async () =>
  fixture(async ({ update, db }) => {
    const before = row(db);
    const reply = await update({ owner: 'bob' }, { owner: 'ann' });
    assert.ok(refused(reply), JSON.stringify(reply.body));
    assert.deepEqual(row(db), before);
  }));

/* An update that is exactly an action's `set` is that action, and runs as it
   would from the record's action bar; a value no action sets is a move only
   an action may make, whatever the role. */
test('a column the machine owns is refused in a cell, for every role', async () =>
  fixture(async ({ update, db, role }) => {
    for (const who of ['clerk', 'lead']) {
      role(who);
      const reply = await update({ state: 'archived' }, { state: 'open' });
      assert.ok(refused(reply), `${who}: ${JSON.stringify(reply.body)}`);
      assert.equal(row(db).state, 'open');
    }
  }));

test("a value the resource's validation refuses is refused, naming the field", async () =>
  fixture(async ({ update, db }) => {
    const reply = await update({ note: null }, { note: 'kept' });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.outcome, 'rejected');
    assert.ok(JSON.stringify(reply.body.errors).includes('note'), JSON.stringify(reply.body));
    assert.equal(row(db).note, 'kept');
  }));

test('a stale expected value is refused rather than overwriting a newer one', async () =>
  fixture(async ({ update, db }) => {
    db.prepare("UPDATE task SET title = 'Changed elsewhere' WHERE id = 2").run();
    const reply = await update({ title: 'Mine' }, { title: 'Second' }, 2);
    assert.ok(refused(reply), JSON.stringify(reply.body));
    assert.equal(row(db, 2).title, 'Changed elsewhere');
  }));
