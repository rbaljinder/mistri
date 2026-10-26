/**
 * A record's lines as a grid of inputs, and the figures a form says as it is
 * filled in: rows added, moved and removed in place; each line's own checks,
 * and the server's said on the cell it names; the live total worked out from
 * the draft by the evaluator the server agrees with, in its currency.
 */
import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { parseAppConfig, withRollups } from '../../shared/app.js';
import type { DatabaseSchema, TableMeta } from '../../../../engine/src/shared/schema.js';

const column = (name: string, type: string, extra: object = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const raw = {
  label: 'shop',
  dialect: 'sqlite',
  readAt: '2026-10-09T00:00:00Z',
  tables: [
    {
      id: 'sales_order',
      name: 'sales_order',
      schema: '',
      columns: [column('id', 'INTEGER', { primaryKey: true, nullable: false }), column('currency', 'TEXT'), column('shipping', 'INTEGER')],
    },
    {
      id: 'order_line',
      name: 'order_line',
      schema: '',
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('order_id', 'INTEGER', { nullable: false }),
        column('product', 'TEXT', { nullable: false }),
        column('quantity', 'INTEGER', { nullable: false }),
        column('unit_price', 'INTEGER', { nullable: false }),
      ],
    },
    /* A variant named through its product, whose picture it shows: a face read through a reference. */
    {
      id: 'product',
      name: 'product',
      schema: '',
      columns: [column('id', 'INTEGER', { primaryKey: true, nullable: false }), column('title', 'TEXT')],
    },
    {
      id: 'variant',
      name: 'variant',
      schema: '',
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('product_id', 'INTEGER', { references: { table: 'product', column: 'id' } }),
        column('sku', 'TEXT'),
      ],
    },
    {
      id: 'basket_line',
      name: 'basket_line',
      schema: '',
      columns: [
        column('id', 'INTEGER', { primaryKey: true, nullable: false }),
        column('variant_id', 'INTEGER', { references: { table: 'variant', column: 'id' } }),
        column('quantity', 'INTEGER'),
      ],
    },
  ],
  foreignKeys: [{ name: 'fk', from: { table: 'order_line', columns: ['order_id'] }, to: { table: 'sales_order', columns: ['id'] } }],
} as unknown as DatabaseSchema;
const app = parseAppConfig(
  {
    id: 'shop',
    name: 'Shop',
    connection: 'shop',
    resources: {
      order_line: { access: 'write', computed: { line_total: { type: 'number', value: 'quantity * unit_price' } } },
      sales_order: {
        access: 'write',
        rollups: { subtotal: { fn: 'sum', from: 'order_line', column: 'line_total' } },
        computed: { total: { type: 'number', value: 'subtotal + shipping' } },
      },
    },
    views: { orders: { kind: 'list', from: 'sales_order' } },
    home: 'orders',
  },
  'shop',
);
const schema = withRollups(app, raw);
const order = schema.tables[0];
const line = schema.tables[1] as TableMeta;
const rules: Record<string, object> = {
  'order_line.unit_price': { format: 'money', minor: true },
  'sales_order.total': { format: 'money', minor: true, currencyColumn: 'currency' },
  'product.title': { avatar: { from: 'product_image', whose: 'product_id' } },
  'variant.product_id': { subtitle: 'sku' },
};
const labels: Record<string, string> = { variant: '{product_id.title} · {sku}' };

vi.mock('../../../../kit/src/client/core.js', () => ({
  api: vi.fn(),
  state: { schema },
  findTable: (id: string) => schema.tables.find((t) => t.id === id),
  columnDisplay: (table: string, name: string) => rules[`${table}.${name}`] ?? null,
  columnLabel: () => null,
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
  labelPath: () => undefined,
  recordLabel: (table: { id: string }) => labels[table.id],
  emptyWord: () => 'Empty',
  refsFrom: () => [],
  openRecord: () => {},
}));
vi.mock('../../../../kit/src/client/locale.js', async (original) => ({ ...(await original<object>()), defaultCurrency: () => 'USD' }));
/* The cell's own control is GridCellEditor's, tested there; here a plain box stands in for it. */
vi.mock('../../../../kit/src/client/components/GridCellEditor.js', () => ({
  ValueControl: ({
    value,
    onChange,
    label,
    invalid,
  }: {
    value: string;
    onChange: (v: string) => void;
    label: string;
    invalid?: boolean;
  }) => <input aria-label={label} aria-invalid={invalid || undefined} value={value} onChange={(e) => onChange(e.target.value)} />,
}));

const { LinesEditor, LiveValues, lineProblems, lineValues, lineServerProblems, blankLine } = await import('./FormLines.js');
type Draft = ReturnType<typeof blankLine>;

afterEach(cleanup);

