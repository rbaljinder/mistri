import type { Meta, StoryObj } from '@storybook/react-vite';
import { DashboardNote } from '../../packages/kit/src/client/components/DashboardNote.js';

const meta = {
  title: 'Dashboards/Guidance',
  component: DashboardNote,
  args: {
    title: 'Reading this board',
    text: 'Pipeline counts every open opportunity; Won compares the last 90 days against the 90 before, with its monthly trend drawn in the card.\n\nPick a window above to narrow the pipeline, won, stage and account sections. Won then compares against the period before the one picked. Closing soon always looks 30 days ahead.',
  },
} satisfies Meta<typeof DashboardNote>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
export const Narrow: StoryObj<typeof meta> = {
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 300 }}>
        <Story />
      </div>
    ),
  ],
};
