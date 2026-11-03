/**
 * Undo's outcomes. The engine's `revert` (journal.ts) says what happened to a
 * recorded write — applied, not applied, or unknown — and holds a pending or
 * unknown Undo as a barrier the history never reaches past. A product with Undo
 * (the database browser, in its own repository) answers its HTTP and agent
 * Undo from it; an App has none, and refuses one without entering a write.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { TransactionOutcomeUnknown, type Adapter } from '../packages/engine/src/adapters/adapter.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history, lastRevertible, recordWrite, revert } from '../packages/engine/src/server/journal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

async function fixture(access: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-undo-outcomes-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE lead (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO lead VALUES (1,'saved')");
  const registry = new Registry();
  const connection = 'undo-outcomes';
  registry.add({ id: connection, name: connection, url: file, source: 'config', writable: true });
  const { adapter } = await registry.open(connection);
  const definition = parseAppConfig(
    {
      id: 'undo-app',
      name: 'Undo App',
      connection,
      resources: { lead: { access: 'write' } },
      auth: { roles: { operator: { read: true, write: true, fields: { lead: { read: ['id', 'name'], write: ['name'] } } } } },
      views: { leads: { kind: 'list', from: 'lead' } },
      home: 'leads',
      nav: ['leads'],
    },
    'undo fixture',
  );
  const host: AppHost = {
    app: { path: 'undo-fixture.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ id: 'alice', who: 'alice@example.test', role: 'operator' }),
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, ...(access ? { apps: [host] } : {}) });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  return {
    registry,
    adapter,
    connection,
    record: () =>
      recordWrite(connection, {
        kind: 'update',
        summary: 'Rename lead',
        revertible: true,
        ...(access ? { principal: 'alice', app: 'undo-app' } : {}),
        steps: [{ table: 'lead', key: { id: 1 }, before: { name: 'before' }, after: { name: 'saved' } }],
      }),
    call: async (body: object = {}) => {
      const response = await fetch(`http://${bound.host}:${bound.port}/api/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ ...(access ? { app: 'undo-app' } : { conn: connection }), ...body }),
      });
      return { status: response.status, body: (await response.json()) as any };
    },
    close: async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      clearJournal(connection);
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('revert returns applied, then not_applied for a write it already took back', async () => {
  const f = await fixture(false);
  try {
    const entry = f.record();
    const done = await revert(f.adapter, f.connection, entry);
    assert.equal(done.reverted, true);
    assert.equal(done.outcome, 'applied');
    assert.equal(lastRevertible(f.connection), undefined);
    const again = await revert(f.adapter, f.connection, entry);
    assert.equal(again.reverted, false);
    assert.equal(again.outcome, 'not_applied');
  } finally {
    await f.close();
  }
});

test('an App refuses Undo without entering a write transaction', async (t) => {
  const f = await fixture(true);
  try {
    const entry = f.record();
    const transaction = t.mock.method(f.adapter as Adapter & Required<Pick<Adapter, 'transaction'>>, 'transaction', async () =>
      assert.fail('App Undo must not run'),
    );
    assert.equal((await f.call({ confirm: true, expectedId: entry.id })).status, 404);
    assert.equal(transaction.mock.callCount(), 0);
  } finally {
    await f.close();
  }
});

test("revert words an unknown outcome without the database's message, and holds pending and unknown as history barriers", async (t) => {
  const f = await fixture(false);
  try {
    f.record();
    const entry = f.record();
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    t.mock.method(f.adapter as Adapter & Required<Pick<Adapter, 'transaction'>>, 'transaction', async () => {
      entered();
      await held;
      throw new TransactionOutcomeUnknown('PRIVATE_DATABASE_SENTINEL');
    });
    const undo = revert(f.adapter, f.connection, entry);
    await Promise.race([started, undo.then(() => assert.fail('Undo returned without entering its transaction'))]);
    try {
      assert.equal(history(f.connection)[0].undoState, 'pending');
      assert.equal(lastRevertible(f.connection), undefined);
      const twice = await revert(f.adapter, f.connection, entry);
      assert.equal(twice.outcome, 'unknown');
      assert.match(twice.errors![0], /already in progress/);
    } finally {
      finish();
    }
    const result = await undo;
    assert.equal(result.reverted, false);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.steps, undefined);
    assert.match(result.errors![0], /could not be confirmed/);
    assert.doesNotMatch(JSON.stringify(result.errors), /PRIVATE_DATABASE_SENTINEL/);
    const [unknown] = history(f.connection);
    assert.equal(unknown.undoState, 'unknown');
    assert.equal(unknown.revertible, false);
    assert.equal(lastRevertible(f.connection), undefined);
    const newer = f.record();
    assert.equal(lastRevertible(f.connection)?.id, newer.id);
  } finally {
    await f.close();
  }
});
