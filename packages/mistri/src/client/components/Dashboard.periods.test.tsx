/**
 * A dashboard section with windows of its own (`windows` on the section): it
 * asks for its own period, never the dashboard's, starts on its first phrase,
 * says the period in its heading, and the address carries it as
 * `period.<section>` beside the window and the picks.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { columnKind, labelColumn, primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const tables: Record<string, TableMeta> = {
  deal: {
    id: 'deal',
    name: 'deal',
    schema: '',
    isView: false,
    columns: [
      col('id', 'INTEGER', { primaryKey: true, nullable: false }),
      col('stage', 'TEXT'),
      col('closed_on', 'DATE'),
    ] as TableMeta['columns'],
  },
};

vi.mock('../../../../kit/src/client/core.js', () => ({
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === '/api/breakdowns')
      return { results: (body.items as unknown[]).map(() => ({ status: 200, body: { columns: ['stage', 'count'], rows: [] } })) };
    return { columns: ['stage', 'count'], rows: [] };
  },
  columnDisplay: () => null,
  columnKind,
  emptyWord: () => '—',
  findTable: (id: string) => tables[id],
  labelColumn,
  // Where a record's name lives; these sections' rows carry none beyond what they show.
  labelPath: () => undefined,
  primaryKey,
  go: () => {},
  tableView: (table: string, query: string) => ({ table, query }),
  openRecord: () => {},
  quote: (v: string) => (/^[\w.-]+$/.test(v) ? v : JSON.stringify(v)),
  refsFrom: () => [],
  viewportBox: () => ({ width: 600, height: 200, top: 0, left: 0, right: 600, bottom: 200 }),
  viewportSize: () => ({ width: 1000, height: 800 }),
  state: { activeConnection: 'crm' },
}));
vi.mock('../appState.js', () => ({ activeApp: () => ({ ui: {}, views: {}, nav: [], resources: {} }), inAppMode: () => true }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/insert.js', () => ({ canInsert: () => true }));
vi.mock('../../../../kit/src/client/components/TableRoom.js', () => ({ TableRoom: () => null }));

const { Dashboard } = await import('./Dashboard.js');
const { dashboardSelection, parseRootSlot, rootSlot } = await import('../../../../kit/src/client/components/dashboardModel.js');

const own = {
  id: 'own',
  label: 'Own',
  windows: ['last 30 days'],
  sections: [
    {
      kind: 'breakdown',
      table: 'deal',
      by: 'stage',
      title: 'Won by stage',
      query: 'stage = won and closed_on = last 7 days',
      windowBase: 'stage = won',
      over: 'closed_on',
      windows: ['last 7 days', 'last 90 days'],
      windowKey: 'won-by-stage',
    },
  ],
};
const asked = () =>
  calls.flatMap((call) =>
    call.path === '/api/breakdowns'
      ? (call.body.items as Array<{ text: string }>).map((item) => item.text)
      : call.path === '/api/breakdown'
        ? [String(call.body.text)]
        : [],
  );
const draw = (props = {}) =>
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      <Dashboard dashboard={own} {...props} />,
    ),
  );

beforeEach(() => {
  calls.length = 0;
});
afterEach(() => cleanup());

describe('a section with windows of its own', () => {
  test("it starts on its first window, passes the dashboard's over and says its period in its heading", async () => {
    draw({ window: 'last 30 days' });
    await waitFor(() => expect(asked().some((text) => text.includes('closed_on = last 7 days'))).toBe(true));
    expect(asked().some((text) => text.includes('last 30 days'))).toBe(false);
    expect(screen.getByRole('heading', { name: 'Won by stage' })).toBeTruthy();
    expect((await screen.findByLabelText('Period of Won by stage', undefined, { timeout: 5000 })).textContent).toContain('Last 7 days');
  });

  test('a period the link names is the one it asks for', async () => {
    draw({ periods: { 'won-by-stage': 'last 90 days' } });
    await waitFor(() => expect(asked().some((text) => text.includes('closed_on = last 90 days'))).toBe(true));
  });

  test("the slot carries each section's period beside the window and picks, and a stray one is dropped", () => {
    const slot = rootSlot('last 30 days', {}, { 'won-by-stage': 'last 90 days' });
    expect(slot).toBe('last-30-days;period.won-by-stage=last-90-days');
    expect(parseRootSlot(slot)).toEqual({ window: 'last-30-days', picks: {}, periods: { 'won-by-stage': 'last-90-days' } });
    expect(dashboardSelection(own as never, slot)).toEqual({
      window: 'last 30 days',
      picks: {},
      periods: { 'won-by-stage': 'last 90 days' },
    });
    expect(dashboardSelection(own as never, 'period.won-by-stage=last-2-years;period.other=last-7-days').periods).toEqual({});
  });

  test('a dashboard that declares its window opens on it, the address still wins, and all time is said', () => {
    const review = { windows: ['last 7 days', 'last 30 days'], window: 'last 30 days', filters: [], sections: [] };
    expect(dashboardSelection(review as never, undefined).window).toBe('last 30 days');
    expect(dashboardSelection(review as never, 'last-7-days').window).toBe('last 7 days');
    expect(dashboardSelection(review as never, 'all-time').window).toBeNull();
    // A window it no longer offers lands where it opens.
    expect(dashboardSelection(review as never, 'last-2-years').window).toBe('last 30 days');
    // The window it opens on goes unsaid; all time is said, so a reload keeps it.
    expect(rootSlot('last 30 days', {}, {}, review.window)).toBe('');
    expect(rootSlot(null, {}, {}, review.window)).toBe('all-time');
    expect(rootSlot('last 7 days', {}, {}, review.window)).toBe('last-7-days');
    // Without a declared window, nothing changes: unpicked is all time, unsaid.
    expect(rootSlot(null, {})).toBe('');
    expect(dashboardSelection({ ...review, window: undefined } as never, 'all-time').window).toBeNull();
  });
});
