/**
 * An App list's column menu, drawn and driven: the entries a column of each
 * kind gets, the one popover Filter… opens (the rail's own facet, More
 * conditions and all), the rail it defers to, and what each choice hands the
 * list. The words and the drop rule are appColumnMenuModel's (its own tests).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { humanName } from '../../../../engine/src/shared/model.js';

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
    col('status', 'TEXT', { allowed: ['open', 'in_progress', 'done'], nullable: false }),
    col('due_on', 'DATE'),
    col('estimate', 'INTEGER'),
    col('owner_id', 'INTEGER', { references: { table: 'rep', column: 'id' } }),
  ] as TableMeta['columns'],
};
const pins: Array<[string, string | undefined]> = [];

/* In an App a condition is said in its words; the Workbench, which has no App, keeps the language. */
let inApp = true;

vi.mock('../core.js', async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  return {
    ...real,
    // An App registers its words for every column; the Workbench registers none.
    columnLabel: (_table: string, column: string) => (inApp ? humanName(column) : null),
    state: { activeConnection: 'demo', page: 0, schema: { tables: [task, rep], foreignKeys: [] } },
    findTable: (id: string) => (id === 'task' ? task : id === 'rep' ? rep : undefined),
    viewportSize: () => ({ width: 1000, height: 800 }),
    api: async (path: string, body: { q?: string; text?: string; items?: Array<{ text: string }> }) => {
      if (path === '/api/breakdowns') return { results: body.items!.map((item) => ({ status: 200, body: breakdown(item.text) })) };
      if (path === '/api/breakdown') return breakdown(String(body.text));
      if (path === '/api/run') return { total: String(body.q).includes('open') ? 4 : 40, rows: [], errors: [] };
      return {};
    },
  };
});
vi.mock('../pins.js', () => ({
  pinnedFor: () => [],
  pinsVersion: () => 0,
  subscribePins: () => () => {},
  togglePin: (_t: unknown, _c: unknown, name: string, list?: string) => pins.push([name, list]),
}));

/* Counts like the server would: a vocabulary's few values, a figure's many. */
function breakdown(text: string) {
  if (text.includes('by status'))
    return {
      columns: ['status', 'count'],
      rows: [
        { status: 'open', count: 4 },
        { status: 'done', count: 36 },
      ],
    };
  if (text.includes('by estimate'))
    return { columns: ['estimate', 'count'], rows: Array.from({ length: 30 }, (_, i) => ({ estimate: i, count: 1 })) };
  return { columns: [], rows: [] };
}

const { AppColumnMenuButton } = await import('./AppColumnMenu.js');
const { FilterPicker } = await import('./ListFilterBar.js');
const { boxesFor } = await import('./FilterBoxes.js');
const { columnKind } = await import('../../../../engine/src/shared/schema.js');

const labels: Record<string, string> = { title: 'Title', status: 'Status', due_on: 'Due', estimate: 'Estimate', owner_id: 'Owner' };
const kinds: Record<string, string> = { title: 'text', status: 'text', due_on: 'date', estimate: 'number', owner_id: 'number' };

function draw(
  name: string,
  over: { refinement?: string; query?: string; tabQuery?: string; current?: 'asc' | 'desc' | null; rail?: HTMLElement | null } = {},
) {
  const host = {
    current: {
      table: task,
      query: over.query ?? `task ${over.refinement ?? ''}`.trim(),
      refinement: over.refinement ?? '',
      tabQuery: over.tabQuery ?? '',
      standing: '',
      listKey: 'tasks',
      boxFor: (column: string) => boxesFor(task, [column], (n) => labels[n])[0],
      unitOf: () => undefined,
      apply: vi.fn(),
      navigate: vi.fn(),
      railFacet: () => over.rail ?? null,
      Picker: FilterPicker,
    },
  };
  const meta = task.columns.find((c) => c.name === name)!;
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AppColumnMenuButton
        host={host}
        name={name}
        label={labels[name]}
        kind={kinds[name] ?? columnKind(meta.type)}
        meta={meta}
        sortable
        current={over.current ?? null}
        columns={task.columns.map((c) => c.name)}
      />
    </QueryClientProvider>,
  );
  return host.current;
}

async function open(name: string) {
  await userEvent.click(screen.getByRole('button', { name: `${labels[name]} column options` }));
  return screen.findByRole('menu');
}
const entries = (menu: HTMLElement) =>
  within(menu)
    .getAllByRole('menuitem')
    .map((item) => item.textContent);

