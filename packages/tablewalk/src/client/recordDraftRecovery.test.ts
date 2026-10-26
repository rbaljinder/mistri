import { beforeEach, expect, test, vi } from 'vitest';
import type { TableMeta } from '../../../engine/src/shared/schema.js';

const state = vi.hoisted(() => ({
  activeConnection: 'a',
  canWrite: true,
  app: true,
  schema: undefined as { tables: TableMeta[] } | undefined,
  connections: [
    { id: 'a', writable: true },
    { id: 'b', writable: false },
  ],
}));
vi.mock('../../../kit/src/client/core.js', () => ({
  state,
  prefersPages: () => state.app,
  currentEntry: () => ({}),
  setRecordMutationPendingProbe: vi.fn(),
  loadJson: (_key: string, fallback: unknown) => fallback,
  saveJson: () => {},
  render: () => {},
  toast: vi.fn(),
  api: vi.fn(),
  el: (tag: string, attrs: Record<string, unknown> = {}, children: Node | Node[] = []) => {
    const node = document.createElement(tag);
    if (attrs.text) node.textContent = String(attrs.text);
    if (typeof attrs.onclick === 'function') node.addEventListener('click', attrs.onclick as EventListener);
    node.append(...[children].flat());
    return node;
  },
  writeAllowed: () => true,
}));
vi.mock('./undo.js', () => ({ refreshUndo: vi.fn(), undoLast: vi.fn() }));
vi.mock('../../../kit/src/client/recordWriteRefresh.js', () => ({ captureRecordWriteRefresh: () => vi.fn() }));
vi.mock('../../../kit/src/client/prompt.js', () => ({ ask: vi.fn(), confirmFor: vi.fn() }));
const write = await import('../../../kit/src/client/write.js');
const { api, toast } = await import('../../../kit/src/client/core.js');
const table: TableMeta = {
  id: 'item',
  name: 'Item',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: true, primaryKey: false },
  ],
};
let id = 0;
beforeEach(() => {
  state.activeConnection = 'a';
  state.canWrite = true;
  state.app = true;
  state.schema = undefined;
  vi.mocked(api).mockReset();
  vi.mocked(toast).mockClear();
  id++;
});

test('leaving an unsent App draft explains tab-local retention without exposing its contents', () => {
  const draft = write.activateDraft(table, { id });
  write.stage(table, { id }, table.columns[1], 'Private draft text', 'Original');
  write.suspendDraft(draft);
  expect(toast).toHaveBeenCalledExactlyOnceWith('Unsaved changes were retained in this tab. Review them when you return.', 'info');
  write.suspendDraft(draft);
  expect(toast).toHaveBeenCalledTimes(1);
});

test('connection changes do not discard or silently resume the previous connection draft', () => {
  const key = { id };
  const draft = write.activateDraft(table, key);
  write.stage(table, key, table.columns[1], 'Draft', 'Original');
  state.activeConnection = 'b';
  write.syncWriteMode();
  write.suspendDraft(draft);
  write.activateDraft(table, key);
  expect(write.pendingCount()).toBe(0);
  state.activeConnection = 'a';
  write.syncWriteMode();
  write.activateDraft(table, key);
  expect(write.draftNeedsReview(table.id, key)).toBe(true);
  expect(write.stagedValue('name')).toBeUndefined();
  write.resumeDraft(table, key);
  expect(write.draftRequiresManualSave(table.id, key)).toBe(true);
  expect(write.stagedValue('name')).toBe('Draft');
  expect(write.stagedOriginal('name')).toBe('Original');
  write.discardStaged();
  expect(write.draftRequiresManualSave(table.id, key)).toBe(false);
});

test('incompatible metadata blocks recovery until the draft is explicitly discarded', () => {
  const key = { id };
  const draft = write.activateDraft(table, key);
  write.stage(table, key, table.columns[1], 'Draft', 'Original');
  write.suspendDraft(draft);
  const changed = { ...table, columns: [table.columns[0], { ...table.columns[1], type: 'INTEGER' }] };
  write.activateDraft(changed, key);
  expect(write.draftSchemaChanged(changed)).toBe(true);
  write.resumeDraft(changed, key);
  expect(write.stagedValue('name')).toBeUndefined();
  expect(write.retainedValues()).toEqual({ name: 'Draft' });
  write.discardStaged();
  write.activateDraft(changed, key);
  expect(write.draftSchemaChanged(changed)).toBe(false);
});

test('a denied field cannot be staged even if the caller carries old column metadata', () => {
  const limited = { ...table, columns: [table.columns[0], { ...table.columns[1], writable: false }] };
  write.activateDraft(limited, { id });
  write.stage(limited, { id }, table.columns[1], 'Draft', 'Original');
  expect(write.pendingCount()).toBe(0);
  write.stage(table, { id }, { ...table.columns[1], writable: false }, 'Draft', 'Original');
  expect(write.pendingCount()).toBe(0);
});

