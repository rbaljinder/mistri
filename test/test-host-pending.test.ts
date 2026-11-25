/**
 * `startTestApp({ pending: true })`: the App's pending migrations applied to the test's own copy of the database
 * before the App starts, as `mistri check --pending` judges the App against them. A field report wrote a migration
 * and the App that needs it, and could test neither until the database it develops on was migrated: the tests ran
 * on a copy of that database, which lacked the column.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { createTestWorkspace, startTestApp } from '../packages/mistri/src/server/testing.ts';
import { mistri } from './support/bootstrapApp.js';

/** An App whose list shows `note`, a column only its second migration makes; the database holds the first alone. */
function ahead(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'mistri-test-host-pending-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'app'),
    database = join(root, 'tiny.db'),
    config = join(root, 'mistri.json');
  mkdirSync(join(directory, 'migrations'), { recursive: true });
  writeFileSync(
    join(directory, 'app.json'),
    JSON.stringify({
      id: 'tiny',
      name: 'Tiny',
      connection: 'tiny',
      resources: { task: { access: 'write' } },
      auth: { roles: { reader: { read: true } } },
      views: { tasks: { kind: 'list', from: 'task', show: ['name'] } },
      home: 'tasks',
    }),
  );
  writeFileSync(join(directory, 'migrations', 'V1__tasks.sql'), 'CREATE TABLE task (id INTEGER PRIMARY KEY, name TEXT NOT NULL);\n');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'tiny', url: database, writable: true }] }));
  const up = mistri(['migrate', 'up', '--app', directory, '--config', config], root, { XDG_CONFIG_HOME: join(root, 'xdg') });
  assert.equal(up.code, 0, up.said);
  // The change being worked on: a migration not yet applied, and the App that reads what it makes.
  writeFileSync(join(directory, 'migrations', 'V2__note.sql'), 'ALTER TABLE task ADD COLUMN note TEXT;\n');
  const app = JSON.parse(readFileSync(join(directory, 'app.json'), 'utf8')) as { views: { tasks: { show: string[] } } };
  app.views.tasks.show = ['name', 'note'];
  writeFileSync(join(directory, 'app.json'), JSON.stringify(app));
  const columns = (file: string) => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      return (db.prepare('PRAGMA table_info(task)').all() as { name: string }[]).map((column) => column.name);
    } finally {
      db.close();
    }
  };
  return { root, directory, database, config, columns };
}

test('pending: the test runs on its copy with the pending migrations applied, and the database it copied is untouched', async (t) => {
  const { directory, database, config, columns } = ahead(t);
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  // As the tests ran before: on a copy of the database as it is, which the App no longer fits.
  const stale = await startTestApp({ workspace, directory, config: await workspace.copyConfig(config, 'before.json') });
  await assert.rejects(stale.seed('task', [{ name: 'Call back', note: 'after four' }]), /note/);
  await stale.close();

  const before = readFileSync(database);
  const host = await startTestApp({ workspace, directory, config: await workspace.copyConfig(config), pending: true });
  const [row] = await host.seed('task', [{ name: 'Call back', note: 'after four' }]);
  assert.equal(row.note, 'after four');
  await host.close();
  assert.deepEqual(readFileSync(database), before, 'the database the test copied was not migrated');
  assert.deepEqual(columns(database), ['id', 'name']);

  // The same with the database named alone: a file outside the workspace is served, and migrated, as a copy.
  const named = await startTestApp({ workspace, directory, database, pending: true });
  assert.equal((await named.seed('task', { name: 'Write up', note: 'today' })).note, 'today');
  await named.close();
  assert.deepEqual(readFileSync(database), before);
});

test('pending refuses a database that is not the test’s own copy, and changes nothing', async (t) => {
  const { directory, database, config, columns } = ahead(t);
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  // The config as it is on disk names the database itself, not a copy in the workspace.
  await assert.rejects(
    startTestApp({ workspace, directory, config, pending: true }),
    /startTestApp\(\{ pending \}\) could not apply the pending migrations: pending applies migrations to the test's own copy of the database, and "tiny" is not one/,
  );
  assert.deepEqual(columns(database), ['id', 'name']);
});

test('a check that fails while a migration waits says --pending, and with it the App is judged against the schema to come', (t) => {
  const { root, directory, config } = ahead(t);
  // A grant naming the column the pending migration adds: what the report's check rejected.
  const file = join(directory, 'app.json');
  const app = JSON.parse(readFileSync(file, 'utf8')) as { auth: { roles: Record<string, unknown> } };
  app.auth.roles.reader = { read: true, fields: { task: { read: ['id', 'name', 'note'] } } };
  writeFileSync(file, JSON.stringify(app));
  const env = { XDG_CONFIG_HOME: join(root, 'xdg') };
  const checked = mistri(['check', '--app', directory, '--config', config], root, env);
  assert.equal(checked.code, 4, checked.said);
  assert.match(checked.stdout, /column "note" is unknown/);
  assert.match(checked.stdout, /note: 1 migration is pending \(V2__note\.sql\)\. mistri check --pending judges the App against the schema/);
  const judged = mistri(['check', '--app', directory, '--config', config, '--pending'], root, env);
  assert.equal(judged.code, 0, judged.said);
  assert.doesNotMatch(judged.stdout, /note: 1 migration is pending/);
});
