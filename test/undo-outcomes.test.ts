// test-package: shared — holds the database browser and the App framework to one rule (scripts/test-owners.mjs).
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
import { agentTools, runTool, setAdvertiseOutputSchema, setElicitor } from '../packages/tablewalk/src/server/mcp.js';
import { clearJournal, history, recordWrite } from '../packages/engine/src/server/journal.js';
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

test('HTTP returns applied and not_applied, including the expected-ID precondition', async () => {
  const f = await fixture(false);
  try {
    const entry = f.record();
    const stale = await f.call({ confirm: true, expectedId: entry.id + 1 });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.outcome, 'not_applied');
    const done = await f.call({ confirm: true, expectedId: entry.id });
    assert.equal(done.body.reverted, true);
    assert.equal(done.body.outcome, 'applied');
    const empty = await f.call({ confirm: true });
    assert.equal(empty.body.reverted, false);
    assert.equal(empty.body.outcome, 'not_applied');
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

test('Workbench HTTP preserves sanitized unknown feedback and pending/unknown history barriers', async (t) => {
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
    const undo = f.call({ confirm: true, expectedId: entry.id });
    await Promise.race([started, undo.then(() => assert.fail('Undo returned without entering its transaction'))]);
    try {
      const pending = await f.call();
      assert.equal(pending.body.next, undefined);
      assert.equal(pending.body.writes[0].undoState, 'pending');
    } finally {
      finish();
    }
    const result = await undo;
    assert.equal(result.body.reverted, false);
    assert.equal(result.body.outcome, 'unknown');
    assert.equal(result.body.steps, undefined);
    assert.match(result.body.errors[0].message, /could not be confirmed/);
    assert.doesNotMatch(JSON.stringify(result.body), /PRIVATE_DATABASE_SENTINEL|current permissions/);
    const unknown = await f.call();
    assert.equal(unknown.body.next, undefined);
    assert.equal(unknown.body.writes[0].undoState, 'unknown');
    assert.equal(unknown.body.writes[0].revertible, false);
    const newer = f.record();
    assert.equal((await f.call()).body.next.id, newer.id);
  } finally {
    await f.close();
  }
});

test('MCP exposes outcome and undoState schemas, returns unknown and withholds older Undo', async (t) => {
  const f = await fixture(false);
  try {
    setAdvertiseOutputSchema(true);
    const tool = agentTools(f.registry).find((item) => item.name === 'revert') as any;
    assert.deepEqual(tool.outputSchema.properties.outcome.enum, ['applied', 'not_applied', 'unknown']);
    assert.deepEqual(tool.outputSchema.properties.writes.items.properties.undoState.enum, ['pending', 'unknown']);
    const call = async (expectedId?: number) => {
      const reply = await runTool(f.registry, 'revert', {
        connection: f.connection,
        ...(expectedId === undefined ? {} : { confirm: true, expectedId }),
      });
      assert.equal(reply.isError, false, JSON.stringify(reply));
      return reply.structuredContent as any;
    };
    f.record();
    assert.equal((await call((await call()).next.id)).outcome, 'applied');
    f.record();
    f.record();
    // The successful Undo changed the stored name; make the next preflight valid.
    await f.adapter.update!({ table: 'lead', key: { id: 1 }, values: { name: 'saved' } });
    t.mock.method(f.adapter as Adapter & Required<Pick<Adapter, 'transaction'>>, 'transaction', async () => {
      throw new TransactionOutcomeUnknown('PRIVATE_DATABASE_SENTINEL');
    });
    const expectedId = (await call()).next.id;
    const result = await call(expectedId);
    assert.equal(result.reverted, false);
    assert.equal(result.outcome, 'unknown');
    assert.equal(result.steps, undefined);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_DATABASE_SENTINEL/);
    const listed = await call();
    assert.equal(listed.next, undefined);
    assert.equal(listed.writes[0].undoState, 'unknown');
    assert.equal(history(f.connection).length, 2);
    assert.equal((await call(expectedId)).outcome, 'not_applied');
  } finally {
    setAdvertiseOutputSchema(false);
    await f.close();
  }
});

test('HTTP and MCP reject missing, invalid and stale tokens before any mutation, including after a lost success response', async (t) => {
  const f = await fixture(false);
  try {
    // These two inverse steps can both run in order; retrying the first ID must
    // not silently execute the older inverse once the first entry is forgotten.
    const older = recordWrite(f.connection, {
      kind: 'update',
      summary: 'Older rename',
      revertible: true,
      steps: [{ table: 'lead', key: { id: 1 }, before: { name: 'original' }, after: { name: 'before' } }],
    });
    const latest = f.record();
    const transaction = t.mock.method(f.adapter as Adapter & Required<Pick<Adapter, 'transaction'>>, 'transaction');
    for (const expectedId of [undefined, null, 0, -1, 1.5, '2', true, {}, [], Number.MAX_SAFE_INTEGER + 1]) {
      const http = await f.call({ confirm: true, expectedId });
      assert.equal(http.status, 400);
      assert.equal(http.body.outcome, 'not_applied');
      const mcp = await runTool(f.registry, 'revert', { connection: f.connection, confirm: true, expectedId });
      assert.ok(mcp.isError || mcp.structuredContent?.outcome === 'not_applied');
    }
    assert.equal(transaction.mock.callCount(), 0);
    const mcp = async (expectedId: number) =>
      (
        await runTool(f.registry, 'revert', {
          connection: f.connection,
          confirm: true,
          expectedId,
        })
      ).structuredContent!;
    assert.equal((await mcp(older.id)).outcome, 'not_applied');
    assert.equal((await f.call({ confirm: true, expectedId: older.id })).status, 409);
    assert.equal(transaction.mock.callCount(), 0);
    assert.equal((await f.call({ confirm: true, expectedId: latest.id })).body.outcome, 'applied');
    assert.equal((await f.call()).body.next.id, older.id);
    assert.equal((await f.call({ confirm: true, expectedId: latest.id })).status, 409);
    assert.equal((await mcp(latest.id)).outcome, 'not_applied');
    assert.equal(transaction.mock.callCount(), 1);
    const newer = f.record();
    assert.equal((await mcp(latest.id)).outcome, 'not_applied');
    assert.equal((await f.call({ confirm: true, expectedId: latest.id })).status, 409);
    assert.equal(transaction.mock.callCount(), 1);
    assert.equal((await f.call()).body.next.id, newer.id);
  } finally {
    await f.close();
  }
});

test('MCP preview never writes or elicits; a matching captured ID is required even with elicitation enabled', async (t) => {
  const f = await fixture(false);
  try {
    const entry = f.record();
    const elicit = t.mock.fn(async () => true);
    setElicitor(elicit);
    const preview = (await runTool(f.registry, 'revert', { connection: f.connection })).structuredContent!;
    assert.equal(preview.reverted, false);
    assert.deepEqual(
      history(f.connection).map((item) => item.id),
      [entry.id],
    );
    assert.match(String(preview.note), /expectedId/);
    assert.equal(elicit.mock.callCount(), 0);
    const undone = await runTool(f.registry, 'revert', {
      connection: f.connection,
      confirm: true,
      expectedId: (preview.next as { id: number }).id,
    });
    assert.equal(undone.structuredContent?.outcome, 'applied');
    assert.equal(elicit.mock.callCount(), 0);
  } finally {
    setElicitor(null);
    await f.close();
  }
});
