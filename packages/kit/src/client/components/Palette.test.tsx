/**
 * The palette: ranked as you type, moved with the arrows, chosen with
 * Enter, and record hits from the app's own tables a beat later.
 */
import { afterEach, expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { checkPatterns } from '@mistriwork/ui/conformance.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const site: TableMeta = {
  id: 'site',
  name: 'site',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')] as TableMeta['columns'],
};
/** Further lists of further tables (`room1`…), each with a table of its own, for the tests of a long menu. */
let extraLists = 0;
const extraTable = (n: number): TableMeta => ({ ...site, id: `t${n}`, name: `t${n}` });
const tableById = (id: string): TableMeta | undefined =>
  id === 'site' ? site : /^t\d+$/.test(id) && Number(id.slice(1)) <= extraLists ? extraTable(Number(id.slice(1))) : undefined;
const ran: string[] = [];
const opened: unknown[] = [];
const calls: string[] = [];
let appMode = false;
/** More pages than the first screen holds, for the test of what an empty box shows. */
let morePages: object[] = [];
const northYard = () => ({ rows: [{ id: 7, name: 'North yard' }] });
let reply: (q: string) => unknown = northYard;
vi.mock('../core.js', () => ({
  state: { schema: { tables: [site] } },
  api: async (_p: string, body: { q: string }) => {
    calls.push(body.q);
    return reply(body.q);
  },
  findTable: (id: string) => tableById(id),
  labelPath: () => 'name',
  rowLabel: (_table: TableMeta, row: Record<string, unknown>) => String(row.name ?? row.id),
  primaryKey: () => ['id'],
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => ({ id: row.id }),
  openRecord: (...a: unknown[]) => opened.push(a),
  quote: (v: string) => JSON.stringify(v),
}));
vi.mock('../../../../mistri/src/client/appState.js', () => ({
  inAppMode: () => appMode,
  activeApp: () => ({
    views: {
      sites: { table: 'site', label: 'Sites' },
      ...Object.fromEntries(Array.from({ length: extraLists }, (_, i) => [`list${i + 1}`, { table: `t${i + 1}`, label: `List ${i + 1}` }])),
    },
    nav: [
      { view: 'sites', label: 'Sites' },
      ...Array.from({ length: extraLists }, (_, i) => ({ view: `list${i + 1}`, label: `List ${i + 1}` })),
    ],
    resources: {},
    ui: {},
  }),
}));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../menu.js', () => ({ whenMenuChanges: () => () => {} }));
/* The rows below say their own Create lines; the App's lists offer none of their own here (newMenuModel.test.ts says those). */
vi.mock('../insert.js', () => ({ canInsert: () => false }));
vi.mock('../palette.js', () => {
  const item = (kind: string, label: string, search = label, more: object = {}) => ({
    kind,
    label,
    search,
    detail: null,
    run: () => ran.push(label),
    ...more,
  });
  return {
    entries: () =>
      appMode
        ? [
            item('page', 'Sites', 'Sites Work', { detail: 'Work', icon: 'buildings', room: 'sites' }),
            item('page', 'Visits', 'Visits Work', { detail: 'Work', room: 'visits' }),
            item('create', 'New site', 'New site', { icon: 'receipt' }),
            item('create', 'Log a visit', 'Log a visit New visit'),
            item('action', 'Preferences', 'Preferences appearance', { detail: 'appearance' }),
            ...morePages,
          ]
        : [
            item('table', 'purchase_order_line'),
            item('table', 'site'),
            item('table', 'site_visit_note'),
            item('filter', 'Open orders', 'Open orders purchase_order status = open'),
          ],
  };
});

const { Palette } = await import('./Palette.js');
const { forgetVisits, noteVisit } = await import('../paletteRecents.js');

afterEach(() => {
  cleanup();
  forgetVisits();
  ran.length = 0;
  opened.length = 0;
  calls.length = 0;
  appMode = false;
  morePages = [];
  extraLists = 0;
  reply = northYard;
});

