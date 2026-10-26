import { beforeEach, expect, test, vi } from 'vitest';
import { setAppConfigured } from '../../../kit/src/client/connectionScope.js';
import {
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
} from '../../../kit/src/client/sessionIdentity.js';

const { api, toast, invalidateQueries, state } = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  invalidateQueries: vi.fn().mockResolvedValue(undefined),
  state: { activeConnection: 'app', canWrite: false },
}));
vi.mock('../../../kit/src/client/core.js', () => ({ api, toast, state }));
vi.mock('../../../kit/src/client/components/mount.js', () => ({ queryClient: { invalidateQueries } }));
import { canUndo, initUndo, refreshUndo, undoDescription, undoEntry, undoLast, undoToast } from './undo.js';

const preview = (id = 2) => ({ next: { id, summary: `Write ${id}` }, writes: [] });
const deferred = () => {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
beforeEach(() => {
  vi.clearAllMocks();
  api.mockReset();
  setAppConfigured(false); // These history and uncertainty cases exercise the Workbench.
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
  state.activeConnection = 'app';
  state.canWrite = false;
});
async function offer(id = 2) {
  api.mockResolvedValueOnce(preview(id));
  await refreshUndo();
}

test('captures the offered ID, gates duplicate calls and refreshes after applied Undo', async () => {
  await offer();
  const result = deferred();
  api.mockReturnValueOnce(result.promise).mockResolvedValueOnce(preview(1));
  const undo = undoLast();
  expect(canUndo()).toBe(false);
  await undoLast();
  expect(api).toHaveBeenCalledTimes(2);
  expect(api).toHaveBeenLastCalledWith('/api/revert', { conn: 'app', confirm: true, expectedId: 2 });
  result.resolve({ reverted: true, outcome: 'applied', undone: { summary: 'Write 2' } });
  await undo;
  expect(invalidateQueries).toHaveBeenCalledTimes(1);
  expect(toast).toHaveBeenCalledWith('Undone: Write 2.', 'ok');
  expect(undoDescription()).toBe('Write 1');
});

test.each(['unknown', 'network', 'malformed'])('%s cannot retry the same write or fall through to older history', async (kind) => {
  await offer();
  if (kind === 'network') api.mockRejectedValueOnce(new Error('Lost response'));
  else api.mockResolvedValueOnce(kind === 'unknown' ? { reverted: true, outcome: 'unknown' } : {});
  api.mockResolvedValueOnce(preview(1));
  await undoLast();
  expect(toast).toHaveBeenCalledWith(expect.stringContaining('Undo was not confirmed'), 'error');
  expect(invalidateQueries).toHaveBeenCalledTimes(1);
  expect(canUndo()).toBe(false);
  await offer(2);
  expect(canUndo()).toBe(false);
  await undoLast();
  expect(api.mock.calls.filter(([, body]) => body.confirm)).toHaveLength(1);
  await offer(3);
  expect(canUndo()).toBe(true);
  api.mockResolvedValueOnce({ reverted: true, outcome: 'applied' }).mockResolvedValueOnce(preview(1));
  await undoLast();
  expect(canUndo()).toBe(false);
});

test('known refusal refreshes history without claiming success or refreshing stored data', async () => {
  await offer();
  api
    .mockResolvedValueOnce({ reverted: false, outcome: 'not_applied', errors: [{ message: 'The row changed.' }] })
    .mockResolvedValueOnce(preview());
  await undoLast();
  expect(toast).toHaveBeenCalledWith('The row changed.', 'error');
  expect(invalidateQueries).not.toHaveBeenCalled();
  expect(canUndo()).toBe(true);
});

test('unknown feedback does not wait for history, and a failed refresh does not release the barrier', async () => {
  await offer();
  const history = deferred();
  api.mockRejectedValueOnce(new Error('Lost response')).mockReturnValueOnce(history.promise);
  const undo = undoLast();
  await vi.waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining('Undo was not confirmed'), 'error'));
  expect(canUndo()).toBe(false);
  history.reject(new Error('Still offline'));
  await undo;
  await offer(1);
  expect(canUndo()).toBe(false);
});

test('a stale expected ID is a known refusal; the new preview requires another deliberate Undo', async () => {
  await offer();
  api
    .mockRejectedValueOnce(Object.assign(new Error('History changed.'), { status: 409, outcome: 'not_applied' }))
    .mockResolvedValueOnce(preview(3));
  await undoLast();
  expect(toast).toHaveBeenCalledWith('History changed.', 'error');
  expect(undoDescription()).toBe('Write 3');
  expect(api.mock.calls.filter(([, body]) => body.confirm)).toHaveLength(1);
});

