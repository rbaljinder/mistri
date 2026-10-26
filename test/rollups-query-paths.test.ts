/**
 * A rollup's query through references (appRollups.ts): `count('task', { whose:
 * 'project_id.client_id', query: 'project_id.status != closed' })` — which rows
 * count is said about the rows they name, so a product's units sold leave out
 * cancelled orders without a status copied onto every line. What the catalog
 * serves and refuses, the statement it compiles to, and the served App, where
 * a reader who cannot read the table a path reaches is served no number.
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
import { appRollupRules, parseAppConfig, resolveViews, withRollups } from '../packages/mistri/src/shared/app.js';
import { ANSI_STYLE, MYSQL_STYLE } from '../packages/engine/src/shared/filter.js';
import { rollupReads } from '../packages/engine/src/shared/rollups.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView, withViewComputed } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const table = (id: string, columns: object[]) => ({ id, name: id, schema: '', isView: false, columns });
const schema = {
  label: 'Studio',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    table('client', [key('id'), column('name', 'TEXT')]),
    table('project', [key('id'), column('client_id', 'INTEGER'), column('status', 'TEXT'), column('name', 'TEXT')]),
    table('task', [key('id'), column('project_id', 'INTEGER'), column('done', 'INTEGER'), column('title', 'TEXT')]),
    table('time_entry', [key('id'), column('task_id', 'INTEGER'), column('hours', 'NUMERIC')]),
  ],
  foreignKeys: [
    { name: 'project_client', from: { table: 'project', columns: ['client_id'] }, to: { table: 'client', columns: ['id'] } },
    { name: 'task_project', from: { table: 'task', columns: ['project_id'] }, to: { table: 'project', columns: ['id'] } },
    { name: 'entry_task', from: { table: 'time_entry', columns: ['task_id'] }, to: { table: 'task', columns: ['id'] } },
  ],
} as DatabaseSchema;

const ROLLUPS = {
  client: {
    rollups: {
      open_tasks: { fn: 'count', from: 'task', whose: 'project_id.client_id', query: 'project_id.status != closed and done = 0' },
    },
  },
  task: { rollups: { live_hours: { fn: 'sum', from: 'time_entry', column: 'hours', query: 'task_id.project_id.status = active' } } },
  project: {},
  time_entry: {},
};
const app = (resources: Record<string, unknown> = ROLLUPS) =>
  parseAppConfig(
    { name: 'Studio', resources, views: { clients: { kind: 'list', from: 'client' } }, home: 'clients', nav: ['clients'] },
    'paths',
  );

test("a rollup's query may walk its rows' references; what the walk reads is what a reader is held to", () => {
  const judged = appRollupRules(app(), schema);
  assert.deepEqual(judged.problems, []);
  const open = judged.rules.get('client')!.open_tasks;
  // Two hops to the client, and the query narrows the rows themselves (the inner level), not the projects between.
  assert.equal(open.of!.filter!.groups[0][0].column, 'project_id.status');
  assert.deepEqual(rollupReads(open), [
    { table: 'project', fields: ['client_id'] },
    { table: 'task', fields: ['project_id', 'project_id', 'done'] },
    { table: 'project', fields: ['id', 'status'] },
  ]);
  // Two hops inside the query: the task, then its project.
  assert.deepEqual(rollupReads(judged.rules.get('task')!.live_hours), [
    { table: 'time_entry', fields: ['task_id', 'hours', 'task_id'] },
    { table: 'task', fields: ['id', 'project_id'] },
    { table: 'project', fields: ['id', 'status'] },
  ]);

  const problem = (query: string) =>
    appRollupRules(app({ client: { rollups: { r: { fn: 'count', from: 'project', query } } }, project: {}, task: {} }), schema).problems[0];
  assert.match(problem('client_id.nope = 1'), /"r" query: .*nope/);
  assert.match(problem('nope.status = 1'), /"r" query: /);
  // Only a stored column at the end of the walk: a label, a rollup or a computed column is another figure.
  assert.match(problem('client_id.$label = Acme'), /"r" query: /);
  assert.match(problem('status = open sort name'), /no show, sort or limit/);
});

test('a path in the query is one scalar subquery per walk inside the rows it narrows', () => {
  const served = withRollups(app(), schema);
  for (const [style, q] of [
    [ANSI_STYLE, '"'],
    [MYSQL_STYLE, '`'],
  ] as const) {
    const view = withViewComputed(served, textToView(served, 'task show title, live_hours').view!);
    const { text } = compileView(served, view, style);
    const hop = `${q}_tw_hop\\$\\d+${q}`;
    assert.match(
      text,
      new RegExp(
        `\\(SELECT ${hop}\\.${q}status${q} FROM ${q}task${q} ${hop} JOIN ${q}project${q} ${hop} ON ${hop}\\.${q}id${q} = ${hop}\\.${q}project_id${q} ` +
          `WHERE ${hop}\\.${q}id${q} = ${q}_tw_row${q}\\.${q}task_id${q}\\) = `,
      ),
      text,
    );
  }
});

test('a list filters by a rollup and totals one, as a condition and a measure read it', () => {
  const listing = (extra: Record<string, unknown>) =>
    parseAppConfig(
      {
        name: 'Studio',
        resources: ROLLUPS,
        views: { clients: { kind: 'list', from: 'client', show: ['name', 'open_tasks'], ...extra } },
        home: 'clients',
        nav: ['clients'],
      },
      'filters',
    );
  const served = withRollups(listing({}), schema);
  const resolved = (extra: Record<string, unknown>) => resolveViews(listing(extra), served).clients as { error?: string };
  assert.equal(resolved({ filters: ['name', 'open_tasks'], totals: ['open_tasks'] }).error, undefined);
  assert.match(resolved({ filters: ['nope'] }).error ?? '', /"client" has no column "nope" — named in this view's filters/);
});

/* ---------- served ---------- */

