import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { InsertResponse } from './NewRecord.js';

const context = vi.hoisted(() => ({
  table: undefined as TableMeta | undefined,
  entry: {},
  resource: true,
  state: { activeConnection: 'demo', canWrite: false, connections: [{ id: 'demo', writable: true }] },
  watchers: new Set<() => void>(),
}));
const api = vi.hoisted(() => vi.fn());
const refreshUndo = vi.hoisted(() => vi.fn());
const openRecord = vi.hoisted(() => vi.fn());
const allowMutationExit = vi.hoisted(() => vi.fn(() => true));
vi.mock('../core.js', () => ({
  state: context.state,
  api,
  openRecord,
  allowMutationExit,
  currentEntry: () => context.entry,
  findTable: () => context.table,
  writeAllowed: () => context.resource,
  prefersPages: () => false,
  columnLabel: (_table: string, column: string) => (column === 'name' ? 'Task' : undefined),
  columnDisplay: () => undefined,
  humanName: (name: string) => name,
  rowLabel: () => 'New task',
  toast: vi.fn(),
  subscribeWalk: () => () => {},
  walkVersion: () => 0,
  whenConnectionChanges: (fn: () => void) => {
    context.watchers.add(fn);
    return () => context.watchers.delete(fn);
  },
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo }));
vi.mock('../url.js', () => ({ syncHash: vi.fn() }));
vi.mock('./mount.js', () => ({ mount: vi.fn(), unmount: vi.fn() }));

const { QuickAdd } = await import('./QuickAdd.js');
const { establishSessionIdentity, lockSessionIdentity } = await import('../sessionIdentity.js');
const table: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, identity: 'by-default' },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false, default: "'open'" },
  ],
};
const form = { show: ['name'], defaults: { status: 'open' } };
const deferred = () => {
  let resolve!: (result: InsertResponse) => void;
  const promise = new Promise<InsertResponse>((done) => {
    resolve = done;
  });
  api.mockReturnValue(promise);
  return resolve;
};
const open = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: '+ Add task' }));
  return user;
};

beforeEach(bridgeShell);

beforeEach(() => {
  vi.clearAllMocks();
  context.table = table;
  context.entry = {};
  context.resource = true;
  context.state.activeConnection = 'demo';
  context.state.canWrite = false;
  context.state.connections[0].writable = true;
  allowMutationExit.mockReturnValue(true);
  api.mockResolvedValue({ key: { id: 1 }, row: { id: 1, name: 'First' } });
  establishSessionIdentity({ signedIn: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  expect(context.watchers.size).toBe(0);
});

test('collapsed uses the supplied label, mounts one curated form on expansion, and focuses only once', async () => {
  const onAdded = vi.fn();
  const view = render(<QuickAdd table={table} form={form} label="Task" onAdded={onAdded} />);
  expect(screen.queryByRole('textbox')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: '+ Add Task' }));
  expect(document.querySelectorAll('form')).toHaveLength(1);
  expect(document.querySelector('.insert-lede')).toBeNull();
  expect(screen.getAllByRole('textbox')).toHaveLength(1);
  expect(screen.getByRole('textbox', { name: 'Task' })).toHaveFocus();
  screen.getByRole('button', { name: 'Cancel' }).focus();
  view.rerender(<QuickAdd table={{ ...table }} form={{ ...form }} label="Task" onAdded={onAdded} />);
  expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
});

test('creation works with App write mode off, refreshes Undo and the list, closes, resets and never navigates', async () => {
  const onAdded = vi.fn();
  render(<QuickAdd table={table} form={form} onAdded={onAdded} />);
  const user = await open();
  await user.type(screen.getByRole('textbox', { name: 'Task' }), 'First');
  await user.click(screen.getByRole('button', { name: 'Add' }));
  await vi.waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
  expect(onAdded).toHaveBeenCalledWith();
  expect(api).toHaveBeenCalledExactlyOnceWith('/api/insert', { conn: 'demo', table: 'task', values: { status: 'open', name: 'First' } });
  expect(refreshUndo).toHaveBeenCalledOnce();
  expect(openRecord).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '+ Add task' })).toHaveFocus();
  await open();
  expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('');
});

