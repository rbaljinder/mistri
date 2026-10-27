/**
 * An app's list page, drawn and driven.
 *
 * Against an API that answers counts, rows and saved filters like the
 * server would. The grid inside is the vanilla client's and is stood in
 * for; the filter bar and its pickers are the real ones, because what the
 * list says in its bar depends on what they read.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { humanName } from '../../../../engine/src/shared/model.js';
import { setPublicVisitor } from '../../../../mistri/src/client/publicVisitor.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const toasts: string[] = [];
/* The server's saved views for this connection, and whose they are. */
let savedFilters: Record<string, Array<{ name: string; query: string }>> = {};
let viewStore: 'shared' | 'account' | 'none' = 'shared';
let promptAnswer: string | null = 'Open twos';
let countMode: 'known' | 'unknown' | 'parse-error' | 'capped' | 'no-batch' = 'known';
let gridReply: ((d: unknown) => void) | undefined;
/* Held while set: the badges' batch is on the way. */
let countsGate: Promise<void> | undefined;
/* The props the list last gave its grid. */
let room: Record<string, unknown> = {};

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const task: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('title', 'TEXT'),
    col('status', 'TEXT', { allowed: ['open', 'in_progress', 'done'] }),
    col('priority', 'INTEGER'),
    col('due_on', 'DATE'),
    col('is_urgent', 'INTEGER'),
  ] as TableMeta['columns'],
};

vi.mock('../core.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    // An App registers its words for every column (appnav's label source, which this suite stands in for).
    columnLabel: (_table: string, column: string) => humanName(column),
    state: { activeConnection: 'demo', page: 3, schema: { tables: [task], foreignKeys: [] } },
    findTable: (id: string) => (id === 'task' ? task : undefined),
    toast: (message: string) => toasts.push(message),
    api: async (path: string, body: Record<string, unknown>) => {
      calls.push({ path, body });
      if (path === '/api/filters') return { filters: structuredClone(savedFilters), store: viewStore };
      if (path === '/api/filters/save') {
        const next = { ...savedFilters };
        if (body.filters) next[String(body.list)] = body.filters as never;
        else delete next[String(body.list)];
        savedFilters = next;
        return { ok: true };
      }
      if (path === '/api/breakdown') {
        return String(body.text).includes('by status')
          ? {
              columns: ['status', 'count'],
              rows: [
                { status: 'open', count: 12 },
                { status: 'done', count: 3 },
              ],
            }
          : { columns: [], rows: [] };
      }
      if (path === '/api/counts') {
        if (countsGate) await countsGate;
        // A server without the batch: the badges are asked tab by tab instead.
        if (countMode === 'no-batch') throw new Error('Not found');
        return {
          results: (body.items as string[]).map((q) =>
            countMode === 'parse-error'
              ? { errors: [{ message: 'Invalid tab query.' }] }
              : countMode === 'capped'
                ? { total: 10_000, exactTotal: true, cappedTotal: true }
                : countMode === 'known'
                  ? { total: q.includes('status = open') ? 12 : 40, exactTotal: true }
                  : {},
          ),
        };
      }
      if (path === '/api/run')
        return countMode === 'parse-error'
          ? { errors: [{ message: 'Invalid tab query.' }] }
          : {
              ...(countMode === 'known' || countMode === 'no-batch' ? { total: String(body.q).includes('status = open') ? 12 : 40 } : {}),
              rows: [],
              errors: [],
            };
      return {};
    },
  };
});
/* Further views a test puts beside `tasks` — a second view over its table — and the resources served beside them. */
const extraViews: Array<[string, { label: string } & Record<string, unknown>]> = [];
const resources: Record<string, unknown> = { task: { labels: { title: 'Task' } } };
/* Views a test leaves out of nav: one only a dashboard embeds. */
const unlisted = new Set<string>();
/* What the App payload says this reader may run (grantedCommands, grantedActions), as a test sets it. */
let grants: Record<string, unknown> = {};
vi.mock('../../../../mistri/src/client/appState.js', () => ({
  activeApp: () => {
    const rooms = [['tasks', view] as const, ...extraViews];
    return {
      ...grants,
      ui: {},
      resources,
      views: Object.fromEntries(rooms),
      nav: rooms.filter(([key]) => !unlisted.has(key)).map(([key, room]) => ({ view: key, label: room.label })),
    };
  },
}));
vi.mock('./TableRoom.js', async () => {
  const { useEffect } = await import('react');
  return {
    TableRoom: ({ onResult, empty, ...props }: { onResult?: (d: unknown) => void; empty?: ReactNode }) => {
      gridReply = onResult;
      room = props;
      useEffect(() => {
        onResult?.({ columns: [], total: 7 });
      }, []); // eslint-disable-line react-hooks/exhaustive-deps
      return empty ?? null;
    },
  };
});
/* What each prompt was opened with: a view's name starts as its question in words. */
const prompted: Array<{ value?: string; hint?: string }> = [];
vi.mock('../prompt.js', () => ({
  promptFor: async (options: { value?: string; hint?: string }) => {
    prompted.push(options);
    return promptAnswer;
  },
}));

