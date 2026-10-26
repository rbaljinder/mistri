/**
 * The tree list: records folded under the record their parent column names,
 * read with the tree's keys, a record opened from its name.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { primaryKey, type TableMeta } from '../../../../engine/src/shared/schema.js';
import type { AppTreeList } from '../../../../engine/src/shared/listPresentations.js';
const mocks = vi.hoisted(() => ({ api: vi.fn(), open: vi.fn(), state: { activeConnection: 'crm' } }));
const table: TableMeta = {
  id: 'account',
  name: 'account',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'name', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'city', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'parent_id', type: 'INTEGER', nullable: true, primaryKey: false },
  ],
};
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: mocks.api,
  openRecord: mocks.open,
  state: mocks.state,
  primaryKey,
  keyOf: (_t: TableMeta, row: Record<string, unknown>) => (row.id == null ? null : { id: row.id }),
}));
vi.mock('../../../../kit/src/client/requestIdentity.js', () => ({ ownedBy: () => ({}) }));
vi.mock('../../../../kit/src/client/clauses.js', () => ({
  splitQuery: (text: string) => ({ filter: text.replace(/^\S+\s*/, '').replace(/\s*sort .*$/, '') }),
}));
vi.mock('../../../../kit/src/client/bulkActions.js', () => ({
  bulkKey: (_t: TableMeta, key: Record<string, unknown>) => JSON.stringify(key),
}));
vi.mock('../../../../kit/src/client/components/Value.js', () => ({
  Value: ({ value }: { value: unknown }) => <span>{String(value)}</span>,
}));
const { TreeList, forestOf } = await import('./TreeList.js');
const { canShowTree } = await import('../../../../kit/src/client/components/presentationFit.js');
const spec: AppTreeList = { kind: 'tree', parent: 'parent_id', primary: 'name', lines: ['city'] };
const rows = [
  { id: 1, name: 'Northwind Group', city: 'Seattle', parent_id: null },
  { id: 2, name: 'Northwind Retail', city: 'Portland', parent_id: 1 },
  { id: 3, name: 'Northwind Labs', city: 'Boise', parent_id: 1 },
  { id: 4, name: 'Labs West', city: null, parent_id: 3 },
  { id: 5, name: 'Acme', city: 'Austin', parent_id: 99 },
];
const draw = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <TreeList
        table={table}
        spec={spec}
        entry={{ kind: 'table', table: 'account', query: 'account rating = hot' } as never}
        label="Accounts"
      />
    </QueryClientProvider>,
  );
const names = () => screen.getAllByRole('treeitem').map((item) => item.querySelector('.tree-title')!.textContent);

beforeEach(() => {
  mocks.api.mockReset().mockResolvedValue({ rows, more: false });
  mocks.open.mockReset();
});
afterEach(cleanup);

test('the whole list is asked once, with the columns the tree reads', async () => {
  draw();
  await screen.findByRole('tree');
  expect(mocks.api).toHaveBeenCalledWith(
    '/api/run',
    expect.objectContaining({ q: 'account rating = hot show id, parent_id, name, city', limit: 2000 }),
  );
});

test('roots in title order with their first level open; a missing parent makes a root', async () => {
  draw();
  await screen.findByRole('tree');
  expect(names()).toEqual(['Acme', 'Northwind Group', 'Northwind Labs', 'Northwind Retail']);
  const group = screen.getAllByRole('treeitem')[1];
  expect(group).toHaveAttribute('aria-expanded', 'true');
  expect(group).toHaveAttribute('aria-level', '1');
  expect(screen.getAllByRole('treeitem')[2]).toHaveAttribute('aria-level', '2');
  expect(screen.getAllByRole('treeitem')[2]).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getAllByRole('treeitem')[0]).not.toHaveAttribute('aria-expanded');
  expect(group).toHaveTextContent('Seattle');
});

test('the keys walk it: one Tab stop, Right opens and steps in, Left steps out and folds, Enter opens', async () => {
  draw();
  await screen.findByRole('tree');
  expect(screen.getAllByRole('treeitem').filter((item) => item.tabIndex === 0)).toHaveLength(1);
  await userEvent.tab();
  expect(document.activeElement).toHaveTextContent('Acme');
  await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowRight}');
  expect(names()).toContain('Labs West');
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement).toHaveTextContent('Labs West');
  await userEvent.keyboard('{ArrowLeft}');
  expect(document.activeElement).toHaveTextContent('Northwind Labs');
  await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
  expect(document.activeElement).toHaveTextContent('Northwind Group');
  await userEvent.keyboard('{ArrowLeft}');
  expect(names()).toEqual(['Acme', 'Northwind Group']);
  await userEvent.keyboard('{Enter}');
  expect(mocks.open).toHaveBeenCalledWith('account', { id: 1 }, 'Northwind Group', 'push', expect.anything());
});

test('a loop is drawn as roots rather than lost', () => {
  const loop = [
    { id: 'a', parent: 'b' },
    { id: 'b', parent: 'a' },
  ];
  const roots = forestOf(
    loop,
    (row) => String(row.id),
    (row) => String(row.parent),
    (row) => String(row.id),
    (row) => ({ id: row.id }),
  );
  expect(roots.map((root) => root.id)).toEqual(['a', 'b']);
});

test('a tree is shown only over a single-column key and its own columns', () => {
  expect(canShowTree(table, spec)).toBe(true);
  expect(canShowTree(table, { ...spec, parent: 'nope' })).toBe(false);
  expect(
    canShowTree(
      { ...table, columns: table.columns.map((column) => ({ ...column, primaryKey: column.name === 'id' || column.name === 'name' })) },
      spec,
    ),
  ).toBe(false);
});
