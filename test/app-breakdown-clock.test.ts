import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';

/* A filter rail counts each facet with a breakdown and lists the rows with a
   run, both under the same date phrase, so inside an App the two must read
   that phrase by the same clock. The counts once re-read it on the wall clock
   while the list read it by the request's, and a pinned day showed "Hugo
   Duval 7" beside "No rows match". The clock is pinned years from the wall
   clock here, so a breakdown that consults the wall clock counts nothing. */
const connection = 'clock-connection';
const appId = 'clock-app';
const viewer: Identity = { id: 'account-viewer', who: 'viewer@example.test', role: 'viewer' };

test("an App breakdown and a view's query read a date phrase by the request clock, as its list does", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-breakdown-clock-'));
  const previous = { clock: process.env.MISTRI_CLOCK, config: process.env.XDG_CONFIG_HOME };
  const path = join(directory, 'tasks.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE task (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, status TEXT NOT NULL, due_on DATE NOT NULL);
    INSERT INTO task VALUES (1, 'Inside the week', 'open', '2020-01-16'), (2, 'Also inside', 'done', '2020-01-20'),
      (3, 'After the week', 'open', '2020-02-10');
  `);
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Clock connection', url: path, source: 'config' });
  // Role grants put the App's access layer between the request and the adapter.
  const manifest = parseAppConfig(
    {
      id: appId,
      name: 'Clock',
      connection,
      resources: { task: {} },
      auth: { providers: ['email'], defaultRole: 'viewer', roles: { viewer: { read: true } } },
      views: { tasks: { kind: 'list', from: 'task', label: 'Tasks' } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'breakdown clock fixture',
  );
  const pages = parsePagesConfig({ pages: [{ label: 'Task', base: 'task' }] }, 'clock pages');
  const host: AppHost = {
    app: { path: '/clock/app.ts', app: manifest, pages, sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async () => viewer,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  process.env.XDG_CONFIG_HOME = directory;
  // Noon UTC is the 15th in every zone a server is likely to run in.
  process.env.MISTRI_CLOCK = '2020-01-15T12:00:00.000Z';
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const post = async (route: string, body: Record<string, unknown>) => {
      const response = await fetch(`http://${bound.host}:${address.port}${route}`, {
        signal: AbortSignal.timeout(3_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: appId, ...body }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    const listed = await post('/api/run', { q: 'task due_on = next 7 days', exactCount: true });
    assert.deepEqual(listed.errors, []);
    assert.equal(listed.total, 2);

    /* A view's query box (what a free-form page's useRows sends) reads it by the same clock: it once read the
       wall clock, so a page's `today` was the server's day and not the App's (Ladle's check-in, past midnight). */
    const viewed = await post('/api/view/run', {
      count: 'exact',
      query: 'due_on = next 7 days',
      view: { id: 'clock', name: 'task', base: 'task', columns: [{ path: 'subject' }], limit: 20 },
    });
    assert.deepEqual(viewed.errors, []);
    assert.equal(viewed.total, 2);

    const counted = await post('/api/breakdown', { text: 'task due_on = next 7 days count by status sort status' });
    assert.match(counted.text, /due_on >= 2020-01-15 and due_on < 2020-01-22/);
    assert.deepEqual(counted.rows, [
      { status: 'done', count: 1 },
      { status: 'open', count: 1 },
    ]);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(connection);
    db.close();
    for (const [name, value] of [
      ['MISTRI_CLOCK', previous.clock],
      ['XDG_CONFIG_HOME', previous.config],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
