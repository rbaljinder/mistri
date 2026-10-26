import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import { Dashboard } from '../../packages/mistri/src/client/components/Dashboard.js';
import type { DashboardDef } from '../../packages/kit/src/client/components/dashboardModel.js';
import { applicationFixture } from '../mocks/core.js';

/* A people team's day: metrics that open the list they count (the arrow says
   so), and an aside of short lists drawn as names — each whole, a quiet line
   under it and a value at its end — rather than as cramped tables. */
const column = (name: string, type = 'TEXT', references?: { table: string; column: string }) => ({
  name,
  type,
  nullable: false,
  primaryKey: name === 'id',
  ...(references ? { references } : {}),
});
const employee: TableMeta = {
  id: 'employee',
  name: 'employee',
  schema: '',
  isView: false,
  columns: [column('id', 'INTEGER'), column('name'), column('title'), column('status'), column('start_date', 'DATE')],
};
const documentTable: TableMeta = {
  id: 'document',
  name: 'document',
  schema: '',
  isView: false,
  columns: [
    column('id', 'INTEGER'),
    column('employee_id', 'INTEGER', { table: 'employee', column: 'id' }),
    column('title'),
    column('due_date', 'DATE'),
  ],
};
const event: TableMeta = {
  id: 'company_event',
  name: 'company_event',
  schema: '',
  isView: false,
  columns: [column('id', 'INTEGER'), column('title'), column('kind'), column('event_date', 'DATE')],
};
const foreignKeys = [
  { name: 'document_employee', from: { table: 'document', columns: ['employee_id'] }, to: { table: 'employee', columns: ['id'] } },
];

const starting = [
  { id: 11, name: 'Riley Chen-Okonkwo', title: 'Support specialist', start_date: '2026-09-28' },
  { id: 12, name: 'Alexandra Montgomery-Okafor', title: 'Senior platform engineer', start_date: '2026-10-05' },
  { id: 13, name: 'Priya Shah', title: 'Product designer', start_date: '2026-10-19' },
];
const signatures = [
  { id: 1, 'employee_id.name': 'Taylor Morgan', title: 'Employee handbook 2026 acknowledgment', due_date: '2026-09-30' },
  { id: 2, 'employee_id.name': 'Riley Chen-Okonkwo', title: 'Form W-4', due_date: '2026-10-02' },
];
const events = [
  { id: 1, title: 'Taylor Morgan · 3 years', kind: 'anniversary', event_date: '2026-09-25' },
  { id: 2, title: 'Riley Chen-Okonkwo joins Support', kind: 'first_day', event_date: '2026-09-28' },
  { id: 3, title: 'Indigenous Peoples’ Day', kind: 'holiday', event_date: '2026-10-12' },
];
const rowsFor = (q: string) =>
  q.startsWith('employee') ? starting : q.startsWith('document') ? signatures : q.startsWith('company_event') ? events : [];

const dashboard = {
  id: 'today',
  label: 'Today',
  sections: [
    { kind: 'metric', title: 'Active headcount', table: 'employee', query: 'status = active', view: 'people' },
    { kind: 'metric', title: 'Starting soon', table: 'employee', query: 'status = onboarding', view: 'people' },
    { kind: 'metric', title: 'Open signatures', table: 'document' },
    {
      kind: 'note',
      text: 'Payroll for September 16–30 is due for review on Friday. Everything else on this screen can wait until it is done.',
    },
  ],
  aside: [
    { kind: 'rows', title: 'Starting soon', table: 'employee', show: ['name', 'title', 'start_date'], sort: 'start_date', limit: 4 },
    { kind: 'rows', title: 'Awaiting signature', table: 'document', show: ['employee_id.name', 'title'], sort: 'due_date', limit: 4 },
    { kind: 'rows', title: 'Coming up', table: 'company_event', show: ['title', 'kind', 'event_date'], sort: 'event_date', limit: 6 },
  ],
} satisfies DashboardDef;

async function setup(empty = false) {
  await applicationFixture({
    tables: [employee, documentTable, event],
    foreignKeys,
    writable: false,
    app: {
      id: 'people',
      name: 'People',
      ui: {},
      nav: [{ view: 'people', label: 'People' }],
      views: { people: { kind: 'list', table: 'employee', label: 'People' }, today: { kind: 'dashboard', ...dashboard } },
      resources: {
        employee: { table: 'employee', labels: { start_date: 'Starts' }, display: { name: { avatar: true } } },
        company_event: {
          table: 'company_event',
          display: { kind: { tone: { anniversary: 'good', first_day: 'info', holiday: 'neutral' } } },
        },
      },
    },
    answer: {
      '/api/run': ({ q }: { q: string }) => {
        const rows = empty ? [] : rowsFor(q);
        return { rows, total: rows.length, exactTotal: true, errors: [] };
      },
      '/api/breakdown': ({ text }: { text: string }) => ({
        columns: ['count'],
        rows: [{ count: text.startsWith('document') ? 7 : text.includes('onboarding') ? 3 : 42 }],
      }),
    },
  });
}

const meta = {
  title: 'Dashboards/Aside lists and linked metrics',
  component: Dashboard,
  args: { dashboard },
  beforeEach: async () => {
    await setup();
  },
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div style={{ padding: '24px 0' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Dashboard>;
export default meta;

export const AsideLists: StoryObj<typeof meta> = {};
/* Nothing to list: the aside says so in words, never a table's name. */
export const EmptyAside: StoryObj<typeof meta> = {
  beforeEach: async () => {
    await setup(true);
  },
};
