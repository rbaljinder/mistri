/** A combination: one free-form page (`pages/board.page.tsx`) reading a SQL table and an HTTP source's resource.
 * Each is covered alone elsewhere (app-pages.test.ts, app-resource-http.test.ts); the pair is where a read could slip
 * past a grant, because an HTTP source is not the connection the App's home source reads and `crm.contacts` is a
 * name no table of the home catalog carries. The App is written to a scratch directory the way an author lays one
 * out (app.json and pages/), loaded by loadApp so the page file is placed as a view, and served in-process over a
 * real SQLite file and a stub REST server, with the signed-in role switched per request. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { loadConfig, Registry } from '../packages/engine/src/server/connections.js';
import { loadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';
import { pageQueryFailures } from '../packages/mistri/src/server/build/checkQueries.js';
import { createApp } from './support/createApp.js';
import { startFakeRest } from './support/fakeRest.js';

const spec = JSON.parse(readFileSync(new URL('./fixtures/http/openapi.json', import.meta.url), 'utf8'));

const SQL = `CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  INSERT INTO ticket VALUES (1, 'Printer jam'), (2, 'No badge');`;

const APP = {
  id: 'deskcrm',
  name: 'Desk and CRM',
  sources: { desk: { connection: 'desk-db', default: true }, crm: { connection: 'crm-api' } },
  resources: { ticket: {}, 'crm.contacts': {} },
  auth: {
    providers: ['email'],
    roles: {
      both: { read: ['ticket', 'crm.contacts'] },
      desk: { read: ['ticket'] },
      nobody: { read: [] },
    },
  },
  views: {
    tickets: { kind: 'list', from: 'ticket', label: 'Tickets' },
    contacts: { kind: 'list', from: 'crm.contacts', label: 'Contacts' },
  },
  home: 'tickets',
  nav: ['tickets', 'contacts'],
};

const PAGE = `import { definePage, Empty } from '@mistriwork/mistri/page';
export default definePage({
  label: 'Board',
  reads: ['ticket', 'crm.contacts'],
  component: () => <Empty title="Board" />,
});
`;

async function serve(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-page-sources-'));
  const api = await startFakeRest();
  const appDir = join(directory, 'app');
  mkdirSync(join(appDir, 'pages'), { recursive: true });
  writeFileSync(join(appDir, 'app.json'), JSON.stringify(APP));
  writeFileSync(join(appDir, 'pages', 'board.page.tsx'), PAGE);
  const file = join(directory, 'desk.db');
  const seed = new DatabaseSync(file);
  seed.exec(SQL);
  seed.close();
  writeFileSync(join(directory, 'crm.http.json'), JSON.stringify(draftDescription(readOpenApi(spec))));
  const config = join(directory, 'mistri.json');
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { id: 'desk-db', name: 'desk-db', url: file },
        { id: 'crm-api', name: 'crm-api', kind: 'http', url: `${api.origin}/v1`, description: 'crm.http.json', insecure: true },
      ],
    }),
  );
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
    await api.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const as = (role: string) => {
    control.identity = { id: role, who: `${role}@example.test`, role } as Identity;
  };
  /** A read the board makes, as its component makes it: a view run, with the page's header. */
  const read = async (base: string, page = true) => {
    const response = await fetch(`http://${bound.host}:${bound.port}/api/view/run?app=deskcrm`, {
      signal: AbortSignal.timeout(5000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(page ? { 'x-mistri-page': 'board' } : {}) },
      body: JSON.stringify({ app: 'deskcrm', view: { base }, count: 'none' }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  /** A list as the App's own list room reads it: the query-language run, in no order. */
  const run = async (q: string) => {
    const response = await fetch(`http://${bound.host}:${bound.port}/api/run?app=deskcrm`, {
      signal: AbortSignal.timeout(5000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { as, read, run, loaded, api, config, appDir, directory, control };
}

test('combination: a page × a SQL table and an HTTP source reads rows from both, for the role granted both', async (t) => {
  const f = await serve(t);
  const board = f.loaded.app.views.board as { page: { reads: string[] } };
  assert.deepEqual(board.page.reads, ['ticket', 'crm.contacts'], 'the page file is placed as a view that reads one of each');
  f.as('both');
  const tickets = await f.read('ticket');
  assert.equal(tickets.status, 200, JSON.stringify(tickets.body));
  assert.deepEqual(tickets.body.rows, [
    { id: 1, name: 'Printer jam' },
    { id: 2, name: 'No badge' },
  ]);
  const before = f.api.seen.length;
  const contacts = await f.read('crm.contacts');
  assert.equal(contacts.status, 200, JSON.stringify(contacts.body));
  assert.equal(contacts.body.rows[0].id, 'c-01');
  assert.equal(contacts.body.rows[0].name, 'Contact 1');
  assert.ok(
    f.api.seen.slice(before).some((request) => request.path === '/v1/contacts'),
    'the rows came from the stub API, not the SQL database',
  );
});

test('combination: a page × an HTTP source refuses the HTTP read to a role not granted it, and the SQL read still works', async (t) => {
  const f = await serve(t);
  f.as('desk');
  // The page is offered only to a role that holds every read it declares, so as the page it is not found for this one...
  for (const base of ['ticket', 'crm.contacts']) {
    const refused = await f.read(base);
    assert.equal(refused.status, 403, base);
    assert.equal(refused.body.code, 'page_undeclared', base);
  }
  // ...and the page header is drift protection, not the boundary: the grants are, and they hold without it.
  assert.equal((await f.read('ticket', false)).status, 200);
  const before = f.api.seen.length;
  const http = await f.read('crm.contacts', false);
  assert.equal(http.status, 404);
  assert.equal(http.body.error, 'Unknown table "crm.contacts"');
  assert.equal(f.api.seen.length, before, 'a refused read never reaches the API');

  f.as('nobody');
  for (const base of ['ticket', 'crm.contacts']) {
    const refused = await f.read(base, false);
    assert.equal(refused.status, 404, base);
    assert.equal(refused.body.error, `Unknown table "${base}"`, base);
    assert.equal((await f.read(base)).body.code, 'page_undeclared', base);
  }
  assert.equal(f.api.seen.length, before, 'nor does a role granted nothing reach it');
});

/** The merged catalog's `dialect` is the home source's (SQLite here); `crm.contacts` is read on its own source's engine.
 * A list asked for in no order sends no sort: the key as a default sort is one the API does not document, and once
 * every plain list of an HTTP resource beside a SQL home source was refused for asking it (`sourceDialect`). */
test('combination: a page × an HTTP source: a list read in no order sends the API no sort, though the home source is SQL', async (t) => {
  const f = await serve(t);
  f.as('both');
  const before = f.api.seen.length;
  const list = await f.run('crm.contacts');
  assert.equal(list.status, 200, JSON.stringify(list.body));
  assert.equal(list.body.rows[0].id, 'c-01');
  const sent = f.api.seen.slice(before).filter((request) => request.path === '/v1/contacts');
  assert.ok(sent.length >= 1, 'the rows came from the API');
  for (const request of sent) assert.equal(request.query.get('sort'), null, request.query.toString());
  const view = await f.read('crm.contacts');
  assert.equal(view.status, 200, JSON.stringify(view.body));
  for (const request of f.api.seen.slice(before)) assert.equal(request.query.get('sort'), null, request.query.toString());
});

/** There is no `--plan` flag: the queries step (on by default, `--no-query-check` skips it) is what has the database
 * EXPLAIN the App's reads. It plans the home source's lists, and a free-form page's own reads are a loader's code, not
 * statements the compiler writes, so "0 page sections" is right here. */
test('combination: a page × an HTTP source: the queries step plans the SQL reads and leaves the HTTP one alone', async (t) => {
  const f = await serve(t);
  const registry = new Registry();
  t.after(() => registry.closeAll());
  for (const c of (await loadConfig(f.config, CONFIG_SECTIONS))!.connections) registry.add({ ...c, writable: false, source: 'config' });
  const planned = await pageQueryFailures(registry, f.loaded.app, f.loaded.pages, 'desk-db');
  assert.deepEqual(planned.failures, []);
  assert.ok(planned.statements >= 1, 'the ticket list is planned');
  assert.equal(planned.skipped, 0);

  // The step through the real command: it passes and says it planned statements, with the HTTP source in the App.
  const before = f.api.seen.length;
  const out = await new Promise<string>((done) =>
    execFile(
      process.execPath,
      ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), 'check', '--app', f.appDir, '--config', f.config, '--json'],
      { env: { ...process.env, XDG_CONFIG_HOME: join(f.directory, 'xdg') }, timeout: 180_000, killSignal: 'SIGKILL' },
      (_error, stdout) => done(stdout),
    ),
  );
  const report = JSON.parse(out) as {
    steps: Array<{ step: string; status: string; detail?: string }>;
    problems: Array<{ code: string; message?: string }>;
  };
  const queries = report.steps.find((step) => step.step === 'queries');
  assert.ok(queries, JSON.stringify(report.steps));
  assert.equal(queries.status, 'passed', JSON.stringify(queries));
  assert.match(
    queries.detail ?? '',
    new RegExp(`planned the ${planned.statements} statements`),
    'the same SQL statements, and none for the HTTP list',
  );
  assert.ok(!report.problems.some((problem) => problem.code === 'query-invalid'));
  assert.equal(f.api.seen.length, before, 'check plans SQL and never calls the API');
});
