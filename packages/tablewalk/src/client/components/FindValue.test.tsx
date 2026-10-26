/** Find a value: the sweep's answer with everything it is honest about kept, and a match a door. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const calls: unknown[] = [];
const opened: unknown[] = [];
let answer: Record<string, unknown> = {};
vi.mock('../../../../kit/src/client/core.js', () => ({
  state: { activeConnection: 'demo' },
  api: async (_path: string, body: unknown) => {
    calls.push(body);
    return { structuredContent: answer };
  },
  findTable: (id: string) => ({ id, name: id === 'customer' ? 'Customer' : id }),
  openRecord: async (...args: unknown[]) => {
    opened.push(args);
  },
}));

const draw = (tree: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{tree}</QueryClientProvider>);
const { FindValueDialog } = await import('./FindValue.js');

afterEach(() => {
  cleanup();
  calls.length = 0;
  opened.length = 0;
  answer = {};
});

test('an initial value is looked for at once; matches group by table and open the row; what was skipped is said', async () => {
  const user = userEvent.setup();
  answer = {
    matches: [
      { table: 'customer', key: { id: 4 }, columns: ['name'], values: { name: 'Harbour Freight' } },
      { table: 'customer', key: { id: 9 }, columns: ['email'], values: { email: 'harbour@example.com' } },
      { table: 'note', columns: ['body'], values: { body: 'harbour' } },
    ],
    searched: 7,
    moreIn: ['customer'],
    failed: [{ table: 'audit' }],
    stopped: 'row cap',
    unreached: 2,
  };
  draw(<FindValueDialog initial="harbour" onClose={() => {}} />);
  await waitFor(() => expect(calls).toEqual([{ name: 'find', arguments: { value: 'harbour' } }]));
  await screen.findByText('Customer');
  expect(screen.getByText('2+')).toBeInTheDocument();
  // Named by their text, not their title: found by the class the stylesheet knows them by.
  const hits = [...document.querySelectorAll<HTMLButtonElement>('.find-hit')];
  expect(hits).toHaveLength(3);
  expect(hits[2]).toBeDisabled();
  expect(screen.getByText(/1 table could not be searched/)).toBeInTheDocument();
  expect(screen.getByText(/Stopped at the row cap, with 2 tables unread/)).toBeInTheDocument();
  await user.click(hits[0]);
  expect(opened).toEqual([['customer', { id: 4 }, 'Harbour Freight']]);
});

test('nothing found is said against the number of tables searched', async () => {
  answer = { matches: [], searched: 5 };
  draw(<FindValueDialog initial="zzz" onClose={() => {}} />);
  await screen.findByText('Nothing in 5 tables holds “zzz”.');
});
