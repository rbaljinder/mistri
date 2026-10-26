import type { Meta, StoryObj } from '@storybook/react-vite';
import { waitFor } from 'storybook/test';
import type { TableMeta } from '../../packages/engine/src/shared/schema.js';
import { Dashboard } from '../../packages/mistri/src/client/components/Dashboard.js';
import { DashboardNote } from '../../packages/kit/src/client/components/DashboardNote.js';
import { ListNavigationProvider } from '../../packages/kit/src/client/components/listNavigation.js';
import type { DashboardDef, Section } from '../../packages/kit/src/client/components/dashboardModel.js';
import { applicationFixture } from '../mocks/core.js';
import { photo } from './photos.js';

/* A sales desk, drawn by the real dashboard: the 0.8.9 blocks (a banner note,
   a pipeline as steps, a donut with its total, a smooth line per region, the
   window as one button, and the further chart shapes) over fixture answers.
   A breakdown is answered by what it groups by, as the server answers it. */
const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const deal: TableMeta = {
  id: 'deal',
  name: 'deal',
  schema: '',
  isView: false,
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('stage', 'TEXT', { allowed: ['lead', 'qualified', 'proposal', 'won'] }),
    col('region', 'TEXT', { allowed: ['Northeast', 'Southeast', 'Midwest'] }),
    col('amount', 'NUMERIC'),
    col('closed_on', 'DATE'),
  ] as TableMeta['columns'],
};

const stageCounts: Record<string, number> = { lead: 184, qualified: 96, proposal: 41, won: 23 };
const regions = ['Northeast', 'Southeast', 'Midwest'];
const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
const groups = ['Tires', 'Brake pads', 'Batteries', 'Filters', 'Wiper blades', 'Spark plugs', 'Floor mats', 'Bulbs', 'Fuses', 'Washers'];

type Answer = { columns: string[]; rows: Array<Record<string, unknown>> };
function answerFor(text: string): Answer {
  const by = /\bby (.+?)(?: limit \d+)?$/.exec(text)?.[1]?.trim();
  if (!by) return { columns: ['n'], rows: [{ n: text.includes('sum amount') ? 1_284_500 : 344 }] };
  if (by === 'stage') return { columns: ['stage', 'count'], rows: Object.entries(stageCounts).map(([stage, count]) => ({ stage, count })) };
  if (by === 'region')
    return {
      columns: ['region', 'count'],
      rows: regions.map((region, i) => ({ region, count: [132, 88, 64][i] })),
    };
  if (by.startsWith('month closed_on, region'))
    return {
      columns: ['month closed_on', 'region', 'sum amount'],
      rows: regions.flatMap((region, r) =>
        months.map((month, i) => ({
          'month closed_on': month,
          region,
          'sum amount': 90_000 + r * 38_000 + i * (21_000 - r * 4_000) + ((i + r) % 3) * 26_000,
        })),
      ),
    };
  if (by === 'category')
    return { columns: ['category', 'sum amount'], rows: groups.map((category, i) => ({ category, 'sum amount': 190_000 / (i + 1) })) };
  return { columns: [by, 'count'], rows: [] };
}

const sections = {
  banner: {
    kind: 'note',
    variant: 'banner',
    eyebrow: 'Q4 push',
    title: 'Three weeks left in the quarter',
    text: 'Proposals out for more than 14 days are the quickest wins left. Start with the oldest.',
    action: { label: 'Open stale proposals', view: 'deals' },
  },
  metrics: [
    {
      kind: 'metric',
      title: 'Won this period',
      table: 'deal',
      query: 'stage = won',
      measure: 'sum amount',
      over: 'closed_on',
      width: 'third',
    },
    { kind: 'metric', title: 'Open deals', table: 'deal', query: 'stage != won', over: 'closed_on', width: 'third' },
    { kind: 'metric', title: 'Average deal', table: 'deal', measure: 'avg amount', over: 'closed_on', width: 'third' },
  ],
  steps: {
    kind: 'breakdown',
    shape: 'steps',
    title: 'Pipeline',
    table: 'deal',
    by: 'stage',
    notes: { lead: 'Waiting on a first call', qualified: 'Budget confirmed', proposal: 'Out for signature' },
  },
  donut: { kind: 'chart', title: 'Open deals by region', table: 'deal', by: 'region', shape: 'donut', total: 'Open deals', width: 'half' },
  line: {
    kind: 'chart',
    title: 'Revenue by region',
    table: 'deal',
    by: 'month closed_on, region',
    measure: 'sum amount',
    shape: 'line',
    curve: 'smooth',
    width: 'half',
  },
  funnel: { kind: 'chart', title: 'Conversion', table: 'deal', by: 'stage', shape: 'funnel', width: 'half' },
  treemap: {
    kind: 'chart',
    title: 'Revenue by category',
    table: 'deal',
    by: 'category',
    measure: 'sum amount',
    shape: 'treemap',
    width: 'half',
  },
} satisfies Record<string, Section | Section[]>;

