/**
 * A list's cell edited in place: which columns are offered, and the
 * spreadsheet's contract — a click or Enter opens, Enter saves the record
 * form's request, Esc puts the value back without a write, Tab saves and
 * opens the row's next editable cell. Optimistic: the saved value is drawn
 * at once, and a refusal puts the stored one back and says why.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  toast: vi.fn(),
  editable: true,
  open: vi.fn(),
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false } as Record<string, unknown>,
  state: { activeConnection: 'desk', connections: [{ id: 'desk', writable: true }], canWrite: true },
  choices: null as null | { yes: string; no: string },
  rules: {} as Record<string, unknown>,
}));
const table: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'note', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'state', type: 'TEXT', nullable: false, primaryKey: false, changesBy: 'actions' },
    { name: 'owner', type: 'TEXT', nullable: true, primaryKey: false, writable: false },
    { name: 'meta', type: 'JSON', nullable: true, primaryKey: false },
  ],
};
vi.mock('../core.js', () => ({
  api: mocks.api,
  columnDisplay: (_table: string, name: string) => mocks.rules[name] ?? null,
  toast: mocks.toast,
  state: mocks.state,
  findTable: () => table,
  refsFrom: () => [],
  labelPath: () => 'title',
  recordLabel: () => undefined,
  rowLabel: (_t: unknown, r: Record<string, unknown>) => String(r.title ?? r.id),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
  columnLabel: (_t: string, name: string) => (({ title: 'Title', note: 'Note' }) as Record<string, string>)[name],
}));
vi.mock('../rowEditing.js', () => ({ canEditRow: () => mocks.editable, booleanChoices: () => mocks.choices }));
vi.mock('../sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  subscribeSessionIdentity: () => () => {},
  subscribeTenantLease: () => () => {},
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: vi.fn(), undoLast: vi.fn() }));
const { GridCellEdit, ValueControl } = await import('./GridCellEditor.js');
const { editableCells, editableColumns } = await import('./gridCellModel.js');
const { updateAttempts } = await import('../updateAttempts.js');

const column = (name: string) => table.columns.find((c) => c.name === name)!;
const row = { id: 7, title: 'Draft plan', note: 'first' };
const drawOf = (current: Record<string, unknown>, name: string) => (next?: { value: unknown }) => (
  <span className="drawn">{String((next ? next.value : current[name]) ?? '—')}</span>
);

function draw(current: Record<string, unknown> = row) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <table>
        <tbody>
          <tr onClick={mocks.open}>
            <td className="cell-editable">
              <GridCellEdit table={table} row={current} column={column('title')} recordKey={{ id: 7 }} draw={drawOf(current, 'title')} />
            </td>
            <td className="cell-editable">
              <GridCellEdit table={table} row={current} column={column('note')} recordKey={{ id: 7 }} draw={drawOf(current, 'note')} />
            </td>
          </tr>
        </tbody>
      </table>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.toast.mockReset();
  mocks.open.mockReset();
  mocks.editable = true;
  updateAttempts.reset();
});
afterEach(cleanup);

test('only shown columns the reader may write are offered: never the key, an action-moved, read-only or document column', () => {
  const shown = ['id', 'title', 'note', 'state', 'owner', 'meta'];
  expect(editableColumns(table, true, shown)).toEqual(['title', 'note']);
  expect(editableColumns(table, ['note', 'state'], shown)).toEqual(['note']);
  expect(editableColumns(table, ['note'], ['title'])).toEqual([]);
  expect(editableColumns(table, undefined, shown)).toEqual([]);
  expect(editableColumns({ ...table, isView: true }, true, shown)).toEqual([]);
});

test('a reference shown by its record’s name is edited as the reference; a longer path is another record’s value', () => {
  const withOwner: TableMeta = {
    ...table,
    columns: [
      ...table.columns,
      { name: 'rep_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'rep', column: 'id' } },
    ],
  };
  expect([...editableCells(withOwner, true, ['title', 'rep_id.name', 'rep_id.team_id.name', 'title.x'])]).toEqual([
    ['title', 'title'],
    ['rep_id.name', 'rep_id'],
  ]);
  expect(editableColumns(withOwner, ['rep_id'], ['title', 'rep_id.name'])).toEqual(['rep_id']);
});

test('a click edits the cell without opening the row; Enter saves the record form’s request and draws the value at once', async () => {
  let answer!: (value: unknown) => void;
  mocks.api.mockImplementation(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Title' }));
  expect(mocks.open).not.toHaveBeenCalled();
  const box = screen.getByRole('textbox', { name: 'Title' });
  await userEvent.clear(box);
  await userEvent.type(box, 'Final plan{Enter}');
  expect(mocks.api).toHaveBeenCalledWith('/api/update', {
    table: 'task',
    key: { id: 7 },
    values: { title: 'Final plan' },
    expected: { title: 'Draft plan' },
    conn: 'desk',
  });
  // Optimistic: drawn before the server answers.
  expect(screen.getByRole('button', { name: 'Edit Title' })).toHaveTextContent('Final plan');
  answer({ affected: 1, applied: { title: 'Final plan' } });
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('Saved Title.', 'ok', undefined));
});

test('a refusal puts the stored value back and says why', async () => {
  mocks.api.mockResolvedValue({ outcome: 'rejected', errors: [{ message: 'A task keeps a title.', field: 'title' }] });
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Title' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Title' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'X{Enter}');
  await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith('A task keeps a title.', 'error'));
  expect(screen.getByRole('button', { name: 'Edit Title' })).toHaveTextContent('Draft plan');
});

test('Esc puts the value back and writes nothing', async () => {
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Note' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Note' }), ' more{Escape}');
  expect(mocks.api).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Edit Note' })).toHaveTextContent('first');
});

test('a value the record form would refuse keeps the editor open, saying why, and sends nothing', async () => {
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Title' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Title' }));
  await userEvent.keyboard('{Enter}');
  expect(screen.getByRole('alert')).toHaveTextContent('Required');
  expect(mocks.api).not.toHaveBeenCalled();
});

test('Tab saves and opens the row’s next editable cell', async () => {
  mocks.api.mockResolvedValue({ affected: 1, applied: { title: 'Renamed' } });
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Title' }));
  await userEvent.clear(screen.getByRole('textbox', { name: 'Title' }));
  await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Renamed');
  await userEvent.keyboard('{Tab}');
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Note' })).toHaveFocus());
  expect(mocks.api).toHaveBeenCalledTimes(1);
});

test('a row the reader may not edit opens no editor', async () => {
  mocks.editable = false;
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Edit Title' }));
  expect(screen.queryByRole('textbox')).toBeNull();
});

test('a reference opens on the name its cell draws, not on the key, before any label is fetched', async () => {
  mocks.api.mockImplementation(() => new Promise(() => {}));
  const owner = { name: 'owner_id', type: 'INTEGER', nullable: true, primaryKey: false, references: { table: 'task', column: 'id' } };
  const current = { ...row, owner_id: 3 };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <table>
        <tbody>
          <tr>
            <td className="cell-editable">
              <GridCellEdit
                table={table}
                row={current}
                column={owner}
                recordKey={{ id: 7 }}
                draw={drawOf(current, 'owner_id')}
                valueLabel="Freya Lind"
              />
            </td>
          </tr>
        </tbody>
      </table>
    </QueryClientProvider>,
  );
  await userEvent.click(screen.getByRole('button', { name: /Edit/ }));
  expect(screen.getByRole('combobox')).toHaveValue('Freya Lind');
});

test("a form's true/false control says the column's display words", async () => {
  mocks.choices = { yes: 'true', no: 'false' };
  mocks.rules = { done: { values: { true: 'On', false: 'Off' } } };
  try {
    const user = userEvent.setup();
    const done = { name: 'done', type: 'boolean', nullable: false, primaryKey: false };
    render(<ValueControl table={table} column={done} value="false" onChange={() => {}} label="Done" />);
    const control = screen.getByRole('button', { name: 'Done' });
    expect(control).toHaveTextContent('Off');
    await user.click(control);
    expect(screen.getByRole('option', { name: 'On' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'Yes' })).toBeNull();
  } finally {
    mocks.choices = null;
    mocks.rules = {};
  }
});
