/**
 * The queue's selection on a grid: a checkbox portalled into each row's
 * host cell, select all in the header row's for the loaded rows, and the
 * same bulk bar and per-record writes as the queue.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { columnKind, type TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppAction } from '../../../../mistri/src/shared/app.js';

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  open: vi.fn(),
  allowed: true,
  resources: {} as Record<string, unknown>,
  identity: { epoch: 1, mode: 'anonymous', tenantRequired: false } as Record<string, unknown>,
  state: { activeConnection: 'desk', connections: [{ id: 'desk', writable: true }] },
}));
const table: TableMeta = {
  id: 'ticket',
  name: 'ticket',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'subject', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
import { quoteValue } from '../../../../engine/src/shared/query.js';
vi.mock('../core.js', () => ({
  api: mocks.api,
  columnDisplay: () => null,
  openRecord: mocks.open,
  state: mocks.state,
  toast: vi.fn(),
  columnLabel: () => undefined,
  refsFrom: () => [],
  columnKind,
  viewportSize: () => ({ width: 1280, height: 800 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  writeAllowed: () => mocks.allowed,
  findTable: () => table,
  primaryKey: (t: TableMeta) => t.columns.filter((c) => c.primaryKey).map((c) => c.name),
  quote: quoteValue,
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => row.subject,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../sessionIdentity.js', () => ({
  sessionIdentity: () => mocks.identity,
  captureSessionIdentity: () => mocks.identity,
  tenantLeaseActive: () => false,
  captureTenantLease: () => undefined,
  subscribeTenantLease: () => () => {},
  subscribeSessionIdentity: () => () => {},
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: vi.fn() }));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => ({ grantedCommands: [], resources: mocks.resources }) }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
const { GridSelection } = await import('./GridSelection.js');
const { RowHosts, useRowHostScope } = await import('./RowHost.js');
const { bulkKey } = await import('../bulkActions.js');

const rows = [
  { id: '9007199254740993', subject: 'Printer jammed', status: 'open' },
  { id: 2, subject: 'VPN drops', status: 'open' },
];
const close: AppAction = { id: 'close', label: 'Close', set: { status: 'closed' }, bulk: true };

/** What the grid does with the scope: a host in the header row and one per keyed row, and a row click that opens. */
function StandInGrid() {
  const store = useRowHostScope()!;
  return (
    <table>
      <thead>
        <tr>
          <th className="row-host" ref={store.headRef} />
          <th>Subject</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const id = bulkKey(table, { id: row.id });
          return (
            <tr key={id} onClick={() => mocks.open(row.id)}>
              <td className="row-host" ref={store.ref(id)} />
              <td>{row.subject}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function draw(actions: AppAction[] = [close]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RowHosts>
        <GridSelection table={table} rows={rows} actions={actions} interactive />
        <StandInGrid />
      </RowHosts>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mocks.api.mockReset();
  mocks.open.mockReset();
  mocks.allowed = true;
  mocks.resources = { ticket: { noun: { one: 'ticket', many: 'tickets' } } };
});
afterEach(cleanup);

test('each row gets a checkbox in its host cell, and choosing a row does not open it', async () => {
  draw();
  const box = await screen.findByRole('checkbox', { name: 'Select VPN drops' });
  expect(box.closest('td')).toHaveClass('row-host');
  await userEvent.click(box);
  expect(box).toBeChecked();
  expect(mocks.open).not.toHaveBeenCalled();
  expect(screen.getByRole('toolbar', { name: 'Selected records' })).toHaveTextContent('1 selected');
});

test('select all takes every loaded row, and the bulk action writes each key once, big ids as sent', async () => {
  mocks.api.mockImplementation(async (path: string, body: { values?: Record<string, unknown> }) =>
    path === '/api/update' ? { affected: 1, applied: body.values } : { rows: rows.map((r) => ({ id: r.id })) },
  );
  draw();
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select all tickets' }));
  expect(screen.getByRole('toolbar', { name: 'Selected records' })).toHaveTextContent('2 selected');
  await userEvent.click(screen.getByRole('button', { name: 'Close' }));
  await waitFor(() => expect(mocks.api.mock.calls.filter(([path]) => path === '/api/update')).toHaveLength(2));
  const keys = mocks.api.mock.calls.filter(([path]) => path === '/api/update').map(([, body]) => body.key);
  expect(keys).toEqual([{ id: '9007199254740993' }, { id: 2 }]);
});

test('select all is the header row’s box, with no label or count: unchecked, mixed, checked, and a press when checked clears', async () => {
  draw();
  const all = await screen.findByRole('checkbox', { name: 'Select all tickets' });
  expect(all.closest('th')).toHaveClass('row-host');
  expect(all.closest('th')).toHaveTextContent('');
  expect(screen.queryByText(/Select all/)).toBeNull();
  expect(all).not.toBeChecked();
  expect(all).not.toBePartiallyChecked();

  await userEvent.click(screen.getByRole('checkbox', { name: 'Select VPN drops' }));
  expect(all).toBePartiallyChecked();
  expect(all).not.toBeChecked();

  // Mixed takes everything, as unchecked does.
  await userEvent.click(all);
  expect(all).toBeChecked();
  expect(all).not.toBePartiallyChecked();
  expect(screen.getByRole('checkbox', { name: 'Select Printer jammed' })).toBeChecked();
  expect(screen.getByRole('toolbar', { name: 'Selected records' })).toHaveTextContent('2 selected');

  await userEvent.click(all);
  expect(all).not.toBeChecked();
  expect(all).not.toBePartiallyChecked();
  expect(screen.getByRole('checkbox', { name: 'Select VPN drops' })).not.toBeChecked();
  expect(screen.queryByRole('toolbar')).toBeNull();
});

test('a resource without a noun of its own is said as rows', async () => {
  mocks.resources = {};
  draw();
  expect(await screen.findByRole('checkbox', { name: 'Select all rows' })).toBeInTheDocument();
});

test('a reader offered no bulk action gets no checkboxes and no bar', () => {
  mocks.allowed = false;
  draw();
  expect(screen.queryByRole('checkbox')).toBeNull();
  expect(screen.queryByRole('toolbar')).toBeNull();
});

function drawEditable(editable: string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RowHosts>
        <GridSelection table={table} rows={rows} actions={[]} interactive editable={editable} />
        <StandInGrid />
      </RowHosts>
    </QueryClientProvider>,
  );
}

test('an editable list offers "Set field…": one value, written per record, answered in the bulk report', async () => {
  mocks.api.mockImplementation(async (_path: string, body: { key: { id: unknown }; values: Record<string, unknown> }) =>
    body.key.id === 2
      ? { outcome: 'rejected', errors: [{ message: 'VPN tickets keep their subject.' }] }
      : { affected: 1, applied: body.values },
  );
  drawEditable(['subject', 'status']);
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select all tickets' }));
  await userEvent.click(screen.getByRole('button', { name: 'Set field…' }));
  const dialog = await screen.findByRole('dialog', { name: 'Set a field' });
  expect(dialog).toHaveTextContent('Writes one value to 2 selected records.');
  await userEvent.type(screen.getByRole('textbox', { name: 'Subject' }), 'Needs triage');
  await userEvent.click(screen.getByRole('button', { name: 'Set Subject' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Set Subject: 1 applied, 1 rejected.'));
  expect(screen.getByRole('alert')).toHaveTextContent('VPN drops: VPN tickets keep their subject.');
  const sent = mocks.api.mock.calls.filter(([path]) => path === '/api/update').map(([, body]) => [body.key, body.values]);
  expect(sent).toEqual([
    [{ id: '9007199254740993' }, { subject: 'Needs triage' }],
    [{ id: 2 }, { subject: 'Needs triage' }],
  ]);
});

test('"Set field…" checks the value as a record form does before writing anything', async () => {
  drawEditable(['subject']);
  await userEvent.click(await screen.findByRole('checkbox', { name: 'Select VPN drops' }));
  await userEvent.click(screen.getByRole('button', { name: 'Set field…' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Set Subject' }));
  expect(await screen.findByText('Required')).toBeInTheDocument();
  expect(mocks.api).not.toHaveBeenCalled();
});

test('a reader who may not write gets no "Set field…"', () => {
  mocks.allowed = false;
  drawEditable(['subject']);
  expect(screen.queryByRole('checkbox')).toBeNull();
});
