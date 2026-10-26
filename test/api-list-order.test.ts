import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveApiListOrder } from '../packages/mistri/src/server/api/apiListOrder.js';
import type { TableMeta } from '../packages/engine/src/shared/schema.js';

const table = (): TableMeta => ({
  id: 'item',
  name: 'item',
  schema: '',
  isView: false,
  columns: ['tenant', 'id', 'status', 'updated_at'].map((name) => ({
    name,
    type: name === 'id' ? 'INTEGER' : 'TEXT',
    primaryKey: name === 'tenant' || name === 'id',
    nullable: false,
  })),
});
const exposure = { fields: ['tenant', 'id', 'status', 'updated_at'], sorts: ['status', 'id'] };

test('duplicate sort values receive all composite key tie breakers ascending', () => {
  const result = resolveApiListOrder(table(), exposure, [{ field: 'status', descending: true }]);
  assert.deepEqual(result.order, [
    { column: 'status', direction: 'desc' },
    { column: 'tenant', direction: 'asc' },
    { column: 'id', direction: 'asc' },
  ]);
  assert.equal(result.stage, 'total-order');
  assert.equal(result.source, 'request');
  assert.equal(result.cursorValidation, 'pending');
  assert.ok(Object.isFrozen(result.order) && result.order.every(Object.isFrozen));
  const rows = [
    { tenant: 'a', id: 2, status: 'open' },
    { tenant: 'b', id: 1, status: 'open' },
    { tenant: 'a', id: 1, status: 'open' },
  ];
  rows.sort((a, b) => {
    for (const { column, direction } of result.order) {
      const left = a[column as keyof typeof a],
        right = b[column as keyof typeof b];
      const difference = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
      if (difference) return direction === 'desc' ? -difference : difference;
    }
    return 0;
  });
  assert.deepEqual(
    rows.map((row) => `${row.tenant}:${row.id}`),
    ['a:1', 'a:2', 'b:1'],
  );
});

test('requested key directions remain untouched and only missing key pieces append', () => {
  assert.deepEqual(resolveApiListOrder(table(), exposure, [{ field: 'id', descending: true }]).order, [
    { column: 'id', direction: 'desc' },
    { column: 'tenant', direction: 'asc' },
  ]);
});

test('standing and shared default rules are reused without a new fallback heuristic', () => {
  const t = table();
  assert.deepEqual(resolveApiListOrder(t, exposure).order, [
    { column: 'tenant', direction: 'asc' },
    { column: 'id', direction: 'asc' },
  ]);
  t.columns[0].primaryKey = false;
  assert.deepEqual(resolveApiListOrder(t, exposure).order, [{ column: 'id', direction: 'desc' }]);
  const result = resolveApiListOrder(t, exposure, [], [{ column: 'status', direction: 'asc' }]);
  assert.equal(result.source, 'standing');
  assert.deepEqual(result.order, [
    { column: 'status', direction: 'asc' },
    { column: 'id', direction: 'asc' },
  ]);
});

test('incomplete keys, nullable keys, joined sorts and undeclared request sorts refuse', () => {
  assert.throws(() => resolveApiListOrder(table(), { ...exposure, fields: ['id', 'status'] }), /projection/);
  const nullable = table();
  nullable.columns[0].nullable = true;
  assert.throws(() => resolveApiListOrder(nullable, exposure), /nonnullable/);
  const keyless = table();
  keyless.columns.forEach((column) => {
    column.primaryKey = false;
  });
  assert.throws(() => resolveApiListOrder(keyless, exposure), /primary key/);
  for (const field of ['owner.name', 'updated_at'])
    assert.throws(() => resolveApiListOrder(table(), exposure, [{ field, descending: false }]));
  assert.throws(
    () =>
      resolveApiListOrder(table(), exposure, [
        { field: 'id', descending: true },
        { field: 'id', descending: false },
      ]),
    /duplicate/,
  );
});

test('implicit indexed order cannot escape the sparse projection; a nullable sort may lead but never the key', () => {
  const t = table();
  t.columns[3].type = 'TIMESTAMP';
  t.indexed = ['updated_at'];
  assert.throws(() => resolveApiListOrder(t, { ...exposure, fields: ['tenant', 'id', 'status'] }), /projection/);
  t.columns[3].nullable = true;
  assert.equal(resolveApiListOrder(t, exposure).order[0].column, 'updated_at');
  t.columns.find((column) => column.name === 'id')!.nullable = true;
  assert.throws(() => resolveApiListOrder(t, exposure), /the key nonnullable/);
});
