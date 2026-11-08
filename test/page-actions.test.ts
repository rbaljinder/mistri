/**
 * A free-form page runs a fixed action (`definePage({ actions })`, `page.useAction`): a machine's verb or
 * `action(label, { set })` of a resource it reads, which is the record page's own button. What the page declares is held
 * to the App when it loads, and what a reader may run is the server's to judge, on every run, through the same update
 * route as every other write: a repair desk, a request that moves through scheduled, onsite and done, and a page over it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { scanPageSource, astParser } from '../packages/mistri/src/server/app/appPages.js';
import { commandTypes } from '../packages/mistri/src/server/typegen.js';
import { authorityReport } from '../packages/mistri/src/shared/appAuthority.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const component = (key: string) => ({ id: `page-${key}`, module: `./pages/${key}.page.tsx`, kind: 'page' });
const SQL = `CREATE TABLE technician (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE request (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
    technician_id INTEGER REFERENCES technician(id), moved_at TIMESTAMP);
  INSERT INTO technician VALUES (1, 'Ada');
  INSERT INTO request (id, title, status, technician_id) VALUES
    (1, 'Dishwasher leaks', 'new', NULL), (2, 'Oven is dead', 'scheduled', 1), (3, 'Fridge hum', 'onsite', 1);`;

const cancel = { to: 'cancelled', label: 'Cancel request', confirm: true } as const;
const RESTOCK = { label: 'Restock', command: { id: 'restock', target: 'request', input: {} } };
/* A repair desk: the machine's verbs are the request's fixed actions; one more action runs a command, which a page names apart. */
const APP = {
  id: 'repairs',
  name: 'Repairs',
  connection: 'repair-db',
  resources: {
    technician: {},
    request: {
      access: 'write',
      machine: {
        column: 'status',
        since: 'moved_at',
        states: {
          new: { on: { scheduleVisit: 'scheduled', cancelRequest: cancel } },
          scheduled: { on: { startVisit: 'onsite', cancelRequest: cancel } },
          onsite: { on: { finishJob: 'done' } },
          done: { final: true },
          cancelled: { final: true },
        },
      },
      validation: [{ must: 'technician_id is not empty', when: 'status = scheduled', message: 'Assign a technician before scheduling.' }],
      actions: { restock: RESTOCK },
    },
  },
  auth: {
    providers: ['email'],
    defaultRole: 'desk',
    roles: {
      desk: { read: true, write: ['request'] },
      tech: { read: true, actions: { request: ['startVisit', 'finishJob'] } },
      visitor: { read: true },
    },
    public: { read: ['technician'] },
  },
  views: {
    requests: { kind: 'list', from: 'request', label: 'Requests' },
    board: {
      kind: 'page',
      label: 'Board',
      component: component('board'),
      reads: ['request', 'technician'],
      actions: ['scheduleVisit', 'startVisit', 'finishJob', 'cancelRequest'],
    },
  },
  home: 'requests',
  nav: ['requests', 'board'],
};
const parse = (extra: Record<string, unknown> = {}) => parseTestApp({ ...APP, ...extra }, 'repairs.ts');
const board = (change: Record<string, unknown>) => ({ views: { ...APP.views, board: { ...APP.views.board, ...change } } });

