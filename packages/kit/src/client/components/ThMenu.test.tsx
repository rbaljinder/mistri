/** The header menu: what a column of each kind is offered, and where a click goes. */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const gone: unknown[] = [];
const pins: string[] = [];
const rendered = vi.fn();
import { quoteValue } from '../../../../engine/src/shared/query.js';
vi.mock('../core.js', () => ({
  go: (e: unknown, mode: string) => gone.push([e, mode]),
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  quote: quoteValue,
  render: rendered,
  refine: (fn: () => unknown) => fn(),
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../pins.js', () => ({ pinnedFor: () => pins, togglePin: (_t: unknown, _c: unknown, name: string) => pins.push(name) }));
vi.mock('../prompt.js', () => ({ promptFor: async () => 'Nia', promptForRange: async () => ({ from: '1', to: '9' }) }));

const { FilterMenu, offersFor } = await import('./ThMenu.js');

const table = {
  id: 'invoice',
  name: 'invoice',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [],
  approxRows: 100_000,
} as unknown as TableMeta;
const rows = [
  { status: 'paid', total: 10 },
  { status: 'paid', total: 30 },
  { status: 'draft', total: 20 },
];

function draw(name: string, kind: string, query = 'invoice') {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const onClose = vi.fn();
  render(
    <FilterMenu
      anchor={anchor}
      name={name}
      kind={kind}
      dateish={false}
      rows={rows}
      table={table}
      columns={['status', 'total']}
      entry={{ table: 'invoice', query }}
      onClose={onClose}
    />,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  gone.length = 0;
  pins.length = 0;
  rendered.mockClear();
  document.body.replaceChildren();
});

describe('what is offered', () => {
  test('a repeating text column offers its values with honest counts; a number offers its middle', () => {
    const text = offersFor('status', 'text', false, rows);
    expect(text.options.slice(0, 2)).toEqual([
      ['paid  ·  2 of 3 here', 'status = paid'],
      ['draft  ·  1 of 3 here', 'status = draft'],
    ]);
    expect(text.options.at(-1)).toEqual(['is not empty', 'status is not empty']);
    expect(text.typed.map((t) => t.label)).toEqual(['equals a value…', 'contains…', 'starts with…', 'matches a pattern…']);
    const number = offersFor('total', 'number', false, rows);
    expect(number.options[0]).toEqual(['greater than 20', 'total > 20']);
    expect(number.ranges).toEqual([['between…', 'text', 'Value']]);
    const stamp = offersFor('created_at', 'date', true, rows, 'timestamp');
    expect(stamp.options[0]).toEqual(['today', 'created_at = today']);
    expect(stamp.typed[0].type).toBe('datetime-local');
    expect(stamp.typed[0].build('2026-01-01T09:30')).toBe('created_at >= "2026-01-01 09:30"');
  });
});

describe('the menu', () => {
  test('a value click composes the filter; sort edits the line; pin redraws', async () => {
    const user = userEvent.setup();
    const onClose = draw('status', 'text');
    await vi.waitFor(() => expect(screen.getByRole('menu').contains(document.activeElement)).toBe(true));
    await user.click(screen.getByRole('menuitem', { name: /paid · 2 of 3 here/ }));
    expect(gone).toEqual([[{ kind: 'table', table: 'invoice', query: 'invoice status = paid' }, 'replace']]);
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('menuitem', { name: /Sort descending/ }));
    expect((gone.at(-1) as [{ query: string }])[0].query).toBe('invoice sort status desc');
    expect(screen.getByRole('menuitem', { name: /Sort descending/ })).toHaveTextContent('no index — a full scan');
    await user.click(screen.getByRole('menuitem', { name: /Pin this column/ }));
    expect(pins).toEqual(['status']);
    expect(rendered).toHaveBeenCalledTimes(1);
  });

  test('a typed condition asks, then adds; "then by" appears only once sorted; Escape hands focus back', async () => {
    const user = userEvent.setup();
    const onClose = draw('total', 'number', 'invoice sort status');
    expect(screen.getByRole('menuitem', { name: /Then by, ascending/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'equals a value…' }));
    await vi.waitFor(() =>
      expect(gone).toEqual([[{ kind: 'table', table: 'invoice', query: 'invoice total = Nia sort status' }, 'replace']]),
    );
    await user.click(screen.getByRole('menuitem', { name: 'between…' }));
    await vi.waitFor(() => expect((gone.at(-1) as [{ query: string }])[0].query).toBe('invoice total between 1 and 9 sort status'));
    fireEvent.keyDown(document, { key: 'Escape' });
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(document.querySelector('body > button')).toHaveFocus());
  });
});
