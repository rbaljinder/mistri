// test-package: shared — holds the database browser and the App framework to one rule (scripts/test-owners.mjs).
/**
 * Hidden columns: an App's `hidden` (with or without sign-in) and a
 * connection's `"hidden"` in tablewalk.json. The claim is the server's: a
 * hidden column never appears in any response, and a question that names one
 * (a projection, a filter, a sort, a walk through it) is refused rather than
 * answered. So every test here goes to the generic endpoints directly, not
 * through a page that happens not to show the column.
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
import { Registry, type ConnectionConfig } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { runTool } from '../packages/tablewalk/src/server/mcp/registry.js';
import { historyRules } from '../packages/mistri/src/server/recordHistory.js';
import { parseHiddenColumns } from '../packages/engine/src/server/hiddenColumns.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { resolveAppAccess } from '../packages/mistri/src/shared/appAccess.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';

const HASH = 'HASH_SENTINEL_7f3a';
const SECRET = 'SECRET_SENTINEL_91c2';
const said = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
/** An answer names no hidden column and carries no hidden value. */
const clean = (value: unknown, where = '') =>
  assert.doesNotMatch(said(value), /password_hash|api_secret|HASH_SENTINEL|SECRET_SENTINEL/, where);
/** A refusal may repeat the name the request sent, as a column that is not there; never a value. */
const valueFree = (value: unknown, where = '') => assert.doesNotMatch(said(value), /HASH_SENTINEL|SECRET_SENTINEL/, where);

