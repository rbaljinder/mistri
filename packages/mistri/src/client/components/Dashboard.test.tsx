/**
 * A dashboard, drawn and driven.
 *
 * Against an API that answers breakdowns and rows like the server would.
 * What is tested is the composition: which text each section asks for
 * once the reader's window and picks are folded in, what a metric says,
 * where a bar goes when clicked. The charts, the grid and the dressed
 * values are the vanilla client's and are stood in for.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { columnKind, labelColumn, primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';
import { parseAppConfig, resolveViews, type AppDashboardView } from '../../shared/app.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
/** Every list page asked, alone or in a batch with the breakdowns. */
const runs = () =>
  calls.flatMap((call) =>
    call.path === '/api/run'
      ? [call.body]
      : call.path === '/api/breakdowns'
        ? (call.body.items as Array<Record<string, unknown>>).flatMap((item) => (item.run ? [item.run as Record<string, unknown>] : []))
        : [],
  );
const gone: unknown[] = [];
const opened = vi.fn();
const rowResults: Record<string, Array<Record<string, unknown>>> = {};
const rooms: Array<Record<string, unknown>> = [];
/** A column's display rule by `table.column`, for the sections that read one (a toned breakdown). */
const displays: Record<string, unknown> = {};
let app: Record<string, unknown> = { ui: {}, views: {}, nav: [], resources: {} };

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const tables: Record<string, TableMeta> = {
  deal: {
    id: 'deal',
    name: 'deal',
    schema: '',
    isView: false,
    indexed: ['id'],
    columns: [
      col('id', 'INTEGER', { primaryKey: true, nullable: false }),
      col('name', 'TEXT'),
      col('stage', 'TEXT', { allowed: ['lead', 'won', 'lost'] }),
      col('amount', 'NUMERIC'),
      col('closed_on', 'DATE'),
    ] as TableMeta['columns'],
  },
};

/** What the fake server says to each breakdown text. */
const breakdowns: Record<string, { columns: string[]; rows: Array<Record<string, unknown>> }> = {};