test('cancel collapses a clean form; dirty cancellation uses the existing discard confirmation', async () => {
  render(<QuickAdd table={table} form={form} onAdded={vi.fn()} />);
  const user = await open();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('button', { name: '+ Add task' })).toHaveFocus();
  await open();
  await user.type(screen.getByRole('textbox', { name: 'Task' }), 'Draft');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(screen.getByRole('dialog', { name: 'Discard new record?' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Keep editing' }));
  expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Draft');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Discard record' }));
  await open();
  expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('');
  expect(api).not.toHaveBeenCalled();
});

test('required validation stays local', async () => {
  render(<QuickAdd table={table} form={form} onAdded={vi.fn()} />);
  const user = await open();
  await user.click(screen.getByRole('button', { name: 'Add' }));
  const field = screen.getByRole('textbox', { name: 'Task' });
  expect(await screen.findByText('Fill in Task.')).toBeVisible();
  expect(field).toHaveAttribute('aria-invalid', 'true');
  expect(field).toHaveAccessibleDescription('Fill in Task.');
  expect(field).toHaveFocus();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(api).not.toHaveBeenCalled();
  await user.type(field, 'A task');
  expect(field).not.toHaveAttribute('aria-invalid');
  expect(screen.queryByText('Fill in Task.')).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

test('confirmed App validation maps into the shared inline field message', async () => {
  api.mockResolvedValueOnce({
    errors: [
      {
        message: 'The record does not satisfy the application rules.',
        fields: [{ field: 'name', message: 'This value does not meet the application rules.' }],
      },
    ],
    outcome: 'rejected',
  });
  render(<QuickAdd table={table} form={form} onAdded={vi.fn()} />);
  const user = await open();
  const field = screen.getByRole('textbox', { name: 'Task' });
  await user.type(field, 'A task');
  await user.click(screen.getByRole('button', { name: 'Add' }));
  expect(await screen.findByText('This value does not meet the application rules.')).toBeVisible();
  expect(field).toHaveAccessibleDescription('This value does not meet the application rules.');
  await user.type(field, ' revised');
  expect(screen.queryByText('This value does not meet the application rules.')).toBeNull();
});

test('pending locks controls and double submits; definite rejection preserves editable values for a deliberate retry', async () => {
  const resolve = deferred();
  const onAdded = vi.fn();
  render(<QuickAdd table={table} form={form} onAdded={onAdded} />);
  const user = await open();
  await user.type(screen.getByRole('textbox', { name: 'Task' }), 'First');
  const formElement = document.querySelector('form')!;
  fireEvent.submit(formElement);
  fireEvent.submit(formElement);
  await screen.findByText('Adding...');
  expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getByRole('textbox', { name: 'Task' })).toBeDisabled();
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ errors: [{ message: 'Duplicate task' }], outcome: 'rejected' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Duplicate task');
  expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('First');
  expect(screen.getByRole('textbox', { name: 'Task' })).toBeEnabled();
  expect(onAdded).not.toHaveBeenCalled();
  api.mockResolvedValue({ key: { id: 2 } });
  await user.type(screen.getByRole('textbox', { name: 'Task' }), ' revised');
  await user.click(screen.getByRole('button', { name: 'Add' }));
  await vi.waitFor(() => expect(onAdded).toHaveBeenCalledOnce());
});

test.each(['unknown', 'lost'])('%s result keeps all inline controls locked without a blind retry', async (outcome) => {
  if (outcome === 'unknown') api.mockResolvedValue({ outcome: 'unknown', errors: [{ message: 'Unconfirmed' }] });
  else api.mockRejectedValue(new Error('Response lost'));
  const onAdded = vi.fn();
  render(<QuickAdd table={table} form={{ ...form, defaults: { name: 'First' } }} onAdded={onAdded} />);
  const user = await open();
  await user.click(screen.getByRole('button', { name: 'Add' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The row may already exist');
  expect(screen.getByRole('textbox', { name: 'Task' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  fireEvent.submit(document.querySelector('form')!);
  await user.keyboard('{Escape}');
  expect(api).toHaveBeenCalledOnce();
  expect(onAdded).not.toHaveBeenCalled();
});

test('timeout retains the same attempt and a late confirmed reply can still complete it', async () => {
  const resolve = deferred();
  const onAdded = vi.fn();
  render(<QuickAdd table={table} form={{ defaults: { name: 'First' } }} onAdded={onAdded} />);
  await open();
  vi.useFakeTimers();
  await act(async () => fireEvent.submit(document.querySelector('form')!));
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(screen.getByRole('alert')).toHaveTextContent('The request may still complete');
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  await act(async () => resolve({ key: { id: 1 } }));
  expect(onAdded).toHaveBeenCalledOnce();
  expect(api).toHaveBeenCalledOnce();
  expect(screen.getByRole('button', { name: '+ Add task' })).toBeVisible();
});

test.each(['grant', 'insertable', 'view', 'resource', 'connection'])('denies creation without the %s capability', async (gate) => {
  if (gate === 'grant') context.state.connections[0].writable = false;
  if (gate === 'resource') context.resource = false;
  if (gate === 'connection') context.state.activeConnection = 'missing';
  render(<QuickAdd table={{ ...table, insertable: gate !== 'insertable', isView: gate === 'view' }} onAdded={vi.fn()} />);
  expect(screen.queryByRole('button')).toBeNull();
  expect(api).not.toHaveBeenCalled();
});

test('existing mutation exit guards veto expansion and draft dismissal', async () => {
  render(<QuickAdd table={table} form={form} onAdded={vi.fn()} />);
  allowMutationExit.mockReturnValue(false);
  await open();
  expect(screen.queryByRole('textbox')).toBeNull();
  allowMutationExit.mockReturnValue(true);
  const user = await open();
  await user.type(screen.getByRole('textbox', { name: 'Task' }), 'Draft');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  allowMutationExit.mockReturnValue(false);
  await user.click(screen.getByRole('button', { name: 'Discard record' }));
  expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Draft');
});

test.each(['session', 'connection', 'table', 'unmount', 'route'])(
  'a late result cannot close or refresh a replacement after %s changes',
  async (change) => {
    const resolve = deferred();
    const onAdded = vi.fn();
    const nextAdded = vi.fn();
    const view = render(<QuickAdd table={table} form={{ defaults: { name: 'First' } }} onAdded={onAdded} />);
    const user = await open();
    await user.click(screen.getByRole('button', { name: 'Add' }));
    let nextTable = table;
    if (change === 'session')
      act(() => {
        lockSessionIdentity();
        establishSessionIdentity({ signedIn: false });
      });
    if (change === 'connection')
      act(() => {
        context.state.activeConnection = 'other';
        for (const fn of context.watchers) fn();
        context.state.activeConnection = 'demo';
      });
    if (change === 'table') nextTable = { ...table, id: 'other' };
    if (change === 'route') {
      context.entry = {};
      history.replaceState(null, '', '/other');
    }
    if (change === 'unmount') {
      view.unmount();
      render(<QuickAdd table={table} form={form} onAdded={nextAdded} />);
    } else view.rerender(<QuickAdd table={nextTable} form={form} onAdded={nextAdded} />);
    await open();
    await user.type(screen.getByRole('textbox', { name: 'Task' }), 'Replacement');
    await act(async () => resolve({ key: { id: 1 } }));
    expect(onAdded).not.toHaveBeenCalled();
    expect(nextAdded).not.toHaveBeenCalled();
    expect(refreshUndo).not.toHaveBeenCalled();
    expect(openRecord).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Task' })).toHaveValue('Replacement');
    history.replaceState(null, '', '/');
  },
);
