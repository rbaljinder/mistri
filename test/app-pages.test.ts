/**
 * Free-form pages (`definePage` in `pages/<path>.page.tsx`) and their
 * loaders: each refusal `mistri check` names, with one fixture apiece;
 * what authority.lock and the address book say of a page; and the loader as
 * the security boundary it is — it reads as the reader, through the same
 * scoped reader as every other read (row policy included), never writes,
 * runs only for a page that names it, and ends in time and in size.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { connect } from '../packages/engine/src/adapters/connect.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { astParser, pageFiles, placePages, readPageFiles, scanPageSource } from '../packages/mistri/src/server/app/appPages.js';
import { checkPageLoaders } from '../packages/mistri/src/server/app/pageLoaderCheck.js';
import { defineLoader, defineLoaders, LOADER_RESULT_MOST, type PageLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { runPageLoader } from '../packages/mistri/src/server/commands/pageLoaderRun.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { pageLoad, pageManifestRefusal } from '../packages/mistri/src/server/http/pageLoad.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { commandTypes } from '../packages/mistri/src/server/typegen.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseTestApp } from './support/commandCatalog.js';

const component = (key: string) => ({ id: `page-${key}`, module: `./pages/${key}.page.tsx`, kind: 'page' });
const SQL = `CREATE TABLE desk (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE ticket (id INTEGER PRIMARY KEY, desk_id INTEGER REFERENCES desk(id), name TEXT NOT NULL);
  CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);
  INSERT INTO desk VALUES (1, 'North'), (2, 'South');
  INSERT INTO ticket VALUES (1, 1, 'North one'), (2, 1, 'North two'), (3, 2, 'South one');
  INSERT INTO note VALUES (1, 'Kept from readers');`;

/* A desk where a reader reads desks and tickets and a clerk reads everything; the lobby is open to visitors. */
const APP = {
  id: 'desk',
  name: 'Desk',
  connection: 'desk-db',
  resources: { desk: {}, ticket: { access: 'write' }, note: {} },
  auth: {
    roles: { reader: { read: ['desk', 'ticket'] }, clerk: { read: true, write: ['ticket'], commands: ['settle'] } },
    public: { read: ['desk'] },
  },
  views: {
    tickets: { kind: 'list', from: 'ticket', label: 'Tickets' },
    board: { kind: 'page', label: 'Board', component: component('board'), reads: ['ticket', 'desk'], params: ['desk'], loader: 'board' },
    settle: { kind: 'page', label: 'Settle', component: component('settle'), reads: ['ticket'], commands: ['settle'] },
    notes: { kind: 'page', label: 'Notes', component: component('notes'), reads: ['note'], loader: 'notes' },
    lobby: { kind: 'page', label: 'Lobby', component: component('lobby'), reads: ['desk'], loader: 'lobby', public: true },
  },
  home: [{ view: 'lobby', signedOut: true }, { view: 'tickets' }],
  nav: ['tickets', 'board', 'settle', 'notes', 'lobby'],
};
const CONTRACTS = { settle: { target: 'ticket' } };
const parse = (raw: object = APP) => parseTestApp(raw, 'desk', CONTRACTS);
const views = (change: Record<string, unknown>) => ({ ...APP, views: { ...APP.views, ...change } });

const LOADERS = defineLoaders({
  board: defineLoader({
    reads: ['ticket', 'desk'],
    async load({ db, params }) {
      const tickets = await db.ticket.where(params.desk ? { desk_id: Number(params.desk) } : {}).orderBy('id');
      return { tickets: tickets.map((row) => String(row.name)) };
    },
  }),
  notes: defineLoader({ reads: ['note'], load: async ({ db }) => ({ notes: (await db.note.where({})).length }) }),
  lobby: defineLoader({ reads: ['desk'], load: async ({ db, viewer }) => ({ desks: (await db.desk.where({})).length, viewer }) }),
}) as unknown as Readonly<Record<string, PageLoader>>;

