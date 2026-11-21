/**
 * A free-form page's reads asked in one moment go as one request. A field report: a page of nineteen `useRows` was
 * nineteen requests at once, 45 ms from its database, each queued behind the others' sockets. They now ride one
 * `/api/breakdowns` under the page's name (kit breakdownBatch.ts); each hook keeps its own key, rows and error.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UiPageContext, type UiPageFrame } from './context.js';

type Asked = { path: string; body: Record<string, unknown>; page: string | undefined };
const mocks = vi.hoisted(() => ({ asked: [] as Asked[], forbidden: '' }));
/* Each read answers with a row named for what it asked, so a hook drawing another's rows would show. */
const tag = (view: Record<string, unknown>) => /"([^"]+)"/.exec(String(view.query ?? ''))?.[1] ?? 'all';
const refused = (view: Record<string, unknown>) => mocks.forbidden !== '' && tag(view) === mocks.forbidden;
const rows = (view: Record<string, unknown>) => ({
  view: { columns: [{ path: 'name' }, { path: 'id' }] },
  columns: ['name', 'id'],
  rows: [{ name: `row ${tag(view)}`, id: 1 }],
});
const answer = (path: string, body: Record<string, unknown>) => {
  if (path === '/api/breakdowns') {
    return {
      results: (body.items as Array<{ view: Record<string, unknown> }>).map(({ view }) =>
        refused(view)
          ? { status: 403, body: { error: 'refused in the batch', code: 'page_undeclared' } }
          : { status: 200, body: rows(view) },
      ),
    };
  }
  if (refused(body)) throw Object.assign(new Error('The page "board" may not read that.'), { status: 403, code: 'page_undeclared' });
  return rows(body);
};
vi.mock('@mistriwork/kit/client/core.js', async (original) => ({
  ...(await original<object>()),
  api: async (path: string, body: Record<string, unknown>) => (mocks.asked.push({ path, body, page: undefined }), answer(path, body)),
  pageApi: async (page: string, path: string, body: Record<string, unknown>) => (
    mocks.asked.push({ path, body, page }),
    answer(path, body)
  ),
}));

const { state } = await import('@mistriwork/kit/client/core.js');
const { resetBreakdownBatch } = await import('@mistriwork/kit/client/breakdownBatch.js');
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

const frame: UiPageFrame = {
  view: 'board',
  label: 'Board',
  reads: ['desk'],
  commands: [],
  params: [],
  get: () => undefined,
  set: () => {},
};

function Read({ name }: { name: string }) {
  const read = useRows('desk', { show: ['name'], query: `name = "${name}"` });
  if (read.isError) return <p>{`${name}: ${read.error?.message}`}</p>;
  if (read.isPending) return <p>{`${name}: loading`}</p>;
  return <p>{`${name}: ${read.data?.map((row) => row.name).join(', ')}`}</p>;
}

function page(names: readonly string[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UiPageContext.Provider value={frame}>
        {names.map((name) => (
          <Read key={name} name={name} />
        ))}
      </UiPageContext.Provider>
    </QueryClientProvider>,
  );
  return client;
}
const names = (count: number) => Array.from({ length: count }, (_, at) => `r${at + 1}`);
const batches = () => mocks.asked.filter((one) => one.path === '/api/breakdowns');
const singles = () => mocks.asked.filter((one) => one.path === '/api/view/run');

beforeEach(() => resetBreakdownBatch());
afterEach(() => {
  cleanup();
  mocks.asked.length = 0;
  mocks.forbidden = '';
});

describe("a free-form page's reads", () => {
  test('nineteen useRows on entry are one request, under the page, and each draws its own rows', async () => {
    page(names(19));
    for (const name of names(19)) await screen.findByText(`${name}: row ${name}`);
    expect(batches()).toHaveLength(1);
    expect(singles()).toHaveLength(0);
    expect(batches()[0]!.page).toBe('board');
    expect((batches()[0]!.body.items as unknown[]).length).toBe(19);
  });

  test('a refetch of them all is one request too', async () => {
    const client = page(names(6));
    for (const name of names(6)) await screen.findByText(`${name}: row ${name}`);
    mocks.asked.length = 0;
    await act(() => client.invalidateQueries());
    await waitFor(() => expect(batches()).toHaveLength(1));
    expect((batches()[0]!.body.items as unknown[]).length).toBe(6);
    expect(singles()).toHaveLength(0);
  });

  test('a read the server refuses fails alone, with the error its own request meets', async () => {
    mocks.forbidden = 'r2';
    page(names(4));
    await screen.findByText('r2: The page "board" may not read that.');
    for (const name of ['r1', 'r3', 'r4']) await screen.findByText(`${name}: row ${name}`);
    expect(batches()).toHaveLength(1);
    /* Only the refused read was asked again alone, so its message is the single read's, not the batch's. */
    expect(singles().map((one) => tag(one.body))).toEqual(['r2']);
  });

  test("past the server's ceiling of 48 a second request carries the rest", async () => {
    page(names(50));
    for (const name of names(50)) await screen.findByText(`${name}: row ${name}`);
    expect(batches().map((one) => (one.body.items as unknown[]).length)).toEqual([48, 2]);
  });
});
