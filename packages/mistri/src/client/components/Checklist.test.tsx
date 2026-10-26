import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  open: vi.fn(),
  allowed: true,
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false },
  state: { activeConnection: 'tick', connections: [{ id: 'tick', writable: true }] },
}));
const table: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'completed', type: 'BOOLEAN', nullable: false, primaryKey: false },
  ],
};
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: mocks.open,
  state: mocks.state,
  writeAllowed: () => mocks.allowed,
  findTable: () => table,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../../../../kit/src/client/sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({
  Value: ({ value }: { value: unknown }) => <span>{String(value)}</span>,
}));
const { Checklist, canShowChecklist } = await import('./Checklist.js');
const { updateAttempts } = await import('../../../../kit/src/client/updateAttempts.js');
const spec = { kind: 'checklist' as const, primary: 'name', checked: 'completed' };
const row = { id: '9007199254740993', name: 'Buy bread', completed: false };
function draw(rows = [row], interactive = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const result = render(
    <QueryClientProvider client={client}>
      <Checklist table={table} rows={rows} spec={spec} interactive={interactive} />
    </QueryClientProvider>,
  );
  return { ...result, invalidate };
}
beforeEach(() => {
  mocks.api.mockReset();
  mocks.open.mockReset();
  mocks.allowed = true;
  mocks.state.activeConnection = 'tick';
  mocks.state.connections[0].writable = true;
  mocks.identity = { epoch: 1, mode: 'anonymous', tenantRequired: false };
  table.columns[2].writable = undefined;
  updateAttempts.reset();
});
afterEach(cleanup);

test('completion writes the exact key and one boolean through the ordinary route', async () => {
  mocks.api.mockResolvedValue({ affected: 1, applied: { completed: true } });
  const { invalidate } = draw();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Complete Buy bread' }));
  // The box as the list showed it rides along: ticked elsewhere since, the tick is refused, not undone.
  expect(mocks.api).toHaveBeenCalledWith('/api/update', {
    conn: 'tick',
    table: 'task',
    key: { id: row.id },
    values: { completed: true },
    expected: { completed: false },
  });
  expect(mocks.open).not.toHaveBeenCalled();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['run', 'tick'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['count', 'tick'] });
});

test('completed records can be reopened, and their title opens detail independently', async () => {
  mocks.api.mockResolvedValue({ affected: 1, applied: { completed: false } });
  draw([{ ...row, completed: true }]);
  expect(screen.getByRole('checkbox')).toBeChecked();
  await userEvent.click(screen.getByRole('checkbox', { name: 'Reopen Buy bread' }));
  expect(mocks.api.mock.calls[0][1].values).toEqual({ completed: false });
  await userEvent.click(screen.getByRole('button', { name: row.name }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith('task', { id: row.id }, row.name, 'push', {
    records: [{ key: { id: row.id }, label: row.name }],
  });
});

test('pending completion stays unchecked and refuses a second submission', async () => {
  let resolve!: (value: unknown) => void;
  mocks.api.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  draw();
  const checkbox = screen.getByRole('checkbox');
  await userEvent.click(checkbox);
  expect(checkbox).toBeDisabled();
  expect(checkbox).not.toBeChecked();
  expect(screen.getByRole('status')).toHaveTextContent('Saving');
  await userEvent.click(checkbox);
  expect(mocks.api).toHaveBeenCalledOnce();
  await act(async () => resolve({ affected: 1, applied: { completed: true } }));
});

test('unknown completion retains a visible locked attempt across remount, never retries', async () => {
  mocks.api.mockRejectedValue(new Error('Network lost'));
  const first = draw();
  await userEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('alert')).toHaveTextContent('Update not confirmed');
  expect(screen.getByRole('checkbox')).toBeDisabled();
  first.unmount();
  draw();
  expect(screen.getByRole('alert')).toHaveTextContent('Open this record');
  await userEvent.click(screen.getByRole('checkbox'));
  expect(mocks.api).toHaveBeenCalledOnce();
});

test('a confirmed refusal shows the reason and permits a fresh attempt', async () => {
  mocks.api.mockResolvedValue({ errors: [{ message: 'No longer writable' }], outcome: 'rejected' });
  draw();
  await userEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('alert')).toHaveTextContent('No longer writable');
  expect(screen.getByRole('checkbox')).toBeEnabled();
});

test.each(['grant', 'connection', 'field', 'embedded'])('%s denial disables completion', (kind) => {
  if (kind === 'grant') mocks.allowed = false;
  if (kind === 'connection') mocks.state.connections[0].writable = false;
  if (kind === 'field') table.columns[2].writable = false;
  draw([row], kind !== 'embedded');
  expect(screen.getByRole('checkbox')).toBeDisabled();
  // Read-only, it is drawn in the text's ink (structure.css), not the browser's grey.
  expect(screen.getByRole('checkbox')).toHaveClass('is-readonly');
  expect(mocks.api).not.toHaveBeenCalled();
});

test('a check waiting on its save is not read-only: it keeps the waiting dress', async () => {
  mocks.api.mockImplementation(() => new Promise(() => {}));
  draw();
  await userEvent.click(screen.getByRole('checkbox'));
  expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.getByRole('checkbox')).not.toHaveClass('is-readonly');
});

test('a late reply from a retired session cannot refresh its successor', async () => {
  let resolve!: (value: unknown) => void;
  mocks.api.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const { invalidate } = draw();
  await userEvent.click(screen.getByRole('checkbox'));
  mocks.identity = { ...mocks.identity, epoch: 2 };
  await act(async () => resolve({ affected: 1, applied: { completed: true } }));
  expect(invalidate).not.toHaveBeenCalled();
});

test('keyboard completion uses Space without opening the record', async () => {
  mocks.api.mockResolvedValue({ affected: 1, applied: { completed: true } });
  draw();
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard(' ');
  await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
  expect(mocks.open).not.toHaveBeenCalled();
});

test('a checklist requires all configured fields and complete primary keys', () => {
  expect(canShowChecklist(table, ['id', 'name', 'completed'], spec)).toBe(true);
  expect(canShowChecklist(table, ['name', 'completed'], spec)).toBe(false);
  expect(canShowChecklist(table, ['id', 'name'], spec)).toBe(false);
  expect(canShowChecklist(table, ['id', 'name', 'completed'], { ...spec, lines: ['due_on'] })).toBe(false);
  expect(
    canShowChecklist({ ...table, columns: table.columns.map((c) => ({ ...c, primaryKey: false })) }, ['id', 'name', 'completed'], spec),
  ).toBe(false);
});
