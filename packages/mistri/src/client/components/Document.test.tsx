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
  col('ordered_on', 'DATE'),
  col('due_on', 'DATE'),
  col('paid_at', 'TIMESTAMP'),
]);
const line = table('order_line', [
  col('id', 'INTEGER', { primaryKey: true, nullable: false }),
  col('sales_order_id', 'INTEGER', { references: { table: 'sales_order', column: 'id' } }),
  col('description', 'TEXT'),
  col('quantity', 'INTEGER'),
  col('amount', 'NUMERIC'),
]);
const tables: Record<string, TableMeta> = { sales_order: order, order_line: line };
let money: Record<string, unknown> = { format: 'money', currency: 'USD' };
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
        : column === 'due_on'
          ? { format: 'relative' }
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
  // Three columns are no crowd: the tighter many-column type is for six and more.
  expect(tableNode.hasAttribute('data-wide')).toBe(false);
});

test('on paper a table is held to the sheet: fixed layout, cells that wrap, tighter type for many columns', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('packages/mistri/src/client/components/Document.css', 'utf8');
  const print = css.slice(css.indexOf('@media print'));
  expect(print).toMatch(/\.doc-table \{ table-layout: fixed; \}/);
  expect(print).toMatch(/\.doc-table :is\(th, td\) \{ overflow-wrap: anywhere; \}/);
  expect(print).toMatch(/\.doc-table\[data-wide\] :is\(th, td\)/);
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

test('money on paper is its digits to the cent, past 2^53 too, and a zero stored as text is left unsaid', async () => {
  ordered = { ...orderRow(), subtotal: '90071992547409931.25', discount: '-0.00', total: '90071992547409931.25' };
  const { container } = draw();
  await screen.findByRole('table');
  const totals = [...container.querySelectorAll('.doc-total')].map((row) => [
    row.querySelector('dt')?.textContent,
    row.querySelector('dd')?.textContent,
  ]);
  expect(totals).toEqual([
    ['Subtotal', '$90,071,992,547,409,931.25'],
    ['Total', '$90,071,992,547,409,931.25'],
  ]);
});

test('whole money on paper drops zero cents and keeps real ones', async () => {
  money = { format: 'money', currency: 'USD', whole: true };
  ordered = { ...orderRow(), subtotal: '1200.00', discount: '0', total: '1199.50' };
  try {
    const { container } = draw();
    await screen.findByRole('table');
    const totals = [...container.querySelectorAll('.doc-total')].map((row) => row.querySelector('dd')?.textContent);
    expect(totals).toEqual(['$1,200', '$1,199.50']);
  } finally {
    money = { format: 'money', currency: 'USD' };
  }
});

test('a date is its day on paper, never said from today: a plain one, a relative one and a moment with its zone', async () => {
  /* A field report's statement said "yesterday" and "13 days ago": true the day it was read, false every day after. */
  document.body.classList.add('app-mode');
  const day = (offset: number) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const medium = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${iso}T00:00:00Z`));
  ordered = { ...orderRow(), ordered_on: day(-1), due_on: day(3), paid_at: '2026-09-04T21:30:00Z' };
  composed = async () => ({
    page: {
      ...invoicePage,
      sections: [
        ...invoicePage.sections,
        { kind: 'fields', paths: ['ordered_on', 'due_on', 'paid_at'], presentation: 'properties', width: 'half' },
      ],
    },
    plans,
  });
  try {
    const { container } = draw();
    await screen.findByRole('table');
    const said = [...container.querySelectorAll('.doc-property dd')].map((dd) => dd.textContent?.replace(/[\u00a0\u202f]/g, ' '));
    expect(said).toEqual([medium(day(-1)), medium(day(3)), 'Sep 4, 2026, 9:30 PM UTC']);
  } finally {
    document.body.classList.remove('app-mode');
  }
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
