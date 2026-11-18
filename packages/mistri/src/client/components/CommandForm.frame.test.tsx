import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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

const fields = (count: number): AppCommandField[] =>
  Array.from({ length: count }, (_, at) => ({ name: `f${at}`, label: `Field ${at}`, type: 'text' }) as AppCommandField);
const actionOf = (count: number): AppCommandAction => ({
  id: 'writeNote',
  label: 'Write a note',
  command: { id: 'writeNote', version: 1, target: 'patient', input: fields(count) },
});
const owner: CommandOwner = { connection: 'clinic', target: 'patient', command: 'writeNote', commandVersion: 1, key: { id: 1 } };

const clients: QueryClient[] = [];
function draw(count: number, extra: Partial<Parameters<typeof CommandForm>[0]> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(
    <QueryClientProvider client={client}>
      <CommandForm action={actionOf(count)} owner={owner} label="" onClose={vi.fn()} onDone={vi.fn()} {...extra} />
    </QueryClientProvider>,
  );
}
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

test('a form of eight fields or fewer is the centered dialog', async () => {
  draw(8);
  const dialog = await screen.findByRole('dialog', { name: 'Write a note' });
  expect(dialog).toHaveClass('command-form');
  expect(dialog).not.toHaveClass('command-drawer');
  expect(dialog).toHaveAttribute('aria-modal', 'true');
});

test('past eight fields the same form is a side drawer, still a labelled modal dialog', async () => {
  draw(9);
  const drawer = await screen.findByRole('dialog', { name: 'Write a note' });
  expect(drawer).toHaveClass('command-form', 'command-drawer');
  expect(drawer).toHaveAttribute('aria-modal', 'true');
  expect(drawer.querySelector('form .confirm-actions')).not.toBeNull();
});

test('inputs a page gives are not counted toward the frame', async () => {
  const action = { ...actionOf(9), given: ['f0'] } as AppCommandAction;
  const client = new QueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <CommandForm action={action} owner={owner} label="" onClose={vi.fn()} onDone={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(await screen.findByRole('dialog', { name: 'Write a note' })).not.toHaveClass('command-drawer');
});

test('the evidence slot is not drawn when absent, and sits beside the form when given', async () => {
  const bare = draw(9);
  await screen.findByRole('dialog', { name: 'Write a note' });
  expect(document.querySelector('.command-aside')).toBeNull();
  bare.unmount();
  draw(9, { aside: <p>Last visit</p> });
  const drawer = await screen.findByRole('dialog', { name: 'Write a note' });
  expect(drawer).toHaveClass('command-drawer-wide');
  const aside = drawer.querySelector('.command-body > .command-aside');
  expect(aside).toHaveTextContent('Last visit');
  expect(aside?.previousElementSibling?.tagName).toBe('FORM');
});

test('a short form with an evidence slot stays a dialog and keeps the slot', async () => {
  draw(2, { aside: <p>Last visit</p> });
  const dialog = await screen.findByRole('dialog', { name: 'Write a note' });
  expect(dialog).not.toHaveClass('command-drawer');
  expect(dialog).not.toHaveClass('command-drawer-wide');
  expect(dialog.querySelector('.command-aside')).toHaveTextContent('Last visit');
});