import { quoteValue } from '../../../../engine/src/shared/query.js';
vi.mock('../../../../kit/src/client/core.js', () => ({
  writeAllowed: () => true,
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    const breakdown = (ask: Record<string, unknown>) => {
      const answer = breakdowns[String(ask.text)];
      if (!answer) return { columns: ['n'], rows: [{ n: 0 }] };
      return ask.limit === 1 ? { columns: answer.columns, rows: answer.rows.slice(0, 1) } : answer;
    };
    if (path === '/api/breakdown') return breakdown(body);
    // The sections of one paint arrive together (breakdownBatch.ts).
    // A section's list rides in the same batch as `run` (breakdownBatch.ts).
    if (path === '/api/breakdowns') {
      return {
        results: (body.items as Array<Record<string, unknown>>).map((item) => ({
          status: 200,
          body: item.run ? { rows: rowResults[String((item.run as Record<string, unknown>).q)] ?? [] } : breakdown(item),
        })),
      };
    }
    return { rows: rowResults[String(body.q)] ?? [] };
  },
  columnDisplay: (table: string, column: string) => displays[`${table}.${column}`] ?? null,
  columnKind,
  emptyWord: () => '—',
  findTable: (id: string) => tables[id],
  labelColumn,
  // Where a record's name lives; these sections' rows carry none beyond what they show.
  labelPath: () => undefined,
  primaryKey,
  go: (entry: unknown) => gone.push(entry),
  tableView: (table: string, query: string) => ({ table, query }),
  openRecord: opened,
  quote: quoteValue,
  refsFrom: () => [],
  viewportBox: () => ({ width: 600, height: 200, top: 0, left: 0, right: 600, bottom: 200 }),
  viewportSize: () => ({ width: 1000, height: 800 }),
  state: { activeConnection: 'crm' },
}));
vi.mock('../appState.js', () => ({ activeApp: () => app, inAppMode: () => true }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
// An address is the server's book and the walk's to write; here a list's link says its view and its question.
vi.mock('../../../../kit/src/client/components/viewLink.js', () => ({
  viewLink: () => undefined,
  formLink: () => ({ href: '/crm/form' }),
  listEntry: (view: string, query: string) => ({ table: 'deal', query, view }),
  listLink: (view: string, query: string) => ({
    href: `/crm/${view}?q=${encodeURIComponent(query)}`,
    onClick: (event: { preventDefault: () => void }) => {
      event.preventDefault();
      gone.push({ table: 'deal', query, view });
    },
  }),
}));
vi.mock('../../../../kit/src/client/components/TableRoom.js', async () => {
  const { useEffect } = await import('react');
  return {
    TableRoom: (props: Record<string, unknown>) => {
      const onResult = props.onResult as ((d: unknown) => void) | undefined;
      rooms.push(props);
      useEffect(() => {
        onResult?.({ columns: [], total: 12, exactTotal: true });
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return null;
    },
  };
});
// A first run asks whether a step's table takes a New record; the form's own module is not the dashboard's.
vi.mock('../../../../kit/src/client/insert.js', () => ({ canInsert: () => true }));
vi.mock('./BrandingForm.js', () => ({ BrandingForm: () => <div data-stub="branding-form" /> }));

const { Dashboard } = await import('./Dashboard.js');
const { boardSection, windowed, windowTitle, metricWindow, picked, rootSlot, parseRootSlot, orderGroups, barShare } =
  await import('../../../../kit/src/client/components/dashboardModel.js');
const { comparedWith, changeTone } = await import('./Dashboard.js');
const { andQuery } = await import('../../../../engine/src/shared/query.js');

const dashboard = {
  id: 'sales',
  label: 'Sales',
  windows: ['last 30 days', 'last 90 days'],
  filters: ['stage'],
  sections: [
    {
      kind: 'metric',
      table: 'deal',
      query: 'stage = won',
      measure: 'sum amount',
      title: 'Won',
      over: 'closed_on',
      compare: 'stage = won and closed_on = previous 30 days',
      comparePeriod: true,
      better: 'up' as const,
    },
    { kind: 'metric', table: 'deal', title: 'Deals' },
    { kind: 'breakdown', table: 'deal', by: 'stage', title: 'By stage' },
    { kind: 'note', title: 'Read me', text: 'First paragraph.\n\nSecond paragraph.' },
    { kind: 'rows', table: 'deal', title: 'Recent', limit: 3 },
  ],
};

function draw(props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, <Dashboard dashboard={dashboard} {...props} />));
}

beforeEach(() => {
  calls.length = 0;
  gone.length = 0;
  opened.mockReset();
  rooms.length = 0;
  app = { ui: {}, views: {}, nav: [], resources: {} };
  for (const k of Object.keys(rowResults)) delete rowResults[k];
  for (const k of Object.keys(breakdowns)) delete breakdowns[k];
  breakdowns['deal stage = won sum amount'] = { columns: ['sum'], rows: [{ sum: 250000 }] };
  breakdowns['deal stage = won and closed_on = previous 30 days sum amount'] = { columns: ['sum'], rows: [{ sum: 200000 }] };
  breakdowns['deal count'] = { columns: ['count'], rows: [{ count: 42 }] };
  breakdowns['deal count by stage'] = {
    columns: ['stage', 'count'],
    rows: [
      { stage: 'lead', count: 30 },
      { stage: 'won', count: 10 },
      { stage: null, count: 2 },
    ],
  };
  // A breakdown asks for its groups and orders them itself (orderGroups): the server's order is the engine's.
  breakdowns['deal count by stage limit 200'] = {
    columns: ['stage', 'count'],
    rows: [
      { stage: null, count: 2 },
      { stage: 'won', count: 10 },
      { stage: 'lead', count: 30 },
    ],
  };
});
afterEach(() => {
  cleanup();
  for (const key of Object.keys(displays)) delete displays[key];
});

describe('the model', () => {
  test("groups read in their vocabulary's order, else biggest first, and a bar is a share of the largest", () => {
    const rows = [
      { k: 'proposal', n: 5 },
      { k: 'negotiation', n: 9 },
      { k: null, n: 50 },
      { k: 'prospecting', n: 2 },
    ];
    expect(orderGroups(rows, 'k', 'n', ['prospecting', 'qualification', 'proposal', 'negotiation']).map((r) => r.k)).toEqual([
      'prospecting',
      'proposal',
      'negotiation',
      null,
    ]);
    expect(orderGroups(rows, 'k', 'n').map((r) => r.k)).toEqual([null, 'negotiation', 'proposal', 'prospecting']);
    expect([1, 1, 1].map((n) => barShare(n, 1))).toEqual([100, 100, 100]);
    expect(barShare(0, 40)).toBe(2);
    expect(barShare(10, 40)).toBe(25);
  });

  test('a change names the window it is measured against', () => {
    expect(comparedWith('stage = won and closed_on = previous 90 days')).toBe('vs prior 90 days');
    expect(comparedWith('created_on = previous 1 month')).toBe('vs prior month');
    expect(comparedWith('status = closed')).toBe('vs the compare window');
    expect(comparedWith(undefined)).toBeUndefined();
    // Unchanged is one phrase, not a figure with nothing to say.
    expect(comparedWith('closed_on = previous 30 days', true)).toBe('Same as prior 30 days');
    expect(comparedWith('status = closed', true)).toBe('Same as the compare window');
  });

  test("a pick narrows the trend's unwindowed query as well as the figure's", () => {
    const narrowed = picked(
      { kind: 'metric', table: 'deal', query: 'closed_on = last 90 days', windowBase: 'stage = won' },
      { stage: 'won' },
    );
    expect(narrowed.windowBase).toBe('stage = won and stage = won');
  });

  test('lane scope composes with OR filters, windows and picks without mutating authorship', () => {
    const source = {
      kind: 'board',
      table: 'deal',
      by: 'stage',
      query: 'amount > 20 or amount < 5',
      over: 'closed_on',
      lanes: ['won', 'lost'],
    };
    const scoped = boardSection(picked(windowed(source, 'last 30 days'), { stage: 'won' }));
    expect(scoped.query).toBe('(amount > 20 or amount < 5) and closed_on = last 30 days and stage = won and (stage = won or stage = lost)');
    expect(source.query).toBe('amount > 20 or amount < 5');
    expect(boardSection({ kind: 'board' })).toEqual({ kind: 'board' });
    const ordinary = { kind: 'board', query: 'stage = won' };
    expect(boardSection(ordinary)).toBe(ordinary);
  });

  test('lane literals containing commas, quotes and query words stay whole', () => {
    expect(boardSection({ kind: 'board', by: 'stage', lanes: ['review, legal', 'say "yes"', 'a or b'] }).query).toBe(
      '(stage = "review, legal" or stage = "say \\"yes\\"" or stage = "a or b")',
    );
  });
  test("the reader's window stands where the author's did, and re-derives the compare", () => {
    const w = windowed(dashboard.sections[0], 'last 90 days');
    expect(w.query).toBe('stage = won and closed_on = last 90 days');
    expect(w.compare).toBe('stage = won and closed_on = previous 90 days');
    // A section without a clock is passed over.
    expect(windowed(dashboard.sections[1], 'last 90 days')).toBe(dashboard.sections[1]);
  });

  test('a picked window replaces the window the title names, rather than following it', () => {
    const won = { query: 'stage = closed_won and close_date = last 90 days', over: 'close_date', windowBase: 'stage = closed_won' };
    expect(windowTitle('Won, last 90 days', won, null)).toBe('Won, last 90 days');
    expect(windowTitle('Won, last 90 days', won, 'last 30 days')).toBe('Won, last 30 days');
    expect(windowTitle('Last 90 days won', won, 'this year')).toBe('This year won');
    // A title that does not name its window says the pick after it.
    expect(windowTitle('Won', won, 'this year')).toBe('Won (this year)');
    // With nothing picked it says the author's window: under "All time" a bare "Won" hid its ninety days.
    expect(windowTitle('Won', won, null)).toBe('Won (last 90 days)');
    // An unwindowed section is over all time until a window is picked.
    const pipeline = { query: 'stage != closed_won', over: 'close_date' };
    expect(windowTitle('Pipeline', pipeline, null)).toBe('Pipeline (all time)');
    expect(windowTitle('Pipeline', pipeline, 'last 30 days')).toBe('Pipeline (last 30 days)');
    expect(windowTitle('Pipeline', { query: 'x' }, 'last 30 days')).toBe('Pipeline');
  });

  test('a stat card never has its window appended: it names a pick in place, or says the window under the figure', () => {
    const won = { query: 'stage = closed_won and close_date = last 90 days', over: 'close_date', windowBase: 'stage = closed_won' };
    expect(metricWindow('Won', won, null)).toEqual({ title: 'Won', note: 'Last 90 days' });
    expect(metricWindow('Won', won, 'this year')).toEqual({ title: 'Won' });
    expect(metricWindow('Won, last 90 days', won, null)).toEqual({ title: 'Won, last 90 days' });
    expect(metricWindow('Won, last 90 days', won, 'last 30 days')).toEqual({ title: 'Won, last 30 days' });
    // Under All time nothing is narrowed, so nothing is said.
    expect(metricWindow('Pipeline', { query: 'stage != closed_won', over: 'close_date' }, null)).toEqual({ title: 'Pipeline' });
    expect(metricWindow('Pipeline', { query: 'x' }, 'last 30 days')).toEqual({ title: 'Pipeline' });
  });

  test('a pick lands only on sections whose table has the column', () => {
    expect(picked({ kind: 'metric', table: 'deal', query: 'stage = won' }, { stage: 'lost', owner_id: '7' }).query).toBe(
      'stage = won and stage = lost',
    );
    expect(picked({ kind: 'note' }, { stage: 'lost' })).toEqual({ kind: 'note' });
  });

  test('the slot round-trips a window and picks', () => {
    const slot = rootSlot('last 30 days', { stage: 'won', owner_id: '7' });
    expect(slot).toBe('last-30-days;stage=won;owner_id=7');
    expect(parseRootSlot(slot)).toEqual({ window: 'last-30-days', picks: { stage: 'won', owner_id: '7' } });
    expect(rootSlot(null, {})).toBe('');
    expect(parseRootSlot(';stage=won')).toEqual({ window: '', picks: { stage: 'won' } });
  });
});

describe('the screen', () => {
  test('authored lanes retain exact order and empty states; all board links share their scope', async () => {
    const query = '(stage = lost or stage = lead)';
    breakdowns[`deal ${query} count by stage`] = {
      columns: ['stage', 'count'],
      rows: [
        { stage: 'lead', count: 3 },
        { stage: 'won', count: 7 },
      ],
    };
    rowResults[`deal ${query} and stage = lead show name, id`] = [{ id: 1, name: 'First deal' }];
    draw({
      dashboard: {
        id: 'queue',
        label: 'Queue',
        sections: [
          {
            kind: 'board',
            title: 'Selected lanes',
            table: 'deal',
            by: 'stage',
            lanes: ['lost', 'lead'],
            limit: 1,
          },
        ],
      },
    });
    const card = await screen.findByRole('button', { name: 'First deal' });
    expect([...document.querySelectorAll('.board-lane-name')].map((n) => n.textContent)).toEqual(['lost', 'lead']);
    expect([...document.querySelectorAll('.board-lane-count')].map((n) => n.textContent)).toEqual(['0', '3']);
    await userEvent.setup().click(card);
    expect(opened).toHaveBeenCalledWith('deal', { id: 1 }, 'First deal', 'push');
    await userEvent.setup().click(screen.getByRole('button', { name: /^View all/ }));
    expect(gone.at(-1)).toEqual({ table: 'deal', query: `deal ${query}` });
    await userEvent.setup().click(screen.getByRole('button', { name: '+ 2 more' }));
    expect(gone.at(-1)).toEqual({ table: 'deal', query: `deal ${query} and stage = lead` });
    expect(runs().map((run) => run.q)).toEqual([`deal ${query} and stage = lead show name, id`]);
    expect(calls.every((c) => ['/api/run', '/api/breakdown', '/api/breakdowns'].includes(c.path))).toBe(true);
  });

  test("an embed's open → goes to its view's own room; any other section's, to the list its table and query suggest", async () => {
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        sections: [
          { kind: 'rows', table: 'deal', title: 'Pipeline', query: 'stage = lead', view: 'pipeline' },
          { kind: 'rows', table: 'deal', title: 'Recent' },
        ],
      },
    });
    const [embed, plain] = screen.getAllByRole('button', { name: /^View all/ });
    await userEvent.setup().click(embed);
    expect(gone.at(-1)).toEqual({ table: 'deal', query: 'deal stage = lead', view: 'pipeline' });
    await userEvent.setup().click(plain);
    expect(gone.at(-1)).toEqual({ table: 'deal', query: 'deal' });
  });

  test('embeds inherit empty copy only for the source question', async () => {
    const empty = { title: 'All reviewed', description: 'No pending deals.' };
    app = { ui: {}, nav: [], resources: {}, views: { pipeline: { table: 'deal', label: 'Pipeline', query: 'stage = lead', empty } } };
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        sections: [
          { kind: 'rows', table: 'deal', title: 'Pending', view: 'pipeline', query: 'stage = lead' },
          { kind: 'rows', table: 'deal', title: 'Large pending', view: 'pipeline', query: 'stage = lead and amount > 1000' },
        ],
      },
    });
    await screen.findAllByText('12 in all');
    const inherited = rooms.find((room) => Boolean(room.empty));
    expect(inherited).toBeDefined();
    expect((inherited!.empty as { props: { spec: unknown } }).props.spec).toEqual(empty);
    expect(
      rooms
        .filter((room) => String((room.entry as { query: string }).query).includes('amount > 1000'))
        .every((room) => room.empty === undefined),
    ).toBe(true);
  });

  test('a rows section that asks for row actions hands its table the resource’s verbs; one that does not, none', async () => {
    const verbs = [{ id: 'win', label: 'Mark won', set: { stage: 'won' } }];
    app = { ui: {}, nav: [], resources: { deal: { actions: verbs } }, views: {} };
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        sections: [
          { kind: 'rows', table: 'deal', title: 'With verbs', rowActions: true },
          { kind: 'rows', table: 'deal', title: 'Without' },
        ],
      },
    });
    await screen.findAllByText('12 in all');
    const offered = rooms.filter((room) => room.rowActions === true);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered.every((room) => room.actions === verbs)).toBe(true);
    expect(rooms.filter((room) => room.rowActions === undefined).every((room) => room.actions === undefined)).toBe(true);
    expect(rooms.some((room) => room.rowActions === undefined)).toBe(true);
  });

  test('an explicit view embed borrows its served cards and their projection, while retaining the dashboard question', async () => {
    const cards = { kind: 'cards' as const, primary: 'name', value: 'amount', badge: 'stage', facts: ['closed_on'] };
    app = { ui: {}, nav: [], resources: {}, views: { pipeline: { table: 'deal', label: 'Pipeline', presentation: cards } } };
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        sections: [
          {
            kind: 'rows',
            table: 'deal',
            title: 'Closing soon',
            view: 'pipeline',
            query: 'stage = won',
            sort: 'amount desc',
            show: ['name'],
            limit: 2,
          },
        ],
      },
    });
    await screen.findByText('12 in all');
    const room = rooms.at(-1)!;
    expect(room.presentation).toEqual(cards);
    expect(room.listLabel).toBe('Pipeline');
    expect(room.interactive).toBe(false);
    expect(room.chrome).toBe(false);
    expect(room.actions).toBeUndefined();
    expect(room.recordNavigation).toBe(true);
    expect(room.entry).toEqual({
      kind: 'table',
      table: 'deal',
      query: 'deal stage = won sort amount desc show name, amount, stage, closed_on, id limit 2',
    });
  });

  test('an explicit view embed keeps record navigation for a read-only queue', async () => {
    const queue = { kind: 'queue' as const, primary: 'name', lines: ['stage'] };
    app = { ui: {}, nav: [], resources: {}, views: { pipeline: { table: 'deal', label: 'Pipeline', presentation: queue } } };
    draw({ dashboard: { id: 'desk', label: 'Desk', sections: [{ kind: 'rows', table: 'deal', view: 'pipeline', show: ['name'] }] } });
    await screen.findByText('12 in all');
    const room = rooms.at(-1)!;
    expect(room.interactive).toBe(false);
    expect(room.recordNavigation).toBe(true);
    expect(room.presentation).toEqual(queue);
  });

  test('a raw dashboard list does not borrow a matching view presentation', async () => {
    app = {
      ui: {},
      nav: [],
      resources: {},
      views: { pipeline: { table: 'deal', label: 'Pipeline', presentation: { kind: 'cards', primary: 'name' } } },
    };
    draw({ dashboard: { id: 'desk', label: 'Desk', sections: [{ kind: 'rows', table: 'deal', show: ['name'] }] } });
    await screen.findByText('12 in all');
    expect(rooms.at(-1)!.presentation).toBeUndefined();
  });

  test('omitted lanes preserve schema vocabulary including empty lanes', async () => {
    draw({ dashboard: { id: 'queue', label: 'Queue', sections: [{ kind: 'board', table: 'deal', by: 'stage' }] } });
    await screen.findByText('lost');
    expect([...document.querySelectorAll('.board-lane-name')].map((n) => n.textContent)).toEqual(['lead', 'won', 'lost']);
    expect(calls.some((c) => c.body.text === 'deal count by stage')).toBe(true);
  });

  test('metrics say their figure and their delta, coloured the way the author said', async () => {
    draw();
    const won = await screen.findByRole('button', { name: 'Won: 250,000' });
    expect(within(won).getByText('↑ 50,000').closest('.dash-delta')).toHaveClass('good');
    // The change says what it is a change from.
    expect(within(won).getByText('vs prior 30 days', { exact: false })).toHaveClass('dash-delta-period');
    const deals = await screen.findByRole('button', { name: 'Deals: 42' });
    // Under All time the window narrows nothing, so no card has anything to say about it.
    expect(within(deals).queryByText('Right now')).toBeNull();
  });

  test('a goal read from data is a second measure, and a ratio wears no money dress', async () => {
    breakdowns['quota sum amount'] = { columns: ['sum'], rows: [{ sum: 500000 }] };
    breakdowns['deal sum amount / count as average'] = { columns: ['average'], rows: [{ average: 0.5 }] };
    draw({
      dashboard: {
        ...dashboard,
        windows: [],
        filters: [],
        sections: [
          {
            kind: 'metric',
            table: 'deal',
            query: 'stage = won',
            measure: 'sum amount',
            title: 'Won',
            target: { table: 'quota', measure: 'sum amount' },
          },
          { kind: 'metric', table: 'deal', measure: 'sum amount / count as average', title: 'Average' },
        ],
      },
    });
    const won = await screen.findByRole('button', { name: 'Won: 250,000, 50% of 500,000 target' });
    expect(within(won).getByText('50% of 500,000 target')).toHaveClass('dash-target-text');
    expect(await screen.findByRole('button', { name: 'Average: 0.5' })).toBeInTheDocument();
  });

  test('a target that is the figure\'s own whole is said as a share of it, "118 of 159 (74%)", not as a goal', async () => {
    breakdowns['deal stage = won count'] = { columns: ['count'], rows: [{ count: 118 }] };
    breakdowns['deal count'] = { columns: ['count'], rows: [{ count: 159 }] };
    draw({
      dashboard: {
        ...dashboard,
        windows: [],
        filters: [],
        sections: [
          {
            kind: 'metric',
            table: 'deal',
            query: 'stage = won',
            title: 'Approved',
            target: { table: 'deal', measure: 'count' },
            targetWhole: true,
          },
        ],
      },
    });
    const card = await screen.findByRole('button', { name: 'Approved: 118 of 159, 74 percent' });
    expect(within(card).getByText('118 of 159 (74%)')).toHaveClass('dash-target-text');
    expect(within(card).queryByText(/target/)).toBeNull();
  });

  test('a strip of money cards says its figures one way, each whole in its title and to a screen reader', async () => {
    breakdowns['deal sum fee'] = { columns: ['sum'], rows: [{ sum: 414100 }] };
    breakdowns['deal sum deposit'] = { columns: ['sum'], rows: [{ sum: 27300 }] };
    draw({
      dashboard: {
        ...dashboard,
        windows: [],
        filters: [],
        sections: [
          { kind: 'metric', table: 'deal', measure: 'sum fee', format: 'money', title: 'Fees' },
          { kind: 'metric', table: 'deal', measure: 'sum deposit', format: 'money', title: 'Deposits' },
        ],
      },
    });
    const fees = await screen.findByRole('button', { name: /^Fees: \$414,100/ });
    const deposits = await screen.findByRole('button', { name: /^Deposits: \$27,300/ });
    expect(within(fees).getByText('$414.1K')).toHaveAttribute('title', expect.stringMatching(/^\$414,100/));
    expect(within(deposits).getByText('$27.3K')).toHaveAttribute('title', expect.stringMatching(/^\$27,300/));
  });

  test('once the reader picks a window, a card it does not move says so', async () => {
    const user = userEvent.setup();
    draw();
    await screen.findByRole('button', { name: 'Deals: 42' });
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    const deals = screen.getByRole('button', { name: 'Deals: 42' });
    const won = await screen.findByRole('button', { name: /^Won: / });
    expect(within(deals).getByText('Right now')).toBeInTheDocument();
    expect(within(won).queryByText('Right now')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All time' }));
    expect(within(screen.getByRole('button', { name: 'Deals: 42' })).queryByText('Right now')).toBeNull();
  });

  test('a windowed metric holds its change and its trend from the first paint, and draws the window a day at a time', async () => {
    const query = 'stage = won and closed_on = last 30 days';
    const day = (back: number) => {
      const d = new Date();
      d.setDate(d.getDate() - back);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    breakdowns[`deal ${query} sum amount`] = { columns: ['sum'], rows: [{ sum: 90 }] };
    breakdowns['deal stage = won and closed_on = previous 30 days sum amount'] = { columns: ['sum'], rows: [{ sum: 60 }] };
    // Two days of rows over thirty: the rest are put back as zero, so the line is the window's.
    breakdowns[`deal ${query} sum amount by day closed_on limit 400`] = {
      columns: ['closed_on', 'sum'],
      rows: [
        { closed_on: day(3), sum: 50 },
        { closed_on: day(10), sum: 40 },
      ],
    };
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        sections: [
          {
            kind: 'metric',
            table: 'deal',
            query,
            measure: 'sum amount',
            title: 'Won',
            over: 'closed_on',
            compare: 'stage = won and closed_on = previous 30 days',
            better: 'up',
          },
        ],
      },
    });
    // Before any read has landed, the change's line and the trend's height already stand.
    const card = screen.getByRole('button', { name: /^Won:/ });
    expect(card.querySelector('.dash-delta')!.textContent).toBe('\u00a0');
    expect(card.querySelector('.spark-host.is-reserved')).not.toBeNull();
    await waitFor(() => expect(within(card).getByText('↑ 30')).toBeInTheDocument());
    await waitFor(() => expect(card.querySelector('.spark-host svg.spark')).not.toBeNull());
    expect(card.querySelector('.spark-host')).toHaveClass('good');
    const said = card.querySelector('svg.spark')!.getAttribute('aria-label')!;
    expect(said.split(', ').length).toBeGreaterThanOrEqual(30);
  });

  test('a trend is drawn in its change’s news, and a section carries its mark in its heading row', async () => {
    const trend = (query: string) => `deal ${andQuery(query, 'closed_on = last 12 months')} sum amount by month closed_on`;
    const months = {
      columns: ['month', 'sum'],
      rows: ['2026-01', '2026-02', '2026-03', '2026-04'].map((month, i) => ({ month, sum: 10 + i })),
    };
    breakdowns[trend('stage = won')] = months;
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        sections: [
          {
            kind: 'metric',
            table: 'deal',
            query: 'stage = won',
            measure: 'sum amount',
            title: 'Won',
            icon: 'currency-dollar',
            over: 'closed_on',
            spark: true,
            compare: 'stage = won and closed_on = previous 30 days',
            better: 'up',
          },
          {
            kind: 'metric',
            table: 'deal',
            query: 'stage = won',
            measure: 'sum amount',
            title: 'Won, fewer is better',
            over: 'closed_on',
            spark: true,
            compare: 'stage = won and closed_on = previous 30 days',
            better: 'down',
          },
          {
            kind: 'metric',
            table: 'deal',
            query: 'stage = won',
            measure: 'sum amount',
            title: 'Won, unjudged',
            over: 'closed_on',
            spark: true,
            compare: 'stage = won and closed_on = previous 30 days',
          },
          { kind: 'chart', table: 'deal', by: 'stage', shape: 'bar', title: 'By stage', icon: 'chart-bar' },
        ],
      },
    });
    const good = await screen.findByRole('button', { name: 'Won: 250,000' });
    await waitFor(() => expect(good.querySelector('.spark-host')).toHaveClass('good'));
    expect(good.querySelector('.home-card-label svg.dash-section-icon')).not.toBeNull();
    const bad = screen.getByRole('button', { name: 'Won, fewer is better: 250,000' });
    await waitFor(() => expect(bad.querySelector('.spark-host')).toHaveClass('bad'));
    expect(within(bad).getByText('↑ 50,000').closest('.dash-delta')).toHaveClass('bad');
    const plain = screen.getByRole('button', { name: 'Won, unjudged: 250,000' });
    await waitFor(() => expect(plain.querySelector('.spark-host svg.spark')).not.toBeNull());
    expect(plain.querySelector('.spark-host')!.className).toBe('spark-host is-reserved');
    const chart = screen.getByRole('heading', { name: 'By stage' });
    expect(chart.querySelector('svg.dash-section-icon')).not.toBeNull();
    await waitFor(() => expect(document.querySelector('.chart-bars')).not.toBeNull());
    expect(document.querySelectorAll('.chart-bar')).toHaveLength(3);
  });

  test('an `auto` chart says the unit it chose, and draws the sparse answer in it', async () => {
    // Three days over thirty-four are asked a day at a time, and summed into the weeks they fall in.
    breakdowns['deal closed_on = last 34 days count by day closed_on'] = {
      columns: ['closed_on', 'count'],
      rows: [
        { closed_on: '2026-09-14', count: 2 },
        { closed_on: '2026-09-22', count: 3 },
        { closed_on: '2026-10-12', count: 4 },
      ],
    };
    draw({
      dashboard: {
        id: 'sales',
        label: 'Sales',
        sections: [
          { kind: 'chart', table: 'deal', by: 'auto closed_on', over: 'closed_on', query: 'closed_on = last 34 days', title: 'Won' },
        ],
      },
    });
    expect(await screen.findByText('by week')).toHaveClass('chart-unit');
    await waitFor(() => expect(document.querySelectorAll('.chart-data tr')).toHaveLength(5));
    expect([...document.querySelectorAll('.chart-data td')].map((cell) => cell.textContent)).toEqual(['2', '3', '0', '0', '4']);
  });

  test('a change is good or bad news only where the author said which way is better', () => {
    expect([changeTone(5, 'up'), changeTone(-5, 'up'), changeTone(5, 'down'), changeTone(-5, 'down')]).toEqual([
      ' good',
      ' bad',
      ' bad',
      ' good',
    ]);
    expect([changeTone(5, undefined), changeTone(0, 'up'), changeTone(Number.NaN, 'up')]).toEqual(['', '', '']);
  });

  test('a breakdown draws a bar per group and a group is a doorway', async () => {
    const user = userEvent.setup();
    app = { ui: {}, nav: [], resources: {}, views: { deals: { table: 'deal', label: 'Deals', query: '' } } };
    draw();
    const lead = await screen.findByTitle('Open deal where stage = lead');
    expect(within(lead).getByText('30')).toBeInTheDocument();
    // The stage's vocabulary order, whatever order the groups were answered in; the null group last.
    expect([...document.querySelectorAll('.page-breakdown-rows .pbd-label')].map((n) => n.textContent)).toEqual(['lead', 'won', '—']);
    // The largest group fills its track.
    expect((lead.querySelector('.pbd-fill') as HTMLElement).style.width).toBe('100%');
    // A null group cannot be opened, so it is not a link.
    expect(screen.getByText('—').closest('a, button')).toBeNull();
    // The group is a real link to the App's one list over the table, so it opens in a new tab as well as in place.
    expect(lead.tagName).toBe('A');
    expect(lead).toHaveAttribute('href', `/crm/deals?q=${encodeURIComponent('deal stage = lead')}`);
    await user.click(lead);
    expect(gone).toEqual([{ table: 'deal', query: 'deal stage = lead', view: 'deals' }]);
  });

  test("a group of a column that colors its values wears the color: its bar is the chip's ink (G209)", async () => {
    app = { ui: {}, nav: [], resources: {}, views: {} };
    displays['deal.stage'] = { tone: { lead: 'bad', won: 'good' } };
    draw({ dashboard: { id: 'd', label: 'D', sections: [{ kind: 'breakdown', table: 'deal', by: 'stage', title: 'By stage' }] } });
    await screen.findByText('30');
    const fills = [...document.querySelectorAll<HTMLElement>('.pbd-fill')];
    expect(fills.map((fill) => fill.style.getPropertyValue('--bar-ink'))).toEqual(['var(--status-critical)', 'var(--status-good)', '']);
    // The group with no value says nothing, so it keeps the accent.
    expect(fills.map((fill) => fill.classList.contains('is-toned'))).toEqual([true, true, false]);
  });

  test('a breakdown over a column with no colors keeps the accent bar', async () => {
    app = { ui: {}, nav: [], resources: {}, views: {} };
    draw({ dashboard: { id: 'd', label: 'D', sections: [{ kind: 'breakdown', table: 'deal', by: 'stage', title: 'By stage' }] } });
    await screen.findByText('30');
    expect(document.querySelector('.pbd-fill.is-toned')).toBeNull();
  });

  describe('where a group goes in an App', () => {
    const list = (extra: object = {}) => ({ table: 'deal', label: 'List', query: '', ...extra });
    const one = (section: object) => ({
      id: 'd',
      label: 'D',
      sections: [{ kind: 'breakdown', table: 'deal', by: 'stage', title: 'By stage', ...section }],
    });
    const groups = async (dash: object) => {
      draw({ dashboard: dash });
      await screen.findByText('30');
      return [...document.querySelectorAll('.page-breakdown-rows .pbd-row')];
    };

    test('with no list over its table the groups are text: an App never opens the database browser', async () => {
      app = { ui: {}, nav: [], resources: {}, views: {} };
      const rows = await groups(one({}));
      expect(rows.length).toBe(3);
      expect(rows.every((row) => row.tagName === 'DIV')).toBe(true);
      expect(gone).toEqual([]);
    });

    test('with several lists and no `to` the groups are text, and `to` (view) chooses one', async () => {
      app = { ui: {}, nav: [], resources: {}, views: { all: list(), won: list({ query: 'stage = won' }) } };
      expect((await groups(one({}))).every((row) => row.tagName === 'DIV')).toBe(true);
      cleanup();
      const chosen = await groups(one({ view: 'won' }));
      expect(chosen[0].getAttribute('href')).toBe(`/crm/won?q=${encodeURIComponent('deal stage = lead')}`);
    });

    test('`to: false` keeps the groups text even where one list would take them', async () => {
      app = { ui: {}, nav: [], resources: {}, views: { all: list() } };
      expect((await groups(one({ noDrill: true }))).every((row) => row.tagName === 'DIV')).toBe(true);
    });

    test('a `to` this reader is not served keeps the groups text rather than falling back to the table', async () => {
      app = { ui: {}, nav: [], resources: {}, views: { all: list() } };
      expect((await groups(one({ view: 'gone' }))).every((row) => row.tagName === 'DIV')).toBe(true);
    });
  });

  describe('empty: hide', () => {
    const nothing = { columns: ['stage', 'count'], rows: [] };
    const sectionOf = (emptyMode?: 'hide') => ({
      id: 'd',
      label: 'D',
      sections: [{ kind: 'breakdown', table: 'deal', by: 'stage', title: 'By stage', ...(emptyMode ? { emptyMode } : {}) }],
    });

    test('a breakdown with nothing to count leaves its section out, and without it says so', async () => {
      breakdowns['deal count by stage'] = nothing;
      breakdowns['deal count by stage limit 200'] = nothing;
      draw({ dashboard: sectionOf('hide') });
      await waitFor(() => expect(document.querySelector('section[hidden]')).not.toBeNull());
      cleanup();
      draw({ dashboard: sectionOf() });
      await waitFor(() => expect(document.querySelector('.empty, [class*=empty]')).not.toBeNull());
      expect(document.querySelector('section[hidden]')).toBeNull();
    });
  });

  test('a breakdown says its bars as the author said its figure: a share with its percent sign', async () => {
    breakdowns['deal avg won * 100 by stage limit 200'] = {
      columns: ['stage', 'avg'],
      rows: [
        { stage: 'lead', avg: 86.4321 },
        { stage: 'won', avg: 40 },
      ],
    };
    const section = { kind: 'breakdown', table: 'deal', by: 'stage', measure: 'avg won * 100', format: 'percent', title: 'Met' };
    draw({ dashboard: { ...dashboard, sections: [section] } });
    expect(await screen.findByText('86.4%')).toBeInTheDocument();
    expect(screen.getByText('40%')).toBeInTheDocument();
  });

  test('a breakdown of seconds says each bar as a time taken', async () => {
    breakdowns['deal avg first_response_seconds by stage limit 200'] = {
      columns: ['stage', 'avg'],
      rows: [
        { stage: 'lead', avg: 36120.42 },
        { stage: 'won', avg: 183600 },
      ],
    };
    const section = {
      kind: 'breakdown',
      table: 'deal',
      by: 'stage',
      measure: 'avg first_response_seconds',
      format: 'duration',
      title: 'First response',
    };
    draw({ dashboard: { ...dashboard, sections: [section] } });
    expect(await screen.findByText(/^10\s?h,? 2\s?m(in)?$/)).toBeInTheDocument();
    expect(screen.getByText(/^2\s?d,? 3\s?h$/)).toBeInTheDocument();
  });

  test('a breakdown measured against a goal per group: each bar the share reached, a group with only a goal at 0%', async () => {
    breakdowns['deal stage = won sum amount by owner limit 200'] = {
      columns: ['owner', 'sum'],
      rows: [
        { owner: 'ana', sum: 12000 },
        { owner: 'raj', sum: 30000 },
      ],
    };
    breakdowns['quota sum amount by owner limit 200'] = {
      columns: ['owner', 'sum'],
      rows: [
        { owner: 'ana', sum: 20000 },
        { owner: 'raj', sum: 25000 },
        { owner: 'lee', sum: 10000 },
      ],
    };
    const section = {
      kind: 'breakdown',
      table: 'deal',
      by: 'owner',
      query: 'stage = won',
      measure: 'sum amount',
      title: 'Attainment',
      target: { table: 'quota', by: 'owner', measure: 'sum amount' },
    };
    draw({ dashboard: { ...dashboard, sections: [section] } });
    const goals = await screen.findAllByText(/of .* target/);
    expect(goals.map((node) => node.textContent?.trim())).toEqual(['120% of 25,000 target', '60% of 20,000 target', '0% of 10,000 target']);
    const fills = [...document.querySelectorAll<HTMLElement>('.pbd-fill')].map((fill) => fill.style.width);
    // Past the goal the bar is full, never longer.
    expect(fills).toEqual(['100%', '60%', '0%']);
  });

  test("a note is the author's paragraphs, and a list counts what it shows", async () => {
    draw();
    expect(screen.getByRole('heading', { name: 'Read me' })).toBeInTheDocument();
    expect(screen.getByText('Second paragraph.')).toHaveClass('dashboard-note-text');
    expect(await screen.findByText('12 in all')).toBeInTheDocument();
  });

  test('an aside has its own context flow while using the same dashboard controls', () => {
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        filters: ['stage'],
        sections: [{ kind: 'note', title: 'Main', text: 'Main work.' }],
        aside: [{ kind: 'note', title: 'Context', text: 'Keep this nearby.' }],
      },
    });
    const layout = document.querySelector('.dashboard-layout.page-layout');
    expect(layout).toBeInTheDocument();
    expect(within(layout as HTMLElement).getByText('Main work.')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Dashboard context' })).toHaveTextContent('Keep this nearby.');
  });

  test('the window pills re-ask every clocked section and report the choice', async () => {
    const user = userEvent.setup();
    const onWindow = vi.fn();
    breakdowns['deal stage = won and closed_on = last 30 days sum amount'] = { columns: ['sum'], rows: [{ sum: 90000 }] };
    breakdowns['deal stage = won and closed_on = previous 30 days sum amount'] = { columns: ['sum'], rows: [{ sum: 100000 }] };
    draw({ onWindow });
    await screen.findByRole('button', { name: 'Won: 250,000' });
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    expect(onWindow).toHaveBeenCalledWith('last 30 days');
    expect(screen.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
    const won = await screen.findByRole('button', { name: 'Won: 90,000' });
    expect(within(won).getByText('↓ 10,000').closest('.dash-delta')).toHaveClass('bad');
    // The unclocked metric was not asked again.
    const asked = calls.flatMap((c) => (c.path === '/api/breakdowns' ? (c.body.items as Array<Record<string, unknown>>) : [c.body]));
    expect(asked.filter((ask) => ask.text === 'deal count')).toHaveLength(1);
  });

  test('a previous-period metric with no window of its own follows the picker, and its own windows', async () => {
    const user = userEvent.setup();
    breakdowns['deal stage = won and closed_on = last 30 days sum amount'] = { columns: ['sum'], rows: [{ sum: 90000 }] };
    breakdowns['deal stage = won and closed_on = previous 30 days sum amount'] = { columns: ['sum'], rows: [{ sum: 60000 }] };
    breakdowns['deal stage = won and closed_on = last 7 days sum amount'] = { columns: ['sum'], rows: [{ sum: 7000 }] };
    breakdowns['deal stage = won and closed_on = previous 7 days sum amount'] = { columns: ['sum'], rows: [{ sum: 9000 }] };
    /* As the server serves it (app.ts): no compare until a window is picked. */
    const follows = {
      kind: 'metric',
      table: 'deal',
      query: 'stage = won',
      measure: 'sum amount',
      title: 'Won',
      over: 'closed_on',
      comparePeriod: true,
      better: 'up' as const,
    };
    draw({
      dashboard: {
        ...dashboard,
        sections: [follows, { ...follows, title: 'Weekly', windows: ['last 7 days', 'last 30 days'], windowKey: 'weekly' }],
      },
    });
    const all = await screen.findByRole('button', { name: 'Won: 250,000' });
    expect(within(all).queryByText(/vs prior/)).toBeNull();
    // A section with windows of its own starts at its first, and compares with the one before it.
    const weekly = (await screen.findByText('↓ 2,000')).closest('.dash-delta');
    expect(weekly).toHaveClass('bad');
    expect(weekly).toHaveTextContent('vs prior 7 days');
    await user.click(screen.getByRole('button', { name: 'Last 30 days' }));
    const won = await screen.findByRole('button', { name: /^Won.*: 90,000/ });
    expect(within(won).getByText('↑ 30,000').closest('.dash-delta')).toHaveClass('good');
    expect(within(won).getByText('vs prior 30 days', { exact: false })).toBeInTheDocument();
  });

  test('a pick folds into every section whose table has the column, and is reported', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    breakdowns['deal stage = won and stage = won sum amount'] = { columns: ['sum'], rows: [{ sum: 1 }] };
    breakdowns['deal stage = won count'] = { columns: ['count'], rows: [{ count: 10 }] };
    breakdowns['deal stage = won count by stage'] = { columns: ['stage', 'count'], rows: [{ stage: 'won', count: 10 }] };
    draw({ onPick });
    await screen.findByRole('button', { name: 'Deals: 42' });
    await user.click(screen.getByRole('button', { name: 'Filter by stage' }));
    await user.click(screen.getByRole('option', { name: 'won' }));
    expect(onPick).toHaveBeenCalledWith({ stage: 'won' });
    await screen.findByRole('button', { name: 'Deals: 10' });
    expect(screen.queryByTitle('Open deal where stage = lead')).toBeNull();
  });

  test('a list in the aside is names — a line under each, a value at its end — each row opening its record', async () => {
    rowResults['deal stage = lead sort closed_on show name, stage, closed_on, id limit 5'] = [
      { id: 1, name: 'Stonebridge Holdings international renewal', stage: 'lead', closed_on: '2026-10-02' },
      { id: 2, name: 'Wexford', stage: 'lead', closed_on: null },
    ];
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        sections: [{ kind: 'note', text: 'Main work.' }],
        aside: [
          {
            kind: 'rows',
            table: 'deal',
            title: 'Coming up',
            query: 'stage = lead',
            sort: 'closed_on',
            show: ['name', 'stage', 'closed_on'],
          },
        ],
      },
    });
    const list = await screen.findByRole('list', { name: 'Coming up' });
    // No table in the aside: the grid is never asked for.
    expect(rooms).toHaveLength(0);
    const [first, second] = within(list).getAllByRole('button');
    expect(first.querySelector('.dash-mini-name')).toHaveTextContent('Stonebridge Holdings international renewal');
    expect(first.querySelector('.dash-mini-line')).toHaveTextContent('lead');
    expect(first.querySelector('.dash-mini-value')).toHaveTextContent(/2026|Oct/);
    expect(second.querySelector('.dash-mini-value')).toBeNull();
    await userEvent.setup().click(second);
    expect(opened).toHaveBeenCalledWith('deal', { id: 2 }, 'Wexford', 'push', {
      records: [
        { key: { id: 1 }, label: 'Stonebridge Holdings international renewal' },
        { key: { id: 2 }, label: 'Wexford' },
      ],
    });
  });

  test('a metric that names a view opens that room on the rows it counted, and shows an arrow', async () => {
    app = { ui: {}, nav: [{ view: 'pipeline' }], resources: {}, views: { pipeline: { kind: 'rows', table: 'deal', label: 'Pipeline' } } };
    draw({
      dashboard: {
        id: 'desk',
        label: 'Desk',
        sections: [
          { kind: 'metric', table: 'deal', title: 'Deals', view: 'pipeline' },
          { kind: 'metric', table: 'deal', title: 'Won', query: 'stage = won', measure: 'sum amount', view: 'missing' },
        ],
      },
    });
    const deals = await screen.findByRole('button', { name: 'Deals: 42' });
    expect(deals).toHaveClass('opens-view');
    expect(deals.querySelector('.home-card-go')).toHaveTextContent('→');
    await userEvent.setup().click(deals);
    expect(gone.at(-1)).toEqual({ table: 'deal', query: 'deal', view: 'pipeline' });
    // A view this reader is not served opens the table, without the arrow.
    const won = screen.getByRole('button', { name: 'Won: 250,000' });
    expect(won.querySelector('.home-card-go')).toBeNull();
  });

  test('a metric that says to: false is a figure read where it stands: no button, nothing opens', async () => {
    draw({
      dashboard: { id: 'desk', label: 'Desk', sections: [{ kind: 'metric', table: 'deal', title: 'Deals', noDrill: true }] },
    });
    const deals = await screen.findByRole('group', { name: 'Deals: 42' });
    expect(deals).toHaveClass('home-card-still');
    expect(screen.queryByRole('button', { name: 'Deals: 42' })).toBeNull();
    await userEvent.setup().click(deals);
    expect(gone).toEqual([]);
  });

  test.each([
    /* No query: every row the list shows, its standing condition alone, never its first tab. */
    { name: 'no query of its own', query: undefined, filter: '(amount > 0 or name = Exception)' },
    {
      name: 'an explicit refinement',
      query: 'stage = lost or name = Priority',
      filter: '(amount > 0 or name = Exception) and (stage = lost or name = Priority)',
    },
  ])('a metric counts and opens the same target cohort with $name', async ({ query, filter }) => {
    const parsed = parseAppConfig(
      {
        name: 'Deals',
        resources: { deal: { segments: { active: { query: 'stage = lead or stage = won', label: 'Active' } } } },
        views: {
          pipeline: {
            kind: 'list',
            from: 'deal',
            query: 'amount > 0 or name = Exception',
            sort: 'name',
            show: ['name'],
            tabs: [{ segment: 'active', sort: 'amount desc' }],
          },
          desk: { kind: 'dashboard', label: 'Desk', sections: [{ kind: 'metric', from: 'deal', title: 'Deals', to: 'pipeline', query }] },
        },
        home: 'desk',
        nav: ['desk'],
      },
      'dashboard cohort fixture',
    );
    const views = resolveViews(parsed, { label: 'Deals', dialect: 'sqlite', readAt: '', tables: Object.values(tables), foreignKeys: [] });
    expect(views.desk.error).toBeUndefined();
    app = { ui: {}, resources: {}, nav: [], views };
    breakdowns[`deal ${filter} count`] = { columns: ['count'], rows: [{ count: 3 }] };
    draw({ dashboard: { ...views.desk, id: 'desk' } });
    const metric = await screen.findByRole('button', { name: 'Deals: 3' });
    const asked = calls.flatMap((c) => (c.path === '/api/breakdowns' ? (c.body.items as Array<Record<string, unknown>>) : [c.body]));
    expect(asked.map((ask) => ask.text)).toEqual([`deal ${filter} count`]);
    await userEvent.setup().click(metric);
    expect(gone.at(-1)).toEqual({ table: 'deal', query: `deal ${filter}`, view: 'pipeline' });
  });

  test.each(['(amount > 0 or name = Exception)', 'closed_on = last 90 days'])(
    'a target metric keeps %s in the count, comparison, spark and drill after a window change',
    async (standing) => {
      const parsed = parseAppConfig(
        {
          name: 'Deals',
          resources: { deal: { segments: { leads: 'stage = lead' } } },
          views: {
            pipeline: { kind: 'list', from: 'deal', query: standing, tabs: ['leads'] },
            desk: {
              kind: 'dashboard',
              label: 'Desk',
              windows: ['last 7 days', 'last 30 days'],
              sections: [
                {
                  kind: 'metric',
                  from: 'deal',
                  title: 'Won',
                  to: 'pipeline',
                  query: 'stage = won and closed_on = last 30 days',
                  over: 'closed_on',
                  compare: 'previous period',
                  spark: true,
                },
              ],
            },
          },
          home: 'desk',
          nav: ['desk'],
        },
        'dashboard period cohort fixture',
      );
      const views = resolveViews(parsed, { label: 'Deals', dialect: 'sqlite', readAt: '', tables: Object.values(tables), foreignKeys: [] });
      const desk = views.desk as AppDashboardView;
      expect(desk.error).toBeUndefined();
      app = { ui: {}, resources: {}, nav: [], views };
      const cohort = `${standing} and stage = won`;
      for (const [period, count] of [
        ['last 30 days', 5],
        ['previous 30 days', 3],
        ['last 7 days', 2],
        ['previous 7 days', 1],
      ] as const) {
        breakdowns[`deal ${cohort} and closed_on = ${period} count`] = { columns: ['count'], rows: [{ count }] };
      }
      draw({ dashboard: { ...desk, id: 'desk' } });
      const user = userEvent.setup();
      const initial = await screen.findByRole('button', { name: 'Won: 5' });
      await user.click(initial);
      expect(gone.at(-1)).toEqual({ table: 'deal', query: `deal ${cohort} and closed_on = last 30 days`, view: 'pipeline' });
      await user.click(screen.getByRole('button', { name: 'Last 7 days' }));
      const weekly = await screen.findByRole('button', { name: 'Won: 2' });
      expect(within(weekly).getByText('↑ 1')).toBeInTheDocument();
      await user.click(weekly);
      expect(gone.at(-1)).toEqual({ table: 'deal', query: `deal ${cohort} and closed_on = last 7 days`, view: 'pipeline' });
      const asked = calls.flatMap((c) => (c.path === '/api/breakdowns' ? (c.body.items as Array<Record<string, unknown>>) : [c.body]));
      expect(asked.map((ask) => ask.text).sort()).toEqual(
        [
          `deal ${cohort} and closed_on = last 30 days count`,
          `deal ${cohort} and closed_on = previous 30 days count`,
          /* The trend is the window's own, a day at a time: thirty days of "last 30 days", seven of "last 7 days". */
          `deal ${cohort} and closed_on = last 30 days count by day closed_on limit 400`,
          `deal ${cohort} and closed_on = last 7 days count by day closed_on limit 400`,
          `deal ${cohort} and closed_on = last 7 days count`,
          `deal ${cohort} and closed_on = previous 7 days count`,
        ].sort(),
      );
    },
  );

  test('a window from the link is pressed on arrival', () => {
    draw({ window: 'last 90 days' });
    expect(screen.getByRole('button', { name: 'Last 90 days' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'false');
  });

  /* Keystone's dealer board: "All time" pressed over figures still counting
     their own ninety days. Unpicked is said as what it is. */
  test('where a section keeps its own window, the unpicked state is "Default", never "All time"', () => {
    const own = {
      ...dashboard,
      sections: [
        {
          kind: 'metric',
          table: 'deal',
          title: 'Won',
          query: 'stage = won and closed_on = last 90 days',
          over: 'closed_on',
          windowBase: 'stage = won',
        },
      ],
    };
    draw({ dashboard: own });
    expect(screen.getByRole('button', { name: 'Default' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'All time' })).toBeNull();
    // The figure says the window it keeps.
    expect(screen.getByText('Last 90 days', { selector: ':not(button)' })).toBeInTheDocument();
  });
});

