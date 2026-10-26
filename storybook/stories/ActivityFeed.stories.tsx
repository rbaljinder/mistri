import type { Meta, StoryObj } from '@storybook/react-vite';
import { ActivityFeed } from '../../packages/mistri/src/client/components/DashboardActivity.js';
import type { Section } from '../../packages/kit/src/client/components/dashboardModel.js';
import { applicationFixture } from '../mocks/core.js';
import { task, rep } from './taskFixture.js';

/* A dashboard's `activity()`: the newest changes across the resources it
   names, as the server answers them for this reader — what each write did,
   the record by its name, its first field from what to what, who and when. */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const entries = [
  {
    table: 'task',
    key: { id: 2 },
    label: 'Draft the renewal proposal',
    at: minutesAgo(6),
    kind: 'update',
    via: 'app',
    action: 'Start work',
    by: 'Tariq Osei',
    fields: [{ column: 'status', before: 'open', after: 'in_progress' }],
  },
  {
    table: 'task',
    key: { id: 5 },
    label: 'Update the handover notes',
    at: minutesAgo(38),
    kind: 'update',
    via: 'app',
    by: 'Nia Andersen',
    fields: [{ column: 'due_on', before: '2026-09-16', after: '2026-09-18' }],
  },
  {
    table: 'task',
    key: { id: 13 },
    label: 'Order more pallet wrap',
    at: minutesAgo(95),
    kind: 'insert',
    via: 'app',
    by: 'Isla Fontaine',
    fields: [{ column: 'title', after: 'Order more pallet wrap' }],
  },
  {
    table: 'rep',
    key: { id: 5 },
    label: 'Marcus Webb',
    at: minutesAgo(140),
    kind: 'insert',
    via: 'app',
    by: 'Hugo Duval',
    fields: [{ column: 'name', after: 'Marcus Webb' }],
  },
];

const meta = {
  title: 'Dashboards/Activity',
  beforeEach: async () => {
    await applicationFixture({
      tables: [task, rep],
      app: {
        id: 'fieldwork',
        name: 'Fieldwork',
        home: 'overview',
        ui: { shell: { counts: false } },
        views: { overview: { label: 'Overview', sections: [] } },
        nav: [{ view: 'overview', label: 'Overview' }],
        resources: {
          task: { noun: { one: 'task', many: 'tasks' }, labels: { due_on: 'Due', status: 'Status' } },
          rep: { noun: { one: 'person', many: 'people' } },
        },
      },
      answer: { '/api/record-activity': () => ({ entries }) },
    });
  },
} satisfies Meta;
export default meta;

const section = {
  kind: 'activity',
  title: 'Latest updates',
  resources: { task: { icon: 'list-checks' }, rep: { icon: 'users' } },
} as unknown as Section;

export const Feed: StoryObj = {
  render: () => (
    <section className="page-section width-full">
      <h2 className="page-section-title">Latest updates</h2>
      <ActivityFeed section={section} dashboard="overview" at={0} />
    </section>
  ),
};
