import { expect, test } from 'vitest';
import type { DatabaseSchema, TableMeta } from '../../../../engine/src/shared/schema.js';
import { presentationColumns } from './columnPresentation.js';

const account: TableMeta = {
  id: 'account',
  name: 'account',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'active', type: 'BOOLEAN', nullable: false, primaryKey: false },
  ],
};
const contact: TableMeta = {
  id: 'contact',
  name: 'contact',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'account_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'account', column: 'id' } },
  ],
};
const schema: DatabaseSchema = {
  label: 'Test',
  dialect: 'sqlite',
  readAt: '',
  tables: [contact, account],
  foreignKeys: [
    { name: 'contact_account', from: { table: 'contact', columns: ['account_id'] }, to: { table: 'account', columns: ['id'] } },
  ],
};

test('joined fields use catalog types and remain nullable non-key outputs', () => {
  const before = structuredClone(schema);
  const columns = presentationColumns(schema, contact, ['id', 'account_id.active', 'account_id.id']);
  expect(columns.get('id')).toBe(contact.columns[0]);
  expect(columns.get('account_id.active')).toEqual({
    name: 'account_id.active',
    sourceName: 'active',
    identifier: false,
    type: 'BOOLEAN',
    nullable: true,
    primaryKey: false,
  });
  expect(columns.get('account_id.id')?.primaryKey).toBe(false);
  expect(columns.get('account_id.id')?.identifier).toBe(true);
  expect(schema).toEqual(before);
});

test('constraint paths use the shared resolver; unknown aliases do not invent metadata', () => {
  const columns = presentationColumns(schema, contact, ['contact_account.active', 'report.total', 'unknown']);
  expect(columns.get('contact_account.active')?.type).toBe('BOOLEAN');
  expect(columns.has('report.total')).toBe(false);
  expect(columns.has('unknown')).toBe(false);
  expect(presentationColumns(undefined, contact, ['account_id.active']).size).toBe(2);
});
