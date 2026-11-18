/** A proposal's panel: the command's own drawer, opened with the proposal and its evidence; Dismiss dismisses it. */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';
import type { CommandProposal } from '../commandProposals.js';

const h = vi.hoisted(() => ({
  go: vi.fn(),
  toast: vi.fn(),
  open: vi.fn(),
  dismiss: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  go: h.go,
  rowView: (table: string, key: unknown, label: string) => ({ table, key, label }),
  toast: h.toast,
}));
vi.mock('../../../../kit/src/client/components/mount.js', () => ({ queryClient: { invalidateQueries: h.invalidate } }));
vi.mock('./sdk/proposalCommands.js', () => ({ openProposalForm: h.open }));
vi.mock('../commandProposals.js', () => ({ PROPOSALS_KEY: 'command-proposals' }));
vi.mock('../proposalDecisions.js', () => ({ dismissProposal: h.dismiss }));

const { openProposal, proposalKey, ProposalEvidenceList } = await import('./ProposalPanel.js');

const proposal = {
  id: 'p1',
  command: 'appeal',
  target: '{"id":4}',
  input: { reason: 'Coding error' },
  reason: 'The denial cites a code the visit did not use.',
  evidence: [
    { kind: 'record', ref: 'visit/{"id":12}', label: 'Visit on May 3', quote: 'Billed 99214' },
    { kind: 'url', ref: 'https://example.com/policy', label: 'Payer policy' },
    { kind: 'url', ref: 'javascript:alert(1)', label: 'Not a link' },
    { kind: 'text', ref: '', label: 'Denial letter', quote: 'Code mismatch' },
  ],
} as unknown as CommandProposal;

beforeEach(() => {
  for (const each of Object.values(h)) each.mockReset();
  h.open.mockReturnValue(Promise.resolve({ status: 'applied' }));
});
afterEach(cleanup);

test("a proposal's key is its target; a create's is empty", () => {
  expect(proposalKey({ target: '{"id":4}' })).toEqual({ id: 4 });
  expect(proposalKey({ target: null })).toEqual({});
  expect(proposalKey({ target: 'not json' })).toEqual({});
});

test('opening a proposal opens its command at its record, with its input and evidence, and reads the queue again after', async () => {
  const outcome = await openProposal(proposal, 'demo');
  expect(outcome).toEqual({ status: 'applied' });
  const [command, key, options] = h.open.mock.calls[0]!;
  expect(command).toBe('appeal');
  expect(key).toEqual({ id: 4 });
  expect(options.proposal).toMatchObject({ id: 'p1', input: { reason: 'Coding error' } });
  await options.proposal.onDismiss();
  expect(h.dismiss).toHaveBeenCalledWith('demo', { id: 'p1', command: 'appeal' });
  render(options.aside as ReactElement);
  expect(screen.getByText('Evidence')).toBeInTheDocument();
  expect(h.invalidate).toHaveBeenCalledWith({ queryKey: ['command-proposals'] });
});

test('a command the reader has no form for is said, and nothing opens', () => {
  h.open.mockReturnValue(undefined);
  expect(openProposal(proposal, 'demo')).toBeUndefined();
  expect(h.toast).toHaveBeenCalledWith('This command cannot be opened here.', 'error');
});

test('the Evidence column gives the reason, then each piece: a record opens, a web link links, anything else is text', async () => {
  render(<ProposalEvidenceList proposal={proposal} />);
  expect(screen.getByText('The denial cites a code the visit did not use.')).toBeInTheDocument();
  expect(screen.getByText('Billed 99214')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Payer policy' })).toHaveAttribute('href', 'https://example.com/policy');
  expect(screen.queryByRole('link', { name: 'Not a link' })).toBeNull();
  expect(screen.getByText('Not a link')).toBeInTheDocument();
  expect(screen.getByText('Code mismatch')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Visit on May 3' }));
  expect(h.go).toHaveBeenCalledWith({ table: 'visit', key: { id: 12 }, label: 'Visit on May 3' }, 'push');
});

test('a proposal with no evidence says so', () => {
  render(<ProposalEvidenceList proposal={{ evidence: [], reason: '' }} />);
  expect(screen.getByText('No evidence was given.')).toBeInTheDocument();
});
