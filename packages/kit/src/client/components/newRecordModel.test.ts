import { expect, test } from 'vitest';
import { formColumns, hasFormChanges, insertValues, isFormFieldVisible, missingFields, presetValue } from './newRecordModel.js';
import { parseComputed } from '../../../../engine/src/shared/computedParse.js';
import { autoKey } from '../../../../engine/src/shared/form.js';
import type { ColumnMeta, TableMeta } from '../../../../engine/src/shared/schema.js';

const column = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'TEXT',
  nullable: true,
  primaryKey: false,
  ...extra,
});
const table: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    column('id', { type: 'INTEGER', primaryKey: true, nullable: false, identity: 'by-default' }),
    column('name', { nullable: false }),
    column('status', { nullable: false, default: "'new'" }),
    column('active', { type: 'BOOLEAN' }),
    column('amount', { type: 'NUMERIC' }),
    column('note'),
  ],
};

test('the authored field order is respected without mutating the schema or asking for an assigned key', () => {
  expect(formColumns(table, { show: ['note', 'name', 'id', 'note'] }, true).map((c) => c.name)).toEqual(['note', 'name']);
  expect(formColumns(table, { show: ['note', 'id'] }, false).map((c) => c.name)).toEqual(['note', 'id']);
  expect(formColumns(table, { show: [] }, true)).toEqual([]);
  expect(table.columns.map((c) => c.name)).toEqual(['id', 'name', 'status', 'active', 'amount', 'note']);
});

test('steps select fields in step order without a duplicate show list or unrelated catalog fields', () => {
  const steps = [{ id: 'details', label: 'Details', fields: ['note', 'name'] }];
  expect(formColumns(table, { steps }, true).map((column) => column.name)).toEqual(['note', 'name']);
  expect(formColumns(table, { show: ['name', 'note'], steps }, true).map((column) => column.name)).toEqual(['name', 'note']);
  expect(formColumns(table, { show: [], steps }, true)).toEqual([]);
  expect(formColumns(table, { groups: [{ label: 'Details', fields: ['name'] }] }, true).map((column) => column.name)).toEqual([
    'name',
    'status',
    'active',
    'amount',
    'note',
  ]);
});

test('boolean defaults match the control vocabulary and inherited properties never become presets', () => {
  expect(presetValue(table.columns[3], { active: false })).toBe('0');
  expect(presetValue(table.columns[3], { active: true })).toBe('1');
  expect(presetValue(table.columns[3], { active: 'false' })).toBe('0');
  expect(presetValue({ ...table.columns[3], allowed: ['false', 'true'] }, { active: false })).toBe('false');
  expect(presetValue(table.columns[4], { amount: 0 })).toBe('0');
  expect(presetValue(table.columns[1], Object.create({ name: 'inherited' }))).toBe('');
});

test('untouched shown and hidden defaults retain null, false, zero and empty text on the wire', () => {
  const defaults = { active: false, amount: 0, note: null, name: '' };
  expect(insertValues({ active: '0', amount: '0', note: '', name: '' }, defaults, new Set(), table.columns)).toEqual(defaults);
  expect(insertValues({}, defaults, new Set(), table.columns)).toEqual(defaults);
  expect(insertValues({ note: '' }, { note: undefined }, new Set(), table.columns)).toEqual({});
});

test('editing overrides a preset and clearing it delegates to the database, not the old DSL value', () => {
  const defaults = { name: 'Preset', note: null, status: 'working' };
  expect(insertValues({ name: '', note: 'Changed', status: '' }, defaults, new Set(['name', 'note', 'status']), table.columns)).toEqual({
    note: 'Changed',
  });
  expect(missingFields(table.columns, { note: 'Changed' }, autoKey(table)).map((c) => c.name)).toEqual(['name']);
  expect(missingFields(table.columns, { name: 'Ada', status: null }, autoKey(table)).map((c) => c.name)).toEqual(['status']);
  expect(missingFields(table.columns, { name: 'Ada', active: false, amount: 0 }, autoKey(table))).toEqual([]);
});

