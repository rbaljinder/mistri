/**
 * Comparing two shapes.
 *
 * The reason this exists rather than `diff <(pg_dump -s a) <(pg_dump -s b)`:
 * a dump diff reports every difference in formatting as loudly as the missing
 * column, and a column that quietly became nullable looks the same as one
 * whose comment moved. So the tests are mostly about what is *not* a
 * difference.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diffReport, diffSchemas } from '../packages/tablewalk/src/shared/diff.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema = (over: Partial<DatabaseSchema> = {}): DatabaseSchema => ({
  label: 'left',
  dialect: 'postgres',
  readAt: '2026-08-23T00:00:00.000Z',
  tables: [],
  foreignKeys: [],
  ...over,
});

const customer = (columns: Array<Record<string, unknown>>) =>
  ({
    name: 'customer',
    schema: '',
    id: 'customer',
    isView: false,
    columns: columns.map((c) => ({ nullable: true, primaryKey: false, type: 'text', ...c })),
  }) as never;

describe('two schemas that are the same', () => {
  test('are reported as the same, whatever order they list things in', () => {
    const left = schema({ tables: [customer([{ name: 'id', type: 'integer', primaryKey: true }, { name: 'name' }])] });
    const right = schema({
      label: 'right',
      tables: [customer([{ name: 'id', type: 'integer', primaryKey: true }, { name: 'name' }])],
    });
    const diff = diffSchemas(left, right);
    assert.equal(diff.same, true);
    assert.match(diffReport(diff), /have the same shape/);
  });

  test('and a table read at a different time is not a difference', () => {
    const left = schema({ tables: [customer([{ name: 'id' }])] });
    const right = schema({ tables: [customer([{ name: 'id' }])], readAt: '2020-01-01T00:00:00.000Z' });
    assert.equal(diffSchemas(left, right).same, true);
  });
});

describe('the differences that matter', () => {
  const before = schema({
    label: 'production',
    tables: [
      customer([
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'email' },
        { name: 'status', allowed: ['open', 'closed'] },
        { name: 'total', type: 'numeric', nullable: false },
      ]),
    ],
    foreignKeys: [
      {
        name: 'fk',
        from: { table: 'customer', columns: ['country_code'] },
        to: { table: 'country', columns: ['code'] },
        onDelete: 'restrict',
      },
    ],
  });

  const after = schema({
    label: 'staging',
    tables: [
      customer([
        { name: 'id', type: 'integer', primaryKey: true },
        { name: 'status', allowed: ['open', 'closed', 'archived'] },
        { name: 'total', type: 'numeric', nullable: true },
        { name: 'tier' },
      ]),
      { name: 'audit', schema: '', id: 'audit', isView: false, columns: [] } as never,
    ],
    foreignKeys: [
      {
        name: 'fk',
        from: { table: 'customer', columns: ['country_code'] },
        to: { table: 'country', columns: ['code'] },
        onDelete: 'cascade',
      },
    ],
  });

  const diff = diffSchemas(before, after);
  const forCustomer = diff.tables.find((t) => t.table === 'customer')!;

  test('name the side each one is missing from, not just "differs"', () => {
    assert.deepEqual(forCustomer.columnsOnlyLeft, ['email']);
    assert.deepEqual(forCustomer.columnsOnlyRight, ['tier']);
    assert.equal(diff.tables.find((t) => t.table === 'audit')?.onlyIn, 'right');
  });

  test('include a column that quietly became nullable', () => {
    const nullable = forCustomer.changed!.find((c) => c.column === 'total' && c.what === 'nullable');
    assert.deepEqual({ left: nullable!.left, right: nullable!.right }, { left: 'false', right: 'true' });
  });

  test('include a vocabulary that gained a value', () => {
    const allowed = forCustomer.changed!.find((c) => c.what === 'allowed');
    assert.match(allowed!.right, /archived/);
  });

  test('include a delete rule that now does something else', () => {
    /* The key still exists, so "which keys are there" says nothing — and the
       difference is between a refused delete and a cascade. */
    assert.deepEqual(forCustomer.deleteRuleChanged, [
      {
        key: 'country_code → country(code)',
        left: 'restrict',
        right: 'cascade',
      },
    ]);
  });

  test('read as a document that says which way round it is', () => {
    const text = diffReport(diff);
    assert.match(text, /# production → staging/);
    assert.match(text, /"Only in production" means it is missing from staging/);
    assert.match(text, /`total` nullable: \*\*false\*\* → \*\*true\*\*/);
  });
});
