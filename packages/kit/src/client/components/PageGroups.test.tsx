/**
 * A related list read as groups: each group's header is the record its rows share, named by the breakdown and opened
 * as a link, with the facts the rows carry; the rows are one read narrowed to the group's key; a subtotal sums the
 * whole group and says so when fewer rows are drawn; "Show all" opens a group in place and the pager steps the groups.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DatabaseSchema, TableMeta } from '../../../../engine/src/shared/schema.js';

const column = (name: string, type = 'TEXT', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
const estimate: TableMeta = {
  id: 'estimate',
  name: 'estimate',
  schema: '',
  isView: false,
  columns: [column('id', 'INTEGER', true), column('title'), column('total', 'NUMERIC')],
};
const option: TableMeta = {
  id: 'option',
  name: 'option',
  schema: '',
  isView: false,
  columns: [column('id', 'INTEGER', true), column('estimate_id', 'INTEGER'), column('lender')],
};
const schema: DatabaseSchema = {
  dialect: 'sqlite',
  label: 'x',
  readAt: '',
  tables: [estimate, option],
  foreignKeys: [{ name: 'fk', from: { table: 'option', columns: ['estimate_id'] }, to: { table: 'estimate', columns: ['id'] } }],
};
const mocks = vi.hoisted(() => ({
  reads: [] as Array<{ view: { limit: number; filter: { groups: Array<Array<{ path: string; value?: unknown }>> } } }>,
  opened: [] as unknown[],
  grids: [] as Array<{ totals?: Record<string, unknown>; label?: string }>,
  toasts: [] as unknown[][],
}));
vi.mock('../core.js', () => ({
  columnDisplay: () => null,
  columnLabel: () => null,
  findTable: (id: string) => [estimate, option].find((t) => t.id === id),
  openRecord: (...args: unknown[]) => mocks.opened.push(args),
  state: { schema },
  toast: (...args: unknown[]) => mocks.toasts.push(args),
}));
vi.mock('./pageContext.js', () => ({
  usePageApi: () => async (_path: string, body: { view: (typeof mocks.reads)[number]['view'] }) => {
    mocks.reads.push(body);
    const key = body.view.filter.groups[0].find((c) => c.path === 'estimate_id')?.value;
    const rows = Array.from({ length: body.view.limit }, (_, i) => ({
      id: Number(key) * 100 + i,
      lender: `lender ${key}-${i}`,
      'estimate_id.title': `Estimate ${key}`,
      'estimate_id.total': 24000,
      __rank: (i + 1) * 1024,
    }));
    return { view: {}, columns: ['id', 'lender', 'estimate_id.title', 'estimate_id.total'], rows };
  },
}));
vi.mock('./dashboardModel.js', () => ({
  namedGroups: (answer: { names?: Record<string, Record<string, string>> }, keyName: string, say: (k: unknown) => string) => {
    const names = answer.names?.[keyName] ?? {};
    return (key: unknown) => names[String(key)] ?? say(key);
  },
}));
vi.mock('./valueModel.js', () => ({ groupLabel: (_r: unknown, value: unknown) => String(value) }));
vi.mock('./columnPresentation.js', () => ({ presentationColumns: () => new Map() }));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span>{String(value)}</span> }));
vi.mock('./Icon.js', () => ({ Icon: () => null }));
vi.mock('./Notes.js', () => ({ Empty: ({ text }: { text: string }) => <p>{text}</p> }));

const { GroupedBody } = await import('./PageGroups.js');

type Props = Parameters<typeof GroupedBody>[0];
const groups = (keys: number[], extra: Record<string, unknown> = {}) =>
  ({
    columns: ['estimate_id', 'group_rows', 'total_0'],
    rows: keys.map((key, i) => ({ estimate_id: key, group_rows: i === 0 ? 9 : 2, total_0: 1000 * (i + 1) })),
    names: { estimate_id: Object.fromEntries(keys.map((key) => [String(key), `Estimate #${key}`])) },
    total: 12,
    ...extra,
  }) as unknown as Props['groups'];

function draw(props: Partial<Props> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOffset = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <GroupedBody
        section={
          {
            kind: 'list',
            from: 'option',
            title: 'Options',
            totals: ['payment'],
            group: { by: 'estimate_id', show: ['title', 'total'] },
          } as Props['section']
        }
        groups={groups([4, 7])}
        offset={0}
        perPage={2}
        onOffset={onOffset}
        view={
          {
            base: 'option',
            columns: [{ path: 'lender' }],
            filter: { groups: [[{ path: 'estimate_id.lead_id', op: '=', value: 1 }]] },
          } as Props['view']
        }
        labelColumns={{}}
        rowsPerGroup={3}
        grid={(data, totals, label) => {
          mocks.grids.push({ totals, label });
          return (
            <ul aria-label="rows">
              {data.rows.map((row) => (
                <li key={String(row.id)}>{String(row.lender)}</li>
              ))}
            </ul>
          );
        }}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onOffset };
}

beforeEach(() => {
  mocks.toasts = [];
  mocks.reads = [];
  mocks.opened = [];
  mocks.grids = [];
});
afterEach(cleanup);

test('a group is headed by its record, named and opened, with the facts its rows carry and how many it holds', async () => {
  draw();
  const first = await screen.findByRole('group', { name: 'Estimate #4' });
  expect(await within(first).findByText('Estimate 4')).toBeInTheDocument();
  expect(within(first).getByText('24000')).toBeInTheDocument();
  expect(within(first).getByText('3 of 9')).toBeInTheDocument();
  await userEvent.click(within(first).getByRole('button', { name: 'Estimate #4' }));
  expect(mocks.opened).toEqual([['estimate', { id: 4 }, 'Estimate #4']]);
  // The second group is smaller than a page of rows: it says all of them and offers no more.
  const second = screen.getByRole('group', { name: 'Estimate #7' });
  expect(within(second).getByText('2 of 2')).toBeInTheDocument();
  expect(within(second).queryByRole('button', { name: /Show all/ })).toBeNull();
});

test("each group's rows are the list's own read held to the group's key, at the rows to a group", async () => {
  draw();
  await screen.findByRole('group', { name: 'Estimate #4' });
  await waitFor(() => expect(mocks.reads).toHaveLength(2));
  const [one] = mocks.reads;
  expect(one.view.limit).toBe(3);
  // The page's own condition stays, and the group's key joins it.
  expect(one.view.filter.groups).toEqual([
    [
      { path: 'estimate_id.lead_id', op: '=', value: 1 },
      { path: 'estimate_id', op: '=', value: 4 },
    ],
  ]);
});

test('a subtotal sums the whole group and says so when fewer rows are drawn', async () => {
  draw();
  await screen.findByRole('group', { name: 'Estimate #4' });
  await waitFor(() => expect(mocks.grids.length).toBeGreaterThan(1));
  expect(mocks.grids.find((grid) => grid.label === 'Total of 9')?.totals).toEqual({ payment: 1000 });
  // The group of two drew both: its footer is not an answer to a question nobody asked.
  expect(mocks.grids.find((grid) => grid.totals?.payment === 2000)?.label).toBeUndefined();
});

test('Show all opens a group in place up to what a group opens to, and the same button closes it', async () => {
  draw();
  const first = await screen.findByRole('group', { name: 'Estimate #4' });
  const more = within(first).getByRole('button', { name: 'Show all 9 options of Estimate #4' });
  expect(more).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(more);
  await waitFor(() => expect(mocks.reads.some((read) => read.view.limit === 50)).toBe(true));
  const less = await within(first).findByRole('button', { name: 'Show the first 3 options of Estimate #4' });
  expect(less).toHaveAttribute('aria-expanded', 'true');
  await waitFor(() => expect(within(first).getAllByRole('listitem')).toHaveLength(50));
  await userEvent.click(less);
  await waitFor(() => expect(within(first).getAllByRole('listitem')).toHaveLength(3));
});

test('the pager steps the groups by a page of them and stands disabled at the ends', async () => {
  const { onOffset } = draw();
  await screen.findByRole('group', { name: 'Estimate #4' });
  expect(document.querySelector('.page-range')?.textContent).toBe('1–2 of 12');
  expect(screen.getByRole('button', { name: 'Previous groups' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'More groups' }));
  expect(onOffset).toHaveBeenCalledWith(2);
});

test('no groups says so, and a list that fits one page of groups draws no pager', async () => {
  draw({ groups: groups([], { total: 0 }) });
  expect(await screen.findByText('Nothing to group yet.')).toBeInTheDocument();
  expect(document.querySelector('.page-pager')).toBeNull();
  cleanup();
  draw({ groups: groups([4], { total: 1 }) });
  await screen.findByRole('group', { name: 'Estimate #4' });
  expect(document.querySelector('.page-pager')).toBeNull();
});

test('a group the breakdown does not name is headed by its key, and rows with no parent are headed No estimate and open nothing', async () => {
  draw({ groups: groups([4], { names: undefined }) });
  expect(await screen.findByRole('group', { name: '4' })).toBeInTheDocument();
  cleanup();
  mocks.reads = [];
  draw({
    groups: {
      columns: ['estimate_id', 'group_rows'],
      rows: [{ estimate_id: null, group_rows: 2 }],
      total: 1,
    } as unknown as Props['groups'],
  });
  const none = await screen.findByRole('group', { name: 'No estimate' });
  expect(none.querySelector('button.page-group-link')).toBeNull();
  await waitFor(() => expect(mocks.reads).toHaveLength(1));
  expect(mocks.reads[0].view.filter.groups[0].at(-1)).toEqual({ path: 'estimate_id', op: 'isNull' });
});

test('the group of rows with no value is "No <the column>" by default, or what the list calls it', async () => {
  draw({
    groups: {
      columns: ['estimate_id', 'group_rows'],
      rows: [
        { estimate_id: 4, group_rows: 2 },
        { estimate_id: null, group_rows: 2 },
      ],
      names: { estimate_id: { '4': 'Estimate #4' } },
    } as unknown as Props['groups'],
  });
  expect(await screen.findByRole('group', { name: 'No estimate' })).toBeInTheDocument();
  cleanup();
  draw({
    section: {
      kind: 'list',
      from: 'option',
      group: { by: 'estimate_id', empty: 'Backlog' },
    } as Props['section'],
    groups: {
      columns: ['estimate_id', 'group_rows'],
      rows: [{ estimate_id: null, group_rows: 2 }],
    } as unknown as Props['groups'],
  });
  expect(await screen.findByRole('group', { name: 'Backlog' })).toBeInTheDocument();
});

test('a summed column is said after the count, in the header', async () => {
  draw({
    section: { kind: 'list', from: 'option', group: { by: 'estimate_id', sum: ['payment', 'hours'] } } as Props['section'],
    groups: {
      columns: ['estimate_id', 'group_rows', 'group_sum_0', 'group_sum_1'],
      rows: [{ estimate_id: 4, group_rows: 2, group_sum_0: 34, group_sum_1: null }],
      names: { estimate_id: { '4': 'Estimate #4' } },
    } as unknown as Props['groups'],
  });
  const head = (await screen.findByRole('group', { name: 'Estimate #4' })).querySelector('.page-group-head')!;
  expect(head.querySelector('.page-group-count')?.textContent).toBe('2 of 2');
  // Only the figure the group has: no sum is drawn for a group that summed nothing.
  expect([...head.querySelectorAll('.page-group-sum')].map((el) => el.textContent)).toEqual(['34']);
});

/* Rows moved by hand (groupMoves.tsx): the grid stand-in draws real rows, named as the grid names them. */
const rowId = (id: unknown) => JSON.stringify([['id', String(id)]]);
const tableGrid: Props['grid'] = (data) => (
  <table>
    <tbody>
      {data.rows.map((row) => (
        <tr key={String(row.id)} data-row-key={rowId(row.id)}>
          <td>{String(row.lender)}</td>
        </tr>
      ))}
    </tbody>
  </table>
);
function moving(overrides: Partial<import('./groupMoves.js').GroupMoves> = {}) {
  const calls: unknown[][] = [];
  const done = vi.fn(async () => undefined);
  const moves: import('./groupMoves.js').GroupMoves = {
    keyOf: (row) => ({ key: { id: row.id }, id: rowId(row.id) }),
    labelOf: (row) => String(row.lender),
    enters: () => true,
    regroup: async (...args) => {
      calls.push(args);
      return null;
    },
    done,
    ...overrides,
  };
  return { moves, calls, done };
}
const { dragOnto } = await import('./dragTesting.js');
const groupOf = (name: string) => screen.getByRole('group', { name: new RegExp(name) });
const rowsIn = (name: string) =>
  within(groupOf(name))
    .queryAllByRole('row')
    .map((row) => row.textContent);

