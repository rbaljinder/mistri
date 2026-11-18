import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const mock = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../../../kit/src/client/core.js', () => ({ state: { activeConnection: 'app' }, api: mock.api }));
import type { CommandProposal } from './commandProposals.js';
import { pendingOn, targets, usePendingCount, useProposals } from './proposalTargets.js';
import { useApproveProposal, useConfirmProvenance, useDismissProposal } from './proposalDecisions.js';

const proposal = (
  id: string,
  target: string | null,
  state: CommandProposal['state'] = 'proposed',
  command = 'advance',
): CommandProposal => ({
  id,
  command,
  target,
  input: {},
  actorKind: 'job',
  actor: 'job:nightly',
  model: null,
  evidence: [],
  reason: 'Because.',
  state,
  decidedBy: null,
  decidedAt: null,
  receiptId: null,
  createdAt: 1,
  expiresAt: 2,
});

let client: QueryClient;
const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mock.api.mockReset();
});
afterEach(cleanup);

test('a target is the record whose key it names, column by column as text', () => {
  expect(targets(proposal('a', '{"id":5}'), { id: 5 })).toBe(true);
  expect(targets(proposal('a', '{"id":5}'), { id: '5' })).toBe(true);
  expect(targets(proposal('a', '{"id":5}'), { id: 6 })).toBe(false);
  expect(targets(proposal('a', '{"id":5,"org":"x"}'), { id: 5 })).toBe(false);
  expect(targets(proposal('a', null), { id: 5 })).toBe(false);
  expect(targets(proposal('a', 'not json'), { id: 5 })).toBe(false);
});

test('pending on a record counts only proposed rows, of one command when asked', () => {
  const rows = [
    proposal('a', '{"id":1}'),
    proposal('b', '{"id":1}', 'dismissed'),
    proposal('c', '{"id":1}', 'proposed', 'close'),
    proposal('d', '{"id":2}'),
  ];
  expect(pendingOn(rows, { id: 1 }).map((row) => row.id)).toEqual(['a', 'c']);
  expect(pendingOn(rows, { id: 1 }, 'close').map((row) => row.id)).toEqual(['c']);
});

test('the list asks the proposals route with the filter, and the record count reads the same list', async () => {
  mock.api.mockResolvedValue({ proposals: [proposal('a', '{"id":1}'), proposal('d', '{"id":2}')] });
  const listed = renderHook(() => useProposals('app', { command: 'advance', states: ['proposed'] }), { wrapper });
  await waitFor(() => expect(listed.result.current.data?.length).toBe(2));
  expect(mock.api).toHaveBeenCalledWith('/api/commands/proposals', expect.objectContaining({ command: 'advance', states: ['proposed'] }));
  const counted = renderHook(() => usePendingCount('app', { id: 1 }), { wrapper });
  await waitFor(() => expect(counted.result.current).toBe(1));
  expect(mock.api.mock.calls.at(-1)?.[1]).not.toHaveProperty('command');
});

test('no record, no request', () => {
  const counted = renderHook(() => usePendingCount('app', null), { wrapper });
  expect(counted.result.current).toBe(0);
  expect(mock.api).not.toHaveBeenCalled();
});

test('each decision posts to its route and reads the list again, refused or not', async () => {
  mock.api.mockImplementation(async (path: string) => {
    if (path === '/api/commands/proposals') return { proposals: [] };
    if (path === '/api/commands/proposals/dismiss') throw new Error('refused');
    if (path === '/api/commands/provenance/confirm') return { confirmed: 2 };
    return { ok: true };
  });
  renderHook(() => useProposals('app'), { wrapper });
  await waitFor(() => expect(mock.api).toHaveBeenCalledTimes(1));
  const approve = renderHook(() => useApproveProposal('app'), { wrapper });
  const dismiss = renderHook(() => useDismissProposal('app'), { wrapper });
  const confirm = renderHook(() => useConfirmProvenance('app'), { wrapper });
  await act(() => approve.result.current.mutateAsync({ id: 'p1', command: 'advance', expectedVersion: 3 }));
  await act(() => dismiss.result.current.mutateAsync({ id: 'p2', command: 'advance' }).catch(() => undefined));
  const confirmed = await act(() =>
    confirm.result.current.mutateAsync({ command: 'advance', resource: 'task', key: { id: 1 }, field: 'title' }),
  );
  expect(confirmed).toEqual({ confirmed: 2 });
  const posted = mock.api.mock.calls.map(([path, body]) => [path, body]);
  expect(posted).toContainEqual([
    '/api/commands/proposals/approve',
    expect.objectContaining({ id: 'p1', command: 'advance', expectedVersion: 3 }),
  ]);
  expect(posted).toContainEqual(['/api/commands/proposals/dismiss', expect.objectContaining({ id: 'p2', command: 'advance' })]);
  expect(posted).toContainEqual([
    '/api/commands/provenance/confirm',
    expect.objectContaining({ command: 'advance', resource: 'task', key: { id: 1 }, field: 'title' }),
  ]);
  await waitFor(() => expect(mock.api.mock.calls.filter(([path]) => path === '/api/commands/proposals').length).toBe(4));
});