/* The App's view of task, as served, and the list spec it makes: the view under its key. */
const view = {
  table: 'task',
  label: 'Tasks',
  presentation: {
    kind: 'split' as const,
    limit: 25,
    detail: ['title', 'status'],
  },
  tabs: [{ label: 'All' }, { label: 'Open', query: 'status = open' }, { label: 'In progress', query: 'status = in_progress' }],
  show: ['title', 'status', 'priority'],
  filters: ['status', 'priority'],
};
const spec = { id: 'tasks', ...view };

const { AppList } = await import('./AppList.js');
const { installShell } = await import('../shellMode.js');
const { PHONE_QUERY, RAIL_QUERY } = await import('./useMediaQuery.js');
const { appListQuery, appCrumbLabel, appListFor, currentNavIndex, defaultListShow, litTabFor, visibleQuestion, wholeQuery } =
  await import('./appListModel.js');

beforeEach(bridgeShell);

describe('the view that opened a room', () => {
  /* A second view over the same table with no query of its own: nothing but
     its key tells it from the plain one. */
  const inbox = { table: 'task', label: 'Inbox', show: ['title'], presentation: { kind: 'split' as const } };
  beforeEach(() => {
    extraViews.push(['inbox', inbox]);
  });
  afterEach(() => {
    extraViews.length = 0;
  });

  test('is found by its key, and without one — or with one no view has — by table and query as before', () => {
    expect(appListFor('task', 'task', 'inbox')).toMatchObject({ id: 'inbox', label: 'Inbox' });
    expect(appListFor('task', undefined, 'inbox').id).toBe('inbox');
    expect(appListFor('task', 'task').id).toBe('tasks');
    expect(appListFor('task').id).toBe('tasks');
    expect(appListFor('task', undefined, 'renamed').id).toBe('tasks');
    // A key names a view over *this* table only.
    expect(appListFor('other', undefined, 'inbox').id).toBeUndefined();
    expect(appCrumbLabel({ table: 'task', query: 'task', view: 'inbox' })).toBe('Inbox');
  });

  test('a view only a dashboard embeds is found by its key alone, never by its table', () => {
    extraViews.push(
      ['board', { label: 'Board', sections: [{ kind: 'list', table: 'note', view: 'notes' }] }],
      ['notes', { table: 'note', label: 'Notes' }],
    );
    unlisted.add('notes');
    try {
      expect(appListFor('note', 'note', 'notes')).toMatchObject({ id: 'notes', label: 'Notes' });
      expect(appCrumbLabel({ table: 'note', query: 'note', view: 'notes' })).toBe('Notes');
      /* Without its key the table has no listed view: the stand-in, as before the room existed. */
      expect(appListFor('note', 'note')).toMatchObject({ table: 'note', label: 'Note' });
      expect(appListFor('note', 'note').id).toBeUndefined();
    } finally {
      unlisted.clear();
    }
  });

  test('lights its menu row by its key', () => {
    const inboxSpec = { id: 'inbox', ...inbox };
    expect(currentNavIndex([spec, inboxSpec], 'task', 'task show title, id', 'inbox')).toBe(1);
    expect(currentNavIndex([spec, inboxSpec], 'task', 'task show title, id')).toBe(0);
    expect(currentNavIndex([spec, inboxSpec], 'task', 'task show title, id', 'renamed')).toBe(0);
  });
});

test('synthesized defaults name references but keep keys and authored projections intact', () => {
  const owner: TableMeta = {
    ...task,
    id: 'owner',
    name: 'owner',
    columns: [col('id', 'INTEGER', { primaryKey: true }), col('name', 'TEXT')],
  };
  const work: TableMeta = {
    ...task,
    columns: [
      col('id', 'INTEGER', { primaryKey: true }),
      col('owner_id', 'INTEGER', { references: { table: 'owner', column: 'id' } }),
      col('title', 'TEXT'),
    ],
  };
  const schema = { label: 'Test', dialect: 'sqlite' as const, readAt: '', tables: [work, owner], foreignKeys: [] };
  expect(defaultListShow(schema, work)).toEqual(['id', 'owner_id.name', 'title']);
  expect(appListFor('task')).toMatchObject(spec);
  expect(appListFor('task').presentation).toEqual(view.presentation);
  expect(wholeQuery(spec, 'show id')).toBe('task show id');
});

test("a stand-in for a table the App has no view of offers its resource's New form and actions", () => {
  const pin = { id: 'pin', label: 'Pin', set: { pinned: true } };
  resources.note = { form: { show: ['body'] }, actions: [pin] };
  try {
    expect(appListFor('note')).toEqual({ table: 'note', label: 'Note', form: { show: ['body'] }, actions: [pin] });
  } finally {
    delete resources.note;
  }
  expect(appListFor('note')).toEqual({ table: 'note', label: 'Note' });
});

const PLUMBING = 'show title, status, priority, id';

function draw(query: string, props = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const navigate = vi.fn();
  render(
    createElement(QueryClientProvider, { client }, <AppList entry={{ table: 'task', query }} spec={spec} navigate={navigate} {...props} />),
  );
  return { navigate };
}

