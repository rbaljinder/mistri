/** A proposal's panel: the command's drawer prefilled with what was proposed; Approve sends the correction, Dismiss replaces Cancel. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppCommandAction, AppCommandField } from '../../shared/app.js';
import { establishSessionIdentity } from '../../../../kit/src/client/sessionIdentity.js';
import type { CommandOwner } from '../commandState.js';

const { api, state } = vi.hoisted(() => ({ api: vi.fn(), state: { activeConnection: 'clinic' } }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: (path: string, body: unknown) => api(path, body),
  pickerApi: (path: string, body: unknown) => api(path, body),
  state,
  findTable: () => undefined,
  columnLabel: () => null,
  humanName: (name: string) => name,
  prefersPages: () => true,
  toast: vi.fn(),
  viewportSize: () => ({ width: 1024, height: 768 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  setRecordMutationPendingProbe: () => {},
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({ Value: () => null }));

const { CommandForm } = await import('./CommandForm.js');

const fields: AppCommandField[] = [
  { name: 'reason', label: 'Reason', type: 'text' } as AppCommandField,
  { name: 'note', label: 'Note', type: 'text' } as AppCommandField,
];
const action: AppCommandAction = {
  id: 'appeal',
  label: 'Send appeal',
  command: { id: 'appeal', version: 1, target: 'claim', input: fields },
};
const owner: CommandOwner = { connection: 'clinic', target: 'claim', command: 'appeal', commandVersion: 1, key: { id: 4 } };
const input = { reason: 'Coding error', note: 'Resubmit with modifier 25' };

const clients: QueryClient[] = [];
function draw(onDismiss = vi.fn(async () => ({}))) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <CommandForm
        action={action}
        owner={owner}
        label=""
        onClose={onClose}
        onDone={vi.fn()}
        initial={input}
        proposal={{ id: 'prop-1', input, onDismiss }}
        aside={<p>Evidence here</p>}
      />
    </QueryClientProvider>,
  );
  return { onDismiss, onClose };
}
const approvals = () => api.mock.calls.filter(([path]) => path === '/api/commands/proposals/approve');
beforeEach(() => {
  state.activeConnection = 'clinic';
  establishSessionIdentity({ signedIn: true, accountId: 'nurse', appId: 'clinic' });
  api.mockReset();
  api.mockImplementation(async () => ({ expectedVersion: 1 }));
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
});

test('a proposal opens in the drawer, prefilled with what was proposed and its evidence beside it', async () => {
  draw();
  const drawer = await screen.findByRole('dialog', { name: 'Send appeal' });
  expect(drawer).toHaveClass('command-drawer');
  expect(await screen.findByRole('textbox', { name: 'Reason' })).toHaveValue('Coding error');
  expect(screen.getByRole('textbox', { name: 'Note' })).toHaveValue('Resubmit with modifier 25');
  expect(drawer.querySelector('.command-aside')).toHaveTextContent('Evidence here');
});

test('Dismiss stands where Cancel was, dismisses the proposal and closes', async () => {
  const { onDismiss, onClose } = draw();
  await screen.findByRole('dialog', { name: 'Send appeal' });
  expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(onDismiss).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test('Approve as proposed sends the approval alone', async () => {
  draw();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send appeal' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));
  await waitFor(() => expect(approvals()).toHaveLength(1));
  expect(approvals()[0]![1]).toEqual({ conn: 'clinic', id: 'prop-1', command: 'appeal', expectedVersion: 1 });
});

test('a corrected field sends the corrected input with the approval', async () => {
  draw();
  const again = await screen.findByRole('textbox', { name: 'Reason' });
  await waitFor(() => expect(again).toBeEnabled());
  await userEvent.clear(again);
  await userEvent.type(again, 'Wrong code');
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send appeal' })).toBeEnabled());
  await userEvent.click(screen.getByRole('button', { name: 'Send appeal' }));
  await waitFor(() => expect(approvals()).toHaveLength(1));
  expect(approvals()[0]![1]).toMatchObject({ id: 'prop-1', input: { reason: 'Wrong code', note: 'Resubmit with modifier 25' } });
});
