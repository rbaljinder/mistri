/**
 * Which proposals and unconfirmed marks are on one record, read off the shell's review list (commandProposals.ts),
 * and the proposals a reader may decide by command or state. Apart from that module, which a record page reads in
 * every App's first paint: only the parts that draw what waits on a record (RecordProposalLine.tsx) need these, and
 * they load the first time a record has something.
 */
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { COMMAND_ROUTES } from '../shared/commandRoutes.js';
import { PROPOSALS_KEY, type CommandProposal, type ProposalState, type UnconfirmedMark } from './commandProposals.js';

interface ProposalFilter {
  /** One command's proposals; every granted command's when absent. */
  command?: string;
  /** The states asked; the server's default is `proposed` alone. */
  states?: readonly ProposalState[];
}

/* Its key starts with PROPOSALS_KEY, so a decision's one invalidation reaches it as it reaches the review list. */
const proposalsQueryKey = (connection: string | null, filter: ProposalFilter = {}) =>
  [PROPOSALS_KEY, connection, filter.command ?? null, filter.states ? [...filter.states].sort() : null] as const;

function proposalsQuery(connection: string | null, filter: ProposalFilter = {}) {
  return queryOptions({
    queryKey: proposalsQueryKey(connection, filter),
    queryFn: async (): Promise<CommandProposal[]> => {
      const answer = await api(COMMAND_ROUTES.proposals, {
        ...ownedBy(connection),
        ...(filter.command ? { command: filter.command } : {}),
        ...(filter.states ? { states: [...filter.states] } : {}),
      });
      return Array.isArray(answer?.proposals) ? (answer.proposals as CommandProposal[]) : [];
    },
  });
}

/** The proposals a reader may decide. */
export function useProposals(connection: string | null, filter: ProposalFilter = {}) {
  return useQuery(proposalsQuery(connection, filter));
}

/**
 * Whether a proposal's target is this record. The target is canonical JSON of the key; a key read from a page may
 * carry a number where the canonical text has the same number, so columns compare as text.
 */
export function targets(proposal: Pick<CommandProposal, 'target'>, key: Readonly<Record<string, unknown>>): boolean {
  if (proposal.target === null) return false;
  let target: unknown;
  try {
    target = JSON.parse(proposal.target);
  } catch {
    return false;
  }
  if (!target || typeof target !== 'object' || Array.isArray(target)) return false;
  const columns = Object.keys(key);
  const held = target as Record<string, unknown>;
  return (
    columns.length === Object.keys(held).length &&
    columns.every((column) => Object.hasOwn(held, column) && String(held[column]) === String(key[column]))
  );
}

/** The pending proposals on one record, of every command the reader may decide (or one command's). */
export function pendingOn(
  proposals: readonly CommandProposal[],
  key: Readonly<Record<string, unknown>>,
  command?: string,
): CommandProposal[] {
  return proposals.filter(
    (proposal) => proposal.state === 'proposed' && (command === undefined || proposal.command === command) && targets(proposal, key),
  );
}

/** The unconfirmed marks on one row, from the review list. */
export function unconfirmedOn(
  marks: readonly UnconfirmedMark[],
  resource: string,
  key: Readonly<Record<string, unknown>>,
): UnconfirmedMark[] {
  return marks.filter((mark) => mark.resource === resource && targets({ target: mark.rowKey }, key));
}

/**
 * How many proposals wait on one record. It reads the queue's own list, so a record page and the queue share one
 * request; the list is bounded by the server, as the queue is.
 */
export function usePendingCount(connection: string | null, key: Readonly<Record<string, unknown>> | null, command?: string): number {
  const listed = useQuery({ ...proposalsQuery(connection), enabled: key !== null });
  return key && listed.data ? pendingOn(listed.data, key, command).length : 0;
}
