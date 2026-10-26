import { beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { Connection, ConnectionManagerProps } from './components/ConnectionManager.js';
import type { ConnectionDialogProps } from './components/ConnectionDialog.js';

const state = { activeConnection: 'a' };
const api = vi.fn();
const selectConnection = vi.fn();
const refreshConnections = vi.fn();
const promptFor = vi.fn();
const mounted: unknown[] = [];
const canManageConnections = vi.fn();
vi.mock('../../../kit/src/client/connectionScope.js', () => ({ canManageConnections }));
vi.mock('../../../kit/src/client/core.js', () => ({ state, api, toast: vi.fn(), el: (tag: string) => document.createElement(tag) }));
vi.mock('../../../kit/src/client/prompt.js', () => ({ promptFor }));
vi.mock('./connections.js', () => ({ selectConnection, reintrospect: vi.fn() }));
vi.mock('../../../kit/src/client/connectionList.js', () => ({ refreshConnections }));
vi.mock('../../../kit/src/client/components/mount.js', () => ({
  mount: (_host: Element, tree: ReactElement) => mounted.push(tree.props),
  unmount: vi.fn(),
}));
vi.mock('./components/ConnectionManager.js', () => ({ ConnectionManager: () => null }));
vi.mock('./components/ConnectionDialog.js', () => ({ ConnectionDialog: () => null }));

let manager: ConnectionManagerProps;
let transitions: typeof import('../../../kit/src/client/connectionTransition.js');
const conn: Connection = { id: 'a', name: 'A', schemas: ['sales'] };
const refreshed = vi.fn();
const submission = { url: '', name: 'New A', schemas: [] };
const listed = { active: 'c', connections: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  mounted.length = 0;
  canManageConnections.mockReturnValue(true);
  document.body.innerHTML = '';
  state.activeConnection = 'a';
  api.mockResolvedValue(listed);
  transitions = await import('../../../kit/src/client/connectionTransition.js');
  await (await import('./connmanager.js')).openConnections();
  manager = mounted[0] as ConnectionManagerProps;
});

test('app context dismisses management surfaces and blocks manager and wizard entrypoints', async () => {
  const module = await import('./connmanager.js');
  manager.onAdd(refreshed);
  const form = mounted[1] as ConnectionDialogProps;
  canManageConnections.mockReturnValue(false);
  module.closeConnectionManagement();
  expect(module.connectionsOpen()).toBe(false);
  mounted.length = 0;
  await module.openConnections();
  module.addConnection(vi.fn());
  manager.onAdd(refreshed);
  expect(mounted).toHaveLength(0);
  expect(await form.run({ ...submission, url: '/tmp/fixture.db' })).toEqual({
    error: 'The workspace changed. Close this form and open Connections again.',
  });
  expect(api).not.toHaveBeenCalled();
});

test('a pending save prompt cannot write connection configuration after entering an app', async () => {
  let answer!: (value: string) => void;
  promptFor.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  manager.onSaveFile(2);
  canManageConnections.mockReturnValue(false);
  answer('tablewalk.json');
  await vi.waitFor(() => expect(promptFor).toHaveBeenCalledOnce());
  expect(api).not.toHaveBeenCalled();
});

test('editing the current connection reloads it, ignores the server default and can clear schemas', async () => {
  manager.onEdit(conn, refreshed);
  const form = mounted[1] as ConnectionDialogProps;
  expect(await form.run(submission)).toBeNull();
  expect(api).toHaveBeenCalledWith('/api/connections/update', { id: 'a', name: 'New A', schemas: [] });
  expect(selectConnection).toHaveBeenCalledWith('a', { reload: true });
  expect(state.activeConnection).toBe('a');
});

test('an update arriving after navigation cannot switch the new workspace', async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  manager.onEdit(conn, refreshed);
  const saving = (mounted[1] as ConnectionDialogProps).run(submission);
  state.activeConnection = 'b';
  transitions.beginConnectionTransition().finish();
  finish(listed);
  await saving;
  expect(selectConnection).not.toHaveBeenCalled();
  expect(refreshConnections).not.toHaveBeenCalled();
  expect(state.activeConnection).toBe('b');
});

test('an obsolete form refuses to submit and two submissions cannot mutate a connection concurrently', async () => {
  manager.onEdit(conn, refreshed);
  const form = mounted[1] as ConnectionDialogProps;
  let finish!: (value: unknown) => void;
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const saving = form.run(submission);
  expect(await form.run(submission)).toEqual({ error: 'A change to this connection is still pending.' });
  expect(api).toHaveBeenCalledTimes(1);
  finish(listed);
  await saving;
  transitions.beginConnectionTransition().finish();
  expect(await form.run(submission)).toEqual({ error: 'The workspace changed. Close this form and open Connections again.' });
  expect(api).toHaveBeenCalledTimes(1);
});

test('a late add acknowledgement does not close a new manager or open a different database', async () => {
  let finish!: (value: unknown) => void;
  api.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  manager.onAdd(refreshed);
  const saving = (mounted[1] as ConnectionDialogProps).run({ ...submission, url: '/tmp/fixture.db' });
  state.activeConnection = 'b';
  finish({ ...listed, added: 'new' });
  await saving;
  expect(selectConnection).not.toHaveBeenCalled();
  expect((await import('./connmanager.js')).connectionsOpen()).toBe(true);
});

test('removing a different connection does not adopt the server default', async () => {
  promptFor.mockResolvedValue('B');
  manager.onRemove({ id: 'b', name: 'B' }, refreshed);
  await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  expect(state.activeConnection).toBe('a');
  expect(selectConnection).not.toHaveBeenCalled();
  expect(refreshConnections).toHaveBeenCalledOnce();
});

test('removing the current connection selects a replacement through the transition owner', async () => {
  promptFor.mockResolvedValue('A');
  api.mockResolvedValue({ active: 'b', connections: [{ id: 'b' }] });
  manager.onRemove(conn, refreshed);
  manager.onRemove(conn, refreshed);
  await vi.waitFor(() => expect(refreshed).toHaveBeenCalledOnce());
  expect(api).toHaveBeenCalledTimes(1);
  expect(selectConnection).toHaveBeenCalledWith('b');
  expect(state.activeConnection).toBe('a');
});
