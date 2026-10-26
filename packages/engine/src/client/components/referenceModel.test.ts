import { describe, expect, test } from 'vitest';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '../../shared/schema.js';
import {
  recordView,
  recordViewKey,
  recordViewLabel,
  referenceProjection,
  referenceView,
  withoutParentName,
} from '../../shared/referenceModel.js';

const col = (name: string, references?: ColumnMeta['references']): ColumnMeta => ({
  name,
  type: 'TEXT',
  nullable: true,
  primaryKey: name === 'id',
  ...(references ? { references } : {}),
});
const target: TableMeta = { id: 'account', name: 'account', schema: '', isView: false, columns: [col('id'), col('name')] };
const table: TableMeta = {
  id: 'contact',
  name: 'contact',
  schema: '',
  isView: false,
  columns: [col('id'), col('name'), col('account_id', { table: 'account', column: 'id' })],
};
const schema: DatabaseSchema = { label: 'Test', dialect: 'sqlite', readAt: '', tables: [table, target], foreignKeys: [] };

describe('record navigation projection', () => {
  test('fetches omitted authorized keys without changing authored columns or filters', () => {
    const view = { columns: [{ path: 'name' }], limit: 6, filter: { groups: [[{ path: 'account_id', op: '=', value: 'parent' }]] } };
    const before = structuredClone(view);
    const result = recordView(schema, table, view, false);
    expect(result.view.columns).toEqual([{ path: 'name' }, { path: 'id', alias: '__tw_key_0' }]);
    expect(result.hidden).toEqual(['__tw_key_0']);
    expect(result.view.filter).toBe(view.filter);
    expect(view).toEqual(before);
    expect(recordViewKey(result.keyColumns, ['name', '__tw_key_0'], { name: 'Contact', __tw_key_0: '9007199254740993' })).toEqual({
      id: '9007199254740993',
    });
  });

  test('reuses an aliased key and preserves composite key values exactly', () => {
    const composite = { ...table, columns: [...table.columns, { ...col('tenant_id'), primaryKey: true }] };
    const result = recordView(schema, composite, { columns: [{ path: 'id', alias: 'Record' }, { path: 'name' }] }, false);
    expect(result.view.columns).toEqual([{ path: 'id', alias: 'Record' }, { path: 'name' }, { path: 'tenant_id', alias: '__tw_key_1' }]);
    expect(
      recordViewKey(result.keyColumns, ['Record', 'name', '__tw_key_1'], { Record: '0007', name: 'Contact', __tw_key_1: 'north' }),
    ).toEqual({ id: '0007', tenant_id: 'north' });
    expect(recordViewKey(result.keyColumns, ['Record', 'name', '__tw_key_1'], { Record: '0007' })).toBeNull();
  });

  test('keeps reference labels and authored aliases separate from hidden navigation keys', () => {
    const view = {
      columns: [
        { path: 'account_id', alias: 'Account' },
        { path: 'name', alias: '__tw_key_0' },
      ],
    };
    const result = recordView(schema, table, view, true);
    expect(result.labelColumns).toEqual({ Account: '__tw_reference_0' });
    expect(result.hidden).toEqual(['__tw_reference_0', '__tw_key_0_']);
    expect(result.view.columns.at(-1)).toEqual({ path: 'id', alias: '__tw_key_0_' });
    expect(
      recordViewKey(result.keyColumns, ['Account', '__tw_key_0', '__tw_reference_0', '__tw_key_0_'], {
        Account: 'account',
        __tw_key_0: 'Contact',
        __tw_reference_0: 'Acme',
        __tw_key_0_: 'contact-id',
      }),
    ).toEqual({ id: 'contact-id' });
  });

  test('fetches an explicit joined root label in a private collision-free output', () => {
    const result = recordView(
      schema,
      table,
      {
        columns: [
          { path: 'account_id', alias: 'Account' },
          { path: 'name', alias: '__tw_label' },
        ],
      },
      true,
      (target) => (target.id === 'account' ? 'name' : undefined),
      () => 'account_id.name',
    );
    expect(result.view.columns).toEqual([
      { path: 'account_id', alias: 'Account' },
      { path: 'name', alias: '__tw_label' },
      { path: 'account_id.name', alias: '__tw_reference_0' },
      { path: 'account_id.name', alias: '__tw_label_' },
      { path: 'id', alias: '__tw_key_0' },
    ]);
    expect(result.hidden).toEqual(['__tw_reference_0', '__tw_label_', '__tw_key_0']);
    expect(result.labelColumn).toEqual({ path: 'account_id.name', index: 3 });
    expect(
      recordViewLabel(result.labelColumn, ['Account', '__tw_label', '__tw_reference_0', '__tw_label_', '__tw_key_0'], {
        Account: 'acct-7',
        __tw_label: 'An authored value',
        __tw_reference_0: 'Acme',
        __tw_label_: 'Dealer-facing name',
        __tw_key_0: '9007199254740993',
      }),
    ).toEqual({ 'account_id.name': 'Dealer-facing name' });
    expect(
      recordViewKey(result.keyColumns, ['Account', '__tw_label', '__tw_reference_0', '__tw_label_', '__tw_key_0'], {
        Account: 'acct-7',
        __tw_label: 'An authored value',
        __tw_reference_0: 'Acme',
        __tw_label_: 'Dealer-facing name',
        __tw_key_0: '9007199254740993',
      }),
    ).toEqual({ id: '9007199254740993' });
  });

  test('an unavailable explicit root label adds no label output and retains primary-key fallback', () => {
    const result = recordView(schema, table, { columns: [{ path: 'name' }] }, true, undefined, () => undefined);
    expect(result.labelColumn).toBeUndefined();
    expect(result.view.columns).toEqual([{ path: 'name' }, { path: 'id', alias: '__tw_key_0' }]);
    expect(recordViewLabel(result.labelColumn, ['name', '__tw_key_0'], { name: 'Visible name', __tw_key_0: '7' })).toEqual({});
    expect(recordViewKey(result.keyColumns, ['name', '__tw_key_0'], { name: 'Visible name', __tw_key_0: '7' })).toEqual({ id: '7' });
  });

  test('an ambiguous authored output gets its own collision-free key column', () => {
    const result = recordView(
      schema,
      table,
      {
        columns: [
          { path: 'name', alias: 'value' },
          { path: 'id', alias: 'value' },
          { path: 'name', alias: 'value_2' },
        ],
      },
      false,
    );
    expect(result.keyColumns).toEqual([{ column: 'id', index: 3 }]);
    expect(
      recordViewKey(result.keyColumns, ['value', 'value_2', 'value_2', '__tw_key_0'], {
        value: 'Contact',
        value_2: 'Not a key',
        __tw_key_0: 'real-key',
      }),
    ).toEqual({ id: 'real-key' });
  });

  test('keyless tables never gain an invented id and malformed keys cannot navigate', () => {
    const keyless = { ...table, columns: table.columns.map((column) => ({ ...column, primaryKey: false })) };
    const result = recordView(schema, keyless, { columns: [{ path: 'name' }] }, false);
    expect(result.view.columns).toEqual([{ path: 'name' }]);
    expect(result.hidden).toEqual([]);
    expect(recordViewKey(result.keyColumns, ['name'], { name: 'Contact', id: 'fake' })).toBeNull();
    for (const value of [undefined, null, true, Infinity, {}]) {
      expect(recordViewKey([{ column: 'id', index: 0 }], ['key'], { key: value })).toBeNull();
    }
    expect(recordViewKey([{ column: 'id', index: 0 }], ['key', 'key'], { key: 3 })).toBeNull();
  });
});

