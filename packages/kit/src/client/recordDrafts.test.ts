import { expect, test } from 'vitest';
import { createRecordDrafts, draftSchemaKey } from './recordDrafts.js';
import type { TableMeta } from '../../../engine/src/shared/schema.js';

const owner = { connection: 'a', table: 'item', key: { tenant: 'north', id: 4 } };
const table: TableMeta = {
  id: 'item',
  name: 'Item',
  schema: '',
  isView: false,
  columns: [{ name: 'name', type: 'TEXT', nullable: true, primaryKey: false }],
};

test('suspension retains values and originals but releases DOM references', () => {
  const store = createRecordDrafts();
  const draft = store.acquire(owner, 'schema');
  draft.values.name = 'After';
  draft.originals.name = 'Before';
  draft.inputs.name = { element: document.createElement('input') };
  store.suspend(draft);
  const again = store.acquire({ ...owner, key: { id: '4', tenant: 'north' } }, 'schema');
  expect(again).toBe(draft);
  expect(again.needsReview).toBe(true);
  expect(again.manualSaveRequired).toBe(true);
  expect(again.originals.name).toBe('Before');
  expect(again.values.name).toBe('After');
  expect(again.inputs).toEqual({});
  expect(store.hasPending()).toBe(true);
});

test('connections and complete composite keys cannot share a draft', () => {
  const store = createRecordDrafts();
  const a = store.acquire(owner, 'schema');
  a.values.name = 'A';
  expect(store.acquire({ ...owner, connection: 'b' }, 'schema').values).toEqual({});
  expect(store.acquire({ ...owner, key: { tenant: 'south', id: 4 } }, 'schema').values).toEqual({});
  expect(store.acquire(owner, 'schema').values.name).toBe('A');
});

test('schema changes do not rebase pending drafts; clean drafts adopt the new schema', () => {
  const store = createRecordDrafts();
  const draft = store.acquire(owner, 'old');
  draft.values.name = 'After';
  draft.originals.name = 'Before';
  expect(store.acquire(owner, 'new').schemaKey).toBe('old');
  expect(draft.needsReview).toBe(true);
  expect(draft.manualSaveRequired).toBe(true);
  store.drop(owner);
  expect(store.acquire(owner, 'new').schemaKey).toBe('new');
  expect(store.hasPending()).toBe(false);
});

test('clean suspended drafts are removed and storage metadata defines compatibility', () => {
  const store = createRecordDrafts();
  const draft = store.acquire(owner, 'schema');
  store.suspend(draft);
  expect(store.acquire(owner, 'schema')).not.toBe(draft);
  expect(draftSchemaKey(table)).toBe(draftSchemaKey({ ...table, name: 'Different label' }));
  expect(draftSchemaKey(table)).not.toBe(draftSchemaKey({ ...table, columns: [{ ...table.columns[0], type: 'INTEGER' }] }));
});

test('field policy changes invalidate pending drafts even when storage metadata is unchanged', () => {
  const store = createRecordDrafts();
  const allowed = { ...table, columns: [{ ...table.columns[0], writable: true }] };
  const denied = { ...table, columns: [{ ...table.columns[0], writable: false }] };
  const draft = store.acquire(owner, draftSchemaKey(allowed));
  draft.values.name = 'Pending';
  expect(store.acquire(owner, draftSchemaKey(denied))).toBe(draft);
  expect(draft.needsReview).toBe(true);
  expect(draft.schemaKey).toBe(draftSchemaKey(allowed));
  expect(draft.manualSaveRequired).toBe(true);
  expect(draftSchemaKey(table)).not.toBe(draftSchemaKey(denied));
});

test('resuming retained editing does not clear its separate manual-save requirement', () => {
  const store = createRecordDrafts();
  const draft = store.acquire(owner, 'schema');
  expect(draft.manualSaveRequired).toBe(false);
  draft.values.name = 'Retained';
  draft.originals.name = 'Before';
  store.suspend(draft);
  draft.needsReview = false;
  expect(store.acquire(owner, 'schema').manualSaveRequired).toBe(true);
  draft.values.name = 'Another edit';
  expect(store.acquire(owner, 'schema').manualSaveRequired).toBe(true);
});

test('only a newly acquired owner avoids the rejected latch; correcting back to originals does not clear it', () => {
  const store = createRecordDrafts();
  const draft = store.acquire(owner, 'schema');
  draft.manualSaveRequired = true;
  draft.values.name = 'Rejected';
  expect(store.acquire({ ...owner, key: { id: 5, tenant: 'north' } }, 'schema').manualSaveRequired).toBe(false);
  draft.values = {};
  expect(store.acquire(owner, 'schema').manualSaveRequired).toBe(true);
  store.suspend(draft);
  expect(store.acquire(owner, 'schema').manualSaveRequired).toBe(true);
  store.drop(owner);
  expect(store.acquire(owner, 'schema').manualSaveRequired).toBe(false);
});