test('is a named modal whose one Tab stop is its box', () => {
  render(<Palette onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Search' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  const input = screen.getByRole('combobox', { name: 'Search' });
  expect(dialog).toContainElement(input);
  // The results move with the arrows; Tab must not leave for the page under the scrim.
  const tab = fireEvent.keyDown(document, { key: 'Tab' });
  expect(tab).toBe(false);
  expect(input).toHaveFocus();
});

test('holds to the dialog and combobox patterns', async () => {
  render(<Palette onClose={vi.fn()} />);
  expect(await checkPatterns(document.body, { act: (step) => act(step) })).toEqual([]);
});

test('ranks the exact name first, moves with the arrows, and Enter goes there', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  render(<Palette onClose={onClose} />);
  const input = screen.getByRole('combobox', { name: 'Search' });
  expect(input).toHaveAttribute('placeholder', 'Go to a table, view, saved filter or database…');
  expect(input).toHaveFocus();
  expect(screen.getAllByRole('option')).toHaveLength(4);
  await user.type(input, 'site');
  const options = screen.getAllByRole('option');
  expect(options.map((o) => o.querySelector('.palette-label')!.textContent)).toEqual(['site', 'site_visit_note']);
  expect(options[0]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(document, { key: 'ArrowDown' });
  expect(screen.getAllByRole('option')[1]).toHaveClass('active');
  expect(input).toHaveAttribute('aria-activedescendant', 'palette-o1');
  fireEvent.keyDown(document, { key: 'Enter' });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(ran).toEqual(['site_visit_note']);
});

test('initials find a snake_case name; nothing matching says so; Escape closes and stops there', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const outer = vi.fn();
  document.addEventListener('keydown', outer);
  render(<Palette onClose={onClose} />);
  await user.type(screen.getByRole('combobox'), 'pol');
  expect(screen.getAllByRole('option')[0]).toHaveTextContent('purchase_order_line');
  await user.clear(screen.getByRole('combobox'));
  await user.type(screen.getByRole('combobox'), 'zzz');
  expect(screen.getByText('Nothing matches "zzz".')).toBeInTheDocument();
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  document.removeEventListener('keydown', outer);
});

test('in an app, rows the term finds ride below the named things and open as records', async () => {
  const user = userEvent.setup();
  appMode = true;
  const onClose = vi.fn();
  render(<Palette onClose={onClose} />);
  expect(screen.getByRole('combobox')).toHaveAttribute('placeholder', 'Search records, pages and commands…');
  await user.type(screen.getByRole('combobox'), 'north');
  const hit = await screen.findByText('North yard');
  expect(screen.getByText('Site · 7')).toBeInTheDocument();
  expect(calls).toEqual(['site name contains "north" show name, id sort name']);
  // A record stands under Records and says its table in its line; the kind is no badge in an App.
  expect(hit.closest('[role="option"]')).toHaveAttribute('data-group', 'records');
  expect(hit.closest('[role="option"]')!.querySelector('.palette-kind')).toBeNull();
  expect(screen.getByRole('group', { name: 'Records' })).toContainElement(hit);
  await user.click(hit);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(opened).toEqual([['site', { id: 7 }, 'North yard']]);
});

test('until the hits answer what is typed, only the rows it names can be lit and entered', async () => {
  /* Record hits arrive a pause and a request after typing. The hits for
     "yard" stayed whole while "yardl" was asked, North yard first and lit,
     so Enter opened a record the box never named. */
  const held = new Map<string, (value: unknown) => void>();
  reply = (q) => {
    const asked = /contains "([^"]*)"/.exec(q)?.[1] ?? '';
    return asked === 'yard'
      ? {
          rows: [
            { id: 7, name: 'North yard' },
            { id: 9, name: 'Yardley dock' },
          ],
        }
      : new Promise((resolve) => {
          held.set(asked, resolve);
        });
  };
  const user = userEvent.setup();
  appMode = true;
  render(<Palette onClose={vi.fn()} />);
  const input = screen.getByRole('combobox');
  await user.type(input, 'yard');
  await screen.findByText('North yard');
  await user.type(input, 'l');
  await vi.waitFor(() => expect(held.has('yardl')).toBe(true));
  const options = screen.getAllByRole('option');
  expect(options.map((o) => o.querySelector('.palette-label')!.textContent)).toEqual(['Yardley dock']);
  expect(options[0]).toHaveAttribute('aria-selected', 'true');
  fireEvent.keyDown(document, { key: 'Enter' });
  expect(opened).toEqual([['site', { id: 9 }, 'Yardley dock']]);
  // Nothing named and nothing answered yet: not "Nothing matches".
  await user.type(input, 'x');
  await vi.waitFor(() => expect(held.has('yardlx')).toBe(true));
  expect(screen.queryAllByRole('option')).toEqual([]);
  expect(screen.queryByText('Nothing matches "yardlx".')).toBeNull();
  await act(async () => {
    held.get('yardlx')!({ rows: [] });
  });
  expect(await screen.findByText('Nothing matches "yardlx".')).toBeInTheDocument();
});

