import type { Meta, StoryObj } from '@storybook/react-vite';
import { Metric } from '../../packages/mistri/src/client/components/Dashboard.js';
import type { Section } from '../../packages/kit/src/client/components/dashboardModel.js';
import { applicationFixture } from '../mocks/core.js';
import { task, rep } from './taskFixture.js';

/* A dashboard's strip of stat cards, as the dashboard draws it: the figure,
   its label, the delta against a compare window, a target's meter, the
   twelve-month spark, and the honest dash when a card cannot be read. */
const figures: Record<string, number> = { now: 128, compared: 112, done: 46, overdue: 9, before: 14 };
const measure = (text: string) => {
  if (text.includes('by month')) {
    return {
      columns: ['month', 'count'],
      rows: Array.from({ length: 12 }, (_, i) => ({
        month: `2025-${String(((i + 9) % 12) + 1).padStart(2, '0')}`,
        count: 60 + Math.round(30 * Math.sin(i / 2)) + i * 4,
      })),
    };
  }
  const value = text.includes('compare-window')
    ? figures.compared
    : text.includes('status = done')
      ? figures.done
      : text.includes('due_on < today')
        ? text.includes('last 30 days')
          ? figures.before
          : figures.overdue
        : figures.now;
  return { columns: ['count'], rows: [{ count: value }] };
};
const meta = {
  title: 'Dashboards/Stat cards',
  beforeEach: async () => {
    await applicationFixture({
      tables: [task, rep],
      app: { id: 'fieldwork', name: 'Fieldwork', ui: {}, nav: [], views: {}, resources: {} },
      answer: { '/api/breakdown': ({ text }: { text?: string }) => measure(String(text)) },
    });
  },
} satisfies Meta;
export default meta;

const card = (section: Partial<Section>): Section => ({ kind: 'metric', table: 'task', ...section }) as Section;
const Strip = ({ sections }: { sections: Section[] }) => (
  <section className="page-section width-full dash-strip">
    <div className="home-cards">
      {sections.map((section, i) => (
        <Metric key={i} section={section} />
      ))}
    </div>
  </section>
);

export const Figures: StoryObj = {
  render: () => (
    <Strip
      sections={[
        card({ title: 'Open tasks', query: 'status in (open, in_progress)', compare: 'compare-window', better: 'down' }),
        card({ title: 'Done this month', query: 'status = done', target: 60 }),
        card({ title: 'Overdue', query: 'due_on < today', compare: 'due_on < today and created = last 30 days', better: 'down' }),
        card({ title: 'Created, last 12 months', spark: true, over: 'due_on' }),
      ]}
    />
  ),
};

/* Each card with its mark, and a trend drawn in its change's news: open
   tasks rose where fewer is better, so that trend is red; overdue fell, so
   its trend is green. */
export const TrendsAndMarks: StoryObj = {
  render: () => (
    <Strip
      sections={[
        card({
          title: 'Open tasks',
          icon: 'list-checks',
          query: 'status in (open, in_progress)',
          compare: 'compare-window',
          better: 'down',
          spark: true,
          over: 'due_on',
        }),
        card({
          title: 'Overdue',
          icon: 'warning',
          query: 'due_on < today',
          compare: 'due_on < today and created = last 30 days',
          better: 'down',
          spark: true,
          over: 'due_on',
        }),
        card({ title: 'Done this month', icon: 'check-circle', query: 'status = done', target: 60 }),
      ]}
    />
  ),
};

/* One card that cannot be read: the dash, and its reason in the title. */
export const Unavailable: StoryObj = {
  render: () => (
    <Strip
      sections={[
        card({ title: 'Open tasks', query: 'status in (open, in_progress)' }),
        card({ title: 'Billable hours', error: 'The column "hours" is not on task.' }),
      ]}
    />
  ),
};
