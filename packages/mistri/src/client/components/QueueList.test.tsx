import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppAction } from '../../shared/app.js';
import type { AppQueueList } from '../../../../engine/src/shared/listPresentations.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  open: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  allowed: true,
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false } as Record<string, unknown>,
  app: { grantedCommands: [] as string[] },
  state: { activeConnection: 'desk', connections: [{ id: 'desk', writable: true }] },
}));
const employee: TableMeta = {
  id: 'employee',
  name: 'employee',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
const table: TableMeta = {
  id: 'ticket',
  name: 'ticket',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'subject', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'requester', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'count', type: 'INTEGER', nullable: true, primaryKey: false },
    { name: 'active', type: 'BOOLEAN', nullable: true, primaryKey: false },
  ],
};
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  columnDisplay: (_table: string, name: string) => (name === 'status' ? { values: { open: 'Open now', closed: 'Done' } } : null),
  columnLabel: (_table: string, name: string) =>
    (({ requester: 'Requester', count: 'Employees', active: 'Active' }) as Record<string, string>)[name] ?? null,
  openRecord: mocks.open,
  state: mocks.state,
  toast: mocks.toast,
  writeAllowed: () => mocks.allowed,
  findTable: (id: string) => (id === 'employee' ? employee : table),
  refsFrom: (id: string) =>
    id === 'ticket' ? [{ from: { table: 'ticket', columns: ['employee_id'] }, to: { table: 'employee', columns: ['id'] } }] : [],
  primaryKey: (t: TableMeta) => t.columns.filter((c) => c.primaryKey).map((c) => c.name),
  quote: (v: unknown) => (/^[\w.-]+$/.test(String(v)) ? String(v) : `"${String(v)}"`),
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../../../../kit/src/client/sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  tenantLeaseActive: () => false,
  subscribeSessionIdentity: () => () => {},
  subscribeTenantLease: () => () => {},
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: mocks.refresh }));
// This suite exercises command preparation/reconciliation; transport batching,
// pending visibility and owner fences have their own availability hook tests.
vi.mock('../commandAvailability.js', () => ({ useCommandAvailability: (checks: unknown[]) => checks.map(() => true) }));
vi.mock('../appState.js', () => ({ activeApp: () => mocks.app }));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({
  Value: ({ value }: { value: unknown }) => <span>{String(value)}</span>,
}));
const { QueueList, canShowQueue } = await import('./QueueList.js');
const { updateAttempts } = await import('../../../../kit/src/client/updateAttempts.js');

const spec: AppQueueList = { kind: 'queue', primary: 'subject', lines: ['requester'] };
const rows = [
  { id: '9007199254740993', subject: 'Printer jammed', requester: 'Ana', status: 'open', count: 0, active: false },
  { id: 2, subject: 'VPN drops', requester: 'Bo', status: 'open', count: 12, active: true },
  { id: 3, subject: 'Laptop swap', requester: null, status: 'closed', count: null, active: false },
];
const close: AppAction = { id: 'close', label: 'Close', set: { status: 'closed' }, bulk: true };
const actions: AppAction[] = [close];
const applied = (values: Record<string, unknown>) => ({ affected: 1, applied: values });

function draw(
  props: {
    rows?: Array<Record<string, unknown>>;
    actions?: AppAction[];
    interactive?: boolean;
    recordNavigation?: boolean;
    spec?: AppQueueList;
  } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const tree = (p: typeof props) => (
    <QueryClientProvider client={client}>
      <QueueList
        table={table}
        rows={p.rows ?? rows}
        spec={p.spec ?? spec}
        actions={p.actions ?? actions}
        interactive={p.interactive}
        recordNavigation={p.recordNavigation}
      />
    </QueryClientProvider>
  );
  const result = render(tree(props));
  return { ...result, invalidate, redraw: (p: typeof props) => result.rerender(tree(p)) };
}
const option = (name: string) => screen.getByRole('row', { name: new RegExp(name) });
const toolbar = () => screen.getByRole('toolbar', { name: 'Selected records' });
async function selectTwo() {
  await userEvent.click(option('Printer jammed'));
  fireEvent.click(option('VPN drops'), { ctrlKey: true });
  expect(option('Printer jammed')).toHaveAttribute('aria-selected', 'true');
  expect(option('VPN drops')).toHaveAttribute('aria-selected', 'true');
  expect(toolbar()).toHaveTextContent('2 selected');
}

