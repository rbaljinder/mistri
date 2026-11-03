/**
 * A grouped grid's heads are one breakdown — the group's column over the list's own conditions, each value counted
 * and each `totals` column summed — never a read per group, and never the list's sort or page. A value is said as its
 * column says it, a reference by its record's name, and the rows with none as "No …".
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const deal: TableMeta = {
  id: 'deal',
  name: 'deal',
  schema: '',
  isView: false,
  columns: [
    col('id', 'INTEGER', { primaryKey: true, nullable: false }),
    col('stage', 'TEXT'),
    col('owner_id', 'INTEGER', { references: { table: 'rep', column: 'id' } }),
    col('amount', 'INTEGER'),
  ] as TableMeta['columns'],
};

const asked: Array<{ path: string; body: Record<string, unknown> }> = [];
const answers: Record<string, unknown> = {};
vi.mock('../core.js', () => ({
  state: { activeConnection: 'demo', schema: { tables: [deal], foreignKeys: [] } },
  api: async (path: string, body: Record<string, unknown>) => {
    asked.push({ path, body });
    return answers[String(body.text)] ?? { columns: [], rows: [] };
  },
  columnDisplay: (_table: string, name: string) => (name === 'stage' ? { values: { closed_won: 'Won' } } : null),
  columnLabel: (_table: string, name: string) => (name === 'owner_id' ? 'Owner' : null),
}));

const { useGridGroups } = await import('./useGridGroups.js');

afterEach(() => {
  cleanup();
  asked.length = 0;
});

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{children}</QueryClientProvider>;
}

test("one breakdown of the group's column over the list's conditions, with a count and each total, and heads read from it", async () => {
  const text = 'deal stage != lost count as group_rows, sum amount as total_0 by stage';
  answers[text] = {
    columns: ['stage', 'group_rows', 'total_0'],
    rows: [
      { stage: 'closed_won', group_rows: 3, total_0: 4200 },
      { stage: null, group_rows: 1, total_0: 50 },
    ],
  };
  const view = renderHook(
    () =>
      useGridGroups({
        column: 'stage',
        table: deal,
        query: 'deal stage != lost sort close_date limit 20',
        totals: ['amount'],
        connection: 'demo',
      }),
    { wrapper },
  );
  await waitFor(() => expect(view.result.current?.head('closed_won').count).toBe(3));
  // Asked once, without the list's sort or page.
  expect(asked).toEqual([{ path: '/api/breakdown', body: { text, limit: 500 } }]);
  const group = view.result.current!;
  expect(group.column).toBe('stage');
  expect(group.head('closed_won')).toEqual({ label: 'Won', count: 3, sums: { amount: 4200 } });
  expect(group.head(null)).toEqual({ label: 'No stage', count: 1, sums: { amount: 50 } });
  // A value the breakdown did not reach (past its limit) still has its words.
  expect(group.head('proposal')).toEqual({ label: 'proposal' });
});

test("a reference's groups are named by its records, and a list with no totals asks only the count", async () => {
  const text = 'deal count as group_rows by owner_id';
  answers[text] = {
    columns: ['owner_id', 'group_rows'],
    rows: [{ owner_id: 7, group_rows: 12 }],
    names: { owner_id: { '7': 'Dana Reyes' } },
  };
  const view = renderHook(() => useGridGroups({ column: 'owner_id', table: deal, query: 'deal', totals: undefined, connection: 'demo' }), {
    wrapper,
  });
  await waitFor(() => expect(view.result.current?.head(7).count).toBe(12));
  expect(view.result.current!.head(7)).toEqual({ label: 'Dana Reyes', count: 12 });
  expect(view.result.current!.head(undefined).label).toBe('No owner');
});

test('an ungrouped list asks nothing', () => {
  const view = renderHook(() => useGridGroups({ column: undefined, table: deal, query: 'deal', totals: ['amount'], connection: 'demo' }), {
    wrapper,
  });
  expect(view.result.current).toBeUndefined();
  expect(asked).toHaveLength(0);
});
