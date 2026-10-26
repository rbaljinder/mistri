import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { AppQueueList } from '../../packages/mistri/src/shared/app.js';
import { QueueList } from '../../packages/mistri/src/client/components/QueueList.js';
import { applicationFixture, fixture } from '../mocks/core.js';

const column = (name: string, type: string, nullable = false) => ({ name, type, nullable, primaryKey: name === 'id' });
const task: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    column('id', 'INTEGER'),
    column('subject', 'TEXT'),
    column('owner', 'TEXT'),
    column('due_on', 'DATE'),
    column('priority', 'TEXT'),
  ],
};
const rows = [
  { id: 1, subject: 'Review new hire paperwork', owner: 'Maya Chen', due_on: '2026-09-22', priority: 'Today' },
  { id: 2, subject: 'Confirm Q4 planning room', owner: 'Owen Brooks', due_on: '2026-09-24', priority: 'This week' },
  { id: 3, subject: 'Send design handoff notes', owner: 'Priya Shah', due_on: '2026-09-26', priority: 'This week' },
];
const spec: AppQueueList = { kind: 'queue', primary: 'subject', badge: 'priority', facts: ['owner', 'due_on'], openLabel: 'Review task' };

const meta = {
  title: 'Lists/Queue',
  component: QueueList,
  args: { table: task, rows, spec, label: 'Tasks', interactive: false, recordNavigation: true },
  beforeEach: () => {
    fixture({ tables: [task] });
  },
} satisfies Meta<typeof QueueList>;
export default meta;

/** Readonly queues retain a clear row-level CTA for opening each task. */
export const ReadonlyTaskQueue: StoryObj<typeof meta> = {};

/** Omitting facts keeps the original compact queue presentation. */
export const WithoutFacts: StoryObj<typeof meta> = {
  args: { spec: { kind: 'queue', primary: 'subject', lines: ['owner'], openLabel: 'Review task' } },
};

/* A requests queue in half a dashboard's width: the name and its status (a
   dot and its word, from the display map) on one line, the policy and the
   captioned dates and hours on one wrapping line, the action at the end. */
const request: TableMeta = {
  id: 'request',
  name: 'request',
  schema: '',
  isView: false,
  columns: [
    column('id', 'INTEGER'),
    column('employee', 'TEXT'),
    column('policy', 'TEXT'),
    column('status', 'TEXT'),
    column('start_date', 'DATE'),
    column('end_date', 'DATE'),
    column('hours', 'NUMERIC'),
  ],
};
const requests = [
  { id: 1, employee: 'Drew Wilson', policy: 'Vacation', status: 'pending', start_date: '2026-09-24', end_date: '2026-09-25', hours: 16 },
  {
    id: 2,
    employee: 'Alexandra Montgomery-Okafor',
    policy: 'Parental leave',
    status: 'pending',
    start_date: '2026-09-28',
    end_date: '2026-12-18',
    hours: 480,
  },
  { id: 3, employee: 'Robin Taylor', policy: 'Vacation', status: 'pending', start_date: '2026-10-12', end_date: '2026-10-16', hours: 40 },
];
const requestSpec: AppQueueList = {
  kind: 'queue',
  primary: 'employee',
  badge: 'status',
  lines: ['policy'],
  facts: ['start_date', 'end_date', 'hours'],
  openLabel: 'Review request',
};
export const HalfWidth: StoryObj<typeof meta> = {
  args: { table: request, rows: requests, spec: requestSpec, label: 'Time off requests' },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 460 }}>
        <Story />
      </div>
    ),
  ],
  beforeEach: async () => {
    await applicationFixture({
      tables: [request],
      app: {
        id: 'people',
        name: 'People',
        ui: {},
        nav: [],
        views: {},
        resources: {
          request: {
            table: 'request',
            labels: { start_date: 'Starts', end_date: 'Ends', hours: 'Hours' },
            display: { status: { tone: { pending: 'warn', approved: 'good' } }, hours: { format: 'number', unit: 'h' } },
          },
        },
      },
    });
  },
};
/* The narrowest a queue is drawn: its action goes under the row. */
export const Narrow: StoryObj<typeof meta> = {
  ...HalfWidth,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 320 }}>
        <Story />
      </div>
    ),
  ],
};
