/**
 * A page's related list, a page at a time: the reader's rows-per-list
 * preference sizes the page unless the section names its own limit, the
 * pager says the range and the total, steps by that size in both directions,
 * and stands disabled at either end; a list with one page draws no pager.
 * Whether an empty list is left out or said in a line is the page's to decide
 * (PageEmptyRun.tsx), so the list itself always says its own emptiness.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { installShell } from '../shellMode.js';

const note: TableMeta = {
  id: 'note',
  name: 'note',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'body', type: 'TEXT', nullable: true, primaryKey: false },
  ],
};
const mocks = vi.hoisted(() => ({ total: 5, reads: [] as Array<Record<string, unknown>>, perList: 2, groups: [] as number[] }));
vi.mock('../core.js', () => ({
  api: async (path: string, body: { view: { limit: number }; offset?: number }) => {
    mocks.reads.push({ path, ...body });
    if (path === '/api/breakdown')
      return {
        columns: ['note_id', 'group_rows'],
        rows: mocks.groups.map((id) => ({ note_id: id, group_rows: 3 })),
        total: mocks.groups.length,
      };
    const offset = body.offset ?? 0;
    const ids = Array.from({ length: mocks.total }, (_, i) => i + 1).slice(offset, offset + body.view.limit);
    return {
      view: {},
      columns: ['id', 'body'],
      rows: ids.map((id) => ({ id, body: `note ${id}` })),
      more: offset + body.view.limit < mocks.total,
      total: mocks.total,
    };
  },
  findTable: (id: string) => (id === 'note' ? note : undefined),
  columnDisplay: () => null,
  columnLabel: () => null,
  labelPath: () => undefined,
  recordLabel: () => undefined,
  openRecord: () => {},
  rowLabel: (_t: unknown, row: Record<string, unknown>) => `#${row.id}`,
  state: { activeConnection: 'demo', schema: { tables: [note], foreignKeys: [] } },
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => null, inAppMode: () => false }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../prefs.js', () => ({ relatedRows: () => mocks.perList }));
vi.mock('../insert.js', () => ({ canInsert: () => false, openRelatedRecord: () => {} }));
vi.mock('../../../../engine/src/shared/referenceModel.js', () => ({
  recordView: (_schema: unknown, _table: unknown, view: unknown) => ({
    view,
    labelColumns: {},
    hidden: [],
    keyColumns: [{ column: 'id' }],
    labelColumn: undefined,
  }),
  recordViewKey: (_keys: unknown, _columns: unknown, row: Record<string, unknown>) => ({ id: row.id }),
  recordViewLabel: () => ({}),
  withoutParentName: (rows: unknown) => rows,
}));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span>{String(value)}</span> }));
vi.mock('./columnPresentation.js', () => ({ presentationColumns: () => new Map() }));
vi.mock('./valueModel.js', () => ({ groupLabel: (_rule: unknown, value: unknown) => String(value) }));
vi.mock('./dashboardModel.js', () => ({ namedGroups: (_answer: unknown, _key: unknown, say: (key: unknown) => string) => say }));
vi.mock('./PageSectionBox.js', () => ({
  SectionBox: ({ body, broken }: { body: React.ReactNode; broken?: string }) => <section>{broken ?? body}</section>,
  Loading: () => <p>Loading</p>,
}));
vi.mock('./Grid.js', () => ({
  Grid: ({ data, emptyText }: { data: { rows: Array<Record<string, unknown>> }; emptyText: string }) => (
    <ul aria-label="rows">
      {data.rows.length ? data.rows.map((row) => <li key={String(row.id)}>{String(row.body)}</li>) : <li>{emptyText}</li>}
    </ul>
  ),
}));

const { ListSection } = await import('./PageRelated.js');

function draw(section: Record<string, unknown> = {}) {
  // The server plans a section's own limit into its view; only a view without one takes the preference.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    section: { kind: 'list', from: 'note', title: 'Notes', ...section },
    plan: { view: { from: 'note', columns: [{ path: 'id' }, { path: 'body' }], limit: (section.limit as number | undefined) ?? 99 } },
    base: note,
    recordKey: { id: 1 },
  } as unknown as Parameters<typeof ListSection>[0];
  render(
    <QueryClientProvider client={client}>
      <ListSection {...props} />
    </QueryClientProvider>,
  );
}
const shown = () => screen.getAllByRole('listitem').map((item) => item.textContent);
const range = () => document.querySelector('.page-range')?.textContent;
const next = () => screen.getByRole('button', { name: 'More rows' });
const previous = () => screen.getByRole('button', { name: 'Previous rows' });

beforeEach(() => {
  mocks.total = 5;
  mocks.reads = [];
  mocks.perList = 2;
  mocks.groups = [];
});
afterEach(cleanup);

test('pages by the reader’s rows-per-list, forward to the last page and back to the first', async () => {
  draw();
  await waitFor(() => expect(shown()).toEqual(['note 1', 'note 2']));
  // The preference replaces the view's own limit when the section names none.
  expect(mocks.reads[0]).toMatchObject({ view: { limit: 2 }, offset: 0 });
  expect(range()).toBe('1–2 of 5');
  expect(previous()).toBeDisabled();

  await userEvent.click(next());
  await waitFor(() => expect(shown()).toEqual(['note 3', 'note 4']));
  expect(range()).toBe('3–4 of 5');
  expect(previous()).toBeEnabled();

  await userEvent.click(next());
  await waitFor(() => expect(shown()).toEqual(['note 5']));
  expect(range()).toBe('5–5 of 5');
  expect(next()).toBeDisabled();

  await userEvent.click(previous());
  await waitFor(() => expect(shown()).toEqual(['note 3', 'note 4']));
  expect(mocks.reads.map((read) => read.offset)).toEqual([0, 2, 4, 2]);
});

test('a section’s own limit sizes the page and its steps, over the preference', async () => {
  draw({ limit: 3 });
  await waitFor(() => expect(shown()).toEqual(['note 1', 'note 2', 'note 3']));
  expect(range()).toBe('1–3 of 5');
  await userEvent.click(next());
  await waitFor(() => expect(shown()).toEqual(['note 4', 'note 5']));
  expect(mocks.reads.map((read) => read.offset)).toEqual([0, 3]);
});

test('a list that fits one page draws no pager', async () => {
  mocks.total = 2;
  draw();
  await waitFor(() => expect(shown()).toEqual(['note 1', 'note 2']));
  expect(document.querySelector('.page-pager')).toBeNull();
});

test('an empty list says so, and drawn collapsed it leaves only its Add to the page', async () => {
  mocks.total = 0;
  draw();
  await waitFor(() => expect(shown()).toEqual(['No note for this record.']));
  cleanup();

  draw({ emptyMode: 'hide' });
  await waitFor(() => expect(shown()).toEqual(['No note for this record.']));
});

test('a grouped list asks its groups and then the rows of each, never a flat first page, and its limit is the rows to a group', async () => {
  mocks.groups = [8, 9];
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    section: { kind: 'list', from: 'note', title: 'Notes', group: { by: 'note_id' } },
    plan: {
      view: { from: 'note', columns: [{ path: 'id' }, { path: 'body' }], limit: 99 },
      groups: { base: 'note', by: [{ path: 'note_id' }], measures: [{ fn: 'count', alias: 'group_rows' }], limit: 5 },
    },
    base: note,
    recordKey: { id: 1 },
  } as unknown as Parameters<typeof ListSection>[0];
  render(
    <QueryClientProvider client={client}>
      <ListSection {...props} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getAllByRole('group')).toHaveLength(2));
  await waitFor(() => expect(shown().length).toBeGreaterThan(0));
  const paths = mocks.reads.map((read) => read.path);
  expect(paths[0]).toBe('/api/breakdown');
  expect(paths.filter((path) => path === '/api/view/run')).toHaveLength(2);
  // Three rows a group by default (the groups say 3 each, the page the section's own limit or five): one read each.
  expect(mocks.reads.filter((read) => read.path === '/api/view/run').map((read) => (read.view as { limit: number }).limit)).toEqual([5, 5]);
});

test('a grouped list with no groups says its own guidance, as a flat one with no rows does', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    section: { kind: 'list', from: 'note', title: 'Notes', group: { by: 'note_id' } },
    plan: {
      view: { from: 'note', columns: [{ path: 'id' }], limit: 99 },
      groups: { base: 'note', by: [{ path: 'note_id' }], measures: [{ fn: 'count', alias: 'group_rows' }], limit: 5 },
    },
    base: note,
    recordKey: { id: 1 },
  } as unknown as Parameters<typeof ListSection>[0];
  render(
    <QueryClientProvider client={client}>
      <ListSection {...props} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(mocks.reads).toHaveLength(1));
  expect(mocks.reads[0].path).toBe('/api/breakdown');
  expect(document.querySelector('.page-groups')).toBeNull();
});

test("an embedded view's board is drawn by the App's presenter, held to the record, and a list without one stays a table", async () => {
  const board = { kind: 'board', by: 'body', primary: 'body' };
  const present = vi.fn(() => ({ whole: false, pages: false, element: <p>the board</p> }));
  await bridgeShell();
  installShell({ inApp: () => true, present: present as never });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    section: { kind: 'list', from: 'note', title: 'Notes', path: 'project_id', filter: 'done = false', lanes: board },
    plan: { view: { from: 'note', columns: [{ path: 'id' }, { path: 'body' }], limit: 99 } },
    base: note,
    recordKey: { id: 12 },
  } as unknown as Parameters<typeof ListSection>[0];
  render(
    <QueryClientProvider client={client}>
      <ListSection {...props} />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('the board')).toBeInTheDocument();
  const [asked] = present.mock.calls[0] as unknown as [{ presentation: unknown; entry: { query: string } }];
  expect(asked.presentation).toEqual(board);
  // The record's condition is said in the query language, after the view's own, for the lanes to read.
  expect(asked.entry.query).toBe('done = false and project_id = 12');
  // A board draws its lanes whole: the table's pager is not under it.
  expect(document.querySelector('.page-pager')).toBeNull();
  installShell({ inApp: () => false, present: null });
});
