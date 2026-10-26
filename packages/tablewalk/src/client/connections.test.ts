import { beforeEach, expect, test, vi } from 'vitest';
import type { ReactElement } from 'react';

const schema = (label: string) => ({ label, dialect: 'sqlite', tables: [] });
const state = {
  activeConnection: 'a' as string | undefined,
  schema: schema('a'),
  stack: [] as unknown[],
  page: 0,
  onSwitched: undefined as undefined | ((isCurrent: () => boolean) => Promise<void>),
};
const api = vi.fn();
const render = vi.fn();
const toast = vi.fn();
const changed = vi.fn();
const clearPeekCache = vi.fn();
const syncWriteMode = vi.fn();
const canManageConnections = vi.fn();
const unmount = vi.fn();
const switched = vi.fn(async (_isCurrent: () => boolean) => {});
const mounted: Array<{ active: string; onReintrospect: () => Promise<void> }> = [];
vi.mock('../../../kit/src/client/core.js', () => ({
  state,
  api,
  render,
  toast,
  connectionChanged: changed,
  $: (id: string) => document.getElementById(id),
}));
vi.mock('../../../kit/src/client/components/mount.js', () => ({
  mount: (_host: Element, tree: ReactElement) => mounted.push(tree.props as (typeof mounted)[number]),
  unmount,
}));
vi.mock('../../../kit/src/client/connectionScope.js', () => ({ canManageConnections, setAppConfigured: vi.fn() }));
vi.mock('./components/ConnectionPicker.js', () => ({ ConnectionPicker: () => null }));
vi.mock('../../../kit/src/client/write.js', () => ({ syncWriteMode }));
vi.mock('./connmanager.js', () => ({ openConnections: vi.fn() }));
vi.mock('../../../kit/src/client/peek.js', () => ({ clearPeekCache }));
vi.mock('../../../kit/src/client/page.js', () => ({ forgetPages: vi.fn() }));
vi.mock('./sqlsaved.js', () => ({ loadSavedSql: async () => {} }));

let connections: typeof import('./connections.js');
let runtime: typeof import('../../../kit/src/client/connectionList.js');
let transitions: typeof import('../../../kit/src/client/connectionTransition.js');
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const list = (active = 'a') => ({ active, connections: ['a', 'b', 'c'].map((id) => ({ id, name: id })) });

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  canManageConnections.mockReturnValue(true);
  state.activeConnection = 'a';
  state.schema = schema('a');
  state.stack = [];
  state.onSwitched = undefined;
  mounted.length = 0;
  document.body.innerHTML = '<div id="conn-picker"></div><div id="db-label"></div><input id="query">';
  api.mockImplementation(async (path: string, body?: { id: string }) =>
    path === '/api/runtime' ? { appConfigured: false } : path === '/api/connections' ? list() : { schema: schema(body!.id) },
  );
  connections = await import('./connections.js');
  runtime = await import('../../../kit/src/client/connectionList.js');
  transitions = await import('../../../kit/src/client/connectionTransition.js');
  await runtime.initConnections(switched);
});

test('app ownership unmounts picker controls and rejects manual connection switching', async () => {
  api.mockClear();
  canManageConnections.mockReturnValue(false);
  runtime.syncConnectionControls();
  expect(document.getElementById('conn-picker')).toHaveProperty('hidden', true);
  expect(document.getElementById('db-label')).toHaveProperty('hidden', true);
  expect(unmount).toHaveBeenCalledWith(document.getElementById('conn-picker'));
  await connections.selectConnection('b');
  expect(api).not.toHaveBeenCalled();
  expect(state.activeConnection).toBe('a');
  canManageConnections.mockReturnValue(true);
  runtime.syncConnectionControls();
  expect(document.getElementById('conn-picker')).toHaveProperty('hidden', false);
});

test('app bootstrap uses authored app identities and never requests connection management', async () => {
  api.mockClear();
  canManageConnections.mockReturnValue(false);
  state.activeConnection = undefined;
  api.mockResolvedValueOnce({ appConfigured: true, active: 'atlas', apps: [{ id: 'atlas', name: 'Atlas', writable: true }] });
  await runtime.refreshConnections();
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/runtime']);
  expect(state.activeConnection).toBe('atlas');
  expect(document.getElementById('conn-picker')).toHaveProperty('hidden', true);
  api.mockClear();
  await connections.reintrospect();
  expect(api).not.toHaveBeenCalled();
});

test('early bootstrap selects a deep-linked App before schema loading and reuses safe runtime metadata', async () => {
  api.mockClear();
  canManageConnections.mockReturnValue(false);
  state.activeConnection = undefined;
  api.mockResolvedValueOnce({
    appConfigured: true,
    active: null,
    apps: [
      { id: 'atlas', name: 'Atlas', writable: true },
      { id: 'finance', name: 'Finance', writable: false },
    ],
  });
  await runtime.bootstrapRequestIdentity('finance');
  expect(state.activeConnection).toBe('finance');
  await runtime.initConnections(switched);
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/runtime']);
});

