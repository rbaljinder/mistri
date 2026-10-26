import { beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../test/shellBridge.js';
import type { TableMeta } from '../../../engine/src/shared/schema.js';
import { establishSessionIdentity, lockSessionIdentity } from '../../../kit/src/client/sessionIdentity.js';

const { state, api, toast, render, invalidateQueries } = vi.hoisted(() => ({
  state: {
    activeConnection: 'app',
    canWrite: true,
    app: true,
    connections: [{ id: 'app', writable: true }],
    schema: undefined as { tables: TableMeta[] } | undefined,
  },
  api: vi.fn(),
  toast: vi.fn(),
  render: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../kit/src/client/core.js', () => ({
  state,
  api,
  toast,
  render,
  prefersPages: () => state.app,
  writeAllowed: () => true,
  setRecordMutationPendingProbe: vi.fn(),
  currentEntry: () => ({}),
  loadJson: (_key: string, fallback: unknown) => fallback,
  saveJson: () => {},
  el: (tag: string, attrs: Record<string, unknown> = {}, children: Node | Node[] = []) => {
    const node = document.createElement(tag);
    if (attrs.text) node.textContent = String(attrs.text);
    if (typeof attrs.onclick === 'function') node.addEventListener('click', attrs.onclick as EventListener);
    node.append(...[children].flat());
    return node;
  },
}));
vi.mock('../../../kit/src/client/components/mount.js', () => ({ queryClient: { invalidateQueries } }));
vi.mock('../../../kit/src/client/prompt.js', () => ({ ask: vi.fn(), confirmFor: vi.fn() }));
// The Workbench has Undo; an App has none (undo.js).
vi.mock('../../../kit/src/client/connectionScope.js', () => ({ canUseDatabaseTools: () => !state.app }));
import * as write from '../../../kit/src/client/write.js';
import { canUndo, refreshUndo, undoLast } from './undo.js';

const table: TableMeta = {
  id: 'lead',
  name: 'Lead',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
  ],
};
let row = 0;
const preview = (id = 2) => ({ next: { id, summary: `Write ${id}` } });
beforeEach(bridgeShell);

beforeEach(() => {
  vi.clearAllMocks();
  api.mockReset();
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
  state.activeConnection = 'app';
  state.canWrite = true;
  state.app = true;
  state.schema = { tables: [table] };
  write.discardStaged();
  document.body.replaceChildren();
  row++;
});
async function save() {
  const key = { id: row };
  api.mockResolvedValueOnce({ affected: 1, applied: { name: 'Saved' }, undoId: 2 }).mockResolvedValueOnce(preview());
  write.stage(table, key, table.columns[1], 'Saved', 'Original');
  const saving = write.applyStaged(table, key);
  if (!state.app) {
    const dialog = document.querySelector('dialog')!;
    [...dialog.querySelectorAll('button')].find((button) => button.textContent === 'Apply')!.click();
  }
  await saving;
  const input = document.createElement('input');
  document.body.append(input);
  const committed = vi.fn();
  write.registerInput(table, key, 'name', input, committed);
  api.mockClear();
  return { key, committed };
}

test('an App save says what it saved and offers no Undo: nothing asks the history', async () => {
  const key = { id: row };
  api.mockResolvedValueOnce({ affected: 1, applied: { name: 'Saved' } });
  write.stage(table, key, table.columns[1], 'Saved', 'Original');
  await write.applyStaged(table, key);
  expect(write.stagedFeedback(table.id, key)).toMatchObject({ phase: 'saved', message: 'Changes saved' });
  expect(write.stagedFeedback(table.id, key)?.undoId).toBeUndefined();
  expect(api).toHaveBeenCalledExactlyOnceWith(
    '/api/update',
    expect.objectContaining({ values: { name: 'Saved' }, expected: { name: 'Original' } }),
  );
  api.mockClear();
  await refreshUndo();
  await undoLast(2);
  expect(canUndo()).toBe(false);
  expect(api).not.toHaveBeenCalled();
});

test('Workbench toast retains its save ID when newer history arrives and never remounts after refusal', async () => {
  state.app = false;
  await save();
  const action = toast.mock.calls.find(([, tone, action]) => tone === 'ok' && action)?.[2];
  expect(action).toBeDefined();
  api.mockResolvedValueOnce(preview(3));
  await refreshUndo();
  api.mockClear();
  api
    .mockRejectedValueOnce(Object.assign(new Error('History changed.'), { outcome: 'not_applied', status: 409 }))
    .mockResolvedValueOnce(preview(3));
  action.run();
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith('History changed.', 'error'));
  expect(api).toHaveBeenCalledWith('/api/revert', { conn: 'app', confirm: true, expectedId: 2 });
  expect(render).not.toHaveBeenCalled();
  api.mockClear();
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'app' });
  action.run();
  expect(api).not.toHaveBeenCalled();
});