test('a row dragged into another group stands there at once, its count moved with it, and the write is the group’s value', async () => {
  let answer: (refusal: string | null) => void = () => undefined;
  const { moves, calls, done } = moving({
    regroup: (...args) => {
      calls.push(args);
      return new Promise((resolve) => (answer = resolve));
    },
  });
  draw({ grid: tableGrid, moves });
  await waitFor(() => expect(rowsIn('Estimate #7')).toHaveLength(3));
  const row = screen.getByText('lender 4-1').closest('tr')!;
  expect(row).toHaveAttribute('data-draggable', 'true');
  dragOnto(row, groupOf('Estimate #7').querySelector('tr')!);
  // Drawn in its new group before the write is answered, quiet while it saves.
  expect(rowsIn('Estimate #7')).toContain('lender 4-1');
  expect(rowsIn('Estimate #4')).not.toContain('lender 4-1');
  expect(within(groupOf('Estimate #4')).getByText('3 of 8')).toBeInTheDocument();
  await waitFor(() => expect(calls).toEqual([[{ id: 401 }, 'lender 4-1', 4, 7]]));
  expect(screen.getByText('lender 4-1').closest('tr')).toHaveAttribute('aria-busy', 'true');
  answer(null);
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(rowsIn('Estimate #7')).toContain('lender 4-1');
});

