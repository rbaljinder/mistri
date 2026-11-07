/**
 * The second line that tells two records of one name apart (referenceSubline.ts), wherever a reference is chosen or
 * shown: the App's display subtitle, else a unique code, an email, the parent by name, the day it was made — and the
 * aside card that reads it beside the name (pageAnatomy.ts).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collidingNames, referenceSubline, sublineText } from '../packages/engine/src/shared/referenceSubline.js';
import { recordAnatomy } from '../packages/engine/src/shared/pageAnatomy.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const key = (name: string) => column(name, 'INTEGER', { primaryKey: true, nullable: false });
const table = (id: string, columns: ReturnType<typeof column>[], extra: Partial<TableMeta> = {}): TableMeta =>
  ({ id, name: id, schema: '', isView: false, columns, ...extra }) as TableMeta;

const account = table('account', [key('id'), column('name', 'TEXT', { nullable: false }), column('city', 'TEXT')]);
const customer = table(
  'customer',
  [
    key('id'),
    column('name', 'TEXT', { nullable: false }),
    column('customer_number', 'TEXT'),
    column('email', 'TEXT'),
    column('account_id', 'INTEGER', { nullable: false, references: { table: 'account', column: 'id' } }),
    column('created_at', 'TIMESTAMP'),
    column('status', 'TEXT'),
    column('phone', 'TEXT'),
  ],
  { unique: ['customer_number'] },
);
const fk = (from: string, column: string, to: string) => ({
  name: `${from}_${column}`,
  from: { table: from, columns: [column] },
  to: { table: to, columns: ['id'] },
});
const schema = {
  label: 'Desk',
  dialect: 'sqlite',
  readAt: '',
  tables: [account, customer],
  foreignKeys: [fk('customer', 'account_id', 'account')],
} as unknown as DatabaseSchema;
const without = (t: TableMeta, ...names: string[]) => ({ ...t, columns: t.columns.filter((c) => !names.includes(c.name)) });

test('the order: the App’s subtitle, a unique code, an email, the parent by name, the day it was made', () => {
  assert.deepEqual(referenceSubline(schema, customer, 'name', { name: { subtitle: 'phone' } }), { path: 'phone', declared: true });
  assert.deepEqual(referenceSubline(schema, customer, 'name'), { path: 'customer_number', declared: false });
  // A code the catalog does not prove unique quotes nothing: two rows may share it.
  assert.deepEqual(referenceSubline(schema, { ...customer, unique: [] }, 'name'), { path: 'email', declared: false });
  assert.deepEqual(referenceSubline(schema, without(customer, 'email', 'customer_number'), 'name'), {
    path: 'account_id.name',
    declared: false,
  });
  assert.deepEqual(referenceSubline(schema, without(customer, 'email', 'customer_number', 'account_id'), 'name'), {
    path: 'created_at',
    declared: false,
  });
  assert.equal(referenceSubline(schema, account, 'name'), undefined, 'nothing tells two accounts apart better than their key');
  // A subtitle naming a column the table lacks, or the name itself, is not a second line.
  assert.deepEqual(referenceSubline(schema, customer, 'name', { name: { subtitle: 'nope' } }), {
    path: 'customer_number',
    declared: false,
  });
});

test('a second line is drawn where names collide, and a timestamp is said by its day', () => {
  assert.deepEqual([...collidingNames(['Ana Silva', 'Bo Chen', 'Ana Silva', 'Cy'])], ['Ana Silva']);
  assert.equal(collidingNames(['Ana', 'Bo']).size, 0);
  assert.equal(sublineText('2026-11-06T09:30:00.000Z'), '2026-11-06');
  assert.equal(sublineText('ana@north.example'), 'ana@north.example');
  assert.equal(sublineText(''), undefined);
  assert.equal(sublineText(null), undefined);
});

test('an aside card reads what tells its record apart beside the name', () => {
  const visit = table('visit', [
    key('id'),
    column('summary', 'TEXT', { nullable: false }),
    column('customer_id', 'INTEGER', { nullable: false, references: { table: 'customer', column: 'id' } }),
  ]);
  const note = table('visit_note', [
    key('id'),
    column('body', 'TEXT'),
    column('visit_id', 'INTEGER', { nullable: false, references: { table: 'visit', column: 'id' } }),
  ]);
  const withVisit = {
    ...schema,
    tables: [...schema.tables, visit, note],
    foreignKeys: [...schema.foreignKeys, fk('visit', 'customer_id', 'customer'), fk('visit_note', 'visit_id', 'visit')],
  } as DatabaseSchema;
  const card = recordAnatomy(withVisit, 'visit')?.parent;
  assert.ok(card);
  // Its state first, then the code that tells two of one name apart, where the first readable field stood before.
  assert.deepEqual(card.paths, ['customer_id', 'customer_id.status', 'customer_id.customer_number']);
});