beforeEach(() => {
  inApp = true;
  pins.length = 0;
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('the entries', () => {
  test('each kind of column sorts in its own words, and nothing repeats the order it is in', async () => {
    draw('estimate', { current: 'asc' });
    expect(entries(await open('estimate'))).toEqual(['High → low', 'Filter…', 'Pin column']);
    cleanup();
    draw('due_on');
    expect(entries(await open('due_on'))).toEqual(['Oldest first', 'Newest first', 'Filter…', 'Pin column']);
    cleanup();
    // A vocabulary sorts in the order it was declared, and names its ends.
    draw('status');
    expect(entries(await open('status'))).toEqual(['Open → Done', 'Done → Open', 'Filter…', 'Pin column']);
  });

  test('a filtered column offers Clear filter; the menu hands the list what each choice asks', async () => {
    const host = draw('status', { refinement: 'status = open sort title' });
    // The words arrive on demand; the open menu says them once they have.
    const menu = await open('status');
    await waitFor(() =>
      expect(entries(menu)).toEqual(['Open → Done', 'Done → Open', 'Filter…', 'Clear filterStatus is Open', 'Pin column']),
    );
    // What it takes off, in words, under the verb.
    await userEvent.click(screen.getByRole('menuitem', { name: 'Clear filter: Status is Open' }));
    expect(host.apply).toHaveBeenCalledWith('sort title', 'status');
    await open('status');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Done → Open' }));
    expect(host.navigate).toHaveBeenCalledWith('task status = open sort status desc', 'status');
    await open('status');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Pin column' }));
    // The list's own pins, not its table's.
    expect(pins).toEqual([['status', 'tasks']]);
  });

  test('Clear filter says a date, a figure and a reference in words; without an App, only the verb', async () => {
    draw('due_on', { refinement: 'due_on < today and estimate >= 5' });
    expect(await within(await open('due_on')).findByRole('menuitem', { name: 'Clear filter: Due on before today' })).toBeInTheDocument();
    cleanup();
    draw('estimate', { refinement: 'estimate between 2 and 8' });
    expect(await within(await open('estimate')).findByRole('menuitem', { name: 'Clear filter: Estimate 2 – 8' })).toBeInTheDocument();
    cleanup();
    inApp = false;
    draw('estimate', { refinement: 'estimate >= 5' });
    expect(entries(await open('estimate'))).toContain('Clear filter');
  });

  test("the lit tab's own condition is the tab's: no Clear filter for it", async () => {
    draw('status', { refinement: 'status = open', tabQuery: 'status = open' });
    expect(entries(await open('status')).some((entry) => entry?.startsWith('Clear filter'))).toBe(false);
  });

  test('the arrows walk the entries and Escape hands the focus back to the ⌄', async () => {
    draw('due_on');
    const menu = await open('due_on');
    await vi.waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));
    await userEvent.keyboard('{ArrowDown}');
    await vi.waitFor(() => expect(document.activeElement).toHaveAttribute('role', 'menuitem'));
    const first = document.activeElement!.textContent;
    await userEvent.keyboard('{ArrowDown}');
    await vi.waitFor(() => expect(document.activeElement!.textContent).not.toBe(first));
    expect(document.activeElement).toHaveAttribute('role', 'menuitem');
    await userEvent.keyboard('{Escape}');
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Due column options' })).toHaveFocus());
  });
});

describe('Filter…', () => {
  const filter = async (name: string) => {
    await open(name);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Filter…' }));
    return screen.findByRole('dialog', { name: `Filter by ${labels[name]}` });
  };

  test('a vocabulary is a checklist in its words, with counts, a live count and one button that applies it', async () => {
    const host = draw('status');
    const pop = await filter('status');
    const open = await within(pop).findByRole('checkbox', { name: /^Open/ });
    await vi.waitFor(() => expect(open).toHaveFocus());
    await userEvent.click(open);
    await vi.waitFor(() => expect(within(pop).getByRole('status')).toHaveTextContent('4 match'));
    await userEvent.click(within(pop).getByRole('button', { name: 'Show 4' }));
    expect(host.apply).toHaveBeenCalledWith('status = open', 'status');
  });

  test('a name with nothing to list is a contains box, a figure a range, a date its presets and a range', async () => {
    draw('title');
    expect(within(await filter('title')).getByPlaceholderText('Contains…')).toBeInTheDocument();
    cleanup();
    draw('estimate');
    const range = await filter('estimate');
    expect(await within(range).findByLabelText('Min')).toBeInTheDocument();
    expect(within(range).getByLabelText('Max')).toBeInTheDocument();
    cleanup();
    draw('due_on');
    const dates = await filter('due_on');
    // A deadline is asked what is overdue.
    expect(within(dates).getByRole('radio', { name: 'Overdue' })).toBeInTheDocument();
    expect(within(dates).getByLabelText('From')).toBeInTheDocument();
  });

  test('the rarer conditions sit behind More conditions, and apply like any other', async () => {
    const host = draw('title');
    const pop = await filter('title');
    expect(within(pop).queryByRole('radio', { name: 'Starts with' })).toBeNull();
    const more = within(pop).getByRole('button', { name: 'More conditions' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(
      within(pop)
        .getAllByRole('radio')
        .map((r) => r.closest('label')!.textContent),
    ).toEqual(['Starts with', 'Matches a pattern', 'Is empty', 'Is not empty']);
    await userEvent.click(within(pop).getByRole('radio', { name: 'Starts with' }));
    await vi.waitFor(() => expect(within(pop).getByRole('textbox', { name: 'Starts with' })).toHaveFocus());
    await userEvent.keyboard('Har{Enter}');
    expect(host.apply).toHaveBeenCalledWith('title startswith Har', 'title');
  });

  test('where the rail beside the rows shows the column, Filter… goes to its facet instead', async () => {
    const rail = document.createElement('fieldset');
    rail.innerHTML = '<input type="checkbox" data-value="open">';
    document.body.append(rail);
    draw('status', { rail });
    await open('status');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Filter…' }));
    await vi.waitFor(() => expect(rail.querySelector('input')).toHaveFocus());
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});
