/**
 * A rollup through two references (appRollups.ts, `whose: 'task_id.project_id'`):
 * the reach a page metric already has, read like a column. What the catalog
 * serves and refuses by name, the statement it compiles to, and the served
 * App, where the reader's grants and hidden columns hold on both hops — a
 * reader who cannot read the middle table, its reference, or the column
 * summed is served no number, and a request that brings its own is refused.
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
import { appRollupRules, parseAppConfig, withRollups } from '../packages/mistri/src/shared/app.js';
import { ANSI_STYLE, MYSQL_STYLE, POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import { rollupReads } from '../packages/engine/src/shared/rollups.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView, withViewComputed } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const schema: DatabaseSchema = {
  label: 'Tracker',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    { id: 'client', name: 'client', schema: '', isView: false, columns: [key('id'), column('name', 'TEXT')] },
    {
      id: 'project',
      name: 'project',
      schema: '',
      isView: false,
      columns: [key('id'), column('name', 'TEXT'), column('client_id', 'INTEGER')],
    },
    {
      id: 'task',
      name: 'task',
      schema: '',
      isView: false,
      columns: [key('id'), column('project_id', 'INTEGER'), column('reviewer_project_id', 'INTEGER'), column('title', 'TEXT')],
    },
    {
      id: 'time_entry',
      name: 'time_entry',
      schema: '',
      isView: false,
      columns: [
        key('id'),
        column('task_id', 'INTEGER'),
        column('hours', 'NUMERIC'),
        column('note', 'TEXT'),
        column('billable', 'INTEGER'),
        column('logged_on', 'DATE'),
      ],
    },
  ],
  foreignKeys: [
    { name: 'project_client', from: { table: 'project', columns: ['client_id'] }, to: { table: 'client', columns: ['id'] } },
    { name: 'task_project', from: { table: 'task', columns: ['project_id'] }, to: { table: 'project', columns: ['id'] } },
    { name: 'task_reviewer', from: { table: 'task', columns: ['reviewer_project_id'] }, to: { table: 'project', columns: ['id'] } },
    { name: 'entry_task', from: { table: 'time_entry', columns: ['task_id'] }, to: { table: 'task', columns: ['id'] } },
  ],
} as DatabaseSchema;

const app = (rollups: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      name: 'Tracker',
      resources: { project: { rollups }, task: {}, time_entry: {} },
      views: { projects: { kind: 'list', from: 'project' } },
      home: 'projects',
      nav: ['projects'],
      ...extra,
    },
    'two hops',
  );

test('a rollup through two references is served as an inner level over its rows, and each hop is judged by name', () => {
  const judged = appRollupRules(
    app({
      hours: { fn: 'sum', from: 'time_entry', column: 'hours', whose: 'task_id.project_id', query: 'billable = 1' },
      entries: { fn: 'count', from: 'time_entry', whose: 'task_id.project_id' },
      last_logged: { fn: 'max', from: 'time_entry', column: 'logged_on', whose: 'task_id.project_id' },
      last_note: { fn: 'latest', from: 'time_entry', column: 'note', sort: 'logged_on', whose: 'task_id.project_id' },
    }),
    schema,
  );
  assert.deepEqual(judged.problems, []);
  // A latest's order is the rows' own: the inner level carries it, and the outer reads no field of the middle table but its reference.
  assert.deepEqual(judged.rules.get('project')!.last_note, {
    fn: 'latest',
    via: 'task.project_id',
    type: 'TEXT',
    of: { fn: 'latest', via: 'time_entry.task_id', column: 'note', by: 'logged_on', type: 'TEXT' },
  });
  assert.match(
    appRollupRules(app({ r: { fn: 'latest', from: 'time_entry', column: 'note', sort: 'title', whose: 'task_id.project_id' } }), schema)
      .problems[0],
    /no column "title" to order by/,
  );
  const project = judged.rules.get('project')!;
  assert.equal(project.hours.via, 'task.project_id');
  assert.equal(project.hours.of!.via, 'time_entry.task_id');
  assert.equal(project.hours.of!.column, 'hours');
  assert.equal(project.hours.of!.filter!.groups[0][0].column, 'billable', 'the declared query narrows the rows, not the middle table');
  assert.equal(project.hours.filter, undefined);
  assert.equal(project.entries.fn, 'count');
  assert.equal(project.last_logged.type, 'DATE');
  // What a reader is held to: the middle table and its reference, then the rows, their reference, column and query.
  assert.deepEqual(rollupReads(project.hours), [
    { table: 'task', fields: ['project_id'] },
    { table: 'time_entry', fields: ['task_id', 'hours', 'billable'] },
  ]);

  const problem = (rollup: Record<string, unknown>) => appRollupRules(app({ r: rollup }), schema).problems[0];
  assert.match(
    problem({ fn: 'count', from: 'time_entry', whose: 'nope.project_id' }),
    /"nope" is not a reference from "time_entry"\. Its references: task_id/,
  );
  assert.match(problem({ fn: 'count', from: 'time_entry', whose: 'task_id.title' }), /"title" is not a reference from "task" to "project"/);
  assert.match(
    problem({ fn: 'sum', from: 'time_entry', column: 'note', whose: 'task_id.project_id' }),
    /"time_entry\.note" is TEXT; a sum reads numbers/,
  );
  assert.match(problem({ fn: 'sum', from: 'time_entry', column: 'cost', whose: 'task_id.project_id' }), /has no column "cost"/);
  assert.match(problem({ fn: 'count', from: 'time_entry', whose: 'task_id.project_id', query: 'nope = 1' }), /"r" query: /);
  // A third hop is refused as it is read; and a two-hop rollup is never the inner of another.
  assert.throws(() => app({ r: { fn: 'count', from: 'time_entry', whose: 'task_id.project_id.id' } }), /one or two references/);
  const deeper = parseAppConfig(
    {
      name: 'Tracker',
      resources: {
        client: { rollups: { hours: { fn: 'sum', from: 'project', column: 'hours' } } },
        project: { rollups: { hours: { fn: 'sum', from: 'time_entry', column: 'hours', whose: 'task_id.project_id' } } },
        task: {},
        time_entry: {},
      },
      views: { projects: { kind: 'list', from: 'project' } },
      home: 'projects',
      nav: ['projects'],
    },
    'deeper',
  );
  const judgedDeeper = appRollupRules(deeper, schema);
  assert.equal(judgedDeeper.problems.length, 1);
  assert.match(judgedDeeper.problems[0], /"project\.hours" is itself a rollup of a rollup/);
});

const served = withRollups(
  app({
    hours: { fn: 'sum', from: 'time_entry', column: 'hours', whose: 'task_id.project_id' },
    entries: { fn: 'count', from: 'time_entry', whose: 'task_id.project_id' },
  }),
  schema,
);

test("a two-hop rollup is the rows' subquery inside the middle table's, and a count of none is 0", () => {
  const view = withViewComputed(served, textToView(served, 'project show name, hours, entries where entries > 0').view!);
  for (const [style, q] of [
    [ANSI_STYLE, '"'],
    [POSTGRES_STYLE, '"'],
    [MYSQL_STYLE, '`'],
  ] as const) {
    const { text } = compileView(schema, view, style);
    const inner = `\\(SELECT COALESCE\\(SUM\\(${q}time_entry_\\d+${q}\\.${q}hours${q}\\), 0\\) FROM ${q}time_entry${q} ${q}time_entry_\\d+${q} WHERE ${q}time_entry_\\d+${q}\\.${q}task_id${q} = ${q}task_\\d+${q}\\.${q}id${q}\\)`;
    assert.match(
      text,
      new RegExp(
        `\\(SELECT COALESCE\\(SUM\\(${inner}\\), 0\\) FROM ${q}task${q} ${q}task_\\d+${q} WHERE ${q}task_\\d+${q}\\.${q}project_id${q} = ${q}project_0${q}\\.${q}id${q}\\) AS ${q}hours${q}`,
      ),
      text,
    );
    assert.match(text, /COALESCE\(SUM\(\(SELECT COUNT\(\*\)/);
  }
});

/* ---------- served ---------- */