const identity = (role: string): Identity => ({ id: `account-${role}`, who: `${role}@example.test`, role });
const sessions: Record<string, Identity> = { manager: identity('manager'), clerk: identity('clerk') };

async function serve(
  run: (
    post: (who: string, body: { route?: string } & Record<string, unknown>) => Promise<Array<Record<string, unknown>> | undefined>,
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-rollup-paths-'));
  const path = join(directory, 'studio.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE client (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE project (id INTEGER PRIMARY KEY, client_id INTEGER REFERENCES client(id), status TEXT NOT NULL, name TEXT NOT NULL);
    CREATE TABLE task (id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES project(id), done INTEGER NOT NULL, title TEXT NOT NULL);
    CREATE TABLE time_entry (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES task(id), hours NUMERIC NOT NULL);
    INSERT INTO client VALUES (1, 'Acme'), (2, 'Brio');
    INSERT INTO project VALUES (1, 1, 'active', 'Site'), (2, 1, 'closed', 'Old site'), (3, 2, 'active', 'App');
    INSERT INTO task VALUES (1, 1, 0, 'Design'), (2, 1, 1, 'Build'), (3, 2, 0, 'Archive'), (4, 3, 0, 'Plan'), (5, NULL, 0, 'Loose');
    INSERT INTO time_entry VALUES (1, 1, 2), (2, 2, 3), (3, 3, 5), (4, 4, 1), (5, 5, 7);`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'studio', name: 'Studio', url: path, source: 'config', writable: false });
  const manifest = parseAppConfig(
    {
      id: 'studio-app',
      name: 'Studio',
      connection: 'studio',
      resources: ROLLUPS,
      // The clerk reads the clients, tasks and time, never the projects a path walks through.
      auth: {
        providers: ['email'],
        defaultRole: 'clerk',
        roles: { manager: { read: true }, clerk: { read: ['client', 'task', 'time_entry'] } },
      },
      views: { clients: { kind: 'list', from: 'client', show: ['name'] } },
      home: 'clients',
      nav: ['clients'],
    },
    'served',
  );
  const host: AppHost = {
    app: { path: '/studio/app.ts', app: manifest, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async (req: { headers: { cookie?: string } }) => sessions[req.headers.cookie?.replace(/^session=/, '') ?? ''] ?? null,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    bound.port = (server.address() as { port: number }).port;
    await run(async (who, { route = '/api/run', ...body }: { route?: string } & Record<string, unknown>) => {
      const res = await fetch(`http://${bound.host}:${bound.port}${route}?app=studio-app`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `session=${who}` },
        body: JSON.stringify(body),
      });
      return ((await res.json()) as { rows?: Array<Record<string, unknown>> }).rows;
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("served: the query's path narrows the rows counted, and a reader who cannot read where it walks is served no figure", async () => {
  await serve(async (post) => {
    // Acme: Design is open on an active project; Build is done; Archive is on a closed one.
    assert.deepEqual(await post('manager', { q: 'client show name, open_tasks sort name', limit: 10 }), [
      { name: 'Acme', open_tasks: 1 },
      { name: 'Brio', open_tasks: 1 },
    ]);
    // A task with no project reads its project's status as empty: not active, so its hours do not count.
    assert.deepEqual(await post('manager', { q: 'task show title, live_hours sort id', limit: 10 }), [
      { title: 'Design', live_hours: 2 },
      { title: 'Build', live_hours: 3 },
      { title: 'Archive', live_hours: 0 },
      { title: 'Plan', live_hours: 1 },
      { title: 'Loose', live_hours: 0 },
    ]);
    assert.deepEqual(await post('manager', { q: 'client open_tasks > 0 show name sort name', limit: 10 }), [
      { name: 'Acme' },
      { name: 'Brio' },
    ]);
    // A related list's footer (pagePaths.totalsView): the rows' rollup summed over every row the reference matches.
    assert.deepEqual(
      await post('manager', {
        route: '/api/breakdown',
        def: {
          base: 'task',
          by: [],
          measures: [{ fn: 'sum', path: 'live_hours', alias: 'total_0' }],
          filter: { groups: [[{ path: 'project_id', op: '=', value: 1 }]] },
          limit: 1,
        },
      }),
      [{ total_0: 5 }],
    );
    assert.equal(await post('clerk', { q: 'task show title, live_hours', limit: 10 }), undefined);
    assert.deepEqual(await post('clerk', { q: 'task show title sort id', limit: 1 }), [{ title: 'Design' }]);
  });
});
