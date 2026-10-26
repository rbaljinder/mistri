/**
 * The breakdown view: groups counted, sorted by editing the line, opened
 * as the rows they count, exported in two scopes, paged like a table.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { columnKind } from '../../../../engine/src/shared/schema.js';
import { nextSort } from '../clauses.js';

const gone: unknown[] = [];
const calls: Array<Record<string, unknown>> = [];
const downloads: Array<[string, string]> = [];
const toasts: string[] = [];
const state = { page: 0, activeConnection: 'demo', schema: { tables: [], foreignKeys: [] } };
const rendered = vi.fn();
let exportError: string | undefined;
vi.mock('../core.js', () => ({
  viewportSize: () => ({ width: 1000, height: 800 }),
  state,
  api: async (_path: string, body: Record<string, unknown>) => {
    calls.push(body);
    return exportError ? { errors: [{ message: exportError }] } : { columns: ['status', 'count'], rows: [{ status: 'x', count: 1 }] };
  },
  findTable: (id: string) => ({ id, name: id === 'invoice' ? 'Invoices' : id, columns: [] }),
  go: (entry: unknown, mode: string) => gone.push([entry, mode]),
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
  quote: (v: string) => (/^[\w.-]+$/.test(v) ? v : JSON.stringify(v)),
  pageSize: () => 2,
  render: rendered,
  toast: (m: string) => toasts.push(m),
  columnKind,
  columnDisplay: () => null,
  refsFrom: () => [],
  openRecord: () => {},
  viewportBox: (n: Element) => n.getBoundingClientRect(),
}));
vi.mock('../export.js', () => ({
  EXPORT_MAX_ROWS: 10_000,
  download: (name: string, text: string) => downloads.push([name, text]),
  exportFilename: (name: string, ext: string) => `${name}.${ext}`,
  toCsv: (columns: string[], rows: Array<Record<string, unknown>>) =>
    [columns.join(','), ...rows.map((r) => columns.map((c) => r[c]).join(','))].join('\n'),
  toJson: (_c: string[], rows: unknown[]) => JSON.stringify(rows),
}));
vi.mock('../prompt.js', () => ({ promptFor: async () => null }));

const { BreakdownView } = await import('./Breakdown.js');
type BreakdownData = Extract<
  import('../../../../engine/src/shared/resourceHttp.js').ResourceHttpSuccess<'/api/breakdown', 'app'>,
  { text: string }
>;

const entry = { kind: 'breakdown' as const, table: 'invoice', query: 'invoice count by status' };
const data: BreakdownData = {
  columns: ['status', 'count'],
  rows: [
    { status: 'draft', count: 102 },
    { status: 'sent', count: 40 },
  ],
  total: 4,
  ms: 7,
  resolved: [
    { name: 'status', kind: 'key' as const, path: 'status', type: 'TEXT' },
    { name: 'count', kind: 'measure' as const, fn: 'count', type: 'INTEGER' },
  ],
  breakdown: { base: 'invoice', by: [{ path: 'status' }], measures: [{ fn: 'count' }], limit: 2 },
  offset: 0,
  text: entry.query,
  section: { kind: 'breakdown', table: 'invoice', by: 'status' },
};

function draw(over: Partial<BreakdownData> = {}, query = entry.query) {
  const client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <BreakdownView entry={{ ...entry, query }} data={{ ...data, ...over }} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  gone.length = 0;
  calls.length = 0;
  downloads.length = 0;
  toasts.length = 0;
  state.page = 0;
  rendered.mockClear();
  exportError = undefined;
});

describe('the head', () => {
  test('counts groups, not rows, and says how many of the whole are shown', () => {
    draw();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Invoices');
    expect(document.querySelectorAll('.stat')[0]).toHaveTextContent('2 of 4 groups');
    expect(document.querySelectorAll('.stat')[1]).toHaveTextContent('7 ms');
    expect(screen.getByRole('button', { name: 'Copy as app section' })).toBeInTheDocument();
  });
});

describe('the grid', () => {
  test('a header click edits the line; the sorted column says which way', async () => {
    const user = userEvent.setup();
    draw({}, 'invoice count by status sort count desc');
    expect(screen.getByTitle('Sort by count')).toHaveTextContent('count ↓');
    await user.click(screen.getByTitle('Sort by status'));
    expect(gone).toEqual([[{ ...entry, query: nextSort('invoice count by status sort count desc', 'status') }, 'replace']]);
  });

  test('a plain group is a door to the rows it counts; a bucketed one is not', async () => {
    const user = userEvent.setup();
    draw();
    const rows = screen.getAllByRole('row').slice(1);
    expect(rows[0]).toHaveClass('clickable');
    await user.click(within(rows[0]).getByText('draft'));
    expect(gone).toEqual([[{ kind: 'table', table: 'invoice', query: 'invoice status = draft' }, 'push']]);
    cleanup();
    draw({ breakdown: { ...data.breakdown, by: [{ path: 'invoice_date', bucket: 'month' }] } });
    expect(screen.getAllByRole('row')[1]).not.toHaveClass('clickable');
  });

  test('no groups is a fact, not an empty table', () => {
    draw({ rows: [], total: 0 });
    expect(screen.getByText('Nothing to group — no rows matched.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('export', () => {
  test('a 200 parse failure reports the diagnostic without exporting empty groups', async () => {
    exportError = 'That grouping is invalid.';
    const user = userEvent.setup();
    draw();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getAllByRole('menuitem', { name: 'all groups (4)' })[0]);
    await vi.waitFor(() => expect(toasts).toEqual(['That grouping is invalid.']));
    expect(downloads).toEqual([]);
  });
  test('this page writes what is shown; all groups re-runs the line once, bounded', async () => {
    const user = userEvent.setup();
    draw();
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getAllByRole('menuitem', { name: 'this page (2 groups)' })[0]);
    expect(downloads).toEqual([['invoice-by-status.csv', 'status,count\ndraft,102\nsent,40']]);
    expect(toasts).toEqual(['Exported 2 groups.']);
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(screen.getAllByRole('menuitem', { name: 'all groups (4)' })[1]);
    await vi.waitFor(() => expect(downloads).toHaveLength(2));
    expect(calls).toEqual([{ text: entry.query, limit: 4, offset: 0 }]);
    expect(downloads[1][0]).toBe('invoice-by-status.json');
  });

  test('the second scope is offered only when it differs', async () => {
    const user = userEvent.setup();
    draw({ total: 2 });
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(screen.getAllByRole('menuitem', { name: /this page/ })).toHaveLength(2);
    expect(screen.queryByRole('menuitem', { name: /all groups/ })).toBeNull();
  });
});

describe('the pager', () => {
  test('pages like the table, and a line with its own limit has no second page', async () => {
    const user = userEvent.setup();
    draw();
    expect(screen.queryByRole('button', { name: '← Previous' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next →' }));
    expect(state.page).toBe(1);
    expect(rendered).toHaveBeenCalledTimes(1);
    cleanup();
    draw({}, 'invoice count by status limit 12');
    expect(screen.queryByRole('button', { name: 'Next →' })).toBeNull();
  });
});