beforeEach(bridgeShell);

beforeEach(() => {
  mocks.api.mockReset();
  mocks.open.mockReset();
  mocks.refresh.mockReset();
  mocks.toast.mockReset();
  mocks.allowed = true;
  mocks.state.activeConnection = 'desk';
  mocks.state.connections[0].writable = true;
  mocks.identity = { epoch: 1, mode: 'anonymous', tenantRequired: false };
  mocks.app.grantedCommands = [];
  table.columns[3].writable = undefined;
  updateAttempts.reset();
});
afterEach(cleanup);

test('queue facts show captions and retain zero and false values in both modes', () => {
  const factSpec: AppQueueList = { ...spec, facts: ['requester', 'count', 'active'] };
  draw({ interactive: false, recordNavigation: true, spec: factSpec });
  const first = screen.getAllByRole('listitem')[0];
  expect(within(first).getByText('Requester')).toBeInTheDocument();
  expect(within(first).getByText('Employees')).toBeInTheDocument();
  expect(within(first).getByText('0')).toBeInTheDocument();
  expect(within(first).getByText('Active')).toBeInTheDocument();
  expect(within(first).getByText('false')).toBeInTheDocument();
  const third = screen.getAllByRole('listitem')[2];
  expect(within(third).queryByText('Requester')).not.toBeInTheDocument();

  cleanup();
  draw({ spec: factSpec });
  const option = screen.getByRole('row', { name: /Printer jammed/ });
  expect(within(option).getByText('Employees')).toBeInTheDocument();
  expect(within(option).getByText('0')).toBeInTheDocument();
});

test("a queue fact may be a rollup, the row's own or through a reference, and says its value", () => {
  // Rollups are served beside the columns (rollups.ts), never among them.
  table.rollups = { open_tickets: { fn: 'count', via: 'ticket.employee_id', type: 'integer' } };
  employee.rollups = { tickets: { fn: 'count', via: 'ticket.employee_id', type: 'integer' } };
  try {
    draw({
      spec: { ...spec, facts: ['open_tickets', 'employee_id.tickets'] },
      rows: [{ id: 2, subject: 'VPN drops', requester: 'Bo', status: 'open', open_tickets: 0, 'employee_id.tickets': 7 }],
    });
    const row = screen.getByRole('row', { name: /VPN drops/ });
    expect(within(row).getByText('0')).toBeInTheDocument();
    expect(within(row).getByText('7')).toBeInTheDocument();
  } finally {
    delete table.rollups;
    delete employee.rollups;
  }
});

test("a selecting queue is a grid of selectable rows whose Open is a button in the row's cell, never inside an option", async () => {
  draw();
  const grid = screen.getByRole('grid', { name: 'Queue' });
  expect(grid).toHaveAttribute('aria-multiselectable', 'true');
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  expect(screen.queryByRole('option')).not.toBeInTheDocument();
  const row = option('VPN drops');
  const cell = within(row).getByRole('gridcell');
  const open = within(cell).getByRole('button', { name: 'Open VPN drops' });
  // The button is reachable and its own: activating it opens, and selects nothing.
  await userEvent.click(open);
  expect(mocks.open).toHaveBeenCalled();
  expect(row).toHaveAttribute('aria-selected', 'false');
  row.focus();
  fireEvent.keyDown(row, { key: ' ' });
  expect(row).toHaveAttribute('aria-selected', 'true');
});

test('a read-only queue shows status beside an accessible record action', () => {
  draw({ interactive: false, recordNavigation: true, spec: { ...spec, badge: 'status', openLabel: 'Review task' } });
  const first = screen.getAllByRole('listitem')[0];
  expect(first.querySelector('.queue-badge')).toHaveTextContent('open');
  expect(first.querySelector('.queue-facts')).toBeNull();
  expect(within(first).getByRole('button', { name: 'Review task Printer jammed' })).toBeInTheDocument();
});

