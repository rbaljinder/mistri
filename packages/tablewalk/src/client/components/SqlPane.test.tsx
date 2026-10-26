/**
 * The SQL pane: a statement run, its result drawn or its error kept in
 * the database's own words, and rows that open as records when the
 * columns can say whose they are.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const customer: TableMeta = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('name', 'TEXT'),
    col('credit_limit', 'REAL'),
  ] as TableMeta['columns'],
};
const calls: Array<Record<string, unknown>> = [];
const gone: unknown[] = [];
const toasts: string[] = [];
let reply: Record<string, unknown> = {};
vi.mock('../../../../kit/src/client/core.js', () => ({
  state: {
    activeConnection: 'demo',
    page: 0,
    schema: { label: 'shop', dialect: 'sqlite', tables: [customer], foreignKeys: [] },
    connections: [{ id: 'demo', writable: true }],
  },
  api: async (_path: string, body: Record<string, unknown>) => {
    calls.push(body);
    return reply;
  },
  go: (e: unknown, mode: string) => gone.push([e, mode]),
  render: () => {},
  toast: (m: string) => toasts.push(m),
  el: (tag: string, attrs: Record<string, unknown> = {}) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'hidden') (node as HTMLElement).hidden = Boolean(v);
      else node.setAttribute(k, String(v));
    }
    return node;
  },
  findTable: (id: string) => (id === 'customer' ? customer : undefined),
  columnKind,
  columnDisplay: () => null,
  columnLabel: () => null,
  emptyWord: () => 'null',
  prefersPages: () => false,
  currentEntry: () => null,
  refsTo: () => [],
  refsFrom: () => [],
  keyOf: () => null,
  rowLabel: () => '',
  openRecord: () => {},
  tableView: () => ({}),
  quote: (v: unknown) => String(v),
  labelColumn: () => null,
  primaryKey: (t: TableMeta) => t.columns.filter((c) => c.primaryKey).map((c) => c.name),
  loadJson: () => ({}),
  saveJson: () => true,
  viewportBox: (n: Element) => n.getBoundingClientRect(),
}));
vi.mock('../sqlcomplete.js', () => ({ sqlSuggestions: () => [], tokenAt: () => ({ word: '', start: 0 }) }));
vi.mock('../../../../kit/src/client/prompt.js', () => ({ promptFor: async () => 'Over limit' }));
const kept: Array<{ name: string; sql: string; source: string }> = [];
vi.mock('../sqlsaved.js', () => ({
  savedStatements: () => kept,
  saveStatement: (name: string, sql: string) => {
    kept.push({ name, sql, source: 'saved' });
    return true;
  },
  removeStatement: (name: string) => {
    const i = kept.findIndex((k) => k.name === name);
    if (i >= 0) kept.splice(i, 1);
  },
}));

const { SqlPane } = await import('./SqlPane.js');

function draw(draft = '') {
  const client = new QueryClient();
  const onClose = vi.fn();
  const onDraft = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <div className="sql-panel">
        <SqlPane draft={draft} onDraft={onDraft} onClose={onClose} />
      </div>
    </QueryClientProvider>,
  );
  return { onClose, onDraft };
}

afterEach(() => {
  cleanup();
  calls.length = 0;
  gone.length = 0;
  toasts.length = 0;
  kept.length = 0;
  reply = {};
});

test('names the database, runs on ⌘↵, and draws the rows walkable when the key is there', async () => {
  const user = userEvent.setup();
  reply = {
    columns: ['id', 'name'],
    rows: [
      [1, 'Nia'],
      [2, 'Ola'],
    ],
    ms: 3,
    truncated: true,
    bounded: false,
  };
  const { onClose, onDraft } = draw('select id, name from customer');
  expect(document.querySelector('.sql-target')).toHaveTextContent('shop · sqlite');
  const input = screen.getByRole('combobox', { name: 'SQL statement' });
  expect(input).toHaveFocus();
  await user.type(input, ' limit 2');
  expect(onDraft).toHaveBeenLastCalledWith('select id, name from customer limit 2');
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true });
  await screen.findByText('2 rows');
  expect(calls).toEqual([{ text: 'select id, name from customer limit 2', limit: 500, write: false }]);
  expect(document.querySelector('.sql-truncated')).toHaveTextContent('first 2 of what the database returned');
  expect(document.querySelector('.sql-walk')).toHaveTextContent('Rows open as customer records.');
  await user.click(screen.getByText('Ola'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(gone).toEqual([[{ kind: 'row', table: 'customer', key: { id: 2 }, label: '2' }, 'reset']]);
});

test('an error is kept in the database’s words; no rows still says the shape', async () => {
  const user = userEvent.setup();
  reply = { errors: [{ message: 'no such table: custmer' }] };
  draw('select * from custmer');
  await user.click(screen.getByRole('button', { name: 'Run ⌘↵' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no such table: custmer');
  reply = { columns: ['id'], rows: [], ms: 1 };
  await user.click(screen.getByRole('button', { name: 'Run ⌘↵' }));
  await screen.findByText('No rows.');
  expect(document.querySelector('.sql-empty')).toHaveTextContent('The statement returned these columns: id.');
});

test('a write shows the statement first and runs on the write connection', async () => {
  const user = userEvent.setup();
  reply = { affected: 3 };
  draw('update customer set credit_limit = 0');
  await user.click(screen.getByRole('button', { name: 'Run as write…' }));
  expect(screen.getByRole('dialog').querySelector('pre')).toHaveTextContent('update customer set credit_limit = 0');
  await user.click(screen.getByRole('button', { name: 'Run as write' }));
  await screen.findByText('3 rows changed.');
  expect(calls).toEqual([{ text: 'update customer set credit_limit = 0', limit: 500, write: true }]);
  expect(toasts).toEqual(['3 rows changed.']);
});

test('a saved statement becomes a chip that fills the box, and can be forgotten', async () => {
  const user = userEvent.setup();
  draw('select 1');
  await user.click(screen.getByRole('button', { name: 'Save…' }));
  const chip = await screen.findByRole('button', { name: 'Over limit' });
  const input = screen.getByRole('combobox', { name: 'SQL statement' }) as HTMLTextAreaElement;
  input.value = '';
  await user.click(chip);
  expect(input.value).toBe('select 1');
  await user.click(screen.getByRole('button', { name: 'Forget Over limit' }));
  expect(screen.queryByRole('button', { name: 'Over limit' })).toBeNull();
});
