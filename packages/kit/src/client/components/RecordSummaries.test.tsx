import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { humanName } from '../../../../engine/src/shared/model.js';
import { columnKind, type TableMeta } from '../../../../engine/src/shared/schema.js';

const opened = vi.fn();
vi.mock('../core.js', () => ({
  humanName,
  columnKind,
  columnLabel: () => null,
  columnDisplay: () => null,
  // A link table has no name of its own: its label falls to its key.
  labelPath: (table: TableMeta) => (table.id === 'campaign_member' ? 'campaign_id' : table.id === 'ticket' ? '$label' : 'name'),
  recordLabel: () => undefined,
  state: { schema: undefined },
  keyOf: (_table: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { tenant: row.tenant, id: row.id }),
  rowLabel: (_table: TableMeta, row: Record<string, unknown>) => row.name ?? row.title,
  openRecord: (...args: unknown[]) => opened(...args),
  emptyWord: () => 'Empty',
}));
const { RecordSummaries, fixedColumns, linkTitleColumn, summaryColumns, tableSaysMore } = await import('./RecordSummaries.js');
const table: TableMeta = {
  id: 'request',
  name: 'request',
  schema: '',
  isView: false,
  columns: ['tenant', 'id', 'name', 'account', 'amount', 'date', 'owner', 'status'].map((name) => ({
    name,
    type: 'TEXT',
    nullable: false,
    primaryKey: name === 'tenant' || name === 'id',
  })),
};
afterEach(() => {
  cleanup();
  opened.mockClear();
  vi.restoreAllMocks();
});

test('state is visible, keys are omitted, and authored fact order is retained', () => {
  expect(
    summaryColumns(
      table,
      table.columns.map((column) => column.name),
    ),
  ).toEqual(['status', 'account', 'amount', 'date']);
});

test('a column the question holds to one value is not said on every summary', () => {
  expect(fixedColumns('lead status = new and owner_id = 4 sort created_on desc')).toEqual(['status', 'owner_id']);
  expect(fixedColumns('lead name = "Ada Lovelace"')).toEqual(['name']);
  // Half of an `or`, a range, a window phrase or an inequality is not one value.
  expect(fixedColumns('lead status = new or status = working')).toEqual([]);
  expect(fixedColumns('lead created_on = last 30 days and amount > 5 and status != lost')).toEqual([]);
  expect(fixedColumns(undefined)).toEqual([]);
  const row = { id: 4, name: 'Loading door', status: 'new', account: 'Harbour' };
  render(<RecordSummaries table={table} data={{ rows: [row] }} columns={Object.keys(row)} query="request status = new" />);
  expect(screen.queryByText('new')).not.toBeInTheDocument();
  expect(screen.getByText('Harbour')).toBeInTheDocument();
});

test('nullable summary facts use the empty-value presentation', () => {
  render(
    <RecordSummaries
      table={table}
      data={{ rows: [{ id: 4, name: 'Unassigned', account: null, amount: null }] }}
      columns={['name', 'account', 'amount']}
    />,
  );
  expect(screen.getAllByText('Empty')).toHaveLength(2);
  expect(screen.queryByText('0')).not.toBeInTheDocument();
});

test('related facts reuse joined reference names and retain values when a name is unavailable', () => {
  const rows = [
    { id: 1, name: 'First', account: 123, __account: 'Northstar' },
    { id: 2, name: 'Second', account: 456, __account: null },
  ];
  render(<RecordSummaries table={table} data={{ rows }} columns={['account']} referenceLabels={{ account: '__account' }} />);
  expect(screen.getByText('Northstar')).toBeInTheDocument();
  expect(screen.queryByText('123')).not.toBeInTheDocument();
  expect(screen.getByText('456')).toBeInTheDocument();
});

test('a reference drawn as the title of its record is not said again as a fact', () => {
  const rows = [
    { id: 1, name: 'Alder Court #406', account: 7, __account: 'Alder Court #406', amount: 5 },
    { id: 2, name: 'Cedar Row #8', account: 8, __account: 'Cedar Row #8', amount: 6 },
  ];
  render(
    <RecordSummaries
      table={table}
      data={{ rows }}
      columns={['account', 'amount']}
      labels={{ account: 'Site' }}
      referenceLabels={{ account: '__account' }}
    />,
  );
  expect(screen.queryByText('Site')).not.toBeInTheDocument();
  expect(screen.getAllByText('Alder Court #406')).toHaveLength(1);
});