test('a bulk action writes each selected key once, in row order, and refreshes the room', async () => {
  mocks.api.mockResolvedValue(applied({ status: 'closed' }));
  const { invalidate } = draw();
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.getByRole('status', { name: '' })).toHaveTextContent('Close: 2 applied.'));
  expect(mocks.api.mock.calls).toEqual([
    [
      '/api/update',
      { conn: 'desk', table: 'ticket', key: { id: '9007199254740993' }, values: { status: 'closed' }, expected: { status: 'open' } },
    ],
    ['/api/update', { conn: 'desk', table: 'ticket', key: { id: 2 }, values: { status: 'closed' }, expected: { status: 'open' } }],
  ]);
  expect(mocks.refresh).toHaveBeenCalledOnce();
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['run', 'desk'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['count', 'desk'] });
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['when', 'ticket'] });
  expect(screen.getByText('Close: 2 applied.').parentElement).toHaveFocus();
  // The selection survives the write; departures are pruned by the refetch, not the press.
  expect(toolbar()).toHaveTextContent('2 selected');
});

test('a "when" is judged by the server in one read; records that do not match are reported, not written', async () => {
  mocks.api.mockImplementation(async (route: string, body: Record<string, unknown>) =>
    route === '/api/run' ? { rows: [{ id: 2 }], columns: ['id'] } : applied(body.values as Record<string, unknown>),
  );
  draw({ actions: [{ ...close, when: 'status = open' }] });
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.getByText('Close: 1 applied, 1 not written.')).toBeInTheDocument());
  const read = mocks.api.mock.calls.find(([route]) => route === '/api/run')!;
  expect(read[1].q).toContain('id = 9007199254740993');
  expect(read[1].q).toContain('id = 2');
  expect(read[1].q).toContain('status = open');
  expect(read[1].conn).toBe('desk');
  const writes = mocks.api.mock.calls.filter(([route]) => route === '/api/update');
  expect(writes).toEqual([
    ['/api/update', { conn: 'desk', table: 'ticket', key: { id: 2 }, values: { status: 'closed' }, expected: { status: 'open' } }],
  ]);
  expect(screen.getByRole('listitem')).toHaveTextContent('Printer jammed: Does not match "status = open" now.');
});

test('one refusal neither stops nor undoes the others, and the report is an alert', async () => {
  mocks.api.mockImplementation(async (_route: string, body: Record<string, unknown>) => {
    if ((body.key as { id: unknown }).id === '9007199254740993') throw Object.assign(new Error('Nope'), { status: 409 });
    return applied(body.values as Record<string, unknown>);
  });
  draw();
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Close: 1 applied, 1 rejected.'));
  expect(screen.getByRole('alert')).toHaveTextContent('Printer jammed: Nope');
  expect(mocks.api).toHaveBeenCalledTimes(2);
  expect(mocks.refresh).toHaveBeenCalledOnce();
});

test('a confirmed action asks first: Cancel writes nothing, the primary button writes', async () => {
  mocks.api.mockResolvedValue(applied({ status: 'closed' }));
  draw({ actions: [{ ...close, confirm: true }] });
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Close' }));
  const dialog = await screen.findByRole('dialog', { name: 'Close?' });
  expect(dialog).toHaveTextContent('Apply to 2 selected records.');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(mocks.api).not.toHaveBeenCalled();
  expect(within(toolbar()).getByRole('button', { name: 'Close' })).toBeEnabled();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Close' }));
  const again = await screen.findByRole('dialog', { name: 'Close?' });
  await userEvent.click(within(again).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.getByText('Close: 2 applied.')).toBeInTheDocument());
  expect(mocks.api).toHaveBeenCalledTimes(2);
});

test.each(['grant', 'connection', 'field', 'embedded', 'view'])('%s denial hides the toolbar', (kind) => {
  if (kind === 'grant') mocks.allowed = false;
  if (kind === 'connection') mocks.state.connections[0].writable = false;
  if (kind === 'field') table.columns[3].writable = false;
  const view = kind === 'view' ? { ...table, isView: true } : table;
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <QueueList table={view} rows={rows} spec={spec} actions={actions} interactive={kind !== 'embedded'} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  expect(screen.getAllByRole(kind === 'embedded' ? 'row' : 'listitem')).toHaveLength(3);
});