describe('what a page declares of its actions, held to the App', () => {
  test('a page names the fixed actions of the resources it reads, and the manifest carries them', () => {
    const view = parse().views.board as { page: { actions?: string[]; commands: string[] } };
    assert.deepEqual(view.page.actions, ['scheduleVisit', 'startVisit', 'finishJob', 'cancelRequest']);
    assert.deepEqual(view.page.commands, []);
    // A page without them says nothing of them.
    const plain = parse(board({ actions: undefined })).views.board as { page: { actions?: string[] } };
    assert.equal(plain.page.actions, undefined);
  });

  test('an action needs no role the page could be checked against: an App with no auth parses', () => {
    assert.doesNotThrow(() =>
      parseTestApp(
        { ...APP, auth: undefined, resources: { ...APP.resources, request: { ...APP.resources.request, validation: undefined } } },
        'repairs.ts',
      ),
    );
  });

  test('page-action: a command, an unknown id and an action of a resource the page does not read are refused', () => {
    assert.throws(() => parse(board({ actions: ['restock'] })), /\[page-action\].*"restock" is a command; name it in commands/);
    assert.throws(
      () => parse(board({ actions: ['dance'] })),
      /\[page-action\].*"dance" is not a fixed action of "request", "technician", the resources it reads\. Their fixed actions: "scheduleVisit"/,
    );
    assert.throws(
      () => parse(board({ reads: ['technician'], actions: ['startVisit'] })),
      /\[page-action\].*"startVisit" is not a fixed action of "technician"/,
    );
    assert.throws(() => parse(board({ actions: [''] })), /\[page-action\].*not a list of action ids/);
  });

  test('page-public: a public page runs public commands, not actions', () => {
    assert.throws(
      () => parse(board({ reads: ['technician'], public: true, actions: ['startVisit'] })),
      /\[page-public\].*a public page runs public commands, not actions/,
    );
  });

  test('an action is a role grant, not authority: saving a page that adds one changes no fact', () => {
    const without = authorityReport(parse(board({ actions: ['startVisit'] })));
    const more = authorityReport(parse());
    assert.equal(more, without);
  });

  test('check holds the page source to its actions: a literal useAction the page does not declare is a finding', async () => {
    const manifest = { key: 'board', reads: ['request'], commands: [], actions: ['startVisit'] };
    const found = scanPageSource(
      await astParser(),
      `import { definePage } from '@mistriwork/mistri/page';
       const page = definePage({ label: 'Board', reads: ['request'], actions: ['startVisit'], component: B });
       function B() { page.useAction('startVisit'); page.useAction('finishJob'); return null; }`,
      'tsx',
      manifest,
    );
    assert.equal(found.undeclared.length, 1);
    assert.match(
      found.undeclared[0].text,
      /\[page-undeclared\] useAction\(…\) runs "finishJob", which the page "board" does not declare in its actions/,
    );
  });

  test("the generated types name the App's fixed actions for a page", () => {
    const text = commandTypes(undefined, 'Repairs', undefined, ['board'], ['startVisit', 'finishJob']);
    assert.match(text, /interface Register { pagePaths: PagePaths; actions: ActionNames }/);
    assert.match(text, /export type ActionNames = "finishJob" \| "startVisit";/);
    // An App with no page has nothing to name them for.
    assert.doesNotMatch(commandTypes(undefined, 'Repairs', undefined, [], ['startVisit']), /ActionNames/);
  });
});

