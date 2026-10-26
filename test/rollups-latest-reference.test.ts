/**
 * A `latest` of a reference column is a reference (rollups.ts `references`): it is served as the column it
 * reads, and a path may read through it — `resident.name`, the name of the record the newest row points at —
 * as the record's own column would be read. The value is the key, the name rides beside it, and a reader
 * held from the target table is served neither.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { appRollupRules, parseAppConfig, withRollups } from '../packages/mistri/src/shared/app.js';
import { ANSI_STYLE } from '../packages/engine/src/shared/filter.js';
import { listReferenceNames } from '../packages/engine/src/shared/listQuestion.js';
import { rollupColumnMeta, rollupReads } from '../packages/engine/src/shared/rollups.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { compileView, withViewComputed } from '../packages/engine/src/shared/view.js';
import { textToView } from '../packages/engine/src/shared/viewtext.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const schema = {
  label: 'Lettings',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    { id: 'person', name: 'person', schema: '', isView: false, columns: [key('id'), column('name', 'TEXT')] },
    { id: 'home', name: 'home', schema: '', isView: false, columns: [key('id'), column('code', 'TEXT')] },
    {
      id: 'lease',
      name: 'lease',
      schema: '',
      isView: false,
      columns: [
        key('id'),
        column('home_id', 'INTEGER'),
        column('person_id', 'INTEGER', { references: { table: 'person', column: 'id' } }),
        column('start_on', 'DATE'),
      ],
    },
  ],
  foreignKeys: [
    { name: 'lease_home', from: { table: 'lease', columns: ['home_id'] }, to: { table: 'home', columns: ['id'] } },
    { name: 'lease_person', from: { table: 'lease', columns: ['person_id'] }, to: { table: 'person', columns: ['id'] } },
  ],
} as DatabaseSchema;

const config = parseAppConfig(
  {
    name: 'Lettings',
    resources: {
      home: { rollups: { resident: { fn: 'latest', from: 'lease', column: 'person_id', sort: 'start_on' } } },
      person: { recordLabel: 'name' },
      lease: {},
    },
    views: { homes: { kind: 'list', from: 'home' } },
    home: 'homes',
    nav: ['homes'],
  },
  'latest reference',
);

test('a latest of a reference column is a reference, named by a column of its record', () => {
  const judged = appRollupRules(config, schema);
  assert.deepEqual(judged.problems, []);
  const resident = judged.rules.get('home')!.resident;
  assert.deepEqual(resident.references, { table: 'person', column: 'id' });
  assert.deepEqual(rollupColumnMeta('resident', resident).references, { table: 'person', column: 'id' });
  const served = withRollups(config, schema);
  const names = listReferenceNames({ schema: served, resources: config.resources ?? {} } as never, {
    table: 'home',
    show: ['code', 'resident'],
  });
  assert.deepEqual(names, { resident: 'resident.name' });
});

test('the name is read through the newest row, from the target table, and the reader is held to both', () => {
  const served = withRollups(config, schema);
  const view = withViewComputed(served, textToView(served, 'home show code, resident, resident.name').view!);
  const { text, params } = compileView(served, view, ANSI_STYLE);
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE home (id INTEGER PRIMARY KEY, code TEXT);
    CREATE TABLE lease (id INTEGER PRIMARY KEY, home_id INTEGER, person_id INTEGER, start_on DATE);
    INSERT INTO person VALUES (1, 'Ada'), (2, 'Bo');
    INSERT INTO home VALUES (1, 'A-1'), (2, 'A-2');
    INSERT INTO lease VALUES (1, 1, 1, '2024-01-01'), (2, 1, 2, '2025-01-01');`);
  const rows = db.prepare(text).all(...(params as never[])) as Array<Record<string, unknown>>;
  assert.deepEqual(
    rows.map((row) => [row.code, row.resident, row['resident.name']]),
    [
      ['A-1', 2, 'Bo'],
      ['A-2', null, null],
    ],
  );
  const reads = rollupReads(view.computed!['resident.name']);
  assert.ok(
    reads.some((read) => read.table === 'person' && read.fields.includes('name')),
    JSON.stringify(reads),
  );
});
