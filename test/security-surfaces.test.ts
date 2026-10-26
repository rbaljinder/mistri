/**
 * The surfaces 0.8.0 added, attacked from every seat at once: a streamed
 * export, batched counts, a record's history, a public page's head and its
 * 301, revalidated replies, a file's preview, rollups, a custom component's
 * files and a cell edited in place — each asked by an administrator, a role
 * whose grant cuts fields, a role without the resource, a signed-out
 * visitor, and a request with forged headers or body. Every answer is
 * either the reader's own, narrowed, or a refusal that says nothing of what
 * it refused.
 *
 * Tenant A against tenant B is tenant-http.test.ts's (its /api/counts and
 * /api/export cases); a row-policy reader's counts and revalidation are
 * app-row-policy-http.test.ts's. This file is the role-grant App, where
 * most Apps live.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { PageDef } from '../packages/engine/src/shared/pageModel.js';
import { provisionSqliteRecordHistory } from '../packages/mistri/src/adapters/history/sqliteRecordHistory.js';

const appId = 'sec';
const owner = 'sec-db';
/* Values no reader below the administrator may ever be sent. */
const SECRET = 'SECRET_FIELD_SENTINEL';
const SOURCE = 'COMPONENT_SOURCE_SENTINEL';
/* A record whose name is markup, and every pattern String.replace would read in a replacement string. */
const HOSTILE = '</title><script>alert(1)</script> "q" $` $\' $& <b>';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR and the rest')]);

const SQL = `CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
  CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    salary INTEGER, secret TEXT, owner_id INTEGER REFERENCES person(id));
  CREATE TABLE attachment (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES task(id), file_name TEXT NOT NULL,
    content_type TEXT, data BLOB NOT NULL, thumb BLOB);
  INSERT INTO person VALUES (1, 'Ann', 'ann@example.test'), (2, 'Bob', 'bob@example.test');
  INSERT INTO task VALUES (1, 'First task', 'open', 100, '${SECRET}', 1), (2, 'Second task', 'done', 200, '${SECRET}', 2);`;

const APP = {
  id: appId,
  name: 'Sec',
  connection: owner,
  resources: {
    person: { rollups: { tasks: { fn: 'count', from: 'task' }, pay: { fn: 'sum', from: 'task', column: 'salary' } } },
    task: { access: 'write', slug: true, audit: { redact: ['salary'] } },
    attachment: { access: 'write', file: { content: 'data', name: 'file_name', type: 'content_type', thumbnail: 'thumb', maxBytes: 4096 } },
  },
  auth: {
    roles: {
      // Exports person too: a file with a column through owner_id reads that table, so it needs the grant for it.
      admin: { read: true, write: true, export: ['person'] },
      clerk: { read: true, write: true, fields: { task: { read: ['id', 'title', 'status', 'owner_id'], write: ['title', 'status'] } } },
      outsider: { read: ['person'] },
    },
    public: { read: ['task'], fields: { task: { read: ['id', 'title'] } } },
  },
  views: {
    tasks: { kind: 'list', from: 'task', label: 'Tasks', show: ['title'] },
    people: { kind: 'list', from: 'person', label: 'People' },
  },
  home: [{ view: 'tasks', signedOut: true }, { view: 'tasks' }],
  nav: ['tasks', 'people'],
};

type Seat = 'admin' | 'admin2' | 'clerk' | 'outsider' | 'public';
const SESSIONS: Record<Exclude<Seat, 'public'>, { id: string; who: string; role: string; name: string }> = {
  admin: { id: 'account-admin', who: 'admin@example.test', role: 'admin', name: 'Ada' },
  admin2: { id: 'account-admin-2', who: 'admin2@example.test', role: 'admin', name: 'Ada' },
  clerk: { id: 'account-clerk', who: 'clerk@example.test', role: 'clerk', name: 'Cal' },
  outsider: { id: 'account-outsider', who: 'out@example.test', role: 'outsider', name: 'Oz' },
};

interface Raw {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  body: any;
}