test('the summary opens the complete composite key and honors local labels', async () => {
  const user = userEvent.setup();
  const row = { tenant: 'north', id: 4, name: 'Replace the loading door', status: 'open', account: 'Harbour' };
  render(
    <RecordSummaries
      table={table}
      data={{ rows: [row], columns: Object.keys(row) }}
      columns={Object.keys(row)}
      labels={{ account: 'Site' }}
    />,
  );
  expect(screen.getByText('Site')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: row.name }));
  expect(opened).toHaveBeenCalledWith('request', { tenant: 'north', id: 4 }, row.name, 'push', {
    records: [{ key: { tenant: 'north', id: 4 }, label: row.name }],
  });
  expect(opened).toHaveBeenCalledTimes(1);
});

test('facts and card gutters open the record; selection and nested controls do not', async () => {
  const user = userEvent.setup();
  const row = { tenant: 'north', id: 4, name: 'Loading door', status: 'open' };
  render(<RecordSummaries table={table} data={{ rows: [row] }} columns={Object.keys(row)} />);
  await user.click(screen.getByText('open'));
  await user.click(screen.getByRole('listitem'));
  expect(opened).toHaveBeenCalledTimes(2);
  const control = document.createElement('button');
  control.textContent = 'Related record';
  screen.getByRole('listitem').append(control);
  await user.click(control);
  expect(opened).toHaveBeenCalledTimes(2);
  vi.spyOn(window, 'getSelection').mockReturnValue({ isCollapsed: false } as Selection);
  await user.click(screen.getByText('open'));
  expect(opened).toHaveBeenCalledTimes(2);
});

test('the keyboard target opens once and a keyless summary never navigates', async () => {
  const user = userEvent.setup();
  const row = { tenant: 'north', id: 4, name: 'Loading door', status: 'open' };
  render(<RecordSummaries table={table} data={{ rows: [row, { ...row, id: null, name: 'No key' }] }} columns={Object.keys(row)} />);
  await user.tab();
  expect(screen.getByRole('button', { name: row.name })).toHaveFocus();
  await user.keyboard('{Enter}');
  expect(opened).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'No key' }));
  await user.click(screen.getAllByRole('listitem')[1]);
  expect(opened).toHaveBeenCalledTimes(1);
});

test('mobile modal navigation receives only loaded complete keys without rounding large IDs', async () => {
  const rows = [
    { tenant: 'north', id: '9007199254740993', name: 'First' },
    { tenant: 'north', id: '9007199254740995', name: 'Second' },
    { name: 'Unkeyed' },
  ];
  render(<RecordSummaries table={table} data={{ rows }} columns={['name']} />);
  await userEvent.setup().click(screen.getByRole('button', { name: 'Second' }));
  expect(opened).toHaveBeenCalledExactlyOnceWith('request', { tenant: 'north', id: '9007199254740995' }, 'Second', 'push', {
    records: [
      { key: { tenant: 'north', id: '9007199254740993' }, label: 'First' },
      { key: { tenant: 'north', id: '9007199254740995' }, label: 'Second' },
    ],
  });
});

test('related projections supply their complete keys and names without exposing key aliases as facts', async () => {
  const rows = [
    { row_tenant: 'north', row_id: '9007199254740993', person: 'Maya Chen', status: 'open' },
    { row_tenant: 'north', row_id: null, person: 'Unavailable', status: 'open' },
  ];
  render(
    <RecordSummaries
      table={table}
      data={{ rows }}
      columns={['status']}
      recordForRow={(row) => ({
        key: typeof row.row_id === 'string' ? { tenant: row.row_tenant, id: row.row_id } : null,
        label: String(row.person),
      })}
    />,
  );
  expect(screen.queryByText('9007199254740993')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Unavailable' })).toBeDisabled();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Maya Chen' }));
  expect(opened).toHaveBeenCalledExactlyOnceWith('request', { tenant: 'north', id: '9007199254740993' }, 'Maya Chen', 'push', {
    records: [{ key: { tenant: 'north', id: '9007199254740993' }, label: 'Maya Chen' }],
  });
});