test('column names are data, including names that match object prototype properties', () => {
  const values = Object.fromEntries([
    ['__proto__', 'kept'],
    ['constructor', 'also kept'],
  ]);
  const result = insertValues(
    values,
    {},
    new Set(Object.keys(values)),
    Object.keys(values).map((name) => column(name)),
  );
  expect(Object.entries(result)).toEqual(Object.entries(values));
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
});

test('discard detection ignores untouched defaults and edits returned to their displayed baseline', () => {
  const defaults = { name: 'Preset', active: false, amount: 0, note: null };
  const values = { name: 'Preset', active: '0', amount: '0', note: '' };
  expect(hasFormChanges(table.columns, values, defaults, new Set())).toBe(false);
  expect(hasFormChanges(table.columns, values, defaults, new Set(['name', 'active', 'amount']))).toBe(false);
  expect(hasFormChanges(table.columns, { ...values, name: '' }, defaults, new Set(['name']))).toBe(true);
  expect(hasFormChanges(table.columns, { ...values, active: '1' }, defaults, new Set(['active']))).toBe(true);
  expect(hasFormChanges(table.columns, { name: '' }, {}, new Set(['name']))).toBe(false);
});

test('clearing an explicit null or empty preset changes the insertion intent even when the display matches', () => {
  for (const note of [null, '']) {
    expect(hasFormChanges(table.columns, { note: '' }, { note }, new Set(['note']))).toBe(true);
  }
  expect(hasFormChanges(table.columns, { note: '' }, { note: undefined }, new Set(['note']))).toBe(false);
  expect(hasFormChanges(table.columns, { note: '' }, Object.create({ note: null }), new Set(['note']))).toBe(false);
});

test('integer type alone never hides a key; identity and declared defaults are separate facts', () => {
  const manual = { ...table, columns: [column('id', { type: 'BIGINT', primaryKey: true, nullable: false }), column('name')] };
  expect(autoKey(manual)).toBeNull();
  expect(formColumns(manual, undefined, true).map((c) => c.name)).toEqual(['id', 'name']);
  expect(missingFields(manual.columns, {}, autoKey(manual)).map((c) => c.name)).toEqual(['id']);
  const uuid = { ...manual, columns: [{ ...manual.columns[0], type: 'uuid', default: 'gen_random_uuid()' }] };
  expect(autoKey(uuid)).toBe('id');
  expect(formColumns(uuid, undefined, true)).toEqual([]);
  expect(formColumns(uuid, undefined, false)).toHaveLength(1);
});

test('a generated component of a composite key is optional without hiding the manual components', () => {
  const composite = {
    ...table,
    columns: [
      column('tenant', { type: 'INTEGER', primaryKey: true, nullable: false }),
      column('id', { type: 'INTEGER', primaryKey: true, nullable: false, identity: 'by-default' }),
    ],
  };
  expect(autoKey(composite)).toBeNull();
  expect(formColumns(composite, undefined, true).map((c) => c.name)).toEqual(['tenant']);
  expect(missingFields(composite.columns, {}, null).map((c) => c.name)).toEqual(['tenant']);
  expect(missingFields(composite.columns, { tenant: 4 }, null)).toEqual([]);
});

test('ALWAYS identities cannot be entered in either form mode, even when explicitly shown', () => {
  const always = { ...table, columns: [column('sequence', { type: 'INTEGER', nullable: false, identity: 'always' })] };
  expect(formColumns(always, { show: ['sequence'] }, true)).toEqual([]);
  expect(formColumns(always, { show: ['sequence'] }, false)).toEqual([]);
  expect(missingFields(always.columns, {}, null)).toEqual([]);
});

