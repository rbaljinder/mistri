/**
 * The pick board's lists, drawn as the floor sees them: the next lists to pick, first to ship first, each with its
 * Pick; one warehouse's work when one is chosen; and a floor with nothing waiting, said in words.
 */
import '@testing-library/jest-dom/vitest';
import { within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import page from './pick-board.page.tsx';

const viewer = { signedIn: true, account: 'picker' };
const commands = { pickList: { label: 'Pick' } };
const warehouse = [
  { id: 1, name: 'Reno' },
  { id: 2, name: 'Columbus' },
];
const list = (id: number, warehouse_id: number, status: string, ship_by: string, ship_to: string) => ({
  id,
  reference: `SO-${id}`,
  ship_to,
  status,
  warehouse_id,
  released_at: '2026-11-08T15:00:00Z',
  'sales_order_id.ship_by': ship_by,
  'warehouse_id.name': warehouse.find((place) => place.id === warehouse_id)?.name,
});
const pick_list = [
  list(25160, 1, 'to_pick', '2026-11-11', 'Front Range Pedal Co., Fort Collins, CO'),
  list(25164, 2, 'to_pick', '2026-11-09', 'North Woods Outfitting, Duluth, MN'),
  list(25148, 1, 'picked', '2026-11-09', 'Palouse Cycle Club, Pullman, WA'),
];

test('the next lists to pick come first to ship first, each with its warehouse and a Pick', async () => {
  const view = renderPage(page, { viewer, commands, data: fixtures({ warehouse, pick_list }) });
  const next = await view.findByRole('list', { name: 'Next to pick' });
  const rows = next.querySelectorAll('li');
  expect(rows).toHaveLength(2);
  expect(rows[0]).toHaveTextContent('SO-25164 · North Woods Outfitting, Duluth, MN');
  expect(rows[0]).toHaveTextContent('Columbus');
  expect(rows[1]).toHaveTextContent('SO-25160');
  expect(next).not.toHaveTextContent('SO-25148');
});

test('Pick runs the pick-list command on that list and says where it went', async () => {
  const announced: { text: string; tone: 'ok' | 'error' }[] = [];
  const view = renderPage(page, { viewer, commands, data: fixtures({ warehouse, pick_list }), announced });
  const first = (await view.findByRole('list', { name: 'Next to pick' })).querySelector('li')!;
  /* By the row, not the button's name: the test host titles a row by a guess (here the warehouse), the App by its catalog. */
  within(first).getByRole('button', { name: /^Pick/ }).click();
  expect(await view.findByText('SO-25164 is picked. It waits in To pack.')).toBeInTheDocument();
  expect(view.commands).toEqual([{ command: 'pickList', mode: 'run', key: expect.objectContaining({ id: 25164 }) }]);
});

test('a chosen warehouse keeps to its own lists', async () => {
  const view = renderPage(page, { viewer, commands, address: { warehouse: '1' }, data: fixtures({ warehouse, pick_list }) });
  expect(await view.findByRole('radio', { name: 'Reno' })).toHaveAttribute('aria-checked', 'true');
  const next = await view.findByRole('list', { name: 'Next to pick' });
  expect(next).toHaveTextContent('SO-25160');
  expect(next).not.toHaveTextContent('SO-25164');
});

test('with nothing released, the floor says so', async () => {
  const view = renderPage(page, { viewer, commands, data: fixtures({ warehouse, pick_list: [] }) });
  expect(await view.findByText('Nothing to pick')).toBeInTheDocument();
  expect(view.getByRole('radio', { name: 'All warehouses' })).toHaveAttribute('aria-checked', 'true');
});