test('a refused move goes back with the server’s sentence; a group the row cannot enter is shut and says so', async () => {
  const { moves } = moving({ regroup: async () => 'Estimate #7 is closed.', enters: (key) => key !== 4 });
  draw({ grid: tableGrid, moves });
  await waitFor(() => expect(rowsIn('Estimate #7')).toHaveLength(3));
  dragOnto(screen.getByText('lender 4-1').closest('tr')!, groupOf('Estimate #7').querySelector('tr')!);
  await waitFor(() => expect(rowsIn('Estimate #4')).toContain('lender 4-1'));
  expect(mocks.toasts).toContainEqual(['“lender 4-1” went back to Estimate #4: Estimate #7 is closed.', 'error']);
  mocks.toasts = [];
  dragOnto(screen.getByText('lender 7-0').closest('tr')!, groupOf('Estimate #4').querySelector('tr')!);
  expect(mocks.toasts).toEqual([['“lender 7-0” can’t be moved to Estimate #4 here.', 'error']]);
  expect(rowsIn('Estimate #7')).toContain('lender 7-0');
});

test('moves made while one is saving wait their turn, and the rows are read again once', async () => {
  const answers: Array<() => void> = [];
  const { moves, calls, done } = moving({
    regroup: (...args) => {
      calls.push(args);
      return new Promise((resolve) => answers.push(() => resolve(null)));
    },
  });
  draw({ grid: tableGrid, moves });
  await waitFor(() => expect(rowsIn('Estimate #7')).toHaveLength(3));
  dragOnto(screen.getByText('lender 4-0').closest('tr')!, groupOf('Estimate #7').querySelector('tr')!);
  dragOnto(screen.getByText('lender 4-2').closest('tr')!, groupOf('Estimate #7').querySelector('tr')!);
  expect(rowsIn('Estimate #7')).toEqual(expect.arrayContaining(['lender 4-0', 'lender 4-2']));
  await waitFor(() => expect(calls).toHaveLength(1));
  answers[0]();
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(done).not.toHaveBeenCalled();
  answers[1]();
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
});

