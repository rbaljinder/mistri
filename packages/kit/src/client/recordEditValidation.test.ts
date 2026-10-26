import { expect, test } from 'vitest';
import type { ColumnMeta, TableMeta } from '../../../engine/src/shared/schema.js';
import { validateRecordEdits } from './recordEditValidation.js';

const field = (name: string, other: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  type: 'TEXT',
  nullable: false,
  primaryKey: false,
  ...other,
});
const table: TableMeta = {
  id: 'task',
  name: 'Task',
  schema: '',
  isView: false,
  columns: [
    field('id', { type: 'INTEGER', primaryKey: true, identity: 'by-default' }),
    field('name'),
    field('status', { default: "'open'", allowed: ['open', 'done'] }),
    field('due_on', { type: 'DATE', nullable: true }),
    field('assignee', { nullable: true, references: { table: 'staff', column: 'id' } }),
  ],
};

test('untouched required fields are not re-required during an update', () => {
  expect(validateRecordEdits(table, {})).toEqual({});
  expect(validateRecordEdits(table, { name: 'Plan the week' })).toEqual({});
});

test.each([null, ''])('clearing a required existing value to %s cannot use creation defaults', (value) => {
  expect(validateRecordEdits(table, { status: value, id: value, name: value })).toEqual({
    id: 'Required',
    name: 'Required',
    status: 'Required',
  });
  const privateDefault = { ...table, columns: [field('name', { hasDefault: true })] };
  expect(validateRecordEdits(privateDefault, { name: value })).toEqual({ name: 'Required' });
});

test('nullable explicit clears are valid without changing their submitted representation', () => {
  const values = Object.freeze({ due_on: null, assignee: '' });
  expect(validateRecordEdits(table, values)).toEqual({});
  expect(values).toEqual({ due_on: null, assignee: '' });
});

test('vocabulary is checked without guessing SQL constraints or coercing values', () => {
  expect(validateRecordEdits(table, { status: 'done' })).toEqual({});
  expect(validateRecordEdits(table, { status: 'Done' })).toEqual({ status: 'Choose one of the available values.' });
  const limited = { ...table, columns: [field('value', { nullable: true, allowed: ['0', 'false'] })] };
  expect(validateRecordEdits(limited, { value: 0 })).toEqual({});
  expect(validateRecordEdits(limited, { value: false })).toEqual({});
  expect(validateRecordEdits(limited, { value: null })).toEqual({});
  expect(validateRecordEdits(limited, { value: '' })).toEqual({ value: 'Choose one of the available values.' });
});

test('unresolved picker text blocks another staged field without staging a replacement ID', () => {
  const values = Object.freeze({ name: 'New name' });
  expect(validateRecordEdits(table, values, { assignee: { unresolvedReference: true } })).toEqual({
    assignee: 'Choose a record or clear the field.',
  });
  expect(Object.keys(values)).toEqual(['name']);
  expect(validateRecordEdits(table, values, { assignee: { unresolvedReference: false } })).toEqual({});
});

test('native bad input cannot masquerade as a nullable date clear', () => {
  expect(validateRecordEdits(table, { due_on: null }, { due_on: { invalidInput: true } })).toEqual({ due_on: 'Enter a valid value.' });
  expect(validateRecordEdits(table, { due_on: null }, { due_on: { invalidInput: false } })).toEqual({});
});

test('reports every invalid field once in catalog order without modifying the snapshot', () => {
  const values = Object.freeze({ due_on: null, status: 'other', name: '' });
  const controls = Object.freeze({ due_on: Object.freeze({ invalidInput: true }), name: Object.freeze({ invalidInput: true }) });
  const errors = validateRecordEdits(table, values, controls);
  expect(Object.keys(errors)).toEqual(['name', 'status', 'due_on']);
  expect(errors.name).toBe('Enter a valid value.');
  expect(Object.isFrozen(errors)).toBe(true);
  expect(values.name).toBe('');
});

test('missing or no-longer-editable fields refuse instead of disappearing from a partial save', () => {
  const denied = { ...table, columns: table.columns.map((column) => ({ ...column, writable: false })) };
  expect(validateRecordEdits(denied, { name: 'Draft' })).toEqual({ name: 'This field is no longer editable.' });
  expect(validateRecordEdits(table, { removed: 'Draft' })).toEqual({ removed: 'This field is no longer editable.' });
  expect(validateRecordEdits({ ...table, isView: true }, { name: 'Draft' })).toEqual({ name: 'This field is no longer editable.' });
});

test.each([undefined, NaN, Infinity, {}, [], 1n])('unsupported staged scalar %s is not stringified into an accepted value', (value) => {
  expect(validateRecordEdits(table, { name: value })).toEqual({ name: 'Enter a valid value.' });
});

test('large IDs and decimal text are kept exact; browser validation does not parse numbers', () => {
  const values = Object.freeze({ id: '90071992547409931234', name: '000123.4500', assignee: '90071992547409931235' });
  expect(validateRecordEdits(table, values)).toEqual({});
  expect(values.assignee).toBe('90071992547409931235');
});

test('column names cannot mutate the validation map prototype', () => {
  const unusual = { ...table, columns: [field('__proto__'), field('constructor')] };
  const values = Object.fromEntries([
    ['__proto__', null],
    ['constructor', null],
  ]);
  const errors = validateRecordEdits(unusual, values);
  expect(Object.keys(errors)).toEqual(['__proto__', 'constructor']);
  expect(Object.getPrototypeOf(errors)).toBeNull();
  expect(errors.__proto__).toBe('Required');
});