test('one-record commands and single-record actions are never offered in bulk', async () => {
  draw({
    actions: [
      { id: 'reopen', label: 'Reopen', set: { status: 'open' } },
      {
        id: 'escalate',
        label: 'Escalate',
        command: { id: 'escalate', version: 1, target: 'ticket', label: 'Escalate', input: [] },
      } as unknown as AppAction,
      close,
    ],
  });
  // Nothing chosen, nothing to do: no bar of disabled verbs above the list.
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  await selectTwo();
  const buttons = within(toolbar())
    .getAllByRole('button')
    .map((button) => button.textContent);
  expect(buttons).toEqual(['Close', 'Clear selection']);
});

/* A `targets: 'many'` command is the atomic half of the contract: one form,
   one request for the selection, one outcome for the group. */
const assign: AppAction = {
  id: 'assign',
  label: 'Assign',
  bulk: true,
  when: 'status = open',
  command: {
    id: 'assign',
    version: 1,
    target: 'ticket',
    targets: 'many',
    input: [{ name: 'reason', label: 'Reason', type: 'text', required: true }],
  },
};
const both = [{ id: '9007199254740993' }, { id: 2 }];
const prepared = (eligible = [true, true]) => ({
  targets: both.map((key, index) => ({ key, expectedVersion: 4 + index, eligible: eligible[index] })),
});
const receipt = (keys = both) => ({
  status: 'applied',
  command: 'assign',
  commandVersion: 1,
  resource: 'ticket',
  key: keys[0],
  keys,
  receiptId: 'receipt-1',
  replayed: false,
  result: {},
});
function signIn() {
  mocks.identity = { epoch: 1, mode: 'authenticated', appId: 'desk', accountId: 'manager', tenantRequired: false };
  mocks.app.grantedCommands = ['assign'];
}

test('a bulk command opens its form once for the selection, sends one request naming every key, and reports one outcome', async () => {
  signIn();
  mocks.api.mockImplementation(async (route: string) => (route === '/api/commands/prepare' ? prepared() : receipt()));
  draw({ actions: [close, assign] });
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Assign' }));
  const dialog = await screen.findByRole('dialog', { name: 'Assign' });
  expect(dialog).toHaveTextContent('2 selected records');
  await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Ready to submit 2 records.'));
  expect(mocks.api.mock.calls[0]).toEqual(['/api/commands/prepare', { conn: 'desk', command: 'assign', commandVersion: 1, keys: both }]);
  await userEvent.type(within(dialog).getByLabelText('Reason (required)'), 'Batch');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
  await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Completed.'));
  const executes = mocks.api.mock.calls.filter(([route]) => route === '/api/commands/execute');
  expect(executes).toHaveLength(1);
  expect(executes[0][1]).toMatchObject({
    conn: 'desk',
    command: 'assign',
    commandVersion: 1,
    keys: both,
    expectedVersions: [4, 5],
    input: { reason: 'Batch' },
  });
  expect(mocks.api.mock.calls.some(([route]) => route === '/api/update')).toBe(false);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  const report = screen.getByText('Assign: 2 applied.').parentElement!;
  expect(report).toHaveAttribute('role', 'status');
  // The dialog hands focus to the report once the page behind it is live again.
  await waitFor(() => expect(report).toHaveFocus());
});

test('a bulk command that names its record counts them, in the bar, the dialog and its submit, as the selection narrows', async () => {
  signIn();
  const approve = { ...assign, label: 'Assign ticket' } as AppAction;
  mocks.api.mockImplementation(async (route: string) => (route === '/api/commands/prepare' ? prepared([true, false]) : receipt([both[0]])));
  draw({ actions: [approve] });
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Assign 2 tickets' }));
  const dialog = await screen.findByRole('dialog', { name: 'Assign 2 tickets' });
  expect(within(dialog).getByRole('heading')).toHaveTextContent('Assign 2 tickets');
  expect(within(dialog).getByRole('button', { name: 'Assign 2 tickets' })).toBeDisabled();
  await userEvent.click(within(await within(dialog).findByRole('alert')).getByRole('button', { name: 'Deselect ineligible' }));
  // One left is the label as written.
  expect(within(dialog).getByRole('heading')).toHaveTextContent(/^Assign ticket$/);
  expect(within(dialog).getByRole('button', { name: 'Assign ticket' })).toBeInTheDocument();
});

