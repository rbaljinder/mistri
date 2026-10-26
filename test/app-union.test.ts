/**
 * A union: one list over incidents and requested items, in one
 * order and one page, each branch read under the reader's own grants. Paged
 * through, it repeats and skips nothing; a reader who cannot read a branch
 * sees the other alone; and what a union cannot answer is refused as a
 * question, never sent to the database as a table.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { appProblems, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parseUnions, unionProblems, withUnions } from '../packages/mistri/src/shared/appUnions.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const connection = 'desk-db';
const appId = 'desk';
const sessions: Record<string, Identity> = {
  agent: { id: 'account-agent', who: 'agent@example.test', role: 'agent' },
  requester: { id: 'account-requester', who: 'requester@example.test', role: 'requester' },
};
const manifest = parseAppConfig(
  {
    id: appId,
    name: 'Desk',
    connection,
    resources: { incident: {}, requested_item: {} },
    unions: [
      {
        name: 'mine',
        branches: [
          { from: 'incident', as: { title: 'short_description', opened: 'opened_at' } },
          { from: 'requested_item', as: { title: 'name', opened: 'created_at' } },
        ],
      },
    ],
    auth: {
      providers: ['email'],
      defaultRole: 'requester',
      roles: { agent: { read: ['incident', 'requested_item'] }, requester: { read: ['requested_item'] } },
    },
    views: { requests: { kind: 'list', from: 'mine', label: 'My requests', show: ['title', 'opened'] } },
    home: 'requests',
    nav: ['requests'],
  },
  'union fixture',
);

async function fixture(run: (base: string) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-union-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE incident (id INTEGER PRIMARY KEY, short_description TEXT NOT NULL, opened_at TEXT NOT NULL, private_note TEXT);
    CREATE TABLE requested_item (id INTEGER PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO incident VALUES (1, 'Printer jammed', '2026-10-01', 'x'), (2, 'Screen flickers', '2026-10-04', 'x'),
      (3, 'VPN drops', '2026-10-06', 'x');
    INSERT INTO requested_item VALUES (1, 'New laptop', '2026-10-02'), (2, 'Desk phone', '2026-10-05'), (3, 'Badge', '2026-10-07');
  `);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Desk', url: path, source: 'config' });
  const host: AppHost = {
    app: { path: '/desk/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: '/desk/sessions.db',
      handler: async () => {},
      close: async () => {},
      session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await run(`http://${bound.host}:${address.port}`);
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function post(base: string, path: string, body: Record<string, unknown>, role = 'agent') {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    signal: AbortSignal.timeout(5_000),
    headers: { Cookie: `session=${role}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: appId, ...body }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}
const titles = (reply: { body: Record<string, unknown> }) => (reply.body.rows as Array<{ title: string }>).map((row) => row.title);

test('a union lists both tables in one order, paged without a repeat or a gap, each row naming its record', async () => {
  await fixture(async (base) => {
    const page = (offset: number) => post(base, '/api/run', { q: 'mine sort opened desc', limit: 4, offset, count: 'exact' });
    const first = await page(0),
      second = await page(4);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.deepEqual(titles(first), ['Badge', 'VPN drops', 'Desk phone', 'Screen flickers']);
    assert.deepEqual(titles(second), ['New laptop', 'Printer jammed']);
    assert.equal(first.body.total, 6);
    const badge = (first.body.rows as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([badge.from, badge.key], ['requested_item', 3]);
    // Narrowed by its own columns and by the branch a row came from.
    const narrowed = await post(base, '/api/run', { q: 'mine from = incident and opened >= 2026-10-04 sort opened', limit: 10, offset: 0 });
    assert.deepEqual(titles(narrowed), ['Screen flickers', 'VPN drops']);
    // As useRows asks it: a view of the union's own columns.
    const viewed = await post(base, '/api/view/run', {
      view: { id: 'ui:mine', name: 'mine', base: 'mine', columns: [{ path: 'title' }, { path: 'from' }], limit: 3 },
      query: 'sort opened',
      count: 'exact',
    });
    assert.equal(viewed.status, 200, JSON.stringify(viewed.body));
    assert.deepEqual(titles(viewed), ['Printer jammed', 'New laptop', 'Screen flickers']);
    assert.equal(viewed.body.total, 6);
    // A column the union does not have is a question asked wrongly, not a table the database is asked for.
    const past = await post(base, '/api/view/run', {
      view: { id: 'ui:mine', name: 'mine', base: 'mine', columns: [{ path: 'private_note' }], limit: 3 },
    });
    assert.ok(past.status === 400 || (past.body.errors as unknown[] | undefined)?.length, JSON.stringify(past.body));
    // Every room's metadata answers with the union in its catalog.
    for (const path of ['/api/schema', '/api/views', '/api/pages', '/api/layouts', '/api/filters']) {
      const reply = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}app=${appId}`, { headers: { Cookie: 'session=agent' } });
      assert.equal(reply.status, 200, `${path}: ${await reply.text()}`);
    }
    const catalog = (await (await fetch(`${base}/api/schema?app=${appId}`, { headers: { Cookie: 'session=agent' } })).json()) as {
      tables: Array<{ id: string; union?: unknown }>;
    };
    assert.ok(catalog.tables.find((table) => table.id === 'mine')?.union);
    // The list over it is served whole, with nothing to fix.
    const app = (await (await fetch(`${base}/api/app?app=${appId}`, { headers: { Cookie: 'session=agent' } })).json()) as {
      app: { views: Record<string, { table?: string; error?: string }>; problems?: string[] };
    };
    assert.equal(app.app.views.requests?.table, 'mine');
    assert.equal(app.app.views.requests?.error, undefined);
    assert.deepEqual(app.app.problems ?? [], []);
  });
});

test('each branch is read under the reader’s own grants: a requester sees requested items alone', async () => {
  await fixture(async (base) => {
    const mine = await post(base, '/api/run', { q: 'mine sort opened desc', limit: 10, offset: 0, count: 'exact' }, 'requester');
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.deepEqual(titles(mine), ['Badge', 'Desk phone', 'New laptop']);
    assert.equal(mine.body.total, 3);
    assert.doesNotMatch(JSON.stringify(mine.body), /incident|Printer|VPN/);
  });
});

test('a union is declared with the same shape in every branch, over resources with a key', () => {
  assert.throws(() => parseUnions([{ name: 'mine', branches: [{ from: 'incident', as: { title: 't' } }] }], 'u'), /fewer than two/);
  assert.throws(
    () =>
      parseUnions(
        [
          {
            name: 'mine',
            branches: [
              { from: 'a', as: { title: 't' } },
              { from: 'b', as: { name: 'n' } },
            ],
          },
        ],
        'u',
      ),
    /every branch says the same columns/,
  );
  assert.throws(
    () =>
      parseUnions(
        [
          {
            name: 'mine',
            branches: [
              { from: 'a', as: { key: 'id' } },
              { from: 'b', as: { key: 'id' } },
            ],
          },
        ],
        'u',
      ),
    /its own/,
  );
  const schema: DatabaseSchema = {
    label: '',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'incident',
        name: 'incident',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'short_description', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'opened_at', type: 'TEXT', nullable: false, primaryKey: false },
        ],
      },
      {
        id: 'requested_item',
        name: 'requested_item',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'created_at', type: 'INTEGER', nullable: false, primaryKey: false },
        ],
      },
    ],
  };
  assert.match(unionProblems(manifest, schema).join('\n'), /"opened" is text in one branch and number in "requested_item"/);
  // Over a catalog that agrees, startup has nothing to say: the list over it resolves.
  const agreeing = {
    ...schema,
    tables: schema.tables.map((table) => ({
      ...table,
      columns: table.columns.map((c) => ({ ...c, type: c.name === 'created_at' ? 'TEXT' : c.type })),
    })),
  };
  assert.deepEqual(appProblems({ path: '/desk/app.ts', app: manifest, pages: [], sources: {} } as never, agreeing), []);
  // A reader without one branch's table is served the union over the other alone.
  const served = withUnions(manifest, { ...schema, tables: schema.tables.slice(1) });
  assert.deepEqual(
    served.tables.find((table) => table.id === 'mine')?.union?.branches.map((branch) => branch.from),
    ['requested_item'],
  );
});
