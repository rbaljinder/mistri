import { beforeEach, expect, test, vi } from 'vitest';

const s = vi.hoisted(() => ({
  activeConnection: 'a',
  canWrite: false,
  schema: {},
  entry: {},
  app: true,
  connections: [
    { id: 'a', writable: true },
    { id: 'b', writable: false },
  ],
}));
const stored = vi.hoisted(() => new Map<string, unknown>());
const confirm = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../../../kit/src/client/core.js', () => ({
  state: s,
  prefersPages: () => s.app,
  currentEntry: () => s.entry,
  setRecordMutationPendingProbe: vi.fn(),
  loadJson: (key: string, fallback: unknown) => stored.get(key) ?? fallback,
  saveJson: (key: string, value: unknown) => stored.set(key, value),
  render: () => {},
  toast: () => {},
  api: vi.fn(),
  el: vi.fn(),
  writeAllowed: () => true,
}));
vi.mock('../../../kit/src/client/prompt.js', () => ({ ask: confirm, confirmFor: confirm }));
vi.mock('./undo.js', () => ({ refreshUndo: vi.fn(), undoLast: vi.fn() }));

const { syncWriteMode, toggleWriteMode, discardStaged, stage, pendingCount } = await import('../../../kit/src/client/write.js');

beforeEach(() => {
  stored.clear();
  confirm.mockReset();
  confirm.mockResolvedValue(true);
  s.activeConnection = 'a';
  s.canWrite = false;
  s.app = true;
  s.schema = {};
  s.entry = {};
  discardStaged();
});

test('app editing defaults on only for an explicitly writable connection', () => {
  syncWriteMode();
  expect(s.canWrite).toBe(true);
  expect(document.body.classList.contains('write-mode')).toBe(false);
  s.activeConnection = 'b';
  syncWriteMode();
  expect(s.canWrite).toBe(false);
  s.activeConnection = 'unknown';
  syncWriteMode();
  expect(s.canWrite).toBe(false);
});

test('app override and Workbench opt-in persist independently', async () => {
  syncWriteMode();
  await toggleWriteMode();
  expect(s.canWrite).toBe(false);
  syncWriteMode();
  expect(s.canWrite).toBe(false);
  s.app = false;
  syncWriteMode();
  expect(s.canWrite).toBe(false);
  await toggleWriteMode();
  expect(s.canWrite).toBe(true);
  expect(confirm).toHaveBeenCalledOnce();
  s.app = true;
  syncWriteMode();
  expect(s.canWrite).toBe(false);
  await toggleWriteMode();
  expect(s.canWrite).toBe(true);
  expect(confirm).toHaveBeenCalledOnce();
  s.app = false;
  syncWriteMode();
  expect(s.canWrite).toBe(true);
  s.activeConnection = 'b';
  syncWriteMode();
  expect(s.canWrite).toBe(false);
});

test('a canceled discard keeps editing enabled and its staged values', async () => {
  syncWriteMode();
  stage({ id: 'customer' }, { id: 1 }, { name: 'name' }, 'After', 'Before');
  confirm.mockResolvedValueOnce(false);
  await toggleWriteMode();
  expect(s.canWrite).toBe(true);
  expect(pendingCount()).toBe(1);
  await toggleWriteMode();
  expect(s.canWrite).toBe(false);
  expect(pendingCount()).toBe(0);
});

test('a late enable confirmation cannot enable editing in another workspace', async () => {
  s.app = false;
  syncWriteMode();
  let answer!: (value: boolean) => void;
  confirm.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  const changing = toggleWriteMode();
  s.app = true;
  syncWriteMode();
  await toggleWriteMode();
  answer(true);
  await changing;
  expect(s.canWrite).toBe(false);
  expect(stored.get('mistri.write.v1')).toBeUndefined();
});
