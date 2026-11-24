/* A look reaches an on-demand part by the classes that part renders: the recipe rules in surfaces-*.css name them
   (`.nx-table-head`, `.nx-stat-value`, `.nx-kanban-lane-title`), and a part that stopped rendering one would go on
   drawing itself, in one fixed dress, in every look. Each twin of a kit part is drawn here and held to its hooks,
   and every `.nx-*` class the look rules name is held to being one a twin renders. */
import { readFileSync } from 'node:fs';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { AreaChart, LineChart } from '@mistriwork/ui/charts.js';
import { Badge, Card, StatCard, StatusDot, Tabs } from '@mistriwork/ui/primitives.js';
import { DataTable, KanbanBoard } from '@mistriwork/ui/views.js';

afterEach(cleanup);

const SDK = 'packages/mistri/src/client/components/sdk';
const lookRules = ['surfaces-base.css', 'surfaces-charts.css', 'surfaces-primitives.css', 'surfaces-views.css']
  .map((file) => readFileSync(`${SDK}/${file}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''))
  .flatMap((css) => [...css.matchAll(/@layer look \{([\s\S]*?)\n\}/g)].map((match) => match[1]!))
  .join('\n');

const rows = [
  { id: 'a', name: 'Larkspur Trust', guests: 301 },
  { id: 'b', name: 'Saltaire Ceramics', guests: 275 },
];
const series = [
  { day: 'Mon', value: 4 },
  { day: 'Tue', value: 9 },
  { day: 'Wed', value: 6 },
];

const draw = {
  table: () =>
    render(
      <DataTable
        ariaLabel="Events"
        data={rows}
        getRowId={(row) => row.id}
        columns={[
          { id: 'name', header: 'Name', accessor: 'name', sortable: true },
          { id: 'guests', header: 'Guests', accessor: 'guests', align: 'right' },
        ]}
      />,
    ),
  stat: () => render(<StatCard label="Events ahead" value={21} delta={{ value: '+3' }} icon={<i />} />),
  board: () =>
    render(
      <KanbanBoard
        ariaLabel="Tasks"
        columns={[
          { id: 'todo', title: 'To do' },
          { id: 'doing', title: 'Doing', tone: 'info' },
        ]}
        cards={[{ id: '1', title: 'Print the table plan' }]}
        defaultValue={{ todo: ['1'], doing: [] }}
      />,
    ),
  tabs: () =>
    render(
      <Tabs
        ariaLabel="Sections"
        tabs={[
          { value: 'floor', label: 'Floor', count: 8 },
          { value: 'crew', label: 'Crew' },
        ]}
      />,
    ),
  status: () =>
    render(
      <>
        <Badge tone="good">Paid</Badge>
        <StatusDot tone="good">Confirmed</StatusDot>
      </>,
    ),
  card: () => render(<Card title="Tonight">On the floor</Card>),
  chart: () =>
    render(
      <>
        <AreaChart ariaLabel="Area" data={series} xKey="day" series={[{ key: 'value', label: 'Events' }]} />
        <LineChart ariaLabel="Line" data={series} xKey="day" series={[{ key: 'value', label: 'Events' }]} showDots />
      </>,
    ),
};

/** The hooks each twin's recipe rules stand on, as selectors the drawn part must match. */
const HOOKS: Record<keyof typeof draw, string[]> = {
  table: [
    '.nx-data-table-surface',
    '.nx-data-table-surface .nx-table-head',
    '.nx-table-head .nx-table-th',
    '.nx-table-th .nx-table-sort-btn',
    'tbody .nx-table-row',
  ],
  stat: [
    '.nx-stat-card.nx-card',
    '.nx-stat-card .nx-stat-label',
    '.nx-stat-card .nx-stat-value',
    '.nx-stat-card .nx-stat-icon',
    '.nx-badge.nx-stat-delta[data-tone]',
  ],
  board: [
    '.nx-kanban-lane',
    '.nx-kanban-lane .nx-kanban-lane-header',
    '.nx-kanban-lane-header .nx-kanban-lane-title-group > .nx-status-dot[data-tone="info"]',
    '.nx-kanban-lane-title-group > .nx-kanban-lane-title',
    '.nx-kanban-lane .nx-kanban-cards',
    '.nx-kanban-card',
  ],
  tabs: ['.nx-tabs-list:not([data-variant]) > .nx-tabs-tab[data-selected]', '.nx-tabs-list > .nx-tabs-indicator'],
  status: ['.nx-badge[data-tone="good"]', '.nx-status-dot.tone.tone-good[data-tone="good"]'],
  card: ['.nx-card'],
  chart: ['.nx-chart-gridline', 'path.nx-chart-stroke', 'path.nx-chart-area', 'circle.nx-chart-dot'],
};

describe('the look reaches the on-demand parts', () => {
  for (const part of Object.keys(draw) as (keyof typeof draw)[]) {
    test(`${part}: the part renders the hooks its recipe rules name`, () => {
      const { container } = draw[part]();
      for (const hook of HOOKS[part]) expect(container.querySelector(hook), hook).not.toBeNull();
    });
  }

  test('every class the look rules name is one a twin renders', () => {
    const rendered = new Set<string>();
    for (const part of Object.keys(draw) as (keyof typeof draw)[]) {
      const { container } = draw[part]();
      for (const node of container.querySelectorAll('[class]'))
        for (const name of node.getAttribute('class')!.split(/\s+/)) rendered.add(name);
      cleanup();
    }
    const named = new Set([...lookRules.matchAll(/\.(nx-[a-z-]+[a-z])/g)].map((match) => match[1]!));
    expect(named.size).toBeGreaterThan(20);
    /* Drawn only by a part these cases do not draw: the composite field boxes of the primitives' own, older look rules. */
    const elsewhere = new Set(['nx-token-input-box', 'nx-datetime-picker-box', 'nx-textarea-frame']);
    expect([...named].filter((name) => !rendered.has(name) && !elsewhere.has(name))).toEqual([]);
  });
});