describe('a first run', () => {
  const welcome = {
    ...dashboard,
    sections: [
      {
        kind: 'firstRun',
        title: 'Welcome',
        steps: [
          { label: 'Add your first deal', view: 'deals', table: 'deal' },
          { label: 'Add a note', view: 'notes', table: 'note' },
        ],
      },
      ...dashboard.sections,
    ],
  };

  test('over empty tables it is the dashboard: the welcome alone, no figures asked for', async () => {
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        <Dashboard dashboard={welcome} />,
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(screen.queryByText('Read me')).toBeNull();
    // One bounded read per step, and no section's own question (a batch the last test queued may still land).
    expect(runs().map((run) => [run.q, run.limit])).toEqual([
      ['deal', 1],
      ['note', 1],
    ]);
    expect(document.querySelector('.page-breakdown-rows, .home-cards')).toBeNull();
  });

  test('once a step is done the dashboard draws under it, and once all are it is gone', async () => {
    rowResults.deal = [{ id: 1 }];
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        <Dashboard dashboard={welcome} />,
      ),
    );
    expect(await screen.findByRole('heading', { name: 'Welcome' })).toBeInTheDocument();
    expect(await screen.findByText('Read me')).toBeInTheDocument();
    cleanup();
    rowResults.note = [{ id: 2 }];
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        <Dashboard dashboard={welcome} />,
      ),
    );
    expect(await screen.findByText('Read me')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Welcome' })).toBeNull();
  });
});

