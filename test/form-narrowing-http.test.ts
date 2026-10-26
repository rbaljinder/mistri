import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appNarrowings } from '../packages/mistri/src/server/app/appValidation.js';

/**
 * A New form's narrowed picker (`form.fields.milestone_id.where`) is drawn
 * in the browser and held by the server: a milestone of another project is
 * refused on the New form's insert, on a record's Save and when the project
 * moves under a milestone that no longer belongs to it — the refusal naming
 * the field, never the rows it compared.
 */
const appId = 'narrowed';
const owner = 'narrowed-db';

async function fixture(
  run: (f: {
    post: (path: string, body: Record<string, unknown>) => Promise<{ status: number; body: any }>;
    db: DatabaseSync;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-narrowing-http-'));
  const file = join(directory, 'fixture.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE project (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE milestone (id INTEGER PRIMARY KEY, name TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES project(id));
    CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, project_id INTEGER NOT NULL REFERENCES project(id),
      milestone_id INTEGER REFERENCES milestone(id));
    INSERT INTO project (id, name) VALUES (1, 'Launch'), (2, 'Audit');
    INSERT INTO milestone (id, name, project_id) VALUES (10, 'Beta', 1), (20, 'Fieldwork', 2);
    INSERT INTO task (id, title, project_id, milestone_id) VALUES (1, 'Existing', 1, 10);`);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Narrowed', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(
    {
      id: appId,
      name: 'Narrowed',
      connection: owner,
      resources: {
        task: {
          access: 'write',
          form: {
            show: ['title', 'project_id', 'milestone_id'],
            fields: { milestone_id: { where: { project_id: 'project_id' }, help: "Only the chosen project's milestones." } },
          },
        },
        project: {},
        milestone: {},
      },
      views: { tasks: { kind: 'list', from: 'task', show: ['title', 'project_id', 'milestone_id'] } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'narrowing fixture',
  );
  const host: AppHost = { app: { path: 'narrowing-fixture.ts', app: definition, pages: [], sources: {} }, pages: [] };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages: [] });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  try {
    await run({
      db,
      post: async (path, body) => {
        const response = await fetch(`http://${bound.host}:${bound.port}${path}`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: appId, ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
    });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    clearJournal(owner);
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

const refused = (reply: { status: number; body: any }) =>
  reply.status >= 400 || reply.body?.outcome === 'rejected' || (Array.isArray(reply.body?.errors) && reply.body.errors.length > 0);
const tasks = (db: DatabaseSync) =>
  db
    .prepare('SELECT id, title, project_id, milestone_id FROM task ORDER BY id')
    .all()
    .map((row) => ({ ...row }));

test("the New form's narrowed reference is held on insert: outside the chosen project is refused, inside and empty land", async () =>
  fixture(async ({ post, db }) => {
    const outside = await post('/api/insert', { table: 'task', values: { title: 'Wrong', project_id: 1, milestone_id: 20 } });
    assert.ok(refused(outside), JSON.stringify(outside.body));
    // The field is named; neither the milestone's project nor its name is.
    assert.match(JSON.stringify(outside.body), /milestone_id/);
    assert.doesNotMatch(JSON.stringify(outside.body), /Fieldwork|Audit/);
    assert.equal(tasks(db).length, 1);
    const inside = await post('/api/insert', { table: 'task', values: { title: 'Right', project_id: 2, milestone_id: 20 } });
    assert.equal(inside.status, 200, JSON.stringify(inside.body));
    const none = await post('/api/insert', { table: 'task', values: { title: 'Loose', project_id: 1 } });
    assert.equal(none.status, 200, JSON.stringify(none.body));
    assert.deepEqual(
      tasks(db).map((task) => task.title),
      ['Existing', 'Right', 'Loose'],
    );
  }));

test('a Save is held too: a milestone of another project, or a project moved from under its milestone, is refused and the row kept', async () =>
  fixture(async ({ post, db }) => {
    const milestone = await post('/api/update', { table: 'task', key: { id: 1 }, values: { milestone_id: 20 } });
    assert.ok(refused(milestone), JSON.stringify(milestone.body));
    const moved = await post('/api/update', { table: 'task', key: { id: 1 }, values: { project_id: 2 } });
    assert.ok(refused(moved), JSON.stringify(moved.body));
    assert.deepEqual(tasks(db)[0], { id: 1, title: 'Existing', project_id: 1, milestone_id: 10 });
    const both = await post('/api/update', { table: 'task', key: { id: 1 }, values: { project_id: 2, milestone_id: 20 } });
    assert.equal(both.status, 200, JSON.stringify(both.body));
    assert.deepEqual(tasks(db)[0], { id: 1, title: 'Existing', project_id: 2, milestone_id: 20 });
  }));

test('narrowings are read off the forms against the catalog, and one the catalog cannot hold is left out', () => {
  const schema = {
    label: '',
    dialect: 'sqlite' as const,
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'task',
        name: 'task',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'project_id', type: 'INTEGER', nullable: false, primaryKey: false },
          { name: 'milestone_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'milestone', column: 'id' } },
          { name: 'owner_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'person', column: 'id' } },
        ],
      },
      {
        id: 'milestone',
        name: 'milestone',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'project_id', type: 'INTEGER', nullable: false, primaryKey: false },
        ],
      },
    ],
  };
  const app = {
    resources: {
      task: {
        form: {
          fields: {
            milestone_id: { where: { project_id: 'project_id' } },
            // person is not in this catalog, so there is nothing to hold it against; its form is refused at load instead.
            owner_id: { where: { team_id: 'project_id' } },
          },
        },
      },
    },
  } as unknown as Parameters<typeof appNarrowings>[1];
  assert.deepEqual(
    [...appNarrowings(schema, app)],
    [
      [
        'task',
        [
          {
            kind: 'narrowed',
            field: 'milestone_id',
            target: 'milestone',
            key: 'id',
            where: [{ remote: 'project_id', local: 'project_id' }],
          },
        ],
      ],
    ],
  );
});

/* Skill run: a scaffolded form narrowed a tenant to the chosen unit's, and every command that moved a request — whose
   only input was a vendor — was refused `invalid_input` on tenant_id, with no reason, wherever a stored row predated
   the narrowing. A write that sets neither the reference nor what narrows it is not judged by it; one that does is
   refused with the pairing said. */
test('a write that touches neither the reference nor what narrows it is not judged by it, and a refusal says the pairing', async () =>
  fixture(async ({ post, db }) => {
    db.exec(`INSERT INTO task (id, title, project_id, milestone_id) VALUES (2, 'Predates', 1, 20)`);
    const title = await post('/api/update', { table: 'task', key: { id: 2 }, values: { title: 'Renamed' } });
    assert.equal(title.status, 200, JSON.stringify(title.body));
    assert.equal(tasks(db)[1].title, 'Renamed');
    const moved = await post('/api/update', { table: 'task', key: { id: 2 }, values: { project_id: 2, milestone_id: 10 } });
    assert.ok(refused(moved), JSON.stringify(moved.body));
    assert.ok(
      JSON.stringify(moved.body).includes(
        JSON.stringify(
          `Choose one whose project_id is this record's project_id (form.fields.milestone_id.where; a command that sets it reads "milestone").`,
        ),
      ),
      JSON.stringify(moved.body),
    );
    assert.doesNotMatch(JSON.stringify(moved.body), /Beta|Launch/);
  }));