test('an ineligible record is listed and blocks submit until one click deselects it from the form and the queue', async () => {
  signIn();
  mocks.api.mockImplementation(async (route: string) => (route === '/api/commands/prepare' ? prepared([true, false]) : receipt([both[0]])));
  draw({ actions: [assign] });
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Assign' }));
  const dialog = await screen.findByRole('dialog', { name: 'Assign' });
  const alert = await within(dialog).findByRole('alert');
  expect(
    within(alert)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['VPN drops']);
  await userEvent.type(within(dialog).getByLabelText('Reason (required)'), 'Batch');
  expect(within(dialog).getByRole('button', { name: 'Assign' })).toBeDisabled();
  await userEvent.click(within(alert).getByRole('button', { name: 'Deselect ineligible' }));
  expect(within(dialog).queryByRole('alert')).not.toBeInTheDocument();
  expect(dialog).toHaveTextContent('1 selected record');
  // The dialog makes the queue behind it inert, so read it past the accessibility tree.
  expect(screen.getByRole('toolbar', { name: 'Selected records', hidden: true })).toHaveTextContent('1 selected');
  expect(screen.getByRole('row', { name: /VPN drops/, hidden: true })).toHaveAttribute('aria-selected', 'false');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
  await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent('Completed.'));
  expect(mocks.api.mock.calls.filter(([route]) => route === '/api/commands/prepare')).toHaveLength(1);
  expect(mocks.api.mock.calls.find(([route]) => route === '/api/commands/execute')![1]).toMatchObject({
    keys: [both[0]],
    expectedVersions: [4],
  });
});

test('a refused group is one refusal naming the record it is about, and nothing is reported per record', async () => {
  signIn();
  const message = 'The record has changed. Reload it before trying again.';
  mocks.api.mockImplementation(async (route: string) =>
    route === '/api/commands/prepare'
      ? prepared()
      : { code: 'stale_record', message, error: message, outcome: 'not_applied', key: { id: 2 } },
  );
  draw({ actions: [assign] });
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Assign' }));
  const dialog = await screen.findByRole('dialog', { name: 'Assign' });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Assign' })).toBeEnabled());
  await userEvent.type(within(dialog).getByLabelText('Reason (required)'), 'Batch');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Assign' }));
  await waitFor(() => expect(within(dialog).getByRole('status')).toHaveTextContent(`${message} (VPN drops)`));
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent(`Assign: refused, so none of the 2 records was written. ${message} (VPN drops)`),
  );
  expect(within(screen.getByRole('alert')).queryAllByRole('listitem')).toHaveLength(0);
  expect(toolbar()).toHaveTextContent('2 selected');
});

test('a bulk command needs its own grant and a targets: many reference, not generic write', async () => {
  signIn();
  mocks.allowed = false;
  const { redraw } = draw({ actions: [close, assign] });
  await selectTwo();
  expect(
    within(toolbar())
      .getAllByRole('button')
      .map((button) => button.textContent),
  ).toEqual(['Assign', 'Clear selection']);
  mocks.app.grantedCommands = [];
  redraw({ actions: [close, assign] });
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  mocks.app.grantedCommands = ['assign'];
  const one = { ...assign, command: { ...(assign as { command: object }).command, targets: 'one' } } as AppAction;
  redraw({ actions: [close, one] });
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
});

test('the selection keeps only keys still in the list when rows change', async () => {
  const { redraw } = draw();
  await selectTwo();
  redraw({ rows: rows.filter((row) => row.id !== 2) });
  await waitFor(() => expect(toolbar()).toHaveTextContent('1 selected'));
  expect(option('Printer jammed')).toHaveAttribute('aria-selected', 'true');
  redraw({ rows });
  expect(toolbar()).toHaveTextContent('1 selected');
  expect(option('VPN drops')).toHaveAttribute('aria-selected', 'false');
});

test('a joined queue line retains its target column formatting and output path', () => {
  draw({
    spec: { kind: 'queue', primary: 'subject', lines: ['employee_id.name'] },
    rows: [{ id: 1, subject: 'Approve leave', requester: null, status: 'open', 'employee_id.name': 'Ana' }],
  });
  expect(screen.getByText('Ana')).toBeInTheDocument();
  expect(
    canShowQueue(table, ['id', 'subject', 'employee_id.name'], { kind: 'queue', primary: 'subject', lines: ['employee_id.name'] }),
  ).toBe(true);
});

