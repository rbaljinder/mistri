import type { Meta, StoryObj } from '@storybook/react-vite';
import { BarChart, DonutChart, LineChart, Sparkline } from '../../packages/kit/src/client/components/Chart.js';

const money = (v: unknown) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact' }).format(Number(v));
const months = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'];
const revenue = months.map((key, i) => ({ key, value: 3_100_000 + i * 210_000 + (i % 3) * 180_000 }));
const pipeline = [
  { key: 'Prospecting', value: 42 },
  { key: 'Qualified', value: 27 },
  { key: 'Proposal', value: 14 },
  { key: 'Negotiation', value: 9 },
  { key: 'Won', value: 6 },
];

const meta = { title: 'Dashboards/Charts', component: LineChart } satisfies Meta<typeof LineChart>;
export default meta;

/* A dashboard measures its section and passes the width (`wide`); drawn at the
   default 600 units across a wider canvas, the story's type was stretched. */
export const Line: StoryObj<typeof meta> = {
  args: { rows: revenue, say: money, wide: 600 },
  render: (args) => (
    <div style={{ maxWidth: 600 }}>
      <LineChart {...args} />
    </div>
  ),
};

/* One series: the quiet bars and the current one (the last) with its value
   said in the pill over it and a guide across to the levels. */
export const Bars: StoryObj<typeof BarChart> = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <BarChart rows={revenue} say={money} wide={600} />
    </div>
  ),
};

/* Bars over categories: in the order they come, biggest first where there is no vocabulary. */
export const BarsByStage: StoryObj<typeof BarChart> = {
  render: () => (
    <div style={{ maxWidth: 480 }}>
      <BarChart rows={pipeline} wide={480} />
    </div>
  ),
};

export const Donut: StoryObj<typeof DonutChart> = { render: () => <DonutChart rows={pipeline} /> };

/* `total` names the figure in the middle, and the legend then says each slice's share. */
export const DonutWithTotal: StoryObj<typeof DonutChart> = { render: () => <DonutChart rows={pipeline} total="Open leads" /> };

/* `curve: 'smooth'` with a series per key: each line keeps its own color from one chart to the next. */
const regions = ['Northeast', 'Southeast', 'Midwest'];
const byRegion = regions.flatMap((series, r) =>
  months.map((key, i) => ({ key, series, value: 820_000 + r * 240_000 + i * (95_000 - r * 20_000) + ((i + r) % 3) * 110_000 })),
);
export const SmoothLines: StoryObj<typeof LineChart> = {
  render: () => (
    <div style={{ maxWidth: 600 }}>
      <LineChart rows={byRegion} say={money} wide={600} smooth seriesVocabulary={regions} />
    </div>
  ),
};

export const Spark: StoryObj<typeof Sparkline> = {
  render: () => (
    <div style={{ width: 160 }}>
      <Sparkline rows={revenue} say={money} />
    </div>
  ),
};
