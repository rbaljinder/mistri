/*
 * The command pipeline's reads and forms that only a proposal needs (sdk/commands.tsx draws them): the table a
 * proposal's record is a row of, the revision a run is approved against, and a proposal's own drawer. Apart, so they load with the review surfaces that use them
 * (ReviewRoom, ProposalPanel, DecisionChip, AssistantPanel) and not in every App's first paint.
 */
import { prepareCommand } from '../../commandSend.js';
import { actionOf, openForm, ownerFor, resourceOffering, type ProposalFormProps } from './commands.js';
import type { UiCommandOutcome } from './context.js';

/** The table a command's records are rows of, where an action offers it to this reader: a proposal's record link. */
export function commandResource(ref: string): string | undefined {
  const action = actionOf(ref);
  return action ? resourceOffering(action) : undefined;
}

/**
 * The revision of a record a command would run against now, for a run sent outside the pipeline: a decision's stored
 * proposal approved as it stands (DecisionChip.tsx). Undefined when the command is no record action of this App's.
 */
export async function commandRevision(ref: string, key: Record<string, unknown>): Promise<number | undefined> {
  const action = actionOf(ref);
  return action ? (await prepareCommand(ownerFor(action, key))).expectedVersion : undefined;
}

/**
 * A proposal's command form (ProposalPanel.tsx): the record action that offers the command, drawn as a drawer
 * prefilled with the proposal's input, its evidence beside it; Approve sends the input as the person left it.
 * Undefined when no action of this reader's offers the command — the panel then decides it as it stands.
 */
export function openProposalForm(
  command: string,
  key: Record<string, unknown>,
  extra: Required<Pick<ProposalFormProps, 'proposal'>> & ProposalFormProps,
): Promise<UiCommandOutcome> | undefined {
  const action = actionOf(command);
  return action ? openForm(action, key, extra.proposal.input, {}, extra) : undefined;
}