function Harness({
  initial,
  ordered = true,
  max,
  problems,
  columns = ['product', 'quantity'],
}: {
  initial: Draft[];
  ordered?: boolean;
  max?: number;
  problems?: Record<string, string>;
  columns?: string[];
}) {
  const [rows, setRows] = useState(initial);
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return (
    <QueryClientProvider client={client}>
      <LinesEditor
        title="Lines"
        table={line}
        columns={columns}
        rows={rows}
        onChange={setRows}
        ordered={ordered}
        max={max}
        problems={problems}
      />
      <output data-testid="rows">{rows.map((row) => row.values.product ?? '').join(',')}</output>
    </QueryClientProvider>
  );
}

const draft = (product: string, extra: Record<string, string> = {}): Draft => ({ ...blankLine(), values: { product, ...extra } });

test('lines are added, moved by their handle or their menu, and removed in place, and a new line takes the focus', async () => {
  const user = userEvent.setup();
  render(<Harness initial={[draft('Kettle'), draft('Mug'), draft('Spoon')]} />);
  /* The handle is the keyboard's way as well as the pointer's: Alt and an arrow move its line, and it keeps the focus. */
  screen.getByRole('button', { name: 'Move line 2' }).focus();
  await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
  expect(screen.getByTestId('rows').textContent).toBe('Mug,Kettle,Spoon');
  expect(document.activeElement?.getAttribute('aria-label')).toBe('Move line 1');
  expect(screen.getByText('Line moved to place 1 of 3.')).toBeTruthy();
  /* The row's menu says the same moves by name, and holds Remove. */
  await user.click(screen.getByRole('button', { name: 'Line 3 actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Move up' }));
  expect(screen.getByTestId('rows').textContent).toBe('Mug,Spoon,Kettle');
  await user.click(screen.getByRole('button', { name: 'Line 1 actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Remove line' }));
  expect(screen.getByTestId('rows').textContent).toBe('Spoon,Kettle');
  await user.click(screen.getByRole('button', { name: /Add line/i }));
  expect(document.activeElement?.getAttribute('aria-label')).toMatch(/, 3$/);
  await user.keyboard('Fork');
  expect(screen.getByTestId('rows').textContent).toBe('Spoon,Kettle,Fork');
});

test('a money cell reads in its currency at rest and as typed under the focus, and a line’s amount is worked out beside it', async () => {
  const user = userEvent.setup();
  render(<Harness initial={[draft('Kettle', { quantity: '2', unit_price: '1999' })]} columns={['product', 'quantity', 'unit_price']} />);
  const price = screen.getByRole('textbox', { name: /unit price, 1/i }) as HTMLInputElement;
  expect(price.value).toBe('$19.99');
  await user.click(price);
  expect(price.value).toBe('19.99');
  expect(screen.getByText('$39.98')).toBeTruthy();
  await user.clear(price);
  await user.keyboard('5');
  expect(screen.getByText('$10.00')).toBeTruthy();
});

test('with every line it may hold, no more are offered; with none, it says so', () => {
  const { unmount } = render(<Harness initial={[draft('Kettle')]} max={1} ordered={false} />);
  expect(screen.getByRole('button', { name: /Add line/i })).toHaveProperty('disabled', true);
  expect(screen.queryByRole('button', { name: /^Move line/i })).toBeNull();
  unmount();
  render(<Harness initial={[]} />);
  expect(screen.getByText(/No lines yet/i)).toBeTruthy();
});

test("a line's problem is said under its cell and marks it", () => {
  render(<Harness initial={[draft('Kettle')]} problems={{ '0.quantity': 'Order at least one.' }} />);
  expect(screen.getByText('Order at least one.')).toBeTruthy();
  expect(screen.getByRole('textbox', { name: /quantity, 1/i }).getAttribute('aria-invalid')).toBe('true');
});

test('each line is checked before the wire: a required value, and an amount its currency cannot hold', () => {
  const problems = lineProblems(
    line,
    ['product', 'quantity', 'unit_price'],
    [draft('', { quantity: '2', unit_price: '1999' }), draft('Mug', { quantity: '1', unit_price: '19.999' })],
  );
  expect(Object.keys(problems).sort()).toEqual(['0.product', '1.unit_price']);
  expect(problems['1.unit_price']).toMatch(/2/);
});

test("a save sends a new line's filled boxes, clears a kept line's emptied ones, and reads the server's word back onto its cell", () => {
  expect(lineValues(draft('Mug', { quantity: '' }), ['product', 'quantity'])).toEqual({ product: 'Mug' });
  expect(lineValues({ ...draft('Mug', { quantity: '' }), key: { id: 3 } }, ['product', 'quantity'])).toEqual({
    product: 'Mug',
    quantity: null,
  });
  expect(
    lineServerProblems(line, [
      { field: 'order_line[1].quantity', message: 'Order at least one.' },
      { field: 'customer', message: 'Fill it.' },
    ]),
  ).toEqual({ '1.quantity': 'Order at least one.' });
});

