/**
 * After `mistri check` rewrites `mistri-schema.d.ts`, the columns the migration took are said once each, and a column
 * gone beside one of its own type arrived on the same table is said as a possible rename.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { schemaChanges } from '../packages/mistri/src/server/build/schemaChanges.js';
import { typesForSchema } from '../packages/mistri/src/server/typegen.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string) => ({ name, type, nullable: false, primaryKey: name === 'id' });
const schema = (orders: Array<[string, string]>, more: string[] = []): DatabaseSchema =>
  ({
    label: 'shop',
    dialect: 'sqlite',
    readAt: '2026-11-04T00:00:00Z',
    tables: [
      { id: 'orders', name: 'orders', schema: 'main', columns: [column('id', 'INTEGER'), ...orders.map(([n, t]) => column(n, t))] },
      ...more.map((id) => ({ id, name: id, schema: 'main', columns: [column('id', 'INTEGER')] })),
    ],
    foreignKeys: [],
  }) as unknown as DatabaseSchema;
const types = (orders: Array<[string, string]>, more: string[] = []) => typesForSchema(schema(orders, more));

test('one column gone and one of its type arrived is a possible rename', () => {
  const said = schemaChanges(
    types([
      ['reference_id', 'INTEGER'],
      ['note', 'TEXT'],
    ]),
    types([
      ['submission_id', 'INTEGER'],
      ['note', 'TEXT'],
    ]),
  );
  assert.equal(said.length, 1);
  assert.match(said[0], /^possibly renamed orders\.reference_id → orders\.submission_id/);
});

test('a column gone with nothing of its type arriving is removed', () => {
  assert.deepEqual(
    schemaChanges(
      types([
        ['legacy_code', 'TEXT'],
        ['note', 'TEXT'],
      ]),
      types([['note', 'TEXT']]),
    ),
    ['removed orders.legacy_code'],
  );
  // A different type is not a rename.
  assert.deepEqual(schemaChanges(types([['legacy_code', 'TEXT']]), types([['total', 'INTEGER']])), ['removed orders.legacy_code']);
  // Two gone and one arrived is not a guess either.
  assert.deepEqual(
    schemaChanges(
      types([
        ['a', 'TEXT'],
        ['b', 'TEXT'],
      ]),
      types([['c', 'TEXT']]),
    ),
    ['removed orders.a', 'removed orders.b'],
  );
});

test('a removed table is said, an added column or table is not', () => {
  assert.deepEqual(schemaChanges(types([], ['extra']), types([])), ['removed table extra']);
  assert.deepEqual(schemaChanges(types([]), types([['fresh', 'TEXT']], ['more'])), []);
});
