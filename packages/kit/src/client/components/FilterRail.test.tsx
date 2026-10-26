/**
 * The rail, drawn and driven: facets over a question, writing it back
 * through onChange, against a breakdown that counts like the server would.
 * The rules underneath are filterRailModel's (its own tests); this is what
 * a reader sees and presses.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { humanName } from '../../../../engine/src/shared/model.js';

const asked: string[] = [];
/* How many breakdowns each /api/breakdowns request carried. */
const batches: number[] = [];
const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const rep: TableMeta = {
  id: 'rep',
  name: 'rep',
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
    col('status', 'TEXT', { allowed: ['open', 'in_progress', 'done'] }),
    col('is_urgent', 'BOOLEAN'),
    col('due_on', 'DATE'),
    col('owner_id', 'INTEGER', { references: { table: 'rep', column: 'id' } }),
  ] as TableMeta['columns'],
};

/* In an App a condition is said in its words; the Workbench, which has no App, keeps the language. */
let inApp = true;

vi.mock('../core.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    // An App registers its words for every column; the Workbench registers none.
    columnLabel: (_table: string, column: string) => (inApp ? humanName(column) : null),
    state: {
      activeConnection: 'demo',
      page: 0,
      schema: {
        tables: [task, rep],
        foreignKeys: [{ from: { table: 'task', columns: ['owner_id'] }, to: { table: 'rep', columns: ['id'] } }],
      },
    },
    findTable: (id: string) => (id === 'task' ? task : id === 'rep' ? rep : undefined),
    api: async (path: string, body: { text?: string; q?: string; items?: Array<{ text: string }> }) => {
      if (path === '/api/breakdowns') {
        batches.push(body.items!.length);
        return { results: body.items!.map((item) => ({ status: 200, body: breakdown(item.text) })) };
      }
      if (path === '/api/breakdown') return breakdown(String(body.text));
      // A reference's name, read as its box reads it.
      if (path === '/api/run' && String(body.q).startsWith('rep id = ')) return { rows: [{ name: 'Tariq Osei' }], errors: [] };
      if (path === '/api/run') return { total: String(body.q).includes('done') ? 5 : 40, rows: [], errors: [] };
      return {};
    },
  };
});

/* Counts like the server would, for one breakdown alone or one item of a batch. */
function breakdown(text: string) {
  asked.push(text);
  if (text.includes('by status'))
    return {
      columns: ['status', 'count'],
      rows: [
        { status: 'open', count: 12 },
        { status: 'done', count: 1234 },
      ],
    };
  if (text.includes('by title'))
    return {
      columns: ['title', 'count'],
      rows: [
        { title: 'Pump', count: 4 },
        { title: 'Valve', count: 2 },
      ],
    };
  if (text.includes('by is_urgent'))
    return {
      columns: ['is_urgent', 'count'],
      rows: [
        { is_urgent: 0, count: 30 },
        { is_urgent: 1, count: 7 },
      ],
    };
  if (text.includes('by owner_id')) {
    return {
      columns: ['owner_id', 'owner_id.name', 'count'],
      rows: [
        { owner_id: 14, 'owner_id.name': 'Nia Andersen', count: 9 },
        { owner_id: 3, 'owner_id.name': 'Tariq Osei', count: 2 },
      ],
    };
  }
  return { columns: [], rows: [] };
}

const { FacetFor, FilterRail, FilterSheet } = await import('./FilterRail.js');
const { boxesFor } = await import('./FilterBoxes.js');

const words: Record<string, string> = { title: 'Task', status: 'Status', is_urgent: 'Urgent', due_on: 'Due', owner_id: 'Owner' };
const boxes = boxesFor(task, ['title', 'status', 'is_urgent', 'due_on', 'owner_id'], (name) => words[name]);

function draw(refinement: string, props: { tabQuery?: string; status?: string } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onChange = vi.fn();
  const wrap = (node: ReactNode) => <QueryClientProvider client={client}>{node}</QueryClientProvider>;
  const rail = (text: string) => <FilterRail table={task} boxes={boxes} refinement={text} onChange={onChange} {...props} />;
  const view = render(wrap(rail(refinement)));
  return { onChange, redraw: (text: string) => view.rerender(wrap(rail(text))) };
}

beforeEach(() => {
  inApp = true;
  asked.length = 0;
  batches.length = 0;
});
afterEach(() => cleanup());

