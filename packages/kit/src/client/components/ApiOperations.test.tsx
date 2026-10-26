/**
 * The explorer's API tab: a form drawn from the description alone, sent
 * through the server, answered as the API answered, and a list's question
 * opened as the table view asking the same thing.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';

const OPERATIONS = {
  resource: 'shipments',
  list: {
    path: '/shipments',
    params: [
      { name: 'status', kind: 'filter', column: 'status' },
      { name: 'carrier_id', kind: 'filter', column: 'carrier_id', many: true },
      { name: 'q', kind: 'search' },
      { name: 'sort', kind: 'sort', values: ['-shipped_at', 'eta'] },
      { name: 'offset', kind: 'offset' },
      { name: 'limit', kind: 'limit' },
    ],
  },
  item: { path: '/shipments/{tracking_number}', key: 'tracking_number' },
};
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
const go = vi.fn();
let answer: unknown;

import { quoteValue } from '../../../../engine/src/shared/query.js';
vi.mock('../core.js', () => ({
  state: {
    activeConnection: 'parcel',
    schema: {
      dialect: 'http',
      tables: [{ id: 'shipments', columns: [{ name: 'status' }, { name: 'carrier_id' }, { name: 'eta' }, { name: 'shipped_at' }] }],
    },
  },
  api: async (path: string, body: Record<string, unknown>) => {
    calls.push({ path, body });
    if (path === '/api/http/operations') return OPERATIONS;
    if (answer instanceof Error) throw answer;
    return answer;
  },
  go,
  quote: quoteValue,
  tableView: (table: string, query: string) => ({ kind: 'table', table, query }),
}));
vi.mock('./JsonView.js', () => ({
  JsonView: ({ value }: { value: unknown }) => createElement('pre', { 'data-testid': 'json' }, JSON.stringify(value)),
}));
vi.mock('./Skeleton.js', () => ({ Delayed: () => null, GridSkeleton: () => null }));

const { ApiOperations } = await import('./ApiOperations.js');

function draw() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(createElement(QueryClientProvider, { client }, createElement(ApiOperations, { table: 'shipments' })));
}

beforeEach(() => {
  calls.length = 0;
  go.mockClear();
  answer = {
    request: { method: 'GET', path: '/shipments', query: 'status=exception&limit=2' },
    status: 200,
    json: [{ tracking_number: 'PX1' }],
    ms: 7,
  };
});
afterEach(cleanup);

describe('the API tab', () => {
  test('the form is the description: its filters, search, sort and paging, and nothing else', async () => {
    draw();
    for (const name of ['status', 'carrier_id', 'Search', 'offset', 'limit'])
      expect(await screen.findByLabelText(name)).toBeInTheDocument();
    const sort = screen.getByLabelText('sort') as HTMLSelectElement;
    expect([...sort.options].map((option) => option.value)).toEqual(['', '-shipped_at', 'eta']);
    expect(screen.getAllByRole('textbox')).toHaveLength(5);
    expect(screen.getByText('GET /shipments')).toBeInTheDocument();
  });

  test('Send asks the server for the typed parameters only, and says the request and the answer', async () => {
    const user = userEvent.setup();
    draw();
    await user.type(await screen.findByLabelText('status'), 'exception');
    await user.type(screen.getByLabelText('limit'), '2');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(calls.at(-1)).toEqual({
      path: '/api/http/operation',
      body: { resource: 'shipments', operation: 'list', params: { status: 'exception', limit: '2' } },
    });
    expect(await screen.findByText('GET /shipments?status=exception&limit=2')).toBeInTheDocument();
    expect(screen.getByText('200 · 7 ms')).toBeInTheDocument();
    expect(screen.getByTestId('json')).toHaveTextContent('PX1');
  });

  test("Open as table asks the table view the same question, and is off where the API's search has no equivalent", async () => {
    const user = userEvent.setup();
    draw();
    await user.type(await screen.findByLabelText('status'), 'exception');
    await user.type(screen.getByLabelText('carrier_id'), 'car-01, car-02');
    await user.selectOptions(screen.getByLabelText('sort'), '-shipped_at');
    await user.click(screen.getByRole('button', { name: 'Open as table' }));
    expect(go).toHaveBeenCalledWith(
      { kind: 'table', table: 'shipments', query: 'shipments status = exception and carrier_id in (car-01, car-02) sort shipped_at desc' },
      'push',
    );
    await user.type(screen.getByLabelText('Search'), 'Chicago');
    expect(screen.getByRole('button', { name: 'Open as table' })).toBeDisabled();
  });

  test('a refusal is said where the answer would be', async () => {
    const user = userEvent.setup();
    answer = new Error('shipments\'s list takes status, carrier_id, q, sort, offset, limit; not "name".');
    draw();
    await user.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not "name"');
    expect(screen.queryByTestId('json')).toBeNull();
  });

  test('one record is read by its key, and an error status is said without a body', async () => {
    const user = userEvent.setup();
    answer = { request: { method: 'GET', path: '/shipments/PX9', query: '' }, status: 404, ms: 3 };
    draw();
    await user.click(await screen.findByRole('radio', { name: /One record/ }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(screen.getByLabelText('tracking_number'), 'PX9');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(calls.at(-1)?.body).toEqual({ resource: 'shipments', operation: 'item', params: { tracking_number: 'PX9' } });
    expect(await screen.findByText(/answered 404/)).toBeInTheDocument();
    expect(screen.queryByTestId('json')).toBeNull();
  });
});