test('early bootstrap never treats a physical database name as an App or selects an arbitrary App', async () => {
  api.mockClear();
  state.activeConnection = undefined;
  api.mockResolvedValue({
    appConfigured: true,
    active: null,
    apps: [
      { id: 'atlas', name: 'Atlas', writable: true },
      { id: 'finance', name: 'Finance', writable: true },
    ],
  });
  /* Named as an address with no App behind it, with what is served, so the screen can say so rather than blame a database. */
  await expect(runtime.bootstrapRequestIdentity('production-database')).rejects.toMatchObject({
    name: 'UnknownAppError',
    message: 'No App at /production-database.',
    requested: 'production-database',
    apps: [
      { id: 'atlas', name: 'Atlas' },
      { id: 'finance', name: 'Finance' },
    ],
  });
  await expect(runtime.bootstrapRequestIdentity(undefined)).rejects.toThrow('Choose an application');
  expect(state.activeConnection).toBeUndefined();
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/runtime', '/api/runtime']);
});

test('malformed bootstrap metadata is distinguishable from an unavailable runtime', async () => {
  const { RuntimeMetadataError } = await import('../../../kit/src/client/requestIdentity.js');
  api.mockResolvedValueOnce({ appConfigured: true, active: 'atlas', apps: null });
  await expect(runtime.bootstrapRequestIdentity('atlas')).rejects.toBeInstanceOf(RuntimeMetadataError);
  const unavailable = Object.assign(new Error('Unavailable'), { status: 503 });
  api.mockRejectedValueOnce(unavailable);
  await expect(runtime.bootstrapRequestIdentity('atlas')).rejects.toBe(unavailable);
});

test('unavailable runtime metadata never falls back to the connection inventory', async () => {
  api.mockClear();
  api.mockRejectedValueOnce(new Error('Unavailable'));
  await runtime.refreshConnections();
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/runtime']);
  expect(document.getElementById('conn-picker')).toHaveProperty('hidden', true);
});

test('App runtime retains a selected authored app when its default names another app', async () => {
  api.mockClear();
  canManageConnections.mockReturnValue(false);
  state.activeConnection = 'finance';
  api.mockResolvedValueOnce({
    appConfigured: true,
    active: 'atlas',
    apps: [
      { id: 'atlas', name: 'Atlas', writable: true },
      { id: 'finance', name: 'Finance', writable: false },
    ],
  });
  await runtime.refreshConnections();
  expect(state.activeConnection).toBe('finance');
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/runtime']);
});

test('the former runtime source inventory is not accepted as an App list', async () => {
  api.mockClear();
  api.mockResolvedValueOnce({ appConfigured: true, active: 'physical', sources: [{ id: 'physical', name: 'Database' }] });
  await expect(runtime.refreshConnections()).rejects.toThrow('Invalid runtime application');
  expect(api.mock.calls.map(([path]) => path)).toEqual(['/api/runtime']);
});

test('boot cannot continue without a source after runtime metadata fails', async () => {
  state.activeConnection = undefined;
  api.mockRejectedValueOnce(new Error('Unavailable'));
  await expect(runtime.initConnections(switched)).rejects.toThrow('Application runtime is unavailable');
});

test('the latest selection owns schema, picker and completion even when the older response arrives last', async () => {
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const first = connections.selectConnection('b');
  await connections.selectConnection('c');
  old.resolve({ schema: schema('b') });
  await first;
  expect(state.activeConnection).toBe('c');
  expect(state.schema.label).toBe('c');
  expect(mounted.at(-1)?.active).toBe('c');
  expect(changed).toHaveBeenCalledTimes(1);
  expect(switched).toHaveBeenCalledTimes(1);
  expect(transitions.connectionTransitionPending()).toBe(false);
});

test('choosing the current connection supersedes a pending selection away from it', async () => {
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const first = connections.selectConnection('b');
  await connections.selectConnection('a');
  old.resolve({ schema: schema('b') });
  await first;
  expect(state.activeConnection).toBe('a');
  expect(state.schema.label).toBe('a');
  expect(api).toHaveBeenCalledWith('/api/connections/select', { id: 'a' });
});

test('a late failed selection neither reports an obsolete error nor refreshes the picker', async () => {
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const first = connections.selectConnection('b');
  await connections.selectConnection('c');
  const calls = api.mock.calls.length;
  old.reject(new Error('Old failure'));
  await first;
  expect(toast).not.toHaveBeenCalled();
  expect(api.mock.calls).toHaveLength(calls);
  expect(state.activeConnection).toBe('c');
});

