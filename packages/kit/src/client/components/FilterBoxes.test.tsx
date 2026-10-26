/**
 * The filter boxes: what kind of box a column gets, what tail each speaks,
 * and the workbench bar that folds only touched boxes into the text.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind, labelColumn, looksLikeDate, primaryKey } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const owner: TableMeta = {
  id: 'owner',
  name: 'owner',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [col('id', 'INTEGER', { primaryKey: true, nullable: false }), col('name', 'TEXT')] as TableMeta['columns'],
};
const task: TableMeta = {
  id: 'task',
  name: 'task',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('title', 'TEXT'),
    col('priority', 'INTEGER'),
    col('status', 'TEXT', { allowed: ['open', 'done'] }),
    col('is_urgent', 'INTEGER'),
    col('due_on', 'DATE'),
    col('owner_id', 'INTEGER', { references: { table: 'owner', column: 'id' } }),
  ] as TableMeta['columns'],
};
const fks = [{ name: 'task_owner', from: { table: 'task', columns: ['owner_id'] }, to: { table: 'owner', columns: ['id'] } }];
const calls: string[] = [];
/* An App labels its columns; the Workbench registers none (core.columnLabel). */
const appLabels = { on: false };
const lookup = vi.fn();

import { quoteValue } from '../../../../engine/src/shared/query.js';
vi.mock('../core.js', () => ({
  columnLabel: (_table: string, name: string) => (appLabels.on ? name : null),
  state: { activeConnection: 'demo', page: 2, schema: { tables: [task, owner], foreignKeys: fks } },
  api: async (_path: string, body: { q: string; conn?: string }) => {
    calls.push(body.q);
    if (body.q.includes('sort')) return lookup(body);
    return { rows: [{ name: 'Nia Andersen' }] };
  },
  findTable: (id: string) => (id === 'task' ? task : id === 'owner' ? owner : undefined),
  labelColumn,
  labelPath: (table: TableMeta) => labelColumn(table),
  primaryKey,
  columnKind,
  looksLikeDateColumn: (c: never) => looksLikeDate(c),
  quote: quoteValue,
  go: () => {},
  tableView: () => ({}),
  toast: () => {},
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../prompt.js', () => ({ promptFor: async () => null }));

const { FilterBar, boxesFor, boxTail, wrongForNumber } = await import('./FilterBoxes.js');

function draw(query: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigate = vi.fn();
  render(
    createElement(
      QueryClientProvider,
      { client },
      <FilterBar
        table={task}
        entry={{ table: 'task', query }}
        names={['title', 'priority', 'status', 'is_urgent', 'due_on', 'owner_id']}
        navigate={navigate}
      />,
    ),
  );
  return { navigate };
}

beforeEach(() => {
  lookup.mockReset();
  lookup.mockResolvedValue({
    rows: [
      { name: 'Nia Andersen', id: 14 },
      { name: 'Nia Patel', id: 22 },
    ],
  });
});
afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe('what kind of box a column gets', () => {
  test('its type decides, not its position', () => {
    const boxes = boxesFor(task, ['title', 'priority', 'status', 'is_urgent', 'due_on', 'owner_id'], (n) => n);
    expect(boxes.map((b) => b.kind)).toEqual(['text', 'text', 'enum', 'flag', 'date', 'ref']);
  });

  test('a text box searches, a number is named, and = asks for exactly', () => {
    const [title, priority] = boxesFor(task, ['title', 'priority'], (n) => n);
    expect(boxTail(title, { raw: 'fix' }, '')).toBe('contains fix');
    expect(boxTail(title, { raw: '=Fix the door' }, '')).toBe('= "Fix the door"');
    expect(boxTail(priority, { raw: '2' }, '')).toBe('= 2');
    // Untouched, a box reads back exactly what the text says.
    expect(boxTail(title, undefined, 'contains "a and b"')).toBe('contains "a and b"');
    expect(boxTail(title, { raw: '' }, 'contains x')).toBe('');
  });

  test('words in a number box are not sent: the database refuses them, and the box says what it takes', () => {
    const [title, priority] = boxesFor(task, ['title', 'priority'], (n) => n);
    expect(wrongForNumber(priority, 'stone')).toBe(true);
    expect(boxTail(priority, { raw: 'stone' }, '= 2')).toBe('= 2');
    expect(boxTail(priority, { raw: 'stone' }, '')).toBe('');
    for (const number of ['2', '-3', '2.5', '=7', '1e3', '9007199254740993']) expect(wrongForNumber(priority, number)).toBe(false);
    expect(wrongForNumber(title, 'stone')).toBe(false);
  });

  test('an API table gets boxes only for what it can filter, each asking for a whole value', async () => {
    const { deriveFilterNames } = await import('../filterbar.js');
    // An API filters where it documents a parameter; `contains` is not one it takes.
    const api: TableMeta = { ...task, id: 'api_task', filterable: ['title', 'status'] };
    expect(deriveFilterNames(api)).toEqual(['status', 'title']);
    const [title] = boxesFor(api, ['title'], (n) => n);
    expect(boxTail(title, { raw: 'fix' }, '')).toBe('= fix');
  });

  test('a reference box speaks the id it picked, or the name typed', () => {
    const [ownerBox] = boxesFor(task, ['owner_id'], (n) => n);
    expect(boxTail(ownerBox, { raw: 'Nia Andersen', id: '14' }, '')).toBe('= 14');
    expect(boxTail(ownerBox, { raw: '7', id: null }, '')).toBe('= 7');
    // A picked key is a value like any other: a slug carrying `select` is quoted, or it reads as a clause.
    expect(boxTail(ownerBox, { raw: 'Mazda CX-5', id: '2023-mazda-cx-5-select' }, '')).toBe('= "2023-mazda-cx-5-select"');
  });
});

describe('the workbench bar', () => {
  test('opening a reference offers names without typing, scoped to its connection', async () => {
    const user = userEvent.setup();
    const { navigate } = draw('task');
    await user.click(screen.getByRole('combobox', { name: 'Filter by owner_id' }));
    await user.click(await screen.findByRole('option', { name: 'Nia Patel 22' }));
    expect(lookup).toHaveBeenCalledWith({ conn: 'demo', q: 'owner show name, id sort name limit 8', limit: 8, count: 'none' });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('task owner_id = 22'));
  });

  test('in an App a reference is picked by its name alone: no key under it, no query in its tooltip', async () => {
    appLabels.on = true;
    try {
      const user = userEvent.setup();
      draw('task');
      await user.click(screen.getByRole('combobox', { name: 'Filter by owner_id' }));
      const option = await screen.findByRole('option', { name: 'Nia Patel' });
      expect(option.querySelector('.dd-detail')).toBeNull();
    } finally {
      appLabels.on = false;
    }
  });

  test('pending and empty lookups have a status inside the themed list', async () => {
    const user = userEvent.setup();
    let resolve!: (value: { rows: unknown[] }) => void;
    lookup.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    draw('task');
    await user.click(screen.getByRole('combobox', { name: 'Filter by owner_id' }));
    const loading = await screen.findByRole('status');
    expect(loading).toHaveTextContent('Loading...');
    expect(loading.closest('.dd-list')).not.toBeNull();
    await act(async () => {
      resolve({ rows: [] });
    });
    await vi.waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('No records available.'));
  });

  test('no matches remains visible and a failed lookup offers reopening to retry', async () => {
    const user = userEvent.setup();
    lookup.mockResolvedValue({ rows: [] });
    draw('task');
    const box = screen.getByRole('combobox', { name: 'Filter by owner_id' });
    await user.type(box, 'missing');
    await screen.findByText('Nothing matches.');
    await user.keyboard('{Escape}');
    lookup.mockRejectedValue(new Error('internal database details'));
    await user.clear(box);
    await user.click(box);
    await screen.findByText('Could not load records. Close and reopen to retry.');
    expect(screen.queryByText('internal database details')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    lookup.mockResolvedValue({ rows: [{ id: 14, name: 'Nia Andersen' }] });
    await user.click(box);
    await screen.findByRole('option', { name: 'Nia Andersen 14' });
  });

  test('a late lookup answer does not reopen a dismissed popup', async () => {
    const user = userEvent.setup();
    let resolve!: (value: { rows: unknown[] }) => void;
    lookup.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    draw('task');
    const box = screen.getByRole('combobox', { name: 'Filter by owner_id' });
    await user.click(box);
    await screen.findByText('Loading...');
    await user.keyboard('{Escape}');
    await act(async () => {
      resolve({ rows: [{ id: 14, name: 'Nia Andersen' }] });
    });
    expect(box).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
  });

  test('query errors returned with HTTP success are failures, not empty results', async () => {
    const user = userEvent.setup();
    lookup.mockResolvedValue({ errors: [{ message: 'private schema detail' }] });
    draw('task');
    await user.click(screen.getByRole('combobox', { name: 'Filter by owner_id' }));
    await screen.findByText('Could not load records. Close and reopen to retry.');
    expect(screen.queryByText('No records available.')).not.toBeInTheDocument();
    expect(screen.queryByText('private schema detail')).not.toBeInTheDocument();
  });

  test('folds only touched boxes into the text, and a pick submits itself', async () => {
    const user = userEvent.setup();
    const { navigate } = draw('task due_on = last 30 days');
    // The untouched date box reads its phrase back and leaves it alone.
    expect(screen.getByRole('button', { name: 'Filter by due_on' })).toHaveTextContent('last 30 days');
    await user.type(screen.getByRole('textbox', { name: 'Filter by priority' }), '2');
    expect(navigate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    expect(navigate).toHaveBeenCalledWith('task due_on = last 30 days and priority = 2');
    await user.click(screen.getByRole('button', { name: 'Filter by status' }));
    await user.click(screen.getByRole('option', { name: 'done' }));
    await vi.waitFor(() => expect(navigate).toHaveBeenLastCalledWith('task due_on = last 30 days and priority = 2 and status = done'));
  });

  test('a flag is one gesture, and Clear goes back to the bare table', async () => {
    const user = userEvent.setup();
    const { navigate } = draw('task priority = 2');
    await user.click(screen.getByRole('checkbox', { name: 'Only is_urgent' }));
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('task priority = 2 and is_urgent = true'));
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(navigate).toHaveBeenLastCalledWith('task');
  });

  test('a reference box shows the name behind an id, and a pick writes the id', async () => {
    const user = userEvent.setup();
    const { navigate } = draw('task owner_id = 14');
    const box = screen.getByRole('combobox', { name: 'Filter by owner_id' });
    await vi.waitFor(() => expect(box).toHaveValue('Nia Andersen'));
    expect(box).toHaveAttribute('title', 'owner_id = 14');
    await user.clear(box);
    await user.type(box, 'Nia');
    const option = await screen.findByText('Nia Patel');
    await user.click(option.closest('[role="option"]')!);
    expect(box).toHaveValue('Nia Patel');
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('task owner_id = 22'));
  });
});