let server: ReturnType<typeof createApp>;
let registry: Registry;
let db: DatabaseSync;
let directory: string;
const bound = { host: '127.0.0.1', port: 0 };
const COMPONENT = 'hello-0123456789ab';
const HUSH = 'hush';
/** Served by a server of its own: an App that signs people in has its server to itself. */
let hushHost: AppHost;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-security-surfaces-'));
  const file = join(directory, 'sec.db');
  db = new DatabaseSync(file);
  db.exec(SQL);
  db.prepare('INSERT INTO attachment (id, task_id, file_name, content_type, data, thumb) VALUES (1, 1, ?, ?, ?, ?)').run(
    'front.png',
    'image/png',
    PNG,
    Buffer.concat([PNG.subarray(0, 8), Buffer.from('small')]),
  );
  provisionSqliteRecordHistory(file);
  registry = new Registry();
  registry.add({ id: owner, name: 'Sec', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(APP, 'security fixture');
  const pages: PageDef[] = [{ id: 'task', name: 'Task', base: 'task', sections: [{ kind: 'history' }] }];
  const host: AppHost = {
    app: {
      path: 'sec-fixture.ts',
      app: definition,
      pages,
      sources: {},
      /* A compiled component as a load leaves it (appComponents.ts): what its routes serve. */
      components: {
        entries: { hello: { kind: 'section', js: `${COMPONENT}.js`, sources: [] } },
        files: {
          [`${COMPONENT}.js`]: 'export default function Hello() { return null; }\n',
          [`${COMPONENT}.js.map`]: JSON.stringify({ version: 3, sources: ['Hello.jsx'], sourcesContent: [SOURCE], mappings: '' }),
        },
      },
    },
    pages: [],
    auth: {
      spec: definition.auth!,
      store: 'not-used',
      handler: async () => {},
      close: async () => {},
      session: async (req: { headers: { cookie?: string } }) => {
        const seat = /(?:^|;\s*)seat=([\w-]+)/.exec(req.headers.cookie ?? '')?.[1];
        return seat && Object.hasOwn(SESSIONS, seat) ? SESSIONS[seat as keyof typeof SESSIONS] : null;
      },
    },
  };
  /* The same App with nothing opened to a signed-out visitor: its components are nobody's but a signed-in reader's. */
  const { public: _public, ...closedAuth } = APP.auth;
  const closedDefinition = parseAppConfig({ ...APP, id: HUSH, name: 'Hush', auth: closedAuth, home: 'tasks' }, 'security fixture, closed');
  hushHost = {
    ...host,
    app: { ...host.app, path: 'hush-fixture.ts', app: closedDefinition },
    auth: { ...host.auth!, spec: closedDefinition.auth! },
  };
  server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
});

