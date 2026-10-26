import type { Meta, StoryObj } from '@storybook/react-vite';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import type { AppGanttList } from '../../packages/mistri/src/shared/appModel.js';
import { GanttList, dayOf } from '../../packages/mistri/src/client/components/GanttList.js';
import { fixture } from '../mocks/core.js';

const campaign: TableMeta = {
  id: 'campaign',
  name: 'campaign',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'channel', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'starts_on', type: 'DATE', nullable: false, primaryKey: false },
    { name: 'ends_on', type: 'DATE', nullable: true, primaryKey: false },
    { name: 'done', type: 'INTEGER', nullable: true, primaryKey: false },
  ],
};

/* A row per channel, overlapping campaigns stacked, a share done filled in, and a line at today. A campaign with no end
   date is a mark on its start. Today is fixed so the line stands where the story means it to. */
const rows = [
  { id: 1, name: 'Spring webinar series', channel: 'Webinar', starts_on: '2026-03-02', ends_on: '2026-04-24', done: 100 },
  { id: 2, name: 'Partner roadshow', channel: 'Event', starts_on: '2026-04-06', ends_on: '2026-05-29', done: 100 },
  { id: 3, name: 'Customer summit', channel: 'Event', starts_on: '2026-05-18', ends_on: '2026-06-12', done: 75 },
  { id: 4, name: 'Product launch email', channel: 'Email', starts_on: '2026-04-20', ends_on: '2026-05-15', done: 100 },
  { id: 5, name: 'Summer nurture track', channel: 'Email', starts_on: '2026-05-25', ends_on: '2026-07-31', done: 40 },
  { id: 6, name: 'Developer meetup', channel: 'Event', starts_on: '2026-06-23', ends_on: null, done: null },
  { id: 7, name: 'Fall webinar series', channel: 'Webinar', starts_on: '2026-07-06', ends_on: '2026-08-28', done: 10 },
  { id: 8, name: 'Search campaign refresh', channel: 'Paid', starts_on: '2026-05-04', ends_on: '2026-08-14', done: 55 },
];
const spec: AppGanttList = { kind: 'gantt', start: 'starts_on', end: 'ends_on', primary: 'name', by: 'channel', progress: 'done' };

const meta = {
  title: 'Lists/Gantt',
  component: GanttList,
  args: {
    table: campaign,
    spec,
    entry: { kind: 'table', table: 'campaign', query: 'campaign' },
    label: 'Campaign schedule',
    today: dayOf('2026-06-02')!,
  },
  beforeEach: () => {
    fixture({ tables: [campaign], answer: { '/api/run': () => ({ rows, more: false }) } });
  },
} satisfies Meta<typeof GanttList>;
export default meta;

export const CampaignSchedule: StoryObj<typeof meta> = {};
/* Without `by` each record is a row of its own. */
export const RowPerRecord: StoryObj<typeof meta> = { args: { spec: { ...spec, by: undefined } } };
export const Narrow: StoryObj<typeof meta> = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 400 }}>
        <Story />
      </div>
    ),
  ],
};