describe('what check refuses, one fixture per code', () => {
  /* Page files on disk, read under the stand-ins the server reads them with. */
  async function readFiles(t: TestContext, files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-pages-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'pages'));
    for (const [name, source] of Object.entries(files)) writeFileSync(join(dir, 'pages', name), source);
    return readPageFiles(dir, await pageFiles(dir));
  }
  const pageSource = (fields: string) =>
    `import { definePage, Empty } from '@mistriwork/mistri/page';\nexport default definePage({ ${fields}, component: () => <Empty title="x" /> });\n`;

  test('page-file: a page file whose default is not a definePage, or that gives definePage a key it does not take', async (t) => {
    await assert.rejects(
      readFiles(t, { 'a.page.tsx': 'export default 1;\n' }),
      /\[page-file\] pages\/a\.page\.tsx:? has no default export made by definePage/,
    );
    await assert.rejects(
      readFiles(t, { 'a.page.tsx': pageSource("label: 'A', reads: ['desk'], sql: 'select 1'") }),
      /\[page-file\] pages\/a\.page\.tsx: definePage has no "sql"/,
    );
    await assert.rejects(readFiles(t, { 'a.page.tsx': pageSource("reads: ['desk']") }), /\[page-file\].*has no "label"/);
    // What is read is the definition alone: the component is never called, and the worker is handed no environment.
    const [read] = await readFiles(t, {
      'a.page.tsx': `import { definePage } from '@mistriwork/mistri/page';
export default definePage({ label: String(typeof process === 'object' && process.env && Object.keys(process.env).length), reads: ['desk'],
  component: () => { throw new Error('drawn on the server'); } });\n`,
    });
    assert.deepEqual(read, { key: 'a', module: './pages/a.page.tsx', fields: { label: '0', reads: ['desk'] } });
  });

  test("page-path: definePage takes no path, a file name the server answers itself is refused, and a view's is too", async (t) => {
    // The file's name is the path; saying one is refused with the way to leave it out, whether or not it agrees.
    for (const said of ['b', 'a']) {
      await assert.rejects(
        readFiles(t, { 'a.page.tsx': pageSource(`path: '${said}', label: 'A', reads: ['desk']`) }),
        /\[page-file\] pages\/a\.page\.tsx: definePage has "path", which is now the file's name: pages\/pick-walk\.page\.tsx is the page at \/pick-walk, so leave it out/,
      );
    }
    await assert.rejects(
      readFiles(t, { 'api.page.tsx': pageSource("label: 'A', reads: ['desk']") }),
      /\[page-path\].*"api" is not a page's path/,
    );
    const page = { key: 'tickets', module: './pages/tickets.page.tsx', fields: { label: 'T', reads: ['desk'] } };
    assert.throws(() => placePages(APP, [page], 'desk'), /\[page-path\].*already has a view "tickets"/);
  });

  test('page-nav: a page placed where nav has no group, or named in nav as well as placing itself', () => {
    const page = (nav: unknown) => ({
      key: 'walk',
      module: './pages/walk.page.tsx',
      fields: { label: 'Walk', reads: ['desk'], nav },
    });
    const grouped = { ...APP, nav: [{ id: 'floor', label: 'Floor', children: ['tickets'] }] };
    assert.throws(() => placePages(grouped, [page({ group: 'yard' })], 'desk'), /\[page-nav\].*nav has no group "yard"/);
    assert.throws(
      () => placePages({ ...APP, nav: ['tickets', 'walk'] }, [page({})], 'desk'),
      /\[page-nav\] desk: nav names "walk", a free-form page/,
    );
    const placed = placePages(grouped, [page({ group: 'floor', position: 0 })], 'desk');
    assert.deepEqual((placed.nav as Array<{ children: string[] }>)[0].children, ['walk', 'tickets'], 'a page places itself where it asks');
    assert.deepEqual(placePages(APP, [page(false)], 'desk').nav, APP.nav, 'nav: false keeps it out of the menu');
  });

  test('page-reads, page-params, page-commands, page-public, page-coverage: what the page declares, held to the App', () => {
    assert.throws(() => parse(views({ board: { ...APP.views.board, reads: [] } })), /\[page-reads\]/);
    assert.throws(() => parse(views({ board: { ...APP.views.board, params: ['period'] } })), /\[page-params\]/);
    assert.throws(() => parse(views({ settle: { ...APP.views.settle, commands: ['refund'] } })), /\[page-commands\].*"refund"/);
    assert.throws(
      () => parse(views({ lobby: { ...APP.views.lobby, reads: ['ticket'] } })),
      /\[page-public\].*"ticket", which "auth.public" does not open/,
    );
    assert.throws(
      () => parse({ ...APP, auth: { ...APP.auth, public: undefined } }),
      /\[page-public\].*opens nothing to signed-out visitors/,
    );
    assert.throws(
      () => parse(views({ notes: { ...APP.views.notes, roles: ['reader'] } })),
      /\[page-coverage\].*"reader", which is not granted "note"/,
    );
    const covered = { ...APP, auth: { ...APP.auth, roles: { reader: { read: ['desk'] } } } };
    assert.throws(
      () => parse({ ...covered, views: { settle: APP.views.settle }, nav: ['settle'], home: 'settle' }),
      /\[page-coverage\].*no one could open it/,
    );
    assert.throws(
      () => parse(views({ settle: { ...APP.views.settle, roles: ['reader'] } })),
      /\[page-coverage\].*runs "settle", which no role it is offered to is granted/,
    );
  });

  test('a page is offered by what it reads; a command a reader may not run is theirs to miss, not a closed door', () => {
    const app = parse();
    const roles = (key: string) => (app.views[key] as { roles?: string[] }).roles;
    /* The reader reads tickets and runs nothing: offered the page that runs settle, whose handle says it is not granted. */
    assert.deepEqual(roles('settle'), ['reader', 'clerk']);
    assert.deepEqual(roles('notes'), ['clerk']);
    /* Named, a role needs the reads alone. */
    assert.deepEqual(
      (parse(views({ settle: { ...APP.views.settle, roles: ['reader', 'clerk'] } })).views.settle as { roles?: string[] }).roles,
      ['reader', 'clerk'],
    );
  });

  test('home may name a page, as it names a view', () => {
    assert.deepEqual(parse({ ...APP, home: [{ view: 'lobby', signedOut: true }, { view: 'board' }] }).home.at(-1), { view: 'board' });
  });

  test("a service role is offered no page unless the page names it, and is never a person's", () => {
    const withBot = (bot: Record<string, unknown>) => ({ ...APP, auth: { ...APP.auth, roles: { ...APP.auth.roles, bot } } });
    const app = parse(withBot({ service: true, read: true, commands: ['settle'] }));
    for (const key of ['board', 'settle', 'notes']) assert.ok(!(app.views[key] as { roles?: string[] }).roles?.includes('bot'), key);
    const named = parse({
      ...withBot({ service: true, read: true }),
      views: { ...APP.views, notes: { ...APP.views.notes, roles: ['bot'] } },
    });
    assert.deepEqual((named.views.notes as { roles?: string[] }).roles, ['bot']);
    /* Without the word, a role that reads everything is a person's, and offered every page it can read. */
    assert.ok((parse(withBot({ read: true })).views.notes as { roles?: string[] }).roles?.includes('bot'));
    assert.throws(() => parse(withBot({ service: 'yes', read: true })), /"service" that is not true/);
    assert.throws(
      () =>
        parse({ ...withBot({ service: true, read: true }), auth: { ...withBot({ service: true, read: true }).auth, defaultRole: 'bot' } }),
      /"defaultRole": "bot", a service role/,
    );
  });

  test('page-loader: a page names a loader the commands module does not export, or one that reads past the page', () => {
    const app = parse();
    assert.doesNotThrow(() => checkPageLoaders(app, LOADERS, 'desk'));
    assert.throws(() => checkPageLoaders(app, undefined, 'desk'), /\[page-loader\].*"board", which the commands module does not export/);
    const wide = defineLoaders({ ...(LOADERS as object), board: defineLoader({ reads: ['ticket', 'note'], load: () => null }) }) as never;
    assert.throws(() => checkPageLoaders(app, wide, 'desk'), /\[page-loader\].*reads "note", which the page does not declare/);
  });

  test("page-undeclared: the page's module reads or runs what it does not declare", async () => {
    const source = `import { definePage } from '@mistriwork/mistri/page';
const page = definePage({ label: 'Board', reads: ['ticket'], commands: ['settle'], component: Board });
export default page;
function Board() {
  page.useRows('ticket');
  page.useRows('note');
  page.useCommand('refund');
  page.useRows(name);
  return null;
}`;
    const scan = scanPageSource(await astParser(), source, 'tsx', { key: 'board', reads: ['ticket'], commands: ['settle'] });
    assert.deepEqual(
      scan.undeclared.map((problem) => problem.text),
      [
        '[page-undeclared] useRows(…) reads "note", which the page "board" does not declare in its reads',
        '[page-undeclared] useCommand(…) runs "refund", which the page "board" does not declare in its commands',
      ],
    );
    assert.equal(scan.unread.length, 1, 'a name check cannot read is a warning, not a pass');
  });
});

