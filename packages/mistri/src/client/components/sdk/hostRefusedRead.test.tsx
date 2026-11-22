/**
 * A free-form page whose one read the server refuses. A field report: a read asked with `status in ("")` (an empty
 * pick spelled into the query) was refused — "in" needs at least one value — and the whole page sat on Loading. The
 * refusal is that read's: its `useRows` fails, naming the read, and the page's other reads draw beside it.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ asked: [] as Array<[string, unknown, string | undefined]> }));
const answer = (body: { query?: string; view?: { base?: string } }) =>
  body.query?.includes('in ("")')
    ? { errors: [{ message: '"in" needs at least one value', at: 7 }] }
    : { view: { columns: [{ path: 'name' }, { path: 'id' }] }, columns: ['name', 'id'], rows: [{ name: 'North', id: 1 }] };
vi.mock('@mistriwork/kit/client/core.js', async (original) => ({
  ...(await original<object>()),
  api: async (path: string, body: never) => (mocks.asked.push([path, body, undefined]), answer(body)),
  pageApi: async (page: string, path: string, body: never) => (mocks.asked.push([path, body, page]), answer(body)),
}));

const { state } = await import('@mistriwork/kit/client/core.js');
const { useRows } = await import('./hooks.js');
await import('./host.js');

(state as { schema: unknown }).schema = {
  tables: [
    {
      id: 'desk',
      name: 'desk',
      columns: [
        { name: 'id', type: 'integer', pk: true, primaryKey: true },
        { name: 'name', type: 'text' },
      ],
    },
  ],
  foreignKeys: [],
};

function Read({ label, query }: { label: string; query?: string }) {
  const rows = useRows('desk', { show: ['name'], ...(query ? { query } : {}) });
  if (rows.isError) return <p>{`${label}: ${rows.error?.message}`}</p>;
  if (rows.isPending) return <p>{`${label}: loading`}</p>;
  return <p>{`${label}: ${rows.data?.map((row) => row.name).join(', ')}`}</p>;
}

afterEach(() => {
  cleanup();
  mocks.asked.length = 0;
});

describe('a refused read on a free-form page', () => {
  test("fails its own useRows, naming the read, and the page's other reads draw", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Read label="picked" query={'name in ("")'} />
        <Read label="all" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('all: North')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/^picked: /).textContent).not.toBe('picked: loading'));
    expect(screen.getByText(/^picked: /).textContent).toBe('picked: The rows of "desk" could not be read: "in" needs at least one value');
  });
});
