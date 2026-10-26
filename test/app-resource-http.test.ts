import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal, history } from '../packages/engine/src/server/journal.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';

const originalName = 'public.customer and physical_customers are literal record text';

async function fixture(appMode: boolean, run: (base: string, db: DatabaseSync, host: AppHost) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-resource-http-'));
  const path = join(directory, 'fixture.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE physical_customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE physical_tickets (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL,
      customer_id INTEGER NOT NULL REFERENCES physical_customers(id)
    );
  `);
  db.prepare('INSERT INTO physical_customers VALUES (?, ?)').run(1, originalName);
  db.exec("INSERT INTO physical_tickets VALUES (7, 'Investigate public.customer', 1)");
  const registry = new Registry();
  clearJournal('resource-fixture');
  registry.add({ id: 'resource-fixture', name: 'Resource fixture', url: path, source: 'config', writable: true });
  const pages = parsePagesConfig({ pages: [{ label: 'Customer', base: 'customer' }] }, 'fixture');
  const host: AppHost = {
    app: {
      path: '/operator/resources/app.ts',
      app: {
        id: 'resources',
        name: 'Resource app',
        connection: 'resource-fixture',
        ui: {},
        home: [{ view: 'customer' }],
        resources: { customer: { physical: 'physical_customers', access: 'write' }, ticket: { physical: 'physical_tickets' } },
        views: { customer: { table: 'customer' }, ticket: { table: 'ticket' } },
        nav: [{ view: 'customer' }, { view: 'ticket' }],
      },
      pages,
      sources: {},
    },
    pages: [],
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, ...(appMode ? { apps: [host], pages } : {}) });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run(`http://${bound.host}:${bound.port}`, db, host);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal('resource-fixture');
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function request(base: string, path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${base}${path}`, {
    signal: AbortSignal.timeout(3_000),
    ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(json)}`);
  return json;
}

test('app HTTP metadata and relationship queries use resource identities without rewriting record text', { timeout: 10_000 }, async () => {
  await fixture(true, async (base) => {
    const schema = await request(base, '/api/schema');
    assert.deepEqual(schema.tables.map((table: { id: string }) => table.id).sort(), ['customer', 'ticket']);
    assert.deepEqual(schema.tables.map((table: { name: string }) => table.name).sort(), ['customer', 'ticket']);
    assert.ok(schema.tables.every((table: { schema: string }) => table.schema === ''));
    assert.equal(schema.foreignKeys[0].from.table, 'ticket');
    assert.equal(schema.foreignKeys[0].to.table, 'customer');

    const app = await request(base, '/api/app');
    assert.deepEqual(
      Object.values(app.app.views).map((view) => (view as { table: string }).table),
      ['customer', 'ticket'],
    );
    assert.ok(Object.values(app.app.views).every((view) => !(view as { error?: string }).error));
    assert.doesNotMatch(JSON.stringify(app.app.resources), /physical/, 'physical resource bindings are server-only');
    const pages = await request(base, '/api/pages');
    const page = pages.pages.find((entry: { base: string }) => entry.base === 'customer');
    assert.ok(page);
    assert.equal(page.error, undefined);

    const rows = await request(base, '/api/run', { q: 'customer show id, name' });
    assert.deepEqual(rows.errors, []);
    assert.equal(rows.table, 'customer');
    assert.deepEqual(rows.rows, [{ id: 1, name: originalName }]);

    const view = await request(base, '/api/view/run', { text: 'ticket show id, name, customer_id.name' });
    assert.deepEqual(view.errors, []);
    assert.equal(view.view.base, 'ticket');
    assert.deepEqual(view.rows, [{ id: 7, name: 'Investigate public.customer', 'customer_id.name': originalName }]);
    assert.doesNotMatch(JSON.stringify(view.resolved), /physical_customers|physical_tickets/);
  });
});

test('app resource writes reach the physical table while preserving logical write scope', { timeout: 10_000 }, async () => {
  await fixture(true, async (base, db) => {
    const updated = await request(base, '/api/update', {
      table: 'customer',
      key: { id: 1 },
      values: { name: 'Changed public.customer' },
      expected: { name: originalName },
    });
    assert.equal(updated.affected, 1);
    assert.equal(updated.undoId, undefined);
    assert.equal(db.prepare('SELECT name FROM physical_customers WHERE id = 1').get()?.name, 'Changed public.customer');

    const denied = await fetch(`${base}/api/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(3_000),
      body: JSON.stringify({ table: 'ticket', key: { id: 7 }, values: { name: 'Not allowed' } }),
    });
    assert.equal(denied.status, 403);
    await denied.text();
    assert.equal(db.prepare('SELECT name FROM physical_tickets WHERE id = 7').get()?.name, 'Investigate public.customer');
  });
});

test('standalone DB browser retains physical identities and querying without an app resource facade', { timeout: 10_000 }, async () => {
  await fixture(false, async (base) => {
    const schema = await request(base, '/api/schema');
    assert.deepEqual(schema.tables.map((table: { id: string }) => table.id).sort(), ['physical_customers', 'physical_tickets']);
    assert.equal(schema.foreignKeys[0].to.table, 'physical_customers');
    const rows = await request(base, '/api/run', { q: 'physical_customers show id, name' });
    assert.deepEqual(rows.errors, []);
    assert.equal(rows.table, 'physical_customers');
    assert.deepEqual(rows.rows, [{ id: 1, name: originalName }]);
    assert.ok(rows.sql, 'DB browser retains SQL diagnostics');
  });
});

test('a resource alias reload keeps writing the original table, and nothing is journaled', { timeout: 10_000 }, async () => {
  await fixture(true, async (base, db, host) => {
    const updated = await request(base, '/api/update', {
      table: 'customer',
      key: { id: 1 },
      values: { name: 'Saved before app reload' },
    });
    assert.equal(updated.affected, 1);
    assert.deepEqual(history('resource-fixture'), []);

    host.app.app = {
      ...host.app.app,
      resources: { client: { physical: 'physical_customers', access: 'write' }, ticket: { physical: 'physical_tickets' } },
      views: { client: { table: 'client' }, ticket: { table: 'ticket' } },
      nav: [{ view: 'client' }, { view: 'ticket' }],
    };
    for (const page of host.app.pages) if (page.base === 'customer') page.base = 'client';

    const schema = await request(base, '/api/schema');
    assert.deepEqual(schema.tables.map((table: { id: string }) => table.id).sort(), ['client', 'ticket']);
    assert.equal(schema.foreignKeys[0].to.table, 'client');
    const app = await request(base, '/api/app');
    assert.deepEqual(
      Object.values(app.app.views).map((view) => (view as { table: string }).table),
      ['client', 'ticket'],
    );
    assert.ok(Object.values(app.app.views).every((view) => !(view as { error?: string }).error));

    const saved = await request(base, '/api/update', { table: 'client', key: { id: 1 }, values: { name: 'Saved after app reload' } });
    assert.equal(saved.affected, 1);
    assert.equal(db.prepare('SELECT name FROM physical_customers WHERE id = 1').get()?.name, 'Saved after app reload');
    const rows = await request(base, '/api/run', { q: 'client show id, name' });
    assert.deepEqual(rows.rows, [{ id: 1, name: 'Saved after app reload' }]);
  });
});