describe('reference projection', () => {
  test('view labels preserve authored aliases, keys, filters and paging without collisions', () => {
    const view = {
      columns: [{ path: 'id' }, { path: 'account_id', alias: 'Account' }, { path: 'name', alias: '__tw_reference_1' }],
      limit: 12,
      filter: { groups: [[{ path: 'id', op: '=', value: 6 }]] },
    };
    const before = structuredClone(view);
    const result = referenceView(schema, table, view, true);
    expect(result.labelColumns).toEqual({ Account: '__tw_reference_1_' });
    expect(result.hidden).toEqual(['__tw_reference_1_']);
    expect(result.view.columns).toEqual([...view.columns, { path: 'account_id.name', alias: '__tw_reference_1_' }]);
    expect(result.view.filter).toBe(view.filter);
    expect(result.view.limit).toBe(12);
    expect(view).toEqual(before);
    expect(referenceView(schema, table, view, false).view).toBe(view);
  });
  test('joins labels once without changing the visible projection or schema', () => {
    const paths = ['name', 'account_id', 'account_id.name'];
    const before = structuredClone(schema);
    const result = referenceProjection(schema, table, paths, true);
    expect(result.fetched).toEqual(paths);
    expect(result.labels.get('account_id')).toBe('account_id.name');
    expect(paths).toEqual(['name', 'account_id', 'account_id.name']);
    expect(schema).toEqual(before);
  });

  test('a reference reached through another is named one hop further along, within the path limit', () => {
    const department: TableMeta = { id: 'department', name: 'department', schema: '', isView: false, columns: [col('id'), col('name')] };
    const person: TableMeta = {
      id: 'person',
      name: 'person',
      schema: '',
      isView: false,
      columns: [
        col('id'),
        col('name'),
        col('department_id', { table: 'department', column: 'id' }),
        col('manager_id', { table: 'person', column: 'id' }),
      ],
    };
    const hops: DatabaseSchema = {
      ...schema,
      tables: [person, department],
      foreignKeys: [
        { name: 'person_department', from: { table: 'person', columns: ['department_id'] }, to: { table: 'department', columns: ['id'] } },
        { name: 'person_manager', from: { table: 'person', columns: ['manager_id'] }, to: { table: 'person', columns: ['id'] } },
      ],
    };
    const result = referenceProjection(hops, person, ['manager_id.department_id', 'manager_id.name'], true);
    expect(result.labels.get('manager_id.department_id')).toBe('manager_id.department_id.name');
    expect(result.labels.has('manager_id.name')).toBe(false);
    expect(result.fetched).toEqual(['manager_id.department_id', 'manager_id.name', 'manager_id.department_id.name']);
    // Four hops is the most a path may follow; a label past it is left out, not refused later.
    const deep = referenceProjection(hops, person, ['manager_id.manager_id.manager_id.manager_id.department_id'], true);
    expect(deep.labels.size).toBe(0);
    expect(referenceProjection(hops, person, ['manager_id.manager_id.manager_id.department_id'], true).labels.size).toBe(1);
  });

  test('raw mode never adds joined columns', () => {
    const result = referenceProjection(schema, table, ['account_id'], false);
    expect(result.fetched).toEqual(['account_id']);
    expect(result.labels.size).toBe(0);
  });

  test('composite keys keep ids rather than failing the whole field query', () => {
    const composite = {
      ...schema,
      foreignKeys: [
        {
          name: 'account_scope',
          from: { table: 'contact', columns: ['account_id', 'tenant_id'] },
          to: { table: 'account', columns: ['id', 'tenant_id'] },
        },
      ],
    };
    expect(referenceProjection(composite, table, ['account_id'], true).labels.size).toBe(0);
  });

  test('a leg of a composite key that is also a key of its own is named through its own', () => {
    // A tenant's pair keeps the row in its tenant; the single key is the one its path walks.
    const both = {
      ...schema,
      foreignKeys: [
        {
          name: 'account_scope',
          from: { table: 'contact', columns: ['tenant_id', 'account_id'] },
          to: { table: 'account', columns: ['tenant_id', 'id'] },
        },
        { name: 'contact_account', from: { table: 'contact', columns: ['account_id'] }, to: { table: 'account', columns: ['id'] } },
      ],
    };
    expect(referenceProjection(both, table, ['account_id'], true).labels.get('account_id')).toBe('account_id.name');
  });

  test('a missing target and non-reference paths remain ordinary fields', () => {
    const result = referenceProjection({ ...schema, tables: [table] }, table, ['name', 'account_id', 'account_id.name'], true);
    expect(result.labels.size).toBe(0);
    expect(result.fetched).toEqual(['name', 'account_id', 'account_id.name']);
  });
});

test("on its parent's page a child's name says the word that tells it from its siblings, and no other name is cut", () => {
  const rows = [
    { id: 1, __tw_reference_1: 'Lena Patel · sick visit', note: 'Lena Patel · sick visit' },
    { id: 2, __tw_reference_1: 'Lena Patelson · follow-up' },
    { id: 3, __tw_reference_1: 'Omar Brennan · follow-up' },
    { id: 4, __tw_reference_1: 'Lena Patel' },
    { id: 5, __tw_reference_1: 'Lena Patel — annual physical' },
  ];
  const said = withoutParentName(rows, ['__tw_reference_1'], 'Lena Patel');
  expect(said.map((row) => row.__tw_reference_1)).toEqual([
    'sick visit',
    'Lena Patelson · follow-up',
    'Omar Brennan · follow-up',
    'Lena Patel',
    'annual physical',
  ]);
  // Only the reference labels: an authored cell is the author's words.
  expect(said[0].note).toBe('Lena Patel · sick visit');
  expect(said[2]).toBe(rows[2]);
  expect(withoutParentName(rows, ['__tw_reference_1'], undefined)).toBe(rows);
});
