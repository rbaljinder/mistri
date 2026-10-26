/**
 * The palette: ranked as you type, moved with the arrows, chosen with
 * Enter, and record hits from the app's own tables a beat later.
 */
import { afterEach, expect, test, vi, beforeEach } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const site: TableMeta = {
  id: 'site',
  name: 'site',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')] as TableMeta['columns'],
};
const ran: string[] = [];
const opened: unknown[] = [];
const calls: string[] = [];
let appMode = false;
const northYard = () => ({ rows: [{ id: 7, name: 'North yard' }] });
let reply: (q: string) => unknown = northYard;
vi.mock('../core.js', () => ({
  state: { schema: { tables: [site] } },
  api: async (_p: string, body: { q: string }) => {
    calls.push(body.q);
    return reply(body.q);
  },
  findTable: (id: string) => (id === 'site' ? site : undefined),
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
    views: { sites: { table: 'site', label: 'Sites' } },
    nav: [{ view: 'sites', label: 'Sites' }],
    resources: {},
    ui: {},
  }),
}));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../menu.js', () => ({ whenMenuChanges: () => () => {} }));
vi.mock('../palette.js', () => {
  const item = (kind: string, label: string, search = label) => ({ kind, label, search, detail: null, run: () => ran.push(label) });
  return {
    entries: () => [
      item('table', 'purchase_order_line'),
      item('table', 'site'),
      item('table', 'site_visit_note'),
      item('filter', 'Open orders', 'Open orders purchase_order status = open'),
    ],
  };
});

const { Palette } = await import('./Palette.js');

afterEach(() => {
  cleanup();
  ran.length = 0;
  opened.length = 0;
  calls.length = 0;
  appMode = false;
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
  expect(hit.closest('[role="option"]')!.querySelector('.palette-kind')).toHaveClass('kind-record');
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
