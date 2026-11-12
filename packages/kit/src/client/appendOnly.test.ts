import { expect, test, vi } from 'vitest';

/* The two questions every edit and delete affordance asks first. A table the reader only adds rows to
   (`appendOnly`, from `create` without `write`) answers no to both, whatever else is true; the same table without
   the word answers yes, so the refusal is the word's alone. */
vi.mock('./uiBridge.js', () => ({ pageBridge: { activeApp: () => null } }));
vi.mock('./core.js', async (original) => ({
  ...(await original<object>()),
  state: { canWrite: true, activeConnection: 'c', connections: [{ id: 'c', writable: true }] },
  writeAllowed: () => true,
  prefersPages: () => false,
}));
const { canEditRow } = await import('./rowEditing.js');
const { canDelete } = await import('./delete.js');

const table = (extra: object = {}) => ({
  id: 'note',
  name: 'note',
  schema: '',
  isView: false,
  columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
  ...extra,
});

test('an append-only table is neither edited nor deleted from', () => {
  expect(canEditRow(table(), { id: 1 }, undefined)).toBe(true);
  expect(canDelete(table())).toBe(true);
  expect(canEditRow(table({ appendOnly: true }), { id: 1 }, undefined)).toBe(false);
  expect(canDelete(table({ appendOnly: true }))).toBe(false);
});
