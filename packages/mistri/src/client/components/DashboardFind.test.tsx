/**
 * A dashboard's find box, against an engine that answers as recordSearch.ts
 * does: one question per typed pause, the hits grouped by resource, the
 * arrows walking them across the groups and Enter opening the lit one, and
 * a box that says when nothing matches.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

const asked: Array<{ table: string; term: string; line?: string }> = [];
const opened = vi.fn();
const findable = (id: string, label: string) => ({ table: { id, name: id, columns: [] }, label: 'name', room: { label } });
const records: Record<string, Array<{ label: string; line?: string }>> = {
  article: [{ label: 'Reset your laptop password', line: 'Accounts' }, { label: 'Laptop docking guide' }],
  catalog_item: [{ label: 'Standard laptop', line: 'A 14-inch business laptop with a dock and a bag.' }],
};

vi.mock('../appState.js', () => ({ activeApp: () => ({ views: {} }) }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/components/recordSearch.js', () => ({
  findableTables: (_app: unknown, tables: string[]) => tables.map((id) => findable(id, id === 'article' ? 'Help articles' : 'Catalog')),
  lineOf: (each: { table: { id: string } }) => (each.table.id === 'article' ? 'topic' : 'summary'),
  findRecords: async (each: { table: { id: string } }, term: string, _limit: number, line?: string) => {
    asked.push({ table: each.table.id, term, line });
    return term.includes('laptop')
      ? (records[each.table.id] ?? []).map((record, i) => ({
          ...record,
          key: { id: i + 1 },
          open: () => opened(each.table.id, record.label),
        }))
      : [];
  },
}));

const { FindSection } = await import('./DashboardFind.js');
const draw = () =>
  render(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      <FindSection
        section={{
          kind: 'find',
          title: 'Find anything',
          placeholder: 'Search help and the catalog',
          searched: ['article', 'catalog_item'],
        }}
      />,
    ),
  );

beforeEach(() => {
  asked.length = 0;
  opened.mockReset();
});
afterEach(() => cleanup());

test('a typed pause asks each resource once, and the hits stand under their resource, each its name and its line', async () => {
  draw();
  const box = screen.getByRole('combobox', { name: 'Find anything' });
  expect(box).toHaveAttribute('placeholder', 'Search help and the catalog');
  await userEvent.type(box, 'laptop');
  const options = await screen.findAllByRole('option');
  // One word typed is one question per resource, not one per letter; each asks for its list's line.
  expect(asked).toEqual([
    { table: 'article', term: 'laptop', line: 'topic' },
    { table: 'catalog_item', term: 'laptop', line: 'summary' },
  ]);
  expect(
    screen
      .getAllByRole('group')
      .map(
        (group) => group.getAttribute('aria-labelledby') && document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent,
      ),
  ).toEqual(['Help articles', 'Catalog']);
  expect(options.map((option) => option.textContent)).toEqual([
    'Reset your laptop passwordAccounts',
    'Laptop docking guide',
    'Standard laptopA 14-inch business laptop with a dock and a bag.',
  ]);
  expect(box).toHaveAttribute('aria-expanded', 'true');
});

test('the arrows walk the hits across the groups, and Enter opens the lit one', async () => {
  draw();
  const box = screen.getByRole('combobox', { name: 'Find anything' });
  await userEvent.type(box, 'laptop');
  await screen.findAllByRole('option');
  expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  const lit = screen.getAllByRole('option')[2];
  expect(lit).toHaveAttribute('aria-selected', 'true');
  expect(box).toHaveAttribute('aria-activedescendant', lit.id);
  await userEvent.keyboard('{Enter}');
  expect(opened).toHaveBeenCalledWith('catalog_item', 'Standard laptop');
  // Down from the last wraps to the first, and up from the first to the last.
  await userEvent.keyboard('{ArrowDown}');
  expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
  await userEvent.keyboard('{ArrowUp}');
  expect(screen.getAllByRole('option')[2]).toHaveAttribute('aria-selected', 'true');
});

test('nothing matching says so, and one letter asks nothing', async () => {
  draw();
  const box = screen.getByRole('combobox', { name: 'Find anything' });
  await userEvent.type(box, 'm');
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(asked).toEqual([]);
  await userEvent.type(box, 'onitor');
  expect(await screen.findByText('Nothing matches “monitor”.')).toBeInTheDocument();
  expect(screen.queryAllByRole('option')).toHaveLength(0);
  await waitFor(() => expect(asked.every((each) => each.term === 'monitor')).toBe(true));
});
