/**
 * The peek drawer: a fresh row, references speaking names, the three
 * ways out — Escape, the backdrop, and the page — and the focus it holds.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, primaryKey, labelColumn } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const site: TableMeta = {
  id: 'site',
  name: 'site',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')] as TableMeta['columns'],
};
const order: TableMeta = {
  id: 'work_order',
  name: 'work_order',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('title', 'TEXT'),
    col('site_id', 'INTEGER', { references: { table: 'site', column: 'id' } }),
    col('closed_at', 'TEXT'),
  ] as TableMeta['columns'],
};
const calls: Array<Record<string, unknown>> = [];
const opened: unknown[] = [];
let row: Record<string, unknown> | null = { id: 8, title: 'Replace pump', site_id: 3, 'site_id.name': 'North yard', closed_at: null };
vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: [order, site], foreignKeys: [] } },
  $: () => null,
  // A run is a step past the page (RecordTrailNav's reader); a view run is the glance's own row.
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push(body);
    if (path === '/api/run') return { rows: [{ id: 9, title: 'Fix valve' }] };
    return { rows: row ? [row] : [] };
  },
  findTable: (id: string) => (id === 'work_order' ? order : id === 'site' ? site : undefined),
  keyOf: (_t: TableMeta, r: Record<string, unknown>) => ({ id: r.id }),
  labelPath: labelColumn,
  primaryKey,
  columnKind,
  refsFrom: () => [],
  rowLabel: (_t: TableMeta, r: Record<string, unknown>) => String(r.title),
  columnLabel: () => null,
  columnDisplay: () => null,
  emptyWord: () => '—',
  openRecord: (...a: unknown[]) => opened.push(a),
  viewportBox: (n: Element) => n.getBoundingClientRect(),
}));

const { PeekPanel } = await import('./PeekPanel.js');

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <PeekPanel tableId="work_order" recordKey={{ id: 8 }} label="#8" onClose={onClose} />
    </QueryClientProvider>,
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  opened.length = 0;
  row = { id: 8, title: 'Replace pump', site_id: 3, 'site_id.name': 'North yard', closed_at: null };
});

test('fetches the whole row with reference names joined in, and titles itself by it', async () => {
  draw();
  expect(screen.getByRole('dialog', { name: '#8 — a glance' })).toHaveTextContent('Reading…');
  await screen.findByText('Replace pump', { selector: 'h2' });
  const view = calls[0].view as { columns: Array<{ path: string }> };
  expect(view.columns.map((c) => c.path)).toEqual(['id', 'title', 'site_id', 'closed_at', 'site_id.name']);
  /* The name is the title; it is not repeated as a field. Nulls show. */
  const names = [...document.querySelectorAll('.field dt')].map((n) => n.textContent);
  expect(names).toEqual(['id', 'site_id', 'closed_at']);
  expect(screen.getByText('North yard')).toBeInTheDocument();
  expect(document.querySelector('dd.null')).toHaveTextContent('—');
});

test('Escape, the backdrop and Details all leave; the page opens directly', async () => {
  const user = userEvent.setup();
  let onClose = draw();
  await screen.findByText('Replace pump', { selector: 'h2' });
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Details →' }));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(opened).toEqual([['work_order', { id: 8 }, '#8', 'push', { direct: true }]]);
  cleanup();
  // The scrim is a dialog's (Modal.tsx): a press on it closes the glance, as it does every dialog.
  onClose = draw();
  await screen.findByText('Replace pump', { selector: 'h2' });
  await user.click(document.querySelector('.peekpanel-glance-backdrop')!);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a glance from a list steps through it with J, K and the arrows, and not while typing', async () => {
  const user = userEvent.setup();
  const records = [
    { key: { id: 7 }, label: '#7' },
    { key: { id: 8 }, label: '#8' },
    { key: { id: 9 }, label: '#9' },
  ];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PeekPanel tableId="work_order" recordKey={{ id: 8 }} label="#8" onClose={() => {}} records={records} />
    </QueryClientProvider>,
  );
  const at = () => document.querySelector('.record-trail-at');
  expect(at()).toHaveTextContent('2 of 3');
  fireEvent.keyDown(document, { key: 'j' });
  expect(screen.getByRole('dialog', { name: '#9 — a glance' })).toBeInTheDocument();
  expect(at()).toHaveTextContent('3 of 3');
  expect(screen.getByRole('button', { name: 'Next record' })).toBeDisabled();
  fireEvent.keyDown(document, { key: 'k' });
  await user.click(screen.getByRole('button', { name: 'Previous record' }));
  expect(at()).toHaveTextContent('1 of 3');
  expect(screen.getByRole('button', { name: 'Previous record' })).toBeDisabled();
  const field = document.body.appendChild(document.createElement('input'));
  field.focus();
  fireEvent.keyDown(field, { key: 'j' });
  expect(at()).toHaveTextContent('1 of 3');
  field.remove();
});

