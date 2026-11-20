/**
 * A proposal decided in its command's own form (sdk/proposalCommands.ts `openProposalForm`): the drawer, prefilled with what
 * was proposed and editable, with the evidence beside the fields. Approve sends the input as the person left it — the
 * fields they changed become theirs (server/commands/proposals.ts) — and Dismiss, in Cancel's place, sets it aside.
 *
 * Opened from the For review room, a record's proposal line and a decision's Change…; loaded with the first of them,
 * never in a first page.
 */
import { toast } from '@mistriwork/kit/client/core.js';
import { EvidenceItem } from './EvidenceList.js';
import { queryClient } from '@mistriwork/kit/client/components/mount.js';
import { AiMark } from '@mistriwork/kit/client/components/AiMark.js';
import { openProposalForm } from './sdk/proposalCommands.js';
import type { UiCommandOutcome } from './sdk/context.js';
import { PROPOSALS_KEY, type CommandProposal } from '../commandProposals.js';
import { dismissProposal } from '../proposalDecisions.js';
import { say } from '../copy/review/components/ProposalPanel.js';
import './ProposalPanel.css';

/** The record a proposal is about, as a key; an empty key for a create. */
export function proposalKey(proposal: Pick<CommandProposal, 'target'>): Record<string, unknown> {
  if (!proposal.target) return {};
  try {
    const key = JSON.parse(proposal.target) as unknown;
    return key && typeof key === 'object' && !Array.isArray(key) ? (key as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Open a proposal's panel. Resolves with how the form ended once it closes; undefined (and said) when no action of
 * this reader's offers the command, so there is no form to draw it in.
 */
export function openProposal(proposal: CommandProposal, connection: string | null): Promise<UiCommandOutcome> | undefined {
  let closeDrawer: (() => void) | undefined;
  const opened = openProposalForm(proposal.command, proposalKey(proposal), {
    proposal: {
      id: proposal.id,
      input: proposal.input,
      onDismiss: () => dismissProposal(connection, { id: proposal.id, command: proposal.command }),
    },
    aside: <ProposalEvidenceList proposal={proposal} onNavigate={() => closeDrawer?.()} />,
    onOpen: (close) => {
      closeDrawer = close;
    },
  });
  if (!opened) {
    toast(say('couldNotOpen'), 'error');
    return undefined;
  }
  // Approved or dismissed, the queue and every record's line are read again; a closed form changed nothing.
  return opened.finally(() => void queryClient.invalidateQueries({ queryKey: [PROPOSALS_KEY] }));
}

/** The panel's Evidence column: who proposed it and why, then what it read. */
export function ProposalEvidenceList({
  proposal,
  onNavigate,
}: {
  proposal: Pick<CommandProposal, 'evidence' | 'reason'>;
  onNavigate?: () => void;
}) {
  return (
    <div className="proposal-evidence">
      <h3 className="proposal-evidence-head">
        <AiMark />
        <span>{say('evidence')}</span>
      </h3>
      {proposal.reason ? <p className="proposal-evidence-reason">{proposal.reason}</p> : null}
      {proposal.evidence.length ? (
        <ul className="proposal-evidence-list">
          {proposal.evidence.map((each, index) => (
            <EvidenceItem key={`${each.kind}:${each.ref}:${index}`} evidence={each} onNavigate={onNavigate} />
          ))}
        </ul>
      ) : (
        <p className="proposal-evidence-none">{say('noEvidence')}</p>
      )}
    </div>
  );
}
