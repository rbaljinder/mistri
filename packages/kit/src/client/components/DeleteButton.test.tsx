import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { establishSessionIdentity, establishTenantSelection, lockSessionIdentity, requireTenantSelection } from '../sessionIdentity.js';
import { tenantMutationState } from '../../../../mistri/src/client/tenantMutationState.js';
import type { DeleteButtonHost } from './DeleteButton.js';

const mock = vi.hoisted(() => ({
  api: vi.fn(),
  go: vi.fn(),
  toast: vi.fn(),
  refresh: vi.fn(),
  state: { activeConnection: 'app' },
  undoToast: vi.fn((undoId: unknown, after?: () => void) =>
    undoId === undefined ? undefined : { label: 'Undo', undoId, run: async () => after?.() },
  ),
}));
vi.mock('../core.js', () => ({ api: mock.api, go: mock.go, toast: mock.toast, state: mock.state }));
vi.mock('../delete.js', () => ({ canDelete: () => true }));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: mock.refresh, undoToast: mock.undoToast }));
vi.mock('@mistriwork/ui/Modal.js', () => ({ Modal: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div> }));
const { DeleteButton } = await import('./DeleteButton.js');
const table: TableMeta = { id: 'ticket', name: 'Ticket', schema: '', isView: false, columns: [] };
beforeEach(bridgeShell);

beforeEach(() => {
  vi.clearAllMocks();
  mock.api.mockReset();
  mock.state.activeConnection = 'app';
  history.replaceState({}, '', '/');
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
});
afterEach(() => {
  cleanup();
  lockSessionIdentity();
});

function selectTenant() {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'app' });
  requireTenantSelection();
  establishTenantSelection({
    appId: 'app',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'tab-one',
    context: 'north-context',
    revision: 1,
    expiresAt: Date.now() + 60_000,
  });
}
function deletionReply() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function draw(recordKey: Record<string, unknown> = { id: 1 }, host?: DeleteButtonHost) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <DeleteButton table={table} recordKey={recordKey} label="One" host={host} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
async function confirm() {
  const user = draw();
  await user.click(screen.getByRole('button', { name: 'Delete…' }));
  await user.click(await screen.findByRole('button', { name: 'Delete' }));
}
test.each([
  { name: 'empty', key: {} },
  { name: 'missing value', key: { id: undefined } },
  { name: 'null value', key: { id: null } },
  { name: 'object value', key: { id: {} } },
  { name: 'nonfinite value', key: { id: Infinity } },
])('an invalid $name preview key neither sends nor gates deletion', async ({ key }) => {
  const user = draw(key);
  const button = screen.getByRole('button', { name: 'Delete…' });
  await user.click(button);
  expect(mock.toast).toHaveBeenCalledWith('This record has no usable key.', 'error');
  expect(button).toBeEnabled();
  await user.click(button);
  expect(mock.toast).toHaveBeenCalledTimes(2);
  expect(button).toBeEnabled();
  expect(mock.api).not.toHaveBeenCalled();
  expect(mock.refresh).not.toHaveBeenCalled();
  expect(mock.go).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test.each([
  { timing: 'pending', replacement: 'another-record' },
  { timing: 'pending', replacement: null },
  { timing: 'ready', replacement: 'another-record' },
  { timing: 'ready', replacement: null },
])('confirmation uses the detached preview key when original changes while $timing to $replacement', async ({ timing, replacement }) => {
  const original: Record<string, unknown> = { id: '9007199254740993', part: 2 };
  const captured = { ...original };
  let resolvePreview!: (value: unknown) => void;
  mock.api
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreview = resolve;
        }),
    )
    .mockResolvedValueOnce({ deleted: true, affected: 1, undoId: 3 });
  const user = draw(original);
  await user.click(screen.getByRole('button', { name: 'Delete…' }));
  expect(mock.api).toHaveBeenCalledWith('/api/delete', { table: table.id, key: captured });
  expect(mock.api.mock.calls[0][1].key).not.toBe(original);
  if (timing === 'pending') {
    original.id = replacement;
    original.part = 99;
  }
  await act(async () => {
    resolvePreview({ deleted: false, impact: [] });
  });
  const confirmButton = await screen.findByRole('button', { name: 'Delete' });
  if (timing === 'ready') {
    original.id = replacement;
    original.part = 99;
  }
  await user.click(confirmButton);
  await waitFor(() => expect(mock.go).toHaveBeenCalledOnce());
  expect(mock.api).toHaveBeenCalledTimes(2);
  expect(mock.api).toHaveBeenNthCalledWith(2, '/api/delete', { table: table.id, key: captured, confirm: true });
  expect(mock.api.mock.calls[0][1].key).toEqual(captured);
  expect(mock.refresh).toHaveBeenCalledOnce();
  expect(mock.toast).toHaveBeenCalledWith('Deleted Ticket One.', 'ok', expect.objectContaining({ label: 'Undo' }));
});

