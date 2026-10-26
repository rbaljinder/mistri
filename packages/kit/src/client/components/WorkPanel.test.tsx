/** @vitest-environment happy-dom */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';

const go = vi.fn();
let pinned: Array<{ id: string; name: string; base: string }> = [];
let visits: Array<Record<string, unknown>> = [];
let saved: Array<{ name: string; table: string; query: string }> = [];

vi.mock('../core.js', () => ({
  go,
  pageView: (pageId: string, table?: string, key?: unknown, label?: string) => ({ kind: 'page', pageId, table, key, label }),
  tableView: (table: string, query?: string) => ({ kind: 'table', table, query }),
}));
vi.mock('../pagemarks.js', () => ({ pinnedPages: () => pinned, recentVisits: () => visits }));
vi.mock('../views.js', () => ({ allSavedFilters: () => saved }));

const { WorkPanel } = await import('./WorkPanel.js');

const pages = [
  { id: 'config-customer', name: 'Customer desk', base: 'customer', source: 'config' },
  { id: 'saved:invoice:1', name: 'Invoice review', base: 'invoice', source: 'saved' },
  { id: 'suggested:product', name: 'Product', base: 'product', source: 'suggested' },
];

afterEach(() => {
  cleanup();
  go.mockReset();
  pinned = [];
  visits = [];
  saved = [];
});

test('nothing to resume is no card at all', () => {
  const { container } = render(createElement(WorkPanel, { pages: [] }));
  expect(container).toBeEmptyDOMElement();
});

test('pinned, where you were, saved filters and every page, each a door', async () => {
  const user = userEvent.setup();
  pinned = [{ id: 'config-customer', name: 'Customer desk', base: 'customer' }];
  visits = [
    { pageId: 'saved:invoice:1', name: 'Invoice review', base: 'invoice', key: { id: 7 }, label: 'INV-7' },
    { pageId: 'x', name: 'Unnamed', base: 'invoice', key: { id: 8 } }, // no label: not a position worth listing
  ];
  saved = [{ name: 'Overdue', table: 'invoice', query: 'invoice due_on < today' }];
  render(createElement(WorkPanel, { pages }));
  expect(screen.getByRole('heading', { name: 'Your work' })).toBeInTheDocument();
  expect([...document.querySelectorAll('.shape-label')].map((l) => l.textContent)).toEqual([
    'Pinned',
    'Where you were',
    'Saved filters',
    'All pages (3)',
  ]);
  expect(document.querySelectorAll('.landing-rows .landing-link')).toHaveLength(1);

  await user.click(screen.getByTitle('A page about one customer'));
  expect(go).toHaveBeenLastCalledWith(
    { kind: 'page', pageId: 'config-customer', table: 'customer', key: undefined, label: undefined },
    'reset',
  );
  await user.click(screen.getByTitle('Invoice review — INV-7'));
  expect(go).toHaveBeenLastCalledWith(
    { kind: 'page', pageId: 'saved:invoice:1', table: 'invoice', key: { id: 7 }, label: 'INV-7' },
    'reset',
  );
  await user.click(screen.getByTitle('invoice due_on < today'));
  expect(go).toHaveBeenLastCalledWith({ kind: 'table', table: 'invoice', query: 'invoice due_on < today' }, 'reset');

  const sources = [...document.querySelectorAll('.landing-page-source')].map((s) => s.textContent);
  expect(sources).toEqual(['config', 'yours', 'suggested']);
  await user.type(screen.getByLabelText('Filter pages'), 'inv');
  expect(document.querySelectorAll('.landing-page')).toHaveLength(1);
  await user.clear(screen.getByLabelText('Filter pages'));
  await user.type(screen.getByLabelText('Filter pages'), 'zzz');
  expect(screen.getByText('No page of that name.')).toBeInTheDocument();
});
