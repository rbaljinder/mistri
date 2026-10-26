/**
 * `me` in an App's conditions, end to end: a tab, a count and a view read
 * through the server as the verified session's person, the row `auth.me`
 * maps them to, and an action's `when` judged for that same person inside
 * the write. The browser sends the word; nothing it sends chooses who.
 */
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
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { parseAppConfig, resolveResources, resolveViews, withRollups } from '../packages/mistri/src/shared/app.js';
import { appLiteralWarnings } from '../packages/mistri/src/shared/appWarnings.js';

const connection = 'me-connection';
const appId = 'me-app';
const DESK = {
  id: appId,
  name: 'Desk',
  connection,
  resources: {
    employee: {},
    ticket: {
      access: 'write',
      // Every tab below names one: the queries (and the faults a bad one gets) live on the resource.
      segments: {
        mine: 'owner_id = me',
        filed_by_me: { query: 'filed_by = me', label: 'Filed by me' },
        urgent: 'priority = me',
        low: 'priority = none',
      },
      machine: { column: 'status', states: { open: { on: { close: { to: 'closed', when: 'owner_id = me' } } }, closed: { final: true } } },
    },
  },
  auth: {
    providers: ['email'],
    defaultRole: 'agent',
    me: { from: 'employee', column: 'email' },
    roles: { agent: { read: true, write: ['ticket'] } },
  },
  views: {
    tickets: {
      kind: 'list',
      from: 'ticket',
      label: 'Tickets',
      tabs: ['mine', 'filed_by_me', { label: 'All' }],
    },
  },
  home: 'tickets',
  nav: ['tickets'],
};

