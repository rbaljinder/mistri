/**
 * A generated column under a row policy (field report R1): the database
 * computes it from the row the policy already bounds, so it is read like any
 * other column and written by nobody. SQLite's scoped catalog once kept a
 * table with one out of every scoped write ("read-only in this scope"), and
 * both engines advertised the column as a field to write.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appRoleWarnings } from '../packages/mistri/src/server/app/appRoleChecks.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { liveSkip } from './live.js';
import { LIVE_PG, policyServer } from './support/policyServer.js';

const APP = {
  id: 'spoke',
  name: 'Spoke',
  auth: {
    signUp: 'open',
    defaultRole: 'rider',
    rows: 'policy',
    roles: { rider: { read: true, write: ['job'] }, admin: { read: true, write: true } },
  },
  resources: { job: { access: 'write' }, bench: {} },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
};
const POLICY = `export default { appId: 'spoke', resolveRows() {
  return { job: { groups: [[{ column: 'bench_id', op: '=', value: 1 }]] }, bench: true };
} };`;
const SQLITE = `CREATE TABLE bench(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL, hours REAL NOT NULL DEFAULT 1, rate REAL NOT NULL DEFAULT 50,
    total REAL GENERATED ALWAYS AS (hours * rate) STORED, label TEXT GENERATED ALWAYS AS ('#' || id) VIRTUAL,
    bench_id INTEGER REFERENCES bench(id));
  INSERT INTO bench VALUES (1, 'Front'), (2, 'Back');
  INSERT INTO job(id, title, bench_id) VALUES (1, 'Tune', 1), (2, 'Hidden', 2);`;
const POSTGRES = `CREATE TABLE bench(id integer PRIMARY KEY, name text NOT NULL);
  CREATE TABLE job(id serial PRIMARY KEY, title text NOT NULL, hours integer NOT NULL DEFAULT 1, rate integer NOT NULL DEFAULT 50,
    total integer GENERATED ALWAYS AS (hours * rate) STORED, bench_id integer REFERENCES bench(id));
  INSERT INTO bench VALUES (1, 'Front'), (2, 'Back');
  INSERT INTO job(title, bench_id) VALUES ('Tune', 1), ('Hidden', 2);`;

async function exercise(t: TestContext, postgres: boolean) {
  const server = await policyServer(t, { app: APP, policy: POLICY, sql: postgres ? POSTGRES : SQLITE, postgres });
  const rider = await server.signUp('rider');
  const total = (row: Record<string, unknown>) => Number(row.total);

  const read = await server.api('run', { q: 'job' }, rider);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.deepEqual(read.body.errors, []);
  assert.deepEqual(
    read.body.rows.map((row: Record<string, unknown>) => [row.title, total(row)]),
    [['Tune', 50]],
  );

  const schema = await server.api('schema', undefined, rider);
  const columns = schema.body.tables.find((table: { id: string }) => table.id.endsWith('job')).columns;
  const writable = Object.fromEntries(columns.map((column: { name: string; writable?: boolean }) => [column.name, column.writable]));
  assert.equal(writable.title, true);
  assert.equal(writable.total, false, 'a generated column is never offered for writing');

  const inserted = await server.api('insert', { table: 'job', values: { title: 'Wheel true', hours: 2, bench_id: 1 } }, rider);
  assert.equal(inserted.status, 200, JSON.stringify(inserted.body) + server.log());
  assert.equal(total(inserted.body.row), 100);
  const updated = await server.api('update', { table: 'job', key: inserted.body.key, values: { hours: 3 } }, rider);
  assert.equal(updated.status, 200, JSON.stringify(updated.body) + server.log());

  const computed = await server.api('update', { table: 'job', key: inserted.body.key, values: { total: 9 } }, rider);
  assert.notEqual(computed.status, 200, JSON.stringify(computed.body));
  assert.equal(computed.body.outcome, 'rejected');
}

test('a generated column under a row policy is read and never written, on SQLite', { timeout: 60_000 }, (t) => exercise(t, false));

test(
  'a generated column under a row policy is read and never written, on PostgreSQL',
  { skip: liveSkip('postgres', LIVE_PG), timeout: 60_000 },
  (t) => exercise(t, true),
);

test('check warns where a write grant names a generated column', () => {
  const app = parseAppConfig(
    {
      ...APP,
      sources: { main: { connection: 'ops' } },
      auth: {
        ...APP.auth,
        roles: { ...APP.auth.roles, rider: { read: true, write: ['job'], fields: { job: { write: ['title', 'total'] } } } },
      },
    },
    'generated fixture',
  );
  const schema: DatabaseSchema = {
    dialect: 'sqlite',
    label: 'fixture',
    readAt: '',
    tables: [
      {
        id: 'job',
        name: 'job',
        schema: 'main',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
          { name: 'total', type: 'REAL', nullable: true, primaryKey: false, writable: false },
        ],
      },
      {
        id: 'bench',
        name: 'bench',
        schema: 'main',
        isView: false,
        columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
      },
    ],
    foreignKeys: [],
  } as unknown as DatabaseSchema;
  const warnings = appRoleWarnings({ app, path: '/spoke/app.json', dir: '/spoke', pages: [] } as never, schema);
  assert.ok(
    warnings.some((warning) => /role "rider" \[write-generated\]: it writes "job"\.total/.test(warning)),
    warnings.join('\n'),
  );
});