/* A phone, as the media queries the list reads say it: a handset is under
   the phone width and under the width a filter rail needs, so both match —
   mocking only one described a window no device has. */
const onAPhone = () =>
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: query === PHONE_QUERY || query === RAIL_QUERY,
        media: query,
        addEventListener() {},
        removeEventListener() {},
      }) as unknown as MediaQueryList,
  );

beforeEach(() => {
  calls.length = 0;
  toasts.length = 0;
  savedFilters = {};
  viewStore = 'shared';
  promptAnswer = 'Open twos';
  countMode = 'known';
  gridReply = undefined;
  countsGate = undefined;
  room = {};
  grants = {};
});
afterEach(() => {
  cleanup();
  installShell({ writeScope: () => true });
});

describe('the model', () => {
  test("a tab is a query text, with the app's plumbing folded in", () => {
    expect(appListQuery(spec, 0)).toBe(`task ${PLUMBING}`);
    expect(appListQuery(spec, 1)).toBe(`task status = open ${PLUMBING}`);
  });

  test('the visible question leaves the table and the plumbing out, and the whole query puts them back', () => {
    expect(visibleQuestion(spec, `task status = open and priority = 2 ${PLUMBING}`)).toBe('status = open and priority = 2');
    expect(wholeQuery(spec, 'status = open')).toBe(`task status = open ${PLUMBING}`);
    // A show of the reader's own wins and stays.
    expect(wholeQuery(spec, 'status = open show title')).toBe('task status = open show title');
  });

  test('which tab is lit is derived from the text, boxes aside', () => {
    expect(litTabFor(spec.tabs, 'status = open', ['status', 'priority'])).toBe(1);
    expect(litTabFor(spec.tabs, 'status = open and priority = 2', ['status', 'priority'])).toBe(1);
    expect(litTabFor(spec.tabs, 'status = in_progress', ['status', 'priority'])).toBe(2);
    // A clause no tab explains lights nothing; the residue is a chip of its own.
    expect(litTabFor(spec.tabs, 'priority = 2 sort due_on', ['status', 'priority'])).toBe(-1);
    expect(litTabFor(spec.tabs, 'priority = 2', ['status', 'priority'])).toBe(0);
    expect(litTabFor(spec.tabs, 'sort due_on', ['status', 'priority'])).toBe(-1);
  });

  test("the crumb says the app's label, the tab, or what the refinement narrows to", () => {
    expect(appCrumbLabel({ table: 'task', query: `task ${PLUMBING}` })).toBe('Tasks');
    expect(appCrumbLabel({ table: 'task', query: `task status = open ${PLUMBING}` })).toBe('Tasks · Open');
    // A number carries its column's name; the sort narrows nothing and says nothing.
    expect(appCrumbLabel({ table: 'task', query: 'task priority = 2 sort due_on' })).toBe('Tasks · Priority 2');
    expect(appCrumbLabel({ table: 'task', query: 'task sort due_on' })).toBe('Tasks');
  });

  test('a filtered view without tabs is never the plain address of its table', () => {
    /* Its question hides its standing condition, so a bare table read as its
       one tab: the plain address of note was Urgent notes, conditions and all. */
    extraViews.push(
      [
        'notes',
        {
          table: 'note',
          label: 'Notes',
          tabs: [
            { label: 'Open', query: 'status = open' },
            { label: 'Done', query: 'status = done' },
          ],
        },
      ],
      ['urgent', { table: 'note', label: 'Urgent notes', query: 'priority = 1', show: ['title'] }],
    );
    try {
      expect(appListFor('note', 'note').id).toBe('notes');
      expect(appListFor('note', 'note priority = 1 show title').id).toBe('urgent');
    } finally {
      extraViews.length = 0;
    }
  });

  test('a tab of either-or conditions is named by its label, clicked bare or composed in brackets', () => {
    extraViews.push([
      'board',
      {
        table: 'task',
        label: 'Board',
        show: ['title'],
        tabs: [{ label: 'All' }, { label: 'Moving', query: 'status = open or status = in_progress' }],
      },
    ]);
    try {
      expect(appCrumbLabel({ table: 'task', view: 'board', query: 'task status = open or status = in_progress show title, id' })).toBe(
        'Board · Moving',
      );
      expect(appCrumbLabel({ table: 'task', view: 'board', query: 'task (status = open or status = in_progress) show title, id' })).toBe(
        'Board · Moving',
      );
      // Refined to an either-or no tab names, it is a filter, not the query's text.
      expect(appCrumbLabel({ table: 'task', view: 'board', query: 'task priority = 1 or priority = 2 show title, id' })).toBe(
        'Board · 1 filter',
      );
    } finally {
      extraViews.length = 0;
    }
  });
});

