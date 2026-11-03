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

/* A week and a day as a time grid (`span`): the hours down the side, each meeting placed by its start and end, the
   two that overlap on the third day side by side, a line at the present moment. */
const meeting: TableMeta = {
  id: 'meeting',
  name: 'meeting',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'title', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'status', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'room', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'starts_at', type: 'TIMESTAMP', nullable: false, primaryKey: false },
    { name: 'ends_at', type: 'TIMESTAMP', nullable: true, primaryKey: false },
  ],
};
const thisMonday = (() => {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
})();
const moment = (plus: number, time: string) => `${at(thisMonday, plus)}T${time}:00`;
const meetings = [
  { title: 'Standup', room: 'Pine', status: 'confirmed', day: 0, from: '09:00', to: '09:30' },
  { title: 'Pipeline review', room: 'Oak', status: 'confirmed', day: 0, from: '13:00', to: '14:30' },
  { title: 'Standup', room: 'Pine', status: 'confirmed', day: 1, from: '09:00', to: '09:30' },
  { title: 'Customer call: Stonebridge', room: 'Online', status: 'tentative', day: 1, from: '11:00', to: '12:00' },
  { title: 'Design critique', room: 'Oak', status: 'confirmed', day: 2, from: '10:00', to: '11:30' },
  { title: 'Hiring sync', room: 'Birch', status: 'tentative', day: 2, from: '10:30', to: '11:00' },
  { title: 'Lunch and learn', room: 'Atrium', status: 'confirmed', day: 2, from: '12:00', to: '13:00' },
  { title: 'Quarterly planning', room: 'Oak', status: 'confirmed', day: 3, from: '14:00', to: '17:00' },
  { title: 'Standup', room: 'Pine', status: 'confirmed', day: 4, from: '09:00', to: '09:30' },
  { title: 'Renewal check-in', room: 'Online', status: 'cancelled', day: 4, from: '15:00', to: '15:45' },
].map(({ title, room, status, day: plus, from, to }, i) => ({
  id: i + 1,
  title,
  room,
  status,
  starts_at: moment(plus, from),
  ends_at: moment(plus, to),
}));
const timed: AppCalendarList = {
  kind: 'calendar',
  date: 'starts_at',
  end: 'ends_at',
  span: 'week',
  primary: 'title',
  badge: 'status',
  lines: ['room'],
};
const meetingFixture = async (rows = meetings) => {
  await applicationFixture({
    tables: [meeting],
    app: {
      id: 'meetings',
      name: 'Meetings',
      ui: {},
      nav: [],
      views: {},
      resources: {
        meeting: {
          table: 'meeting',
          labels: { status: 'Status' },
          display: { status: { tone: { confirmed: 'good', tentative: 'warn', cancelled: 'bad' } } },
        },
      },
    },
    answer: { '/api/run': () => ({ rows }) },
  });
};
export const Week: StoryObj<typeof meta> = {
  args: { table: meeting, spec: timed, entry: { kind: 'table', table: 'meeting', query: 'sort starts_at' }, label: 'Meetings' },
  beforeEach: () => meetingFixture(),
};
export const Day: StoryObj<typeof meta> = {
  args: {
    table: meeting,
    spec: { ...timed, span: 'day' },
    entry: { kind: 'table', table: 'meeting', query: 'sort starts_at' },
    label: 'Meetings',
  },
  /* The day opens on today: the week's busiest day, the critique and the hiring sync side by side, moved onto it. */
  beforeEach: () =>
    meetingFixture(
      meetings
        .filter((row) => row.starts_at.startsWith(at(thisMonday, 2)))
        .map((row) => ({
          ...row,
          starts_at: `${at(now)}${row.starts_at.slice(10)}`,
          ends_at: `${at(now)}${row.ends_at.slice(10)}`,
        })),
    ),
};
