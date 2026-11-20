/**
 * The For review room: AI-made work grouped by command, each row with its record, reason and age and Approve /
 * Dismiss; bulk only where the command allows it; an Unconfirmed section whose Confirm calls provenance/confirm.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommandProposal, ReviewList, UnconfirmedMark } from '../commandProposals.js';

const h = vi.hoisted(() => ({
  go: vi.fn(),
  toast: vi.fn(),
  list: { current: undefined as unknown },
  approve: vi.fn(),
  dismiss: vi.fn(),
  confirm: vi.fn(),
  revision: vi.fn(),
  openProposal: vi.fn(),
  actions: {} as Record<string, { label: string; bulk?: boolean }>,
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: vi.fn(),
  findTable: () => undefined,
  go: h.go,
  labelPath: () => undefined,
  rowLabel: () => '',
  rowView: (table: string, key: unknown, label: string) => ({ table, key, label }),
  state: { activeConnection: 'demo' },
  toast: h.toast,
}));
vi.mock('../../../../kit/src/client/components/Notes.js', () => ({
  Empty: ({ text, detail }: { text: string; detail: string }) => (
    <p>
      {text} {detail}
    </p>
  ),
}));
vi.mock('../../../../kit/src/client/components/crumbSlot.js', () => ({ useCrumbSlots: () => ({}) }));
vi.mock('../../../../kit/src/client/locale.js', () => ({
  defaultCurrency: () => 'USD',
  formatDateTime: (at: string) => at,
  formatMoney: (v: unknown) => `$${v}`,
  formatNumber: (v: unknown) => String(v),
}));
vi.mock('../appState.js', () => ({ activeApp: () => ({ review: true }) }));
vi.mock('./sdk/commands.js', () => ({
  actionOf: (command: string) => h.actions[command],
}));
vi.mock('./sdk/proposalCommands.js', () => ({ commandResource: () => 'claim', commandRevision: h.revision }));
vi.mock('./ProposalPanel.js', async () => ({
  openProposal: h.openProposal,
  proposalKey: (await vi.importActual<typeof import('./ProposalPanel.js')>('./ProposalPanel.js')).proposalKey,
}));
vi.mock('../commandProposals.js', () => ({
  PROPOSALS_KEY: 'command-proposals',
  useReview: () => h.list.current,
}));
vi.mock('../proposalDecisions.js', () => ({
  approveProposal: h.approve,
  dismissProposal: h.dismiss,
  confirmProvenance: h.confirm,
}));

const { ReviewRoom } = await import('./ReviewRoom.js');

const now = Date.now();
const proposal = (id: string, command: string, target: string | null, reason = ''): CommandProposal =>
  ({
    id,
    command,
    target,
    input: {},
    actorKind: 'assistant',
    actor: 'assistant',
    model: null,
    evidence: [],
    reason,
    state: 'proposed',
    decidedBy: null,
    decidedAt: null,
    receiptId: null,
    createdAt: now - 5 * 60_000,
    expiresAt: now + 86_400_000,
  }) as unknown as CommandProposal;
const mark = (over: Partial<UnconfirmedMark> = {}): UnconfirmedMark =>
  ({
    id: 'm1',
    resource: 'claim',
    rowKey: '{"id":4}',
    field: 'amount',
    actorKind: 'ai',
    actor: 'jev',
    createdAt: now,
    command: 'appeal',
    ...over,
  }) as UnconfirmedMark;

function draw(list: ReviewList | undefined) {
  h.list.current = list;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  render(
    <QueryClientProvider client={client}>
      <ReviewRoom />
    </QueryClientProvider>,
  );
  return client;
}

beforeEach(() => {
  for (const each of [h.go, h.toast, h.approve, h.dismiss, h.confirm, h.openProposal]) each.mockReset().mockResolvedValue({});
  h.revision.mockReset().mockResolvedValue(3);
  h.actions = { appeal: { label: 'Send appeal', bulk: true }, assign: { label: 'Assign' } };
});
afterEach(cleanup);

test('a list still on its way says it is loading; an empty one says nothing waits', () => {
  draw(undefined);
  expect(screen.getByText('Loading what waits for review…')).toBeInTheDocument();
  cleanup();
  draw({ proposals: [], unconfirmed: [] });
  expect(screen.getByText(/Nothing waits for review/)).toBeInTheDocument();
  expect(screen.getByText(/What AI proposes/)).toBeInTheDocument();
});

test('proposals are grouped by command, each row with its record, reason, state word and age', () => {
  draw({
    proposals: [
      proposal('p1', 'appeal', '{"id":4}', 'Denied for a coding error'),
      proposal('p2', 'assign', '{"id":5}'),
      proposal('p3', 'appeal', null),
    ],
    unconfirmed: [],
  });
  expect(screen.getByText('3 waiting')).toBeInTheDocument();
  const appeal = screen.getByRole('region', { name: 'Send appeal' });
  const rows = within(appeal).getAllByRole('listitem');
  expect(rows).toHaveLength(2);
  expect(within(rows[0]!).getByRole('button', { name: 'Claim 4' })).toBeInTheDocument();
  expect(within(rows[0]!).getByText('Denied for a coding error')).toBeInTheDocument();
  expect(rows[0]).toHaveTextContent('Drafted · 5 minutes ago');
  expect(within(rows[1]!).getByText('New record')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Assign' })).getAllByRole('listitem')).toHaveLength(1);
});

test('the record opens from its row', async () => {
  draw({ proposals: [proposal('p1', 'appeal', '{"id":4}')], unconfirmed: [] });
  await userEvent.click(screen.getByRole('button', { name: 'Claim 4' }));
  expect(h.go).toHaveBeenCalledWith({ table: 'claim', key: { id: 4 }, label: '4' }, 'push');
});

test('Approve approves at the record’s revision and reads everything again', async () => {
  const client = draw({ proposals: [proposal('p1', 'appeal', '{"id":4}')], unconfirmed: [] });
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(h.revision).toHaveBeenCalledWith('appeal', { id: 4 });
  expect(h.approve).toHaveBeenCalledWith('demo', { id: 'p1', command: 'appeal', expectedVersion: 3 });
  expect(h.toast).toHaveBeenCalledWith('Approved.');
  expect(client.invalidateQueries).toHaveBeenCalledWith();
});

test('Dismiss dismisses and reads only the proposals again', async () => {
  const client = draw({ proposals: [proposal('p1', 'appeal', '{"id":4}')], unconfirmed: [] });
  await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(h.dismiss).toHaveBeenCalledWith('demo', { id: 'p1', command: 'appeal' });
  expect(h.approve).not.toHaveBeenCalled();
  expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['command-proposals'] });
});

test('bulk is offered only where the command allows it, and decides every row of the group', async () => {
  draw({
    proposals: [
      proposal('p1', 'appeal', '{"id":4}'),
      proposal('p2', 'appeal', '{"id":5}'),
      proposal('p3', 'assign', '{"id":6}'),
      proposal('p4', 'assign', '{"id":7}'),
    ],
    unconfirmed: [],
  });
  expect(within(screen.getByRole('region', { name: 'Assign' })).queryByRole('button', { name: 'Approve all' })).toBeNull();
  await userEvent.click(within(screen.getByRole('region', { name: 'Send appeal' })).getByRole('button', { name: 'Dismiss all' }));
  expect(h.dismiss.mock.calls.map(([, ref]) => ref.id)).toEqual(['p1', 'p2']);
});

test('Change… opens the proposal panel, and only where the reader has an action for the command', async () => {
  h.actions = { appeal: { label: 'Send appeal' } };
  draw({ proposals: [proposal('p1', 'appeal', '{"id":4}'), proposal('p2', 'other', '{"id":5}')], unconfirmed: [] });
  const [withAction, without] = screen.getAllByRole('listitem');
  expect(within(without!).queryByRole('button', { name: 'Change…' })).toBeNull();
  await userEvent.click(within(withAction!).getByRole('button', { name: 'Change…' }));
  expect(h.openProposal).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), 'demo');
});

test('the Unconfirmed section names the maker and the field, and Confirm calls provenance/confirm', async () => {
  draw({ proposals: [], unconfirmed: [mark(), mark({ id: 'm2', field: null, actorKind: 'job', actor: 'nightly', rowKey: '{"id":9}' })] });
  const section = screen.getByRole('region', { name: 'Unconfirmed' });
  expect(section).toHaveTextContent('Not yet confirmed by a person');
  const [field, row] = within(section).getAllByRole('listitem');
  expect(field).toHaveTextContent('Amount');
  expect(row).toHaveTextContent('job nightly');
  expect(row).toHaveTextContent('The whole record');
  await userEvent.click(within(field!).getByRole('button', { name: 'Confirm' }));
  expect(h.confirm).toHaveBeenCalledWith('demo', { command: 'appeal', resource: 'claim', key: { id: 4 }, field: 'amount' });
  await userEvent.click(within(row!).getByRole('button', { name: 'Confirm' }));
  expect(h.confirm).toHaveBeenLastCalledWith('demo', { command: 'appeal', resource: 'claim', key: { id: 9 } });
});
