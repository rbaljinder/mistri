/**
 * The schema summary: what it says about a shape, where its links go, and
 * that folding it is remembered.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createElement } from 'react';
import { describeSchema } from '../../../../engine/src/shared/shape.js';

const table = (id: string, approxRows?: number) => ({
  id,
  name: id,
  schema: '',
  isView: false,
  indexed: [],
  approxRows,
  columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
});
const fk = (from: string, to: string, col = `${to}_id`) => ({
  name: `${from}_${to}`,
  from: { table: from, columns: [col] },
  to: { table: to, columns: ['id'] },
});
const schema = {
  label: 'shop',
  connection: 'shop',
  tables: [table('customer', 100), table('order', 5000), table('order_line', 20000), table('product', 300), table('settings', 3)],
  foreignKeys: [fk('order', 'customer'), fk('order_line', 'order'), fk('order_line', 'product'), fk('product', 'customer', 'supplier_id')],
};
const gone: unknown[] = [];
const store = new Map<string, unknown>();
const helped = vi.fn();
vi.mock('../core.js', () => ({
  state: { schema },
  go: (e: unknown, mode: string) => gone.push([e, mode]),
  tableView: (id: string) => ({ kind: 'table', table: id }),
  loadJson: (k: string, d: unknown) => store.get(k) ?? d,
  saveJson: (k: string, v: unknown) => store.set(k, v),
}));
vi.mock('../help.js', () => ({ openHelp: () => helped() }));

const { SchemaSummary, summaryLines } = await import('./Summary.js');

function draw() {
  const shape = describeSchema(schema as never);
  const { container } = render(createElement(SchemaSummary, { shape, label: 'shop', id: 'shop' }));
  const host = container.querySelector('section.shape') as HTMLElement;
  return { host, shape };
}

afterEach(() => {
  cleanup();
  gone.length = 0;
  store.clear();
  helped.mockClear();
  document.body.replaceChildren();
});

test('says where the domain centres, and every name is a door', async () => {
  const user = userEvent.setup();
  const { shape } = draw();
  expect(summaryLines(shape)).toBeGreaterThan(0);
  expect(document.querySelector('.shape-counts')).toHaveTextContent('5 tables');
  expect(document.querySelector('.shape-gist')).toHaveTextContent('centres on customer');
  const centre = screen.getByText('Centres on').nextElementSibling!;
  expect(centre).toHaveTextContent('customer, referenced by 2 other tables');
  await user.click(centre.querySelector('.shape-link')!);
  expect(gone).toEqual([[{ kind: 'table', table: 'customer' }, 'reset']]);
  expect(screen.getByText('Standing alone').nextElementSibling).toHaveTextContent('settings — no foreign keys');
});

test('folds away, keeps the gist, and remembers the fold per database', async () => {
  const user = userEvent.setup();
  const { host } = draw();
  const toggle = screen.getByRole('button', { name: 'shop' });
  expect(host).not.toHaveClass('shape-closed');
  await user.click(toggle);
  expect(host).toHaveClass('shape-closed');
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(store.get('mistri.summary.open')).toEqual({ shop: false });
  cleanup();
  const again = draw();
  expect(again.host).toHaveClass('shape-closed');
});

test('offers at most four places to start, with the reason, and the grammar one click away', async () => {
  const user = userEvent.setup();
  draw();
  const chips = document.querySelectorAll('.start-chip');
  expect(chips.length).toBeLessThanOrEqual(4);
  expect(chips[0]).toHaveTextContent('customer');
  expect(chips[0]).toHaveTextContent('2 tables point at it');
  expect(chips[0].querySelector('.start-rows')).toHaveTextContent('100 rows');
  await user.click(screen.getByRole('button', { name: 'Query language (?)' }));
  expect(helped).toHaveBeenCalledTimes(1);
});
