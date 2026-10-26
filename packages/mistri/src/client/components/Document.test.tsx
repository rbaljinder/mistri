/**
 * A record on paper (Document.tsx): the letterhead (the App's mark and name,
 * the sender's lines, the document's name and number), an address said as
 * one, the lines as a table whose header repeats on each sheet with figures
 * right-aligned and money kept to its cents, the totals with the sum owed
 * last, the sheet's paper size, and the Print verb.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn, primaryKey } from '../../../../engine/src/shared/schema.js';
import type { HttpViewDefinition } from '../../../../engine/src/shared/resourceHttp.js';

const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
let composed: () => Promise<unknown>;

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const table = (id: string, columns: ReturnType<typeof col>[]): TableMeta =>
  ({ id, name: id, schema: '', isView: false, indexed: ['id'], columns }) as unknown as TableMeta;
const order = table('sales_order', [
  col('id', 'INTEGER', { primaryKey: true, nullable: false }),
  col('ship_name', 'TEXT'),
  col('ship_city', 'TEXT'),
  col('ship_state', 'TEXT'),
  col('ship_zip', 'TEXT'),
  col('subtotal', 'NUMERIC'),
  col('discount', 'NUMERIC'),
  col('total', 'NUMERIC'),
  col('financial_status', 'TEXT'),
  col('summary', 'TEXT'),
]);
const line = table('order_line', [
  col('id', 'INTEGER', { primaryKey: true, nullable: false }),
  col('sales_order_id', 'INTEGER', { references: { table: 'sales_order', column: 'id' } }),
  col('description', 'TEXT'),
  col('quantity', 'INTEGER'),
  col('amount', 'NUMERIC'),
]);
const tables: Record<string, TableMeta> = { sales_order: order, order_line: line };
const money = { format: 'money', currency: 'USD' };
const orderRow = (): Record<string, unknown> => ({
  id: 1042,
  ship_name: 'Celeste Abbott',
  ship_city: 'Portland',
  ship_state: 'OR',
  ship_zip: '97204',
  subtotal: 1188,
  discount: 0,
  total: 975.65,
});
let ordered = orderRow();

function reply(view: HttpViewDefinition, rows: Record<string, unknown>[]) {
  return {
    view,
    columns: view.columns.map((c) => c.alias ?? c.path),
    rows,
    resolved: [],
    errors: [],
    ms: 1,
    more: false,
    offset: 0,
    limit: 500,
  };
}

vi.mock('../../../../kit/src/client/core.js', () => ({
  state: { activeConnection: 'shop', schema: { tables: Object.values(tables), foreignKeys: [] }, stack: [] },
  subscribeWalk: () => () => {},
  walkVersion: () => 0,
  api: async (path: string, body: { view?: HttpViewDefinition; def?: unknown }) => {
    calls.push({ path, body: body as Record<string, unknown> });
    if (path === '/api/breakdown') return { rows: [{ total_0: 4 }] };
    const view = body.view!;
    if (view.base === 'sales_order') return reply(view, [ordered]);
    return reply(view, [
      { description: 'Pleated Chino', quantity: 1, amount: 198 },
      { description: 'Waxed Cotton Jacket', quantity: 3, amount: 774 },
    ]);
  },
  findTable: (id: string) => tables[id],
  rowLabel: (_t: TableMeta, row: Record<string, unknown>) => String(row.id),
  labelPath: () => undefined,
  recordLabel: () => undefined,
  labelColumn,
  primaryKey,
  columnKind,
  columnDisplay: (_table: string, column: string) =>
    ['subtotal', 'discount', 'total', 'amount'].includes(column)
      ? money
      : column === 'financial_status'
        ? { tone: { paid: 'good', pending: 'warn' } }
        : null,
  columnLabel: (_table: string, column: string) => ({ ship_name: 'Ship to', total: 'Total', amount: 'Amount' })[column] ?? null,
  emptyWord: () => '—',
  currentEntry: () => undefined,
  renderCrumbs: () => {},
  refsFrom: () => [],
}));
vi.mock('../appState.js', () => ({
  inAppMode: () => true,
  activeApp: () => ({ name: 'Atelier', ui: { logo: undefined }, resources: {} }),
  appSaveMode: () => 'explicit',
}));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/recordCompose.js', () => ({ composeRecordPage: () => composed() }));

const { DocumentRoom } = await import('./Document.js');

const lines: HttpViewDefinition = {
  id: 'page:invoice:list',
  name: 'order_line',
  base: 'order_line',
  columns: [{ path: 'sales_order_id' }, { path: 'description' }, { path: 'quantity' }, { path: 'amount' }],
  filter: { groups: [[{ path: 'sales_order_id', op: '=', value: 1042 }]] },
  limit: 500,
};
const invoicePage = {
  id: 'invoice',
  name: 'Invoice',
  base: 'sales_order',
  source: 'config',
  document: { label: 'Invoice', number: 'id', size: 'a4', description: 'Atelier Goods Co.\n214 Alder Street' },
  sections: [
    { kind: 'fields', title: 'Ship to', paths: ['ship_name', 'ship_city', 'ship_state', 'ship_zip'], presentation: 'facts', width: 'half' },
    { kind: 'list', from: 'order_line', path: 'sales_order_id', title: 'Items', totals: ['quantity'], limit: 500 },
    { kind: 'fields', paths: ['subtotal', 'discount', 'total'], presentation: 'table', width: 'half' },
  ],
};
const plans = [
  {
    index: 1,
    view: lines,
    totals: { base: 'order_line', by: [], measures: [{ fn: 'sum', path: 'quantity', alias: 'total_0' }], filter: lines.filter },
  },
];

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const entry = { kind: 'page' as const, pageId: 'order', table: 'sales_order', key: { id: 1042 }, tab: 'invoice' };
  return render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(DocumentRoom, { entry, document: { id: 'invoice', base: 'sales_order', label: 'Invoice' } }),
    ),
  );
}

beforeEach(() => {
  calls.length = 0;
  ordered = orderRow();
  delete (order as { computed?: unknown }).computed;
  composed = async () => ({ page: invoicePage, plans });
});
afterEach(() => cleanup());

test('the letterhead says who sends it and what it is: the App, its lines, the document and its number', async () => {
  const { container } = draw();
  const heading = await screen.findByRole('heading', { level: 1 });
  expect(heading.textContent).toBe('Invoice No. 1042');
  expect(screen.getByText('Atelier')).toBeTruthy();
  expect(container.querySelector('.doc-from-lines')?.textContent).toBe('Atelier Goods Co.\n214 Alder Street');
  expect(container.querySelector('style')?.textContent).toContain('size: A4');
});

test('an address is said as one: a city, its state and its code on one line', async () => {
  const { container } = draw();
  await screen.findByRole('heading', { level: 1 });
  const facts = [...container.querySelectorAll('.doc-facts-lines > span')].map((span) => span.textContent);
  expect(facts).toEqual(['Celeste Abbott', 'Portland, OR 97204']);
});

test('the lines are a table under a repeating header, figures to the right in cents, the sum said once under them', async () => {
  const { container } = draw();
  const tableNode = (await screen.findByRole('table')) as HTMLTableElement;
  const head = [...tableNode.querySelectorAll('thead th')].map((th) => [th.textContent, th.className]);
  // The column that points back at the order says the same thing on every line: it is left out.
  expect(head).toEqual([
    ['Description', 'is-words'],
    ['Quantity', 'is-figure'],
    ['Amount', 'is-figure'],
  ]);
  const body = [...tableNode.querySelectorAll('tbody tr')].map((row) => [...row.querySelectorAll('td')].map((cell) => cell.textContent));
  expect(body).toEqual([
    ['Pleated Chino', '1', '$198.00'],
    ['Waxed Cotton Jacket', '3', '$774.00'],
    ['Total', '4', ''],
  ]);
  expect(tableNode.querySelector('tfoot')).toBeNull();
  // Every line is asked for, not a screen's page of them.
  expect(
    calls.find((call) => call.path === '/api/view/run' && (call.body.view as HttpViewDefinition).base === 'order_line')?.body.view,
  ).toMatchObject({ limit: 500 });
  expect(container.querySelector('.doc-lines .doc-caption')?.textContent).toBe('Items');
});

test('the totals end on the sum owed, and a zero before it is left unsaid', async () => {
  const { container } = draw();
  await screen.findByRole('table');
  const totals = [...container.querySelectorAll('.doc-total')].map((row) => [
    row.querySelector('dt')?.textContent,
    row.querySelector('dd')?.textContent,
  ]);
  expect(totals).toEqual([
    ['Subtotal', '$1,188.00'],
    ['Total', '$975.65'],
  ]);
  expect(container.querySelector('.doc-total--due dt')?.textContent).toBe('Total');
});

test('a part the total takes off is said negated, and a status is its plain word on paper', async () => {
  // total = subtotal - discount: the discount is taken off, as the New form's summary says it.
  (order as { computed?: unknown }).computed = {
    total: {
      type: 'number',
      expr: { k: 'op', op: '-', left: { k: 'path', path: 'subtotal' }, right: { k: 'path', path: 'discount' } },
      reads: ['subtotal', 'discount'],
    },
  };
  ordered = { ...orderRow(), discount: 297, total: 891, financial_status: 'paid' };
  composed = async () => ({
    page: {
      ...invoicePage,
      sections: [...invoicePage.sections, { kind: 'fields', paths: ['financial_status'], presentation: 'properties', width: 'half' }],
    },
    plans,
  });
  const { container } = draw();
  await screen.findByRole('table');
  const totals = [...container.querySelectorAll('.doc-total')].map((row) => [
    row.querySelector('dt')?.textContent,
    row.querySelector('dd')?.textContent,
  ]);
  expect(totals).toEqual([
    ['Subtotal', '$1,188.00'],
    ['Discount', '−$297.00'],
    ['Total', '$891.00'],
  ]);
  const status = container.querySelector('.doc-property dd')!;
  expect(status.textContent).toBe('Paid');
  expect(status.querySelector('.tone')).toBeNull();
});

test("long text sits under its caption at the section's width; a short value stays beside its caption", async () => {
  const summary =
    'Volume was steady and most of it was accounts and devices. Resolution times held; the one breach was a laptop that waited on a part.';
  ordered = { ...orderRow(), financial_status: 'paid', summary };
  composed = async () => ({
    page: {
      ...invoicePage,
      sections: [
        { kind: 'fields', paths: ['financial_status', 'summary'], presentation: 'properties', width: 'half' },
        { kind: 'fields', title: 'What we said', paths: ['ship_name', 'summary'] },
      ],
    },
    plans: [],
  });
  const { container } = draw();
  await screen.findAllByText(summary);
  const properties = [...container.querySelectorAll('.doc-property')].map((row) => [row.querySelector('dt')?.textContent, row.className]);
  expect(properties).toEqual([
    ['Financial status', 'doc-property'],
    ['Summary', 'doc-property doc-property--block'],
  ]);
  const fields = [...container.querySelectorAll('.doc-summary .doc-field')].map((field) => field.className);
  expect(fields).toEqual(['doc-field', 'doc-field doc-field--block']);
});

test('Print hands the sheet to the browser, whose dialog saves it as a PDF', async () => {
  const print = vi.fn();
  window.print = print;
  draw();
  await screen.findByRole('table');
  await userEvent.click(screen.getByRole('button', { name: 'Print / Save as PDF' }));
  expect(print).toHaveBeenCalledOnce();
});

test('a document that cannot be read says so on the sheet, and offers nothing to print', async () => {
  composed = async () => {
    throw new Error('You cannot read this order.');
  };
  const { container } = draw();
  await waitFor(() => expect(container.querySelector('.doc-broken')?.textContent).toBe('You cannot read this order.'));
  expect((within(container).getByRole('button', { name: 'Print / Save as PDF' }) as HTMLButtonElement).disabled).toBe(true);
});