test("a glance given its list's page steps past the edge with the list's own question", async () => {
  const records = [
    { key: { id: 7 }, label: '#7' },
    { key: { id: 8 }, label: '#8' },
  ];
  const list = { query: 'work_order closed_at = null', offset: 0, limit: 2, total: 3 };
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PeekPanel tableId="work_order" recordKey={{ id: 8 }} label="#8" onClose={() => {}} records={records} list={list} />
    </QueryClientProvider>,
  );
  const at = () => document.querySelector('.record-trail-at');
  expect(at()).toHaveTextContent('2 of 3');
  expect(screen.getByRole('button', { name: 'Next record' })).toBeEnabled();
  fireEvent.keyDown(document, { key: 'j' });
  await screen.findByRole('dialog', { name: 'Fix valve — a glance' });
  expect(at()).toHaveTextContent('3 of 3');
  expect(calls).toContainEqual({ q: 'work_order closed_at = null', limit: 2, offset: 2, count: 'none' });
  expect(screen.getByRole('button', { name: 'Next record' })).toBeDisabled();
});

test('a glance at a lone record has nowhere to step', async () => {
  draw();
  await screen.findByText('Replace pump', { selector: 'h2' });
  expect(document.querySelector('.record-trail')).toBeNull();
});

test('a row that is gone says so', async () => {
  row = null;
  draw();
  await screen.findByText('That record is no longer there.');
});

test('a glance holds the focus like a dialog, and stays a read-only glance', async () => {
  draw();
  const dialog = await screen.findByRole('dialog', { name: '#8 — a glance' });
  /* It covers the list's right side, so Tab must not walk on under it. */
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  await screen.findByText('Replace pump', { selector: 'h2' });
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
});

test('the focus moves to the title on open, and J steps without dropping it: only the record is drawn anew', async () => {
  const records = [
    { key: { id: 7 }, label: '#7' },
    { key: { id: 8 }, label: '#8' },
    { key: { id: 9 }, label: '#9' },
  ];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PeekPanel tableId="work_order" recordKey={{ id: 7 }} label="#7" onClose={() => {}} records={records} />
    </QueryClientProvider>,
  );
  const dialog = screen.getByRole('dialog', { name: '#7 — a glance' });
  const title = dialog.querySelector('h2')!;
  // On the title rather than a button: the Space that opened the glance is released after.
  await waitFor(() => expect(title).toHaveFocus());
  fireEvent.keyDown(document, { key: 'j' });
  expect(screen.getByRole('dialog', { name: '#8 — a glance' })).toBe(dialog);
  expect(dialog.querySelector('h2')).toBe(title);
  expect(title).toHaveFocus();
  // A step pressed from the keyboard keeps its button, and the focus on it.
  const next = screen.getByRole('button', { name: 'Next record' });
  next.focus();
  fireEvent.click(next);
  expect(screen.getByRole('dialog', { name: '#9 — a glance' })).toBe(dialog);
  expect(next.isConnected).toBe(true);
  expect(document.activeElement).toBe(next);
});