test('a vocabulary is a checklist of its values, counted under everything else, blank until known', async () => {
  draw('status = open and is_urgent = true sort due_on');
  const status = screen.getByRole('group', { name: 'Status' });
  // In the vocabulary's own order, before any count has arrived.
  expect(
    within(status)
      .getAllByRole('checkbox')
      .map((box) => box.getAttribute('data-value')),
  ).toEqual(['open', 'in_progress', 'done']);
  expect(within(status).getByRole('checkbox', { name: /^Open/ })).toBeChecked();
  expect(await within(status).findByRole('checkbox', { name: 'Done 1,234' })).not.toBeChecked();
  // A value with no rows is still a value, and says so.
  expect(within(status).getByRole('checkbox', { name: 'In progress 0' })).toBeInTheDocument();
  // Counted without the facet's own condition, the sort or the page.
  expect(asked).toContain('task is_urgent = true count by status sort count desc');
});

test("ticking a second value is an in, in the vocabulary's order; unticking back to one is an equality", async () => {
  const user = userEvent.setup();
  const { onChange, redraw } = draw('status = done sort due_on');
  await user.click(screen.getByRole('checkbox', { name: /^In progress/ }));
  expect(onChange).toHaveBeenLastCalledWith('status in (in_progress, done) sort due_on');
  redraw('status in (in_progress, done) sort due_on');
  await user.click(screen.getByRole('checkbox', { name: /^Done/ }));
  expect(onChange).toHaveBeenLastCalledWith('status = in_progress sort due_on');
});

test('a reference lists its targets by name, the most first, and writes their ids', async () => {
  const user = userEvent.setup();
  const { onChange } = draw('');
  const owner = screen.getByRole('group', { name: 'Owner' });
  await user.click(await within(owner).findByRole('checkbox', { name: 'Nia Andersen 9' }));
  expect(onChange).toHaveBeenLastCalledWith('owner_id = 14');
  expect(asked).toContain('task count by owner_id, owner_id.name sort count desc');
});

test('a flag is a toggle with its count; a date takes a preset or a range; a text box searches on Enter', async () => {
  const user = userEvent.setup();
  const { onChange } = draw('');
  await user.click(await screen.findByRole('checkbox', { name: 'Urgent 7' }));
  expect(onChange).toHaveBeenLastCalledWith('is_urgent = true');

  const due = screen.getByRole('group', { name: 'Due' });
  expect(
    within(due)
      .getAllByRole('radio')
      .map((radio) => radio.closest('label')!.textContent),
  ).toEqual(['Overdue', 'Today', 'This week', 'Next 7 days', 'No date']);
  await user.click(within(due).getByRole('radio', { name: 'Next 7 days' }));
  expect(onChange).toHaveBeenLastCalledWith('due_on = next 7 days');
  // A range applies on Enter or leaving the box, not on every keystroke of a year.
  const from = within(due).getByLabelText('From');
  fireEvent.change(from, { target: { value: '2026-01-01' } });
  expect(onChange).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(from, { key: 'Enter' });
  expect(onChange).toHaveBeenLastCalledWith('due_on >= 2026-01-01');

  await user.type(screen.getByLabelText('Task'), 'call{Enter}');
  expect(onChange).toHaveBeenLastCalledWith('title contains call');
});

