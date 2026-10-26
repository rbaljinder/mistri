import type { Decorator, Meta, StoryObj } from '@storybook/react-vite';
import { ChartShape } from '../../packages/kit/src/client/components/ChartShapes.js';

/* The dashboard's further chart shapes, each drawn from the answer a breakdown
   gives (columns, then rows) as the dashboard hands it over. They are a part
   on demand in the App; here the module is imported whole, so a capture needs
   no wait. */
const money = (v: unknown) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact' }).format(Number(v));
const plain = (v: unknown) => String(v);

const meta = { title: 'Dashboards/Chart shapes', component: ChartShape, parameters: { layout: 'padded' } } satisfies Meta<
  typeof ChartShape
>;
export default meta;

const framed = (width: number): Decorator[] => [
  (Story) => (
    <div style={{ maxWidth: width }}>
      <Story />
    </div>
  ),
];

/* A dot per group: reps placed by deals worked across and revenue up. */
export const Scatter: StoryObj<typeof meta> = {
  args: {
    shape: 'scatter',
    answer: {
      columns: ['owner', 'count', 'sum amount'],
      rows: [
        { owner: 'Maya Chen', count: 14, 'sum amount': 412_000 },
        { owner: 'Owen Brooks', count: 22, 'sum amount': 288_000 },
        { owner: 'Priya Shah', count: 9, 'sum amount': 536_000 },
        { owner: 'Noah Williams', count: 31, 'sum amount': 640_000 },
        { owner: 'Elena Rossi', count: 18, 'sum amount': 351_000 },
        { owner: 'Marcus Reed', count: 6, 'sum amount': 97_000 },
        { owner: 'Sofia Alvarez', count: 26, 'sum amount': 502_000 },
      ],
    },
    say: money,
    sayX: plain,
    names: { x: 'count', y: 'sum amount' },
    label: plain,
    wide: 560,
  },
  decorators: framed(560),
};

/* Weekday by hour; an hour with nothing keeps its column as a pale one. */
const days: Record<string, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri' };
const busy = (day: number, hour: number) =>
  Math.round(Math.max(0, 14 - Math.abs(hour - 11) * 3 - Math.abs(day - 3) * 1.5) + ((day * hour) % 4));
export const Heatmap: StoryObj<typeof meta> = {
  args: {
    shape: 'heatmap',
    answer: {
      columns: ['weekday moved_at', 'hour moved_at', 'count'],
      rows: [1, 2, 3, 4, 5].flatMap((day) =>
        [8, 9, 10, 11, 13, 14, 15, 16].map((hour) => ({
          'weekday moved_at': String(day),
          'hour moved_at': String(hour).padStart(2, '0'),
          count: busy(day, hour),
        })),
      ),
    },
    say: plain,
    label: (key) => days[String(key)] ?? String(key),
    seriesLabel: plain,
    wide: 560,
  },
  decorators: framed(560),
};

/* Each month's rise or fall from where the last ended, then the total. */
export const Waterfall: StoryObj<typeof meta> = {
  args: {
    shape: 'waterfall',
    answer: {
      columns: ['month', 'sum change'],
      rows: [
        { month: '2026-03', 'sum change': -9_000 },
        { month: '2026-01', 'sum change': 42_000 },
        { month: '2026-05', 'sum change': -21_000 },
        { month: '2026-02', 'sum change': 18_000 },
        { month: '2026-04', 'sum change': 35_000 },
        { month: '2026-06', 'sum change': 27_000 },
      ],
    },
    say: money,
    label: plain,
    wide: 560,
  },
  decorators: framed(560),
};

/* Past eight groups the tail is one "Others" tile. */
export const Treemap: StoryObj<typeof meta> = {
  args: {
    shape: 'treemap',
    answer: {
      columns: ['category', 'sum value'],
      rows: [
        ['Tires', 184_000],
        ['Brake pads', 126_500],
        ['Batteries', 118_200],
        ['Filters', 74_800],
        ['Wiper blades', 41_300],
        ['Spark plugs', 38_900],
        ['Floor mats', 29_400],
        ['Bulbs', 22_100],
        ['Fuses', 11_800],
        ['Hose clamps', 9_400],
        ['Washers', 6_200],
      ].map(([category, value]) => ({ category, 'sum value': value })),
    },
    say: money,
    label: plain,
    wide: 600,
  },
  decorators: framed(600),
};