test('a tab, a count and a view read as the signed-in person, and an action is theirs to take', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-me-'));
  const previous = process.env.XDG_CONFIG_HOME;
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE employee (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, status TEXT NOT NULL,
      owner_id INTEGER REFERENCES employee(id), filed_by TEXT, priority INTEGER);
    INSERT INTO employee VALUES (1, 'Bo', 'bo@example.test'), (2, 'Ada', 'ada@example.test');
    INSERT INTO ticket VALUES (1, 'Printer', 'open', 2, 'bo@example.test', 1), (2, 'VPN', 'open', 1, 'ada@example.test', 2),
      (3, 'Laptop', 'open', 2, 'ada@example.test', 3), (4, 'Badge', 'closed', NULL, NULL, 1);
  `);
  db.close();
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Desk', url: path, source: 'config', writable: true });
  const manifest = parseAppConfig(DESK, 'me fixture');
  let who: Identity = { id: 'account-ada', who: 'ada@example.test', role: 'agent' };
  const host: AppHost = {
    app: { path: '/desk/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async () => who,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  process.env.XDG_CONFIG_HOME = directory;
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const post = async (route: string, body: Record<string, unknown>) => {
      const response = await fetch(`http://${bound.host}:${address.port}${route}`, {
        signal: AbortSignal.timeout(5_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: appId, ...body }),
      });
      return { status: response.status, body: await response.json() };
    };
    const ids = async (q: string) => {
      const { body } = await post('/api/run', { q, exactCount: true });
      assert.deepEqual(body.errors, [], q);
      return (body.rows as Array<{ id: number }>).map((row) => row.id).sort();
    };

    assert.deepEqual(await ids('ticket owner_id = me'), [1, 3], "Ada's row is employee 2");
    assert.deepEqual(await ids('ticket filed_by = me'), [2, 3], 'beside text, me is the email');
    assert.deepEqual(await ids('ticket owner_id.email = me'), [1, 3], 'through a path it lands on the email');
    const counted = await post('/api/breakdown', { text: 'ticket owner_id = me count' });
    assert.deepEqual(counted.body.rows, [{ count: 2 }]);
    const viewed = await post('/api/view/run', {
      view: { id: 'v', name: '', base: 'ticket', columns: [{ path: 'id' }] },
      query: 'owner_id = me',
    });
    assert.deepEqual((viewed.body.rows as Array<{ id: number }>).map((row) => row.id).sort(), [1, 3]);
    // A word the request quotes is text, and a column me cannot be is refused, not compared.
    assert.deepEqual(await ids('ticket filed_by = "me"'), []);
    const refused = await post('/api/run', { q: 'ticket priority = me' });
    assert.match(refused.body.errors?.[0]?.message ?? '', /"priority" is INTEGER/);

    // Close is Ada's to take on her open ticket, and nobody's on Bo's.
    const close = (id: number) => post('/api/update', { table: 'ticket', key: { id }, values: { status: 'closed' } });
    assert.equal((await close(2)).status, 400, "ticket 2 is Bo's");
    const mine = await close(1);
    assert.equal(mine.status, 200, JSON.stringify(mine.body));

    // Signed in with no employee row: nothing is theirs.
    who = { id: 'account-new', who: 'new@example.test', role: 'agent' };
    assert.deepEqual(await ids('ticket owner_id = me'), []);
    assert.deepEqual(await ids('ticket owner_id != me'), [1, 2, 3]);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(connection);
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('me is refused where it can mean nobody, and judged against the catalog where it can', async (t) => {
  const without =
    (views: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    () =>
      parseAppConfig({ ...DESK, ...extra, views, home: Object.keys(views)[0], nav: Object.keys(views) }, 'me.ts');
  const { auth: _auth, resources: _resources, ...unsigned } = DESK;
  assert.throws(
    () => parseAppConfig({ ...unsigned, resources: { ticket: { segments: DESK.resources.ticket.segments } } }, 'me.ts'),
    /resources "ticket", segments "mine" compares with me, the signed-in person, and this App has no sign-in/,
  );
  assert.throws(
    without(DESK.views, {
      resources: { ...DESK.resources, ticket: { ...DESK.resources.ticket, form: { when: { priority: 'owner_id = me' } } } },
    }),
    /"form", when "priority" compares with me/,
  );
  assert.doesNotThrow(without(DESK.views));

  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-me-catalog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 'desk.db'));
  db.exec(`CREATE TABLE employee (id INTEGER PRIMARY KEY, email TEXT NOT NULL);
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, status TEXT, owner_id INTEGER REFERENCES employee(id), filed_by TEXT, priority INTEGER);`);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 'desk.db'), 'desk');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const app = parseAppConfig(
    {
      ...DESK,
      views: { tickets: { kind: 'list', from: 'ticket', label: 'Tickets', tabs: ['urgent'] } },
    },
    'me.ts',
  );
  assert.match(
    resolveViews(app, withRollups(app, schema)).tickets.error ?? '',
    /Tab "Urgent": "priority" is INTEGER, and me is the signed-in account's email or their employee row/,
  );
  const unmapped = parseAppConfig({ ...DESK, auth: { ...DESK.auth, me: undefined } }, 'me.ts');
  assert.match(
    resolveViews(unmapped, withRollups(unmapped, schema)).tickets.error ?? '',
    /Tab "Mine": "owner_id" references employee, and me is the signed-in account's email\. Say which table/,
  );
  assert.match(
    resolveResources(
      parseAppConfig({ ...DESK, auth: { ...DESK.auth, me: { from: 'employee', column: 'id' } } }, 'me.ts'),
      schema,
    ).problems.join(' '),
    /auth\.me: "id" is INTEGER/,
  );
  // A literal the column cannot hold is said, not left to be an empty tab.
  const literal = parseAppConfig(
    {
      ...DESK,
      views: { tickets: { kind: 'list', from: 'ticket', label: 'Tickets', tabs: ['low'] } },
    },
    'me.ts',
  );
  assert.deepEqual(appLiteralWarnings(literal, [], withRollups(literal, schema)), [
    'view "tickets", tab "Low": "none" is not a number, and ticket.priority is INTEGER, so it never matches.',
  ]);
});