test('the live figures follow the draft and its lines, in the record’s own currency', () => {
  const lines = {
    order_line: [draft('Kettle', { quantity: '2', unit_price: '1999' }), draft('Mug', { quantity: '3', unit_price: '850' })],
  };
  const { rerender } = render(
    <LiveValues table={order} names={['subtotal', 'total']} values={{ currency: 'USD', shipping: '500' }} lines={lines} />,
  );
  expect(screen.getByText('Subtotal').nextElementSibling?.textContent).toBe('6,548');
  expect(screen.getByText('Total').nextElementSibling?.textContent).toBe('$70.48');
  rerender(<LiveValues table={order} names={['subtotal', 'total']} values={{ currency: 'JPY', shipping: '500' }} lines={lines} />);
  expect(screen.getByText('Total').nextElementSibling?.textContent).toMatch(/7,048/);
  rerender(<LiveValues table={order} names={['total']} values={{ currency: 'USD' }} lines={{ order_line: [] }} />);
  expect(screen.getByText('Total').nextElementSibling?.textContent).toBe('—');
});

test('a total that is a sum is summed up: its parts under it in order, the record’s own money among them, the total last', () => {
  rules['sales_order.shipping'] = { format: 'money', minor: true, currencyColumn: 'currency' };
  try {
    const lines = { order_line: [draft('Kettle', { quantity: '2', unit_price: '1999' })] };
    const { container } = render(
      <LiveValues table={order} names={['subtotal', 'total']} values={{ currency: 'USD', shipping: '500' }} lines={lines} />,
    );
    const rows = [...container.querySelectorAll('.lines-summary-row')].map((row) => row.textContent);
    expect(rows).toEqual(['Subtotal3,998', 'Shipping$5.00', 'Total$44.98']);
    expect(container.querySelector('.lines-summary-row:last-child')?.classList.contains('is-total')).toBe(true);
  } finally {
    delete rules['sales_order.shipping'];
  }
});

test("a command's lines are drawn by the same grid: its help under the legend, each problem on its cell, the money added up", async () => {
  const { CommandLines } = await import('./CommandLines.js');
  function Command() {
    const [rows, setRows] = useState([
      draft('Kettle', { quantity: '2', unit_price: '1999' }),
      draft('Mug', { quantity: '', unit_price: '850' }),
    ]);
    const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
    return (
      <QueryClientProvider client={client}>
        <CommandLines
          field={{
            name: 'items',
            label: 'Items',
            help: 'Tax is added when the order is placed.',
            type: 'lines',
            from: 'order_line',
            show: ['product', 'quantity', 'unit_price'],
            max: 20,
          }}
          path="items"
          rows={rows}
          problems={{ 'items[1].quantity': 'Order at least one.', note: 'Not this one.' }}
          onChange={(next) => setRows(next)}
        />
      </QueryClientProvider>
    );
  }
  render(<Command />);
  expect(screen.getByText('Items')).toBeTruthy();
  expect(screen.getByText('Tax is added when the order is placed.')).toBeTruthy();
  /* The form's path (`items[1].quantity`) is the grid's cell, and a problem elsewhere is not the grid's to say. */
  expect(screen.getByRole('textbox', { name: /quantity, 2/i }).getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('Order at least one.')).toBeTruthy();
  expect(screen.queryByText('Not this one.')).toBeNull();
  /* The line's computed money summed under the grid, a line with no amount yet left out. */
  expect(screen.getByText('Subtotal').nextElementSibling?.textContent).toBe('$39.98');
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: /quantity, 2/i }), '2');
  expect(screen.getByText('Subtotal').nextElementSibling?.textContent).toBe('$56.98');
});

test("a reference named through another record shows that record's picture, with its own second line", () => {
  const basket = schema.tables.find((t) => t.id === 'basket_line') as TableMeta;
  const [client] = [new QueryClient({ defaultOptions: { queries: { retry: false } } })];
  const { container } = render(
    <QueryClientProvider client={client}>
      <LinesEditor
        title="Basket"
        table={basket}
        columns={['variant_id', 'quantity']}
        rows={[{ ...blankLine(), values: { variant_id: '3', quantity: '1' } }]}
        onChange={() => {}}
      />
    </QueryClientProvider>,
  );
  /* The square holds its place before the picture comes, and the second line is the variant's SKU. */
  expect(container.querySelector('.lines-ref.has-thumb.has-sub .lines-thumb')).toBeTruthy();
});

test('a whole amount the grid works out keeps its cents, as the money typed beside it does', () => {
  render(<Harness initial={[draft('Kettle', { quantity: '2', unit_price: '1900' })]} columns={['product', 'quantity', 'unit_price']} />);
  expect(screen.getByText('$38.00')).toBeTruthy();
});
