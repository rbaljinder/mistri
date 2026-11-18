/**
 * The review queue's reads, for a page to draw: the shell's one review list of what a reader may decide (the
 * proposals of the commands they are granted, server/commands/proposals.ts). A record page reads this module in every
 * App's first paint, so what only a deciding or drawing surface needs is apart: the three decisions in
 * proposalDecisions.ts, and the filtered proposal list and which proposals and marks are on one record in
 * proposalTargets.ts.
 *
 * No UI here. Every decision invalidates the list (`PROPOSALS_KEY`), so a queue and a record's pending line agree
 * after it; an approval also writes the record, which live sync already announces to the views that show it.
 */
import { useEffect, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { api } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { COMMAND_ROUTES } from '../shared/commandRoutes.js';

/* The wire shape of server/commands/proposals.ts's rows, as the client reads them. Declared here rather than
   imported: the client does not reach into the adapters, and only these fields are read. Times are epoch ms. */
export type ProposalState = 'proposed' | 'approved' | 'dismissed' | 'expired' | 'failed';
export interface ProposalEvidence {
  kind: 'record' | 'text' | 'file' | 'url';
  ref: string;
  label: string;
  quote?: string;
}
export interface CommandProposal {
  id: string;
  command: string;
  /** The record key as canonical JSON, or null for a create. */
  target: string | null;
  input: Record<string, unknown>;
  actorKind: 'assistant' | 'job' | 'decision' | 'agent' | 'flow';
  actor: string;
  model: string | null;
  evidence: readonly ProposalEvidence[];
  reason: string;
  state: ProposalState;
  decidedBy: string | null;
  decidedAt: number | null;
  receiptId: string | null;
  createdAt: number;
  expiresAt: number;
}

/** A row (or one field of it) a non-person maker wrote and no person has vouched for yet, with a command to confirm it through. */
export interface UnconfirmedMark {
  id: string;
  resource: string;
  /** The row key as canonical JSON. */
  rowKey: string;
  /** The field marked; the row as a whole (a create) when null. */
  field: string | null;
  actorKind: CommandProposal['actorKind'];
  actor: string;
  createdAt: number;
  command: string;
}

/** Every proposal query starts with this, so one invalidation reaches the queue and every record's count. */
export const PROPOSALS_KEY = 'command-proposals';

/**
 * The shell's one read of what waits for review: every pending proposal the reader may decide, and the unconfirmed
 * marks on rows they may confirm. The nav count, the For review room, a record's head line and its fields' marks all
 * read it, so a record opening asks nothing more. Asked once the first paint is done, and only in an App that has
 * AI-made work for this reader (`review` in its payload).
 */
const REVIEW_KEY = [PROPOSALS_KEY, 'review'] as const;

export interface ReviewList {
  proposals: CommandProposal[];
  unconfirmed: UnconfirmedMark[];
}

export function reviewQuery(connection: string | null) {
  return queryOptions({
    queryKey: [...REVIEW_KEY, connection] as const,
    queryFn: async (): Promise<ReviewList> => {
      const answer = await api(COMMAND_ROUTES.proposals, { ...ownedBy(connection), unconfirmed: true });
      return {
        proposals: Array.isArray(answer?.proposals) ? (answer.proposals as CommandProposal[]) : [],
        unconfirmed: Array.isArray(answer?.unconfirmed) ? (answer.unconfirmed as UnconfirmedMark[]) : [],
      };
    },
    // Read by every record page: a record opening within this time asks nothing; a decision invalidates it at once.
    staleTime: 30_000,
  });
}

let painted = false;

/** Whether the page's first paint is done: the review list waits for it, so it is never in a page's first wave. */
function usePainted(): boolean {
  const [now, set] = useState(painted);
  useEffect(() => {
    if (painted) return set(true);
    const done = () => set((painted = true));
    if (typeof requestIdleCallback !== 'function') return void setTimeout(done, 300);
    const asked = requestIdleCallback(done, { timeout: 1500 });
    return () => cancelIdleCallback(asked);
  }, []);
  return now;
}

/** The review list, or undefined while it is not asked (no review in this App, or before the first paint). */
export function useReview(connection: string | null, offered: boolean): ReviewList | undefined {
  const painted = usePainted();
  return useQuery({ ...reviewQuery(connection), enabled: offered && painted }).data;
}