const identity = (role: string): Identity => ({ id: `account-${role}`, who: `${role}@example.test`, role });
const sessions: Record<string, Identity> = { manager: identity('manager'), lead: identity('lead'), clerk: identity('clerk') };

async function serve(
  resources: Record<string, unknown>,
  run: (
    post: (who: string, route: string, body: unknown) => Promise<{ status: number; body: Record<string, unknown> }>,
    catalog: (who: string) => Promise<string[]>,
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-rollups-two-hops-'));
  const path = join(directory, 'tracker.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE project (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE task (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id), title TEXT NOT NULL);
    CREATE TABLE time_entry (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES task(id), hours NUMERIC NOT NULL, billable INTEGER NOT NULL);
    INSERT INTO project VALUES (1, 'Atlas'), (2, 'Beacon'), (3, 'Comet');
    INSERT INTO task VALUES (1, 1, 'Design'), (2, 1, 'Build'), (3, 2, 'Plan');
    INSERT INTO time_entry VALUES (1, 1, 2.5, 1), (2, 1, 1.5, 0), (3, 2, 4, 1), (4, 3, 3, 1);`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'tracker', name: 'Tracker', url: path, source: 'config', writable: false });
  const manifest = parseAppConfig(
    {
      id: 'tracker-app',
      name: 'Tracker',
      connection: 'tracker',
      resources,
      // The lead reads projects and time, never the tasks between them; the clerk projects and tasks, never the time.
      auth: {
        providers: ['email'],
        defaultRole: 'clerk',
        roles: { manager: { read: true }, lead: { read: ['project', 'time_entry'] }, clerk: { read: ['project', 'task'] } },
      },
      views: { projects: { kind: 'list', from: 'project', show: ['name'] } },
      home: 'projects',
      nav: ['projects'],
    },
    'served',
  );
  const host: AppHost = {
    app: { path: '/tracker/app.ts', app: manifest, pages: [], sources: {} },
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
    await run(
      async (who, route, body) => {
        const res = await fetch(`http://${bound.host}:${bound.port}${route}?app=tracker-app`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: `session=${who}` },
          body: JSON.stringify(body),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      },
      async (who) => {
        const res = await fetch(`http://${bound.host}:${bound.port}/api/schema?app=tracker-app`, { headers: { cookie: `session=${who}` } });
        return Object.keys(((await res.json()) as DatabaseSchema).tables.find((table) => table.id === 'project')?.rollups ?? {});
      },
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

const ROLLUPS = {
  hours: { fn: 'sum', from: 'time_entry', column: 'hours', whose: 'task_id.project_id' },
  billable_hours: { fn: 'sum', from: 'time_entry', column: 'hours', whose: 'task_id.project_id', query: 'billable = 1' },
  entries: { fn: 'count', from: 'time_entry', whose: 'task_id.project_id' },
};
const FORGED = {
  id: 'x',
  name: 'x',
  base: 'project',
  columns: [{ path: 'hours' }],
  computed: {
    hours: {
      fn: 'sum',
      via: 'task.project_id',
      type: 'NUMERIC',
      on: '',
      of: { fn: 'sum', via: 'time_entry.task_id', column: 'hours', type: 'NUMERIC' },
    },
  },
};
const rows = (reply: { body: Record<string, unknown> }) => reply.body.rows as Array<Record<string, unknown>> | undefined;

test("served: a two-hop rollup reads under the reader's grants on both hops, and a reader missing either is served none", async () => {
  await serve({ project: { rollups: ROLLUPS }, task: {}, time_entry: {} }, async (post, catalog) => {
    const list = await post('manager', '/api/run', { q: 'project show name, hours, billable_hours, entries sort name', limit: 10 });
    assert.deepEqual(
      rows(list),
      [
        { name: 'Atlas', hours: 8, billable_hours: 6.5, entries: 3 },
        { name: 'Beacon', hours: 3, billable_hours: 3, entries: 1 },
        { name: 'Comet', hours: 0, billable_hours: 0, entries: 0 },
      ],
      JSON.stringify(list.body),
    );
    const busy = await post('manager', '/api/run', { q: 'project entries > 1 show name', limit: 10 });
    assert.deepEqual(rows(busy), [{ name: 'Atlas' }]);
    const measured = await post('manager', '/api/breakdown', {
      def: { base: 'project', by: [], measures: [{ fn: 'sum', path: 'hours', alias: 'value' }] },
    });
    assert.deepEqual(rows(measured), [{ value: 11 }], JSON.stringify(measured.body));

    assert.deepEqual(await catalog('manager'), ['hours', 'billable_hours', 'entries']);
    // Neither the reader who cannot read the tasks between, nor the one who cannot read the time.
    assert.deepEqual(await catalog('lead'), []);
    assert.deepEqual(await catalog('clerk'), []);
    for (const who of ['lead', 'clerk']) {
      assert.equal(rows(await post(who, '/api/run', { q: 'project show name, hours', limit: 10 })), undefined, who);
      assert.equal(rows(await post(who, '/api/view/run', { count: 'none', view: FORGED })), undefined, `${who}: a forged rollup`);
      assert.equal(
        rows(
          await post(who, '/api/breakdown', {
            def: { base: 'project', by: [], measures: [{ fn: 'sum', path: 'hours' }], computed: FORGED.computed },
          }),
        ),
        undefined,
        `${who}: a forged breakdown`,
      );
    }
  });
});

test('served: a hidden column on either hop serves no rollup that reads it', async () => {
  // The hours are hidden: a sum of them is not served, a count of the rows still is.
  await serve({ project: { rollups: ROLLUPS }, task: {}, time_entry: { hidden: ['hours'] } }, async (post, catalog) => {
    assert.deepEqual(await catalog('manager'), ['entries']);
    assert.equal(rows(await post('manager', '/api/run', { q: 'project show name, hours', limit: 10 })), undefined);
    assert.equal(
      rows(await post('manager', '/api/view/run', { count: 'none', view: FORGED })),
      undefined,
      'a forged sum of a hidden column',
    );
    assert.deepEqual(rows(await post('manager', '/api/run', { q: 'project show name, entries sort name', limit: 10 })), [
      { name: 'Atlas', entries: 3 },
      { name: 'Beacon', entries: 1 },
      { name: 'Comet', entries: 0 },
    ]);
  });
  // The middle reference is hidden: nothing reaches the project through the tasks.
  await serve({ project: { rollups: ROLLUPS }, task: { hidden: ['project_id'] }, time_entry: {} }, async (post, catalog) => {
    assert.deepEqual(await catalog('manager'), []);
    assert.equal(
      rows(await post('manager', '/api/view/run', { count: 'none', view: FORGED })),
      undefined,
      'a forged walk through a hidden reference',
    );
  });
});
