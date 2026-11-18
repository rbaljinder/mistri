/**
 * The three decisions on the review queue: approve (run as the approver), dismiss (nothing run), and confirm what a
 * non-person maker wrote on a row. Apart from commandProposals.ts, which a record page reads in every App's first
 * paint, so these load only with the surfaces that decide (the For review room, the proposal panel, a chip).
 *
 * Every decision invalidates the list, so a queue and a record's pending line agree after it.
 */
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { COMMAND_ROUTES } from '../shared/commandRoutes.js';
import { PROPOSALS_KEY } from './commandProposals.js';

const invalidate = (client: QueryClient) => client.invalidateQueries({ queryKey: [PROPOSALS_KEY] });

interface ProposalApprove {
  id: string;
  command: string;
  /** The revision of the record the approver saw; a moved record refuses the run as stale. 0 for a create. */
  expectedVersion: number;
  /** The input as the approver corrected it; the proposal's own when absent. */
  input?: Record<string, unknown>;
}

/** Run a proposal as the approver: their grants, their refusals. The answer is the command's own. */
export function approveProposal(connection: string | null, approval: ProposalApprove): Promise<unknown> {
  return api(COMMAND_ROUTES.approveProposal, { ...ownedBy(connection), ...approval });
}

/** Set a proposal aside; nothing runs. */
export function dismissProposal(connection: string | null, reference: { id: string; command: string }): Promise<unknown> {
  return api(COMMAND_ROUTES.dismissProposal, { ...ownedBy(connection), ...reference });
}

interface ProvenanceConfirm {
  /** A command on the row's resource the person is granted: the grant the confirmation is asked through. */
  command: string;
  resource: string;
  key: Readonly<Record<string, unknown>>;
  /** One field's mark (and the row's own); every mark on the row when absent. */
  field?: string;
}

/** Vouch for what a non-person maker wrote on a row; the answer counts the marks confirmed. */
export async function confirmProvenance(connection: string | null, request: ProvenanceConfirm): Promise<{ confirmed: number }> {
  const answer = await api(COMMAND_ROUTES.confirmProvenance, { ...ownedBy(connection), ...request });
  return { confirmed: Number(answer?.confirmed ?? 0) };
}

export function useApproveProposal(connection: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (approval: ProposalApprove) => approveProposal(connection, approval),
    // A refused approval may still have settled the proposal (expired, failed): the list is read again either way.
    onSettled: () => invalidate(client),
  });
}

export function useDismissProposal(connection: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (reference: { id: string; command: string }) => dismissProposal(connection, reference),
    onSettled: () => invalidate(client),
  });
}

export function useConfirmProvenance(connection: string | null) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (request: ProvenanceConfirm) => confirmProvenance(connection, request),
    onSettled: () => invalidate(client),
  });
}
