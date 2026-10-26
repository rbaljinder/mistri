/**
 * A New form's `today`, `now` and `me` defaults are the server's, not only the
 * browser's: a plain create over /api/insert that leaves the column out gets
 * them, and one that names a column the form does not ask for has it written
 * over, so nobody files a request as someone else. A column the form shows is
 * the person's to change, and what they send stands.
 */
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
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const me = { auto: 'me' };
const today = { auto: 'today' };
const appId = 'intake';
const owner = 'intake-db';

test('a plain create is given its form defaults by the server, and a hidden one is written over', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-form-default-stamps-'));
  const file = join(directory, 'intake.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
    INSERT INTO person VALUES (7, 'ann@example.test'), (8, 'bob@example.test');
    CREATE TABLE request (id INTEGER PRIMARY KEY, title TEXT NOT NULL, filed_by TEXT, owner_id INTEGER REFERENCES person(id),
      filed_on DATE, due_on DATE);`);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Intake', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Intake',
      connection: owner,
      ui: { timezone: 'America/Los_Angeles' },
      resources: {
        person: {},
        request: {
          access: 'write',
          form: { show: ['title', 'due_on'], defaults: { filed_by: me, owner_id: me, filed_on: today, due_on: today } },
        },
      },
      auth: { me: { from: 'person', column: 'email' }, roles: { staff: { read: true, write: true } } },
      views: { requests: { kind: 'list', from: 'request', show: ['title'] } },
      home: 'requests',
      nav: ['requests'],
    },
    'intake fixture',
  );
  const host = {
    app: { path: 'intake-fixture.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async () => ({ id: 'account-ann', who: 'ann@example.test', role: 'staff', name: 'Ann' }),
    },
  } as unknown as AppHost;
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const insert = async (values: Record<string, unknown>) => {
    const response = await fetch(`http://${bound.host}:${bound.port}/api/insert`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appId, table: 'request', values }),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return { ...db.prepare('SELECT filed_by, owner_id, filed_on, due_on FROM request WHERE id = ?').get(body.key.id) };
  };
  try {
    // The App's day, in its own zone: the server's clock decides it, so compare with the zone's day now.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles' }).format(new Date());

    // Left out: the server fills each, `me` as the signed-in account's email and as their row of the people table.
    assert.deepEqual(await insert({ title: 'Leaky tap' }), { filed_by: 'ann@example.test', owner_id: 7, filed_on: day, due_on: day });

    // Said: a column the form does not ask for is the server's, whatever the request names.
    assert.deepEqual(
      await insert({ title: 'Forged', filed_by: 'bob@example.test', owner_id: 8, filed_on: '1999-01-01', due_on: '2030-01-31' }),
      // due_on is shown, so the person's own date stands.
      { filed_by: 'ann@example.test', owner_id: 7, filed_on: day, due_on: '2030-01-31' },
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