test('field policy narrowing blocks save and draft resume without dropping pending values', async () => {
  const key = { id };
  const allowed = { ...table, columns: table.columns.map((c) => ({ ...c, writable: true })) };
  const limited = { ...allowed, columns: [allowed.columns[0], { ...allowed.columns[1], writable: false }] };
  write.stage(allowed, key, allowed.columns[1], 'Draft', 'Original');
  // Save must check the schema even before the next component effect acquires it.
  await write.applyStaged(limited, key);
  expect(api).not.toHaveBeenCalled();
  write.activateDraft(limited, key);
  write.resumeDraft(limited, key);
  expect(write.draftNeedsReview(table.id, key)).toBe(true);
  expect(write.stagedValue('name')).toBeUndefined();
  expect(write.retainedValues()).toEqual({ name: 'Draft' });
  write.discardStaged();
});

test.each([undefined, true])('allowed fields still save with writable metadata %s', async (writable) => {
  const allowed = { ...table, columns: table.columns.map((c) => ({ ...c, writable })) };
  vi.mocked(api).mockResolvedValue({ affected: 1, applied: { name: 'Draft' } });
  write.stage(allowed, { id }, allowed.columns[1], 'Draft', 'Original');
  await write.applyStaged(allowed, { id });
  expect(api).toHaveBeenCalledWith('/api/update', {
    conn: 'a',
    table: 'item',
    key: { id },
    values: { name: 'Draft' },
    expected: { name: 'Original' },
  });
  expect(write.pendingCount()).toBe(0);
});

test('a stale save callback checks the latest catalog before submitting', async () => {
  write.stage(table, { id }, table.columns[1], 'Draft', 'Original');
  state.schema = { tables: [{ ...table, columns: [table.columns[0], { ...table.columns[1], writable: false }] }] };
  await write.applyStaged(table, { id });
  expect(api).not.toHaveBeenCalled();
  expect(write.retainedValues()).toEqual({ name: 'Draft' });
  write.discardStaged();
});

test('a catalog change during Workbench confirmation prevents the old write', async () => {
  state.app = false;
  state.schema = { tables: [table] };
  write.stage(table, { id }, table.columns[1], 'Draft', 'Original');
  const saving = write.applyStaged(table, { id });
  const dialog = document.querySelector('dialog')!;
  expect(dialog).not.toBeNull();
  state.schema = { tables: [{ ...table, columns: [table.columns[0], { ...table.columns[1], writable: false }] }] };
  const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Apply')!;
  confirm.click();
  await saving;
  expect(api).not.toHaveBeenCalled();
  expect(write.retainedValues()).toEqual({ name: 'Draft' });
  write.discardStaged();
  dialog.remove();
});

test('a definite rejection requires manual Save even after a fresh field correction', async () => {
  const key = { id };
  vi.mocked(api).mockResolvedValue({ outcome: 'rejected', errors: [{ message: 'The row changed.' }] });
  write.stage(table, key, table.columns[1], 'Rejected', 'Original');
  await write.applyStaged(table, key);
  expect(write.draftRequiresManualSave(table.id, key)).toBe(true);
  expect(write.retainedValues()).toEqual({ name: 'Rejected' });
  write.stage(table, key, table.columns[1], 'Correction', 'Original');
  expect(write.draftRequiresManualSave(table.id, key)).toBe(true);
  expect(api).toHaveBeenCalledTimes(1);
  vi.mocked(api).mockResolvedValue({ affected: 1, applied: { name: 'Correction' } });
  await write.applyStaged(table, key);
  expect(api).toHaveBeenCalledTimes(2);
  expect(write.draftRequiresManualSave(table.id, key)).toBe(false);
  expect(write.pendingCount()).toBe(0);
});

test('explicit Save of a resumed retained draft clears its manual-only latch after acknowledgement', async () => {
  const key = { id };
  const draft = write.activateDraft(table, key);
  write.stage(table, key, table.columns[1], 'Retained', 'Original');
  write.suspendDraft(draft);
  write.activateDraft(table, key);
  write.resumeDraft(table, key);
  expect(api).not.toHaveBeenCalled();
  expect(write.draftRequiresManualSave(table.id, key)).toBe(true);
  vi.mocked(api).mockResolvedValue({ affected: 1, applied: { name: 'Retained' } });
  await write.applyStaged(table, key);
  expect(api).toHaveBeenCalledTimes(1);
  expect(write.draftRequiresManualSave(table.id, key)).toBe(false);
});
