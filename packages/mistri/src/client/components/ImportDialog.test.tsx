import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const api = vi.hoisted(() => vi.fn());
const download = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
const context = vi.hoisted(() => ({ writable: true, app: null as unknown }));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api,
  toast,
  state: { activeConnection: 'stock', connections: [{ id: 'stock', writable: true }] },
  columnLabel: (_table: string, column: string) =>
    (({ sku: 'SKU', supplier_id: 'Supplier', unit_cost: 'Unit cost' }) as Record<string, string>)[column],
  writeAllowed: () => context.writable,
  viewportSize: () => ({ width: 1280, height: 800 }),
  viewportScale: () => 1,
  viewportBox: (node: Element) => node.getBoundingClientRect(),
}));
vi.mock('../appState.js', () => ({ activeApp: () => context.app }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/export.js', () => ({ download }));

const { ImportDialog } = await import('./ImportDialog.js');
const { ImportButton } = await import('./ImportButton.js');
const table: TableMeta = {
  id: 'product',
  name: 'product',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'sku', type: 'TEXT', nullable: false, primaryKey: false },
    { name: 'supplier_id', type: 'INTEGER', nullable: false, primaryKey: false, references: { table: 'supplier', column: 'id' } },
    { name: 'unit_cost', type: 'NUMERIC', nullable: true, primaryKey: false },
  ],
};
const noun = { one: 'product', many: 'products' };
const draw = (node: React.ReactNode) => render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);
const file = (text: string, name = 'products.csv') => new File([text], name, { type: 'text/csv' });

beforeEach(() => {
  vi.clearAllMocks();
  context.writable = true;
  context.app = { resources: { product: { import: {}, labels: { 'supplier_id.name': 'Vendor' } } }, views: {} };
});
afterEach(cleanup);

test('a file is mapped by its headers, checked and imported', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  draw(<ImportDialog table={table} def={{}} noun={noun} onClose={onClose} />);
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  fireEvent.change(input, { target: { files: [file('SKU,Vendor,Cost,Notes\nA-1,Summit,=1+1,x\nA-2,Nobody,3,y\n')] } });
  await screen.findByText(/Choose the field each column fills/);
  // By caption, by a reference's own path caption ("Vendor" for supplier_id.name), and "Cost" left for the reader.
  expect(screen.getByRole('button', { name: 'Field for SKU' }).textContent).toContain('SKU');
  expect(screen.getByRole('button', { name: 'Field for Vendor' }).textContent).toContain('Supplier');
  expect(screen.getByRole('button', { name: 'Field for Notes' }).textContent).toContain('Leave out');

  api.mockResolvedValueOnce({
    outcome: 'checked',
    rows: 2,
    ready: 1,
    refused: [{ row: 2, line: 3, problems: [{ field: 'Supplier', message: 'No supplier is named "Nobody".' }] }],
  });
  await user.click(screen.getByRole('button', { name: 'Check 2 rows' }));
  expect(api).toHaveBeenLastCalledWith(
    '/api/import',
    expect.objectContaining({ table: 'product', mode: 'check', mapping: ['sku', 'supplier_id', null, null], name: 'products.csv' }),
  );
  expect((await screen.findByRole('status')).textContent).toBe('1 row is ready; 1 row has a problem and will be left out.');
  expect(screen.getByText('No supplier is named "Nobody".')).toBeTruthy();

  // The problems download as a CSV whose cells no spreadsheet reads as a formula.
  await user.click(screen.getByRole('button', { name: 'Download the rows with problems' }));
  expect(download).toHaveBeenCalledWith(
    'product-import-problems.csv',
    expect.stringContaining('3,A-2,Nobody,3,y,"Supplier: No supplier is named ""Nobody""."'),
    'text/csv',
  );

  api.mockResolvedValueOnce({ outcome: 'applied', rows: 2, ready: 1, applied: 1, refused: [] });
  await user.click(screen.getByRole('button', { name: 'Import the 1 ready row' }));
  expect(api).toHaveBeenLastCalledWith('/api/import', expect.objectContaining({ mode: 'commit', skipRefused: true }));
  expect((await screen.findByRole('status')).textContent).toBe('Imported 1 product.');
  // An App has no Undo: the import is done.
  expect(screen.queryByRole('button', { name: /Undo/ })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Done' }));
  expect(onClose).toHaveBeenCalled();
});

test('a file past the limit is refused before it is read, and a bad one says its line', async () => {
  draw(<ImportDialog table={table} def={{}} noun={noun} onClose={() => {}} />);
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  const big = file('x');
  Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
  fireEvent.change(input, { target: { files: [big] } });
  expect((await screen.findByRole('alert')).textContent).toMatch(/larger than 5 MB/);
  fireEvent.change(input, { target: { files: [file('SKU\n"open')] } });
  await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Line 2: A quoted field is never closed.'));
  expect(api).not.toHaveBeenCalled();
});

test('Import is offered only where the list opts in and the reader could make the records', () => {
  const { rerender } = draw(<ImportButton table={table} noun={noun} />);
  expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy();
  context.writable = false;
  rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ImportButton table={table} noun={noun} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  context.writable = true;
  context.app = { resources: { product: {} }, views: {} };
  rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ImportButton table={table} noun={noun} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
  context.app = { resources: { product: { import: {} } }, views: { closed: { table: 'product', import: false } } };
  rerender(
    <QueryClientProvider client={new QueryClient()}>
      <ImportButton table={table} view="closed" noun={noun} />
    </QueryClientProvider>,
  );
  expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
});
