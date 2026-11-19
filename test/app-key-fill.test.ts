/**
 * Which text keys a tenant App's store fills (`fillsKey`, appKeyFill.ts): a tenant-owned resource whose single text key
 * nothing in the catalog fills and that its `address` does not name. Everything else fills nothing.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appAssignedKey } from '../packages/engine/src/shared/form.js';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { withFillsKeys } from '../packages/mistri/src/shared/appKeyFill.js';

const column = (name: string, type: string, extra: Partial<ColumnMeta> = {}): ColumnMeta =>
  ({ name, type, nullable: false, primaryKey: false, ...extra }) as ColumnMeta;
const table = (id: string, key: ColumnMeta): TableMeta =>
  ({ id, name: id, schema: '', isView: false, columns: [key, column('note', 'text')] }) as TableMeta;
const schema = {
  label: 'x',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    table('ticket', column('id', 'text', { primaryKey: true })),
    table('code', column('id', 'text', { primaryKey: true })),
    table('shared', column('id', 'text', { primaryKey: true })),
    table('number', column('id', 'integer', { primaryKey: true })),
    table('short', column('id', 'varchar(12)', { primaryKey: true })),
  ],
} as unknown as DatabaseSchema;
const marked = (app: Parameters<typeof withFillsKeys>[0]) =>
  Object.fromEntries(withFillsKeys(app, schema).tables.map((each) => [each.id, appAssignedKey(each)]));

test('a tenant-owned table with a text key fills it; a global one, an address key, an integer key and a short one do not', () => {
  const app = {
    resources: {
      ticket: { owner: 'tenant' },
      code: { owner: 'tenant', address: 'id' },
      shared: { owner: 'global' },
      number: { owner: 'tenant' },
      short: { owner: 'tenant' },
    },
  } as Parameters<typeof withFillsKeys>[0];
  assert.deepEqual(marked(app), { ticket: 'id', code: null, shared: null, number: null, short: null });
});

test('an App with no tenant-owned resource fills no key', () => {
  const app = { resources: { ticket: {}, code: { owner: 'platform' } } } as Parameters<typeof withFillsKeys>[0];
  assert.deepEqual(Object.values(marked(app)), [null, null, null, null, null]);
});
