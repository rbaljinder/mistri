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
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { withRollups } from '../packages/mistri/src/shared/appRollups.js';
import { planApiViewReadRequest } from '../packages/mistri/src/server/api/apiReadRequest.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { QueryRequest, QueryResult } from '../packages/engine/src/adapters/adapter.js';
import { commandCatalog, compileWhere, zonedCatalog } from '../packages/mistri/src/server/commands/commandDb.js';
import { compileWhen } from '../packages/mistri/src/server/commands/commandWhen.js';
import { assertGrantedAction } from '../packages/mistri/src/server/app/appTransitions.js';
import { prepareCommandTargets } from '../packages/mistri/src/server/commands/commandTargets.js';

/* `today` in an App is its `ui.timezone`'s day, read by the request's clock, on every path that reads a phrase:
   a list's, a rollup's, a computed column's, the App API's. The server here keeps Tokyo's clock and the App
   Chicago's, and the instant is pinned where they disagree: 23:30 on the 15th in Chicago is 14:30 on the 16th in
   Tokyo. A path that reads the server's zone, or that zones the clock twice, lands on the wrong day. */
process.env.TZ = 'Asia/Tokyo';
const INSTANT = '2020-01-16T05:30:00.000Z';
const CHICAGO_DAY = '2020-01-15';
const ZONE = 'America/Chicago';

const connection = 'zone-connection';
const appId = 'zone-app';
const viewer: Identity = { id: 'account-viewer', who: 'viewer@example.test', role: 'viewer' };

const resources = {
  project: { rollups: { due_today: { fn: 'count', from: 'task', query: 'due_on = today' } } },
  task: { computed: { due_now: { type: 'boolean', value: 'due_on = today' } } },
};

test("a rollup's query and a computed column read `today` as the App's day, not the server's", { timeout: 10_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-zone-clock-'));
  const previous = { clock: process.env.MISTRI_CLOCK, config: process.env.XDG_CONFIG_HOME };
  const path = join(directory, 'work.db');
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE project (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE task (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id), subject TEXT NOT NULL, due_on DATE NOT NULL);
    INSERT INTO project VALUES (1, 'Chicago day'), (2, 'Tokyo day');
    INSERT INTO task VALUES (1, 1, 'Tonight', '2020-01-15'), (2, 1, 'Also tonight', '2020-01-15'), (3, 2, 'Tomorrow', '2020-01-16');
  `);
  clearJournal(connection);
  const registry = new Registry();
  registry.add({ id: connection, name: 'Zone connection', url: path, source: 'config' });
  const manifest = parseAppConfig(
    {
      id: appId,
      name: 'Zone',
      connection,
      ui: { timezone: ZONE },
      resources,
      auth: { providers: ['email'], defaultRole: 'viewer', roles: { viewer: { read: true } } },
      views: { projects: { kind: 'list', from: 'project', label: 'Projects' } },
      home: 'projects',
      nav: ['projects'],
    },
    'zone clock fixture',
  );
  const pages = parsePagesConfig({ pages: [{ label: 'Project', base: 'project' }] }, 'zone pages');
  const host: AppHost = {
    app: { path: '/zone/app.ts', app: manifest, pages, sources: {} },
    pages: [],
    auth: {
      spec: manifest.auth!,
      store: join(directory, 'sessions.db'),
      handler: async () => {},
      close: async () => {},
      session: async () => viewer,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  process.env.XDG_CONFIG_HOME = directory;
  process.env.MISTRI_CLOCK = INSTANT;
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const post = async (route: string, body: Record<string, unknown>) => {
      const response = await fetch(`http://${bound.host}:${address.port}${route}`, {
        signal: AbortSignal.timeout(3_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: appId, ...body }),
      });
      assert.equal(response.status, 200);
      return response.json();
    };

    // The list already read the App's day; it is the reference the others must agree with.
    const listed = await post('/api/run', { q: 'task due_on = today sort id show id', exactCount: true });
    assert.deepEqual(listed.errors, []);
    assert.deepEqual(
      listed.rows.map((row: { id: number }) => row.id),
      [1, 2],
    );

    const rolled = await post('/api/run', { q: 'project sort id show id, due_today', exactCount: true });
    assert.deepEqual(rolled.errors, []);
    assert.deepEqual(
      rolled.rows.map((row: { due_today: number }) => Number(row.due_today)),
      [2, 0],
    );

    const computed = await post('/api/run', { q: 'task due_now = true sort id show id', exactCount: true });
    assert.deepEqual(computed.errors, []);
    assert.deepEqual(
      computed.rows.map((row: { id: number }) => row.id),
      [1, 2],
    );

    const counted = await post('/api/breakdown', { text: 'project count by name sort name' });
    assert.deepEqual(counted.errors ?? [], []);
    const summed = await post('/api/breakdown', { text: 'project sum due_today by name sort name' });
    assert.deepEqual(summed.errors ?? [], []);
    assert.deepEqual(
      summed.rows.map((row: Record<string, unknown>) => [row.name, Number(Object.values(row).find((v) => typeof v === 'number') ?? 0)]),
      [
        ['Chicago day', 2],
        ['Tokyo day', 0],
      ],
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(connection);
    db.close();
    for (const [name, value] of [
      ['MISTRI_CLOCK', previous.clock],
      ['XDG_CONFIG_HOME', previous.config],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: false, primaryKey });
const schema: DatabaseSchema = {
  label: 'Zone',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    { id: 'project', name: 'project', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('name', 'TEXT')] },
    {
      id: 'task',
      name: 'task',
      schema: '',
      isView: false,
      columns: [
        column('id', 'INTEGER', true),
        { ...column('project_id', 'INTEGER'), references: { table: 'project', column: 'id' } },
        column('due_on', 'DATE'),
      ],
    },
  ],
  foreignKeys: [{ name: 'task.project_id', from: { table: 'task', columns: ['project_id'] }, to: { table: 'project', columns: ['id'] } }],
};

