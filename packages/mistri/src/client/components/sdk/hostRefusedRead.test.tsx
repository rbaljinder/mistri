/**
 * A free-form page whose one read the server refuses. A field report: a read asked with `status in ("")` (an empty
 * pick spelled into the query) was refused — "in" needs at least one value — and the whole page sat on Loading. The
 * refusal is that read's: its `useRows` fails, naming the read, and the page's other reads draw beside it.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ asked: [] as Array<[string, unknown, string | undefined]> }));
const answer = (body: { query?: string; where?: unknown; view?: { base?: string } }) => {
  /* A where the server cannot compile is answered 400 (engine resourceReadHttp.ts), which the transport throws. */
  if (body.where !== undefined)
    throw Object.assign(
      new Error('name has no operator "in": the object form has not, gt, gte, lt, lte, contains, startsWith, endsWith.'),
      { status: 400 },
    );
  return said(body);
};
const said = (body: { query?: string }) =>
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

function Read({ label, query, where }: { label: string; query?: string; where?: Record<string, unknown> }) {
  const rows = useRows('desk', { show: ['name'], ...(query ? { query } : {}), ...(where ? { where } : {}) });
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

  test('a where with an operator the server does not have is an error of that read, never rows that are not there', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <Read label="picked" where={{ name: { in: ['North', 'South'] } }} />
        <Read label="all" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText('all: North')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/^picked: /).textContent).toMatch(/^picked: name has no operator "in"/));
    /* The condition went as written: the server judges it, so the page cannot ask a wider read by a word the browser dropped. */
    expect(
      mocks.asked.some(([, body]) => JSON.stringify((body as { where?: unknown }).where) === '{"name":{"in":["North","South"]}}'),
    ).toBe(true);
  });
});
