import { expect, test } from 'vitest';
import { appColumnLabel } from './appLabels.js';
import type { DatabaseSchema, TableMeta } from '../../../engine/src/shared/schema.js';

const table = (id: string, names: string[]): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: names.map((name) => ({ name, type: 'TEXT', nullable: true, primaryKey: name === 'id' })),
});
const order = table('work_order', ['id', 'reference', 'assigned_to', 'customer_id', 'external_id']);
order.columns[2].references = { table: 'employee', column: 'id' };
order.columns[3].references = { table: 'customer', column: 'id' };
const schema: DatabaseSchema = {
  label: 'demo',
  dialect: 'sqlite',
  readAt: '',
  tables: [order, table('employee', ['id', 'name']), table('customer', ['id', 'name', 'country_code'])],
  foreignKeys: [
    { name: 'assigned', from: { table: 'work_order', columns: ['assigned_to'] }, to: { table: 'employee', columns: ['id'] } },
    { name: 'customer', from: { table: 'work_order', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
  ],
};
/* The captions the resources give, by table id, as /api/app serves them. */
const resources = {
  work_order: { labels: { assigned_to: 'Engineer' } },
  customer: { labels: { country_code: 'Country' } },
};
const label = (path: string, context = '') => appColumnLabel(resources, schema, 'work_order', path, context);

test('explicit relationship labels win over derived names on the key and joined identity', () => {
  expect(label('assigned_to')).toBe('Engineer');
  expect(label('assigned_to.name')).toBe('Engineer');
  expect(label('customer_id')).toBe('Customer');
  expect(label('external_id')).toBe('External ID');
});

test('related fields inherit their owning table labels and retain section context', () => {
  expect(label('customer_id.name')).toBe('Customer');
  expect(label('customer_id.country_code')).toBe('Country');
  expect(label('customer_id.name', 'customer_id')).toBe('Name');
  expect(label('customer_id.country_code', 'customer_id')).toBe('Country');
  const custom = { ...resources, work_order: { labels: { ...resources.work_order.labels, 'customer_id.name': 'Billing customer' } } };
  expect(appColumnLabel(custom, schema, 'work_order', 'customer_id.name', 'customer_id')).toBe('Billing customer');
});

test('missing schema and unresolvable paths use a readable fallback, not a guessed relationship', () => {
  expect(appColumnLabel(resources, null, 'work_order', 'customer_id')).toBe('Customer ID');
  expect(label('missing_id.name')).toBe('Name');
  expect(label('customer_id.country_code', 'missing_id')).toBe('Country');
  const composite = {
    ...schema,
    foreignKeys: schema.foreignKeys.map((fk) => ({ ...fk, from: { ...fk.from, columns: [...fk.from.columns, 'tenant_id'] } })),
  };
  expect(appColumnLabel(resources, composite, 'work_order', 'customer_id.name')).toBe('Name');
});

test("the resource's caption is the app-wide word, and an exact dotted caption takes precedence", () => {
  expect(
    appColumnLabel(
      { work_order: { labels: { 'assigned_to.name': 'Assignee', assigned_to: 'Engineer' } } },
      schema,
      'work_order',
      'assigned_to.name',
    ),
  ).toBe('Assignee');
  expect(
    appColumnLabel(
      { work_order: { labels: { 'assigned_to.name': 'Assignee', assigned_to: 'Engineer' } } },
      schema,
      'work_order',
      'assigned_to',
    ),
  ).toBe('Engineer');
  /* A caption on no path of this table, or a resource with none, says nothing. */
  expect(appColumnLabel({ work_order: {} }, schema, 'work_order', 'reference')).toBe('Reference');
});

test('a form reference inherits the label authored for its joined identity, never an unrelated field', () => {
  const projected = { work_order: { labels: { 'assigned_to.name': 'Rep', 'customer_id.country_code': 'Billing country' } } };
  expect(appColumnLabel(projected, schema, 'work_order', 'assigned_to')).toBe('Rep');
  expect(appColumnLabel(projected, schema, 'work_order', 'customer_id')).toBe('Customer');
  expect(
    appColumnLabel(
      { work_order: { labels: { ...projected.work_order.labels, assigned_to: 'Engineer' } } },
      schema,
      'work_order',
      'assigned_to',
    ),
  ).toBe('Engineer');
});

test('a name borrowed from Object.prototype is never a caption or a resource', () => {
  expect(appColumnLabel({}, schema, 'constructor', 'toString')).toBe('To string');
  expect(appColumnLabel({ work_order: { labels: {} } }, schema, 'work_order', 'constructor')).toBe('Constructor');
});

test('a projected record name is not labeled as a natural-key code', () => {
  const item = table('line_item', ['id', 'product_sku']);
  item.columns[1].references = { table: 'product', column: 'sku' };
  const data: DatabaseSchema = {
    ...schema,
    tables: [...schema.tables, item, table('product', ['sku', 'name'])],
    foreignKeys: [
      ...schema.foreignKeys,
      { name: 'product', from: { table: 'line_item', columns: ['product_sku'] }, to: { table: 'product', columns: ['sku'] } },
    ],
  };
  expect(appColumnLabel({}, data, 'line_item', 'product_sku.name')).toBe('Product');
  expect(appColumnLabel({}, data, 'line_item', 'product_sku')).toBe('Product SKU');
});
