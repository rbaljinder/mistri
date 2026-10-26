import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../test/shellBridge.js';
import type { ReactElement } from 'react';
import type { TableMeta } from '../../../engine/src/shared/schema.js';
import type { NewRecordProps } from '../../../kit/src/client/components/NewRecord.js';

const context = vi.hoisted(() => ({ table: undefined as TableMeta | undefined, entry: {}, resource: true }));
const state = vi.hoisted(() => ({ activeConnection: 'a', canWrite: true, connections: [{ id: 'a', writable: true }] }));
const mount = vi.hoisted(() => vi.fn());
const api = vi.hoisted(() => vi.fn());
const refreshUndo = vi.hoisted(() => vi.fn());
vi.mock('./undo.js', () => ({ refreshUndo, undoToast: () => undefined }));
vi.mock('../../../kit/src/client/core.js', () => ({
  allowMutationExit: () => true,
  state,
  prefersPages: () => true,
  writeAllowed: () => context.resource,
  currentEntry: () => context.entry,
  findTable: () => context.table,
  el: (tag: string) => document.createElement(tag),
  whenConnectionChanges: () => () => {},
  api,
  columnLabel: () => undefined,
  humanName: (name: string) => name,
  openRecord: vi.fn(),
  rowLabel: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../../../kit/src/client/url.js', () => ({ syncHash: vi.fn() }));
vi.mock('../../../kit/src/client/components/mount.js', () => ({ mount, unmount: vi.fn() }));
vi.mock('../../../kit/src/client/components/NewRecord.js', () => ({ NewRecordDialog: () => null, NewRecordDrawer: () => null }));

const { openInsert, canInsert, formProps } = await import('../../../kit/src/client/insert.js');
const { establishSessionIdentity, lockSessionIdentity } = await import('../../../kit/src/client/sessionIdentity.js');
const { canDelete } = await import('../../../kit/src/client/delete.js');
const table: TableMeta = {
  id: 'item',
  name: 'Item',
  schema: '',
  isView: false,
  columns: [{ name: 'name', type: 'TEXT', nullable: false, primaryKey: false, writable: true }],
};
const form = () => (mount.mock.calls.at(-1)![1] as ReactElement<NewRecordProps>).props;
beforeEach(bridgeShell);

test('a server update-only projection suppresses creation independently of writable fields', () => {
  expect(canInsert({ ...table, insertable: false })).toBe(false);
});
beforeEach(() => {
  mount.mockClear();
  api.mockReset();
  refreshUndo.mockClear();
  context.table = table;
  context.resource = true;
  state.canWrite = true;
  state.activeConnection = 'a';
  state.connections[0].writable = true;
  establishSessionIdentity({ signedIn: false });
});
afterEach(() => {
  if (mount.mock.calls.length) form().onCancel();
  document.body.replaceChildren();
});

test.each(['read-only', 'unreadable', 'removed'])('an already-open New form refuses after its field becomes %s', (change) => {
  openInsert(table, { defaults: { name: 'Preset' } });
  context.table =
    change === 'removed' ? undefined : { ...table, columns: change === 'unreadable' ? [] : [{ ...table.columns[0], writable: false }] };
  expect(() => form().insert({ name: 'Preset' })).toThrow('The table definition changed. Close this form and open a new one.');
  expect(api).not.toHaveBeenCalled();
});

test('presentation-only catalog changes preserve an open form submission', () => {
  openInsert(table);
  context.table = { ...table, name: 'New title' };
  form().insert({ name: 'Ada' });
  expect(api).toHaveBeenCalledWith('/api/insert', { conn: 'a', table: 'item', values: { name: 'Ada' } });
});

test('confirmed creation refreshes shared Undo eligibility', () => {
  openInsert(table);
  form().onAdded({ key: { id: 1 }, row: { name: 'Ada' } });
  expect(refreshUndo).toHaveBeenCalledOnce();
});

test('a late creation does not refresh another connection history', () => {
  openInsert(table);
  state.activeConnection = 'b';
  form().onAdded({ key: { id: 1 }, row: { name: 'Ada' } });
  expect(refreshUndo).not.toHaveBeenCalled();
});

test.each([undefined, true, false])('deletable %s gates deletes independently of subset inserts', (deletable) => {
  const projected = { ...table, deletable };
  expect(canInsert(projected)).toBe(true);
  expect(canDelete(projected)).toBe(deletable !== false);
});

test.each(['mode', 'resource', 'source', 'connection', 'view', 'missing'])('neither delete nor insert bypasses the %s gate', (gate) => {
  if (gate === 'mode') state.canWrite = false;
  if (gate === 'resource') context.resource = false;
  if (gate === 'source') state.connections[0].writable = false;
  if (gate === 'connection') state.activeConnection = 'unknown';
  const projected = gate === 'missing' ? undefined : { ...table, deletable: true, isView: gate === 'view' };
  expect(canInsert(projected)).toBe(false);
  expect(canDelete(projected)).toBe(false);
});

test('App insert eligibility does not require explorer write mode', () => {
  state.canWrite = false;
  expect(canInsert(table, true)).toBe(true);
  expect(canInsert(table)).toBe(false);
});

test.each(['grant', 'resource', 'insertable', 'view'])('the shared host rechecks %s before dispatch', (gate) => {
  openInsert(table);
  if (gate === 'grant') state.connections[0].writable = false;
  if (gate === 'resource') context.resource = false;
  if (gate === 'insertable') context.table = { ...table, insertable: false };
  if (gate === 'view') context.table = { ...table, isView: true };
  expect(() => form().insert({ name: 'Ada' })).toThrow();
  expect(api).not.toHaveBeenCalled();
});

test('captured callbacks cannot affect a new login with the same connection and route', () => {
  const element = document.createElement('div');
  document.body.append(element);
  const close = vi.fn();
  const added = vi.fn();
  const props = formProps(table, undefined, element, close, added, { app: true });
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: false });
  expect(() => props.insert({ name: 'Ada' })).toThrow('connection or view changed');
  props.onCancel();
  props.onAdded({ key: { id: 1 } });
  expect(close).not.toHaveBeenCalled();
  expect(added).not.toHaveBeenCalled();
  expect(refreshUndo).not.toHaveBeenCalled();
});

test('closed inline callbacks cannot close or refresh a replacement on the same connected host', () => {
  const element = document.createElement('div');
  document.body.append(element);
  const close = vi.fn();
  const added = vi.fn();
  const first = formProps(table, undefined, element, close, added, { app: true });
  first.onCancel();
  const next = formProps(table, undefined, element, close, added, { app: true });
  first.onAdded({ key: { id: 1 } });
  first.onCancel();
  expect(close).toHaveBeenCalledOnce();
  expect(added).not.toHaveBeenCalled();
  expect(refreshUndo).not.toHaveBeenCalled();
  expect(() => first.insert({})).toThrow('connection or view changed');
  next.onAdded({ key: { id: 2 } });
  next.onAdded({ key: { id: 2 } });
  expect(close).toHaveBeenCalledTimes(2);
  expect(added).toHaveBeenCalledExactlyOnceWith({ key: { id: 2 } });
  expect(refreshUndo).toHaveBeenCalledOnce();
});
