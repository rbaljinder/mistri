/**
 * A record's AI line under its head ("✦ AI 1 proposal: Send appeal · Review") and the unconfirmed mark at a field,
 * each with its act in place: Review opens the one proposal (several go to the room), Confirm confirms.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { CommandProposal, UnconfirmedMark } from '../commandProposals.js';

const h = vi.hoisted(() => ({ go: vi.fn(), toast: vi.fn(), confirm: vi.fn(), openProposal: vi.fn() }));
vi.mock('../../../../kit/src/client/core.js', () => ({ go: h.go, state: { activeConnection: 'demo' }, toast: h.toast }));
vi.mock('../publicAddress.js', () => ({ reviewEntry: () => ({ kind: 'page', pageId: 'review' }) }));
vi.mock('./sdk/commands.js', () => ({
  actionOf: (command: string) => ({ appeal: { label: 'Send appeal' }, assign: { label: 'Assign' } })[command],
}));
vi.mock('./ProposalPanel.js', () => ({ openProposal: h.openProposal }));
vi.mock('../commandProposals.js', () => ({ PROPOSALS_KEY: 'command-proposals' }));
vi.mock('../proposalDecisions.js', () => ({ confirmProvenance: h.confirm }));

const { RecordProposalLine, UnconfirmedFieldMark } = await import('./RecordProposalLine.js');

const proposal = (id: string, command: string) => ({ id, command, target: '{"id":4}', input: {} }) as unknown as CommandProposal;
const mark = (over: Partial<UnconfirmedMark> = {}) =>
  ({
    id: 'm1',
    resource: 'claim',
    rowKey: '{"id":4}',
    field: 'amount',
    actorKind: 'ai',
    actor: 'jev',
    createdAt: 0,
    command: 'appeal',
    ...over,
  }) as UnconfirmedMark;
let client: QueryClient;
const wrap = (node: ReactNode) => render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);

beforeEach(() => {
  client = new QueryClient();
  vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  for (const each of Object.values(h)) each.mockReset();
  h.confirm.mockResolvedValue({});
  h.openProposal.mockResolvedValue({ status: 'applied' });
});
afterEach(cleanup);

test('one proposal reads as a line whose Review opens its panel, and a landed approval asks the record again', async () => {
  const landed = vi.fn();
  wrap(<RecordProposalLine proposals={[proposal('p1', 'appeal')]} recordKey={{ id: 4 }} onLanded={landed} />);
  expect(screen.getByRole('status')).toHaveTextContent(/AI\s*1 proposal: Send appeal\s*·\s*Review/);
  await userEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(h.openProposal).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }), 'demo');
  await vi.waitFor(() => expect(landed).toHaveBeenCalled());
  expect(client.invalidateQueries).toHaveBeenCalledWith();
});

test('several proposals name each command once, and Review goes to the room', async () => {
  wrap(
    <RecordProposalLine
      proposals={[proposal('p1', 'appeal'), proposal('p2', 'assign'), proposal('p3', 'appeal')]}
      recordKey={{ id: 4 }}
      onLanded={vi.fn()}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent(/AI\s*3 proposals: Send appeal, Assign/);
  await userEvent.click(screen.getByRole('button', { name: 'Review' }));
  expect(h.go).toHaveBeenCalledWith({ kind: 'page', pageId: 'review' }, 'push');
  expect(h.openProposal).not.toHaveBeenCalled();
});

test('a record a job made and no one confirmed says so, and Confirm confirms the whole row', async () => {
  wrap(
    <RecordProposalLine
      proposals={[]}
      rowMark={mark({ field: null, actorKind: 'job', actor: 'nightly' })}
      recordKey={{ id: 4 }}
      onLanded={vi.fn()}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent(/Made by job nightly, not yet confirmed\s*·\s*Confirm/);
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(h.confirm).toHaveBeenCalledWith('demo', { command: 'appeal', resource: 'claim', key: { id: 4 } });
  expect(h.toast).toHaveBeenCalledWith('Confirmed.');
  expect(client.invalidateQueries).toHaveBeenCalledWith({ queryKey: ['command-proposals'] });
});

test('an unconfirmed field carries the mark, says who wrote it, and confirms that field in place', async () => {
  wrap(<UnconfirmedFieldMark mark={mark()} recordKey={{ id: 4 }} />);
  const button = screen.getByRole('button', { name: 'Confirm Amount' });
  expect(button.closest('.unconfirmed-mark')).toHaveAttribute('title', 'Amount was written by AI and not yet confirmed');
  await userEvent.click(button);
  expect(h.confirm).toHaveBeenCalledWith('demo', { command: 'appeal', resource: 'claim', key: { id: 4 }, field: 'amount' });
});

test('a refused confirm is said and the list is still read again', async () => {
  h.confirm.mockRejectedValue(new Error('Not yours to confirm.'));
  wrap(<UnconfirmedFieldMark mark={mark()} recordKey={{ id: 4 }} />);
  await userEvent.click(screen.getByRole('button', { name: 'Confirm Amount' }));
  expect(h.toast).toHaveBeenCalledWith('Not yours to confirm.', 'error');
  expect(client.invalidateQueries).toHaveBeenCalled();
});
