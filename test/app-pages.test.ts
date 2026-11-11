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
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { connect } from '../packages/engine/src/adapters/connect.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { astParser, pageFiles, placePages, readPageFiles, scanPageSource } from '../packages/mistri/src/server/app/appPages.js';
import { lintComponents, pageManifestsOf } from '../packages/mistri/src/server/app/componentLint.js';
import { checkPageLoaders } from '../packages/mistri/src/server/app/pageLoaderCheck.js';
import { defineLoader, defineLoaders, LOADER_RESULT_MOST, type PageLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { count, max } from '../packages/mistri/src/server/commands/commandDb.js';
import { runPageLoader } from '../packages/mistri/src/server/commands/pageLoaderRun.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { pageLoad, pageManifestRefusal } from '../packages/mistri/src/server/http/pageLoad.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { commandTypes } from '../packages/mistri/src/server/typegen.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { appForRoles } from '../packages/mistri/src/shared/appViewRoles.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseTestApp } from './support/commandCatalog.js';
import { uiViewRunBody } from '../packages/mistri/src/shared/uiSdk.js';

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
      const where = params.desk ? { desk_id: Number(params.desk) } : {};
      const tickets = await db.ticket.where(where).orderBy('id');
      /* The same rows summed: a count through the reader's aggregate, under its row policy as the rows are. */
      const { n } = await db.ticket.where(where).aggregate({ n: count() });
      return { tickets: tickets.map((row) => String(row.name)), counted: n };
    },
  }),
  notes: defineLoader({ reads: ['note'], load: async ({ db }) => ({ notes: (await db.note.where({})).length }) }),
  lobby: defineLoader({ reads: ['desk'], load: async ({ db, viewer }) => ({ desks: (await db.desk.where({})).length, viewer }) }),
}) as unknown as Readonly<Record<string, PageLoader>>;