function database(directory: string): string {
  const file = join(directory, 'accounts.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY, name TEXT NOT NULL, password_hash TEXT, api_secret TEXT);
    CREATE TABLE note (id INTEGER PRIMARY KEY, account_id INTEGER REFERENCES account(id), body TEXT, status TEXT, draft_secret TEXT);
    INSERT INTO account VALUES (1, 'Ada', '${HASH}', '${SECRET}'), (2, 'Grace', '${HASH}', '${SECRET}');
    INSERT INTO note VALUES (1, 1, 'First note', 'open', '${SECRET}'), (2, 1, 'Second note', 'done', '${SECRET}');`);
  db.close();
  return file;
}

type Call = (path: string, body?: object) => Promise<{ status: number; text: string; body: any }>;

async function serve(
  options: { connection?: Partial<ConnectionConfig>; app?: Record<string, unknown>; session?: Identity },
  run: (f: { call: Call; registry: Registry; id: string }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-hidden-'));
  const id = 'hidden-accounts';
  const registry = new Registry();
  registry.add({ id, name: 'Accounts', url: database(directory), source: 'config', writable: true, ...options.connection });
  const definition = options.app
    ? parseAppConfig(
        {
          id: 'accounts-app',
          name: 'Accounts App',
          connection: id,
          views: { accounts: { kind: 'list', from: 'account', label: 'Accounts' } },
          home: 'accounts',
          nav: ['accounts'],
          ...options.app,
        },
        'hidden fixture',
      )
    : undefined;
  const pages = parsePagesConfig(
    { pages: [{ label: 'Account', base: 'account', sections: [{ kind: 'fields', show: ['name'] }] }] },
    'hidden pages',
  );
  /* An App that signs people in is served with one verified session: the reader every request carries. */
  const auth = definition?.auth
    ? {
        auth: {
          spec: definition.auth,
          store: join(directory, 'sessions.db'),
          handler: async () => {},
          close: async () => {},
          session: async () => options.session ?? null,
        },
      }
    : {};
  const hosts: AppHost[] = definition ? [{ app: { path: 'hidden-fixture.ts', app: definition, pages, sources: {} }, pages, ...auth }] : [];
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: hosts, pages: definition ? pages : [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run({
      registry,
      id,
      call: async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
          ...(body ? { method: 'POST', body: JSON.stringify(definition ? { app: definition.id, ...body } : body) } : {}),
        });
        const text = await response.text();
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        return { status: response.status, text, body: parsed };
      },
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(id);
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Refused, or answered with errors and no rows: never a value. */
const refused = (result: { status: number; text: string; body: any }, what: string) => {
  valueFree(result.text, what);
  assert.ok(
    result.status >= 400 || (result.body?.errors?.length && !result.body?.rows?.length),
    `${what}: ${result.status} ${result.text.slice(0, 300)}`,
  );
};

/** Every generic read over the account table, as the database browser's and an App's routes take them. */
async function everyRead(call: Call) {
  const schema = await call('/api/schema');
  assert.equal(schema.status, 200);
  clean(schema.body, 'schema');
  const account = schema.body.tables.find((table: { id: string }) => table.id === 'account');
  assert.deepEqual(
    account.columns.map((column: { name: string }) => column.name),
    ['id', 'name'],
  );

  const read = await call('/api/query', { table: 'account' });
  assert.equal(read.status, 200);
  clean(read.body, 'default query');
  assert.deepEqual(
    read.body.rows.map((row: object) => Object.keys(row)),
    [
      ['id', 'name'],
      ['id', 'name'],
    ],
  );
  for (const body of [
    { table: 'account', columns: ['id', 'password_hash'] },
    { table: 'account', filter: { groups: [[{ column: 'password_hash', op: '=', value: HASH }]] } },
    { table: 'account', orderBy: [{ column: 'api_secret', direction: 'asc' }] },
  ]) {
    const answer = await call('/api/query', body);
    valueFree(answer.text, JSON.stringify(body));
    assert.ok(answer.status >= 400, `${JSON.stringify(body)}: ${answer.status}`);
  }

  const listed = await call('/api/run', { q: 'account' });
  assert.equal(listed.status, 200);
  clean(listed.body, 'run');
  assert.equal(listed.body.rows.length, 2);
  for (const q of [
    `account password_hash = ${HASH}`,
    'account sort api_secret desc',
    'account show name, password_hash',
    `note account_id.password_hash = ${HASH}`,
    'note show body, account_id.api_secret',
  ]) {
    refused(await call('/api/run', { q }), q);
  }
  for (const view of [
    { base: 'account', columns: [{ path: 'password_hash' }] },
    { base: 'note', columns: [{ path: 'account_id.api_secret' }] },
  ]) {
    refused(await call('/api/view/run', { view: { id: 'forged', name: 'Forged', ...view } }), JSON.stringify(view));
  }
  const counts = await call('/api/counts', { items: ['account', `account password_hash = ${HASH}`] });
  valueFree(counts.body, 'counts');
  assert.equal(counts.body.results[0].total, 2);
  assert.equal(counts.body.results[1].total, undefined);
  refused(await call('/api/breakdown', { text: 'account count by password_hash' }), 'breakdown by a hidden column');

  const exported = await call('/api/export', { q: 'account' });
  assert.equal(exported.status, 200);
  clean(exported.text, 'export');
  assert.match(exported.text, /id,name/);
  for (const body of [{ q: 'account', columns: ['password_hash'] }, { q: 'account show api_secret' }]) {
    const answer = await call('/api/export', body);
    valueFree(answer.text, JSON.stringify(body));
    assert.ok(answer.status >= 400 || /"errors":\[\{/.test(answer.text), `${JSON.stringify(body)}: ${answer.status} ${answer.text}`);
  }
  /* Raw SQL is not column-redactable, so it is refused, not filtered. */
  const sql = await call('/api/sql', { text: 'SELECT password_hash, api_secret FROM account' });
  refused(sql, 'raw SQL');
  valueFree(await call('/api/references', { table: 'account', q: HASH }), 'reference search');
}

test('an App without sign-in serves no hidden column on any generic read', async () => {
  await serve(
    { app: { resources: { account: { access: 'write', hidden: ['password_hash', 'api_secret'] }, note: { access: 'write' } } } },
    async ({ call }) => {
      await everyRead(call);
      const app = await call('/api/app');
      assert.equal(app.status, 200);
      clean(app.body, 'app payload');
      const page = await call('/api/pages/plan', {
        key: { id: 1 },
        page: {
          id: 'forged',
          name: 'Forged',
          base: 'account',
          source: 'saved',
          sections: [{ kind: 'fields', paths: ['password_hash'] }],
        },
      });
      refused(page, 'forged page');
      /* Nothing hidden is written either, and an insert answers without it. */
      assert.ok((await call('/api/update', { table: 'account', key: { id: 1 }, values: { password_hash: 'forged' } })).status >= 400);
      const inserted = await call('/api/insert', { table: 'account', values: { name: 'Linus' } });
      assert.equal(inserted.status, 200, inserted.text);
      clean(inserted.body, 'insert');
    },
  );
});

/* `hidden` on one resource is a cut from that resource's columns, not a
   column ceiling for the App: every other resource keeps its New, its
   actions, its updates and its deletes, signed in or not, with roles or not. */
test('hidden on one resource leaves every other resource written as before', async () => {
  const resources = (access: Record<string, unknown> = {}) => ({
    account: { ...access, hidden: ['password_hash', 'api_secret'] },
    note: { ...access, delete: true, actions: { archive: { label: 'Archive', set: { body: 'Archived' } } } },
  });
  const staff: Identity = { id: 'account-staff', who: 'staff@example.test', role: 'staff' };
  for (const [what, options] of [
    ['without sign-in', { app: { resources: resources({ access: 'write' }) } }],
    [
      'signed in with a role',
      {
        app: { resources: resources({ access: 'write' }), auth: { providers: ['email'], roles: { staff: { read: true, write: true } } } },
        session: staff,
      },
    ],
  ] as const) {
    await serve(options, async ({ call }) => {
      const app = await call('/api/app');
      assert.equal(app.status, 200, `${what}: ${app.text.slice(0, 300)}`);
      clean(app.body, what);
      assert.ok(app.body.app.writableTables.includes('note'), `${what}: note offers New (${app.body.app.writableTables})`);
      assert.deepEqual(
        app.body.app.resources.note.actions.map((action: { label: string }) => action.label),
        ['Archive'],
        what,
      );
      const schema = await call('/api/schema');
      const note = schema.body.tables.find((table: { id: string }) => table.id === 'note');
      assert.notEqual(note.deletable, false, `${what}: note is deletable`);
      assert.ok(
        note.columns.every((column: { writable?: boolean }) => column.writable !== false),
        `${what}: every note column is writable`,
      );
      const inserted = await call('/api/insert', { table: 'note', values: { account_id: 1, body: 'Second note' } });
      assert.equal(inserted.status, 200, `${what}: insert ${inserted.text}`);
      const acted = await call('/api/update', { table: 'note', key: { id: 1 }, values: { body: 'Archived' } });
      assert.equal(acted.status, 200, `${what}: update ${acted.text}`);
      const removed = await call('/api/delete', { table: 'note', key: { id: 1 }, confirm: true });
      assert.equal(removed.status, 200, `${what}: delete ${removed.text}`);
      assert.notEqual(removed.body.deleted, false, `${what}: delete ${removed.text}`);
      /* The hidden resource itself: its visible columns write, its hidden ones never. */
      assert.equal((await call('/api/update', { table: 'account', key: { id: 1 }, values: { name: 'Ada L.' } })).status, 200, what);
      assert.ok((await call('/api/update', { table: 'account', key: { id: 1 }, values: { api_secret: 'forged' } })).status >= 400, what);
    });
  }
});

/* A rollup's `query` over a resource with hidden columns is judged by the
   columns it names, as any other question: one naming a visible column is
   answered, one naming a hidden column is refused, for either kind of `hidden`. */
test('a rollup query over a table with hidden columns is refused only where it names one', async () => {
  const rollups = (query: string) => ({ open_notes: { fn: 'count', from: 'note', whose: 'account_id', query } });
  for (const [what, hide] of [
    [
      "a resource's hidden",
      (query: string) => ({ app: { resources: { account: { rollups: rollups(query) }, note: { hidden: ['draft_secret'] } } } }),
    ],
    [
      "a connection's hidden",
      (query: string) => ({
        connection: { hidden: { note: ['draft_secret'] } },
        app: { resources: { account: { rollups: rollups(query) }, note: {} } },
      }),
    ],
  ] as const) {
    await serve(hide('status = open'), async ({ call }) => {
      const listed = await call('/api/run', { q: 'account show name, open_notes sort id' });
      assert.equal(listed.status, 200, `${what}: ${listed.text}`);
      clean(listed.body, what);
      assert.deepEqual(
        listed.body.rows,
        [
          { name: 'Ada', open_notes: 1 },
          { name: 'Grace', open_notes: 0 },
        ],
        what,
      );
      const fields = await call('/api/view/run', {
        count: 'none',
        view: {
          id: 'page',
          name: 'account',
          base: 'account',
          columns: [{ path: 'name' }, { path: 'open_notes' }],
          filter: { groups: [[{ path: 'id', op: '=', value: 1 }]] },
        },
      });
      assert.equal(fields.status, 200, `${what}: ${fields.text}`);
      assert.deepEqual(fields.body.rows, [{ name: 'Ada', open_notes: 1 }], what);
    });
    await serve(hide(`draft_secret = ${SECRET}`), async ({ call }) => {
      refused(await call('/api/run', { q: 'account show name, open_notes' }), `${what}: a rollup naming a hidden column`);
    });
  }
});

test('a connection\'s "hidden" covers the Workbench and every MCP tool, and refuses raw SQL', async () => {
  await serve({ connection: { hidden: { account: ['password_hash'], '*': ['*_secret'] } } }, async ({ call, registry, id }) => {
    await everyRead(call);
    /* Writes through the connection: a visible column saves, a hidden one is
       refused, and a delete (which removes and journals every column) too. */
    const saved = await call('/api/update', { table: 'account', key: { id: 1 }, values: { name: 'Ada L.' } });
    assert.equal(saved.status, 200, saved.text);
    clean(saved.body, 'update');
    const forged = await call('/api/update', { table: 'account', key: { id: 1 }, values: { password_hash: 'forged' } });
    assert.ok(forged.status >= 400, forged.text);
    valueFree(forged.text);
    const removed = await call('/api/delete', { table: 'account', key: { id: 2 }, confirm: true });
    assert.ok(removed.status >= 400 || (removed.body.deleted === false && removed.body.errors?.length), removed.text);
    valueFree(removed.text);
    assert.equal((await call('/api/run', { q: 'account' })).body.rows.length, 2, 'the refused delete removed nothing');
    const listed = await call('/api/connections');
    assert.equal(listed.body.connections?.[0]?.hidesColumns ?? listed.body[0]?.hidesColumns, true);
    for (const [name, args] of [
      ['table', { table: 'account' }],
      ['tables', {}],
      ['schema_summary', {}],
      ['record', { table: 'account', key: { id: 1 } }],
      ['query', { q: 'account' }],
      ['profile', { table: 'account' }],
      ['find', { q: HASH }],
      ['find', { q: 'password' }],
    ] as const) {
      const answer = await runTool(registry, name, { connection: id, ...args });
      clean(answer, `${name} ${JSON.stringify(args)}`);
    }
    for (const [name, args] of [
      ['query', { q: `account password_hash = ${HASH}` }],
      ['query', { q: 'account sort api_secret' }],
      ['sql', { statement: 'SELECT password_hash FROM account' }],
      ['breakdown', { q: 'account count by password_hash' }],
    ] as const) {
      const answer = await runTool(registry, name, { connection: id, ...args });
      valueFree(answer, `${name} ${JSON.stringify(args)}`);
      assert.ok(
        answer.isError || (answer.structuredContent as { errors?: unknown[] } | undefined)?.errors?.length,
        `${name} ${JSON.stringify(args)} answered: ${answer.content[0]?.text.slice(0, 200)}`,
      );
    }
  });
});

test('an App on a connection that hides columns inherits the cut', async () => {
  await serve(
    { connection: { hidden: { account: ['password_hash', 'api_secret'] } }, app: { resources: { account: {}, note: {} } } },
    async ({ call }) => {
      await everyRead(call);
    },
  );
});

/* The dealer's cost hidden by the lender's connection, and by the App that
   reads it there too: said twice, which is no mistake (KS-OBSERVE #13). */
test('an App may hide again what its connection hides: it loads, reads nothing hidden, and its types name the column as hidden', async () => {
  await serve(
    {
      connection: { hidden: { account: ['password_hash', 'api_secret'] } },
      app: { resources: { account: { hidden: ['password_hash'] }, note: {} } },
    },
    async ({ call }) => {
      await everyRead(call);
    },
  );
  const { withoutHiddenColumns } = await import('../packages/engine/src/server/hiddenColumns.js');
  const { typesForSchema } = await import('../packages/mistri/src/server/typegen.js');
  const schema = {
    label: 'x',
    dialect: 'sqlite' as const,
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'account',
        name: 'account',
        schema: 'main',
        isView: false,
        columns: ['id', 'name', 'password_hash'].map((name) => ({
          name,
          type: 'TEXT',
          nullable: name !== 'id',
          primaryKey: name === 'id',
        })),
      },
    ],
  };
  const served = withoutHiddenColumns(schema, { account: ['password_hash'] }, 'Accounts');
  assert.doesNotMatch(JSON.stringify(served), /password_hash/, 'the names never reach an answer');
  const app = parseAppConfig(
    {
      id: 'x',
      name: 'X',
      resources: { account: { hidden: ['password_hash'] } },
      views: { accounts: { kind: 'list', from: 'account' } },
      home: 'accounts',
    },
    'hidden twice',
  );
  assert.deepEqual([...resolveAppAccess(app, served, []).fields!.get('account')!.read], ['id', 'name']);
  assert.throws(
    () =>
      resolveAppAccess(
        parseAppConfig(
          {
            id: 'x',
            name: 'X',
            resources: { account: { hidden: ['pasword_hash'] } },
            views: { accounts: { kind: 'list', from: 'account' } },
            home: 'accounts',
          },
          'typo',
        ),
        served,
        [],
      ),
    /not a column/,
    'a typo is still no column',
  );
  assert.match(typesForSchema(served), /export type Hidden = \{\n  account: "password_hash";/);
});

test("hidden is refused where it cannot hold, and intersects every role's grant", () => {
  const app = (resources: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    parseAppConfig(
      { id: 'x', name: 'X', resources, views: { accounts: { kind: 'list', from: 'account' } }, home: 'accounts', ...more },
      'hidden refusals',
    );
  assert.throws(() => app({ account: { hidden: 'password_hash' } }), /"hidden" that is not a list/);
  assert.throws(
    () => app({ account: { hidden: ['api_secret'], search: { connection: 'find', fields: ['name', 'api_secret'] } } }),
    /index would hold its values/,
  );
  assert.throws(() => app({ account: { hidden: ['name'], address: 'name' } }), /address/);
  assert.throws(() => app({ account: { fields: { read: ['id'] } } }), /keep a column from every reader with "hidden"/);
  const schema = {
    label: 'x',
    dialect: 'sqlite' as const,
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'account',
        name: 'account',
        schema: 'main',
        isView: false,
        columns: ['id', 'name', 'password_hash'].map((name) => ({
          name,
          type: 'TEXT',
          nullable: name !== 'id',
          primaryKey: name === 'id',
        })),
      },
    ],
  };
  assert.throws(() => resolveAppAccess(app({ account: { hidden: ['id'] } }), schema, []), /primary key/);
  assert.throws(() => resolveAppAccess(app({ account: { hidden: ['nope'] } }), schema, []), /not a column/);
  const plain = resolveAppAccess(app({ account: { hidden: ['password_hash'] } }), schema, []);
  assert.deepEqual([...plain.fields!.get('account')!.read], ['id', 'name']);
  const roles = app(
    { account: { access: 'write', hidden: ['password_hash'] } },
    {
      auth: {
        roles: {
          admin: { read: true, write: true, fields: { account: { read: ['id', 'name', 'password_hash'], write: ['password_hash'] } } },
        },
      },
    },
  );
  const admin = resolveAppAccess(roles, schema, ['admin']).fields!.get('account')!;
  assert.deepEqual([[...admin.read], [...admin.write]], [['id', 'name'], []]);
  assert.throws(() => parseHiddenColumns({ account: ['*'] }, 'tablewalk.json'), /never a whole table/);
  assert.throws(() => parseHiddenColumns(['password'], 'tablewalk.json'), /must be an object/);
});

test('a history keeps no value of a hidden column', () => {
  const app = parseAppConfig(
    {
      id: 'x',
      name: 'X',
      resources: { account: { hidden: ['password_hash'], audit: { redact: ['name'] } } },
      views: { accounts: { kind: 'list', from: 'account' } },
      home: 'accounts',
    },
    'hidden history',
  );
  const pages = parsePagesConfig({ pages: [{ label: 'Account', base: 'account', sections: [{ kind: 'history' }] }] }, 'history pages');
  const rule = historyRules(app, pages).get('account')!;
  assert.deepEqual(rule.redact instanceof Set ? [...rule.redact].sort() : rule.redact, ['name', 'password_hash']);
});