describe('over HTTP: a run is the update route, judged again by the server', () => {
  async function serve(t: TestContext) {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-page-actions-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'repairs.db');
    const db = new DatabaseSync(path);
    db.exec(SQL);
    db.close();
    const previous = process.env.XDG_CONFIG_HOME;
    clearJournal('repair-db');
    const registry = new Registry();
    registry.add({ id: 'repair-db', name: 'Repairs', url: path, source: 'config', writable: true });
    const app = parse();
    let who: Identity = { id: 'account-bo', who: 'bo@example.test', role: 'tech' };
    const host: AppHost = {
      app: { path: '/repairs/app.ts', app, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: app.auth!,
        store: join(directory, 'sessions.db'),
        handler: async () => {},
        close: async () => {},
        session: async () => who,
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], pages: [] });
    process.env.XDG_CONFIG_HOME = directory;
    t.after(async () => {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      clearJournal('repair-db');
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
    });
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const call = async (method: 'GET' | 'POST', route: string, body?: Record<string, unknown>) => {
      const response = await fetch(
        `http://${bound.host}:${address.port}${route}${method === 'GET' ? `${route.includes('?') ? '&' : '?'}app=repairs` : ''}`,
        {
          signal: AbortSignal.timeout(5_000),
          method,
          ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: 'repairs', ...body }) } : {}),
        },
      );
      return { status: response.status, body: await response.json() };
    };
    const status = (id: number) => {
      const check = new DatabaseSync(path);
      try {
        return (check.prepare('SELECT status FROM request WHERE id = ?').get(id) as { status: string }).status;
      } finally {
        check.close();
      }
    };
    return {
      call,
      status,
      as: (identity: Identity) => {
        who = identity;
      },
    };
  }

  test('the page is served its actions, and a reader their grants', { timeout: 20_000 }, async (t) => {
    const { call } = await serve(t);
    const served = (await call('GET', '/api/app')).body.app;
    assert.deepEqual(served.grantedActions, { request: ['startVisit', 'finishJob'] });
    assert.deepEqual(served.views.board.page.actions, ['scheduleVisit', 'startVisit', 'finishJob', 'cancelRequest']);
    const actions = served.resources.request.actions as Array<{
      id: string;
      label: string;
      set?: unknown;
      when?: string;
      confirm?: boolean;
      command?: unknown;
    }>;
    const start = actions.find((action) => action.id === 'startVisit');
    assert.deepEqual([start?.label, start?.set, start?.when], ['Start visit', { status: 'onsite', moved_at: 'now' }, 'status = scheduled']);
    assert.equal(actions.find((action) => action.id === 'cancelRequest')?.confirm, true, 'cancel asks first, and the page can tell');
  });

  test(
    'a granted run applies, an ungranted one is refused (403), and a record in the wrong state is refused',
    { timeout: 20_000 },
    async (t) => {
      const { call, status, as } = await serve(t);
      // Start visit sets onsite on a scheduled request.
      const started = await call('POST', '/api/update', {
        table: 'request',
        key: { id: 2 },
        values: { status: 'onsite', moved_at: 'now' },
      });
      assert.equal(started.status, 200, JSON.stringify(started.body));
      assert.equal(status(2), 'onsite');
      // The state it leaves is the action's `when`, judged on the stored row: a request that is new cannot be started.
      const early = await call('POST', '/api/update', { table: 'request', key: { id: 1 }, values: { status: 'onsite', moved_at: 'now' } });
      assert.deepEqual([early.status, early.body.code], [403, 'forbidden'], JSON.stringify(early.body));
      assert.equal(status(1), 'new');
      // Cancel is not this reader's, whatever the state.
      const cancelled = await call('POST', '/api/update', { table: 'request', key: { id: 1 }, values: { status: 'cancelled' } });
      assert.deepEqual([cancelled.status, cancelled.body.code], [403, 'forbidden']);
      // Another action's words in the same body are not widened into an edit.
      const forged = await call('POST', '/api/update', {
        table: 'request',
        key: { id: 3 },
        values: { status: 'done', moved_at: 'now', title: 'Hijacked' },
      });
      assert.equal(forged.status, 403);
      const finished = await call('POST', '/api/update', { table: 'request', key: { id: 3 }, values: { status: 'done', moved_at: 'now' } });
      assert.equal(finished.status, 200, JSON.stringify(finished.body));
      assert.equal(status(3), 'done');
      // A reader granted nothing is refused the same body.
      as({ id: 'account-vi', who: 'vi@example.test', role: 'visitor' });
      assert.equal((await call('GET', '/api/app')).body.app.grantedActions, undefined);
      assert.equal(
        (await call('POST', '/api/update', { table: 'request', key: { id: 2 }, values: { status: 'done', moved_at: 'now' } })).status,
        403,
      );
      assert.equal(status(2), 'onsite');
    },
  );

  test(
    "scheduling a request with no technician is refused by the resource's validation, naming the field",
    { timeout: 20_000 },
    async (t) => {
      const { call, status, as } = await serve(t);
      as({ id: 'account-ada', who: 'ada@example.test', role: 'desk' });
      const refused = await call('POST', '/api/update', { table: 'request', key: { id: 1 }, values: { status: 'scheduled' } });
      assert.notEqual(refused.status, 200, JSON.stringify(refused.body));
      assert.match(JSON.stringify(refused.body), /Assign a technician before scheduling\./);
      assert.equal(status(1), 'new');
      const scheduled = await call('POST', '/api/update', {
        table: 'request',
        key: { id: 1 },
        values: { technician_id: 1, status: 'scheduled' },
      });
      assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
      assert.equal(status(1), 'scheduled');
    },
  );
});
