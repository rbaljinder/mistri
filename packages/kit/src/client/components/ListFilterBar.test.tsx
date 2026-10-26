/**
 * An App list's filter bar, drawn and driven: the search box that folds its
 * text in on Enter, a "+" per declared filter that opens its picker as a
 * draft applied by one button, a flag's "+" that is one gesture, chips that
 * say what applies and come out by × or Backspace, one Clear all past two,
 * the lit tab's own column left unchipped, and a phone's one Filters button.
 * The conditions underneath are filterbar's and filterRailModel's; this is
 * what a reader sees and presses.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { humanName } from '../../../../engine/src/shared/model.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
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
    state: { activeConnection: 'demo', page: 0, schema: { tables: [task], foreignKeys: [] } },
    findTable: (id: string) => (id === 'task' ? task : undefined),
    api: async (path: string, body: { text?: string }) => {
      if (path === '/api/breakdown' && String(body.text).includes('by status'))
        return {
          columns: ['status', 'count'],
          rows: [
            { status: 'open', count: 12 },
            { status: 'done', count: 3 },
          ],
        };
      if (path === '/api/run') return { total: 15, rows: [], errors: [] };
      return { columns: [], rows: [] };
    },
  };
});

const { ListFilterBar } = await import('./ListFilterBar.js');
const { boxesFor } = await import('./FilterBoxes.js');

const words: Record<string, string> = { title: 'Title', status: 'Status', is_urgent: 'Urgent' };
const boxes = boxesFor(task, ['title', 'status', 'is_urgent'], (name) => words[name]);

let refinement = '';
const apply = vi.fn();
const onType = vi.fn();
const onSearch = vi.fn();
const onSheet = vi.fn();
function draw(props: { refinement?: string; tabQuery?: string; phone?: boolean; typed?: string } = {}) {
  refinement = props.refinement ?? '';
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ListFilterBar
        table={task}
        boxes={boxes}
        search={boxes[0]}
        refinement={refinement}
        tabQuery={props.tabQuery ?? ''}
        standing=""
        unitOf={() => undefined}
        typed={props.typed}
        onType={onType}
        onSearch={onSearch}
        apply={apply}
        current={() => refinement}
        listLabel="Tasks"
        phone={props.phone ?? false}
        onSheet={onSheet}
      />
    </QueryClientProvider>,
  );
}
const chips = () => [...document.querySelectorAll('.applist-chip')].map((chip) => chip.getAttribute('data-column'));

beforeEach(() => {
  inApp = true;
  apply.mockReset();
  onType.mockReset();
  onSearch.mockReset();
  onSheet.mockReset();
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

test('the name column is a search box that reads the question and asks on Enter', async () => {
  draw({ refinement: 'title contains pump' });
  const box = screen.getByRole('searchbox', { name: 'Filter by Title' });
  expect(box).toHaveValue('pump');
  expect(box).toHaveAttribute('placeholder', 'Search tasks…');
  // The search's own condition is in its box, not said again as a chip.
  expect(chips()).toEqual([]);
  await userEvent.type(box, 's');
  expect(onType).toHaveBeenLastCalledWith('pumps');
  fireEvent.keyDown(box, { key: 'Enter' });
  expect(onSearch).toHaveBeenCalledOnce();
});

test('a "+" opens the picker on its first field, edits a draft, and applies it with one button', async () => {
  const user = userEvent.setup();
  draw();
  const plus = screen.getByRole('button', { name: 'Filter by Status' });
  await user.click(plus);
  const popup = await screen.findByRole('dialog', { name: 'Filter by Status' });
  await waitFor(() => expect(within(popup).getAllByRole('checkbox')[0]).toHaveFocus());
  await user.click(within(popup).getByRole('checkbox', { name: /^Open/ }));
  // A tick is a draft: nothing applies until the button says so.
  expect(apply).not.toHaveBeenCalled();
  await user.click(await within(popup).findByRole('button', { name: /^Show/ }));
  expect(apply).toHaveBeenCalledWith('status = open', 'status');
});

test('Escape closes a picker, applies nothing, and gives the focus back to its "+"', async () => {
  const user = userEvent.setup();
  draw();
  const plus = screen.getByRole('button', { name: 'Filter by Status' });
  await user.click(plus);
  await screen.findByRole('dialog', { name: 'Filter by Status' });
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Filter by Status' })).toBeNull());
  await waitFor(() => expect(plus).toHaveFocus());
  expect(apply).not.toHaveBeenCalled();
});

test('a flag’s "+" applies at once', async () => {
  draw();
  await userEvent.click(screen.getByRole('button', { name: 'Only Urgent' }));
  expect(apply).toHaveBeenCalledWith('is_urgent = true', 'is_urgent');
});

test('what applies is a chip in its filter’s place; × and Backspace take it out and keep the rest', async () => {
  draw({ refinement: 'status = open' });
  expect(chips()).toEqual(['status']);
  expect(screen.queryByRole('button', { name: 'Filter by Status' })).toBeNull();
  const remove = screen.getByRole('button', { name: /^Remove Status/ });
  await userEvent.click(remove);
  expect(apply).toHaveBeenLastCalledWith('', 'status');
  cleanup();

  draw({ refinement: 'status = open and is_urgent = true' });
  expect(chips()).toEqual(['status', 'is_urgent']);
  const status = document.querySelector('.applist-chip[data-column="status"] .applist-chip-open') as HTMLElement;
  fireEvent.keyDown(status, { key: 'Backspace' });
  expect(apply).toHaveBeenLastCalledWith('is_urgent = true', 'status');
});

test('Clear all appears past one filter and empties the row back to the search box', async () => {
  draw({ refinement: 'status = open' });
  expect(screen.queryByRole('button', { name: 'Clear all' })).toBeNull();
  cleanup();
  draw({ refinement: 'status = open and is_urgent = true' });
  await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(apply).toHaveBeenCalledWith('', 'title');
});

test('the lit tab’s own column is the tab’s to say: no chip, and its picker still opens', () => {
  draw({ refinement: 'status = open', tabQuery: 'status = open' });
  expect(chips()).toEqual([]);
  expect(screen.getByRole('button', { name: 'Filter by Status' })).toBeInTheDocument();
});

test('on a phone the pickers are one Filters button that counts what applies, and chips still come out', async () => {
  draw({ refinement: 'status = open', phone: true });
  expect(screen.queryByRole('button', { name: 'Filter by Status' })).toBeNull();
  const filters = screen.getByRole('button', { name: 'Filters · 1' });
  expect(filters).toHaveAttribute('aria-haspopup', 'dialog');
  await userEvent.click(filters);
  expect(onSheet).toHaveBeenCalledOnce();
  // A chip reopens the sheet rather than a popover.
  await userEvent.click(document.querySelector('.applist-chip[data-column="status"] .applist-chip-open') as HTMLElement);
  expect(onSheet).toHaveBeenCalledTimes(2);
  await userEvent.click(screen.getByRole('button', { name: /^Remove Status/ }));
  expect(apply).toHaveBeenLastCalledWith('', 'status');
});

test('a chip says its condition in words in an App, and in the language without one', () => {
  draw({ refinement: 'status != done and is_urgent = true' });
  const said = () => [...document.querySelectorAll('.applist-chip-text')].map((chip) => chip.textContent);
  expect(said()).toEqual(['Status is not Done', 'Is urgent is Yes']);
  expect(screen.getByRole('button', { name: 'Remove Status is not Done' })).toBeInTheDocument();
  cleanup();
  inApp = false;
  draw({ refinement: 'status != done' });
  expect(said()).toEqual(['status != done']);
});
