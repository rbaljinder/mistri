/**
 * The hover card: it waits, it remembers, it borrows the chip's tooltip
 * only while it is up, and Escape takes it down.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const employee: TableMeta = {
  id: 'employee',
  name: 'employee',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('email', 'TEXT'),
    col('phone', 'TEXT'),
  ] as TableMeta['columns'],
};
const calls: unknown[] = [];
let dressed = false;
vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo' },
  api: async (_path: string, body: unknown) => {
    calls.push(body);
    return { rows: [{ id: 4, name: 'Nia Andersen', email: 'nia@example.org', phone: null, quota: 12500, active: true }] };
  },
  findTable: (id: string) => (id === 'employee' ? employee : undefined),
  labelPath: () => 'name',
  columnKind,
  columnDisplay: (_t: string, name: string) => (dressed && name === 'quota' ? { format: 'money' } : null),
  columnLabel: (_t: string, name: string) => (name === 'email' ? 'E-mail' : null),
  emptyWord: () => '—',
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));

const { PeekLayer } = await import('./Peek.js');

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PeekLayer />
      <button type="button" title="Open employee 4" data-ref-table="employee" data-ref-column="id" data-ref-value="4">
        4
      </button>
    </QueryClientProvider>,
  );
  return screen.getByRole('button');
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  dressed = false;
  employee.columns = employee.columns.slice(0, 4);
});

test('hover fields share money and boolean rendering without formatting raw workbench values as currency', async () => {
  employee.columns.push(col('quota', 'NUMERIC'), col('active', 'BOOLEAN'));
  dressed = true;
  const chip = draw();
  fireEvent.mouseOver(chip);
  const card = await screen.findByRole('tooltip', {}, { timeout: 2000 });
  expect(card).toHaveTextContent('$12,500');
  expect(card.querySelector('.bool-value.yes')).toHaveTextContent('yes');
  cleanup();
  dressed = false;
  fireEvent.mouseOver(draw());
  const raw = await screen.findByRole('tooltip', {}, { timeout: 2000 });
  expect(raw).not.toHaveTextContent('$');
  expect(raw).toHaveTextContent('12,500');
});

test('a settled hover answers with the row’s identifying fields; the pointer leaving takes it down', async () => {
  const chip = draw();
  fireEvent.mouseOver(chip);
  const card = await screen.findByRole('tooltip', {}, { timeout: 2000 });
  expect(card.querySelector('.peek-table')).toHaveTextContent('employee');
  expect(card.querySelector('.peek-key')).toHaveTextContent('4');
  const names = [...card.querySelectorAll('.peek-name')].map((n) => n.textContent);
  expect(names).toEqual(['id', 'name', 'E-mail', 'phone']);
  expect(card.querySelector('.peek-value.null')).toHaveTextContent('—');
  /* The native tooltip has to go while the card is up, and come back after. */
  expect(chip).not.toHaveAttribute('title');
  fireEvent.mouseOut(chip);
  await vi.waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  expect(chip).toHaveAttribute('title', 'Open employee 4');
});

test('a second hover on the same reference does not ask again, and Escape closes', async () => {
  const chip = draw();
  fireEvent.mouseOver(chip);
  await screen.findByRole('tooltip', {}, { timeout: 2000 });
  fireEvent.mouseOut(chip);
  await vi.waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  fireEvent.mouseOver(chip);
  await screen.findByRole('tooltip', {}, { timeout: 2000 });
  expect(calls).toHaveLength(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  await vi.waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
});

test('a pointer passing through fires nothing', async () => {
  const chip = draw();
  fireEvent.mouseOver(chip);
  fireEvent.mouseOut(chip);
  await new Promise((r) => setTimeout(r, 400));
  expect(calls).toHaveLength(0);
  expect(screen.queryByRole('tooltip')).toBeNull();
});
