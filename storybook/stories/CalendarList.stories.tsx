import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { AppCalendarList } from '../../packages/mistri/src/shared/app.js';
import { CalendarList } from '../../packages/mistri/src/client/components/CalendarList.js';
import { applicationFixture, fixture } from '../mocks/core.js';

const task: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'subject', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'due_on', type: 'DATE', nullable: false, primaryKey: false },
  ],
};
const spec: AppCalendarList = { kind: 'calendar', date: 'due_on', primary: 'subject', lines: ['status'] };

// Dated in the month the story is opened in, so the cards are always on screen.
const now = new Date();
const day = (d: number) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const subjects = [
  'Call Stonebridge',
  'Send the renewal',
  'Quarterly review',
  'Chase the invoice',
  'Site visit',
  'Draft the proposal',
  'Book the demo',
  'Follow up on pricing',
  'Onboarding call',
];
const rows = subjects.map((subject, i) => ({
  id: i + 1,
  subject,
  status: i % 3 ? 'open' : 'done',
  due_on: day([3, 3, 3, 3, 9, 14, 18, 22, 27][i]),
}));

const meta = {
  title: 'Lists/Calendar',
  component: CalendarList,
  args: { table: task, spec, entry: { kind: 'table', table: 'task', query: 'sort due_on' }, label: 'Task calendar' },
  beforeEach: () => {
    fixture({ tables: [task], answer: { '/api/run': () => ({ rows, columns: ['id', 'due_on', 'subject', 'status'] }) } });
  },
} satisfies Meta<typeof CalendarList>;
export default meta;

/* A busy day folds its overflow behind "+N more"; a card's status is a dot and its word, from the display map. */
const monthFixture = async () => {
  await applicationFixture({
    tables: [task],
    app: {
      id: 'tasks',
      name: 'Tasks',
      ui: {},
      nav: [],
      views: {},
      resources: { task: { table: 'task', labels: { status: 'Status' }, display: { status: { tone: { done: 'good', open: 'info' } } } } },
    },
    answer: { '/api/run': () => ({ rows, columns: ['id', 'due_on', 'subject', 'status'] }) },
  });
};
export const Month: StoryObj<typeof meta> = { beforeEach: monthFixture };
export const ReadOnly: StoryObj<typeof meta> = { args: { interactive: false }, beforeEach: monthFixture };

/* Ranges: leave from its first day to its last, a bar across the days it
   spans and on into the next week's row, named through the teammate
   reference, its status a dot and a word from the display map. */
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
const policy: TableMeta = {
  id: 'policy',
  name: 'policy',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
  ],
};
const leave: TableMeta = {
  id: 'leave',
  name: 'leave',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'employee_id', type: 'INTEGER', nullable: false, primaryKey: false, references: { table: 'employee', column: 'id' } },
    { name: 'policy_id', type: 'INTEGER', nullable: false, primaryKey: false, references: { table: 'policy', column: 'id' } },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'start_date', type: 'DATE', nullable: false, primaryKey: false },
    { name: 'end_date', type: 'DATE', nullable: false, primaryKey: false },
  ],
};
const leaveFks = [
  { name: 'leave_employee', from: { table: 'leave', columns: ['employee_id'] }, to: { table: 'employee', columns: ['id'] } },
  { name: 'leave_policy', from: { table: 'leave', columns: ['policy_id'] }, to: { table: 'policy', columns: ['id'] } },
];
const ranged: AppCalendarList = {
  kind: 'calendar',
  date: 'start_date',
  end: 'end_date',
  primary: 'employee_id.name',
  badge: 'status',
  lines: ['policy_id.name'],
};
/* Mondays of the month's grid: the second row always lies inside the month. */
const monday = (row: number) => {
  const d = new Date(now.getFullYear(), now.getMonth(), 1);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 * row);
  return d;
};
const at = (d: Date, plus = 0) => {
  const out = new Date(d);
  out.setDate(d.getDate() + plus);
  return `${out.getFullYear()}-${String(out.getMonth() + 1).padStart(2, '0')}-${String(out.getDate()).padStart(2, '0')}`;
};
const leaves = [
  { id: 1, name: 'Morgan Lee', policy: 'Parental leave', status: 'approved', start: at(monday(0), -10), end: at(monday(4), 3) },
  { id: 2, name: 'Jordan Brooks', policy: 'Vacation', status: 'pending', start: at(monday(1), 3), end: at(monday(2), 1) },
  { id: 3, name: 'Quinn Davis', policy: 'Personal', status: 'approved', start: at(monday(1), 0), end: at(monday(1), 1) },
  { id: 4, name: 'Riley Chen-Okonkwo', policy: 'Sick leave', status: 'approved', start: at(monday(2), 4), end: at(monday(2), 4) },
  { id: 5, name: 'Casey Williams', policy: 'Vacation', status: 'declined', start: at(monday(3), 1), end: at(monday(3), 3) },
].map(({ id, name, policy, status, start, end }) => ({
  id,
  'employee_id.name': name,
  'policy_id.name': policy,
  status,
  start_date: start,
  end_date: end,
}));

export const LeaveRanges: StoryObj<typeof meta> = {
  args: { table: leave, spec: ranged, entry: { kind: 'table', table: 'leave', query: 'sort start_date' }, label: 'Who’s out' },
  beforeEach: async () => {
    await applicationFixture({
      tables: [leave, employee, policy],
      foreignKeys: leaveFks,
      app: {
        id: 'people',
        name: 'People',
        ui: {},
        nav: [],
        views: {},
        resources: {
          leave: {
            table: 'leave',
            labels: { status: 'Status' },
            display: { status: { tone: { approved: 'good', pending: 'warn', declined: 'bad' } } },
          },
        },
      },
      answer: { '/api/run': () => ({ rows: leaves }) },
    });
  },
};