const labels = () => screen.getAllByRole('option').map((o) => o.querySelector('.palette-label')!.textContent);

test('in an app the rows stand in groups, in the order recent, pages, create, commands, records, each under its heading', async () => {
  appMode = true;
  // The walk has taken the reader through Visits and on to Sites.
  noteVisit({ kind: 'table', view: 'visits' });
  noteVisit({ kind: 'table', view: 'sites' });
  render(<Palette onClose={vi.fn()} />);
  const groups = screen.getAllByRole('group');
  expect(groups.map((g) => g.querySelector('.palette-group-head')!.textContent)).toEqual(['Recent', 'Pages', 'Create', 'Commands']);
  // Where they were comes first and is not said again under Pages; where they are is not a recent place at all.
  expect(Array.from(groups[0].querySelectorAll('.palette-label')).map((l) => l.textContent)).toEqual(['Visits']);
  expect(Array.from(groups[1].querySelectorAll('.palette-label')).map((l) => l.textContent)).toEqual(['Sites']);
  expect(labels()).toEqual(['Visits', 'Sites', 'New site', 'Log a visit', 'Preferences']);
  // Each group is named for what reads it; the options sit in the listbox's groups.
  expect(screen.getByRole('listbox')).toContainElement(groups[0]);
  expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
});

test('typing leaves Recent behind and ranks each group within itself', async () => {
  const user = userEvent.setup();
  appMode = true;
  noteVisit({ kind: 'table', view: 'visits' });
  noteVisit({ kind: 'table', view: 'sites' });
  render(<Palette onClose={vi.fn()} />);
  await user.type(screen.getByRole('combobox'), 'visit');
  expect(screen.getAllByRole('group').map((g) => g.querySelector('.palette-group-head')!.textContent)).toEqual(['Pages', 'Create']);
  expect(labels()).toEqual(['Visits', 'Log a visit']);
});

test('a row says what it opens in its line, its mark comes from its room, and a record read is a recent one', async () => {
  appMode = true;
  noteVisit({ kind: 'row', table: 'site', key: { id: 7 }, label: 'North yard' });
  noteVisit({ kind: 'table', view: 'sites' });
  const user = userEvent.setup();
  render(<Palette onClose={vi.fn()} />);
  const rows = screen.getAllByRole('option');
  const detail = (row: HTMLElement) => row.querySelector('.palette-detail')?.textContent;
  // The recent record says its table, as a record hit does; a page its kind and the group it is under; a create its kind.
  expect(rows.map(detail)).toEqual(['Site · 7', 'Page · Work', 'Page · Work', 'Create', 'Create', 'Action · appearance']);
  // Each is named by its name, its line a description after it, never run into the name.
  expect(rows[1]).toHaveAccessibleName(rows[1].querySelector('.palette-label')!.textContent!);
  expect(rows[1]).toHaveAccessibleDescription('Page · Work');
  // A mark where the room has one, and a space kept where it has none, so the names line up.
  expect(rows.map((row) => row.querySelector('.palette-icon svg') !== null)).toEqual([false, true, false, true, false, false]);
  expect(rows.map((row) => row.querySelectorAll('.palette-icon').length)).toEqual([1, 1, 1, 1, 1, 1]);
  await user.click(rows[0]);
  expect(opened).toEqual([['site', { id: 7 }, 'North yard']]);
});

