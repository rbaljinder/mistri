/**
 * The photo gallery's question, as the list views' own room is asked it: active products, led by their first photo,
 * with their price and facts; one category's when one is chosen; the room itself is the list views', stood in for.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test, vi } from 'vitest';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import { state } from '@mistriwork/kit/client/core.js';
import page from './product-gallery.page.tsx';

/* The blocks read the App's catalog, which a rendered page has none of: the one table the gallery reads. */
const column = (name: string, primaryKey = false) => ({
  name,
  type: ['id', 'category_id', 'list_price', 'on_hand'].includes(name) ? 'INTEGER' : 'TEXT',
  nullable: !primaryKey,
  primaryKey,
});
(state as { schema: unknown }).schema = {
  tables: [
    {
      id: 'product',
      name: 'product',
      schema: '',
      isView: false,
      columns: ['id', 'sku', 'name', 'category_id', 'status', 'list_price', 'on_hand'].map((name) => column(name, name === 'id')),
    },
  ],
  foreignKeys: [],
};

/* The gallery is the list views' own room, which reads through the shell this test does not have: stood in for, to see what it is asked. */
const room = vi.hoisted(() => vi.fn());
vi.mock('@mistriwork/kit/client/components/TableRoom.js', () => ({
  TableRoom: (props: object) => {
    room(props);
    return <p>The gallery room</p>;
  },
}));

const viewer = { signedIn: true, account: 'planner' };
const category = [
  { id: 1, name: 'Tents' },
  { id: 2, name: 'Stoves' },
];
const photos = { from: 'product_photo', whose: 'product_id', sort: 'position' };

test('asks for the active products with the first photo of each, their price and what is on hand', async () => {
  const view = renderPage(page, { viewer, data: fixtures({ category }) });
  expect(await view.findByText('The gallery room')).toBeInTheDocument();
  expect(room).toHaveBeenLastCalledWith(
    expect.objectContaining({
      entry: expect.objectContaining({ kind: 'table', table: 'product', query: expect.stringContaining('status = "active"') }),
      presentation: { kind: 'cards', image: photos, primary: 'name', value: 'list_price', facts: ['sku', 'on_hand'] },
      listLabel: 'Products by photo',
    }),
  );
  expect(room.mock.lastCall?.[0].entry.query).not.toContain('category_id');
});

test('a chosen category keeps to its own products', async () => {
  const view = renderPage(page, { viewer, address: { category: '2' }, data: fixtures({ category }) });
  expect(await view.findByRole('radio', { name: 'Stoves' })).toHaveAttribute('aria-checked', 'true');
  await view.findByText('The gallery room');
  expect(room.mock.lastCall?.[0].entry.query).toContain('category_id = 2');
});
