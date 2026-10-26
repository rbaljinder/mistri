import assert from 'node:assert/strict';
import { test } from 'node:test';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import type { Dialect } from '../packages/engine/src/shared/schema.js';

function row(dialect: Dialect, type: string, nullable = false) {
  return typesForSchema({
    dialect,
    label: 'numeric contract',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'item',
        schema: 'main',
        name: 'item',
        isView: false,
        columns: [{ name: 'value', type, nullable, primaryKey: false }],
      },
    ],
  })
    .split('\n')
    .find((line) => line.startsWith('  item: {'));
}

test('SQLite wide integers allow lossless large-integer strings; an INTEGER is a number', () => {
  for (const type of ['BIGINT', 'UNSIGNED BIG INT', 'INT8']) {
    assert.equal(row('sqlite', type), '  item: { value: number | string };');
    assert.equal(row('sqlite', type, true), '  item: { value: number | string | null };');
  }
  for (const type of ['INTEGER', 'INT', 'SMALLINT', 'TINYINT', 'MEDIUMINT']) {
    assert.equal(row('sqlite', type), '  item: { value: number };');
    assert.equal(row('sqlite', type, true), '  item: { value: number | null };');
  }
});

test('MySQL BIGINT generated Rows reflect supportBigNumbers without widening smaller integers', () => {
  for (const type of ['BIGINT', 'bigint unsigned', 'bigint(20)']) {
    assert.equal(row('mysql', type), '  item: { value: number | string };');
    assert.equal(row('mysql', type, true), '  item: { value: number | string | null };');
  }
  for (const type of ['INTEGER', 'INT', 'SMALLINT', 'MEDIUMINT', 'TINYINT']) {
    assert.equal(row('mysql', type), '  item: { value: number };');
  }
});

test('SQLite numeric affinity can also return lossless integer strings, unlike real affinity', () => {
  for (const type of ['NUMERIC', 'DECIMAL(20, 2)', 'MONEY', 'SERIAL']) {
    assert.equal(row('sqlite', type), '  item: { value: number | string };');
    assert.equal(row('sqlite', type, true), '  item: { value: number | string | null };');
  }
  for (const type of ['REAL', 'FLOAT', 'DOUBLE PRECISION']) assert.equal(row('sqlite', type), '  item: { value: number };');
});

test('numeric Rows fix preserves existing decimal, PostgreSQL, boolean, float and HTTP contracts', () => {
  for (const dialect of ['mysql', 'postgres'] as const) {
    for (const type of ['NUMERIC', 'DECIMAL(20, 2)']) assert.equal(row(dialect, type), '  item: { value: string };');
  }
  for (const type of ['int8', 'bigint', 'bigserial', 'money']) assert.equal(row('postgres', type), '  item: { value: string };');
  assert.equal(row('postgres', 'integer'), '  item: { value: number };');
  assert.equal(row('http', 'bigint'), '  item: { value: number | string };');
  for (const dialect of ['sqlite', 'mysql', 'postgres'] as const) {
    assert.equal(row(dialect, 'boolean', true), '  item: { value: boolean | null };');
    assert.equal(row(dialect, 'double'), '  item: { value: number };');
  }
});
