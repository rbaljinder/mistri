/**
 * `auth.me.create` (appPersonRows.ts): a new account's person row, made by the
 * server on the account's first signed-in request — after a sign-up, an
 * accepted invitation or a first sign-in through an identity provider alike —
 * once, whatever races it, so `me` names the newcomer from their first page.
 * What the catalog must say first: an email that is unique, a name column of
 * text, and nothing else the row needs left without a default.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { ensurePersonRow } from '../packages/mistri/src/server/app/appPersonRows.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig, resolveResources } from '../packages/mistri/src/shared/app.js';

const desk = (me: Record<string, unknown>, rows?: string) =>
  parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: { employee: {}, ticket: { access: 'write', segments: { mine: 'owner_id = me' } } },
      auth: {
        providers: ['email'],
        defaultRole: 'agent',
        me: { from: 'employee', column: 'email', ...me },
        ...(rows ? { rows } : {}),
        roles: { agent: { read: true, write: ['ticket'] } },
      },
      views: { tickets: { kind: 'list', from: 'ticket', tabs: ['mine'] } },
      home: 'tickets',
      nav: ['tickets'],
    },
    'desk',
  );

function database(sql: string) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-person-rows-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(`${sql}
    CREATE TABLE ticket (id INTEGER PRIMARY KEY, subject TEXT NOT NULL, owner_id INTEGER REFERENCES employee(id));`);
  db.close();
  return { directory, path };
}
const PEOPLE = `CREATE TABLE employee (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name TEXT NOT NULL, team TEXT NOT NULL DEFAULT 'support');`;

test('create is checked where it is written and against the catalog', async (t) => {
  assert.throws(() => desk({ create: { title: 'x' } }), /title/);
  assert.throws(() => desk({ create: { name: '' } }), /"create" is \{ name\? \}/);
  assert.throws(() => desk({ create: {} }, 'tenant'), /does not do yet/);
  const problems = async (sql: string, create: Record<string, unknown>) => {
    const f = database(sql);
    t.after(() => rmSync(f.directory, { recursive: true, force: true }));
    const adapter = new SqliteAdapter(f.path, 'desk');
    t.after(() => adapter.close());
    return resolveResources(desk({ create }), await adapter.introspect()).problems.join('\n');
  };
  assert.equal(await problems(PEOPLE, { name: 'full_name' }), '');
  assert.match(
    await problems('CREATE TABLE employee (id INTEGER PRIMARY KEY, email TEXT NOT NULL, full_name TEXT);', { name: 'full_name' }),
    /found again by "email", which nothing makes unique/,
  );
  assert.match(await problems(PEOPLE, { name: 'nickname' }), /"nickname" .* not a column of employee/);
  assert.match(await problems(PEOPLE, {}), /"full_name" must be filled and has no default/);
  assert.match(
    await problems('CREATE TABLE employee (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, full_name INTEGER);', { name: 'full_name' }),
    /an account's name goes in a text column/,
  );
});

test('the row is made once, named from the account or its email, and a race finds the row the other made', async (t) => {
  const f = database(PEOPLE);
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const adapter = new SqliteAdapter(f.path, 'desk');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const app = desk({ create: { name: 'full_name' } });
  const writer = { query: adapter.query.bind(adapter), insert: adapter.insert!.bind(adapter) };
  await Promise.all([1, 2, 3].map(() => ensurePersonRow(app, schema, writer, { email: 'ana@example.test', name: 'Ana Ruiz' })));
  await ensurePersonRow(app, schema, writer, { email: 'bo@example.test' });
  const check = new DatabaseSync(f.path);
  t.after(() => check.close());
  assert.deepEqual(
    check
      .prepare('SELECT email, full_name, team FROM employee ORDER BY id')
      .all()
      .map((row) => ({ ...row })),
    [
      { email: 'ana@example.test', full_name: 'Ana Ruiz', team: 'support' },
      { email: 'bo@example.test', full_name: 'bo', team: 'support' },
    ],
  );
});

test("served: a new account's first signed-in request makes its row, and `me` names it at once", { timeout: 20_000 }, async () => {
  const f = database(`${PEOPLE} INSERT INTO employee (email, full_name) VALUES ('ada@example.test', 'Ada');`);
  const registry = new Registry();
  registry.add({ id: 'desk', name: 'Desk', url: f.path, source: 'config', writable: true });
  const manifest = desk({ create: { name: 'full_name' } });
  let who: Identity = { id: 'account-new', who: 'new@example.test', role: 'agent', name: 'New Person' };
  const host: AppHost = {
    app: { path: '/desk/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(f.directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async () => who,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    const post = async (body: Record<string, unknown>) => {
      const res = await fetch(`http://${bound.host}:${bound.port}/api/run`, {
        method: 'POST',
        signal: AbortSignal.timeout(5_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: 'desk', ...body }),
      });
      return { status: res.status, body: (await res.json()) as Record<string, any> };
    };
    const first = await post({ q: 'employee email = me' });
    assert.deepEqual(
      first.body.rows?.map((row: Record<string, unknown>) => row.full_name),
      ['New Person'],
      JSON.stringify(first.body),
    );
    await post({ q: 'employee' });
    who = { id: 'account-ada', who: 'ada@example.test', role: 'agent' };
    await post({ q: 'employee' });
    const check = new DatabaseSync(f.path);
    try {
      assert.deepEqual(
        check
          .prepare('SELECT email FROM employee ORDER BY id')
          .all()
          .map((row) => row.email),
        ['ada@example.test', 'new@example.test'],
      );
    } finally {
      check.close();
    }
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(f.directory, { recursive: true, force: true });
  }
});
