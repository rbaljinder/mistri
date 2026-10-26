import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { SlotProps } from '../../packages/kit/src/client/components/pageContext.js';
import type { HttpViewDefinition } from '../../packages/engine/src/shared/resourceHttp.js';
import { ListSection } from '../../packages/kit/src/client/components/PageRelated.js';
import { applicationFixture } from '../mocks/core.js';

const account: TableMeta = {
  id: 'account',
  name: 'account',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
  ],
};
const table: TableMeta = {
  id: 'invoice',
  name: 'invoice',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'account_id', type: 'INTEGER', primaryKey: false, nullable: false, references: { table: 'account', column: 'id' } },
    ...['name', 'status', 'amount', 'due_on'].map((name) => ({
      name,
      type: name === 'amount' ? 'NUMERIC' : name === 'due_on' ? 'DATE' : 'TEXT',
      primaryKey: false,
      nullable: true,
    })),
  ],
};
const rows = [
  {
    id: '9007199254740993',
    name: 'Northstar onboarding and implementation',
    account_id: 1,
    'account_id.name': 'Northstar',
    status: 'Open',
    amount: 12450,
    due_on: '2026-10-02',
  },
  {
    id: '9007199254740995',
    name: 'Quarterly account support',
    account_id: 1,
    'account_id.name': 'Northstar',
    status: 'Paid',
    amount: 3750,
    due_on: '2026-09-15',
  },
];
const section = {
  kind: 'list' as const,
  from: 'invoice',
  title: 'Invoices',
  columns: ['name', 'status', 'account_id', 'amount', 'due_on'],
  empty: { title: 'No invoices yet', message: 'Invoices for this account will appear here.' },
};
const props: SlotProps = {
  section,
  index: 0,
  base: account,
  recordKey: { id: 1 },
  foldable: false,
  onEdit: () => {},
  entry: { kind: 'page', pageId: 'account', table: 'account', key: { id: 1 } },
  page: { id: 'account', name: 'Account', base: 'account', source: 'config', sections: [section] },
  plan: {
    index: 0,
    view: { id: 'account-invoices', name: 'Invoices', base: 'invoice', columns: section.columns.map((path) => ({ path })) },
  },
};
/* The footer's sums: one aggregate row, as the server answers a totals view. */
const totalsView: HttpViewDefinition = {
  id: 'account-invoices:totals',
  name: 'Invoices totals',
  base: 'account',
  columns: [{ path: 'id' }],
  aggregates: [{ fn: 'sum', via: 'invoice.account_id', column: 'amount', alias: 'total_0' }],
};
async function setup(empty = false, matched = rows.length) {
  await applicationFixture({
    tables: [account, table],
    writable: false,
    app: {
      id: 'billing',
      name: 'Billing',
      ui: {},
      nav: [],
      views: { invoices: { table: 'invoice', label: 'Invoices' } },
      resources: {
        invoice: {
          table: 'invoice',
          recordLabel: 'name',
          labels: { account_id: 'Account', amount: 'Amount due', due_on: 'Due date' },
          display: { amount: { format: 'money', currency: 'USD' } },
        },
      },
    },
    answer: {
      '/api/view/run': ({ view }: { view: HttpViewDefinition }) =>
        view.aggregates?.length
          ? {
              view,
              columns: ['id', 'total_0'],
              rows: [{ id: 1, total_0: 48_615 }],
              total: 1,
              more: false,
              limit: 1,
              offset: 0,
              errors: [],
              resolved: [],
              joinCount: 0,
              ms: 1,
            }
          : {
              view,
              columns: view.columns.map((column) => column.alias ?? column.path),
              rows: empty
                ? []
                : rows.map((row) =>
                    Object.fromEntries(view.columns.map((column) => [column.alias ?? column.path, row[column.path as keyof typeof row]])),
                  ),
              total: empty ? 0 : matched,
              more: !empty && matched > rows.length,
              limit: 10,
              offset: 0,
              errors: [],
              resolved: [],
              joinCount: 0,
              ms: 1,
            },
    },
  });
}
const meta = {
  title: 'Records/Related collections',
  beforeEach: async () => {
    await setup();
  },
} satisfies Meta;
export default meta;
export const TableAndPhoneRecords: StoryObj = { render: () => <ListSection {...props} /> };
export const Empty: StoryObj = {
  beforeEach: async () => {
    await setup(true);
  },
  render: () => <ListSection {...props} />,
};
export const MissingReference: StoryObj = {
  render: () => <ListSection {...props} section={{ ...section, of: 'account_id' }} plan={{ index: 0, empty: true }} />,
};
/* A footer of sums over every related row — here more than the page shows, so it says what it sums. */
export const Totals: StoryObj = {
  beforeEach: async () => {
    await setup(false, 12);
  },
  render: () => <ListSection {...props} section={{ ...section, totals: ['amount'] }} plan={{ ...props.plan, totals: totalsView }} />,
};
/* `empty: 'hide' | 'collapse'`: whether an empty list is left out or said in one line with its neighbours is the page's
   to decide (PageEmptyRun.tsx); the list itself still says its own emptiness. */
export const SaysItsOwnEmptiness: StoryObj = {
  beforeEach: async () => {
    await setup(true);
  },
  render: () => (
    <div>
      <p className="note">The section above.</p>
      <ListSection {...props} section={{ ...section, empty: undefined, emptyMode: 'hide' }} />
      <p className="note">The section below.</p>
    </div>
  ),
};