test.each(['resolve', 'reject'])('a late %s cannot publish into a new account or clear its pending gate', async (settle) => {
  await offer();
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const undo = undoLast();
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'app' });
  await offer(4);
  const recent = deferred();
  api.mockReturnValueOnce(recent.promise);
  const newUndo = undoLast();
  if (settle === 'resolve') old.resolve({ reverted: true, outcome: 'applied' });
  else old.reject(new Error('Lost response'));
  await undo;
  expect(canUndo()).toBe(false);
  expect(toast).not.toHaveBeenCalled();
  expect(invalidateQueries).not.toHaveBeenCalled();
  api.mockResolvedValueOnce({});
  recent.resolve({ reverted: true, outcome: 'applied' });
  await newUndo;
  expect(toast).toHaveBeenCalledTimes(1);
});

test('connection navigation suppresses late feedback but retains uncertainty on returning', async () => {
  await offer();
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const undo = undoLast();
  state.activeConnection = 'other';
  old.reject(new Error('Lost response'));
  await undo;
  expect(toast).not.toHaveBeenCalled();
  expect(invalidateQueries).not.toHaveBeenCalled();
  await offer(1);
  expect(canUndo()).toBe(true);
  state.activeConnection = 'app';
  await offer(2);
  expect(canUndo()).toBe(false);
});

test('out-of-order previews and previews from a previous session cannot replace current history', async () => {
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const refresh = refreshUndo();
  await offer(3);
  old.resolve(preview(2));
  await refresh;
  expect(undoDescription()).toBe('Write 3');
  const stale = deferred();
  api.mockReturnValueOnce(stale.promise);
  const priorSession = refreshUndo();
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'app' });
  await offer(4);
  stale.resolve(preview(3));
  await priorSession;
  expect(undoDescription()).toBe('Write 4');
});

test('session change while refreshing after Undo suppresses the old success toast', async () => {
  await offer();
  const refresh = deferred();
  api.mockResolvedValueOnce({ reverted: true, outcome: 'applied' }).mockReturnValueOnce(refresh.promise);
  const undo = undoLast();
  await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(3));
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'app' });
  refresh.resolve(preview(1));
  await undo;
  expect(toast).not.toHaveBeenCalled();
  expect(canUndo()).toBe(false);
});

