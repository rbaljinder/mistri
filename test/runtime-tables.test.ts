/**
 * The one placement function (shared/runtimeTables.ts): the SQL a store writes for a runtime table
 * and the catalog coordinates a reader compares it against come from the same place. PostgreSQL
 * keeps the runtime in its own schema under plain names; SQLite and MySQL keep the prefix.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isRuntimeRelation,
  postgresRuntimeNames,
  RUNTIME_SCHEMA,
  runtimeName,
  runtimeRelation,
  runtimeSchema,
  runtimeTable,
  type RuntimeDialect,
} from '../packages/engine/src/shared/runtimeTables.js';

test('runtimeTable qualifies and quotes per dialect, from a bare or a physical name', () => {
  for (const name of ['history_change', '__mistri_history_change']) {
    assert.equal(runtimeTable('postgres', name), 'mistri."history_change"');
    assert.equal(runtimeTable('sqlite', name), 'main."__mistri_history_change"');
    assert.equal(runtimeTable('mysql', name), '`__mistri_history_change`');
    assert.equal(runtimeTable('mysql', name, 'shop'), '`shop`.`__mistri_history_change`');
  }
  assert.equal(runtimeTable('mysql', 'x', 'we`ird'), '`we``ird`.`__mistri_x`');
});

test('runtimeTable refuses what is not a table name instead of quoting it', () => {
  assert.throws(() => runtimeTable('postgres', 'a"b'), /Not a runtime table name/);
  assert.throws(() => runtimeTable('sqlite', ''), /Not a runtime table name/);
  assert.throws(() => runtimeTable('postgres', '__mistri_'), /Not a runtime table name/);
});

test('runtimeRelation gives the catalog coordinates the SQL name stands for', () => {
  assert.deepEqual(runtimeRelation('postgres', 'job'), {
    schema: 'mistri',
    relname: 'job',
  });
  assert.deepEqual(runtimeRelation('postgres', '__mistri_job'), {
    schema: 'mistri',
    relname: 'job',
  });
  assert.deepEqual(runtimeRelation('sqlite', '__mistri_job'), {
    schema: 'main',
    relname: '__mistri_job',
  });
  assert.deepEqual(runtimeRelation('mysql', 'job'), {
    schema: null,
    relname: '__mistri_job',
  });
  assert.deepEqual(runtimeRelation('mysql', 'job', 'shop'), {
    schema: 'shop',
    relname: '__mistri_job',
  });
  assert.equal(runtimeSchema('postgres'), runtimeRelation('postgres', 'x').schema);
  assert.equal(runtimeSchema('sqlite'), runtimeRelation('sqlite', 'x').schema);
});

test('isRuntimeRelation reads the placement per dialect', () => {
  assert.equal(isRuntimeRelation('postgres', 'mistri', 'job'), true);
  assert.equal(isRuntimeRelation('postgres', 'mistri', 'auth_user'), true);
  assert.equal(isRuntimeRelation('postgres', 'public', 'orders'), false);
  // An App's look-alike is refused by name elsewhere (reservedSql.ts); it is not the runtime's.
  assert.equal(isRuntimeRelation('postgres', 'public', '__mistri_job'), false);
  assert.equal(isRuntimeRelation('postgres', null, 'job'), false);
  assert.equal(isRuntimeRelation('sqlite', 'main', '__mistri_job'), true);
  assert.equal(isRuntimeRelation('sqlite', 'temp', '__mistri_job'), false);
  assert.equal(isRuntimeRelation('mysql', 'shop', '__mistri_job'), true);
  assert.equal(isRuntimeRelation('mysql', null, 'orders'), false);
});

test('every dialect has a placement: the prefix on SQLite and MySQL, the runtime schema on PostgreSQL', () => {
  const dialects: RuntimeDialect[] = ['sqlite', 'mysql'];
  for (const dialect of dialects) assert.match(runtimeTable(dialect, 'x'), /__mistri_x/);
  assert.equal(runtimeTable('postgres', 'x'), `${RUNTIME_SCHEMA}."x"`);
  assert.equal(RUNTIME_SCHEMA, 'mistri');
});

test('a store prefix and its table names read the same way inside the PostgreSQL schema', () => {
  assert.equal(runtimeName('postgres', '__mistri_job_'), 'job_');
  assert.equal(runtimeName('sqlite', 'job_'), '__mistri_job_');
  assert.deepEqual(postgresRuntimeNames({ meta: '__mistri_job_meta', job: '__mistri_job_job' }), { meta: 'job_meta', job: 'job_job' });
});