describe('a matrix', () => {
  afterEach(() => document.body.classList.remove('app-mode'));
  test('says its column heads in words and orders them by their vocabulary, as its rows are', async () => {
    document.body.classList.add('app-mode');
    breakdowns['deal count by name, stage limit 400'] = {
      columns: ['name', 'stage', 'count'],
      rows: [
        { name: 'Ada', stage: 'won', count: 9 },
        { name: 'Ada', stage: 'lost', count: 1 },
        { name: 'Bo', stage: 'lead', count: 2 },
      ],
    };
    const crossed = {
      id: 'cross',
      label: 'Cross',
      sections: [{ kind: 'matrix', table: 'deal', by: 'name, stage', title: 'Deals by stage' }],
    };
    render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        <Dashboard dashboard={crossed} />,
      ),
    );
    await waitFor(() => expect(document.querySelectorAll('.matrix-col').length).toBe(3));
    // The CHECK order (lead, won, lost), not the heaviest first; each said as its word.
    expect([...document.querySelectorAll('.matrix-col')].map((head) => head.textContent)).toEqual(['Lead', 'Won', 'Lost']);
    /* The heaviest cell is tinted to the palette's heat top, not a fixed 62%: its ink reads on it in every look (G186). */
    const heaviest = [...document.querySelectorAll<HTMLElement>('.matrix-cell')].find((cell) => cell.textContent === '9')!;
    expect(heaviest.style.getPropertyValue('--heat')).toBe('1.000');
    expect(heaviest.style.background).toBe('var(--heat-fill)');
  });
});