function selectTenant(tenantId = 'north', context = 'north-context') {
  state.canWrite = true;
  requireTenantSelection();
  return establishTenantSelection({
    appId: 'app',
    accountId: 'alice',
    tenantId,
    tabId: 'tab-one',
    context,
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
}
const tenantPreview = (id: unknown, summary = 'Tenant write') => ({ next: { id, summary }, writes: [{ id, summary }] });
test.each([false, true])('tenant menu/history/explicit Undo remain withheld with canWrite=%s', async (writable) => {
  selectTenant();
  state.canWrite = writable;
  api.mockResolvedValue(tenantPreview('private-history-token'));
  await refreshUndo();
  expect(canUndo()).toBe(false);
  expect(undoDescription()).toBeNull();
  for (const token of [undefined, 'private-history-token', '9007199254740993', 2]) await undoLast(token);
  expect(api).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  expect(invalidateQueries).not.toHaveBeenCalled();
});

test('tenant keyboard Undo stays withheld even when editing is enabled', async () => {
  selectTenant();
  initUndo();
  for (const modifier of ['ctrlKey', 'metaKey']) {
    const event = new KeyboardEvent('keydown', { key: 'z', [modifier]: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  }
  await Promise.resolve();
  expect(api).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
});

test('ordinary offered history is retired when entering a writable tenant context', async () => {
  await offer();
  expect(canUndo()).toBe(true);
  api.mockClear();
  selectTenant();
  await refreshUndo();
  await undoLast(2);
  expect(canUndo()).toBe(false);
  expect(undoDescription()).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

test('direct tenant undoEntry is absent even with a valid opaque history token', async () => {
  selectTenant();
  expect(await undoEntry('app', 'opaque:token-9007199254740993')).toBeUndefined();
  expect(api).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  expect(invalidateQueries).not.toHaveBeenCalled();
  expect(undoDescription()).toBeNull();
  expect(canUndo()).toBe(false);
});

test.each([1, 42, 0, -1, null, '', ' leading', 'trailing ', 'line\nbreak', 'x'.repeat(129)])(
  'tenant UI and direct Undo remain absent for token %j',
  async (token) => {
    selectTenant();
    await refreshUndo();
    expect(canUndo()).toBe(false);
    expect(undoDescription()).toBeNull();
    api.mockClear();
    await Reflect.apply(undoEntry, undefined, ['app', token]);
    expect(api).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  },
);

test.each([false, true])('an App has no history, confirmation or direct Undo with editing enabled=%s', async (writable) => {
  setAppConfigured(true);
  state.canWrite = writable;
  const onUnknown = vi.fn();
  await refreshUndo();
  await undoLast(7);
  expect(await undoEntry('app', 7, onUnknown)).toBeUndefined();
  expect(undoToast(7)).toBeUndefined();
  expect(canUndo()).toBe(false);
  expect(undoDescription()).toBeNull();
  expect(api).not.toHaveBeenCalled();
  expect(onUnknown).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  expect(invalidateQueries).not.toHaveBeenCalled();
});

test('explicit not_applied on Workbench Undo permits another deliberate attempt, not quarantine', async () => {
  api
    .mockRejectedValueOnce(Object.assign(new Error('Known rollback'), { status: 503, outcome: 'not_applied' }))
    .mockResolvedValueOnce(preview(7));
  expect(await undoEntry('app', 7)).toMatchObject({ outcome: 'not_applied' });
  expect(invalidateQueries).not.toHaveBeenCalled();
  api.mockResolvedValueOnce({ reverted: true, outcome: 'applied' }).mockResolvedValueOnce(preview(6));
  expect(await undoEntry('app', 7)).toMatchObject({ reverted: true });
  expect(api.mock.calls.filter(([, body]) => body.confirm)).toHaveLength(2);
  expect(toast).not.toHaveBeenCalled();
});

test('late ordinary preview cannot republish after entering a writable tenant context', async () => {
  const old = deferred();
  api.mockReturnValueOnce(old.promise);
  const refresh = refreshUndo();
  selectTenant();
  await refreshUndo();
  old.resolve(preview());
  await refresh;
  expect(undoDescription()).toBeNull();
  expect(canUndo()).toBe(false);
  expect(api).toHaveBeenCalledTimes(1);
});

test('a read-only connection is not asked for history it cannot have', async () => {
  (state as { connections?: unknown }).connections = [{ id: 'app', writable: false }];
  try {
    await refreshUndo();
    expect(api).not.toHaveBeenCalled();
    expect(canUndo()).toBe(false);
  } finally {
    delete (state as { connections?: unknown }).connections;
  }
});

test("a confirmation's Undo reverts exactly its own entry, then runs its follow-up", async () => {
  const after = vi.fn();
  const action = undoToast(7, after);
  expect(action?.label).toBe('Undo');
  api
    .mockResolvedValueOnce({ reverted: true, outcome: 'applied', undone: { summary: 'Created task 9' } })
    .mockResolvedValueOnce(preview(6));
  await action!.run();
  expect(api).toHaveBeenNthCalledWith(1, '/api/revert', { conn: 'app', confirm: true, expectedId: 7 });
  expect(toast).toHaveBeenCalledWith('Undone: Created task 9.', 'ok');
  expect(after).toHaveBeenCalledOnce();
});

test("a refused confirmation Undo says the server's sentence and leaves the page where it is", async () => {
  const after = vi.fn();
  api
    .mockResolvedValueOnce({ reverted: false, outcome: 'not_applied', errors: [{ message: 'The record changed after this was saved.' }] })
    .mockResolvedValueOnce(preview(8));
  await undoToast(7, after)!.run();
  expect(toast).toHaveBeenCalledWith('The record changed after this was saved.', 'error');
  expect(after).not.toHaveBeenCalled();
  expect(invalidateQueries).not.toHaveBeenCalled();
});

test('a confirmation Undo belongs to the session and connection that wrote, and is not offered without an entry or in a tenant', async () => {
  expect(undoToast(undefined)).toBeUndefined();
  expect(undoToast('7')).toBeUndefined();
  const action = undoToast(7)!;
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'bob', appId: 'app' });
  await action.run();
  const elsewhere = undoToast(8)!;
  state.activeConnection = 'other';
  await elsewhere.run();
  expect(api).not.toHaveBeenCalled();
  expect(toast).not.toHaveBeenCalled();
  state.activeConnection = 'app';
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
  selectTenant();
  expect(undoToast(9)).toBeUndefined();
});