test.each([true, false])('field writability bounds curated controls in app mode %s', (app) => {
  const limited = { ...table, columns: [column('name', { writable: true }), column('note'), column('status', { writable: false })] };
  expect(formColumns(limited, { show: ['status', 'note', 'unreadable', 'name'] }, app).map((c) => c.name)).toEqual(['note', 'name']);
});

test('neither hidden defaults nor retained inputs can submit unavailable fields', () => {
  const columns = [column('name', { writable: true }), column('note'), column('status', { writable: false })];
  const defaults = { name: 'Preset', note: null, status: 'privileged', unreadable: 'hidden' };
  expect(insertValues({}, defaults, new Set(), columns)).toEqual({ name: 'Preset', note: null });
  expect(
    insertValues({ name: 'Changed', status: 'stale', unreadable: 'stale' }, defaults, new Set(['name', 'status', 'unreadable']), columns),
  ).toEqual({ name: 'Changed', note: null });
});

test('required read-only fields never become editable obligations', () => {
  const columns = [
    column('required', { nullable: false, writable: false }),
    column('defaulted', { nullable: false, default: "'new'", writable: false }),
    column('name', { nullable: false, writable: true }),
  ];
  expect(missingFields(columns, {}, null).map((c) => c.name)).toEqual(['name']);
  expect(missingFields(columns, { name: 'Ada', required: null }, null)).toEqual([]);
});

test('private default expressions can be omitted without turning database-filled fields into requirements', () => {
  const projected = {
    ...table,
    columns: [
      column('id', { primaryKey: true, nullable: false, hasDefault: true }),
      column('name', { nullable: false }),
      column('status', { nullable: false, hasDefault: true }),
    ],
  };
  expect(autoKey(projected)).toBe('id');
  expect(formColumns(projected, undefined, true).map((c) => c.name)).toEqual(['name', 'status']);
  expect(missingFields(projected.columns, {}, autoKey(projected)).map((c) => c.name)).toEqual(['name']);
  expect(missingFields(projected.columns, { name: 'North' }, autoKey(projected))).toEqual([]);
  expect(missingFields(projected.columns, { name: 'North', status: null }, autoKey(projected)).map((c) => c.name)).toEqual(['status']);
  expect(insertValues({ name: 'North', status: '' }, {}, new Set(['name']), projected.columns)).toEqual({ name: 'North' });
  expect(projected.columns.every((c) => c.default === undefined)).toBe(true);
});

test('a column the App moves only through its actions is left to the form default', () => {
  const col = (name: string, extra: Partial<ColumnMeta> = {}): ColumnMeta => ({
    name,
    type: 'TEXT',
    nullable: true,
    primaryKey: false,
    ...extra,
  });
  const issue = {
    id: 'issue',
    name: 'issue',
    schema: '',
    isView: false,
    columns: [
      col('id', { type: 'INTEGER', primaryKey: true, nullable: false, identity: 'by-default' }),
      col('name'),
      col('status', { changesBy: 'actions' }),
    ],
  } as TableMeta;
  expect(formColumns(issue, { show: ['name', 'status'] }, true).map((c) => c.name)).toEqual(['name']);
  expect(formColumns(issue, undefined, true).map((c) => c.name)).toEqual(['name']);
});

test("a field's when over a computed column is worked out from the draft", () => {
  const priced: TableMeta = {
    ...table,
    columns: [...table.columns, column('price', { type: 'NUMERIC' })],
    computed: { total: { expr: parseComputed('amount * price', () => true), type: 'number', reads: ['amount', 'price'] } },
  };
  const form = { when: { note: 'total > 100' } };
  const note = priced.columns.find((c) => c.name === 'note')!;
  expect(isFormFieldVisible(form, note, { amount: '20', price: '10' }, priced)).toBe(true);
  expect(isFormFieldVisible(form, note, { amount: '2', price: '10' }, priced)).toBe(false);
  // Nothing typed yet: unknown, so the field stays where the person can see it.
  expect(isFormFieldVisible(form, note, {}, priced)).toBe(true);
});