test('a picker-list response cannot change this tab to the server default or outlive a transition', async () => {
  api.mockResolvedValueOnce({ appConfigured: false }).mockResolvedValueOnce(list('c'));
  await runtime.refreshConnections();
  expect(state.activeConnection).toBe('a');
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const refreshing = runtime.refreshConnections();
  await connections.selectConnection('b');
  const mounts = mounted.length;
  old.resolve({ appConfigured: false });
  await refreshing;
  expect(state.activeConnection).toBe('b');
  expect(mounted).toHaveLength(mounts);
});

test('schema refresh cannot overwrite a newer connection selection', async () => {
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const refreshing = mounted[0].onReintrospect();
  await connections.selectConnection('b');
  old.resolve({ schema: schema('Refreshed a') });
  await refreshing;
  expect(state.schema.label).toBe('b');
  expect(clearPeekCache).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

test('a switch waiting for its dependent loads cannot render after a newer switch', async () => {
  const old = deferred();
  let guard!: () => boolean;
  switched.mockImplementationOnce(async (isCurrent) => {
    guard = isCurrent;
    await old.promise;
  });
  const first = connections.selectConnection('b');
  await vi.waitFor(() => expect(switched).toHaveBeenCalledTimes(1));
  await connections.selectConnection('c');
  expect(guard()).toBe(false);
  old.resolve({});
  await first;
  expect(render).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
});

test('picker operations share ownership with other transition entry points', async () => {
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const first = connections.selectConnection('b');
  const deepLink = transitions.beginConnectionTransition();
  old.resolve({ schema: schema('b') });
  await first;
  expect(state.activeConnection).toBe('a');
  expect(deepLink.isCurrent()).toBe(true);
  expect(transitions.connectionTransitionPending()).toBe(true);
  deepLink.finish();
  expect(transitions.connectionTransitionPending()).toBe(false);
});

test('a current selection failure keeps the original schema and reports the failure', async () => {
  api.mockRejectedValueOnce(new Error('Unavailable'));
  await connections.selectConnection('b');
  expect(state.activeConnection).toBe('a');
  expect(state.schema.label).toBe('a');
  expect(toast).toHaveBeenCalledWith('Unavailable', 'error');
  expect(transitions.connectionTransitionPending()).toBe(false);
});

test('boot adopts the server default only before this tab has selected a connection', async () => {
  state.activeConnection = undefined;
  api.mockResolvedValueOnce({ appConfigured: false }).mockResolvedValueOnce(list('b'));
  await runtime.refreshConnections();
  expect(state.activeConnection).toBe('b');
  expect(mounted.at(-1)?.active).toBe('b');
});

test('a current schema refresh publishes its schema and notifies long-lived views once', async () => {
  api.mockResolvedValueOnce({ schema: schema('Refreshed a') });
  await mounted[0].onReintrospect();
  expect(state.schema.label).toBe('Refreshed a');
  expect(clearPeekCache).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledOnce();
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('Schema re-read'), 'ok');
  expect(transitions.connectionTransitionPending()).toBe(false);
});

test('introspecting another connection never publishes its schema into this tab', async () => {
  await connections.reintrospect('b');
  expect(api).toHaveBeenCalledWith('/api/connections/refresh', { id: 'b' });
  expect(state.activeConnection).toBe('a');
  expect(state.schema.label).toBe('a');
  expect(changed).not.toHaveBeenCalled();
});

test('an explicit reload rebuilds the current connection after its target is edited', async () => {
  api.mockResolvedValueOnce({ schema: schema('retargeted a') });
  await connections.selectConnection('a', { reload: true });
  expect(state.activeConnection).toBe('a');
  expect(state.schema.label).toBe('retargeted a');
  expect(changed).toHaveBeenCalledOnce();
});

test('a stale picker-list failure cannot hide a newer successful picker', async () => {
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const refreshing = runtime.refreshConnections();
  await runtime.refreshConnections();
  old.reject(new Error('Old list failed'));
  await refreshing;
  expect(document.getElementById('conn-picker')?.hidden).toBe(false);
});

test('a failed newer switch recovers the schema whose dependent loads it superseded', async () => {
  const old = deferred();
  switched.mockImplementationOnce(async () => {
    await old.promise;
  });
  const first = connections.selectConnection('b');
  await vi.waitFor(() => expect(switched).toHaveBeenCalledTimes(1));
  expect(state.activeConnection).toBe('b');
  api.mockRejectedValueOnce(new Error('C unavailable'));
  await connections.selectConnection('c');
  expect(switched).toHaveBeenCalledTimes(2);
  expect(state.schema.label).toBe('b');
  expect(render).toHaveBeenCalledOnce();
  old.resolve({});
  await first;
  expect(render).toHaveBeenCalledOnce();
  expect(toast).toHaveBeenCalledWith('C unavailable', 'error');
});
