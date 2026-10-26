/**
 * The gantt list: records as spans across a ruler, a row per group, said in
 * words, stepped through with the arrows and opened with a press.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppGanttList } from '../../../../engine/src/shared/listPresentations.js';
const mocks = vi.hoisted(() => ({ api: vi.fn(), open: vi.fn(), state: { activeConnection: 'crm' } }));
const table: TableMeta = {
  id: 'campaign',
  name: 'campaign',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'kind', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'starts_on', type: 'DATE', nullable: false, primaryKey: false },
    { name: 'ends_on', type: 'DATE', nullable: true, primaryKey: false },
    { name: 'done', type: 'INTEGER', nullable: true, primaryKey: false },
  ],
};
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: mocks.open,
  state: mocks.state,
  primaryKey,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../../../../kit/src/client/requestIdentity.js', () => ({ ownedBy: () => ({}) }));
vi.mock('../../../../kit/src/client/clauses.js', () => ({
  splitQuery: (text: string) => ({ filter: text.replace(/^\S+\s*/, '').replace(/\s*sort .*$/, '') }),
}));
vi.mock('../../../../kit/src/client/locale.js', () => ({ formatLocale: () => 'en-US', formatNumber: (n: number) => String(n) }));
const { GanttList, dayOf, rowsOf } = await import('./GanttList.js');
const { canShowGantt } = await import('../../../../kit/src/client/components/presentationFit.js');
const spec: AppGanttList = { kind: 'gantt', start: 'starts_on', end: 'ends_on', primary: 'name', by: 'kind', progress: 'done' };
const rows = [
  { id: 1, name: 'Spring webinar', kind: 'webinar', starts_on: '2026-03-02', ends_on: '2026-03-31', done: 100 },
  { id: 2, name: 'Trade show', kind: 'event', starts_on: '2026-04-14', ends_on: null, done: null },
  { id: 3, name: 'Summer webinar', kind: 'webinar', starts_on: '2026-06-01', ends_on: '2026-06-30', done: 40 },
];
const draw = (props: Partial<AppGanttList> = {}) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <GanttList
        table={table}
        spec={{ ...spec, ...props }}
        entry={{ kind: 'table', table: 'campaign', query: 'campaign' } as never}
        today={dayOf('2026-04-01')!}
      />
    </QueryClientProvider>,
  );

beforeEach(() => {
  mocks.api.mockReset().mockResolvedValue({ rows, more: false });
  mocks.open.mockReset();
});
afterEach(cleanup);

test('asked whole, sorted by start; a band per group in the order each first starts, a row per name under it', async () => {
  const { container } = draw();
  await screen.findByRole('list');
  expect(mocks.api).toHaveBeenCalledWith(
    '/api/run',
    expect.objectContaining({ q: 'campaign sort starts_on show id, starts_on, ends_on, name, kind, done', limit: 500 }),
  );
  expect([...container.querySelectorAll('.gantt-band')].map((band) => band.textContent)).toEqual(['webinar', 'event']);
  expect([...container.querySelectorAll('.gantt-row .gantt-name')].map((name) => name.textContent)).toEqual([
    'Spring webinar',
    'Summer webinar',
    'Trade show',
  ]);
  // A bar carries no name: its row's label says it.
  expect(container.querySelector('.gantt-bar-title')).toBeNull();
  expect([...container.querySelectorAll('.gantt-year')].map((year) => year.textContent)).toEqual(['2026']);
  expect(container.querySelector('.gantt-today')).not.toBeNull();
  expect([...container.querySelectorAll('.gantt-tick')].map((tick) => tick.textContent)).toEqual(['Apr', 'May', 'Jun', 'Jul']);
});

test('each bar says its span, its share done, or its one day', async () => {
  draw();
  await screen.findByRole('list');
  expect(screen.getAllByRole('button').map((bar) => bar.getAttribute('aria-label'))).toEqual([
    'Spring webinar, Mar 2, 2026 to Mar 31, 2026, 100% done',
    'Summer webinar, Jun 1, 2026 to Jun 30, 2026, 40% done',
    'Trade show, on Apr 14, 2026',
  ]);
  const spring = screen.getAllByRole('button')[0];
  // Thirty days of a span of 1 March to 2 July, both days counted.
  expect(parseFloat(spring.style.width)).toBeCloseTo((30 / 123) * 100, 2);
  expect(spring.style.getPropertyValue('--done')).toBe('100%');
  expect(screen.getAllByRole('button')[2]).toHaveClass('is-mark');
});

test('one Tab stop, the arrows step through the bars, a press opens the record', async () => {
  draw({ by: undefined });
  await screen.findByRole('list');
  expect(screen.getAllByRole('button').filter((bar) => bar.tabIndex === 0)).toHaveLength(1);
  await userEvent.tab();
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement).toHaveAttribute('aria-label', 'Trade show, on Apr 14, 2026');
  await userEvent.keyboard('{End}{Enter}');
  expect(mocks.open).toHaveBeenCalledWith('campaign', { id: 3 }, 'Summer webinar', 'push', expect.anything());
});

test('days read off dates and timestamps alike; ungrouped rows are one per bar', () => {
  expect(dayOf('2026-01-02T23:59:00Z')! - dayOf('2026-01-01')!).toBe(1);
  expect(dayOf('soon')).toBeNull();
  const bars = [
    { id: 'b', key: {}, title: 'B', first: 5, last: 9, mark: false },
    { id: 'a', key: {}, title: 'A', first: 2, last: 2, mark: true },
  ];
  expect(rowsOf(bars, false).map((row) => row.name)).toEqual(['A', 'B']);
  expect(canShowGantt(table, spec)).toBe(true);
  expect(canShowGantt(table, { ...spec, end: 'nope' })).toBe(false);
});