test('a readonly navigable queue is a plain list with its authored CTA, and cannot select or mutate', async () => {
  draw({ interactive: false, recordNavigation: true, spec: { ...spec, openLabel: 'Review payroll' } });
  expect(screen.getByRole('list', { name: 'Queue' })).toBeInTheDocument();
  expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  expect(screen.queryByRole('row')).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Review payroll Printer jammed' }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith('ticket', { id: '9007199254740993' }, 'Printer jammed', 'push', {
    records: rows.map((row) => ({ key: { id: row.id }, label: row.subject })),
  });
  expect(mocks.api).not.toHaveBeenCalled();
});

test('Open opens the record with its exact key and leaves the selection alone', async () => {
  draw();
  await userEvent.click(option('VPN drops'));
  await userEvent.click(screen.getByRole('button', { name: 'Open Printer jammed' }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith('ticket', { id: '9007199254740993' }, 'Printer jammed', 'push', {
    records: rows.map((row) => ({ key: { id: row.id }, label: row.subject })),
  });
  expect(option('Printer jammed')).toHaveAttribute('aria-selected', 'false');
  expect(option('VPN drops')).toHaveAttribute('aria-selected', 'true');
  expect(toolbar()).toHaveTextContent('1 selected');
});

test('Clear selection empties the selection and the last report; Escape clears only the selection, Dismiss the report', async () => {
  mocks.api.mockResolvedValue(applied({ status: 'closed' }));
  draw();
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.getByText('Close: 2 applied.')).toBeInTheDocument());
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Clear selection' }));
  expect(screen.queryByText('Close: 2 applied.')).not.toBeInTheDocument();
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  await selectTwo();
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(screen.getByText('Close: 2 applied.')).toBeInTheDocument());
  option('Printer jammed').focus();
  await userEvent.keyboard('{Escape}');
  // The selection is gone and so is its bar; the report stays until dismissed.
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  expect(screen.getByText('Close: 2 applied.')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('Close: 2 applied.')).not.toBeInTheDocument();
});

test('a row whose record has an unresolved attempt says so, and rows without a key cannot be selected', async () => {
  let resolve!: (value: unknown) => void;
  mocks.api.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  draw({ rows: [...rows, { id: null as unknown as number, subject: 'No key', requester: null, status: 'open' }] });
  const unkeyed = option('No key');
  expect(unkeyed).toHaveAttribute('aria-disabled', 'true');
  await userEvent.click(unkeyed);
  expect(unkeyed).toHaveAttribute('aria-selected', 'false');
  await userEvent.click(option('Laptop swap'));
  await userEvent.click(within(toolbar()).getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(within(option('Laptop swap')).getByRole('status')).toHaveTextContent('Saving…'));
  expect(toolbar()).toHaveAttribute('aria-busy', 'true');
  expect(toolbar()).toHaveTextContent('Applying 0 of 1…');
  resolve(applied({ status: 'closed' }));
  await waitFor(() => expect(screen.getByText('Close: 1 applied.')).toBeInTheDocument());
});

test('a queue without bulk work is a named list with record links, not a selection surface', () => {
  const client = new QueryClient();
  const { rerender } = render(
    <QueryClientProvider client={client}>
      <QueueList table={table} rows={rows} spec={spec} label="Triage" />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('list', { name: 'Triage' })).toBeInTheDocument();
  expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open Printer jammed' })).toBeEnabled();
  rerender(
    <QueryClientProvider client={client}>
      <QueueList table={table} rows={rows} spec={spec} />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('list', { name: 'Queue' })).toBeInTheDocument();
});

