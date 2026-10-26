import { beforeEach, expect, test, vi } from 'vitest';
import type { TableMeta } from '../../../engine/src/shared/schema.js';

const model = vi.hoisted(() => ({
  activeConnection: 'a',
  canWrite: true,
  app: true,
  nav: 0,
  allowed: true,
  schema: undefined as { tables: TableMeta[] } | undefined,
  connections: [
    { id: 'a', writable: true },
    { id: 'b', writable: true },
  ],
}));
vi.mock('../../../kit/src/client/core.js', () => ({
  state: model,
  prefersPages: () => model.app,
  writeAllowed: () => model.allowed,
  captureNavigation: () => {
    const nav = model.nav;
    return () => nav === model.nav;
  },
  api: vi.fn(),
  currentEntry: () => ({}),
  loadJson: (_key: string, fallback: unknown) => fallback,
  setRecordMutationPendingProbe: vi.fn(),
  saveJson: vi.fn(),
  render: vi.fn(),
  toast: vi.fn(),
  el: vi.fn(),
}));
vi.mock('./undo.js', () => ({ refreshUndo: vi.fn(), undoLast: vi.fn() }));
vi.mock('../../../kit/src/client/recordWriteRefresh.js', () => ({ captureRecordWriteRefresh: () => vi.fn() }));
vi.mock('../../../kit/src/client/prompt.js', () => ({ ask: vi.fn(), confirmFor: vi.fn() }));
const write = await import('../../../kit/src/client/write.js');
const { api } = await import('../../../kit/src/client/core.js');
const { establishSessionIdentity } = await import('../../../kit/src/client/sessionIdentity.js');
const table: TableMeta = {
  id: 'task',
  name: 'Task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
let id = 0;
beforeEach(() => {
  establishSessionIdentity({ signedIn: false });
  model.activeConnection = 'a';
  model.canWrite = true;
  model.app = true;
  model.allowed = true;
  model.schema = undefined;
  model.nav++;
  id++;
  vi.mocked(api).mockReset();
});
function edited() {
  const key = { id };
  write.stage(table, key, table.columns[1], 'Draft', 'Original');
  return key;
}

test('guard captures fresh staged work but never sends or schedules a write', async () => {
  const key = edited();
  const guard = write.captureRecordAutosaveGuard(table, key, () => true);
  expect(guard()).toBe(true);
  await Promise.resolve();
  expect(guard()).toBe(true);
  expect(api).not.toHaveBeenCalled();
});

test.each(['navigation', 'connection', 'identity', 'schema', 'permission', 'mode', 'write-mode', 'edit', 'discard'] as const)(
  '%s retires captured autosave eligibility',
  (change) => {
    const key = edited();
    const guard = write.captureRecordAutosaveGuard(table, key, () => true);
    expect(guard()).toBe(true);
    if (change === 'navigation') model.nav++;
    if (change === 'connection') model.activeConnection = 'b';
    if (change === 'identity') establishSessionIdentity({ signedIn: true, appId: 'a', accountId: 'other' });
    if (change === 'schema') model.schema = { tables: [table] };
    if (change === 'permission') model.allowed = false;
    if (change === 'mode') model.app = false;
    if (change === 'write-mode') model.canWrite = false;
    if (change === 'edit') write.stage(table, key, table.columns[1], 'Newer draft', 'Original');
    if (change === 'discard') write.discardStaged();
    expect(guard()).toBe(false);
    expect(api).not.toHaveBeenCalled();
  },
);

test('the exact mounted interaction and policy must still admit dispatch', () => {
  const key = edited();
  let editing = true;
  const guard = write.captureRecordAutosaveGuard(table, key, () => editing);
  expect(guard()).toBe(true);
  editing = false;
  expect(guard()).toBe(false);
  expect(
    write.captureRecordAutosaveGuard(table, key, () => {
      throw new Error('retired');
    })(),
  ).toBe(false);
});

test('an initially denied capture cannot be activated by a later mode/policy change', () => {
  const key = edited();
  let editing = false;
  const guard = write.captureRecordAutosaveGuard(table, key, () => editing);
  editing = true;
  expect(guard()).toBe(false);
  expect(api).not.toHaveBeenCalled();
});

test('mounting, returning to a retained draft and Resume never arm a stale blur', () => {
  const key = edited();
  const draft = write.activateDraft(table, key);
  const prior = write.captureRecordAutosaveGuard(table, key, () => true);
  write.suspendDraft(draft);
  write.activateDraft(table, key);
  const retained = write.captureRecordAutosaveGuard(table, key, () => true);
  write.resumeDraft(table, key);
  expect(prior()).toBe(false);
  expect(retained()).toBe(false);
  expect(write.captureRecordAutosaveGuard(table, key, () => true)()).toBe(false);
  write.stage(table, key, table.columns[1], 'Fresh typing over retained work', 'Original');
  expect(write.captureRecordAutosaveGuard(table, key, () => true)()).toBe(false);
  expect(api).not.toHaveBeenCalled();
});

test('a pending, uncertain or definitely rejected update cannot become an automatic retry', async () => {
  const key = edited();
  const prior = write.captureRecordAutosaveGuard(table, key, () => true);
  let resolve!: (result: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const saving = write.applyStaged(table, key);
  expect(prior()).toBe(false);
  expect(write.captureRecordAutosaveGuard(table, key, () => true)()).toBe(false);
  await Promise.resolve();
  resolve({ outcome: 'rejected', errors: [{ message: 'Conflict' }] });
  await saving;
  expect(write.captureRecordAutosaveGuard(table, key, () => true)()).toBe(false);
  write.stage(table, key, table.columns[1], 'Corrected', 'Original');
  expect(write.captureRecordAutosaveGuard(table, key, () => true)()).toBe(false);
  vi.mocked(api).mockRejectedValueOnce(new Error('Lost acknowledgement'));
  await write.applyStaged(table, key);
  expect(write.stagedAttempt(table.id, key)?.phase).toBe('uncertain');
  expect(write.captureRecordAutosaveGuard(table, key, () => true)()).toBe(false);
  expect(api).toHaveBeenCalledTimes(2);
});
