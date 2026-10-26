import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  captureTenantLease,
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
  sessionIdentity,
  sessionStorageKey,
  tenantLeaseActive,
} from '../../../kit/src/client/sessionIdentity.js';
import { startTenantRenewal } from './tenantRenewal.js';
import { tenantSuspensionOverlay } from './tenantSuspension.js';
import { tenantMutationState } from './tenantMutationState.js';
import { commandOperations, type CommandOwner } from './commandState.js';
import type { AppCommandAction } from '../shared/app.js';

const { api, state } = vi.hoisted(() => ({ api: vi.fn(), state: { activeConnection: 'atlas' } }));
vi.mock('../../../kit/src/client/core.js', () => ({
  api,
  state,
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
const { CommandForm } = await import('./components/CommandForm.js');
let controller: ReturnType<typeof startTenantRenewal> | undefined;
let overlay: ReturnType<typeof tenantSuspensionOverlay> | undefined;
const clients: QueryClient[] = [];
const renew = vi.fn();
beforeEach(() => {
  establishSessionIdentity({ signedIn: true, accountId: 'alice', appId: 'atlas' });
  requireTenantSelection();
  establishTenantSelection({
    appId: 'atlas',
    accountId: 'alice',
    tenantId: 'north',
    tabId: 'tab',
    context: 'context',
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
  renew.mockReset();
  renew.mockImplementation(async (_owner, lease) => ({ ...lease, revision: lease.revision + 1, expiresAt: Date.now() + 60000 }));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  api.mockReset();
});
afterEach(() => {
  controller?.stop();
  controller = undefined;
  overlay?.close(false);
  overlay = undefined;
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  lockSessionIdentity();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
function monitor() {
  const retry = vi.fn(() => {
    void controller!.check().catch(() => {});
  });
  overlay = tenantSuspensionOverlay(retry);
  controller = startTenantRenewal({ renew, onState: overlay.update });
  return { retry, controller, overlay };
}

test.each(['record', 'New', 'command portal'])(
  '%s draft, original, DOM node, focus and selection survive suspension and renewal',
  async (kind) => {
    const mounted = vi.fn(),
      unmounted = vi.fn(),
      original = Object.freeze({ value: 'Original' });
    function Form() {
      const [value, setValue] = useState<string>(original.value);
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      const form = (
        <form>
          <label>
            Draft
            <input value={value} onChange={(event) => setValue(event.target.value)} />
          </label>
        </form>
      );
      return kind === 'command portal' ? createPortal(form, document.body) : form;
    }
    render(<Form />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Unsaved draft' } });
    input.focus();
    input.setSelectionRange(2, 7, 'backward');
    const owner = sessionIdentity(),
      key = sessionStorageKey('draft'),
      { controller: c } = monitor();
    act(() => c.suspend());
    expect(document.body).toHaveClass('tenant-suspended');
    expect(input.closest('[inert]')).not.toBeNull();
    expect(input.closest('[aria-hidden="true"]')).not.toBeNull();
    expect(input).toHaveValue('Unsaved draft');
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Tenant access paused' })).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Check again' })).toHaveFocus();
    await act(() => c.check());
    expect(document.body).not.toHaveClass('tenant-suspended');
    expect(input).toBe(document.querySelector('input'));
    expect(input).toHaveValue('Unsaved draft');
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(7);
    expect(input.selectionDirection).toBe('backward');
    expect(original).toEqual({ value: 'Original' });
    expect(sessionIdentity()).toBe(owner);
    expect(sessionStorageKey('draft')).toBe(key);
    expect(mounted).toHaveBeenCalledOnce();
    expect(unmounted).not.toHaveBeenCalled();
  },
);

test('cover includes late portals, retains preexisting inert state and refuses Escape dismissal', async () => {
  const existing = document.createElement('aside');
  existing.setAttribute('inert', '');
  existing.setAttribute('aria-hidden', 'true');
  document.body.append(existing);
  overlay = tenantSuspensionOverlay(vi.fn());
  overlay.update({ suspended: true, busy: false, offline: false });
  const dialog = screen.getByRole('dialog', { name: 'Tenant access paused' });
  const escape = new Event('cancel', { cancelable: true });
  dialog.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  const portal = document.createElement('section');
  portal.textContent = 'Private late content';
  document.body.append(portal);
  await vi.waitFor(() => expect(portal).toHaveAttribute('inert'));
  expect(portal).toHaveAttribute('aria-hidden', 'true');
  overlay.close();
  expect(existing).toHaveAttribute('inert');
  expect(existing).toHaveAttribute('aria-hidden', 'true');
  expect(portal).not.toHaveAttribute('inert');
  expect(portal).not.toHaveAttribute('aria-hidden');
});

test('manual retry is accessible, serialized and keeps its focus while busy', async () => {
  let finish!: (value: unknown) => void;
  renew.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { controller: c, retry } = monitor();
  c.suspend();
  const button = screen.getByRole('button', { name: 'Check again' });
  fireEvent.click(button);
  fireEvent.click(button);
  await act(async () => {});
  expect(retry).toHaveBeenCalledOnce();
  expect(renew).toHaveBeenCalledOnce();
  expect(button).toHaveAttribute('aria-disabled', 'true');
  expect(button).toHaveFocus();
  expect(screen.getByRole('status')).toHaveTextContent('Verifying tenant access');
  await act(async () => {
    finish({ ...captureTenantLease()!, revision: 2 });
    await c.check();
  });
  expect(screen.queryByRole('dialog', { name: 'Tenant access paused' })).toBeNull();
});

test('recoverable renewal does not settle unknown CRUD handles or notify their subscribers', async () => {
  const owner = sessionIdentity(),
    handle = tenantMutationState.start('update');
  tenantMutationState.unknown(handle);
  const listener = vi.fn(),
    unsubscribe = tenantMutationState.subscribe(listener);
  const { controller: c } = monitor();
  c.suspend();
  await act(() => c.check());
  expect(renew).toHaveBeenCalledOnce();
  expect(tenantMutationState.hasUnresolved(owner)).toBe(true);
  expect(listener).not.toHaveBeenCalled();
  expect(tenantMutationState.unknown(handle)).toBe(false);
  expect(tenantMutationState.settle(handle)).toBe(true);
  unsubscribe();
});

const commandOwner: CommandOwner = { connection: 'atlas', target: 'loans', command: 'assign', commandVersion: 1, key: { id: 1 } };
const action: AppCommandAction = {
  id: 'assign',
  label: 'Assign',
  command: { id: 'assign', version: 1, target: 'loans', input: [{ name: 'reason', label: 'Reason', type: 'textarea', required: true }] },
};
test('real command form and unknown envelope survive renewal without reprepare, replay or result settlement', async () => {
  const operation = commandOperations.start(commandOwner, 3, { reason: 'Original reason' }, action);
  await commandOperations.send(
    operation,
    'execute',
    async () => {
      throw new Error('Lost acknowledgement');
    },
    vi.fn(),
  );
  expect(operation.phase).toBe('unknown');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <CommandForm action={action} owner={commandOwner} label="Loan 1" onClose={vi.fn()} onDone={vi.fn()} />
    </QueryClientProvider>,
  );
  const input = screen.getByLabelText('Reason (required)'),
    dialog = screen.getByRole('dialog', { name: 'Assign' });
  const envelope = operation.envelope,
    { controller: c } = monitor();
  act(() => c.suspend());
  expect(dialog.closest('[inert]')).not.toBeNull();
  expect(input).toHaveValue('Original reason');
  await act(() => c.check());
  expect(screen.getByRole('dialog', { name: 'Assign' })).toBe(dialog);
  expect(screen.getByLabelText('Reason (required)')).toBe(input);
  expect(input).toBeDisabled();
  expect(commandOperations.get(commandOwner)).toBe(operation);
  expect(operation.envelope).toBe(envelope);
  expect(operation.envelope.expectedVersion).toBe(3);
  expect(operation.phase).toBe('unknown');
  expect(tenantMutationState.hasUnresolved()).toBe(true);
  expect(api).not.toHaveBeenCalled();
  expect(tenantLeaseActive()).toBe(true);
});

test('retirement disposal never restores focus into the old private form', () => {
  const input = document.createElement('input');
  document.body.append(input);
  input.focus();
  const { controller: c, overlay: cover } = monitor();
  c.suspend();
  const focus = vi.spyOn(input, 'focus');
  lockSessionIdentity();
  cover.close(false);
  expect(focus).not.toHaveBeenCalled();
  expect(screen.queryByRole('dialog', { name: 'Tenant access paused' })).toBeNull();
});