test("a served catalog is given the request's instant and zones it once, for a rollup and a computed column alike", () => {
  /* A tenant App's catalog was handed a clock already zoned, which a computed column's `today` then zoned again;
     the plain App's was handed the instant, which a rollup's query read in the server's zone. One contract now:
     the instant in, the App's zone applied inside. */
  const app = parseAppConfig(
    { id: 'z', name: 'Z', ui: { timezone: ZONE }, resources, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' },
    'zone catalog',
  );
  const served = withRollups(app, schema, new Date(INSTANT));
  const project = served.tables.find((table) => table.id === 'project')!;
  const values = JSON.stringify(project.rollups?.due_today?.filter);
  assert.match(values, new RegExp(CHICAGO_DAY), values);
  const task = served.tables.find((table) => table.id === 'task')!;
  assert.match(JSON.stringify(task.computed?.due_now?.expr), new RegExp(CHICAGO_DAY));
});

test("the App API reads a view's standing `today` as the App's day", () => {
  const app = parseAppConfig(
    {
      id: 'dues',
      name: 'Dues',
      ui: { timezone: ZONE },
      resources: { task: {} },
      auth: { roles: { reader: { read: true } } },
      views: { due: { kind: 'list', from: 'task', query: 'due_on = today' } },
      home: 'due',
      api: { version: 1, roles: ['reader'], resources: { task: { fields: ['id', 'due_on'] } }, views: ['due'] },
    },
    'zone api',
  );
  const plan = planApiViewReadRequest(app, schema, 'view:due', '', { integers: 'decimal-string' }, new Date(INSTANT));
  const said = JSON.stringify(plan.standingFilter);
  assert.match(said, new RegExp(`"${CHICAGO_DAY}"`), said);
});

/* A command's `when`, its handler's `where`, a fixed action's `when` and a bulk action's targets are given the
   request's instant (it is what a stamp records) and read their date phrase in the App's zone. */
test("a command's catalog, a granted action and a bulk action read `today` as the App's day", async () => {
  const instant = new Date(INSTANT);
  const catalog = zonedCatalog(
    commandCatalog(schema, ['task'], (name) => name)!,
    ZONE,
  );
  const compiled = compileWhere(catalog.task, 'due_on = today', instant);
  assert.match(JSON.stringify(compiled.filter), new RegExp(`"${CHICAGO_DAY}"`));
  assert.match(JSON.stringify(compileWhen(catalog.task, 'due_on = today', instant).filter), new RegExp(`"${CHICAGO_DAY}"`));

  const asked: unknown[] = [];
  const reader = {
    query: async (request: QueryRequest): Promise<QueryResult> => {
      asked.push(request.filter);
      return { rows: [{ id: 1, status: 'open' }], columns: [], total: 1 } as unknown as QueryResult;
    },
  };
  const action = { id: 'close', label: 'Close', set: { status: 'done' }, when: 'due_on = today' };
  const withStatus: DatabaseSchema = {
    ...schema,
    tables: schema.tables.map((table) =>
      table.id === 'task' ? { ...table, columns: [...table.columns, column('status', 'TEXT')] } : table,
    ),
  };
  await assertGrantedAction(
    reader,
    withStatus,
    [action as never],
    { table: 'task', key: { id: 1 }, values: { status: 'done' } },
    instant,
    undefined,
    ZONE,
  );
  await prepareCommandTargets({
    query: reader.query,
    schema,
    table: 'task',
    keyColumns: ['id'],
    keys: [{ id: 1 }],
    when: 'due_on = today',
    now: instant,
    zone: ZONE,
  });
  const said = JSON.stringify(asked);
  assert.ok((said.match(new RegExp(`"${CHICAGO_DAY}"`, 'g')) ?? []).length >= 2, said);
  assert.doesNotMatch(said, /"2020-01-17"/, said);
});