test('a queue requires its primary, its lines and the primary key in the answer', () => {
  expect(canShowQueue(table, ['id', 'subject', 'requester'], spec)).toBe(true);
  const withBadge = { ...spec, badge: 'status' };
  expect(canShowQueue(table, ['id', 'subject', 'requester', 'status'], withBadge)).toBe(true);
  expect(canShowQueue(table, ['id', 'subject', 'requester'], withBadge)).toBe(false);
  expect(canShowQueue(table, ['subject', 'requester'], spec)).toBe(false);
  expect(canShowQueue(table, ['id', 'subject'], spec)).toBe(false);
  expect(canShowQueue(table, ['id', 'subject', 'requester'], { ...spec, lines: ['requester', 'status'] })).toBe(false);
  expect(
    canShowQueue({ ...table, columns: table.columns.map((c) => ({ ...c, primaryKey: false })) }, ['id', 'subject', 'requester'], spec),
  ).toBe(false);
});

test('a reference the list fetched a name for is said by that name, dressed as the column it is read from', async () => {
  const { namedCell } = await import('../../../../kit/src/client/components/listColumn.js');
  const labels = { employee_id: 'employee_id.name' };
  const withRef = { ...table, columns: [...table.columns, { name: 'employee_id', type: 'INTEGER', nullable: true, primaryKey: false }] };
  expect(namedCell(withRef, 'employee_id', { employee_id: 4, 'employee_id.name': 'Ana Diaz' }, labels)).toEqual({
    column: { ...employee.columns[1], name: 'employee_id.name' },
    value: 'Ana Diaz',
  });
  // A name that did not come back leaves the key, and a column with no name fetched is itself.
  expect(namedCell(withRef, 'employee_id', { employee_id: 4, 'employee_id.name': null }, labels)).toMatchObject({
    column: { name: 'employee_id' },
    value: 4,
  });
  expect(namedCell(withRef, 'subject', { subject: 'VPN drops' }, labels)).toMatchObject({
    column: { name: 'subject' },
    value: 'VPN drops',
  });
});

test("a primary that is a reference is said by its record's name, in the title and the Open button", () => {
  const withRef: TableMeta = {
    ...table,
    columns: [...table.columns, { name: 'employee_id', type: 'INTEGER', nullable: true, primaryKey: false }],
  };
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <QueueList
        table={withRef}
        spec={{ kind: 'queue', primary: 'employee_id', lines: ['requester'] }}
        rows={[{ id: 1, employee_id: 4, 'employee_id.name': 'Ana Diaz', requester: 'x' }]}
        referenceLabels={{ employee_id: 'employee_id.name' }}
        label="Triage"
      />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name: 'Open Ana Diaz' })).toBeInTheDocument();
  expect(screen.getByText('Ana Diaz', { selector: '.queue-title' })).toBeInTheDocument();
});

test("a split's chosen rows are buttons that pick their record, and the one beside the list is marked", async () => {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <QueueList
        table={table}
        rows={rows}
        spec={spec}
        actions={[]}
        interactive
        recordNavigation
        pick={{ current: { id: 2 }, avatar: 'requester' }}
      />
    </QueryClientProvider>,
  );
  const picks = screen.getAllByRole('button');
  expect(picks).toHaveLength(3);
  expect(picks.map((button) => button.getAttribute('aria-current'))).toEqual([null, 'true', null]);
  expect(within(picks[1]).getByText('VPN drops')).toBeVisible();
  expect(picks[0].querySelector('.avatar')).not.toBeNull();
  await user.click(picks[2]);
  expect(mocks.open).toHaveBeenCalledWith('ticket', { id: 3 }, 'Laptop swap', 'push', expect.anything());
});

// A field report from the user's own App: a queue drew an enum title raw where the grid drew the rule's words.
test("a queue titles each row by its column's display rule, as the grid does", () => {
  draw({ interactive: false, recordNavigation: true, spec: { ...spec, primary: 'status' } });
  const first = screen.getAllByRole('listitem')[0];
  expect(within(first).getByText('Open now')).toBeInTheDocument();
  expect(within(first).queryByText('open')).not.toBeInTheDocument();
});

test("a shell without the App's commands (the Workbench) offers no bulk command, granted or not", async () => {
  signIn();
  mocks.allowed = false;
  const { installShell, shell } = await import('../../../../kit/src/client/shellMode.js');
  installShell({ slots: { ...shell().slots, bulkCommands: undefined } });
  draw({ actions: [close, assign] });
  /* Nothing to offer, so nothing to select: the rows are not drawn as a selection at all. */
  expect(screen.queryByRole('row', { name: /Printer jammed/ })).not.toBeInTheDocument();
  expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
});