describe('a row menu', () => {
  const close = { id: 'close', label: 'Close', command: { id: 'closeTask' } };
  const note = { id: 'note', label: 'Note', set: { status: 'done' } };
  const withVerbs = (actions: unknown[]) => ({ spec: { ...spec, presentation: undefined, rowActions: true, actions } });

  test('is asked for when the reader holds a command the list offers', () => {
    grants = { grantedCommands: ['closeTask'] };
    draw(`task ${PLUMBING}`, withVerbs([close]));
    expect(room.rowActions).toBe(true);
  });

  test('is not asked for, so no column is reserved, when the reader may run none of the verbs', () => {
    installShell({ writeScope: () => false });
    draw(`task ${PLUMBING}`, withVerbs([close, note]));
    expect(room.rowActions).toBe(false);
  });

  test('is asked for where a role of the reader runs a fixed action without write', () => {
    installShell({ writeScope: () => false });
    grants = { grantedActions: { task: ['note'] } };
    draw(`task ${PLUMBING}`, withVerbs([close, note]));
    expect(room.rowActions).toBe(true);
  });

  test('is decided on the first draw, from the payload, never after the rows load', async () => {
    installShell({ writeScope: () => false });
    draw(`task ${PLUMBING}`, withVerbs([close]));
    const first = room.rowActions;
    await act(async () => {
      gridReply?.({ columns: [], rows: [], total: 0, errors: [] });
    });
    expect([first, room.rowActions]).toEqual([false, false]);
  });
});