test('Alt and ↓ on a group’s last row moves it into the next group and says so; in a ranked list it takes a place first', async () => {
  let landed: () => void = () => undefined;
  const rank = vi.fn(() => new Promise<null>((resolve) => (landed = () => resolve(null))));
  const { moves, calls } = moving({ rank: { column: 'position', whole: false, write: rank } });
  draw({ grid: tableGrid, moves });
  await waitFor(() => expect(rowsIn('Estimate #7')).toHaveLength(3));
  const user = userEvent.setup();
  const first = screen.getByText('lender 4-0').closest('tr')!;
  expect(first).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
  first.focus();
  await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
  // Ranked: a place down within its group, halfway between its new neighbors.
  await waitFor(() => expect(rank).toHaveBeenCalledWith({ id: 400 }, 'lender 4-0', 2560, 1024));
  expect(rowsIn('Estimate #4')).toEqual(['lender 4-1', 'lender 4-0', 'lender 4-2']);
  expect(document.querySelector('[aria-live="polite"]')).toHaveTextContent('Moved “lender 4-0” to place 2 of 3 in Estimate #4.');
  landed();
  // This fixture's server keeps no number: read again, the group is as it says.
  await waitFor(() => expect(rowsIn('Estimate #4')).toEqual(['lender 4-0', 'lender 4-1', 'lender 4-2']));
  const last = screen.getByText('lender 4-2').closest('tr')!;
  last.focus();
  await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
  await waitFor(() => expect(calls).toEqual([[{ id: 402 }, 'lender 4-2', 4, 7]]));
  expect(rowsIn('Estimate #7')[0]).toBe('lender 4-2');
  await waitFor(() => expect(screen.getByText('lender 4-2').closest('tr')).toHaveFocus());
});
