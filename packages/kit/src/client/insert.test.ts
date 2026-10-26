import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { NewRecordProps } from './components/NewRecord.js';

const state = { activeConnection: 'a', navMode: '', canWrite: true, connections: [{ id: 'a', writable: true }] };
let entry = { kind: 'table', table: 'lead', tab: 'rows' };
const api = vi.fn();
const openRecord = vi.fn();
const toast = vi.fn();
const go = vi.fn();
const undoToast = vi.fn((undoId: unknown, after?: () => void) =>
  undoId === undefined ? undefined : { label: 'Undo', undoId, run: async () => after?.() },
);
const prefersPages = vi.fn(() => true);
const allowMutationExit = vi.fn(() => true);
const mounted: NewRecordProps[] = [];
const watchers = new Set<() => void>();
vi.mock('./core.js', () => ({
  state,
  api,
  openRecord,
  toast,
  go,
  prefersPages,
  allowMutationExit,
  currentEntry: () => entry,
  columnLabel: () => undefined,
  humanName: (name: string) => name,
  rowLabel: () => 'Ada',
  findTable: () => table,
  writeAllowed: () => true,
  el: (tag: string, attrs: { class: string }) => Object.assign(document.createElement(tag), { className: attrs.class }),
  whenConnectionChanges: (fn: () => void) => {
    watchers.add(fn);
    return () => watchers.delete(fn);
  },
}));
vi.mock('./url.js', () => ({ syncHash: vi.fn() }));
vi.mock('../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: vi.fn(), undoToast }));
vi.mock('./components/NewRecord.js', () => ({ NewRecordDrawer: () => null, NewRecordDialog: () => null }));
vi.mock('./components/mount.js', () => ({
  mount: (_host: Element, tree: ReactElement<NewRecordProps>) => mounted.push(tree.props),
  unmount: vi.fn(),
}));

let host: typeof import('./insert.js');
const table = { id: 'lead', name: 'lead', columns: [] };
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  mounted.length = 0;
  state.activeConnection = 'a';
  entry = { kind: 'table', table: 'lead', tab: 'rows' };
  prefersPages.mockReturnValue(true);
  allowMutationExit.mockReturnValue(true);
  api.mockResolvedValue({ key: { id: 1 } });
  /* The module graph was just reset: the shell's Undo is installed into the one insert.js reads. */
  (await import('./shellMode.js')).installShell({ undo: { refresh: () => {}, last: () => {}, toast: undoToast } });
  host = await import('./insert.js');
});
afterEach(() => {
  for (const fn of [...watchers]) fn();
  expect(watchers.size).toBe(0);
  document.body.replaceChildren();
});

test.each([true, false])('the host binds inserts to its connection and owns success navigation (app=%s)', async (app) => {
  prefersPages.mockReturnValue(app);
  host.openNewRecord(table);
  const form = mounted[0];
  const result = await form.insert({ name: 'Ada' });
  if (!('key' in result)) throw new Error('Expected an inserted record');
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/insert', { conn: 'a', table: 'lead', values: { name: 'Ada' } });
  form.onAdded(result);
  expect(document.querySelector('.newpanel-host, .insert-host')).toBeNull();
  expect(openRecord).toHaveBeenCalledWith('lead', { id: 1 }, '1');
  expect(watchers.size).toBe(0);
});

test('the Added confirmation offers Undo of that creation, which leaves the gone record for its list', async () => {
  host.openNewRecord(table);
  mounted[0].onAdded({ key: { id: 9 }, undoId: 4 } as never);
  expect(undoToast).toHaveBeenCalledExactlyOnceWith(4, expect.any(Function));
  const action = toast.mock.calls[0][2];
  expect(toast).toHaveBeenCalledWith('Added lead · 9', 'ok', expect.objectContaining({ label: 'Undo', undoId: 4 }));
  // openRecord is mocked: stand on the new record as it would have.
  entry = { kind: 'record', table: 'lead', key: { id: 9 } } as never;
  await action.run();
  expect(go).toHaveBeenCalledExactlyOnceWith({ kind: 'table', table: 'lead', query: 'lead', tab: 'rows' }, 'reset');
  // Somewhere else by the time it is pressed: the reader stays there.
  go.mockClear();
  entry = { kind: 'record', table: 'lead', key: { id: 2 } } as never;
  await action.run();
  expect(go).not.toHaveBeenCalled();
});

test('switching connections closes the old form without changing the new route', async () => {
  host.openNewRecord(table);
  const form = mounted[0];
  state.activeConnection = 'b';
  entry = { kind: 'table', table: 'lead', tab: 'new' };
  for (const fn of [...watchers]) fn();
  expect(document.querySelector('.newpanel-host')).toBeNull();
  expect(entry.tab).toBe('new');
  expect(() => form.insert({})).toThrow('connection or view changed');
  form.onAdded({ key: { id: 1 } });
  expect(api).not.toHaveBeenCalled();
  expect(openRecord).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

test('an unresolved mutation vetoes opening, replacement and dismissal, but not forced connection retirement', () => {
  allowMutationExit.mockReturnValue(false);
  host.openNewRecord(table);
  host.openInsert(table);
  expect(mounted).toHaveLength(0);
  allowMutationExit.mockReturnValue(true);
  host.openNewRecord(table);
  const form = mounted[0];
  allowMutationExit.mockReturnValue(false);
  expect(form.canClose?.()).toBe(false);
  form.onCancel();
  host.openNewRecord(table);
  expect(mounted).toHaveLength(1);
  expect(document.querySelector('.newpanel-host')).not.toBeNull();
  state.activeConnection = 'b';
  for (const fn of [...watchers]) fn();
  expect(document.querySelector('.newpanel-host')).toBeNull();
});

test('the list room drawing `…!new` again keeps the form already open for its table', () => {
  host.openNewRecord(table);
  const first = document.querySelector('.newpanel-host');
  host.openNewRecord(table, undefined, { reopen: true });
  // Drawn again into the same root with the same props, so its state — the draft — is kept.
  expect(mounted).toHaveLength(2);
  expect(mounted[1].onCancel).toBe(mounted[0].onCancel);
  expect(document.querySelector('.newpanel-host')).toBe(first);
  // A button press is a new form, as it was.
  host.openNewRecord(table);
  expect(mounted).toHaveLength(3);
  expect(document.querySelector('.newpanel-host')).not.toBe(first);
});

test('a form replaced during a write cannot close or navigate the replacement', () => {
  host.openNewRecord(table);
  const first = mounted[0];
  host.openNewRecord(table);
  expect(entry.tab).toBe('new');
  first.onAdded({ key: { id: 1 } });
  expect(document.querySelectorAll('.newpanel-host')).toHaveLength(1);
  expect(openRecord).not.toHaveBeenCalled();
  expect(() => first.insert({})).toThrow('connection or view changed');
});

test('navigation invalidates submission and suppresses late record navigation', () => {
  host.openNewRecord(table);
  const form = mounted[0];
  entry = { kind: 'table', table: 'account', tab: 'rows' };
  expect(() => form.insert({})).toThrow('connection or view changed');
  form.onAdded({ key: { id: 1 } });
  expect(entry).toEqual({ kind: 'table', table: 'account', tab: 'rows' });
  expect(api).not.toHaveBeenCalled();
  expect(openRecord).not.toHaveBeenCalled();
});

test('an absent connection cannot fall back to the server default', () => {
  state.activeConnection = '';
  host.openNewRecord(table);
  expect(() => mounted[0].insert({})).toThrow('connection or view changed');
  expect(api).not.toHaveBeenCalled();
});