describe('what the App records of its pages', () => {
  test('authority.lock records what each page reads, runs and loads, and that it is public', () => {
    const lines = authorityReport(parse())
      .split('\n')
      .filter((line) => line.startsWith('page '))
      .map((line) => line.replace(/ — the App$/, ''));
    assert.deepEqual(lines, [
      'page board reads desk',
      'page board reads ticket',
      'page board loads board',
      'page lobby reads desk',
      'page lobby loads lobby',
      'page lobby public',
      'page notes reads note',
      'page notes loads notes',
      'page settle reads ticket',
      'page settle runs settle',
    ]);
  });

  test("the generated types carry the loaders, so a page's data is typed from what its loader returns", () => {
    const text = commandTypes({}, 'Desk', './commands.ts', ['board', 'lobby']);
    assert.match(text, /export type Loaders = typeof import\("\.\/commands\.ts"\)\.loaders;/);
    assert.match(text, /export type PagePaths = "board" \| "lobby";/);
    assert.match(text, /interface Register { commands: Commands; loaders: Loaders; pagePaths: PagePaths }/);
    assert.doesNotMatch(commandTypes({}, 'Desk'), /Loaders|PagePaths/);
    /* An App with pages and no commands module names its pages alone, so its command names stay unjudged rather than none. */
    assert.match(commandTypes(undefined, 'Desk', undefined, ['board']), /interface Register { pagePaths: PagePaths }/);
  });
});