test('confirmed deletion refreshes Undo, navigates to the collection and offers Undo of exactly that deletion', async () => {
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockResolvedValueOnce({ deleted: true, affected: 1, undoId: 3 });
  await confirm();
  await waitFor(() => expect(mock.go).toHaveBeenCalledOnce());
  expect(mock.refresh).toHaveBeenCalledOnce();
  expect(mock.undoToast).toHaveBeenCalledExactlyOnceWith(3, expect.any(Function));
  expect(mock.toast).toHaveBeenCalledWith('Deleted Ticket One.', 'ok', expect.objectContaining({ label: 'Undo', undoId: 3 }));
});

test('a deletion without an Undo entry (a cascade, an incomplete original) confirms without offering one', async () => {
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockResolvedValueOnce({ deleted: true, affected: 1 });
  await confirm();
  await waitFor(() => expect(mock.go).toHaveBeenCalledOnce());
  expect(mock.toast).toHaveBeenCalledWith('Deleted Ticket One.', 'ok', undefined);
});
test.each(['unknown', 'network'])('%s deletion stays locked without claiming failure or retrying', async (fault) => {
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] });
  if (fault === 'unknown') mock.api.mockResolvedValueOnce({ deleted: null, outcome: 'unknown', errors: [{ message: 'Unconfirmed' }] });
  else mock.api.mockRejectedValueOnce(new Error('Lost response'));
  await confirm();
  await waitFor(() => expect(mock.toast).toHaveBeenCalledWith(expect.stringContaining('Deletion was not confirmed'), 'error'));
  expect(screen.getByRole('button', { name: 'Delete…' })).toBeDisabled();
  expect(mock.go).not.toHaveBeenCalled();
  expect(mock.refresh).toHaveBeenCalledOnce();
  expect(mock.api).toHaveBeenCalledTimes(2);
});
test.each(['http', 'result'])('confirmed %s rejection permits a deliberate retry without changing Undo', async (fault) => {
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] });
  if (fault === 'http') mock.api.mockRejectedValueOnce(Object.assign(new Error('Denied'), { status: 403 }));
  else mock.api.mockResolvedValueOnce({ deleted: false, outcome: 'rejected', errors: [{ message: 'Denied' }] });
  await confirm();
  await waitFor(() => expect(mock.toast).toHaveBeenCalledWith('Denied', 'error'));
  expect(screen.getByRole('button', { name: 'Delete…' })).toBeEnabled();
  expect(mock.refresh).not.toHaveBeenCalled();
  expect(mock.go).not.toHaveBeenCalled();
});
test('an uncertain preview never opens a destructive confirmation', async () => {
  mock.api.mockResolvedValue({ deleted: null, outcome: 'unknown', errors: [{ message: 'Preview unavailable' }] });
  const user = draw();
  await user.click(screen.getByRole('button', { name: 'Delete…' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(mock.toast).toHaveBeenCalledWith('Preview unavailable', 'error');
  expect(mock.api).toHaveBeenCalledTimes(1);
});
test.each(['account', 'connection', 'route'])('pending deletion is gated and late success cannot affect another %s', async (boundary) => {
  let resolve!: (value: unknown) => void;
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await confirm();
  expect(screen.getByRole('button', { name: 'Delete…' })).toBeDisabled();
  if (boundary === 'account') lockSessionIdentity();
  else if (boundary === 'connection') mock.state.activeConnection = 'other';
  else history.pushState({}, '', '/elsewhere');
  await act(async () => {
    resolve({ deleted: true });
  });
  expect(mock.toast).not.toHaveBeenCalled();
  expect(mock.refresh).not.toHaveBeenCalled();
  expect(mock.go).not.toHaveBeenCalled();
});

test('explicit unknown HTTP 403 keeps deletion blocked rather than treating it as a retryable denial', async () => {
  mock.api
    .mockResolvedValueOnce({ deleted: false, impact: [] })
    .mockRejectedValueOnce(Object.assign(new Error('Acknowledgement could not be verified'), { status: 403, outcome: 'unknown' }));
  await confirm();
  await waitFor(() => expect(mock.toast).toHaveBeenCalledWith(expect.stringContaining('Deletion was not confirmed'), 'error'));
  const button = screen.getByRole('button', { name: 'Delete…' });
  expect(button).toBeDisabled();
  await userEvent.setup().click(button);
  expect(mock.api).toHaveBeenCalledTimes(2);
  expect(mock.refresh).toHaveBeenCalledOnce();
  expect(mock.go).not.toHaveBeenCalled();
});

test.each(['not_applied', 'rejected'])(
  'explicit %s deletion failure permits deliberate retry independently of HTTP 503',
  async (outcome) => {
    mock.api
      .mockResolvedValueOnce({ deleted: false, impact: [] })
      .mockRejectedValueOnce(Object.assign(new Error('Definitely not deleted'), { status: 503, outcome }));
    await confirm();
    await waitFor(() => expect(mock.toast).toHaveBeenCalledWith('Definitely not deleted', 'error'));
    const button = screen.getByRole('button', { name: 'Delete…' });
    expect(button).toBeEnabled();
    expect(mock.refresh).not.toHaveBeenCalled();
    expect(mock.go).not.toHaveBeenCalled();
    mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockResolvedValueOnce({ deleted: true, affected: 1 });
    const user = userEvent.setup();
    await user.click(button);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mock.go).toHaveBeenCalledOnce());
    expect(mock.api).toHaveBeenCalledTimes(4);
  },
);

test.each([
  ['applied', false],
  ['rejected', false],
  ['not_applied', false],
  ['applied', true],
  ['rejected', true],
  ['not_applied', true],
] as const)('tenant delete %s settles its pending tracker (whole record unmounted=%s)', async (outcome, unmounted) => {
  selectTenant();
  const reply = deletionReply();
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockImplementationOnce(() => reply.promise);
  const user = draw();
  await user.click(screen.getByRole('button', { name: 'Delete…' }));
  const button = await screen.findByRole('button', { name: 'Delete' });
  expect(tenantMutationState.hasUnresolved()).toBe(false);
  await user.click(button);
  await waitFor(() => expect(mock.api).toHaveBeenCalledTimes(2));
  // The real confirmation closes before mutationFn starts; its unmount cannot
  // remove the attempt. Also exercise losing the entire record afterward.
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  if (unmounted) cleanup();
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  await act(async () => {
    if (outcome === 'applied') reply.resolve({ deleted: true, affected: 1, outcome: 'applied' });
    else if (outcome === 'rejected') reply.resolve({ deleted: false, errors: [{ message: 'Denied' }], outcome: 'rejected' });
    else reply.reject(Object.assign(new Error('Denied'), { outcome: 'not_applied', status: 503 }));
  });
  await waitFor(() => expect(tenantMutationState.hasUnresolved()).toBe(false));
  expect(mock.api).toHaveBeenCalledTimes(2);
});

test.each(['network', 'response'])('tenant delete %s uncertainty survives record unmount', async (fault) => {
  selectTenant();
  const reply = deletionReply();
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockImplementationOnce(() => reply.promise);
  await confirm();
  await waitFor(() => expect(mock.api).toHaveBeenCalledTimes(2));
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  cleanup();
  const revision = tenantMutationState.version();
  await act(async () => {
    if (fault === 'network') reply.reject(new Error('Response lost'));
    else reply.resolve({ deleted: null, errors: [{ message: 'Unconfirmed' }], outcome: 'unknown' });
  });
  await waitFor(() => expect(tenantMutationState.version()).toBeGreaterThan(revision));
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  expect(mock.api).toHaveBeenCalledTimes(2);
  expect(mock.go).not.toHaveBeenCalled();
  lockSessionIdentity();
  expect(tenantMutationState.hasUnresolved()).toBe(false);
});

test.each(['applied', 'rejected', 'unknown'])(
  'late tenant delete %s cannot settle a new login attempt with the same context token',
  async (outcome) => {
    selectTenant();
    const oldReply = deletionReply(),
      newReply = deletionReply();
    mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockImplementationOnce(() => oldReply.promise);
    await confirm();
    await waitFor(() => expect(mock.api).toHaveBeenCalledTimes(2));
    expect(tenantMutationState.hasUnresolved()).toBe(true);
    cleanup();
    lockSessionIdentity();
    expect(tenantMutationState.hasUnresolved()).toBe(false);
    selectTenant();
    mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockImplementationOnce(() => newReply.promise);
    await confirm();
    await waitFor(() => expect(mock.api).toHaveBeenCalledTimes(4));
    const revision = tenantMutationState.version();
    await act(async () => {
      if (outcome === 'applied') oldReply.resolve({ deleted: true, affected: 1 });
      else oldReply.resolve({ deleted: outcome === 'rejected' ? false : null, errors: [{ message: 'Old result' }], outcome });
    });
    expect(tenantMutationState.hasUnresolved()).toBe(true);
    expect(tenantMutationState.version()).toBe(revision);
    expect(screen.getByRole('button', { name: 'Delete…' })).toBeDisabled();
    expect(mock.go).not.toHaveBeenCalled();
    expect(mock.toast).not.toHaveBeenCalled();
    expect(mock.refresh).not.toHaveBeenCalled();
    await act(async () => {
      newReply.resolve({ deleted: true, affected: 1 });
    });
    await waitFor(() => expect(tenantMutationState.hasUnresolved()).toBe(false));
    await waitFor(() => expect(mock.go).toHaveBeenCalledOnce());
  },
);

test('ordinary delete never enters the tenant tracker, including after an unknown response', async () => {
  const reply = deletionReply();
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockImplementationOnce(() => reply.promise);
  await confirm();
  await waitFor(() => expect(mock.api).toHaveBeenCalledTimes(2));
  expect(tenantMutationState.hasUnresolved()).toBe(false);
  await act(async () => {
    reply.reject(new Error('Response lost'));
  });
  await waitFor(() => expect(mock.toast).toHaveBeenCalledWith(expect.stringContaining('Deletion was not confirmed'), 'error'));
  expect(tenantMutationState.hasUnresolved()).toBe(false);
});

function surfaceHost(): DeleteButtonHost {
  return { isCurrent: vi.fn(() => true), onDeleted: vi.fn(), onStateChange: vi.fn() };
}

test.each(['preview', 'confirmation', 'mutation'])('same-URL host retirement fences deletion during %s', async (timing) => {
  const host = surfaceHost(),
    reply = deletionReply();
  mock.api
    .mockImplementationOnce(() => (timing === 'preview' ? reply.promise : Promise.resolve({ deleted: false, impact: [] })))
    .mockImplementationOnce(() => reply.promise);
  const user = draw({ id: 1 }, host);
  await user.click(screen.getByRole('button', { name: 'Delete…' }));
  if (timing === 'mutation') await user.click(await screen.findByRole('button', { name: 'Delete' }));
  vi.mocked(host.isCurrent).mockReturnValue(false);
  if (timing === 'confirmation') await user.click(await screen.findByRole('button', { name: 'Delete' }));
  await act(async () => {
    reply.resolve(timing === 'preview' ? { deleted: false, impact: [] } : { deleted: true });
  });
  expect(mock.api).toHaveBeenCalledTimes(timing === 'mutation' ? 2 : 1);
  expect(host.onDeleted).not.toHaveBeenCalled();
  expect(mock.go).not.toHaveBeenCalled();
  expect(mock.toast).not.toHaveBeenCalled();
  expect(host.onStateChange).toHaveBeenCalledTimes(timing === 'mutation' ? 1 : 0);
  if (timing === 'preview') expect(screen.queryByRole('dialog')).toBeNull();
});

test.each(['applied', 'rejected', 'unknown', 'network'])(
  'ordinary host retains pending then %s without using tenant tracking or routing',
  async (outcome) => {
    const host = surfaceHost(),
      reply = deletionReply();
    const phases: string[] = [];
    host.onStateChange = vi.fn((phase) => {
      if (phase === 'pending') {
        expect(screen.getByRole('dialog')).toBeInTheDocument();
        expect(mock.api).toHaveBeenCalledTimes(1); // fence installed before dispatch/close
      }
      phases.push(phase);
    });
    mock.api.mockResolvedValueOnce({ deleted: false, impact: [] }).mockImplementationOnce(() => reply.promise);
    const user = draw({ id: 1 }, host);
    await user.click(screen.getByRole('button', { name: 'Delete…' }));
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    expect(phases).toEqual(['pending']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(tenantMutationState.hasUnresolved()).toBe(false);
    await act(async () => {
      if (outcome === 'network') reply.reject(new Error('Lost acknowledgement'));
      else reply.resolve({ deleted: outcome === 'applied' ? true : outcome === 'rejected' ? false : null, outcome });
    });
    await waitFor(() => expect(phases).toEqual(['pending', outcome === 'network' || outcome === 'unknown' ? 'uncertain' : outcome]));
    expect(host.onDeleted).toHaveBeenCalledTimes(outcome === 'applied' ? 1 : 0);
    expect(mock.go).not.toHaveBeenCalled();
    if (outcome !== 'applied') expect(screen.getByRole('button', { name: 'Delete…' })).toHaveProperty('disabled', outcome !== 'rejected');
    cleanup();
    expect(phases).toHaveLength(2); // cleanup never emits an idle/retry permission
  },
);

test('host must retain pending synchronously or deletion fails closed before dispatch', async () => {
  const host = surfaceHost();
  host.onStateChange = () => {
    throw new Error('Host unavailable');
  };
  mock.api.mockResolvedValueOnce({ deleted: false, impact: [] });
  const user = draw({ id: 1 }, host);
  await user.click(screen.getByRole('button', { name: 'Delete…' }));
  await user.click(await screen.findByRole('button', { name: 'Delete' }));
  expect(mock.api).toHaveBeenCalledOnce();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});