describe('the dashboard blocks', () => {
  test('a banner note is drawn as a banner, with its tag and its action', () => {
    draw({
      dashboard: {
        id: 'home',
        label: 'Home',
        sections: [
          {
            kind: 'note',
            variant: 'banner',
            eyebrow: 'New this week',
            title: 'Welcome back',
            text: 'Pick up where you left off.',
            action: { label: 'Open leads', view: 'leads' },
          },
        ],
      },
    });
    const note = document.querySelector('.dashboard-note.is-banner') as HTMLElement;
    expect(note).not.toBeNull();
    expect(within(note).getByText('New this week')).toBeInTheDocument();
    expect(note.closest('section')).toHaveClass('dash-banner');
  });

  test('a breakdown of steps is a card per vocabulary value, in order, each a doorway', async () => {
    const user = userEvent.setup();
    app = { ui: {}, nav: [], resources: {}, views: { deals: { table: 'deal', label: 'Deals', query: '' } } };
    draw({
      dashboard: {
        id: 'flow',
        label: 'Flow',
        sections: [
          {
            kind: 'breakdown',
            shape: 'steps',
            table: 'deal',
            by: 'stage',
            title: 'Flow',
            notes: { lead: 'Waiting on us' },
          },
        ],
      },
    });
    await waitFor(() => expect(document.querySelector('.dash-step-figure')?.textContent).toBe('30'));
    const cards = [...document.querySelectorAll('.dash-steps .dash-step-card')];
    // The column's vocabulary, not the counts' order; "lost" has no rows and is still a step.
    expect(cards.map((c) => c.querySelector('.dash-step-title')?.textContent)).toEqual(['lead', 'won', 'lost']);
    expect(cards.map((c) => c.querySelector('.dash-step-figure')?.textContent)).toEqual(['30', '10', '0']);
    expect(cards[0].querySelector('.dash-step-note')).toHaveTextContent('Waiting on us');
    expect(cards[1].querySelector('.dash-step-note')).toBeNull();
    expect(document.querySelectorAll('.dash-step-arrow')).toHaveLength(2);
    await user.click(screen.getByTitle('Open deal where stage = lead'));
    expect(gone.at(-1)).toEqual({ table: 'deal', query: 'deal stage = lead', view: 'deals' });
  });

  test('a window button replaces the segmented row, and a window picked from it is what the sections ask for', async () => {
    const user = userEvent.setup();
    const onWindow = vi.fn();
    breakdowns['deal stage = won and closed_on = last 30 days sum amount'] = { columns: ['sum'], rows: [{ sum: 90000 }] };
    draw({ dashboard: { ...dashboard, windowControl: 'button' }, onWindow });
    expect(document.querySelectorAll('.dash-window-button')).toHaveLength(1);
    expect(document.querySelector('.dash-windows')).toBeNull();
    await screen.findByRole('button', { name: 'Won: 250,000' });
    await user.click(document.querySelector('.dash-window-button') as HTMLElement);
    await user.click(await screen.findByRole('menuitem', { name: /Last 30 days/ }));
    expect(onWindow).toHaveBeenCalledWith('last 30 days');
    expect(await screen.findByRole('button', { name: 'Won: 90,000' })).toBeInTheDocument();
  });

  describe('areas', () => {
    const areaNames = () => [...document.querySelectorAll<HTMLElement>('.dash-area')].map((area) => area.style.getPropertyValue('--area'));
    const template = () => (document.querySelector('.dash-grid') as HTMLElement).style.getPropertyValue('--dash-template');
    const placed = (areas: string[], sections: Array<Record<string, unknown>>) => ({
      ...dashboard,
      windows: undefined,
      filters: undefined,
      areas,
      sections,
    });
    const won = { kind: 'metric', table: 'deal', query: 'stage = won', measure: 'sum amount', title: 'Won' };
    const deals = { kind: 'metric', table: 'deal', title: 'Deals' };
    const byStage = { kind: 'breakdown', table: 'deal', by: 'stage', title: 'By stage' };
    const recent = { kind: 'rows', table: 'deal', title: 'Recent', limit: 3 };

    test('areas stand in reading order, not the order the sections were written in', async () => {
      draw({
        dashboard: placed(
          ['side mix', 'side work'],
          [
            { ...recent, area: 'work' },
            { ...byStage, area: 'mix' },
            { ...deals, area: 'side' },
          ],
        ),
      });
      await screen.findByRole('button', { name: 'Deals: 42' });
      expect(areaNames()).toEqual(['side', 'mix', 'work']);
      expect(template()).toBe('"side mix" "side work"');
      expect(document.querySelector('.dash-grid')?.getAttribute('data-columns')).toBe('2');
    });

    test('metrics form a strip in their own area, and nothing pairs inside one', async () => {
      draw({
        dashboard: placed(
          ['kpis kpis', 'a b'],
          [
            { ...won, area: 'kpis' },
            { ...deals, area: 'kpis' },
            { ...byStage, area: 'a' },
            { ...byStage, title: 'Again', area: 'b' },
          ],
        ),
      });
      await screen.findByRole('button', { name: 'Deals: 42' });
      const [kpis, a] = [...document.querySelectorAll('.dash-area')];
      expect(kpis.querySelectorAll('.dash-strip')).toHaveLength(1);
      expect(kpis.querySelectorAll('.dash-strip .home-card')).toHaveLength(2);
      // Written side by side, two breakdowns would have been paired to half widths; the author placed these.
      expect(a.querySelector('section')?.className).toContain('width-full');
    });

    test('a dashboard without a layout is drawn as it always was', async () => {
      draw();
      await screen.findByRole('button', { name: 'Deals: 42' });
      expect(document.querySelector('.dash-grid, .dash-area, .dash-laid')).toBeNull();
    });

    test('an area whose sections all leave out is re-flowed away once the answers are in', async () => {
      breakdowns['deal count by stage'] = { columns: ['stage', 'count'], rows: [] };
      breakdowns['deal count by stage limit 200'] = { columns: ['stage', 'count'], rows: [] };
      draw({
        dashboard: placed(
          ['mix work', 'kpis kpis'],
          [
            { ...byStage, emptyMode: 'hide', area: 'mix' },
            { ...recent, area: 'work' },
            { ...deals, area: 'kpis' },
          ],
        ),
      });
      await waitFor(() => expect(document.querySelector('.dash-area[hidden]')).not.toBeNull());
      expect((document.querySelector('.dash-area[hidden]') as HTMLElement).style.getPropertyValue('--area')).toBe('mix');
      // The hidden area's cell goes to its neighbour: the list now stands the whole row.
      expect(template()).toBe('"work work" "kpis kpis"');
      // The section stays mounted, so it is still asked and can come back; it is the area that is out of the grid.
      expect(areaNames()).toEqual(['mix', 'work', 'kpis']);
    });
  });

  test('a dashboard that is only the branding form does not say "Branding" twice', async () => {
    draw({ dashboard: { id: 'brand', label: 'Branding', sections: [{ kind: 'branding' }] } });
    await waitFor(() => expect(document.querySelector('[data-stub="branding-form"]')).not.toBeNull());
    expect(document.querySelector('h2.page-section-title')).toBeNull();
  });
});