describe('a loader reads as the reader, never writes, and ends', () => {
  async function reader(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-loader-'));
    const file = join(dir, 'desk.db');
    const db = new DatabaseSync(file);
    db.exec(SQL);
    db.close();
    const adapter = connect(file);
    t.after(async () => {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    });
    return { adapter, schema: await adapter.introspect() };
  }
  const run = (loader: PageLoader, at: Awaited<ReturnType<typeof reader>>, schema = at.schema) =>
    runPageLoader({ name: 'x', loader, reader: at.adapter, schema, params: {}, viewer: { roles: ['clerk'] }, now: new Date() });
  const loader = (load: PageLoader['load'], options: { timeout?: '1 second' } = {}) =>
    defineLoader({ reads: ['ticket'], ...options, load: load as never }) as unknown as PageLoader;

  test('it cannot write: every write on its handles is refused, and it has no transaction, adapter or SQL to reach for', async (t) => {
    const at = await reader(t);
    for (const write of ['insert', 'update', 'remove', 'insertFile'] as const) {
      await assert.rejects(
        run(
          loader(async ({ db }) =>
            (db.ticket as never as Record<string, (...args: unknown[]) => unknown>)[write]({ id: 9, name: 'x' }, {}),
          ),
          at,
        ),
        (error: { code?: string; status?: number }) => error.code === 'loader_refused' && error.status === 403,
        write,
      );
    }
    const reached = await run(
      loader(async (context) => ({ keys: Object.keys(context).sort(), tables: Object.keys(context.db), sql: 'sql' in context.db.ticket })),
      at,
    );
    assert.deepEqual(reached, { keys: ['db', 'now', 'params', 'signal', 'viewer'], tables: ['ticket'], sql: false });
  });

  test("it reads only what its reader's catalog holds: a table the reader cannot read refuses the loader before it starts", async (t) => {
    const at = await reader(t);
    let started = false;
    const narrowed = { ...at.schema, tables: at.schema.tables.filter((table) => table.name !== 'ticket') };
    await assert.rejects(
      run(
        loader(() => {
          started = true;
          return null;
        }),
        at,
        narrowed,
      ),
      (error: { code?: string; status?: number }) => error.code === 'page_undeclared' && error.status === 403,
    );
    assert.equal(started, false);
  });

  test('it ends: past its timeout it is refused and its handles are revoked; past the size cap its result is not sent', async (t) => {
    const at = await reader(t);
    let late: unknown = 'not yet';
    const slow = loader(
      async ({ db, signal }) => {
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        assert.equal(signal.aborted, true, 'the loader is told its time is up');
        late = await db.ticket.where({}).then(
          () => 'read',
          (error: { code?: string }) => error.code,
        );
        return null;
      },
      { timeout: '1 second' },
    );
    await assert.rejects(
      run(slow, at),
      (error: { code?: string; status?: number }) => error.code === 'loader_timeout' && error.status === 504,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(late, 'loader_timeout', 'a read started after its time answers nothing');
    await assert.rejects(
      run(
        loader(() => 'x'.repeat(LOADER_RESULT_MOST)),
        at,
      ),
      (error: { code?: string }) => error.code === 'loader_too_large',
    );
    assert.throws(
      () => defineLoader({ reads: ['ticket'], timeout: '30 seconds' as never, load: () => null }),
      /between '1 second' and '10 seconds'/,
    );
  });

  test('the route runs only the loader the page names, for a reader the page is served to, with the parameters it keeps', async (t) => {
    const at = await reader(t);
    const app = parse();
    const ask = (body: Record<string, unknown>, roles: string[] = ['clerk'], signedIn = true) =>
      pageLoad({ app, roles, signedIn, loaders: LOADERS, body, reader: at.adapter, schema: at.schema });
    assert.deepEqual(await ask({ page: 'board', params: { desk: '2' } }), { status: 200, body: { data: { tickets: ['South one'] } } });
    assert.equal((await ask({ page: 'settle' })).body.code, 'page_undeclared', 'a page that names no loader has none to run');
    assert.equal((await ask({ page: 'board', params: { tab: 'x' } })).body.code, 'page_undeclared', 'only the parameters it keeps');
    assert.equal((await ask({ page: 'notes' }, ['reader'])).status, 404, "a page the reader's roles are not offered is not found");
    assert.equal((await ask({ page: 'board' }, [], false)).status, 404, 'a signed-out visitor is served no page but a public one');
    const lobby = await ask({ page: 'lobby' }, [], false);
    assert.deepEqual(lobby, { status: 200, body: { data: { desks: 2, viewer: { roles: [] } } } });
    const unexported = await pageLoad({
      app,
      roles: ['clerk'],
      signedIn: true,
      loaders: undefined,
      body: { page: 'board' },
      reader: at.adapter,
      schema: at.schema,
    });
    assert.equal(unexported.status, 404);
  });

  test('a request that says it is a page’s is refused outside what the page declares', () => {
    const app = parse();
    const refusal = (header: string | undefined, path: string, body: Record<string, unknown>) =>
      pageManifestRefusal({ app, roles: ['clerk'], header, path, body })?.body.code;
    assert.equal(refusal('board', '/api/view/run', { view: { base: 'ticket' } }), undefined);
    assert.equal(refusal('board', '/api/view/run', { view: { base: 'note' } }), 'page_undeclared');
    assert.equal(
      refusal('board', '/api/breakdowns', { items: [{ text: 'ticket by desk_id' }, { text: 'note by body' }] }),
      'page_undeclared',
    );
    assert.equal(refusal('settle', '/api/commands/execute', { command: 'settle' }), undefined);
    assert.equal(refusal('board', '/api/commands/execute', { command: 'settle' }), 'page_undeclared');
    assert.equal(refusal('nowhere', '/api/view/run', { view: { base: 'ticket' } }), 'page_undeclared');
    assert.equal(
      refusal(undefined, '/api/view/run', { view: { base: 'note' } }),
      undefined,
      'drift protection, not the boundary: the grants are',
    );
  });
});

describe('over HTTP, under a row policy', () => {
  const POLICY_APP = {
    id: 'desk',
    name: 'Desk',
    sources: { main: { connection: 'desk-db', default: true } },
    resources: { desk: {}, ticket: {}, note: {} },
    auth: { rows: 'policy', roles: { reader: { read: ['desk', 'ticket'] } } },
    views: {
      tickets: { kind: 'list', from: 'ticket', label: 'Tickets' },
      board: APP.views.board,
    },
    home: 'tickets',
    nav: ['tickets', 'board'],
  };

  async function serve(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-page-policy-'));
    const file = join(directory, 'desk.db');
    const seed = new DatabaseSync(file);
    seed.exec(SQL);
    seed.close();
    const registry = new Registry();
    registry.add({ id: 'desk-db', name: 'Desk', url: file, source: 'config', writable: false });
    const app = parseTestApp(POLICY_APP, 'desk policy');
    const pages = parsePagesConfig({ pages: [] }, 'desk pages');
    const control = { identity: { id: 'north', who: 'north@example.test', role: 'reader' } as Identity | null };
    const host: AppHost = {
      app: { path: join(directory, 'app.ts'), app, pages, sources: {}, loaders: LOADERS },
      pages,
      auth: {
        spec: app.auth!,
        store: join(directory, 'sessions.db'),
        close: async () => {},
        session: async () => control.identity,
        handler: async () => {},
      },
    };
    const policyFile = join(directory, 'policy.mjs');
    /* Each desk's reader sees their own desk's rows; the policy is what the loader must read through. */
    writeFileSync(
      policyFile,
      `export default { appId: 'desk', resolveRows(principal) {
        const desk = principal.id === 'south' ? 2 : 1;
        const eq = (column, value) => ({ groups: [[{ column, op: '=', value }]] });
        return { desk: eq('id', desk), ticket: eq('desk_id', desk), note: eq('id', 0) };
      } };`,
    );
    const policy: HttpAppPolicy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => control.identity });
    const bound = { host: '127.0.0.1', port: 0 };
    const server: Server = createApp({ registry, apps: [host], policy, pages, bound });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    t.after(async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await policy.retire();
      await registry.closeAll();
      rmSync(directory, { recursive: true, force: true });
    });
    const call = async (path: string, body: object, headers: Record<string, string> = {}) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}?app=desk`, {
        signal: AbortSignal.timeout(5000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ app: 'desk', ...body }),
      });
      return { status: response.status, body: (await response.json()) as { data?: unknown; code?: string; error?: string } };
    };
    return { control, call };
  }

  test("each reader's loader sees only the rows the row policy gives them; a page's stray read is refused", async (t) => {
    const { control, call } = await serve(t);
    const north = await call('/api/pages/load', { page: 'board' });
    assert.equal(north.status, 200, JSON.stringify(north.body));
    assert.deepEqual(north.body.data, { tickets: ['North one', 'North two'] });
    // Asking for the other desk's rows by parameter changes nothing: the policy is on the reader, below the loader.
    assert.deepEqual((await call('/api/pages/load', { page: 'board', params: { desk: '2' } })).body.data, { tickets: [] });
    control.identity = { id: 'south', who: 'south@example.test', role: 'reader' };
    assert.deepEqual((await call('/api/pages/load', { page: 'board' })).body.data, { tickets: ['South one'] });
    const stray = await call('/api/view/run', { view: { base: 'note' }, count: false }, { 'x-mistri-page': 'board' });
    assert.equal(stray.status, 403);
    assert.equal(stray.body.code, 'page_undeclared');
    control.identity = null;
    assert.notEqual(
      (await call('/api/pages/load', { page: 'board' })).status,
      200,
      'a signed-out visitor is not served a page that is not public',
    );
  });
});