async function setup() {
  await applicationFixture({
    tables: [deal],
    writable: false,
    app: {
      id: 'sales',
      name: 'Sales',
      ui: {},
      nav: [{ view: 'deals', label: 'Deals' }],
      views: { deals: { kind: 'list', table: 'deal', label: 'Deals' } },
      resources: {
        deal: {
          table: 'deal',
          display: {
            amount: { format: 'money', currency: 'USD' },
            stage: {
              tone: { lead: 'neutral', qualified: 'info', proposal: 'warn', won: 'good' },
              icons: { lead: 'user', qualified: 'check-circle', proposal: 'file-text', won: 'flag' },
            },
          },
        },
      },
    },
    answer: {
      '/api/breakdown': ({ text }: { text: string }) => answerFor(text),
      '/api/breakdowns': ({ items }: { items: Array<{ text: string }> }) => ({
        results: items.map((item) => ({ status: 200, body: answerFor(item.text) })),
      }),
      '/api/run': () => ({ rows: [], total: 0, exactTotal: true, errors: [] }),
    },
  });
}

const dashboard = (id: string, label: string, list: Array<Section | Section[]>, extra: Partial<DashboardDef> = {}): DashboardDef => ({
  id,
  label,
  sections: list.flat(),
  ...extra,
});

const meta = {
  title: 'Dashboards/Blocks',
  component: Dashboard,
  args: { dashboard: dashboard('desk', 'Sales desk', [sections.banner, sections.metrics, sections.steps].flat()) },
  beforeEach: setup,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <ListNavigationProvider navigate={(view) => ({ href: `/sales/${view}`, onClick: (event) => event.preventDefault() })}>
        <div style={{ padding: '24px 0' }}>
          <Story />
        </div>
      </ListNavigationProvider>
    ),
  ],
} satisfies Meta<typeof Dashboard>;
export default meta;

/* A wide note with its tag over the title, one action and, here, no picture. */
export const BannerNote: StoryObj<typeof meta> = {
  args: { dashboard: dashboard('banner', 'Sales desk', [sections.banner, sections.metrics]) },
};

/* A pipeline as steps in the vocabulary's order, each with its count, a short line and a way into its rows. */
export const PipelineSteps: StoryObj<typeof meta> = {
  args: { dashboard: dashboard('steps', 'Pipeline', [sections.steps]) },
};

/* The window picked from one date-range button; the sections ask for what it says. */
export const WindowButton: StoryObj<typeof meta> = {
  args: {
    dashboard: dashboard('window', 'Sales desk', [sections.metrics, sections.steps], {
      windows: ['last 30 days', 'last 90 days', 'this year'],
      windowControl: 'button',
    }),
  },
};

/* The donut's total and a line per region on a smooth curve, in the grid they are drawn in. The further shapes are
   a part on demand, so the story waits for the funnel's and the treemap's own drawing. */
export const ChartsOnADashboard: StoryObj<typeof meta> = {
  args: { dashboard: dashboard('charts', 'Sales charts', [sections.donut, sections.line, sections.funnel, sections.treemap]) },
  play: async ({ canvasElement }) => {
    await waitFor(
      () => {
        if (!canvasElement.querySelector('.chart-funnel-fill')) throw new Error('The funnel has not arrived');
        if (!canvasElement.querySelector('.chart-tile')) throw new Error('The treemap has not arrived');
      },
      { timeout: 8000 },
    );
  },
};

/* The banner's picture is sized by the banner, never by its file. In a dashboard the picture comes from a file row;
   the note stands alone here so the fixture need not serve one. */
export const BannerWithPicture: StoryObj<typeof DashboardNote> = {
  render: () => (
    <div style={{ padding: '0 24px', maxWidth: 960 }}>
      <section className="page-section dash-note dash-banner width-full">
        <DashboardNote
          variant="banner"
          eyebrow="New this week"
          title="Spring inventory is in"
          text="Two hundred vehicles arrived from auction. Photos and prices are ready to review."
          action={{ label: 'Review the new arrivals', view: 'deals' }}
          image={{ src: photo('scene'), alt: 'A row of cars in a studio' }}
        />
      </section>
    </div>
  ),
};