describe('the page', () => {
  test.each([undefined, false])('Advanced is hidden unless opted in (%s)', (advancedFilters) => {
    draw(`task ${PLUMBING}`, { spec: { ...spec, advancedFilters } });
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Filter Tasks')).not.toBeVisible();
    expect(screen.getByRole('searchbox', { name: 'Filter by Title' })).toBeVisible();
  });

  test("filterBar 'none' removes the form without removing tabs or active-query chips", async () => {
    const { navigate } = draw(`task status = open and priority = 2 ${PLUMBING}`, { spec: { ...spec, filterBar: 'none' } });
    expect(document.querySelector('.applist-filterbar')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Filter' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
    // The words arrive on demand; until then the chip says its condition as written.
    expect(await screen.findByText('Priority is 2')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: /^In progress/ }));
    // As with the visible form, only hand-edited boxes carry across tabs.
    expect(navigate).toHaveBeenCalledWith(`task status = in_progress ${PLUMBING}`);
  });

  test('swapping tabs keeps every badge saying its count while the next batch is on the way', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const at = (query: string) =>
      createElement(QueryClientProvider, { client }, <AppList entry={{ table: 'task', query }} spec={spec} navigate={vi.fn()} />);
    const { rerender } = render(at(`task status = open ${PLUMBING}`));
    const badge = (name: RegExp) => screen.getByRole('tab', { name }).querySelector('.tab-count');
    await vi.waitFor(() => expect(badge(/^In progress/)).toHaveTextContent('40'));
    expect(badge(/^Open/)).toHaveTextContent('7');
    let release = () => {};
    countsGate = new Promise((resolve) => (release = resolve));
    rerender(at(`task status = in_progress ${PLUMBING}`));
    // Open's count was the grid's; In progress's was the batch's. Neither empties for the trip.
    expect(badge(/^Open/)).toHaveTextContent('7');
    expect(badge(/^In progress/)).toHaveTextContent('40');
    expect(badge(/^All/)).toHaveTextContent('40');
    await act(async () => release());
    await vi.waitFor(() => expect(badge(/^Open/)).toHaveTextContent('12'));
    // The batch is answered and leaves out the tab on screen, whose rows are still on the way: its badge keeps its
    // count. Emptied for those frames, the tab narrowed, and a strip at the edge of its fold flickered (useTabFold.ts).
    expect(badge(/^In progress/)).toHaveTextContent('40');
  });

  test('a known grid total becoming unknown clears its badge without reviving a cached count', async () => {
    draw(`task status = open ${PLUMBING}`);
    const tab = screen.getByRole('tab', { name: /^Open/ });
    await vi.waitFor(() => expect(within(tab).getByText('7')).toBeInTheDocument());
    const before = calls.filter((call) => call.path === '/api/run').length;
    await act(async () => {
      gridReply?.({ columns: [], rows: [], errors: [] });
    });
    expect(tab.querySelector('.tab-count')).toBeEmptyDOMElement();
    expect(calls.filter((call) => call.path === '/api/run')).toHaveLength(before);
    await act(async () => {
      gridReply?.({ columns: [], rows: [], total: 0, errors: [] });
    });
    expect(within(tab).getByText('0')).toBeInTheDocument();
  });
  test.each(['unknown', 'parse-error'] as const)('%s tab counts stay blank, never zero', async (mode) => {
    countMode = mode;
    draw(`task status = open ${PLUMBING}`);
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    await vi.waitFor(() => expect(within(tabs[1]).getByText('7')).toBeInTheDocument());
    await vi.waitFor(() => expect(calls.some((call) => call.path === '/api/counts')).toBe(true));
    expect(tabs[0].querySelector('.tab-count')).toBeEmptyDOMElement();
    expect(tabs[2].querySelector('.tab-count')).toBeEmptyDOMElement();
  });
  test('every badge but the one on screen is asked in one batch, bounded ones said with a plus', async () => {
    countMode = 'capped';
    draw(`task status = open ${PLUMBING}`);
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    await vi.waitFor(() => expect(within(tabs[0]).getByText('10,000+')).toBeInTheDocument());
    const batches = calls.filter((call) => call.path === '/api/counts');
    expect(batches).toHaveLength(1);
    // The grid answers its own tab; the batch never asks it again.
    expect((batches[0].body.items as string[]).some((q) => q.includes('status = open'))).toBe(false);
    expect(calls.filter((call) => call.path === '/api/run' && call.body.limit === 1)).toHaveLength(0);
  });
  test('a server without the batch is asked tab by tab', async () => {
    countMode = 'no-batch';
    // Another tab on screen, so the batch is a question no earlier test cached.
    draw(`task status = in_progress ${PLUMBING}`);
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    await vi.waitFor(() => expect(within(tabs[1]).getByText('12')).toBeInTheDocument());
    expect(within(tabs[0]).getByText('40')).toBeInTheDocument();
    expect(calls.filter((call) => call.path === '/api/run' && call.body.limit === 1).length).toBeGreaterThan(0);
  });
  test('the heading, the tabs with counts, the filter bar and the grid', async () => {
    draw(`task status = open ${PLUMBING}`);
    const controls = screen.getByRole('group', { name: 'Tasks list controls' });
    expect(within(controls).getByRole('tablist')).toBeInTheDocument();
    expect(within(controls).getByRole('searchbox', { name: 'Filter by Title' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Tasks');
    const tabs = within(screen.getByRole('tablist')).getAllByRole('tab');
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    // The lit tab's badge is the grid's own total; the others count themselves.
    await vi.waitFor(() => expect(within(tabs[1]).getByText('7')).toBeInTheDocument());
    await vi.waitFor(() => expect(within(tabs[0]).getByText('40')).toBeInTheDocument());
    // The name column is the search; every other filter a "+" that opens its picker, and nothing to press after.
    expect(screen.getByRole('searchbox', { name: 'Filter by Title' })).toHaveAttribute('placeholder', 'Search tasks…');
    expect(screen.getByRole('button', { name: 'Filter by Status' })).toHaveTextContent('+Status');
    expect(screen.getByRole('button', { name: 'Filter by Priority' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filter' })).not.toBeInTheDocument();
    // The lit tab already says status; no chip repeats it.
    expect(document.querySelectorAll('.applist-chip')).toHaveLength(0);
  });

  test('over an API, the label column gets no box it cannot filter by; authored filters stay as written', async () => {
    // An API filters where it documents a parameter; a Task search would only ever be refused.
    task.filterable = ['status'];
    try {
      draw(`task status = open ${PLUMBING}`);
      await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Filter by Priority' })).toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Filter by Status' })).toBeInTheDocument();
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    } finally {
      delete task.filterable;
    }
  });

  test("a refinement is said as chips, and a chip's × takes its condition out", async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task status = open and priority = 2 ${PLUMBING}`);
    const chip = screen.getByText('Priority is 2').closest('.applist-chip')!;
    await user.click(within(chip as HTMLElement).getByRole('button', { name: 'Remove Priority is 2' }));
    expect(navigate).toHaveBeenCalledWith(`task status = open ${PLUMBING}`);
  });

  test('a leftover clause no tab explains is one chip in words, in the bar with the rest', async () => {
    draw(`task priority = 2 sort due_on ${PLUMBING}`);
    expect(screen.getByText('Sorted by Due on')).toHaveClass('applist-chip-text');
    expect(screen.getByText('Sorted by Due on').closest('.applist-fields')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Remove Sorted by Due on' })).toBeInTheDocument();
    // Offered once the server has said the list keeps saved views.
    expect(await screen.findByRole('button', { name: 'Save view…' })).toBeInTheDocument();
  });

  test("a tab click swaps the tab's clause and carries what is typed in the search", async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task status = open ${PLUMBING}`);
    await user.type(screen.getByRole('searchbox', { name: 'Filter by Title' }), 'fix');
    await user.click(screen.getByRole('tab', { name: /^In progress/ }));
    expect(navigate).toHaveBeenCalledWith(`task status = in_progress and title contains fix ${PLUMBING}`);
  });

  test('Enter in the search box asks for its words', async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task ${PLUMBING}`);
    await user.type(screen.getByRole('searchbox', { name: 'Filter by Title' }), 'fix{Enter}');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`task title contains fix ${PLUMBING}`);
  });

  test('Advanced opens the query text, which is the question without the plumbing, and Enter asks it', async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task status = open sort due_on ${PLUMBING}`, { spec: { ...spec, advancedFilters: true } });
    expect(screen.getByLabelText('Filter Tasks')).not.toBeVisible();
    const focus = vi.spyOn(screen.getByLabelText('Filter Tasks'), 'focus');
    await user.click(screen.getByRole('button', { name: 'Advanced' }));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(screen.getByLabelText('Filter Tasks')).toBeVisible();
    expect(screen.getByLabelText('Filter Tasks')).toHaveValue('status = open sort due_on');
    await user.clear(screen.getByLabelText('Filter Tasks'));
    await user.type(screen.getByLabelText('Filter Tasks'), 'priority = 3{Enter}');
    expect(navigate).toHaveBeenCalledWith(`task priority = 3 ${PLUMBING}`);
  });

  test("Save view… keeps the question through a fresh read of the server's list; Rename view… renames it; its × removes it", async () => {
    const user = userEvent.setup();
    draw(`task status = open and priority = 2 ${PLUMBING}`);
    await user.click(await screen.findByRole('button', { name: 'Save view…' }));
    const saved = await screen.findByRole('tab', { name: /^Open twos/ });
    expect(prompted.at(-1)?.value).toBe('Status is Open and Priority is 2');
    expect(prompted.at(-1)?.hint).toBeUndefined();
    expect(saved).toHaveClass('tab-yours');
    expect(saved).toHaveAttribute('aria-selected', 'true');
    expect(savedFilters.tasks).toEqual([{ name: 'Open twos', query: 'status = open and priority = 2' }]);
    // Read, then written — never a write on a stale cache.
    expect(
      calls
        .filter((c) => c.path.startsWith('/api/filters'))
        .map((c) => c.path)
        .slice(-2),
    ).toEqual(['/api/filters', '/api/filters/save']);
    // An App without sign-in keeps one list for every reader.
    expect(screen.getByText('Saved views')).toBeInTheDocument();
    // Kept, so not offered again: the lit view is renamed instead.
    expect(screen.queryByRole('button', { name: 'Save view…' })).not.toBeInTheDocument();
    promptAnswer = 'Twos';
    await user.click(screen.getByRole('button', { name: 'Rename view…' }));
    expect(await screen.findByRole('tab', { name: /^Twos/ })).toHaveAttribute('aria-selected', 'true');
    expect(savedFilters.tasks).toEqual([{ name: 'Twos', query: 'status = open and priority = 2' }]);
    await user.click(screen.getByRole('button', { name: 'Remove the view "Twos"' }));
    await vi.waitFor(() => expect(savedFilters.tasks).toBeUndefined());
    expect(screen.queryByRole('tab', { name: /^Twos/ })).not.toBeInTheDocument();
  });

  test('a signed-in reader\'s own views are "My views"; where nothing may be kept, nothing is offered', async () => {
    savedFilters = { tasks: [{ name: 'Twos', query: 'priority = 2 sort due_on' }] };
    viewStore = 'account';
    draw(`task status = open and priority = 2 ${PLUMBING}`);
    expect(await screen.findByText('My views')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save view…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove the view "Twos"' })).toBeInTheDocument();
    cleanup();
    viewStore = 'none';
    draw(`task status = open and priority = 2 ${PLUMBING}`);
    await screen.findByRole('tab', { name: /^Twos/ });
    expect(screen.queryByRole('button', { name: 'Save view…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove the view/ })).not.toBeInTheDocument();
  });

  test('a view opens by its question, which is the ordinary list address', async () => {
    savedFilters = { tasks: [{ name: 'Twos', query: 'priority = 2 sort due_on' }] };
    const user = userEvent.setup();
    const { navigate } = draw(`task ${PLUMBING}`);
    await user.click(await screen.findByRole('tab', { name: /^Twos/ }));
    expect(navigate).toHaveBeenCalledWith(`task priority = 2 sort due_on ${PLUMBING}`);
  });

  test('a Save view… with no name writes nothing', async () => {
    const user = userEvent.setup();
    promptAnswer = null;
    draw(`task status = open and priority = 2 ${PLUMBING}`);
    await user.click(await screen.findByRole('button', { name: 'Save view…' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.filter((c) => c.path === '/api/filters/save')).toHaveLength(0);
  });

  test('a signed-out visitor is not asked for saved views, and is offered no Save view…', async () => {
    setPublicVisitor(true);
    try {
      draw(`task status = open and priority = 2 ${PLUMBING}`);
      await vi.waitFor(() => expect(calls.some((c) => c.path === '/api/run' || c.path === '/api/counts')).toBe(true));
      await new Promise((r) => setTimeout(r, 20));
      expect(calls.some((c) => c.path.startsWith('/api/filters'))).toBe(false);
      expect(screen.queryByRole('button', { name: 'Save view…' })).not.toBeInTheDocument();
    } finally {
      setPublicVisitor(false);
    }
  });
});

describe('the bar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('"+ Status" opens its checklist; ticks edit a draft, and Show applies it', async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task ${PLUMBING}`);
    await user.click(screen.getByRole('button', { name: 'Filter by Status' }));
    const picker = await screen.findByRole('dialog', { name: 'Filter by Status' });
    // The focus is on its first choice, where a reader starts.
    await vi.waitFor(() => expect(within(picker).getByRole('checkbox', { name: /^Open/ })).toHaveFocus());
    await user.click(within(picker).getByRole('checkbox', { name: /^Done/ }));
    await user.click(within(picker).getByRole('checkbox', { name: /^Open/ }));
    expect(navigate).not.toHaveBeenCalled();
    await user.click(within(picker).getByRole('button', { name: /^Show/ }));
    // The rail's own tail, so a chip, an address and a saved view read it as ever.
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(`task status in (open, done) ${PLUMBING}`);
  });

  test("where the lit tab says the column, its picker starts blank and a tick replaces the tab's condition", async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task status = open ${PLUMBING}`);
    await user.click(screen.getByRole('button', { name: 'Filter by Status' }));
    const picker = await screen.findByRole('dialog', { name: 'Filter by Status' });
    expect(
      within(picker)
        .getAllByRole('checkbox')
        .filter((box) => (box as HTMLInputElement).checked),
    ).toHaveLength(0);
    await user.click(within(picker).getByRole('checkbox', { name: /^Done/ }));
    await user.click(within(picker).getByRole('button', { name: /^Show/ }));
    expect(navigate).toHaveBeenCalledWith(`task status = done ${PLUMBING}`);
  });

  test('a chip opens its picker with its values ticked; Escape gives the focus back, and Backspace removes it', async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task status in (open, done) ${PLUMBING}`);
    const chip = screen.getByRole('button', { name: 'Status is Open or Done' });
    await user.click(chip);
    const picker = await screen.findByRole('dialog', { name: 'Filter by Status' });
    expect(within(picker).getByRole('checkbox', { name: /^Open/ })).toBeChecked();
    expect(within(picker).getByRole('checkbox', { name: /^Done/ })).toBeChecked();
    await user.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    await vi.waitFor(() => expect(chip).toHaveFocus());
    await user.keyboard('{Backspace}');
    expect(navigate).toHaveBeenCalledWith(`task ${PLUMBING}`);
  });

  test("two applied filters earn one Clear all, which leaves the lit tab's own conditions", async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task status = open and priority = 2 and title contains fix ${PLUMBING}`);
    // The search says its own words in its box, not in a chip.
    expect(screen.getByRole('searchbox', { name: 'Filter by Title' })).toHaveValue('fix');
    expect(screen.queryByText(/^Title:/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    expect(navigate).toHaveBeenCalledWith(`task status = open ${PLUMBING}`);
    cleanup();
    draw(`task status = open and priority = 2 ${PLUMBING}`);
    expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
  });

  test('a flag\'s "+" is one gesture, as its checkbox was', async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task ${PLUMBING}`, { spec: { ...spec, filters: ['status', 'is_urgent'] } });
    await user.click(screen.getByRole('button', { name: 'Only Is urgent' }));
    expect(navigate).toHaveBeenCalledWith(`task is_urgent = true ${PLUMBING}`);
  });

  test('a picker applies on Enter in its box, without a second key', async () => {
    const { navigate } = draw(`task ${PLUMBING}`, { spec: { ...spec, filters: ['status', 'due_on'] } });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Filter by Due on' }));
    const picker = await screen.findByRole('dialog', { name: 'Filter by Due on' });
    const from = within(picker).getByLabelText('From');
    fireEvent.change(from, { target: { value: '2026-09-01' } });
    fireEvent.keyDown(from, { key: 'Enter' });
    expect(navigate).toHaveBeenCalledWith(`task due_on >= 2026-09-01 ${PLUMBING}`);
  });

  test('on a phone one Filters button opens the sheet without the search it keeps in view, and the chips stay in the row', async () => {
    onAPhone();
    const user = userEvent.setup();
    const { navigate } = draw(`task priority = 2 ${PLUMBING}`);
    expect(screen.getByRole('searchbox', { name: 'Filter by Title' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filter by Status' })).not.toBeInTheDocument();
    expect(document.querySelector('.applist-bar-chips')).toHaveTextContent('Priority is 2');
    await user.click(screen.getByRole('button', { name: 'Filters · 1' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(sheet).queryByRole('searchbox')).not.toBeInTheDocument();
    await user.click(within(sheet).getByRole('checkbox', { name: /^Done/ }));
    expect(navigate).not.toHaveBeenCalled();
    await user.click(await within(sheet).findByRole('button', { name: /^Show/ }));
    expect(navigate).toHaveBeenCalledWith(`task priority = 2 and status = done ${PLUMBING}`);
  });
});

describe('the rail', () => {
  const railSpec = { ...spec, presentation: undefined, filterBar: 'rail' as const, filters: ['status', 'priority', 'due_on'] };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("filterBar 'rail' puts the facets beside the rows in place of the bar, and a tick composes like a picker", async () => {
    const user = userEvent.setup();
    const { navigate } = draw(`task status = open sort due_on ${PLUMBING}`, { spec: railSpec });
    expect(document.querySelector('.applist-search, .applist-add')).toBeNull();
    const rail = screen.getByRole('complementary', { name: 'Tasks filters' });
    const status = within(rail).getByRole('group', { name: 'Status' });
    expect(within(status).getByRole('checkbox', { name: /^Open/ })).toBeChecked();
    await user.click(within(status).getByRole('checkbox', { name: /^Done/ }));
    expect(navigate).toHaveBeenCalledWith(`task status in (open, done) sort due_on ${PLUMBING}`);
    // Raw query editing is opt-in, including beside a rail.
    expect(screen.queryByRole('button', { name: 'Advanced' })).not.toBeInTheDocument();
  });

  test('beside the rail, the chips and one Clear all head the results with the Sort; the heading and the rail carry none', async () => {
    const user = userEvent.setup();
    const sorted = { ...railSpec, sorts: [{ label: 'Due soonest', sort: 'due_on' }] };
    const { navigate } = draw(`task priority = 2 sort due_on ${PLUMBING}`, { spec: sorted });
    const applied = screen.getByRole('group', { name: 'Tasks filters applied' });
    expect(within(applied).getByText('Priority is 2')).toBeInTheDocument();
    expect(document.querySelector('.applist-head .applist-chips')).toBeNull();
    expect(document.querySelector('.applist-results-head .applist-sort')).not.toBeNull();
    expect(document.querySelector('.applist-filterbar .applist-sort')).toBeNull();
    const rail = screen.getByRole('complementary', { name: 'Tasks filters' });
    expect(within(rail).queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
    // And no second clearing word in the tab row: beside a rail, Clear all is the one.
    expect(screen.getAllByRole('button', { name: 'Clear all' })).toHaveLength(1);
    await user.click(within(applied).getByRole('button', { name: 'Clear all' }));
    // The rail's conditions out; the sort stands. (A lit tab's own conditions standing is the rail's own test.)
    expect(navigate).toHaveBeenCalledWith(`task sort due_on ${PLUMBING}`);
  });

  test('on a phone the rail is a Filters sheet: ticks edit a draft, and Show applies it', async () => {
    onAPhone();
    const user = userEvent.setup();
    const { navigate } = draw(`task status = open ${PLUMBING}`, { spec: railSpec });
    expect(screen.queryByRole('complementary', { name: 'Tasks filters' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    const sheet = await screen.findByRole('dialog', { name: 'Filters' });
    await user.click(within(sheet).getByRole('checkbox', { name: /^Done/ }));
    expect(navigate).not.toHaveBeenCalled();
    await user.click(await within(sheet).findByRole('button', { name: 'Show 40' }));
    expect(navigate).toHaveBeenCalledWith(`task status in (open, done) ${PLUMBING}`);
  });
});

test('a list narrowed past its tab to nothing says No matches, and Clear keeps the tab and the order', () => {
  const { navigate } = draw('task status = open and priority = 2 and title contains zzzz sort title');
  expect(screen.getByText('No matches')).toBeVisible();
  // What narrowed it, in words: the tab's own condition is not among them.
  expect(document.querySelector('.list-no-matches')).toHaveTextContent('No tasks match Priority is 2 and Title contains “zzzz”.');
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(navigate).toHaveBeenCalledWith(`task status = open sort title ${PLUMBING}`);
  cleanup();
  // The tab's own condition is not a narrowing: nothing to clear.
  draw('task status = open');
  expect(screen.queryByText('No matches')).toBeNull();
});

test('a tab that carries its own order, with nothing under it, says the tab is empty, not that a search missed', () => {
  const sortedTabs = { ...spec, tabs: [{ label: 'All' }, { label: 'Open', query: 'status = open sort title' }] };
  draw('task status = open sort title', { spec: sortedTabs });
  expect(screen.queryByText('No matches')).toBeNull();
  expect(screen.getByText('No tasks in Open right now.')).toBeVisible();
  cleanup();
  // Narrowed past that tab, only what narrowed it is named, and Clear keeps the tab and its order.
  const { navigate } = draw('task status = open and priority = 2 sort title', { spec: sortedTabs });
  expect(document.querySelector('.list-no-matches')).toHaveTextContent('No tasks match Priority is 2.');
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(navigate).toHaveBeenCalledWith(`task status = open sort title ${PLUMBING}`);
});

test('authored empty guidance survives sorting but yields to a filter or embedded list', () => {
  const emptySpec = { ...spec, empty: { title: 'No tasks yet', description: 'Start with your first task.' } };
  draw('task sort title', { spec: emptySpec });
  expect(screen.getByText('No tasks yet')).toBeVisible();
  cleanup();
  draw('task status = open', { spec: emptySpec });
  expect(screen.queryByText('No tasks yet')).toBeNull();
  cleanup();
  draw('task', { spec: emptySpec, embedded: true });
  expect(screen.queryByText('No tasks yet')).toBeNull();
});

test('a list that says no empty state of its own says what belongs in it, and offers New where the room does', () => {
  draw('task sort title');
  expect(screen.getByText('No tasks yet.')).toBeVisible();
  expect(screen.queryByText(/Use New/)).toBeNull();
  cleanup();
  draw('task', { newButton: <button type="button">New task</button> });
  expect(screen.getByText('Use New to add the first task.')).toBeVisible();
  cleanup();
  // A narrowed list says it matched nothing instead; an embedded one says nothing.
  draw('task status = open');
  expect(screen.queryByText('No tasks yet.')).toBeNull();
  cleanup();
  draw('task', { embedded: true });
  expect(screen.queryByText('No tasks yet.')).toBeNull();
});
