/**
 * A page's optional read (`definePage({ optionalReads })`, a field report): one component on a page two roles open,
 * showing more to the role that may see it (a visit's note to a dentist, not the front desk). `check` held every read
 * of a page to every role it names, so such a page could not be declared at all. An optional read is no part of who
 * is offered the page; for a reader without the grant it is refused before anything is read, and a read the page
 * makes for everyone (`reads`) is still held to every role.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { loadConfig, Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { pageManifestRefusal } from '../packages/mistri/src/server/http/pageLoad.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';
import { appForRoles } from '../packages/mistri/src/shared/appViewRoles.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const component = (key: string) => ({ id: `page-${key}`, module: `./pages/${key}.page.tsx`, kind: 'page' });
const APP = {
  id: 'chair',
  name: 'Chair',
  connection: 'chair-db',
  resources: { visit: {}, note: {}, fee: {} },
  auth: {
    providers: ['email'],
    roles: { dentist: { read: ['visit', 'note'] }, desk: { read: ['visit'] }, billing: { read: ['visit', 'fee'] } },
  },
  views: {
    visits: { kind: 'list', from: 'visit', label: 'Visits' },
    schedule: {
      kind: 'page',
      label: 'Schedule',
      component: component('schedule'),
      roles: ['dentist', 'desk'],
      reads: ['visit'],
      optionalReads: ['note'],
    },
  },
  home: 'visits',
  nav: ['visits', 'schedule'],
};
const parse = (schedule: Record<string, unknown> = {}) =>
  parseTestApp({ ...APP, views: { ...APP.views, schedule: { ...APP.views.schedule, ...schedule } } }, 'chair');

test('an optional read is no part of who is offered the page, and a read the page makes for everyone still is', () => {
  const app = parse();
  const view = app.views.schedule as { roles?: string[]; page?: { reads: string[]; optionalReads?: string[] } };
  assert.deepEqual(view.page?.reads, ['visit']);
  assert.deepEqual(view.page?.optionalReads, ['note']);
  assert.deepEqual(view.roles, ['dentist', 'desk']);
  assert.ok('schedule' in appForRoles(app, ['desk']).views, 'the desk, which reads no note, is offered the page');
  /* Unnamed, the page is offered by its reads alone: the optional one narrows nobody out. */
  const { roles: _roles, ...open } = APP.views.schedule;
  const offered = parseTestApp({ ...APP, views: { ...APP.views, schedule: open } }, 'chair').views.schedule as { roles?: string[] };
  assert.deepEqual(offered.roles, ['dentist', 'desk', 'billing']);

  // The negative: the same table as a plain read is still refused for the role that cannot make it, and says the way out.
  assert.throws(
    () => parse({ reads: ['visit', 'note'], optionalReads: undefined }),
    /\[page-coverage\].*offered to the role "desk", which is not granted "note".*move "note" to "optionalReads" and read it with \{ optional: true \}/,
  );
  // An optional read nobody the page is offered to could make is a mistake, as a command no offered role may run is.
  assert.throws(
    () => parse({ optionalReads: ['fee'] }),
    /\[page-coverage\].*names "fee" in "optionalReads", which no role it is offered to is granted/,
  );
  assert.throws(() => parse({ optionalReads: ['visit'] }), /\[page-reads\].*names "visit" in "reads" and in "optionalReads"/);
  assert.throws(() => parse({ optionalReads: 'note' }), /\[page-reads\].*"optionalReads" that are not a list of resources/);
  assert.throws(() => parse({ optionalReads: [] }), /\[page-reads\].*"optionalReads" that are not a list of resources/);
  assert.throws(() => parse({ optionalReads: ['ledger'] }), /ledger/);
  assert.throws(
    () =>
      parseTestApp(
        {
          ...APP,
          auth: { ...APP.auth, public: { read: ['visit'] } },
          views: { ...APP.views, schedule: { ...open, public: true } },
        },
        'chair',
      ),
    /\[page-public\].*is public and names "optionalReads"/,
  );
});

const PAGE = `import { definePage, EmptyState } from '@mistriwork/mistri/page';
export default definePage({
  label: 'Schedule',
  roles: ['dentist', 'desk'],
  reads: ['visit'],
  optionalReads: ['note'],
  component: () => <EmptyState title="Schedule" />,
});
`;

/** Every statement the process's SQLite connections were handed while `work` ran. */
async function statements<T>(work: () => Promise<T>): Promise<{ value: T; sql: string[] }> {
  const sql: string[] = [];
  const proto = DatabaseSync.prototype as unknown as Record<'prepare' | 'exec', (text: string, ...rest: unknown[]) => unknown>;
  const { prepare, exec } = proto;
  proto.prepare = function (this: unknown, text, ...rest) {
    sql.push(text);
    return prepare.call(this, text, ...rest);
  };
  proto.exec = function (this: unknown, text, ...rest) {
    sql.push(text);
    return exec.call(this, text, ...rest);
  };
  try {
    return { value: await work(), sql };
  } finally {
    proto.prepare = prepare;
    proto.exec = exec;
  }
}

