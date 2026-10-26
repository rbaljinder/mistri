/** The shape check: findings by table, then by rule with the cost said once; a table heading is the way there. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const gone: unknown[] = [];
let result: Record<string, unknown> = {};
vi.mock('../../../../kit/src/client/core.js', () => ({
  state: { activeConnection: 'demo' },
  api: async () => ({ structuredContent: result }),
  findTable: (id: string) => ({ id, name: id }),
  go: (...args: unknown[]) => gone.push(args),
  tableView: (table: string) => ({ kind: 'table', table }),
}));

const draw = (tree: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{tree}</QueryClientProvider>);
const { ShapeCheckDialog } = await import('./ShapeCheck.js');

afterEach(() => {
  cleanup();
  gone.length = 0;
  result = {};
});

test('counts by severity, groups by table then rule, and the heading opens the table', async () => {
  const user = userEvent.setup();
  result = {
    counts: { high: 1, medium: 1, low: 0 },
    rules: { 'unindexed-fk': { why: 'every join scans' } },
    findings: [
      { table: 'invoice', rule: 'unindexed-fk', severity: 'high', message: 'customer_id has no index' },
      { table: 'invoice', rule: 'unindexed-fk', severity: 'high', message: 'sold_by has no index' },
      { table: 'note', rule: 'naive-timestamp', severity: 'medium', message: 'written_on has no zone', why: 'midnight moves' },
    ],
  };
  const onClose = vi.fn();
  draw(<ShapeCheckDialog onClose={onClose} />);
  await screen.findByText(/1 high, 1 medium, 0 low/);
  expect(screen.getAllByText('every join scans')).toHaveLength(1);
  expect(screen.getByText('customer_id has no index')).toBeInTheDocument();
  expect(screen.getByText('midnight moves')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /^invoice/ }));
  expect(gone).toEqual([[{ kind: 'table', table: 'invoice' }, 'reset']]);
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('a clean schema says so', async () => {
  result = { findings: [] };
  draw(<ShapeCheckDialog onClose={() => {}} />);
  await screen.findByText(/Nothing to report/);
});