test("a link row with no name of its own is titled by the row it links to that is not the page's record", () => {
  const member: TableMeta = {
    id: 'campaign_member',
    name: 'campaign_member',
    schema: '',
    isView: false,
    columns: [
      { name: 'campaign_id', type: 'INTEGER', nullable: false, primaryKey: true, references: { table: 'campaign', column: 'id' } },
      { name: 'lead_id', type: 'INTEGER', nullable: false, primaryKey: true, references: { table: 'lead', column: 'id' } },
      { name: 'responded', type: 'INTEGER', nullable: false, primaryKey: false },
    ] as TableMeta['columns'],
  };
  const rows = [{ campaign_id: 6, lead_id: 11, 'campaign_id.name': 'Renewal Nurture Stream', responded: 0 }];
  const columns = ['campaign_id.name', 'responded'];
  render(
    <RecordSummaries
      table={member}
      data={{ rows }}
      columns={columns}
      parent="lead_id"
      recordForRow={(row) => ({ key: { campaign_id: row.campaign_id, lead_id: row.lead_id }, label: String(row.campaign_id) })}
    />,
  );
  // The campaign's card, not "6"; and its name is said once, as the title.
  expect(screen.getByRole('button', { name: 'Renewal Nurture Stream' })).toBeInTheDocument();
  expect(screen.getAllByText('Renewal Nurture Stream')).toHaveLength(1);
  expect(screen.queryByText('6')).not.toBeInTheDocument();
  // Never the record the list is under, and never a row that names itself.
  expect(linkTitleColumn(member, ['lead_id.name'], ['lead_id'])).toBeNull();
  expect(linkTitleColumn(table, ['account'], [])).toBeNull();
});

test('a column that is the title on every row is not said again under it', () => {
  // A template of one column names the row (labelPath answers the template, not the column), so the column was
  // listed by its own name as well.
  const ticket: TableMeta = {
    ...table,
    id: 'ticket',
    columns: ['id', 'title', 'status', 'account'].map((name) => ({ name, type: 'TEXT', nullable: false, primaryKey: name === 'id' })),
  };
  const rows = [{ id: 4, title: 'Outlet not working', status: 'new', account: 'Harbour' }];
  render(<RecordSummaries table={ticket} data={{ rows }} columns={['title', 'status', 'account']} />);
  expect(screen.getAllByText('Outlet not working')).toHaveLength(1);
  expect(screen.queryByText('Title')).not.toBeInTheDocument();
  expect(screen.getByText('Harbour')).toBeInTheDocument();
});

test('the Table is a choice only where it says more than the records: more than four facts, or one a title or a question hides', () => {
  const few = [{ id: 4, name: 'Outlet', status: 'new', account: 'Harbour' }];
  expect(tableSaysMore(table, ['id', 'name', 'status', 'account'], few)).toBe(false);
  const many = [{ id: 4, name: 'Outlet', status: 'new', account: 'Harbour', amount: 3, date: '2026-01-01', owner: 'Ada' }];
  expect(tableSaysMore(table, ['id', 'name', 'status', 'account', 'amount', 'date', 'owner'], many)).toBe(true);
  // What the question fixes is said by the list, not by either reading.
  expect(tableSaysMore(table, ['id', 'name', 'status', 'account'], few, 'request status = new')).toBe(false);
});

test('the host draws an empty fact in place of its empty mark (a suggestion waiting on it), and never a filled one', () => {
  const rows = [
    { id: 1, name: 'Loading door', status: 'new', owner: null },
    { id: 2, name: 'Window latch', status: 'new', owner: 'Ada' },
  ];
  const asked: Array<[unknown, string]> = [];
  render(
    <RecordSummaries
      table={table}
      data={{ rows }}
      columns={['id', 'name', 'status', 'owner']}
      adornFact={(row, column) => {
        asked.push([row.id, column]);
        return column === 'owner' ? <span data-testid="suggested">Suggested</span> : undefined;
      }}
    />,
  );
  // Only the empty fact is asked; the host's answer stands where the empty mark was, and a filled value is the row's own.
  expect(asked).toEqual([[1, 'owner']]);
  expect(screen.getAllByTestId('suggested')).toHaveLength(1);
  expect(screen.getByText('Ada')).toBeInTheDocument();
  expect(screen.queryByText('Empty')).not.toBeInTheDocument();
});