test('the keys it answers to are in a footer in an App and the Workbench keeps its flat list', () => {
  appMode = true;
  const { unmount } = render(<Palette onClose={vi.fn()} />);
  expect(document.querySelector('.palette-foot')).toHaveTextContent('↑↓ move↵ openesc close');
  expect(document.querySelector('.palette-grouped')).not.toBeNull();
  unmount();
  appMode = false;
  render(<Palette onClose={vi.fn()} />);
  expect(document.querySelector('.palette-foot')).toBeNull();
  expect(document.querySelector('.palette-group')).toBeNull();
  expect(document.querySelector('.palette-grouped')).toBeNull();
  expect(screen.getAllByRole('option')[0].querySelector('.palette-kind')).toHaveTextContent('table');
});

test('a menu that fits the shortlist is shown whole before anything is typed', () => {
  appMode = true;
  morePages = Array.from({ length: 6 }, (_, i) => ({
    kind: 'page',
    label: `Room ${i + 1}`,
    search: `Room ${i + 1}`,
    detail: null,
    room: `room${i + 1}`,
    run: () => ran.push(`Room ${i + 1}`),
  }));
  render(<Palette onClose={vi.fn()} />);
  // Eight pages, every one: cut to five, an App's last lists were found only by typing.
  expect(screen.getByRole('group', { name: 'Pages' }).querySelectorAll('[role="option"]')).toHaveLength(8);
  expect(screen.getByRole('group', { name: 'Create' })).toBeInTheDocument();
});

test("before anything is typed a long menu's pages are a first handful, so Create is on the first screen; typing finds the rest", async () => {
  appMode = true;
  morePages = Array.from({ length: 7 }, (_, i) => ({
    kind: 'page',
    label: `Room ${i + 1}`,
    search: `Room ${i + 1}`,
    detail: null,
    room: `room${i + 1}`,
    run: () => ran.push(`Room ${i + 1}`),
  }));
  const user = userEvent.setup();
  render(<Palette onClose={vi.fn()} />);
  const pagesGroup = () => screen.getByRole('group', { name: 'Pages' });
  expect(pagesGroup().querySelectorAll('[role="option"]')).toHaveLength(5);
  expect(screen.getByRole('group', { name: 'Create' })).toBeInTheDocument();
  await user.type(screen.getByRole('combobox'), 'room');
  expect(pagesGroup().querySelectorAll('[role="option"]')).toHaveLength(7);
});

test('the term is searched in every list the menu holds, not the first six, a few at a time', async () => {
  const user = userEvent.setup();
  appMode = true;
  // Eight lists in all: the first six used to be the only ones asked.
  extraLists = 7;
  let flying = 0;
  let most = 0;
  reply = async (q) => {
    flying += 1;
    most = Math.max(most, flying);
    await new Promise((resolve) => setTimeout(resolve, 5));
    flying -= 1;
    const table = q.split(' ')[0];
    return { rows: [{ id: 1, name: `Yard of ${table}` }] };
  };
  render(<Palette onClose={vi.fn()} />);
  await user.type(screen.getByRole('combobox'), 'yard');
  await vi.waitFor(() => expect(calls.filter((q) => q.includes('contains "yard"'))).toHaveLength(8));
  expect(calls.filter((q) => q.includes('contains "yard"')).map((q) => q.split(' ')[0])).toEqual(
    expect.arrayContaining(['site', 't1', 't2', 't3', 't4', 't5', 't6', 't7']),
  );
  expect(most).toBeLessThanOrEqual(6);
  // The nine it shows are one from each table before a second from any, so the last lists are not crowded out.
  await screen.findByText('Yard of t7');
  expect(screen.queryByRole('note')).toBeNull();
});

test('a menu with more lists than one search asks says how many are searched', async () => {
  const user = userEvent.setup();
  appMode = true;
  extraLists = 29;
  render(<Palette onClose={vi.fn()} />);
  expect(screen.getByRole('note')).toHaveTextContent('Records are searched in 24 of 30 lists.');
  await user.type(screen.getByRole('combobox'), 'yard');
  await vi.waitFor(() => expect(calls.filter((q) => q.includes('contains "yard"'))).toHaveLength(24));
});