describe('what check refuses, one fixture per code', () => {
  /* Page files on disk, read under the stand-ins the server reads them with. */
  async function readFiles(t: TestContext, files: Record<string, string>) {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-pages-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, 'pages'));
    for (const [name, source] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, 'pages', name)), { recursive: true });
      writeFileSync(join(dir, 'pages', name), source);
    }
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

  test('page-file: a hook imported from the wrong entry names the entry that exports it, not a data: address', async (t) => {
    const widget = `import { useAddressState } from '@mistriwork/mistri/ui';\nexport const Widget = () => useAddressState;\n`;
    await assert.rejects(
      readFiles(t, {
        'widget.ts': widget,
        'a.page.tsx': `import { Widget } from './widget.js';\n${pageSource("label: 'A', reads: ['desk']")}export { Widget };\n`,
      }),
      (error: Error) => {
        assert.match(
          error.message,
          /\[page-file\] pages\/a\.page\.tsx: `useAddressState` is exported by @mistriwork\/mistri\/page, not @mistriwork\/mistri\/ui: import \{ useAddressState \} from '@mistriwork\/mistri\/page'\./,
        );
        assert.doesNotMatch(error.message, /data:/);
        return true;
      },
    );
    await assert.rejects(
      readFiles(t, {
        'a.page.tsx': `import { useNothing } from '@mistriwork/mistri/ui';\n${pageSource("label: String(typeof useNothing), reads: ['desk']")}`,
      }),
      /\[page-file\] pages\/a\.page\.tsx: @mistriwork\/mistri\/ui has no export named `useNothing`\./,
    );
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
    assert.throws(
      () => placePages(APP, [page], 'desk'),
      /\[page-path\] desk: pages\/tickets\.page\.tsx: the App already has a view "tickets", and a page's path is its address\. Rename the file \(pages\/<another path>\.page\.tsx\), or remove the view from the App's views and let the page take its place\.$/,
    );
  });

  test('page-tab: a tab whose key is also a page is refused, in either order', () => {
    const tab = {
      key: 'tickets-map',
      module: './pages/tickets/[id]/map.page.tsx',
      fields: { label: 'Map', reads: ['desk'] },
      record: { view: 'tickets', tab: 'map' },
    };
    const top = { key: 'tickets-map', module: './pages/tickets-map.page.tsx', fields: { label: 'Map', reads: ['desk'], nav: false } };
    const said =
      /\[page-tab\] desk: pages\/tickets\/\[id\]\/map\.page\.tsx: its key "tickets-map" is also the page pages\/tickets-map\.page\.tsx\. Rename one of them\.$/;
    assert.throws(() => placePages(APP, [tab, top], 'desk'), said);
    assert.throws(() => placePages(APP, [top, tab], 'desk'), said);
  });

  test('page-nav: nav.group is an id or a list of them, and a page stands in each group it names', async (t) => {
    const page = (nav: unknown) => ({ key: 'walk', module: './pages/walk.page.tsx', fields: { label: 'Walk', reads: ['desk'], nav } });
    const two = {
      ...APP,
      nav: [
        { id: 'floor', label: 'Floor', children: ['tickets'] },
        { id: 'yard', label: 'Yard', children: [] },
      ],
    };
    const placed = placePages(two, [page({ group: ['floor', 'yard'] })], 'desk').nav as Array<{ children: string[] }>;
    assert.deepEqual(
      placed.map((group) => group.children),
      [['tickets', 'walk'], ['walk']],
    );
    assert.throws(() => placePages(two, [page({ group: ['floor', 'attic'] })], 'desk'), /\[page-nav\].*nav has no group "attic"/);
    await assert.rejects(
      readFiles(t, { 'inbox.page.tsx': pageSource("label: 'Inbox', reads: ['desk'], nav: { group: ['support', 'support'] }") }),
      /\[page-nav\] pages\/inbox\.page\.tsx: nav\.group names "support" twice\.$/,
    );
  });

  test('page-nav: a public page that says nothing of nav stays off the signed-in menu; nav still places it', () => {
    const page = (fields: Record<string, unknown>) => ({
      key: 'kiosk',
      module: './pages/kiosk.page.tsx',
      fields: { label: 'Kiosk', reads: ['desk'], public: true, ...fields },
    });
    const nav = { ...APP, nav: ['tickets'] };
    assert.deepEqual(placePages(nav, [page({})], 'desk').nav, ['tickets']);
    // With no nav at all, the page is not refused for having nowhere to stand.
    const { nav: _nav, ...noNav } = APP as Record<string, unknown>;
    assert.equal(placePages(noNav, [page({})], 'desk').nav, undefined);
    assert.deepEqual(placePages(nav, [page({ nav: {} })], 'desk').nav, ['tickets', 'kiosk']);
    // A page that is not public is placed as it was.
    assert.deepEqual(placePages(nav, [page({ public: undefined })], 'desk').nav, ['tickets', 'kiosk']);
  });

  test('page-nav: position is an index into the siblings as they stand when the page is placed, in path order', () => {
    const at = (key: string, position: number) => ({
      key,
      module: `./pages/${key}.page.tsx`,
      fields: { label: key, reads: ['desk'], nav: { position } },
    });
    const groups = {
      ...APP,
      nav: [
        { id: 'a', label: 'A', children: [] },
        { id: 'b', label: 'B', children: [] },
      ],
    };
    // Each group is one sibling; a page placed before another counts among the siblings of the next.
    const placed = placePages(groups, [at('one', 0), at('two', 1), at('three', 9)], 'desk').nav as Array<string | { id: string }>;
    assert.deepEqual(
      placed.map((node) => (typeof node === 'string' ? node : node.id)),
      ['one', 'two', 'a', 'b', 'three'],
    );
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

  test("page-file: a record's tab is pages/<list view>/[id]/<tab>.page.tsx, placed under no menu; a page anywhere else in a folder is refused", async (t) => {
    const read = await readFiles(t, {
      'tickets/[id]/history.page.tsx': pageSource("label: 'History', reads: ['ticket', 'note']"),
      'walk.page.tsx': pageSource("label: 'Walk', reads: ['desk']"),
    });
    assert.deepEqual(
      read.map((page) => [page.key, page.module, page.record]),
      [
        ['tickets-history', './pages/tickets/[id]/history.page.tsx', { view: 'tickets', tab: 'history' }],
        ['walk', './pages/walk.page.tsx', undefined],
      ],
      "a tab's key joins its list's and its word",
    );
    for (const misplaced of ['tickets/history.page.tsx', 'tickets/[id]/more/history.page.tsx', 'tickets/[key]/history.page.tsx'])
      await assert.rejects(
        readFiles(t, { [misplaced]: pageSource("label: 'History', reads: ['ticket']") }),
        new RegExp(`\\[page-file\\] pages/${misplaced.replace(/[[\]/.]/g, '\\$&')} is misplaced`),
        misplaced,
      );
    await assert.rejects(
      readFiles(t, { 'tickets/[id]/history.page.tsx': pageSource("label: 'History', reads: ['ticket'], nav: { group: 'floor' }") }),
      /\[page-nav\] pages\/tickets\/\[id\]\/history\.page\.tsx is a record's tab and has "nav"/,
    );
    const placed = placePages(APP, read, 'desk');
    assert.deepEqual(placed.nav, [...APP.nav, 'walk'], 'the tab takes no menu entry; the page beside it does');
    assert.deepEqual((placed.views as Record<string, { record?: unknown }>)['tickets-history'].record, { view: 'tickets', tab: 'history' });
  });

  test("page-file: a record's tab is under a list view, reads its record, and keeps no address of its own", () => {
    const tab = (change: Record<string, unknown> = {}) =>
      views({
        'tickets-history': {
          kind: 'page',
          label: 'History',
          component: component('tickets-history'),
          reads: ['ticket', 'note'],
          record: { view: 'tickets', tab: 'history' },
          ...change,
        },
      });
    const app = parse(tab());
    const view = app.views['tickets-history'] as { page?: unknown; roles?: string[] };
    assert.deepEqual(view.page, {
      reads: ['ticket', 'note'],
      commands: [],
      params: [],
      record: { view: 'tickets', table: 'ticket', tab: 'history' },
    });
    /* Reached from its record's page alone: not a menu entry, not a place to start, and offered as a page is, by its reads. */
    assert.deepEqual(view.roles, ['clerk']);
    assert.ok(!('tickets-history' in appForRoles(app, ['reader']).views), 'a reader who may not read notes is not offered the tab');
    assert.ok('tickets-history' in appForRoles(app, ['clerk']).views);
    assert.throws(() => parse({ ...tab(), home: 'tickets-history' }), /tickets-history/, 'no visitor starts on a tab');

    assert.throws(
      () => parse(tab({ record: { view: 'board', tab: 'history' } })),
      /\[page-file\].*under "board", which is not a list view this App declares.*the list views: tickets/,
    );
    assert.throws(
      () => parse(tab({ record: { view: 'nowhere', tab: 'history' } })),
      /\[page-file\].*under "nowhere", which is not a list view/,
    );
    assert.throws(() => parse(tab({ reads: ['note'] })), /\[page-file\].*a tab of a "ticket" record and does not read "ticket"/);
    assert.throws(() => parse(tab({ params: ['desk'] })), /\[page-file\].*is a record's tab and has "params"/);
    assert.throws(() => parse(tab({ public: true })), /is a record's tab and has "public"/);
    for (const word of ['edit', 'new'])
      assert.throws(() => parse(tab({ record: { view: 'tickets', tab: word } })), /\[page-file\].*is not a record's tab word/, word);
  });

  test("head: a page file, a page and a dashboard say their head's form; the label still names the room", async (t) => {
    const [read] = await readFiles(t, { 'walk.page.tsx': pageSource("label: 'Walk', reads: ['desk'], head: 'compact'") });
    assert.equal(read.fields.head, 'compact', 'definePage takes head');
    const placed = placePages(APP, [read], 'desk') as { views: Record<string, { head?: unknown }> };
    assert.equal(placed.views.walk.head, 'compact', 'and the page view it is placed as carries it');
    const app = parse({
      ...views({
        board: { ...APP.views.board, head: 'compact' },
        notes: { ...APP.views.notes, head: false },
        desk: { kind: 'dashboard', label: 'Desk', description: 'Today at the desk', sections: [{ kind: 'note', text: 'Hi' }], head: false },
      }),
      nav: [...APP.nav, 'desk'],
    });
    const view = (key: string) => app.views[key] as { label: string; head?: string; headingHidden?: true };
    assert.deepEqual([view('board').head, view('board').headingHidden], ['compact', undefined], 'compact keeps its title drawn');
    // A page that draws its own head keeps its title for a screen reader: the room's one h1, under the same label.
    assert.deepEqual([view('notes').head, view('notes').headingHidden, view('notes').label], ['own', true, 'Notes']);
    assert.deepEqual([view('desk').head, view('desk').headingHidden], ['own', true], 'a dashboard says it the same way');
    assert.throws(() => parse(views({ board: { ...APP.views.board, head: 'big' } })), /"head" is 'compact' .* or false/);
    assert.throws(() => parse(views({ board: { ...APP.views.board, head: true } })), /"head" is 'compact'/);
  });

  test('layout: a bare page owns the window, keeps its title for a screen reader, and is held to auth.public when it is public', async (t) => {
    const [read] = await readFiles(t, { 'kiosk.page.tsx': pageSource("label: 'Kiosk', reads: ['desk'], layout: 'bare'") });
    assert.equal(read.fields.layout, 'bare', 'definePage takes layout');
    const placed = placePages(APP, [read], 'desk') as { views: Record<string, { layout?: unknown }> };
    assert.equal(placed.views.kiosk.layout, 'bare', 'and the page view it is placed as carries it');
    const app = parse(views({ lobby: { ...APP.views.lobby, layout: 'bare' } }));
    const lobby = app.views.lobby as { layout?: string; head?: string; headingHidden?: true; label: string; page?: { public?: true } };
    assert.deepEqual([lobby.layout, lobby.head, lobby.headingHidden, lobby.label], ['bare', 'own', true, 'Lobby']);
    assert.equal(lobby.page?.public, true, 'a public bare page is the landing page');
    assert.equal((app.views.board as { layout?: string }).layout, undefined, 'a page that says nothing keeps the App frame');
    // A public bare page opens nothing auth.public does not: the existing bounds hold.
    assert.throws(
      () => parse(views({ lobby: { ...APP.views.lobby, layout: 'bare', reads: ['ticket'] } })),
      /\[page-public\].*"ticket", which "auth.public" does not open/,
    );
    // Any other word, or a head beside a bare page, is a [page-layout].
    assert.throws(() => parse(views({ board: { ...APP.views.board, layout: 'wide' } })), /\[page-layout\].*"layout" is 'bare'/);
    assert.throws(
      () => parse(views({ board: { ...APP.views.board, layout: 'bare', head: 'compact' } })),
      /\[page-layout\].*is bare and names "head"/,
    );
    await assert.rejects(
      readFiles(t, { 'wide.page.tsx': pageSource("label: 'Wide', reads: ['desk'], layout: 'wide'") }),
      /\[page-layout\].*The one word a free-form page takes is 'bare'/,
    );
  });

  test('page-reads, page-params, page-commands, page-public, page-coverage: what the page declares, held to the App', () => {
    const { reads: _reads, ...unread } = APP.views.board;
    assert.throws(() => parse(views({ board: unread })), /\[page-reads\]/);
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

  test('page-reads: `reads: []` is a page that reads nothing, and is held to it like any other list (a field report)', () => {
    const welcome = { kind: 'page', label: 'Welcome', component: component('welcome'), reads: [] };
    const app = parse({ ...views({ welcome }), nav: [...APP.nav, 'welcome'] });
    const view = app.views.welcome;
    assert.ok('sections' in view && view.page);
    assert.deepEqual(view.page.reads, []);
  });

  test('page-unlinked: a `nav: false` page is served, and check warns only when no source links to it (a field report)', async (t) => {
    /* Left out of every menu, the page was refused as "referenced by nothing" though another page opened it. */
    const hidden = { kind: 'page', label: 'Hidden', component: component('hidden'), reads: ['desk'] };
    const app = parse(views({ hidden }));
    assert.ok('sections' in app.views.hidden && app.views.hidden.page);
    const manifests = pageManifestsOf(app);
    assert.equal(manifests.get('page-hidden')?.unplaced, true);
    assert.equal(manifests.get('page-board')?.unplaced, undefined, 'a page in the menu is placed');
    assert.equal(manifests.get('page-lobby')?.unplaced, undefined, 'a public page is opened at its address');
    const lint = async (board: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'mistri-unlinked-'));
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      mkdirSync(join(dir, 'pages'));
      writeFileSync(join(dir, 'pages', 'board.page.tsx'), board);
      writeFileSync(join(dir, 'pages', 'hidden.page.tsx'), 'export default () => <b>Hidden</b>;\n');
      const entries = { 'page-board': { sources: ['pages/board.page.tsx'] }, 'page-hidden': { sources: ['pages/hidden.page.tsx'] } };
      const only = new Map([...manifests].filter(([id]) => id in entries));
      return lintComponents(dir, { entries } as never, only);
    };
    const unlinked = (await lint('export default () => <b>Board</b>;\n')).warnings.filter((w) => w.text.includes('[page-unlinked]'));
    assert.equal(unlinked.length, 1);
    assert.match(unlinked[0].text, /"hidden" is in no menu.*openPage\('hidden'\)/);
    assert.equal(unlinked[0].file, 'pages/hidden.page.tsx');
    for (const link of [
      "import { useNavigate } from '@mistriwork/mistri/page';\nexport default () => { const nav = useNavigate(); return <a onClick={() => nav.openPage('hidden', {})}>Go</a>; };\n",
      "import { pageHref } from '@mistriwork/mistri/page';\nexport default () => <a href={pageHref(`hidden`)}>Go</a>;\n",
    ]) {
      const { warnings } = await lint(link);
      assert.deepEqual(
        warnings.filter((w) => w.text.includes('[page-unlinked]')),
        [],
        link,
      );
    }
    const named = (await lint('export default ({ nav, to }) => <a onClick={() => nav.openPage(to)}>Go</a>;\n')).warnings;
    assert.match(named.find((w) => w.text.includes('[page-unlinked]'))?.text ?? '', /a link named by an expression is not followed/);
  });

  test("page-forms: a page opens the App's form views; a signed-in one it names needs no menu entry of its own", () => {
    const contracts = {
      ...CONTRACTS,
      apply: { input: { name: { type: 'text' } } },
      inquire: { public: true, input: { name: { type: 'text' } } },
    };
    const withForms = (change: Record<string, unknown>, roles: Record<string, unknown> = APP.auth.roles) =>
      parseTestApp(
        {
          ...APP,
          auth: { ...APP.auth, roles },
          views: {
            ...APP.views,
            apply: { kind: 'form', label: 'Apply', command: 'apply' },
            ask: { kind: 'form', label: 'Ask', command: 'inquire', public: true },
            ...change,
          },
        },
        'desk',
        contracts,
      );
    const clerk = { ...APP.auth.roles.clerk, commands: ['settle', 'apply'] };
    const roles = { ...APP.auth.roles, clerk };
    /* Named by no page, menu or home, the signed-in form is refused as unreachable; named in a page's forms, it is served. */
    assert.throws(() => withForms({}, roles), /views "apply" is a signed-in form referenced by nothing.*not a page's forms/);
    const app = withForms({ settle: { ...APP.views.settle, forms: ['apply', 'apply'] } }, roles);
    assert.deepEqual((app.views.settle as { page?: { forms?: string[] } }).page?.forms, ['apply']);
    assert.equal((app.views.apply as { command?: { id: string } }).command?.id, 'apply');
    assert.throws(
      () => withForms({ settle: { ...APP.views.settle, forms: ['tickets'] } }, roles),
      /\[page-forms\].*opens the form "tickets", which is not a form view this App declares\. Its form views: "apply", "ask"/,
    );
    assert.throws(
      () => withForms({ settle: { ...APP.views.settle, forms: 'apply' } }, roles),
      /\[page-forms\].*not a list of form view keys/,
    );
    /* A public page may name a signed-in form for its members: a visitor is not served the form, and the server checks the grant on submit. */
    assert.deepEqual(
      (
        withForms({ settle: { ...APP.views.settle, forms: ['apply'] }, lobby: { ...APP.views.lobby, forms: ['apply'] } }, roles).views
          .lobby as { page?: { forms?: string[] } }
      ).page?.forms,
      ['apply'],
    );
    assert.deepEqual(
      (
        withForms({ settle: { ...APP.views.settle, forms: ['apply'] }, lobby: { ...APP.views.lobby, forms: ['ask'] } }, roles).views
          .lobby as {
          page?: { forms?: string[] };
        }
      ).page?.forms,
      ['ask'],
    );
    /* A form whose command no role the page is offered to may run is a door no reader could use. */
    assert.throws(
      () => withForms({ settle: { ...APP.views.settle, forms: ['apply'] } }),
      /\[page-coverage\].*opens the form "apply", whose command "apply" no role the page is offered to is granted/,
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

  test('page-loader: a surface names a loader the commands module does not export, or one that reads past the surface', () => {
    const surfaced = (reads: string[]) =>
      ({ ...parse(), views: {}, surfaces: { board: { key: 'board', label: 'Board', reads, commands: [], loader: 'board' } } }) as never;
    // LOADERS' board reads ticket and desk: a surface that reads both holds it.
    assert.doesNotThrow(() => checkPageLoaders(surfaced(['ticket', 'desk']), LOADERS, 'desk'));
    assert.throws(
      () => checkPageLoaders(surfaced(['ticket', 'desk']), undefined, 'desk'),
      /\[page-loader\].*surfaces\/board\.surface\.ts names the loader "board", which the commands module does not export/,
    );
    assert.throws(
      () => checkPageLoaders(surfaced(['ticket']), LOADERS, 'desk'),
      /\[page-loader\].*surfaces\/board\.surface\.ts: its loader "board" reads "desk", which the surface does not declare/,
    );
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

  test('page-undeclared: a block, Scope or List reading, or a CommandButton, Steps or ActionButton running, what the page does not declare', async () => {
    const source = `import { definePage, Scope, List, Metric, CommandButton, ActionButton, Empty, Steps, Value } from '@mistriwork/mistri/page';
const page = definePage({ label: 'Board', reads: ['ticket'], commands: ['settle'], actions: ['start'], component: Board });
export default page;
function Board() {
  return (
    <Scope from="note" where={{ open: true }}>
      <Metric title="Open" from="ticket" />
      <List from="reply">{(row) => <CommandButton command="refund" row={row} />}</List>
      <List from="ticket">{(row) => <ActionButton action="finish" row={row} />}</List>
      <CommandButton command="settle" row={{}} />
      <Steps command="reopen" param="step" steps={[{ id: 'why', label: 'Why', inputs: ['reason'] }]} />
      <ActionButton action="start" row={{}} />
      <Empty title="None" action={<ActionButton action="start" row={{}} />} />
      <Value value={1} resource="invoice" />
    </Scope>
  );
}`;
    const scan = scanPageSource(await astParser(), source, 'tsx', {
      key: 'board',
      reads: ['ticket'],
      commands: ['settle'],
      actions: ['start'],
    });
    assert.deepEqual(
      scan.undeclared.map((problem) => problem.text),
      [
        '[page-undeclared] <Scope from> reads "note", which the page "board" does not declare in its reads',
        '[page-undeclared] <List from> reads "reply", which the page "board" does not declare in its reads',
        '[page-undeclared] <CommandButton command> runs "refund", which the page "board" does not declare in its commands',
        '[page-undeclared] <ActionButton action> runs "finish", which the page "board" does not declare in its actions',
        '[page-undeclared] <Steps command> runs "reopen", which the page "board" does not declare in its commands',
      ],
    );
    assert.equal(scan.unread.length, 0, '<Empty action> is a button and <Value resource> reads nothing: neither is a name to hold');
  });

  test("page-undeclared: a <Rows>, <List> or <RecordCard> show or query that crosses into a table the page does not read, on its own from or its Scope's", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-page-block-paths-'));
    const file = join(dir, 'desk.db');
    const db = new DatabaseSync(file);
    db.exec(SQL);
    db.close();
    const adapter = connect(file);
    t.after(async () => {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const schema = await adapter.introspect();
    const source = `import { definePage, Scope, Rows, List, RecordCard } from '@mistriwork/mistri/page';
const page = definePage({ label: 'Settle', reads: ['ticket'], component: Settle });
export default page;
function Settle() {
  return (
    <>
      <Rows from="ticket" show={['name', 'desk_id.name']} />
      <List from="ticket" show={['name', 'desk_id']} query="desk_id.name = North">{(row) => null}</List>
      <Scope from="ticket">
        <RecordCard record={{ id: 1 }} show={['desk_id.name']} />
        <Rows show={['name']} />
      </Scope>
      <Rows from="ticket" show={paths} />
    </>
  );
}`;
    const parseAst = await astParser();
    const manifest = { key: 'settle', reads: ['ticket'], commands: [] };
    const scan = scanPageSource(parseAst, source, 'tsx', manifest, schema);
    assert.deepEqual(
      scan.undeclared.map((problem) => `${problem.line}: ${problem.text}`),
      [
        '7: [page-undeclared] <Rows from="ticket"> reads "desk" through its show "desk_id.name", which the page "settle" does not declare in its reads',
        '8: [page-undeclared] <List from="ticket"> reads "desk" through its query "desk_id.name = North", which the page "settle" does not declare in its reads',
        '10: [page-undeclared] <RecordCard from="ticket"> reads "desk" through its show "desk_id.name", which the page "settle" does not declare in its reads',
      ],
      "a reference's own column and an expression read nothing past the base",
    );
    assert.deepEqual(scanPageSource(parseAst, source, 'tsx', { ...manifest, reads: ['ticket', 'desk'] }, schema).undeclared, []);
  });

  test('page-undeclared: with the catalog, a literal show, query, sort or by that crosses into a table the page does not read, as the server refuses it', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-page-paths-'));
    const file = join(dir, 'desk.db');
    const db = new DatabaseSync(file);
    db.exec(SQL);
    db.close();
    const adapter = connect(file);
    t.after(async () => {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const schema = await adapter.introspect();
    const source = `import { definePage } from '@mistriwork/mistri/page';
const page = definePage({ label: 'Settle', reads: ['ticket'], commands: ['settle'], component: Settle });
export default page;
function Settle() {
  page.useRows('ticket', { show: ['name', 'desk_id', 'desk_id.name'], sort: 'desk_id.name' });
  page.useRows('ticket', { query: 'desk_id.name = North' });
  page.useRows('ticket', { sort: 'desk_id.name desc' });
  page.useRecord('ticket', { id: 1 }, ['desk_id.name']);
  page.useBreakdown('ticket', { by: 'desk_id.name' });
  page.useRows('ticket', { show: ['name', 'desk_id'], query: 'name = x', sort: 'name' });
  page.useRows('ticket', { show: paths });
  return null;
}`;
    const parseAst = await astParser();
    const manifest = { key: 'settle', reads: ['ticket'], commands: ['settle'] };
    const scan = scanPageSource(parseAst, source, 'tsx', manifest, schema);
    assert.deepEqual(
      scan.undeclared.map((problem) => `${problem.line}: ${problem.text}`),
      [
        '5: [page-undeclared] useRows("ticket") reads "desk" through its show "desk_id.name", which the page "settle" does not declare in its reads',
        '6: [page-undeclared] useRows("ticket") reads "desk" through its query "desk_id.name = North", which the page "settle" does not declare in its reads',
        '7: [page-undeclared] useRows("ticket") reads "desk" through its sort "desk_id.name desc", which the page "settle" does not declare in its reads',
        '8: [page-undeclared] useRecord("ticket") reads "desk" through its show "desk_id.name", which the page "settle" does not declare in its reads',
        '9: [page-undeclared] useBreakdown("ticket") reads "desk" through its by "desk_id.name", which the page "settle" does not declare in its reads',
      ],
      "a reference's own column reads nothing past the base; a path written as an expression is the types' to judge",
    );
    assert.deepEqual(scanPageSource(parseAst, source, 'tsx', { ...manifest, reads: ['ticket', 'desk'] }, schema).undeclared, []);
    assert.equal(scanPageSource(parseAst, source, 'tsx', manifest).undeclared.length, 0, 'without the catalog only the names are held');
    // The request the host sends for line 5's crossing path is the one the server refuses: one rule, both sides.
    const app = parse();
    assert.equal(
      pageManifestRefusal({
        app,
        roles: ['clerk'],
        header: 'settle',
        path: '/api/view/run',
        body: uiViewRunBody('ticket', 'ticket', ['desk_id.name'], '', 1),
        schema,
      })?.body.code,
      'page_undeclared',
    );
  });

  /* A field report: eight pages broke on upgrade while check said ok. Typed code writes its paths `as const` or names
     them once in a constant, and the scan read neither, so the crossing was the browser's to find. */
  test("page-undeclared: a path written `as const`, `satisfies`, or in a constant of the page's module is held too", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-page-const-paths-'));
    const file = join(dir, 'desk.db');
    const db = new DatabaseSync(file);
    db.exec(SQL);
    db.close();
    const adapter = connect(file);
    t.after(async () => {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const schema = await adapter.introspect();
    const source = `import { definePage, Rows } from '@mistriwork/mistri/page';
const SHOW = ['name', 'desk_id.name'] as const;
const OPTIONS = { query: 'desk_id.name = North' } satisfies object;
const page = definePage({ label: 'Settle', reads: ['ticket'], component: Settle });
export default page;
function Settle() {
  page.useRows('ticket', { show: ['name', 'desk_id.name'] as const });
  page.useRows('ticket', { show: SHOW });
  page.useRows('ticket', OPTIONS);
  page.useRecord('ticket', { id: 1 }, SHOW);
  let later = ['desk_id.name'];
  page.useRows('ticket', { show: later });
  return <Rows from="ticket" show={SHOW} />;
}`;
    const parseAst = await astParser();
    const manifest = { key: 'settle', reads: ['ticket'], commands: [] };
    assert.deepEqual(
      scanPageSource(parseAst, source, 'tsx', manifest, schema).undeclared.map((problem) => `${problem.line}: ${problem.text}`),
      [
        '7: [page-undeclared] useRows("ticket") reads "desk" through its show "desk_id.name", which the page "settle" does not declare in its reads',
        '8: [page-undeclared] useRows("ticket") reads "desk" through its show "desk_id.name", which the page "settle" does not declare in its reads',
        '9: [page-undeclared] useRows("ticket") reads "desk" through its query "desk_id.name = North", which the page "settle" does not declare in its reads',
        '10: [page-undeclared] useRecord("ticket") reads "desk" through its show "desk_id.name", which the page "settle" does not declare in its reads',
        '13: [page-undeclared] <Rows from="ticket"> reads "desk" through its show "desk_id.name", which the page "settle" does not declare in its reads',
      ],
      "a `let` may change before it is read: it is the types' to judge",
    );
    assert.deepEqual(scanPageSource(parseAst, source, 'tsx', { ...manifest, reads: ['ticket', 'desk'] }, schema).undeclared, []);
  });
});

describe('what the App records of its pages', () => {
  test("authority.lock records which pages load and which are public; what a signed-in page reads and runs is the roles' grants", () => {
    const lines = authorityReport(parse())
      .split('\n')
      .filter((line) => line.startsWith('page '))
      .map((line) => line.replace(/ — the App$/, ''));
    assert.deepEqual(lines, ['page board loads board', 'page lobby loads lobby', 'page lobby public', 'page notes loads notes']);
  });

  test("the generated types carry the loaders, so a page's data is typed from what its loader returns", () => {
    const text = commandTypes({}, 'Desk', './commands.ts', ['board', 'lobby']);
    assert.match(text, /export type Loaders = typeof import\("\.\/commands\.ts"\)\.loaders;/);
    assert.match(text, /export type PagePaths = "board" \| "lobby";/);
    assert.match(text, /interface Register { commands: Commands; loaders: Loaders; pagePaths: PagePaths; pageLoaders: PageLoaders }/);
    assert.doesNotMatch(commandTypes({}, 'Desk'), /Loaders|PagePaths/);
    /* A record's tab is a page path no link names: it is opened on its record, never as a place of its own. */
    assert.match(
      commandTypes({}, 'Desk', undefined, ['board', 'tickets-history'], [], ['tickets-history']),
      /export type PagePaths = "board";/,
    );
    /* An App with pages and no commands module names its pages alone, so its command names stay unjudged rather than none. */
    assert.match(
      commandTypes(undefined, 'Desk', undefined, ['board']),
      /interface Register { pagePaths: PagePaths; pageLoaders: PageLoaders }/,
    );
  });
});

describe('a loader reads as the reader, never writes, and ends', () => {
  async function reader(t: TestContext) {
    const dir = mkdtempSync(join(tmpdir(), 'mistri-loader-'));
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

  test('it sums and groups through its reader, as the reader counts', async (t) => {
    const at = await reader(t);
    const answer = await run(
      loader(async ({ db }) => ({
        total: await db.ticket.where().aggregate({ n: count(), top: max('id') }),
        byDesk: await db.ticket.where().groupBy('desk_id').aggregate({ n: count() }),
      })),
      at,
    );
    assert.deepEqual(JSON.parse(JSON.stringify(answer)), {
      total: { n: 3, top: 3 },
      byDesk: [
        { desk_id: 1, n: 2 },
        { desk_id: 2, n: 1 },
      ],
    });
  });

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

  /* A field report: a page handed its program's configuration had to declare a read it never made. */
  test('a loader may read nothing: its db holds no table, and it still hands the page what it returns', async (t) => {
    const at = await reader(t);
    const settings = defineLoader({
      reads: [],
      load: ({ db, viewer }) => ({ program: 'Everyday Banking', limit: 2500, tables: Object.keys(db), roles: viewer.roles }),
    }) as unknown as PageLoader;
    assert.deepEqual(settings.reads, []);
    assert.deepEqual(await run(settings, at), { program: 'Everyday Banking', limit: 2500, tables: [], roles: ['clerk'] });
    // Held to the page as any loader is: one that reads nothing reads nothing past it.
    const app = parse();
    assert.doesNotThrow(() => checkPageLoaders(app, defineLoaders({ ...(LOADERS as object), board: settings }) as never, 'desk'));
    assert.throws(() => defineLoader({ reads: [''] as never, load: () => null }), /reads: \[\] for none/);
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
    assert.deepEqual(await ask({ page: 'board', params: { desk: '2' } }), {
      status: 200,
      body: { data: { tickets: ['South one'], counted: 1 } },
    });
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
    assert.deepEqual(north.body.data, { tickets: ['North one', 'North two'], counted: 2 });
    // Asking for the other desk's rows by parameter changes nothing: the policy is on the reader, below the loader.
    assert.deepEqual((await call('/api/pages/load', { page: 'board', params: { desk: '2' } })).body.data, { tickets: [], counted: 0 });
    control.identity = { id: 'south', who: 'south@example.test', role: 'reader' };
    assert.deepEqual((await call('/api/pages/load', { page: 'board' })).body.data, { tickets: ['South one'], counted: 1 });
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