async function serve(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-page-optional-'));
  const appDir = join(directory, 'app');
  mkdirSync(join(appDir, 'pages'), { recursive: true });
  const { views: _views, connection: _connection, ...rest } = APP;
  writeFileSync(
    join(appDir, 'app.json'),
    JSON.stringify({
      ...rest,
      sources: { chair: { connection: 'chair-db', default: true } },
      views: { visits: APP.views.visits },
      nav: ['visits'],
    }),
  );
  writeFileSync(join(appDir, 'pages', 'schedule.page.tsx'), PAGE);
  const file = join(directory, 'chair.db');
  const seed = new DatabaseSync(file);
  seed.exec(`CREATE TABLE visit (id INTEGER PRIMARY KEY, patient TEXT NOT NULL);
    CREATE TABLE note (id INTEGER PRIMARY KEY, visit_id INTEGER NOT NULL REFERENCES visit(id), body TEXT NOT NULL);
    CREATE TABLE fee (id INTEGER PRIMARY KEY, cents INTEGER NOT NULL);
    INSERT INTO visit VALUES (1, 'Ada');
    INSERT INTO note VALUES (1, 1, 'Crown on 14, sensitive');`);
  seed.close();
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ id: 'chair-db', name: 'chair-db', url: file }] }));
  const registry = new Registry();
  for (const c of (await loadConfig(config, CONFIG_SECTIONS))!.connections) registry.add({ ...c, writable: false, source: 'config' });
  const loaded = await loadApp(appDir);
  const control = { identity: null as Identity | null };
  const host: AppHost = {
    app: loaded,
    pages: loaded.pages,
    auth: {
      spec: loaded.app.auth!,
      store: join(directory, 'sessions.db'),
      close: async () => {},
      session: async () => control.identity,
      handler: async () => {},
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, apps: [host], pages: loaded.pages, bound });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const post = async (path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}?app=chair`, {
      signal: AbortSignal.timeout(5000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ app: 'chair', ...body }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Record<string, any> };
  };
  return {
    loaded,
    as: (role: string) => {
      control.identity = { id: role, who: `${role}@example.test`, role } as Identity;
    },
    /** A read the page makes, as its hook makes it: a view run under the page's header. */
    read: (base: string, extra: Record<string, unknown> = {}) =>
      post('/api/view/run', { view: { base }, count: 'none', ...extra }, { 'x-mistri-page': 'schedule' }),
    post,
  };
}

test('a refused optional read is answered 403 before anything is read; the granted role reads it, and the page loads for both', async (t) => {
  const f = await serve(t);
  const page = f.loaded.app.views.schedule as { page: { reads: string[]; optionalReads?: string[] } };
  assert.deepEqual(page.page.optionalReads, ['note'], 'the page file is placed with its optional read');

  f.as('desk');
  // The page is the desk's to open: its own read is answered.
  const visits = await f.read('visit');
  assert.equal(visits.status, 200, visits.text);
  assert.deepEqual(visits.body.rows, [{ id: 1, patient: 'Ada' }]);
  // Its optional read is refused, and no statement that names the table reached the database.
  const refused = await statements(() => f.read('note'));
  assert.equal(refused.value.status, 403, refused.value.text);
  assert.equal(refused.value.body.code, 'forbidden');
  assert.doesNotMatch(refused.value.text, /Crown|sensitive|rows/);
  assert.deepEqual(
    refused.sql.filter((text) => /\bnote\b/i.test(text)),
    [],
    'a refused optional read sends no query',
  );
  // The same answer whether rows match or none could: a filter that matches nothing is refused alike.
  const none = await statements(() =>
    f.read('note', { view: { base: 'note', filter: { groups: [[{ path: 'id', op: '=', value: 999 }]] } } }),
  );
  assert.equal(none.value.status, 403, none.value.text);
  assert.equal(none.value.text, refused.value.text);
  assert.deepEqual(
    none.sql.filter((text) => /\bnote\b/i.test(text)),
    [],
  );
  // Through a path from a read it does hold, the table is no nearer.
  const walked = await f.post('/api/view/run', { text: 'note\n  show visit_id.patient' }, { 'x-mistri-page': 'schedule' });
  assert.equal(walked.status, 403, walked.text);
  // A table the page declares nowhere is still a stray, optional or not.
  const stray = await f.read('fee');
  assert.equal(stray.status, 403, stray.text);
  assert.equal(stray.body.code, 'page_undeclared');
  // Without the page's header the grant is the boundary, as ever: the desk reads no note.
  const bare = await f.post('/api/view/run', { view: { base: 'note' }, count: 'none' });
  assert.equal(bare.status, 404, bare.text);
  assert.doesNotMatch(bare.text, /Crown/);

  f.as('dentist');
  const read = await statements(() => f.read('note'));
  assert.equal(read.value.status, 200, read.value.text);
  assert.equal(read.value.body.rows[0].body, 'Crown on 14, sensitive');
  assert.ok(
    read.sql.some((text) => /\bnote\b/i.test(text)),
    'the spy sees the read that is made',
  );

  // A role the page is not offered to opens no part of it.
  f.as('billing');
  assert.equal((await f.read('visit')).body.code, 'page_undeclared');
});

test('the manifest gate refuses a closed optional read itself, on the catalog the reader is served', () => {
  const app = parse();
  const column = (name: string) => ({ name, type: 'TEXT', nullable: false, primaryKey: name === 'id' });
  const table = (id: string) => ({ id, name: id, schema: '', isView: false, columns: [column('id')] });
  const deskSchema = { label: 'Chair', dialect: 'sqlite', tables: [table('visit')], foreignKeys: [] } as never;
  const dentistSchema = { label: 'Chair', dialect: 'sqlite', tables: [table('visit'), table('note')], foreignKeys: [] } as never;
  const ask = (roles: string[], schema: never, base: string) =>
    pageManifestRefusal({ app, roles, header: 'schedule', path: '/api/view/run', body: { view: { base } }, schema });
  assert.equal(ask(['desk'], deskSchema, 'visit'), undefined);
  assert.deepEqual(ask(['desk'], deskSchema, 'note'), {
    status: 403,
    body: { error: '"note" is not open to your role.', code: 'forbidden', outcome: 'not_applied' },
  });
  assert.equal(ask(['dentist'], dentistSchema, 'note'), undefined, 'the granted reader goes on to the read');
  assert.equal(ask(['desk'], deskSchema, 'fee')?.body.code, 'page_undeclared');
});