test("Clear takes one facet out; Clear all takes the rail's out and leaves the lit tab standing", async () => {
  const user = userEvent.setup();
  const tab = 'status = open sort due_on';
  const { onChange, redraw } = draw('status = open and is_urgent = true and due_on = today sort due_on', { tabQuery: tab });
  // A ticked flag is its own Clear: the box, not a second button beside it.
  expect(screen.queryByRole('button', { name: 'Clear Urgent' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('checkbox', { name: /^Urgent/ }));
  expect(onChange).toHaveBeenLastCalledWith('status = open and due_on = today sort due_on');
  await user.click(screen.getByRole('button', { name: 'Clear Due' }));
  expect(onChange).toHaveBeenLastCalledWith('status = open and is_urgent = true sort due_on');
  await user.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(onChange).toHaveBeenLastCalledWith(tab);
  // Only the tab's own conditions: nothing of the rail's to clear.
  redraw(tab);
  expect(screen.queryByRole('button', { name: 'Clear all' })).not.toBeInTheDocument();
});

test('a condition a facet cannot draw is said, and kept until the reader picks', async () => {
  draw('status != open');
  const status = screen.getByRole('group', { name: 'Status' });
  expect(await within(status).findByText('Status is not Open')).toHaveClass('facet-note');
  expect(
    within(status)
      .getAllByRole('checkbox')
      .some((box) => (box as HTMLInputElement).checked),
  ).toBe(false);
});

test('what the list matches is said politely', () => {
  draw('', { status: '37 match' });
  expect(screen.getByRole('status')).toHaveTextContent('37 match');
});

function sheet(refinement: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onApply = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <FilterSheet table={task} boxes={boxes} refinement={refinement} onApply={onApply} onClose={onClose} />
    </QueryClientProvider>,
  );
  return { onApply, onClose };
}

test('the sheet edits a draft, counts it, and applies it only on Show', async () => {
  const user = userEvent.setup();
  const { onApply } = sheet('status = open');
  const dialog = await screen.findByRole('dialog', { name: 'Filters' });
  await user.click(within(dialog).getByRole('checkbox', { name: /^Done/ }));
  expect(within(dialog).getByRole('checkbox', { name: /^Done/ })).toBeChecked();
  expect(onApply).not.toHaveBeenCalled();
  await user.click(await within(dialog).findByRole('button', { name: 'Show 5' }));
  expect(onApply).toHaveBeenCalledWith('status in (open, done)');
});

test('Cancel closes the sheet and applies nothing', async () => {
  const user = userEvent.setup();
  const { onApply, onClose } = sheet('status = open');
  const dialog = await screen.findByRole('dialog', { name: 'Filters' });
  await user.click(within(dialog).getByRole('checkbox', { name: /^Done/ }));
  await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onApply).not.toHaveBeenCalled();
});

test("the rail's facets are counted in one request, not one each", async () => {
  draw('');
  await screen.findByRole('checkbox', { name: 'Nia Andersen 9' });
  await screen.findByRole('checkbox', { name: 'Urgent 7' });
  const counted = asked.filter((text) => text.includes(' count by '));
  expect(counted.length).toBeGreaterThanOrEqual(3);
  expect(batches.reduce((a, b) => a + b, 0)).toBe(asked.length);
  expect(batches).toHaveLength(1);
});

test('the rarer conditions sit behind one quiet More conditions in each facet, the same control a column menu opens', async () => {
  const { onChange } = draw('');
  const status = screen.getByRole('group', { name: 'Status' });
  const more = within(status).getByRole('button', { name: 'More conditions' });
  expect(within(status).queryByRole('radio', { name: 'Is empty' })).toBeNull();
  await userEvent.click(more);
  expect(more).toHaveAttribute('aria-expanded', 'true');
  await userEvent.click(within(status).getByRole('radio', { name: 'Is empty' }));
  expect(onChange).toHaveBeenLastCalledWith('status is empty');
});

test('a rarer condition set anywhere reads back open, chosen and filled, not as language', () => {
  draw('title startswith Har and status = open');
  const title = document.querySelector<HTMLElement>('.facet[data-column="title"]')!;
  expect(within(title).getByRole('button', { name: 'More conditions' })).toHaveAttribute('aria-expanded', 'true');
  expect(within(title).getByRole('radio', { name: 'Starts with' })).toBeChecked();
  expect(within(title).getByRole('textbox', { name: 'Starts with' })).toHaveValue('Har');
  expect(title).not.toHaveTextContent('startswith');
});

test('a facet’s note names a reference by its record, and without an App keeps the language', async () => {
  draw('owner_id != 3');
  const owner = screen.getByRole('group', { name: 'Owner' });
  expect(await within(owner).findByText(/is not Tariq Osei$/)).toHaveClass('facet-note');
  cleanup();
  inApp = false;
  draw('status != open');
  expect(within(screen.getByRole('group', { name: 'Status' })).getByText('status != open')).toHaveClass('facet-note');
});

test('in a column’s own picker the name column with a few values offers them with their counts, not a contains box', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const title = boxes.find((box) => box.column === 'title')!;
  const facet = (picking: boolean, refinement = '') => (
    <QueryClientProvider client={client}>
      <FacetFor box={title} table={task} refinement={refinement} set={() => {}} picking={picking} />
    </QueryClientProvider>
  );
  const view = render(facet(true));
  expect(await screen.findByRole('checkbox', { name: 'Pump 4' })).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Valve 2' })).toBeInTheDocument();
  expect(asked).toContain('task count by title sort count desc');
  // A contains already asked stays the box that asked it, and the rail keeps its name as the search box.
  view.rerender(facet(true, 'title contains pu'));
  expect(screen.queryByRole('checkbox', { name: 'Pump 4' })).toBeNull();
  view.rerender(facet(false));
  expect(screen.queryByRole('checkbox', { name: 'Pump 4' })).toBeNull();
});