after(async () => {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await closed;
  await registry.closeAll();
  clearJournal(owner);
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

/** One request, exactly as written: the path is sent as it is, headers and all. */
function raw(
  method: string,
  path: string,
  options: { seat?: Seat; headers?: Record<string, string>; body?: unknown; port?: number } = {},
): Promise<Raw> {
  const body = options.body === undefined ? undefined : typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  const headers: Record<string, string> = {
    ...(options.seat && options.seat !== 'public' ? { cookie: `seat=${options.seat}` } : {}),
    ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...options.headers,
  };
  return new Promise((resolve, reject) => {
    const req = request({ host: bound.host, port: options.port ?? bound.port, method, path, headers, timeout: 5000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
        resolve({ status: res.statusCode!, headers: res.headers, text, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const post = (seat: Seat, path: string, body: Record<string, unknown>, headers?: Record<string, string>) =>
  raw('POST', path, { seat, body: { app: appId, ...body }, ...(headers ? { headers } : {}) });
const get = (seat: Seat, path: string, headers?: Record<string, string>) =>
  raw('GET', `${path}${path.includes('?') ? '&' : '?'}app=${appId}`, { seat, ...(headers ? { headers } : {}) });

describe('a streamed export (POST /api/export)', () => {
  test("is the reader's own rows and columns: the administrator's whole, the clerk's without a field it may not read", async () => {
    const admin = await post('admin', '/api/export', { q: 'task', format: 'csv' });
    assert.equal(admin.status, 200, admin.text);
    assert.equal(admin.headers['cache-control'], 'private, no-store');
    assert.match(admin.text, new RegExp(SECRET));
    const clerk = await post('clerk', '/api/export', { q: 'task', format: 'ndjson' });
    assert.equal(clerk.status, 200, clerk.text);
    assert.doesNotMatch(clerk.text, new RegExp(`${SECRET}|salary|secret`));
    assert.deepEqual(Object.keys(JSON.parse(clerk.text.split('\n')[0])).sort(), ['id', 'owner_id', 'status', 'title']);
  });

  test('refuses a field, a table or a question outside the grant, before a byte of the file', async () => {
    for (const body of [
      { q: 'task', columns: ['title', 'secret'] },
      { q: 'task secret = x' },
      { q: 'task sort salary' },
      { q: 'task show title, owner_id.email where salary > 0' },
    ]) {
      const refused = await post('clerk', '/api/export', body);
      assert.ok(
        refused.status >= 400 || Array.isArray(refused.body?.errors),
        `${JSON.stringify(body)}: ${refused.status} ${refused.text.slice(0, 200)}`,
      );
      assert.doesNotMatch(refused.text, new RegExp(SECRET));
      assert.equal(refused.headers['content-disposition'], undefined, JSON.stringify(body));
    }
    // The outsider's catalog has no task table: the question does not read, and the answer says only that.
    const outsider = await post('outsider', '/api/export', { q: 'task' });
    assert.ok(outsider.status >= 400 || Array.isArray(outsider.body?.errors), outsider.text);
    assert.equal(outsider.headers['content-disposition'], undefined);
    assert.doesNotMatch(outsider.text, /First task/);
    const visitor = await post('public', '/api/export', { q: 'task' });
    assert.equal(visitor.status, 401, 'a signed-out visitor exports nothing, even of what it may read');
  });

  test("a forged request is refused at the door: another origin, a form's content type, another Host, a connection in the body", async () => {
    const body = { app: appId, q: 'task' };
    const cases: Array<[string, Record<string, string>, unknown]> = [
      ['another origin', { origin: 'https://evil.example' }, body],
      ['a form post', { 'content-type': 'text/plain' }, JSON.stringify(body)],
      ['another host', { host: 'evil.example' }, body],
    ];
    for (const [what, headers, sent] of cases) {
      const refused = await raw('POST', '/api/export', { seat: 'admin', body: sent, headers });
      assert.equal(refused.status, 403, `${what}: ${refused.text}`);
      assert.doesNotMatch(refused.text, new RegExp(SECRET));
    }
    assert.equal((await post('admin', '/api/export', { conn: owner, q: 'task' })).status, 400);
  });

  test("a column list naming what no row has writes nothing of Object's own", async () => {
    for (const format of ['csv', 'json', 'ndjson']) {
      const reply = await post('admin', '/api/export', { q: 'task', format, columns: ['title', 'constructor', 'toString'] });
      if (reply.status !== 200) {
        assert.ok(reply.status >= 400);
        continue;
      }
      assert.doesNotMatch(reply.text, /native code|function /, format);
    }
    // A question a view answers takes the caller's column list as the file's; still only the rows' own values.
    const view = await post('admin', '/api/export', {
      q: 'task show title, owner_id.name',
      format: 'csv',
      columns: ['title', 'constructor', '__proto__'],
    });
    assert.equal(view.status, 200, view.text);
    assert.doesNotMatch(view.text, /native code|function |\{\}/);
  });
});

describe('batched counts (POST /api/counts)', () => {
  test('count only what the reader may filter by, and nothing for a table outside the grant', async () => {
    const admin = await post('admin', '/api/counts', { items: [`task secret = ${SECRET}`, 'task'] });
    assert.equal(admin.status, 200, admin.text);
    assert.deepEqual(
      admin.body.results.map((r: { total: number }) => r.total),
      [2, 2],
    );
    // A filter on a field the clerk may not read would be an oracle for its values.
    const clerk = await post('clerk', '/api/counts', { items: [`task secret = ${SECRET}`, 'task'] });
    assert.ok(clerk.status >= 400 || clerk.body.results[0].errors, clerk.text);
    assert.ok(!clerk.body?.results || clerk.body.results[0].total === undefined, clerk.text);
    const outsider = await post('outsider', '/api/counts', { items: ['task', 'person'] });
    assert.ok(outsider.status >= 400 || outsider.body.results[0].errors, outsider.text);
    // Signed out: the public grant's table and its fields, nothing more.
    const visitor = await post('public', '/api/counts', { items: ['task'] });
    assert.equal(visitor.status, 200, visitor.text);
    assert.equal(visitor.body.results[0].total, 2);
    for (const items of [['person'], ['task salary > 0'], ['task owner_id.name = Ann']]) {
      const refused = await post('public', '/api/counts', { items });
      assert.ok(refused.status >= 400 || refused.body.results[0].errors, `${items[0]}: ${refused.text}`);
      assert.ok(!refused.body?.results || refused.body.results[0].total === undefined, `${items[0]}: ${refused.text}`);
    }
  });

  test('a batch is bounded and a bound is a positive whole number', async () => {
    assert.equal((await post('admin', '/api/counts', { items: Array.from({ length: 500 }, () => 'task') })).status, 400);
    assert.equal((await post('admin', '/api/counts', { items: [{ q: 'task' }] })).status, 400);
    assert.equal((await post('admin', '/api/counts', { items: ['task'], countLimit: -1 })).status, 400);
    assert.equal((await post('admin', '/api/counts', { items: ['task'], countLimit: '1; DROP TABLE task' })).status, 400);
  });
});

describe('record history (POST /api/record-history)', () => {
  test('a field the reader may not read says it changed and no more; a redacted one keeps no values; others get nothing', async () => {
    const saved = await post('admin', '/api/update', {
      table: 'task',
      key: { id: 2 },
      values: { salary: 250, secret: 'NEW_SECRET_SENTINEL' },
      expected: { salary: 200, secret: SECRET },
      actor: 'forged@example.test',
    });
    assert.equal(saved.status, 200, saved.text);
    const admin = await post('admin', '/api/record-history', { table: 'task', key: { id: 2 } });
    assert.equal(admin.status, 200, admin.text);
    // The writer by the name their account had, never their email: the account stays in the store.
    assert.equal(admin.body.entries[0].by, 'Ada');
    assert.doesNotMatch(admin.text, /admin@example/);
    assert.deepEqual(
      admin.body.entries[0].fields.find((f: { column: string }) => f.column === 'salary'),
      { column: 'salary', redacted: true },
    );
    assert.doesNotMatch(admin.text, /forged|"250"|:250/);
    const clerk = await post('clerk', '/api/record-history', { table: 'task', key: { id: 2 } });
    assert.equal(clerk.status, 200, clerk.text);
    assert.doesNotMatch(clerk.text, /SECRET_SENTINEL|SECRET_FIELD_SENTINEL|admin@example/);
    assert.equal(clerk.body.entries[0].fields.find((f: { column: string }) => f.column === 'secret').hidden, true);
    for (const seat of ['outsider', 'public'] as const) {
      const refused = await post(seat, '/api/record-history', { table: 'task', key: { id: 2 } });
      assert.ok(refused.status >= 400, `${seat}: ${refused.text}`);
      assert.doesNotMatch(refused.text, /SENTINEL|admin@example/);
    }
    // A key widened by a second column, or an inherited name, is not a key.
    for (const key of [{ id: 2, title: 'x' }, { id: { '>': 0 } }, { toString: 1 }, [2]]) {
      const refused = await post('admin', '/api/record-history', { table: 'task', key });
      assert.ok(refused.status >= 400, `${JSON.stringify(key)}: ${refused.text}`);
    }
  });
});

describe('revalidated replies (ETag, 304, Vary)', () => {
  test("one reader's tag never validates for another, even where the role and the bytes agree", async () => {
    for (const path of ['/api/schema', '/api/app']) {
      const first = await get('admin', path);
      assert.equal(first.status, 200, first.text);
      assert.equal(first.headers['cache-control'], 'private, no-cache');
      assert.match(String(first.headers.vary), /Cookie/);
      const tag = String(first.headers.etag);
      assert.equal((await get('admin', path, { 'if-none-match': tag })).status, 304, `${path}: the same reader revalidates`);
      for (const seat of ['admin2', 'clerk', 'outsider', 'public'] as const) {
        const other = await get(seat, path, { 'if-none-match': tag });
        assert.notEqual(other.status, 304, `${path} as ${seat}`);
      }
      // A weak or listed spelling of another reader's tag is no better.
      assert.notEqual((await get('clerk', path, { 'if-none-match': `W/${tag}, "x"` })).status, 304);
    }
    const clerkSchema = (await get('clerk', '/api/schema')).body;
    assert.doesNotMatch(JSON.stringify(clerkSchema.tables.find((t: { id: string }) => t.id === 'task')), /"salary"|"secret"/);
  });
});

describe("a file's preview (GET /api/file)", () => {
  const at = (extra = '') => `/api/file?table=attachment&key=${encodeURIComponent(JSON.stringify({ id: 1 }))}&inline=1${extra}`;

  test("a signed-in reader's photo is revalidated every time, per session, so a sign-out or the next account holds at once", async () => {
    for (const variant of ['', '&variant=thumb']) {
      const photo = await get('admin', at(variant));
      assert.equal(photo.status, 200);
      assert.equal(photo.headers['cache-control'], 'private, no-cache');
      assert.match(String(photo.headers.vary), /Cookie/);
      assert.equal(photo.headers['content-type'], 'image/png');
      const tag = String(photo.headers.etag);
      assert.equal((await get('admin', at(variant), { 'if-none-match': tag })).status, 304);
      // The tag is the bytes', but the read runs first: a reader without the resource is refused, never a 304.
      for (const seat of ['outsider', 'public'] as const) {
        const refused = await get(seat, at(variant), { 'if-none-match': tag });
        assert.ok(refused.status >= 400, `${seat}: ${refused.status}`);
      }
    }
  });

  test("a key that is not the record's is refused, not widened", async () => {
    for (const key of ['{"id":{"op":">","value":0}}', '{"id":1,"file_name":"front.png"}', '[1]', '"1 OR 1=1"', '{"__proto__":1}']) {
      const refused = await get('admin', `/api/file?table=attachment&key=${encodeURIComponent(key)}`);
      assert.ok(refused.status >= 400, `${key}: ${refused.status}`);
    }
    assert.equal(
      (await get('admin', `/api/file?table=task&key=${encodeURIComponent('{"id":1}')}`)).status,
      404,
      'a resource that holds no files',
    );
  });
});

describe('rollups under field grants and forged definitions', () => {
  test('a rollup built from a field the reader may not read is not served, and a request cannot bring its own', async () => {
    const rollups = async (seat: Seat) =>
      (await get(seat, '/api/schema')).body?.tables?.find((t: { id: string }) => t.id === 'person')?.rollups;
    assert.deepEqual(Object.keys((await rollups('admin')) ?? {}).sort(), ['pay', 'tasks']);
    assert.deepEqual(Object.keys((await rollups('clerk')) ?? {}), ['tasks'], 'the clerk counts tasks but may not sum salaries');
    assert.equal(await rollups('outsider'), undefined, 'the outsider reads no task, so no number is built from them');
    const asked = await post('clerk', '/api/run', { q: 'person show name, pay', limit: 5 });
    assert.ok(!asked.body?.rows, asked.text);
    const forged = await post('clerk', '/api/view/run', {
      count: 'none',
      view: {
        id: 'x',
        name: 'x',
        base: 'person',
        columns: [{ path: 'pay' }],
        computed: { pay: { fn: 'sum', via: 'task.owner_id', column: 'salary', type: 'INTEGER', on: '' } },
      },
    });
    assert.ok(!forged.body?.rows, forged.text);
    const smuggled = await post('outsider', '/api/view/run', {
      count: 'none',
      view: {
        id: 'x',
        name: 'x',
        base: 'person',
        columns: [{ path: 'name' }, { path: 'n' }],
        computed: {
          n: {
            fn: 'count',
            via: 'task.owner_id',
            type: 'INTEGER',
            on: '',
            filter: { groups: [[{ column: 'secret', op: '=', value: SECRET }]] },
          },
        },
      },
    });
    assert.ok(!smuggled.body?.rows?.some((row: Record<string, unknown>) => row.n !== undefined), smuggled.text);
  });
});

describe('a cell edited in place (the update a grid\'s cell and "Set field…" send)', () => {
  test("lands only where the reader's grant writes", async () => {
    const renamed = await post('clerk', '/api/update', {
      table: 'task',
      key: { id: 1 },
      values: { status: 'done' },
      expected: { status: 'open' },
    });
    assert.equal(renamed.status, 200, renamed.text);
    const salary = await post('clerk', '/api/update', { table: 'task', key: { id: 1 }, values: { salary: 1 }, expected: { salary: 100 } });
    assert.ok(salary.status >= 400, salary.text);
    assert.equal((db.prepare('SELECT salary FROM task WHERE id = 1').get() as { salary: number }).salary, 100);
    assert.ok((await post('outsider', '/api/update', { table: 'task', key: { id: 1 }, values: { title: 'x' } })).status >= 400);
    assert.equal((await post('public', '/api/update', { table: 'task', key: { id: 1 }, values: { title: 'x' } })).status, 401);
    // A stale tab's account is not the session's, whatever it says.
    const stale = await post(
      'admin',
      '/api/update',
      { table: 'task', key: { id: 1 }, values: { title: 'x' } },
      { 'x-mistri-account': 'account-clerk' },
    );
    assert.equal(stale.status, 409, stale.text);
    await post('clerk', '/api/update', { table: 'task', key: { id: 1 }, values: { status: 'open' }, expected: { status: 'done' } });
  });
});

describe("a public page's head and its 301", () => {
  before(() => {
    db.prepare('UPDATE task SET title = ? WHERE id = 1').run(HOSTILE);
  });
  after(() => {
    db.prepare('UPDATE task SET title = ? WHERE id = 1').run('First task');
  });

  // One App on the server: it is served at the root (shared/mount.ts).
  test('a record named in markup and replacement patterns is written into the head as text', async () => {
    const moved = await raw('GET', '/tasks/1', {});
    assert.equal(moved.status, 301, moved.text.slice(0, 200));
    const location = String(moved.headers.location);
    assert.match(location, /^\/tasks\/1-[a-z0-9-]+$/);
    const page = await raw('GET', location, {});
    assert.equal(page.status, 200);
    const title = /<title>([\s\S]*?)<\/title>/.exec(page.text)?.[1];
    const escaped = HOSTILE.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    assert.equal(title, `${escaped} · Sec`);
    assert.doesNotMatch(page.text, /<script>alert/);
    assert.equal((page.text.match(/<title>/g) ?? []).length, 1, 'the page is written once, not poured into its own title');
    assert.match(page.text, new RegExp(`<link rel="canonical" href="${location}">`));
  });

  test('neither the 301 nor the canonical link can be pointed off the site', async () => {
    for (const path of [
      '//evil.example/tasks/1',
      '/tasks/1?next=//evil.example',
      '/tasks/1-%2F%2Fevil.example',
      '/tasks/1?x=%0d%0aSet-Cookie:%20a=b',
      '//tasks/1',
      '/%2F%2Fevil.example/tasks/1',
    ]) {
      const reply = await raw('GET', path, {});
      assert.ok(reply.status === 200 || reply.status === 301, `${path}: ${reply.status}`);
      const location = reply.headers.location === undefined ? undefined : String(reply.headers.location);
      if (location !== undefined) {
        assert.match(location, /^\/[^/]/, `${path} → ${location}`);
        assert.doesNotMatch(location, /[\r\n]/);
      }
      assert.equal(reply.headers['set-cookie'], undefined, path);
      const canonical = /<link rel="canonical" href="([^"]*)">/.exec(reply.text)?.[1];
      if (canonical !== undefined) assert.match(canonical, /^\/[^/]/, `${path}: ${canonical}`);
    }
  });

  test('a signed-in reader and a table outside the public grant get the plain shell', async () => {
    const signedIn = await raw('GET', '/tasks/1', { seat: 'admin' });
    assert.equal(signedIn.status, 200);
    assert.doesNotMatch(signedIn.text, /rel="canonical"/);
    for (const path of ['/people/1', '/attachment/1', '/tasks/..%2f..%2fpackage.json', '/tasks/%E0%A4%A']) {
      const reply = await raw('GET', path, {});
      assert.ok(reply.status === 200 || reply.status === 404, `${path}: ${reply.status}`);
      assert.doesNotMatch(reply.text, /Ann|bob@|"version"/, path);
      assert.doesNotMatch(reply.text, /rel="canonical"/, path);
    }
  });
});

describe("a custom component's files", () => {
  const file = `/_components/${COMPONENT}`;

  test("are the signed-in reader's, kept privately, and nobody else's", async () => {
    for (const suffix of ['.js', '.js.map']) {
      const reader = await raw('GET', file + suffix, { seat: 'clerk' });
      assert.equal(reader.status, 200, suffix);
      assert.match(String(reader.headers['cache-control']), /^private/);
    }
    // The source map carries the App's own source: never a signed-out visitor's, even where `auth.public` opens reads.
    const map = await raw('GET', `${file}.js.map`);
    assert.equal(map.status, 404, '.js.map signed out');
    assert.doesNotMatch(map.text, new RegExp(SOURCE));
  });

  test('reach a signed-out visitor only where `auth.public` opens the App, and never through a shared cache', async (t) => {
    /* A component may draw on a public read, so an App with `auth.public` serves a visitor the compiled code. */
    const visitor = await raw('GET', `${file}.js`);
    assert.equal(visitor.status, 200, '.js signed out, public App');
    assert.match(String(visitor.headers['cache-control']), /^private/);
    assert.doesNotMatch(visitor.text, new RegExp(SOURCE));
    /* The same App with nothing public: there is no such file for a visitor, compiled or mapped. */
    const own = { host: '127.0.0.1', port: 0 };
    const hush = createApp({ registry, bound: own, apps: [hushHost], pages: [] });
    hush.listen(0, own.host);
    await once(hush, 'listening');
    own.port = (hush.address() as { port: number }).port;
    t.after(async () => {
      const closed = new Promise<void>((resolve) => hush.close(() => resolve()));
      hush.closeAllConnections();
      await closed;
    });
    const hushed = `/_components/${COMPONENT}`;
    for (const suffix of ['.js', '.js.map']) {
      const closed = await raw('GET', hushed + suffix, { port: own.port });
      assert.equal(closed.status, 404, `${suffix} signed out, private App`);
      assert.doesNotMatch(closed.text, new RegExp(SOURCE));
      assert.doesNotMatch(closed.text, /export default/);
      const reader = await raw('GET', hushed + suffix, { seat: 'clerk', port: own.port });
      assert.equal(reader.status, 200, `${suffix} signed in, private App`);
      assert.match(String(reader.headers['cache-control']), /^private/);
    }
  });

  test("name only what the App compiled: no traversal, no inherited names, no other App's", async () => {
    for (const path of [
      '/_components/..%2F..%2Fpackage.json',
      '/_components/constructor.js',
      '/_components/__proto__.js',
      `/other/_components/${COMPONENT}.js`,
      `/${appId}/_components/${COMPONENT}.js`,
      `/_components/${COMPONENT}.JS`,
      '/_mistri/sdk/constructor',
      '/_mistri/sdk/..%2F..%2Fpackage.json',
      '/_mistri/sdk/toString',
    ]) {
      const reply = await raw('GET', path, { seat: 'admin' });
      assert.notEqual(reply.headers['content-type'], 'text/javascript; charset=utf-8', path);
      assert.doesNotMatch(reply.text, /"dependencies"|native code/, path);
    }
  });
});
