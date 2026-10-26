/**
 * The saved-filter bar: tabs that are links, a Save offered only when there
 * is a filter worth saving, and every active clause with a way off.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';

const gone: unknown[] = [];
vi.mock('../core.js', () => ({
  go: (e: unknown, mode: string) => gone.push([e, mode]),
  tableView: (table: string, query?: string) => ({ kind: 'table', table, query: query ?? table }),
}));

const { SavedViewsBar } = await import('./SavedViews.js');

const views = [
  { id: '1', name: 'Open', query: 'invoice status = open' },
  { id: '2', name: 'Big', query: 'invoice total > 500' },
];

function draw(query: string, over: Partial<Parameters<typeof SavedViewsBar>[0]> = {}) {
  const host = document.createElement('div');
  host.className = 'views';
  document.body.append(host);
  const props = { entry: { table: 'invoice', query }, views, onSave: vi.fn(), onRename: vi.fn(), onRemove: vi.fn(), ...over };
  render(createElement(SavedViewsBar, props), { container: host });
  return props;
}

afterEach(() => {
  cleanup();
  gone.length = 0;
  document.body.replaceChildren();
});

test('the active filter is the pressed switch; the others are one click away, and × forgets one', async () => {
  const user = userEvent.setup();
  const props = draw('invoice status = open');
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.view-tab')];
  expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Open', 'Big']);
  expect(tabs[1]).toHaveAttribute('aria-pressed', 'true');
  expect(tabs[0]).toHaveAttribute('aria-pressed', 'false');
  await user.click(tabs[2]);
  expect(gone).toEqual([[{ kind: 'table', table: 'invoice', query: 'invoice total > 500' }, 'replace']]);
  await user.click(screen.getByRole('button', { name: 'Remove Big' }));
  expect(props.onRemove).toHaveBeenCalledWith(views[1]);
  /* This filter is already saved, so there is nothing to offer. */
  expect(screen.queryByRole('button', { name: '+ Save this filter' })).toBeNull();
});

test('a filter not yet saved can be, and the bare table cannot', async () => {
  const user = userEvent.setup();
  const props = draw('invoice status = draft sort total desc');
  await user.click(screen.getByRole('button', { name: '+ Save this filter' }));
  expect(props.onSave).toHaveBeenCalledTimes(1);
  cleanup();
  document.body.replaceChildren();
  draw('invoice');
  expect(screen.queryByRole('button', { name: '+ Save this filter' })).toBeNull();
  expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
});

test('each clause narrowing the result has a way off: a condition alone, a sort whole', async () => {
  const user = userEvent.setup();
  draw('invoice status = draft and total > 5 sort total desc');
  expect(document.querySelectorAll('.clause').length).toBe(3);
  await user.click(screen.getByRole('button', { name: 'Remove sorted by total desc' }));
  expect(gone.at(-1)).toEqual([{ kind: 'table', table: 'invoice', query: 'invoice status = draft and total > 5' }, 'replace']);
  await user.click(screen.getByRole('button', { name: 'Remove where status = draft' }));
  expect((gone.at(-1) as [{ query: string }])[0].query).toBe('invoice total > 5 sort total desc');
});
