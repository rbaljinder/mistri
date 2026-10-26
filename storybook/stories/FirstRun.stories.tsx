import type { Meta, StoryObj } from '@storybook/react-vite';
import { FirstRun } from '../../packages/mistri/src/client/components/FirstRun.js';
import type { Section } from '../../packages/kit/src/client/components/dashboardModel.js';
import { applicationFixture } from '../mocks/core.js';
import { task, rep } from './taskFixture.js';

/* A new App's home, as `firstRun(title, steps)` draws it in place of a
   dashboard of zeros: each step a link to its list, the next one primary,
   and a step done once its table has a row. */
const meta = {
  title: 'Dashboards/First run',
  beforeEach: async () => {
    await applicationFixture({
      tables: [task, rep],
      app: {
        id: 'fieldwork',
        name: 'Fieldwork',
        home: 'overview',
        ui: { shell: { counts: false } },
        views: {
          overview: { label: 'Overview', sections: [] },
          people: { table: 'rep', label: 'People' },
          tasks: { table: 'task', label: 'Tasks' },
        },
        nav: [
          { view: 'overview', label: 'Overview' },
          { view: 'people', label: 'People' },
          { view: 'tasks', label: 'Tasks' },
        ],
        resources: { task: {}, rep: {} },
      },
    });
  },
} satisfies Meta;
export default meta;

const section = {
  kind: 'firstRun',
  title: 'Welcome to Fieldwork',
  text: 'Two steps and the dashboard has something to say.',
  steps: [
    { label: 'Add the people on your team', view: 'people', detail: 'Tasks are assigned to them.' },
    { label: 'Add the first task', view: 'tasks', detail: 'What needs doing, by when, and by whom.' },
  ],
} as unknown as Section;

export const Fresh: StoryObj = { render: () => <FirstRun section={section} done={[false, false]} fresh /> };
export const Started: StoryObj = { render: () => <FirstRun section={section} done={[true, false]} fresh={false} /> };
